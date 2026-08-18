/**
 * Virtual switcher + visibility grader.
 *
 * Executes a plan (the sequencer's step list) against a model of the ATEM
 * state and records every moment the *program output* changes, classifying
 * each as:
 *   invisible - program picture identical before/after (seamless handoff)
 *   fade      - a mix transition (graceful)
 *   animate   - SuperSource boxes moving on air (graceful, intentional)
 *   cut       - a hard visible change on air (BAD unless intended)
 *
 * The output picture is modelled as a "scene": what feeds are visible where.
 * Two scenes are equal if the same sources occupy the same screen regions.
 * That is enough to prove/disprove seamlessness of every trick the engine
 * relies on (SS box fullscreen == direct feed, etc.).
 *
 * Usage:
 *   const sim = new Simulator(liveSnapshot)      // from atem snapshot or a look
 *   const report = sim.run(steps)                // { events, grade, worst }
 */
export const SS_INPUT_DEFAULT = 6000

const clone = (o) => JSON.parse(JSON.stringify(o))

/** Geometry of a box in frame units (32x18, origin centre). */
export function boxRect(b) {
  const scale = b.size / 1000
  const w = 32 * scale, h = 18 * scale
  const cx = b.x / 100, cy = b.y / 100
  let left = cx - w / 2, right = cx + w / 2, top = cy + h / 2, bottom = cy - h / 2
  if (b.cropped) {
    left += (b.cropLeft / 1000) * scale
    right -= (b.cropRight / 1000) * scale
    top -= (b.cropTop / 1000) * scale
    bottom += (b.cropBottom / 1000) * scale
  }
  // clip to frame
  return {
    left: Math.max(-16, left), right: Math.min(16, right),
    top: Math.min(9, top), bottom: Math.max(-9, bottom),
  }
}

/** Does this box, on its own, present its source identically to a direct cut? */
export function isFullFrameEquivalent(b) {
  if (!b?.enabled) return false
  const r = boxRect(b)
  const scale = b.size / 1000
  // must be at 1:1 scale (else picture is resized) and cover the frame
  // width/top. Bottom crop is allowed only if the source is otherwise
  // unchanged (we treat bottom-cropped-only as equivalent per the
  // operator's rule: "fullscreen at the top, doesn't matter about bottom").
  if (Math.abs(scale - 1) > 0.006) return false
  const cl = b.cropped ? b.cropLeft : 0, cr = b.cropped ? b.cropRight : 0, ct = b.cropped ? b.cropTop : 0
  if (cl > 50 || cr > 50 || ct > 50) return false
  return r.left <= -15.9 && r.right >= 15.9 && r.top >= 8.9
}

export class Simulator {
  /**
   * @param live  { programInput, boxes:[4], usk:[4 settings incl onAir], art:{artFillSource,artCutSource}, mediaPlayers:[...], ssInput }
   */
  constructor(live) {
    this.ssInput = live.ssInput ?? SS_INPUT_DEFAULT
    this.s = {
      program: live.programInput,
      preview: live.previewInput ?? live.programInput,
      boxes: clone(live.boxes ?? [null, null, null, null]),
      usk: clone(live.usk ?? []),
      art: clone(live.art ?? live.ssProperties ?? null),
      mediaPlayers: clone(live.mediaPlayers ?? []),
      nextSelection: ['background'],
      inTransition: false,
    }
    this.events = []
    this.t = 0 // rough elapsed ms
  }

