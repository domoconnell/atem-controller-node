#!/usr/bin/env node
/**
 * digico-watch — a no-Wireshark OSC/UDP capture + relay for DiGiCo consoles.
 *
 * Two jobs in one:
 *   1. WATCH  — bind the port the desk sends its feedback to, decode every OSC
 *               message, and report which addresses appear and how fast. It
 *               specifically hunts for a *metering stream*: high-rate messages
 *               and OSC blob (`,b`) args, which is how meters would arrive.
 *   2. RELAY  — optionally also stand between an iPad / Companion and the desk,
 *               forwarding both ways verbatim (the desk allows only one OSC
 *               device, so we are it and re-broadcast). This captures the whole
 *               *iPad command set* live — every address the iPad actually uses —
 *               without any dealer docs, and reveals whether meters ride that
 *               same connection (if they do, the iPad gets meters *through us*).
 *
 * No dependencies, no build — runs anywhere Node 18+ is (your Mac, the Pi).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node tools/digico-watch.mjs --desk 10.10.10.60 [options]
 *
 *   --desk <ip>       Console IP address (required).
 *   --send <port>     Port on the console we SEND to — its "Receive" port.
 *                     DiGiCo External Control → the port the desk listens on.
 *                     [default 8000]
 *   --recv <port>     Port WE bind to receive the console's feedback. Point the
 *                     desk's "Send to" at <this-machine-ip>:<recv>.  [default 9000]
 *   --relay <port>    Also relay: bind this port for the iPad / Companion to
 *                     connect to (they aim their OSC here instead of at the
 *                     desk). Everything they exchange is logged + forwarded.
 *                     Omit to just listen.  [optional]
 *   --query <N>       On start, send name/mute/fader "?" queries for channels
 *                     1..N to prod the desk into replying.  [default 0 = off]
 *   --prefix <p>      Address prefix for those queries: "" or "/sd".  [default /sd]
 *   --out <file>      Write a raw JSONL log here; a summary goes to <file>.summary.txt
 *                     on exit.  [default digico-capture]
 *   --quiet           Don't print every first-seen line; just the 2s rate table.
 *
 * ── Tomorrow's recipe ────────────────────────────────────────────────────────
 *   1. On the desk: System → Setup → External Control → enable, add an OSC/iPad
 *      device pointing at THIS machine's IP and the --recv port; set its receive
 *      port to --send. Turn on "Suppress OSC Retransmit".
 *   2. Run:  node tools/digico-watch.mjs --desk <deskIP> --relay 8010 --query 8
 *   3. Point your iPad's DiGiCo app at THIS machine:8010 (instead of the desk).
 *      Open a meter view on the desk/app, push some audio, ride a fader.
 *   4. Watch the table. Hit Ctrl+C for the summary. If you see high-rate rows or
 *      "BLOB" args, that's the meter stream — and the iPad is already getting it
 *      through the relay.
 */

import { createSocket } from 'node:dgram'
import { writeFileSync, createWriteStream } from 'node:fs'

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
const has = (name) => argv.includes(`--${name}`)
const DESK = arg('desk')
if (!DESK) { console.error('error: --desk <ip> is required. See the header of this file for usage.'); process.exit(1) }
const SEND = Number(arg('send', 8000))
const RECV = Number(arg('recv', 9000))
const RELAY = arg('relay') ? Number(arg('relay')) : null
const QUERY = Number(arg('query', 0))
const PREFIX = arg('prefix', '/sd')
const OUT = arg('out', 'digico-capture')
const QUIET = has('quiet')

const t0 = Date.now()
const now = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7)
const raw = createWriteStream(`${OUT}.jsonl`, { flags: 'w' })

