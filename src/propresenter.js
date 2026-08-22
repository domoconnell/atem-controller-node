import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { wire, short } from './wire.js'

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
    this._looksFetched = 0
    this.currentLook = null // { uuid, name, index, stableUuid } — the live audience look
    this.looksList = [] // [{ uuid, name, index }] — all defined audience looks
    this.currentMedia = null // { playlist:{uuid,name,index}, item:{uuid,name,index} } — the live background media, or null
    this._mockStart = Date.now()
    this._timer = null
    // Runtime config: seeded from config.json, overridable from the Settings UI
    // via reconfigure() (the SQLite instance is the live source of truth).
    this.cfg = { ...config.propresenter }
  }

  /** Apply new connection settings (IP/port/pollMs) from Settings. The poll
   *  loop reads baseUrl each tick, so the next poll targets the new host; reset
   *  state so stale timers clear and the status flips immediately. */
  reconfigure(patch = {}) {
    this.cfg = { ...this.cfg, ...patch }
    this.connected = false
    this.timers.clear()
    this._defsFetched = 0
    this.emit('update', this.snapshot())
  }

  start() {
    const tick = () => {
      const ms = Math.max(200, this.cfg?.pollMs ?? 500)
      this._timer = setTimeout(tick, ms)
      this.poll().catch(() => {})
    }
    tick()
  }

  get baseUrl() {
    const c = this.cfg
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
      // Current audience look + look list, for capturing/recalling a look as
      // part of a Stage It "look". Cheap; polled ~1s. Isolated so a PP build
      // without the looks endpoints never disturbs timer connectivity.
      if (now - this._looksFetched > 1000) {
        this._looksFetched = now
        try {
          const [cur, list] = await Promise.all([
            this._get(`${base}/v1/look/current`).catch(() => null),
            this._get(`${base}/v1/looks`).catch(() => null),
          ])
          if (Array.isArray(list)) this.looksList = list.map((l) => ({ uuid: l.id?.uuid, name: l.id?.name, index: l.id?.index }))
          if (cur?.id) {
            // The live look reports an EPHEMERAL uuid; resolve the stable one
            // (used for recall) by matching the name in the look list.
            const stable = this.looksList.find((l) => l.name === cur.id.name)?.uuid
            const next = { uuid: cur.id.uuid, name: cur.id.name, index: cur.id.index, stableUuid: stable ?? cur.id.uuid }
            if (this.currentLook?.name !== next.name) changed = true
            this.currentLook = next
          } else if (this.currentLook) { this.currentLook = null; changed = true }
          // Live background media on the audience wall. Its uuids are stable
          // (they match the enumerated playlist), so recall by uuid directly.
          const active = await this._get(`${base}/v1/media/playlist/active`).catch(() => null)
          const it = active?.item?.uuid ? { playlist: this._idOf(active.playlist), item: this._idOf(active.item) } : null
          if ((this.currentMedia?.item?.uuid ?? null) !== (it?.item?.uuid ?? null)) changed = true
          this.currentMedia = it
        } catch { /* looks/media unsupported on this PP build — leave last known */ }
      }
      if (changed) {
        wire('rx', 'propres', 'timers-changed', short([...this.timers.values()].map((t) => `${t.name}=${Math.round(t.remaining)}s/${t.state}`).join(' '), 110))
        this.emit('update', this.snapshot())
      }
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
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    wire('tx', 'propres', `GET ${path}`)
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    wire('rx', 'propres', `${r.status} ${path}`)
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`)
    return r.json()
  }

  snapshot() {
    return {
      connected: this.connected,
      configured: !!this.baseUrl,
      timers: [...this.timers.values()],
      currentLook: this.currentLook,
      currentMedia: this.currentMedia,
    }
  }

  /**
   * Fetch the ProPresenter playlist tree, flattened to the playlists a service
   * can link to. Groups are recursed into and contribute a "Group / Name" path.
   *   GET /v1/playlists -> { items: [{ id:{uuid,name}, field_type, children? }] }
   * Returns [{ id, name, path }]. Empty array if PP is not configured.
   */
  async getPlaylists() {
    const base = this.baseUrl
    if (!base) return []
    const root = await this._get(`${base}/v1/playlists`)
    const out = []
    const walk = (nodes, prefix) => {
      for (const n of nodes ?? []) {
        const name = n.id?.name ?? n.name ?? '?'
        const uuid = n.id?.uuid ?? n.uuid
        const kind = String(n.field_type ?? n.type ?? '').toLowerCase()
        const path = prefix ? `${prefix} / ${name}` : name
        if (Array.isArray(n.children) && (kind.includes('group') || n.children.length)) {
          walk(n.children, path)
        } else if (uuid) {
          out.push({ id: uuid, name, path })
        }
      }
    }
    walk(root?.items ?? (Array.isArray(root) ? root : []), '')
    return out
  }

  /**
   * Fetch one playlist's ordered items as segment seeds.
   *   GET /v1/playlist/{id} -> { items: [{ id:{uuid,name,index}, type, header_color }] }
   * ProPresenter uses `type:'header'` rows (with a header_color) to group the
   * items beneath them; everything else ('placeholder', 'presentation', media…)
   * is a real item. We surface that distinction so headers become headers.
   * Returns [{ uuid, name, index, type, color }] in playlist order, or null if
   * PP is not configured (so a temporary outage never wipes a linked runsheet).
   */
  async getPlaylistItems(playlistId) {
    const base = this.baseUrl
    if (!base || !playlistId) return null
    const pl = await this._get(`${base}/v1/playlist/${encodeURIComponent(playlistId)}`)
    const items = (pl?.items ?? []).map((it, i) => ({
      uuid: it.id?.uuid ?? it.uuid ?? `idx${i}`,
      name: it.id?.name ?? it.name ?? `Item ${i + 1}`,
      index: it.id?.index ?? i,
      type: it.type === 'header' ? 'header' : 'item',
      color: it.type === 'header' ? ppColorToHex(it.header_color) : undefined,
    }))
    items.sort((a, b) => a.index - b.index)
    return items
  }

  /** All audience looks: [{ uuid, name, index }]. Empty if PP unconfigured. */
  async getLooks() {
    const base = this.baseUrl
    if (!base) return []
    const list = await this._get(`${base}/v1/looks`).catch(() => [])
    return (Array.isArray(list) ? list : []).map((l) => ({ uuid: l.id?.uuid, name: l.id?.name, index: l.id?.index }))
  }

  /** All macros: [{ uuid, name, index }]. Empty if none/unsupported. */
  async getMacros() {
    const base = this.baseUrl
    if (!base) return []
    const list = await this._get(`${base}/v1/macros`).catch(() => [])
    return (Array.isArray(list) ? list : []).map((m) => ({ uuid: m.id?.uuid, name: m.id?.name, index: m.id?.index }))
  }

  /** Trigger an audience look by uuid or name. Idempotent on the output —
   *  re-triggering the current look changes nothing visible. */
  async triggerLook(idOrName) {
    const base = this.baseUrl
    if (!base || !idOrName) return false
    return this._trigger(`${base}/v1/look/${encodeURIComponent(idOrName)}/trigger`)
  }

  /** Trigger a macro by uuid or name. */
  async triggerMacro(idOrName) {
    const base = this.baseUrl
    if (!base || !idOrName) return false
    return this._trigger(`${base}/v1/macro/${encodeURIComponent(idOrName)}/trigger`)
  }

  /** Media (background) playlists, flattened through groups:
   *  [{ id, name, path }] (id = playlist uuid). */
  async getMediaPlaylists() {
    const base = this.baseUrl
    if (!base) return []
    const root = await this._get(`${base}/v1/media/playlists`).catch(() => [])
    const out = []
    const walk = (nodes, prefix) => {
      for (const n of nodes ?? []) {
        const name = n.id?.name ?? '?'
        const uuid = n.id?.uuid
        const path = prefix ? `${prefix} / ${name}` : name
        const kind = String(n.type ?? '').toLowerCase()
        if (kind === 'group' && Array.isArray(n.children)) walk(n.children, path)
        else if (uuid) out.push({ id: uuid, name, path })
      }
    }
    walk(Array.isArray(root) ? root : root?.items, '')
    return out
  }

  /** One media playlist's items: [{ uuid, name, index, type, duration }]. */
  async getMediaItems(playlistId) {
    const base = this.baseUrl
    if (!base || !playlistId) return []
    const pl = await this._get(`${base}/v1/media/playlist/${encodeURIComponent(playlistId)}`).catch(() => null)
    return (pl?.items ?? []).map((it) => ({ uuid: it.id?.uuid, name: it.id?.name, index: it.id?.index, type: it.type, duration: it.duration }))
  }

  /** Trigger a background media item (playlist uuid + item uuid). Puts it on
   *  the audience wall's media layer. */
  async triggerMedia(playlistId, itemId) {
    const base = this.baseUrl
    if (!base || !playlistId || !itemId) return false
    return this._trigger(`${base}/v1/media/playlist/${encodeURIComponent(playlistId)}/${encodeURIComponent(itemId)}/trigger`)
  }

  /** Trigger a presentation (by uuid or name). With `index` set, jumps to that
   *  slide/cue; without it, triggers the presentation (its first cue). Used by
   *  runsheet automation to bring a song/message up as its item goes live. */
  async triggerPresentation(idOrUuid, index) {
    const base = this.baseUrl
    if (!base || !idOrUuid) return false
    const suffix = index != null && index !== '' ? `/${encodeURIComponent(index)}` : ''
    return this._trigger(`${base}/v1/presentation/${encodeURIComponent(idOrUuid)}${suffix}/trigger`)
  }

  /** Clear the audience media layer (remove the background). */
  async clearMedia() {
    const base = this.baseUrl
    if (!base) return false
    return this._trigger(`${base}/v1/clear/layer/media`)
  }

  _idOf(o) { return o ? { uuid: o.uuid, name: o.name, index: o.index } : null }

  /** GET a trigger endpoint that answers 204/no-body (so _get's JSON parse
   *  would throw). Returns true on 2xx. */
  async _trigger(url) {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    wire('tx', 'propres', `GET ${path}`)
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      wire('rx', 'propres', `${r.status} ${path}`)
      return r.ok
    } catch (e) {
      wire('rx', 'propres', `ERR ${path} ${e.message}`)
      return false
    }
  }
}

/** ProPresenter header_color {red,green,blue,alpha} (0..1 floats) -> "#rrggbb". */
function ppColorToHex(c) {
  if (!c) return undefined
  const h = (v) => Math.max(0, Math.min(255, Math.round((v ?? 0) * 255))).toString(16).padStart(2, '0')
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`
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
