import { EventEmitter } from 'node:events'

/**
 * A drop-in replacement for the legacy HyperDeck singleton, backed by the
 * connector engine. Every HyperDeck now runs as a first-class engine instance;
 * this bridge points the transition/look/OSC stack at ONE of them — the deck
 * chosen for ATEM transitions — reading its transport off the hub and routing
 * commands through the engine. No second TCP connection (the deck only accepts
 * one control connection at a time).
 *
 * It presents the same surface the legacy code depends on:
 *   .connected, .transport (raw HyperDeck key shape), .ip, .snapshot(),
 *   .command(step), .reconfigure(), .connect(), and 'connected'/'disconnected'/
 *   'transport' events.
 *
 * The selected deck is stored under the `transitionHyperdeckId` setting; call
 * setTransitionDeck(id) to repoint (Settings does this).
 */
export class HyperDeckBridge extends EventEmitter {
  constructor({ engine, store, defaultId = 'hyperdeck-1' }) {
    super()
    this._engine = engine
    this._store = store
    this._defaultId = defaultId
    this.connected = false
    this.transport = {} // last transport, in the raw HyperDeck key shape
    this.cfg = {} // kept for API-compatibility with the old singleton
    this._selectedId = null
    this._sub = { topics: new Set(), send: (m) => this._onFrame(m) }
    this._engine?.hub?.addSubscriber(this._sub)
    this._applySelection()
  }

  /** The instance id currently chosen to drive ATEM transitions. */
  get selectedId() {
    return this._store?.getSetting('transitionHyperdeckId', this._defaultId) ?? this._defaultId
  }

  /** IP of the selected deck (some legacy status views read this). */
  get ip() {
    const inst = this._store?.listInstances?.().find((i) => i.id === this._selectedId)
    return inst?.config?.ip ?? inst?.config?.host ?? null
  }

  /** Repoint at a different deck and persist the choice. */
  setTransitionDeck(id) {
    if (id) this._store?.setSetting('transitionHyperdeckId', id)
    this._applySelection()
  }

  _topics(id) {
    return [`mi:${id}:transport`, `mi:${id}:$status`]
  }

  _applySelection() {
    const hub = this._engine?.hub
    if (!hub) return
    const id = this.selectedId
    if (id === this._selectedId) return
    if (this._selectedId) hub.unsubscribe(this._sub, this._topics(this._selectedId))
    this._selectedId = id
    this.transport = {}
    const wasConnected = this.connected
    this.connected = false
    // subscribe() delivers current snapshots synchronously via _onFrame.
    hub.subscribe(this._sub, this._topics(id))
    if (wasConnected && !this.connected) this.emit('disconnected')
    this.emit('transport', this.transport)
  }

  _onFrame(msg) {
    let f
    try { f = JSON.parse(msg) } catch { return }
    if (f.t !== 'data' && f.t !== 'snap') return
    const id = this._selectedId
    if (f.topic === `mi:${id}:transport`) {
      this.transport = this._toLegacyTransport(f.data)
      this.emit('transport', this.transport)
    } else if (f.topic === `mi:${id}:$status`) {
      const on = f.data?.state === 'online'
      if (on !== this.connected) {
        this.connected = on
        this.emit(on ? 'connected' : 'disconnected')
      }
    }
  }

  /** Engine transport (parsed) → the raw HyperDeck key shape the legacy code
   *  reads (`t['clip id']`, `t.loop === 'true'`, `t.status`, …). */
  _toLegacyTransport(p) {
    if (!p) return {}
    const t = {}
    if (p.status != null) t.status = p.status
    if (p.clipId != null) t['clip id'] = String(p.clipId)
    if (p.loop != null) t.loop = String(p.loop)
    if (p.singleClip != null) t['single clip'] = String(p.singleClip)
    if (p.speed != null) t.speed = String(p.speed)
    if (p.timecode != null) t.timecode = p.timecode
    if (p.displayTimecode != null) t['display timecode'] = p.displayTimecode
    return t
  }

  /** Legacy step interface (sequencer + OSC) → an engine command. */
  async command(step) {
    const id = this._selectedId
    if (!this._engine || !id) throw new Error('HyperDeck bridge: no engine instance selected')
    const mapped = this._toEngineCommand(step)
    const res = await this._engine.command(id, mapped.cmd, mapped.input)
    if (!res?.ok) throw new Error(res?.error?.message || `HyperDeck ${step.command} failed`)
  }

  _toEngineCommand(step) {
    switch (step.command) {
      case 'play':
        return { cmd: 'play', input: { loop: step.loop, singleClip: step.singleClip, speed: step.speed } }
      case 'stop':
        return { cmd: 'stop', input: {} }
      case 'record':
        return { cmd: 'record', input: step.name ? { name: step.name } : {} }
      case 'gotoClip':
        return { cmd: 'gotoClip', input: { clip: Number(step.clip) } }
      case 'nextClip':
        return { cmd: 'nextClip', input: {} }
      case 'prevClip':
        return { cmd: 'prevClip', input: {} }
      case 'goto':
        return { cmd: 'goto', input: { timecode: step.timecode } }
      default:
        throw new Error(`Unsupported hyperdeck command '${step.command}'`)
    }
  }

  snapshot() {
    return { connected: this.connected, transport: this.transport }
  }

  // The engine owns the connection now; these stay as no-ops / repoint hooks so
  // the legacy call sites keep working unchanged.
  reconfigure() { this._applySelection() }
  connect() { /* no-op: the engine connects every deck */ }
}