  // ---- scene model -----------------------------------------------------
  /**
   * The visible picture: list of {src, rect} layers, background first, plus
   * key overlays. Two scenes compare equal when their layer lists match.
   */
  scene(state = this.s) {
    const layers = []
    if (state.program === this.ssInput) {
      const art = state.art
      if (art?.artFillSource != null && art.artOption !== 1) {
        layers.push({ src: art.artFillSource, rect: 'full', role: 'ss-art' })
      }
      state.boxes.forEach((b, i) => {
        if (b?.enabled && b.size > 0) layers.push({ src: b.source, rect: roundRect(boxRect(b)), role: `box${i + 1}` })
      })
      if (art?.artFillSource != null && art.artOption === 1) {
        layers.push({ src: art.artFillSource, rect: 'full', role: 'ss-art-fg' })
      }
    } else {
      layers.push({ src: state.program, rect: 'full', role: 'bg' })
    }
    // Occlusion: a fullscreen opaque box hides everything painted before it.
    // Foreground art is keyed (translucent) so it never occludes.
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i]
      const full = L.rect === 'full' || (L.rect && L.rect.l <= -15.9 && L.rect.r >= 15.9 && L.rect.t >= 8.9 && L.rect.b <= -8.9)
      if (full && L.role !== 'ss-art-fg' && L.role !== 'ss-art') { layers.splice(0, i); break }
    }
    // Normalise: a lone fullscreen box == a direct feed of that source.
    if (layers.length === 1 && layers[0].role?.startsWith('box') && layers[0].rect !== 'full') {
      const r = layers[0].rect
      if (r.l <= -15.9 && r.r >= 15.9 && r.t >= 8.9 && r.b <= -8.9) layers[0] = { src: layers[0].src, rect: 'full', role: 'bg' }
    }
    state.usk.forEach((k, i) => {
      if (k?.onAir) {
        // a key showing SS is itself a nested scene of boxes
        const fill = k.fillSource === this.ssInput
          ? state.boxes.filter((b) => b?.enabled && b.size > 0).map((b) => `${b.source}@${JSON.stringify(roundRect(boxRect(b)))}`).join('|')
          : k.fillSource
        layers.push({ src: fill, mp: mpOf(state, k), pattern: k.pattern?.style, role: `usk${i + 1}` })
      }
    })
    return JSON.stringify(layers)
  }

  // ---- step execution -------------------------------------------------
  run(steps) {
    let stepIdx = 0
    for (const step of steps) {
      const before = this.scene()
      const beforeState = clone(this.s)
      const kind = this._exec(step)
      const after = this.scene()
      if (before !== after) {
        this.events.push({
          step: stepIdx, type: step.type, kind, // kind: 'cut'|'fade'|'animate'
          before, after,
          detail: describeChange(beforeState, this.s, this.ssInput),
        })
      }
      // Program-visible MP change while something on air uses it -> cut event
      if (step.type === 'mediaPlayerSource') {
        const { fill, key } = mpInputs(step.player)
        const usedLive = this.s.usk.some((k) => k?.onAir && (k.fillSource === fill || k.cutSource === key)) ||
          (this.s.program === this.ssInput && (this.s.art?.artFillSource === fill || this.s.art?.artCutSource === key ||
            this.s.boxes.some((b) => b?.enabled && b.size > 0 && (b.source === fill || b.source === key))))
        if (usedLive) {
          this.events.push({ step: stepIdx, type: step.type, kind: 'cut', detail: `MP${step.player + 1} changed while ON AIR` })
        }
      }
      stepIdx++
    }
    return this.report()
  }

  _exec(step) {
    const s = this.s
    switch (step.type) {
      case 'preview': s.preview = step.input; return 'none'
      case 'program': s.program = step.input; return 'cut'
      case 'cut': {
        const p = s.program; s.program = s.preview; s.preview = p; return 'cut'
      }
      case 'setNextTransition': s.nextSelection = step.selection; return 'none'
      case 'auto': {
        // mix over selection: background swap + toggle selected keys
        const sel = s.nextSelection ?? ['background']
        if (sel.includes('background')) { const p = s.program; s.program = s.preview; s.preview = p }
        for (const k of sel) {
          const m = /^key(\d)$/.exec(k)
          if (m && s.usk[+m[1] - 1]) s.usk[+m[1] - 1].onAir = !s.usk[+m[1] - 1].onAir
        }
        this.t += 500
        return 'fade'
      }
      case 'uskOnAir': if (s.usk[step.keyer]) s.usk[step.keyer].onAir = step.onAir; return 'cut'
      case 'uskSettings': {
        const k = s.usk[step.keyer]; if (!k) return 'none'
        const w = step.settings
        if (w.keyType) k.keyType = w.keyType
        if (w.fillSource != null) k.fillSource = w.fillSource
        if (w.cutSource != null) k.cutSource = w.cutSource
        if (w.pattern) k.pattern = { ...(k.pattern ?? {}), ...w.pattern }
        if (w.mask) k.mask = { ...(k.mask ?? {}), ...w.mask }
        return k.onAir ? 'cut' : 'none'
      }
      case 'animateUskPattern': {
        const k = s.usk[step.keyer]; if (k) k.pattern = { ...(k.pattern ?? {}), ...step.pattern }
        this.t += step.duration ?? 500
        return 'animate'
      }
      case 'setBoxes': {
        for (const [i, props] of Object.entries(step.boxes)) {
          s.boxes[+i] = { ...(s.boxes[+i] ?? {}), ...props }
        }
        return 'cut'
      }
      case 'animateBoxes': {
        // A source change on a box that is visible on air is a hard cut
        // even though the geometry animates - flag it.
        let sourceCut = false
        const onAirSs = s.program === this.ssInput
        ;(step.targets ?? []).forEach((t, i) => {
          if (!t) return
          const before = s.boxes[i]
          if (onAirSs && before?.enabled && before.size > 0 && t.source != null && t.source !== before.source && !this._occluded(i)) sourceCut = true
          s.boxes[i] = { ...(s.boxes[i] ?? {}), ...t }
          if (t.size === 0) s.boxes[i].enabled = false
        })
        this.t += step.duration ?? 500
        return sourceCut ? 'cut' : 'animate'
      }
      case 'setSsProperties': s.art = { ...(s.art ?? {}), ...step.props }; return 'cut'
      case 'mediaPlayerSource': {
        const mp = s.mediaPlayers[step.player] ?? { index: step.player }
        s.mediaPlayers[step.player] = { ...mp, ...step.source }
        return 'cut'
      }
      case 'setMixRate': case 'setCurrentLook': case 'hyperdeckEnsure': case 'hyperdeck': case 'wait': case 'waitForTransition':
        return 'none'
      default:
        return 'none'
    }
  }

  /** Is box i fully hidden behind a later fullscreen box? */
  _occluded(i) {
    for (let j = i + 1; j < 4; j++) {
      const b = this.s.boxes[j]
      if (b?.enabled && isFullFrameEquivalent(b) && !(b.cropped && b.cropBottom > 50)) return true
    }
    return false
  }

  // ---- report ---------------------------------------------------------
  report() {
    // A 'cut' event where the scene actually differs is a visible cut.
    // Cuts where before===after never became events (invisible by construction).
    const visibleCuts = this.events.filter((e) => e.kind === 'cut')
    const fades = this.events.filter((e) => e.kind === 'fade')
    const anims = this.events.filter((e) => e.kind === 'animate')
    const grade = visibleCuts.length === 0 ? 'clean' : 'has-cuts'
    return {
      grade,
      counts: { visibleCuts: visibleCuts.length, fades: fades.length, animations: anims.length, steps: this.events.length },
      visibleCuts,
      events: this.events,
      approxDurationMs: this.t,
      final: clone(this.s),
    }
  }
}