// ── a tiny, dependency-free OSC decoder ──────────────────────────────────────
// Handles addresses, type tags i/f/s/b/T/F/d/h, and #bundle recursion. Blob and
// unknown args are summarised, not expanded (a meter blob is the whole point).
function decode(buf) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out = []
    let p = 16 // "#bundle\0" + 8-byte timetag
    while (p + 4 <= buf.length) {
      const size = buf.readInt32BE(p); p += 4
      if (size <= 0 || p + size > buf.length) break
      const inner = decode(buf.subarray(p, p + size))
      if (inner) out.push(...(Array.isArray(inner) ? inner : [inner]))
      p += size
    }
    return out
  }
  const zero = buf.indexOf(0)
  if (zero < 1 || buf[0] !== 0x2f /* '/' */) return null // not OSC
  const address = buf.toString('ascii', 0, zero)
  let p = pad4(zero + 1)
  let types = ''
  const args = []
  if (buf[p] === 0x2c /* ',' */) {
    const tz = buf.indexOf(0, p)
    types = buf.toString('ascii', p + 1, tz)
    p = pad4(tz + 1)
    for (const tag of types) {
      if (tag === 'i') { args.push(buf.readInt32BE(p)); p += 4 }
      else if (tag === 'f') { args.push(round(buf.readFloatBE(p))); p += 4 }
      else if (tag === 'd') { args.push(round(buf.readDoubleBE(p))); p += 8 }
      else if (tag === 'h') { args.push(Number(buf.readBigInt64BE(p))); p += 8 }
      else if (tag === 's') { const z = buf.indexOf(0, p); args.push(buf.toString('ascii', p, z)); p = pad4(z + 1) }
      else if (tag === 'b') { const len = buf.readInt32BE(p); p += 4; args.push({ blob: len }); p = pad4(p + len) }
      else if (tag === 'T') args.push(true)
      else if (tag === 'F') args.push(false)
      else break // unknown tag: stop, we still have the address
    }
  }
  return { address, types, args }
}
const pad4 = (n) => n + ((4 - (n % 4)) % 4)
const round = (n) => Math.round(n * 1000) / 1000
function encode(address, types = '', args = []) {
  const parts = [strBuf(address), strBuf(',' + types)]
  let ai = 0
  for (const tag of types) {
    if (tag === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(args[ai++] | 0); parts.push(b) }
    else if (tag === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(args[ai++]); parts.push(b) }
    else if (tag === 's') parts.push(strBuf(String(args[ai++])))
  }
  return Buffer.concat(parts)
}
const strBuf = (s) => { const b = Buffer.from(s + '\0', 'ascii'); return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b }

// ── stats ────────────────────────────────────────────────────────────────────
const seen = new Map() // address -> { count, first, last, types, blob, sample }
function note(dir, msg, from) {
  const key = msg.address
  const s = seen.get(key) ?? { count: 0, first: Date.now(), last: 0, types: msg.types, blob: false, sample: msg.args, dir }
  s.count++; s.last = Date.now(); s.types = msg.types
  if (msg.types.includes('b')) s.blob = true
  if (s.count <= 1) s.sample = msg.args
  seen.set(key, s)
  raw.write(JSON.stringify({ t: now(), dir, from, address: msg.address, types: msg.types, args: msg.args }) + '\n')
  if (!QUIET && s.count === 1) {
    const tag = msg.types.includes('b') ? '  ◀── BLOB (meter candidate!)' : ''
    console.log(`${now()}  ${dir.padEnd(10)} NEW  ${msg.address}  [${msg.types}] ${fmtArgs(msg.args)}${tag}`)
  }
}
const fmtArgs = (a) => a.map((x) => (x && x.blob != null ? `<blob ${x.blob}B>` : JSON.stringify(x))).join(' ')

// ── sockets ──────────────────────────────────────────────────────────────────
const deskSock = createSocket('udp4')
deskSock.on('error', (e) => console.error('[recv] socket error', e.message))
deskSock.on('message', (buf, rinfo) => {
  const decoded = decode(buf)
  const list = Array.isArray(decoded) ? decoded : decoded ? [decoded] : []
  if (list.length === 0) { raw.write(JSON.stringify({ t: now(), dir: 'desk→us', nonOsc: buf.length }) + '\n'); if (!QUIET) console.log(`${now()}  desk→us    NON-OSC ${buf.length} bytes: ${buf.subarray(0, 24).toString('hex')}…`); }
  for (const m of list) note('desk→us', m, `${rinfo.address}:${rinfo.port}`)
  // fan out to relay clients verbatim
  if (relaySock) for (const c of clients.values()) relaySock.send(buf, c.port, c.ip)
})
deskSock.bind(RECV, () => {
  console.log(`\n▶ digico-watch`)
  console.log(`  listening for console feedback on udp:${RECV}  (point the desk's "send to" here)`)
  console.log(`  sending to console at ${DESK}:${SEND}`)
  if (RELAY) console.log(`  relaying downstream clients (iPad/Companion) on udp:${RELAY}`)
  console.log(`  raw log → ${OUT}.jsonl   ·   Ctrl+C for summary\n`)
  if (QUERY > 0) startQueries()
})

