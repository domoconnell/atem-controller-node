import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { looksDir } from './config.js'

/**
 * Built-in ATEM simulator - a drop-in for atem-connection's `Atem` object.
 *
 * Implements the same methods and the same `state` shape the wrapper uses,
 * emits 'connected' / 'stateChanged' the same way, and mutates state the way
 * the real switcher would (auto transitions run over the mix rate and swap
 * program/preview, keys toggle, boxes move...). Everything above it -
 * wrapper, engine, sequencer, animator, UI, grader - runs unmodified.
 *
 * Seeded from the first recorded look (or a sensible default) so it boots
 * into a familiar state. Used automatically when the real ATEM is not
 * reachable; the UI shows the ATEM LED amber while simulating.
 */
export class AtemSim extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.videoFps = opts.videoFps ?? 50
    this.state = this._seed()
    this._transitionTimer = null
  }

  // ---- lifecycle -------------------------------------------------------
  async connect() {
    // "connect" instantly, asynchronously like the real one
    setTimeout(() => this.emit('connected'), 30)
  }
  disconnect() { this.emit('disconnected') }

  _changed(paths = []) {
    this.emit('stateChanged', this.state, paths)
  }

  // ---- seed ------------------------------------------------------------
  _seed() {
    let look = null
    try {
      const files = readdirSync(looksDir).filter((f) => f.endsWith('.json')).sort()
      if (files.length) look = JSON.parse(readFileSync(path.join(looksDir, files[0]), 'utf8'))
    } catch { /* no looks yet */ }

    const inputs = {}
    const add = (id, longName, shortName) => { inputs[id] = { inputId: id, longName, shortName } }
    add(0, 'Black', 'BLK'); add(1, 'Camera 1', 'CAM1'); add(2, 'Camera 2', 'CAM2'); add(3, 'Camera 3', 'CAM3')
    add(4, 'Camera 4', 'CAM4'); add(5, 'Camera 5', 'CAM5'); add(9, 'Worship', 'WRSH'); add(14, 'HD 3', 'HD3')
    add(15, 'ProMain', 'PRO'); add(1000, 'Color Bars', 'BARS'); add(2001, 'Color 1', 'COL1'); add(2002, 'Color 2', 'COL2')
    add(3010, 'Media Player 1', 'MP1'); add(3011, 'Media Player 1 Key', 'MP1K')
    add(3020, 'Media Player 2', 'MP2'); add(3021, 'Media Player 2 Key', 'MP2K')
    add(6000, 'SuperSource 1', 'SSRC'); add(10010, 'ME 1', 'ME1'); add(10020, 'ME 2', 'ME2')
    // add any input the seed look references but we don't know
    for (const b of look?.boxes ?? []) if (b && !inputs[b.source]) add(b.source, b.sourceName ?? `Input ${b.source}`, `IN${b.source}`)

    const defaultBox = (i) => ({ enabled: false, source: 0, x: 0, y: 0, size: 1000, cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 })
    const boxes = [0, 1, 2, 3].map((i) => {
      const b = look?.boxes?.[i]
      if (!b) return defaultBox(i)
      const { sourceName, ...rest } = b // eslint-disable-line no-unused-vars
      return { ...defaultBox(i), ...rest }
    })

    const KEY_TYPES = { luma: 0, chroma: 1, pattern: 2, dve: 3 }
    const usk = [0, 1, 2, 3].map((i) => {
      const k = look?.me?.usk?.[i]
      return {
        upstreamKeyerId: i,
        canFlyKey: true,
        flyEnabled: !!k?.flyEnabled,
        mixEffectKeyType: KEY_TYPES[k?.keyType] ?? 0,
        fillSource: k?.fillSource ?? (i === 0 ? 3010 : i === 1 ? 3020 : 0),
        cutSource: k?.cutSource ?? (i === 0 ? 3011 : i === 1 ? 3021 : 0),
        onAir: !!k?.onAir,
        maskSettings: k?.mask ?? { maskEnabled: false, maskTop: 9000, maskBottom: -9000, maskLeft: -16000, maskRight: 16000 },
        lumaSettings: k?.luma ?? { preMultiplied: false, clip: 500, gain: 700, invert: false },
        patternSettings: k?.pattern ?? { style: 2, size: 5000, symmetry: 5000, softness: 0, positionX: 5000, positionY: 5000, invert: false },
        dveSettings: k?.dve ?? null,
        chromaSettings: null,
        flyKeyframes: [null, null],
      }
    })

    const mkMe = (pgm, pvw, keys) => ({
      index: 0,
      programInput: pgm,
      previewInput: pvw,
      transitionPreview: false,
      transitionPosition: { inTransition: false, handlePosition: 0, remainingFrames: 0 },
      transitionProperties: { style: 0, selection: [1], nextStyle: 0, nextSelection: [1] },
      transitionSettings: { mix: { rate: 25 } },
      upstreamKeyers: keys,
    })
    const pgm2 = look?.me?.programInput ?? 6000
    const otherKeys = [0, 1, 2, 3].map((i) => ({ ...usk[i], onAir: false, patternSettings: { ...usk[i].patternSettings }, maskSettings: { ...usk[i].maskSettings }, lumaSettings: { ...usk[i].lumaSettings } }))

    const stillPool = Array.from({ length: 20 }, (_, i) => ({
      isUsed: i < 6, hash: '', fileName: ['border-centre.png', 'border-imag.png', 'mask-left.png', 'mask-right.png', 'logo.png', 'mask-worship.png'][i] ?? '',
    }))
    const players = [0, 1].map((i) => {
      const mp = look?.mediaPlayers?.[i]
      return { playing: false, loop: false, atBeginning: true, clipFrame: 0, sourceType: 1, stillIndex: mp?.stillIndex ?? i, clipIndex: 0 }
    })

    return {
      info: { model: 'SIM', productIdentifier: 'ATEM Simulator' },
      inputs,
      video: {
        mixEffects: [mkMe(1, 2, otherKeys), mkMe(pgm2, look?.me?.previewInput ?? pgm2, usk)],
        superSources: [{
          index: 0,
          boxes,
          properties: look?.ssProperties
            ? { artFillSource: look.ssProperties.artFillSource, artCutSource: look.ssProperties.artCutSource, artOption: look.ssProperties.artOption ?? 0, artPreMultiplied: !!look.ssProperties.artPreMultiplied, artClip: look.ssProperties.artClip ?? 500, artGain: look.ssProperties.artGain ?? 700, artInvertKey: !!look.ssProperties.artInvertKey }
            : { artFillSource: 14, artCutSource: 3011, artOption: 0, artPreMultiplied: false, artClip: 500, artGain: 700, artInvertKey: false },
          border: null,
        }],
        downstreamKeyers: [],
        auxilliaries: [],
      },
      media: { stillPool, clipPool: [], players },
    }
  }

  // ---- M/E ---------------------------------------------------------------
  _me(me = 0) { return this.state.video.mixEffects[me] }

  async changePreviewInput(input, me = 0) { this._me(me).previewInput = input; this._changed([`video.mixEffects.${me}.previewInput`]) }
  async changeProgramInput(input, me = 0) { this._me(me).programInput = input; this._changed([`video.mixEffects.${me}.programInput`]) }
  async cut(me = 0) {
    const m = this._me(me)
    const sel = m.transitionProperties.nextSelection
    this._applySelection(m, sel)
    this._changed([`video.mixEffects.${me}.programInput`])
  }
  _applySelection(m, sel) {
    if (sel.includes(1)) { const p = m.programInput; m.programInput = m.previewInput; m.previewInput = p }
    for (let k = 0; k < 4; k++) if (sel.includes(2 << k)) m.upstreamKeyers[k].onAir = !m.upstreamKeyers[k].onAir
  }
  async setTransitionStyle(props, me = 0) {
    const tp = this._me(me).transitionProperties
    if (props.nextSelection) tp.nextSelection = [...props.nextSelection]
    if (props.nextStyle != null) tp.nextStyle = props.nextStyle
    this._changed([`video.mixEffects.${me}.transitionProperties`])
  }
  async setMixTransitionSettings(props, me = 0) {
    this._me(me).transitionSettings.mix.rate = props.rate
    this._changed([`video.mixEffects.${me}.transitionSettings`])
  }
  async setTransitionPosition(pos, me = 0) {
    this._me(me).transitionPosition.handlePosition = pos
    this._changed([`video.mixEffects.${me}.transitionPosition`])
  }
  /** Runs over the mix rate in real time so waitForTransitionEnd behaves. */
  async autoTransition(me = 0) {
    const m = this._me(me)
    if (m.transitionPosition.inTransition) return
    const frames = Math.max(1, m.transitionSettings.mix.rate)
    const ms = (frames / this.videoFps) * 1000
    const sel = [...m.transitionProperties.nextSelection]
    m.transitionPosition.inTransition = true
    m.transitionPosition.remainingFrames = frames
    m.transitionProperties.selection = sel
    this._changed([`video.mixEffects.${me}.transitionPosition`])
    const start = Date.now()
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / ms)
      m.transitionPosition.handlePosition = Math.round(t * 10000)
      m.transitionPosition.remainingFrames = Math.round(frames * (1 - t))
      if (t < 1) {
        this._changed([`video.mixEffects.${me}.transitionPosition`])
        this._transitionTimer = setTimeout(tick, 40)
      } else {
        this._applySelection(m, sel)
        m.transitionPosition.inTransition = false
        m.transitionPosition.handlePosition = 0
        this._changed([`video.mixEffects.${me}.transitionPosition`, `video.mixEffects.${me}.programInput`])
      }
    }
    this._transitionTimer = setTimeout(tick, 40)
  }

  // ---- USKs --------------------------------------------------------------
  _key(me, k) { return this._me(me).upstreamKeyers[k] }
  async setUpstreamKeyerOnAir(onAir, me = 0, k = 0) { this._key(me, k).onAir = onAir; this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}.onAir`]) }
  async setUpstreamKeyerType(props, me = 0, k = 0) { Object.assign(this._key(me, k), props); this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}`]) }
  async setUpstreamKeyerFillSource(src, me = 0, k = 0) { this._key(me, k).fillSource = src; this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}`]) }
  async setUpstreamKeyerCutSource(src, me = 0, k = 0) { this._key(me, k).cutSource = src; this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}`]) }
  async setUpstreamKeyerPatternSettings(props, me = 0, k = 0) { Object.assign(this._key(me, k).patternSettings, props); this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}.patternSettings`]) }
  async setUpstreamKeyerMaskSettings(props, me = 0, k = 0) { Object.assign(this._key(me, k).maskSettings, props); this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}.maskSettings`]) }
  async setUpstreamKeyerLumaSettings(props, me = 0, k = 0) { Object.assign(this._key(me, k).lumaSettings, props); this._changed([`video.mixEffects.${me}.upstreamKeyers.${k}.lumaSettings`]) }

  // ---- SuperSource -------------------------------------------------------
  async setSuperSourceBoxSettings(props, box = 0, ssrc = 0) {
    Object.assign(this.state.video.superSources[ssrc].boxes[box], props)
    this._changed([`video.superSources.${ssrc}.boxes.${box}`])
  }
  async setSuperSourceProperties(props, ssrc = 0) {
    Object.assign(this.state.video.superSources[ssrc].properties, props)
    this._changed([`video.superSources.${ssrc}.properties`])
  }

  // ---- Media -------------------------------------------------------------
  async setMediaPlayerSource(props, player = 0) {
    Object.assign(this.state.media.players[player], props)
    this._changed([`media.players.${player}`])
  }
  async setMediaPlayerSettings(props, player = 0) {
    Object.assign(this.state.media.players[player], props)
    this._changed([`media.players.${player}`])
  }
}
