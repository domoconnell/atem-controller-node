#!/usr/bin/env node
// Decode the DiGiCo iPad meter subscription from a pcap (or a live capture) and
// print the meter tap path used for EACH channel type — the one thing we need
// to extend metering beyond input channels to auxes, matrices and groups.
//
// The iPad tells the desk what to meter with:
//   /Meters/request/<slot>  "<tap path>"
// e.g. /Input_Channels/13/Channel_Input/post_meter/left. This tool collects
// those tap paths and groups them by channel-type root, so the output-channel
// meter format (which isn't in any DiGiCo doc) falls straight out of a capture
// that includes an aux/matrix/group bank.
//
// Usage:
//   node tools/digico-meter-taps.mjs /tmp/bank.pcap        # decode a saved pcap
//   node tools/digico-meter-taps.mjs                       # live: capture 20s on the relay port then decode
//
// Live mode shells out to tcpdump (needs sudo) on the relay receive port; pass
// --port <n> to change it (default 5678) and --secs <n> for the duration.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
let pcapPath = args.find((a) => !a.startsWith('--') && a.endsWith('.pcap'))
const port = Number(opt('--port', 5678))
const secs = Number(opt('--secs', 20))

if (!pcapPath) {
  pcapPath = `/tmp/digico-taps-${port}.pcap`
  console.error(`Live capture: ${secs}s on udp port ${port} → ${pcapPath}\n(switch the iPad onto aux/matrix/group banks now)`)
  try {
    execSync(`sudo timeout ${secs} tcpdump -n -s 0 -w ${pcapPath} "udp and port ${port}" 2>/dev/null`, { stdio: 'inherit' })
  } catch { /* timeout exits non-zero; the file is still written */ }
}

const buf = readFileSync(pcapPath)
const le = buf.readUInt32BE(0) === 0xd4c3b2a1
const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
const linktype = r32(20)
const L2 = linktype === 1 ? 14 : linktype === 113 ? 16 : linktype === 101 ? 0 : 14

/** Minimal OSC message decode: address + first string arg (enough for requests). */
function oscAddrAndString(p) {
  if (p[0] !== 0x2f) return null
  const ai = p.indexOf(0)
  if (ai <= 0) return null
  const addr = p.slice(0, ai).toString('latin1')
  let o = (ai + 4) & ~3
  if (p[o] !== 0x2c) return { addr, arg: null }
  const ji = p.indexOf(0, o)
  const tags = p.slice(o + 1, ji).toString('latin1')
  o = (ji + 4) & ~3
  if (tags[0] !== 's') return { addr, arg: null }
  const k = p.indexOf(0, o)
  return { addr, arg: p.slice(o, k).toString('latin1') }
}

const taps = new Map() // tap path → count
let off = 24
while (off + 16 <= buf.length) {
  const caplen = r32(off + 8)
  const rec = buf.slice(off + 16, off + 16 + caplen)
  off += 16 + caplen
  try {
    if (linktype === 1 && rec.readUInt16BE(12) !== 0x0800) continue
    const o = L2
    const ihl = (rec[o] & 0x0f) * 4
    if (rec[o + 9] !== 17) continue // not UDP
    const u = o + ihl
    const payload = rec.slice(u + 8)
    const m = oscAddrAndString(payload)
    if (m && m.addr.startsWith('/Meters/request/') && m.arg) taps.set(m.arg, (taps.get(m.arg) ?? 0) + 1)
  } catch { /* skip malformed */ }
}

if (taps.size === 0) {
  console.error('No /Meters/request tap paths found. Was an iPad metering through the relay while capturing?')
  process.exit(1)
}

// Group by channel-type root and reduce each to its meter-point template so the
// per-type format is obvious (e.g. Aux_Outputs → /N/<meter node>/<leg>).
const byType = new Map()
for (const tap of taps.keys()) {
  const m = /^\/([A-Za-z_]+)\/(\d+)\/(.+)$/.exec(tap)
  const type = m ? m[1] : '(other)'
  const template = m ? `/${type}/N/${m[3]}` : tap
  if (!byType.has(type)) byType.set(type, new Set())
  byType.get(type).add(template)
}

console.log(`\nMeter tap paths seen, by channel type (${taps.size} distinct taps):\n`)
for (const [type, templates] of byType) {
  console.log(`  ${type}`)
  for (const t of templates) console.log(`     ${t}`)
}
console.log('\nThe part after /N/ is the meter node — copy it into the connector per type.')
