import { EventEmitter } from 'node:events'
import { config } from './config.js'

/**
 * ProPresenter timer poller.
 *
 * Polls the Pro7 REST API (Preferences -> Network must be enabled):
 *   GET /v1/timers          -> definitions (for countdown durations)
 *   GET /v1/timers/current  -> live values [{id:{uuid,name}, time, state}]
 *
 * Emits 'update' whenever timer values change. If no IP is configured, a
 * built-in demo timer (5:00 looping) runs instead so renderer pages can be
 * designed without ProPresenter on the network.
 *
 * Timer snapshot shape:
 *   { name, uuid, state: 'running'|'stopped'|'overrun',
 *     remaining: seconds (float, may be negative in overrun),
 *     duration: seconds|null, updatedAt: ms epoch }
 */
export class ProPresenter extends EventEmitter {
  constructor() {
    super()
    this.connected = false
    this.timers = new Map()
    this._durations = new Map()
    this._maxSeen = new Map()
    this._defsFetched = 0
    this._mockStart = Date.now()
    this._timer = null
  }

  start() {
    const tick = () => {
      const ms = Math.max(200, config.propresenter?.pollMs ?? 500)
      this._timer = setTimeout(tick, ms)
      this.poll().catch(() => {})
    }
    tick()
  }

  get baseUrl() {
    const c = config.propresenter
    if (!c?.ip) return null
    return `http://${c.ip}:${c.port ?? 50001}`
  }

  async poll() {
    const base = this.baseUrl
    if (!base) {
      this._mockTick()
      return
    }
    try {
      // Refresh countdown durations every 30s (cheap, rarely changes).
      if (Date.now() - this._defsFetched > 30000) {
        const defs = await this._get(`${base}/v1/timers`)
        this._durations.clear()
        for (const t of defs ?? []) {
          const dur = t.countdown?.duration ?? t.count_down?.duration ?? null
          if (t.id?.name != null) this._durations.set(t.id.name, dur)
        }
        this._defsFetched = Date.now()
      }

      const current = await this._get(`${base}/v1/timers/current`)
      const now = Date.now()
      let changed = !this.connected
      this.connected = true
      const seen = new Set()
      for (const t of current ?? []) {
        const name = t.id?.name
        if (name == null) continue
        seen.add(name)
        const remaining = parseTime(t.time)
        const state = normaliseState(t.state, remaining)
        const prev = this.timers.get(name)
        if (!prev || prev.remaining !== remaining || prev.state !== state) changed = true
        // Countdown-to-time timers report no duration in their definition.
        // Infer one: the highest remaining seen for this run; a jump UP
        // means the timer was reset, so start inferring afresh.
        let maxSeen = this._maxSeen.get(name) ?? 0
        if (prev && remaining > prev.remaining + 1.5) maxSeen = remaining
        else maxSeen = Math.max(maxSeen, remaining)
        this._maxSeen.set(name, maxSeen)
        const explicit = this._durations.get(name)
        this.timers.set(name, {
          name,
          uuid: t.id?.uuid,
          state,
          remaining,
          duration: explicit || (maxSeen > 0 ? maxSeen : null),
          updatedAt: now,
        })
      }
      for (const name of [...this.timers.keys()]) {
        if (!seen.has(name)) { this.timers.delete(name); changed = true }
      }
      if (changed) this.emit('update', this.snapshot())
    } catch (e) {
      if (this.connected) {
        console.error('[propresenter] poll failed:', e.message)
        this.connected = false
        this.emit('update', this.snapshot())
      }
    }
  }

  _mockTick() {
    // Demo timer: 5:00 counting down on a loop, plus a stopped one.
    const cycle = 5 * 60
    const elapsed = ((Date.now() - this._mockStart) / 1000) % cycle
    const remaining = Math.ceil(cycle - elapsed)
    const prev = this.timers.get('demo')
    this.connected = false
    this.timers.set('demo', {
      name: 'demo', uuid: 'demo', state: 'running',
      remaining, duration: cycle, updatedAt: Date.now(),
    })
    if (!this.timers.has('demo-stopped')) {
      this.timers.set('demo-stopped', {
        name: 'demo-stopped', uuid: 'demo-stopped', state: 'stopped',
        remaining: 10 * 60, duration: 10 * 60, updatedAt: Date.now(),
      })
    }
    if (!prev || prev.remaining !== remaining) this.emit('update', this.snapshot())
  }

  async _get(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`)
    return r.json()
  }

  snapshot() {
    return {
      connected: this.connected,
      configured: !!this.baseUrl,
      timers: [...this.timers.values()],
    }
  }
}

/** "0:04:37" / "04:37" / "-0:00:05" -> seconds (negative in overrun). */
function parseTime(str) {
  if (typeof str === 'number') return str
  if (!str) return 0
  const neg = String(str).trim().startsWith('-')
  const parts = String(str).replace(/^-/, '').trim().split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return neg ? -secs : secs
}

function normaliseState(state, remaining) {
  const s = String(state ?? '').toLowerCase()
  if (remaining < 0 || s.includes('overrun')) return 'overrun'
  if (s.includes('run') || s.includes('count')) return 'running'
  return 'stopped'
}
