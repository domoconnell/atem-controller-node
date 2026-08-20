#!/usr/bin/env node
/**
 * Scrapbook: talk to Sennheiser wireless gear directly, no WSM.
 *
 * Two known control paths:
 *  1. SSC (Sennheiser Sound Control) - JSON over UDP port 45.
 *     Used by EW-DX (and EM 6000, SpeechLine DW...). Request = JSON with
 *     null leaves; device fills them in. e.g. {"device":{"name":null}}
 *  2. evolution wireless G3/G4 - ASCII over UDP port 53212.
 *     Undocumented but well reverse-engineered (it's what WSM uses).
 *     "Push <timeout_s> <rate_ms> <flags>\r" subscribes to live updates;
 *     single words ("Name\r", "Frequency\r") query one value.
 *
 * NOTE: on Dom's Mac, node is LAN-blocked by Local Network TCC (use
 * sennheiser-probe.sh / nc there); this script is for the Pi.
 *
 * Usage: node scratch/sennheiser-probe.mjs [ip ...]
 *   no args = probe the whole known rig (.70-.83)
 */
import dgram from 'node:dgram'

const RIG = [
  ...['70', '71', '72'].map((o) => ({ ip: `10.10.10.${o}`, expect: 'ew-dx' })),
  ...['73', '74', '75', '76', '77'].map((o) => ({ ip: `10.10.10.${o}`, expect: 'ew300-g3' })),
  ...['78', '79', '80', '81', '82', '83'].map((o) => ({ ip: `10.10.10.${o}`, expect: 'iem-g4' })),
]
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((ip) => ({ ip, expect: '?' }))
  : RIG

const SSC_PORT = 45
const G3_PORT = 53212
const WINDOW_MS = 2500 // listen window per device

const SSC_PROBES = [
  '{"device":{"identity":{"product":null,"serial":null,"version":null}}}\r\n',
  '{"rx1":{"name":null,"frequency":null,"mute":null},"rx2":{"name":null,"frequency":null,"mute":null}}\r\n',
]
const G3_PROBES = [
  'Name\r',
  'Frequency\r',
  'Push 2 300 1\r',   // subscribe: 2s, 300ms cycle -> streams RF/AF/Bat/States
]

const printable = (buf) => {
  const s = buf.toString('utf8')
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s) ? s : null
}

function probe(ip, port, payloads, tag) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const got = []
    sock.on('message', (msg, rinfo) => {
      const txt = printable(msg)
      got.push({ from: `${rinfo.address}:${rinfo.port}`, len: msg.length, body: txt ?? msg.toString('hex') , hex: !txt })
    })
    sock.on('error', (e) => { got.push({ err: e.code || e.message }) })
    sock.bind(port === 53212 ? { port: 53212 } : undefined, () => {
      for (const p of payloads) sock.send(p, port, ip)
      // re-send once - first datagram sometimes primes ARP and gets dropped
      setTimeout(() => { for (const p of payloads) sock.send(p, port, ip) }, 400)
    })
    setTimeout(() => { try { sock.close() } catch {} ; resolve({ tag, got }) }, WINDOW_MS)
  })
}

const C = { dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' }

for (const t of targets) {
  process.stdout.write(`${C.b}${t.ip}${C.x} ${C.dim}(expect ${t.expect})${C.x}\n`)
  const [ssc, g3] = await Promise.all([
    probe(t.ip, SSC_PORT, SSC_PROBES, `ssc:45`),
    probe(t.ip, G3_PORT, G3_PROBES, `g3g4:53212`),
  ])
  for (const r of [ssc, g3]) {
    if (!r.got.length) { console.log(`  ${C.dim}${r.tag}  - silence${C.x}`); continue }
    console.log(`  ${C.g}${r.tag}  ${r.got.length} datagram(s)${C.x}`)
    const seen = new Set()
    for (const d of r.got) {
      if (d.err) { console.log(`    ${C.r}error: ${d.err}${C.x}`); continue }
      const lines = d.hex ? [d.body] : d.body.split(/\r\n?|\n/).filter(Boolean)
      for (const line of lines) {
        if (seen.has(line)) continue // collapse repeats from the Push stream
        seen.add(line)
        console.log(`    ${d.hex ? C.y + '[hex] ' : ''}${line}${C.x}`)
      }
    }
  }
}