let relaySock = null
const clients = new Map() // ip:port -> {ip, port, lastSeen}
if (RELAY) {
  relaySock = createSocket('udp4')
  relaySock.on('error', (e) => console.error('[relay] socket error', e.message))
  relaySock.on('message', (buf, rinfo) => {
    clients.set(`${rinfo.address}:${rinfo.port}`, { ip: rinfo.address, port: rinfo.port, lastSeen: Date.now() })
    const decoded = decode(buf)
    const list = Array.isArray(decoded) ? decoded : decoded ? [decoded] : []
    for (const m of list) note('client→desk', m, `${rinfo.address}:${rinfo.port}`)
    deskSock.send(buf, SEND, DESK) // forward verbatim; replies come back on RECV
  })
  relaySock.bind(RELAY)
}

// Optional: prod the desk into replying so we see the reply addresses/values.
function startQueries() {
  const q = []
  for (let ch = 1; ch <= QUERY; ch++) {
    q.push(`${PREFIX}/Input_Channels/${ch}/Channel_Input/name/?`)
    q.push(`${PREFIX}/Input_Channels/${ch}/mute/?`)
    q.push(`${PREFIX}/Input_Channels/${ch}/fader/?`)
  }
  q.push(`${PREFIX}/Macros/Buttons/?`)
  for (const addr of q) deskSock.send(encode(addr, '', []), SEND, DESK)
  console.log(`  sent ${q.length} startup queries (channels 1..${QUERY})\n`)
}

// ── periodic rate table ──────────────────────────────────────────────────────
let lastCounts = new Map()
setInterval(() => {
  const rows = [...seen.entries()].map(([addr, s]) => {
    const prev = lastCounts.get(addr) ?? 0
    const hz = (s.count - prev) / 2
    return { addr, count: s.count, hz, blob: s.blob }
  })
  lastCounts = new Map([...seen.entries()].map(([a, s]) => [a, s.count]))
  const active = rows.filter((r) => r.hz > 0).sort((a, b) => b.hz - a.hz)
  if (active.length === 0) return
  console.log(`\n── rate (last 2s) · ${now()}s ──────────────────────────────`)
  for (const r of active.slice(0, 15)) {
    const flag = r.blob ? ' ★BLOB' : r.hz >= 10 ? ' ★STREAM' : ''
    console.log(`  ${String(r.hz).padStart(5)} Hz  ×${String(r.count).padEnd(7)} ${r.addr}${flag}`)
  }
  if (clients.size) console.log(`  relay clients: ${[...clients.keys()].join(', ')}`)
}, 2000)

// ── summary on exit ──────────────────────────────────────────────────────────
function summarise() {
  const dur = (Date.now() - t0) / 1000
  const rows = [...seen.entries()].map(([addr, s]) => ({ addr, count: s.count, hz: +(s.count / dur).toFixed(2), types: s.types, blob: s.blob, sample: s.sample, dir: s.dir }))
  rows.sort((a, b) => b.count - a.count)
  const meterCandidates = rows.filter((r) => r.blob || r.hz >= 10)
  const lines = []
  lines.push(`digico-watch summary — ${new Date().toISOString()}`)
  lines.push(`desk ${DESK}:${SEND}  ·  recv :${RECV}  ·  relay ${RELAY ?? 'off'}  ·  ${dur.toFixed(1)}s  ·  ${rows.length} unique addresses\n`)
  lines.push('METER CANDIDATES (blob args or ≥10 Hz):')
  if (meterCandidates.length === 0) lines.push('  none — no metering stream arrived on this OSC connection.')
  for (const r of meterCandidates) lines.push(`  ${String(r.hz).padStart(6)} Hz  ×${String(r.count).padEnd(8)} [${r.types}] ${r.addr}${r.blob ? '  <BLOB>' : ''}`)
  lines.push('\nALL ADDRESSES (by volume):')
  for (const r of rows) lines.push(`  ×${String(r.count).padEnd(8)} ${String(r.hz).padStart(6)}Hz  [${r.types}] ${r.dir.padEnd(11)} ${r.addr}   e.g. ${fmtArgs(r.sample ?? [])}`)
  const text = lines.join('\n')
  writeFileSync(`${OUT}.summary.txt`, text + '\n')
  console.log('\n\n' + text)
  console.log(`\n(raw: ${OUT}.jsonl  ·  summary: ${OUT}.summary.txt)`)
}
process.on('SIGINT', () => { console.log('\n\n■ stopping…'); raw.end(); summarise(); process.exit(0) })
