import { EventEmitter } from 'node:events'
import { Atem, Enums } from 'atem-connection'
import { config } from './config.js'
import { AtemSim } from './atem-sim.js'
import { wire, loggedBackend } from './wire.js'

const SELECTION_MAP = {
  background: Enums.TransitionSelection.Background,
  key1: Enums.TransitionSelection.Key1,
  key2: Enums.TransitionSelection.Key2,
  key3: Enums.TransitionSelection.Key3,
  key4: Enums.TransitionSelection.Key4,
}

const SELECTION_NAMES = Object.fromEntries(
  Object.entries(SELECTION_MAP).map(([name, v]) => [v, name])
)

const STYLE_MAP = {
  mix: Enums.TransitionStyle.MIX,
  dip: Enums.TransitionStyle.DIP,
  wipe: Enums.TransitionStyle.WIPE,
  dve: Enums.TransitionStyle.DVE,
  sting: Enums.TransitionStyle.STING,
}

/**
 * Wrapper around atem-connection with friendly helpers for the bits this
 * project cares about: SuperSource boxes, M/E transitions and USKs.
 *
 * Emits: 'connected', 'disconnected', 'stateChanged'
 */
export class AtemController extends EventEmitter {
  constructor() {
    super()
    this.real = new Atem()
    this._realLogged = loggedBackend(this.real, () => 'atem')
    this.sim = null
    this.atem = this._realLogged   // whichever backend is active (wire-logged)
    this.simulated = false
    this.connected = false
    // Runtime config: seeded from config.json, overridable from Settings via
    // reconfigure() (the SQLite instance is the live source of truth).
    this.cfg = { ...config.atem }

    this.real.on('connected', () => {
      if (this.simulated) {
        console.log('[atem] real ATEM appeared - leaving simulator')
        this._useReal()
      }
      this.connected = true
      console.log('[atem] connected to', this.cfg.ip)
      this.emit('connected')
      this.emit('stateChanged')
    })
    this.real.on('disconnected', () => {
      if (this.simulated) return
      this.connected = false
      console.log('[atem] disconnected')
      this.emit('disconnected')
      this.emit('stateChanged')
      this._scheduleSimFallback()
    })
    this.real.on('stateChanged', (_state, paths) => {
      if (this.simulated) return
      wire('rx', 'atem', pathSig(paths), paths?.length > 1 ? `+${paths.length - 1} more` : '')
      this.emit('stateChanged', paths)
    })
    this.real.on('error', (e) => console.error('[atem] error:', e))
  }

  // SuperSource id and main M/E are behavioural settings read live from the
  // settings-backed config, so a change in ATEM Transitions settings takes
  // effect immediately (no restart / no cached constructor value).
  get ssrcId() { return config.supersource.id }
  get me() { return config.supersource.me }

  async connect() {
    this._scheduleSimFallback()
    await this.real.connect(this.cfg.ip)
  }

  /**
   * Apply new connection settings from Settings (IP / sim fallback) and
   * reconnect to the new switcher. Tears down the simulator if it was running
   * and drops the old real connection first; the usual sim-fallback still
   * applies if the new target isn't reachable (keeps the app usable).
   */
  async reconfigure(patch = {}) {
    this.cfg = { ...this.cfg, ...patch }
    clearTimeout(this._simTimer)
    const was = this.connected || this.simulated
    if (this.sim) { this.sim.removeAllListeners(); try { this.sim.disconnect() } catch { /* noop */ } this.sim = null }
    this.simulated = false
    this.atem = this._realLogged
    try { await this.real.disconnect() } catch { /* not connected */ }
    this.connected = false
    if (was) { this.emit('disconnected'); this.emit('stateChanged') }
    await this.connect()
  }

  /**
   * If the real switcher hasn't connected within the grace period, run the
   * built-in simulator so the whole app is usable (planning, previews,
   * dry-running transitions). The real one takes over if it turns up.
   */
  _scheduleSimFallback() {
    if (this.cfg?.simulate === false) return
    clearTimeout(this._simTimer)
    const grace = this.cfg?.simFallbackMs ?? 4000
    this._simTimer = setTimeout(() => {
      if (this.connected || this.simulated) return
      this._useSim()
    }, grace)
  }