function roundRect(r) {
  return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) }
}
function mpInputs(i) { return { fill: 3010 + i * 10, key: 3011 + i * 10 } }
function mpOf(state, k) {
  for (let i = 0; i < 4; i++) {
    const { fill, key } = mpInputs(i)
    if (k.fillSource === fill || k.cutSource === key) {
      const mp = state.mediaPlayers?.[i]
      return mp ? `${mp.sourceType ?? 'still'}:${mp.stillIndex ?? mp.clipIndex}` : `mp${i + 1}`
    }
  }
  return null
}
function describeChange(a, b, ss) {
  const bits = []
  if (a.program !== b.program) bits.push(`program ${a.program}→${b.program}`)
  for (let i = 0; i < 4; i++) {
    const x = a.boxes[i], y = b.boxes[i]
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      if (x?.source !== y?.source) bits.push(`box${i + 1} src ${x?.source}→${y?.source}`)
      else if (!!x?.enabled !== !!y?.enabled) bits.push(`box${i + 1} ${y?.enabled ? 'on' : 'off'}`)
      else bits.push(`box${i + 1} geom`)
    }
  }
  a.usk.forEach((k, i) => {
    const m = b.usk[i]
    if (k?.onAir !== m?.onAir) bits.push(`USK${i + 1} ${m?.onAir ? 'on' : 'off'}`)
  })
  return bits.join(', ') || (a.program === ss ? 'ss art' : 'n/a')
}
