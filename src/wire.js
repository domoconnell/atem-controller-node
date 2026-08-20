import { EventEmitter } from 'node:events'
import { config } from './config.js'

/**
 * Unified wire log: one compact line for every message exchanged with a
 * connected device, colour/tag per protocol, arrow per direction.
 *
 *   12:01:03.123 → ATEM setSuperSourceBoxSettings {"x":-1120} 1 0
 *   12:01:03.180 ← HDCK 208 transport info status: play
 *
 * Consecutive messages of the same kind (e.g. 30fps animation frames,
 * ProPresenter polls) collapse into "⋮ ×N more <kind>" so the log stays
 * readable. Disable entirely with config.wireLog = false (hot).
 * Colours only when stdout is a TTY (journalctl gets plain text).
 */
/** Live feed of wire lines for the UI (web.js forwards over WebSocket). */
export const wireBus = new EventEmitter()
wireBus.setMaxListeners(50)
const HISTORY_MAX = 400
const history = []
export function wireHistory() { return history }
function record(entry) {
  history.push(entry)
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
  wireBus.emit('line', entry)
}

const TTY = !!process.stdout.isTTY
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s)

const PROTO = {
  atem:      { tag: 'ATEM', color: '33' },  // amber
  asim:      { tag: 'ASIM', color: '93' },  // bright amber (simulator)
  hyperdeck: { tag: 'HDCK', color: '36' },  // cyan
  osc:       { tag: 'OSC ', color: '32' },  // green
  companion: { tag: 'CMPN', color: '35' },  // magenta
  propres:   { tag: 'PRO ', color: '34' },  // blue
}

// Per-signature rate limiting: each (proto, direction, message-kind) prints
// at most once per WINDOW; suppressed repeats surface as a dim "⋮ ×N" line.
// This survives interleaving (tx/rx alternating during animations).
const WINDOW = 1000
const seen = new Map() // sig -> { lastPrint, suppressed, arrow, tag, color, kind }
let sweeper = null

function printSuppressed(sig, e) {
  if (e.suppressed > 0) {
    console.log(paint('2', `             ⋮ ${paint(e.color, `${e.arrow} ${e.tag}`)}${paint('2', ` ${e.kind} ×${e.suppressed} more`)}`))
    record({ t: Date.now(), dir: e.dir, proto: e.proto, repeat: e.suppressed, kind: e.kind })
    e.suppressed = 0
  }
  if (Date.now() - e.lastPrint > WINDOW * 4) seen.delete(sig)
}

export function wire(dir, proto, summary, detail = '') {
  if (config.wireLog === false) return
  const p = PROTO[proto] ?? { tag: String(proto).slice(0, 4).toUpperCase().padEnd(4), color: '37' }
  const kind = String(summary).split(' ')[0]
  const sig = `${proto}|${dir}|${kind}`
  const now = Date.now()

  if (!sweeper) {
    sweeper = setInterval(() => { for (const [g, e] of seen) printSuppressed(g, e) }, 1500)
    sweeper.unref?.()
  }

  const e = seen.get(sig)
  if (e && now - e.lastPrint < WINDOW) {
    e.suppressed++
    return
  }
  if (e) printSuppressed(sig, e)

  const arrow = dir === 'tx' ? '→' : '←'
  seen.set(sig, { lastPrint: now, suppressed: 0, arrow, tag: p.tag, color: p.color, kind, dir, proto })
  const ts = new Date().toISOString().slice(11, 23)
  console.log(
    `${paint('2', ts)} ${paint(p.color, `${arrow} ${p.tag}`)} ${summary}` +
    (detail ? ` ${paint('2', detail)}` : '')
  )
  record({ t: now, dir, proto, summary: String(summary), detail: String(detail || '') })
}

/** Compact one-line rendering of a value for log details. */
export function short(v, max = 90) {
  let s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s == null) return ''
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/** Proxy a device backend so every command method logs a tx line. */
const CMD_RE = /^(set|change|cut$|autoTransition$|upload|run)/
export function loggedBackend(backend, protoOf) {
  return new Proxy(backend, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t)
      if (typeof v === 'function' && CMD_RE.test(String(prop))) {
        return (...args) => {
          wire('tx', protoOf(), String(prop), short(args.map((a) => short(a, 60)).join(' '), 110))
          return v.apply(t, args)
        }
      }
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