  _useSim() {
    this.sim = new AtemSim({ videoFps: config.transition?.videoFps ?? 50 })
    this.atem = loggedBackend(this.sim, () => 'asim')
    this.simulated = true
    this.sim.on('stateChanged', (_s, paths) => {
      wire('rx', 'asim', pathSig(paths), paths?.length > 1 ? `+${paths.length - 1} more` : '')
      this.emit('stateChanged', paths)
    })
    this.sim.on('connected', () => {
      this.connected = true
      console.log('[atem] ⚠ no ATEM at', this.cfg.ip, '- running the built-in SIMULATOR')
      this.emit('connected')
      this.emit('stateChanged')
    })
    this.sim.connect()
  }

  _useReal() {
    if (this.sim) { this.sim.removeAllListeners(); this.sim = null }
    this.atem = this._realLogged
    this.simulated = false
  }

  get state() {
    return this.atem.state
  }

  // ---- SuperSource -------------------------------------------------------

  /** Current SuperSource box states (array of 4, each may be undefined). */
  getBoxes() {
    return this.state?.video?.superSources?.[this.ssrcId]?.boxes ?? []
  }

  /** Set properties on one SuperSource box. props uses raw ATEM units. */
  async setBox(boxId, props) {
    await this.atem.setSuperSourceBoxSettings(props, boxId, this.ssrcId)
  }

  /** Set several boxes at once: { 0: {...}, 2: {...} } */
  async setBoxes(boxProps) {
    await Promise.all(
      Object.entries(boxProps).map(([boxId, props]) =>
        this.atem.setSuperSourceBoxSettings(props, Number(boxId), this.ssrcId)
      )
    )
  }

  // ---- M/E ---------------------------------------------------------------

  getMixEffect(me = this.me) {
    return this.state?.video?.mixEffects?.[me]
  }

  async setPreview(input, me = this.me) {
    await this.atem.changePreviewInput(input, me)
  }

  async setProgram(input, me = this.me) {
    await this.atem.changeProgramInput(input, me)
  }

  async cut(me = this.me) {
    await this.atem.cut(me)
  }

  /**
   * Set the next transition selection/style.
   * selection: array of 'background' | 'key1'..'key4'
   * style: 'mix' | 'dip' | 'wipe' | 'dve' | 'sting' (optional)
   */
  async setNextTransition(selection, style, me = this.me) {
    const props = {}
    if (selection) {
      props.nextSelection = selection.map((s) => {
        const v = SELECTION_MAP[String(s).toLowerCase()]
        if (v === undefined) throw new Error(`Unknown transition selection '${s}'`)
        return v
      })
    }
    if (style) {
      const v = STYLE_MAP[String(style).toLowerCase()]
      if (v === undefined) throw new Error(`Unknown transition style '${style}'`)
      props.nextStyle = v
    }
    await this.atem.setTransitionStyle(props, me)
  }

  /** Mix transition rate for a M/E, in frames. */
  getMixRate(me = this.me) {
    return this.getMixEffect(me)?.transitionSettings?.mix?.rate
  }

  async setMixRate(frames, me = this.me) {
    await this.atem.setMixTransitionSettings({ rate: Number(frames) }, me)
  }

  /** Kick off an auto transition and resolve once it has fully completed. */
  async autoTransition(me = this.me) {
    await this.atem.autoTransition(me)
    await this.waitForTransitionEnd(me)
  }

  /** Resolve when mixEffects[me] is no longer mid-transition. */
  waitForTransitionEnd(me = this.me, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let sawTransition = false
      const check = () => {
        const mix = this.getMixEffect(me)
        const inTransition = mix?.transitionPosition?.inTransition ?? false
        if (inTransition) sawTransition = true
        // Resolve once we've seen it running and it stops, or if it never
        // started within a grace period (e.g. rate 0 -> effectively a cut).
        if (sawTransition && !inTransition) done()
      }
      const done = () => {
        clearTimeout(timer)
        clearTimeout(grace)
        this.off('stateChanged', check)
        resolve()
      }
      const timer = setTimeout(() => {
        this.off('stateChanged', check)
        clearTimeout(grace)
        reject(new Error(`Transition on M/E ${me + 1} did not complete within ${timeoutMs}ms`))
      }, timeoutMs)
      // If nothing starts within 500ms, assume it completed instantly.
      const grace = setTimeout(() => {
        if (!sawTransition) done()
      }, 500)
      this.on('stateChanged', check)
      check()
    })
  }

  // ---- USKs --------------------------------------------------------------

  getUskOnAir(keyer, me = this.me) {
    return this.getMixEffect(me)?.upstreamKeyers?.[keyer]?.onAir ?? false
  }

  async setUskOnAir(keyer, onAir, me = this.me) {
    await this.atem.setUpstreamKeyerOnAir(onAir, me, keyer)
  }

  /**
   * Full settings snapshot of every USK on a M/E: key type, fill/cut
   * sources, luma clip/gain, DVE position/borders, masks, fly keyframes.
   */
  getUskSettings(me = this.me) {
    const KEY_TYPES = { 0: 'luma', 1: 'chroma', 2: 'pattern', 3: 'dve' }
    return (this.getMixEffect(me)?.upstreamKeyers ?? []).map((k) => {
      if (!k) return null
      return {
        onAir: k.onAir,
        keyType: KEY_TYPES[k.mixEffectKeyType] ?? k.mixEffectKeyType,
        fillSource: k.fillSource,
        fillSourceName: this.getInputName(k.fillSource),
        cutSource: k.cutSource,
        cutSourceName: this.getInputName(k.cutSource),
        flyEnabled: k.flyEnabled,
        canFlyKey: k.canFlyKey,
        mask: k.maskSettings ? { ...k.maskSettings } : null,
        luma: k.lumaSettings ? { ...k.lumaSettings } : null,
        dve: k.dveSettings ? { ...k.dveSettings } : null,
        chroma: k.chromaSettings ? { ...k.chromaSettings } : null,
        pattern: k.patternSettings ? { ...k.patternSettings } : null,
        flyKeyframes: (k.flyKeyframes ?? []).map((f) => (f ? { ...f } : null)),
      }
    })
  }

  /** Human-readable name for an input number, e.g. 6000 -> "SuperSource". */
  getInputName(id) {
    const input = this.state?.inputs?.[id]
    return input?.longName || input?.shortName || String(id)
  }

  /**
   * Media player sources: what still/clip each MP is showing, with the
   * still's filename (from the media pool) so looks are self-documenting.
   */
  getMediaPlayers() {
    const media = this.state?.media
    return (media?.players ?? []).map((p, i) => {
      if (!p) return null
      const isStill = p.sourceType === 1 // Enums.MediaSourceType.Still
      const idx = isStill ? p.stillIndex : p.clipIndex
      const still = isStill ? media.stillPool?.[p.stillIndex] : null
      const clip = !isStill ? media.clipPool?.[p.clipIndex] : null
      return {
        index: i,
        sourceType: isStill ? 'still' : 'clip',
        stillIndex: p.stillIndex,
        clipIndex: p.clipIndex,
        name: still?.fileName || clip?.name || `${isStill ? 'still' : 'clip'} ${idx + 1}`,
        playing: p.playing,
        loop: p.loop,
      }
    })
  }

  async setMediaPlayerSource(player, { sourceType, stillIndex, clipIndex }) {
    const props = {}
    if (sourceType) props.sourceType = sourceType === 'still' ? 1 : 2
    if (stillIndex != null) props.stillIndex = stillIndex
    if (clipIndex != null) props.clipIndex = clipIndex
    await this.atem.setMediaPlayerSource(props, player)
  }

  /** ATEM input numbers for a media player's fill and key: MP1 = 3010/3011. */
  mediaPlayerInputs(i) {
    return { fill: 3010 + i * 10, key: 3011 + i * 10 }
  }

  /** SuperSource art/fill settings. */
  getSsProperties() {
    const props = this.state?.video?.superSources?.[this.ssrcId]?.properties
    return props ? { ...props } : null
  }

  /** Next-transition style/selection for a M/E, with friendly names. */
  getNextTransition(me = this.me) {
    const tp = this.getMixEffect(me)?.transitionProperties
    if (!tp) return null
    const styleName = Object.keys(STYLE_MAP).find((k) => STYLE_MAP[k] === tp.nextStyle)
    return {
      style: styleName ?? tp.nextStyle,
      selection: (tp.nextSelection ?? []).map((v) => SELECTION_NAMES[v] ?? v),
    }
  }

  // ---- USK settings (pattern / fill / mask) -----------------------------

  async setUskPattern(keyer, props, me = this.me) {
    await this.atem.setUpstreamKeyerPatternSettings(props, me, keyer)
  }

  async setUskType(keyer, props, me = this.me) {
    await this.atem.setUpstreamKeyerType(props, me, keyer)
  }

  async setUskFillSource(keyer, source, me = this.me) {
    await this.atem.setUpstreamKeyerFillSource(source, me, keyer)
  }

  async setUskCutSource(keyer, source, me = this.me) {
    await this.atem.setUpstreamKeyerCutSource(source, me, keyer)
  }

  async setUskMask(keyer, props, me = this.me) {
    await this.atem.setUpstreamKeyerMaskSettings(props, me, keyer)
  }

  /**
   * Bring a keyer's static settings (type, sources, pattern, mask) in line
   * with a recorded look's keyer entry. Only sends what differs.
   */
  async applyUskSettings(keyer, want, me = this.me) {
    const live = this.getUskSettings(me)[keyer]
    if (!live || !want) return
    const KEY_TYPES = { luma: 0, chroma: 1, pattern: 2, dve: 3 }
    if (want.keyType && want.keyType !== live.keyType) {
      await this.setUskType(keyer, { mixEffectKeyType: KEY_TYPES[want.keyType] }, me)
    }
    if (want.fillSource !== undefined && want.fillSource !== live.fillSource) {
      await this.setUskFillSource(keyer, want.fillSource, me)
    }
    if (want.cutSource !== undefined && want.cutSource !== live.cutSource) {
      await this.setUskCutSource(keyer, want.cutSource, me)
    }
    if (want.pattern) {
      const diff = {}
      for (const [k, v] of Object.entries(want.pattern)) {
        if (live.pattern?.[k] !== v) diff[k] = v
      }
      if (Object.keys(diff).length) await this.setUskPattern(keyer, diff, me)
    }
    if (want.mask) {
      const diff = {}
      for (const [k, v] of Object.entries(want.mask)) {
        if (live.mask?.[k] !== v) diff[k] = v
      }
      if (Object.keys(diff).length) await this.setUskMask(keyer, diff, me)
    }
  }

  // ---- Snapshot for UI / looks ------------------------------------------

  /** Compact snapshot of everything the UI and look store care about. */
  snapshot() {
    const boxes = this.getBoxes().map((b) => (b ? { ...b } : null))
    const mes = (this.state?.video?.mixEffects ?? []).map((mix) => {
      if (!mix) return null
      return {
        programInput: mix.programInput,
        previewInput: mix.previewInput,
        inTransition: mix.transitionPosition?.inTransition ?? false,
        handlePosition: mix.transitionPosition?.handlePosition ?? 0,
        nextStyle: mix.transitionProperties?.nextStyle,
        nextSelection: mix.transitionProperties?.nextSelection,
        mixRate: mix.transitionSettings?.mix?.rate,
        keyers: (mix.upstreamKeyers ?? []).map((k) => (k ? {
          onAir: k.onAir,
          fillSource: k.fillSource,
          keyType: ({ 0: 'luma', 1: 'chroma', 2: 'pattern', 3: 'dve' })[k.mixEffectKeyType] ?? 'luma',
          pattern: k.patternSettings ? { style: k.patternSettings.style, size: k.patternSettings.size, symmetry: k.patternSettings.symmetry, positionX: k.patternSettings.positionX, positionY: k.patternSettings.positionY, invert: k.patternSettings.invert } : null,
        } : null)),
        nextSelectionNames: (mix.transitionProperties?.nextSelection ?? []).map((v) => SELECTION_NAMES[v] ?? v),
        transitionSelectionNames: (mix.transitionProperties?.selection ?? []).map((v) => SELECTION_NAMES[v] ?? v),
        art: this.getSsProperties(),
      }
    })
    const inputs = {}
    for (const [id, input] of Object.entries(this.state?.inputs ?? {})) {
      if (input) inputs[id] = input.longName || input.shortName || String(id)
    }
    const mediaPlayers = this.getMediaPlayers().map((mp) => (mp ? { index: mp.index, sourceType: mp.sourceType, name: mp.name } : null))
    // Available hardware options, for the Settings dropdowns (only meaningful
    // while connected): how many SuperSources / M/Es / boxes this switcher has.
    const ss = this.state?.video?.superSources
    const options = {
      superSourceCount: Math.max(1, Object.keys(ss ?? {}).length),
      meCount: Math.max(1, (this.state?.video?.mixEffects ?? []).length),
      boxCount: ss?.[this.ssrcId]?.boxes?.length ?? 4,
    }
    return { connected: this.connected, simulated: this.simulated, boxes, mixEffects: mes, inputs, mediaPlayers, options }
  }
}

/** Compact signature for a state-change path list. */
function pathSig(paths) {
  const p = paths?.[0]
  if (!p) return 'state'
  return String(p).split('.').slice(0, 4).join('.')
}
