import { config } from './config.js'

const TWEENABLE = ['x', 'y', 'size', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight']

/**
 * The transition planner: given the LIVE switcher state and a target look,
 * work out the choreography to get there. Rules distilled from how the
 * projection setup is operated:
 *
 * - USK changes fade via mix transitions (keys-only selection), never cut.
 * - Keys come OFF before boxes move; keys go ON after boxes have settled.
 * - USKs fed by SuperSource (the USK3 blend) are special: they must be
 *   faded out before the SS layout changes, and faded in only after the SS
 *   layout is in place.
 * - Changing the M/E background (SS <-> direct feed) goes via preview +
 *   auto transition. When leaving SS, the box carrying the incoming feed
 *   animates to true fullscreen first so the mix is seamless; other boxes
 *   shrink out. When entering SS, the layout is prepared offline first.
 * - Boxes that turn on grow from nothing at their target spot; boxes that
 *   turn off shrink in place, then are disabled and their recorded
 *   geometry restored.
 * - The HyperDeck is only touched if the target's transport differs from
 *   what is live right now (never restart a clip that is already playing).
 *
 * plan() returns { steps, notes } - steps run on the existing sequencer.
 */
export class TransitionEngine {
  constructor(atemController, hyperdeck) {
    this.atem = atemController
    this.hyperdeck = hyperdeck
    this.ssInput = config.supersource.ssInput ?? 6000
    // Zero-indexed box that carries the "main display" feed, used when no
    // live box already carries the incoming program source.
    this.displayBox = config.supersource.displayBox ?? 3
  }

  plan(target, opts = {}) {
    const steps = []
    const notes = []
    const duration = opts.duration
    const mix = this.atem.getMixEffect()
    if (!mix) throw new Error('No ATEM state - not connected?')
    if (!target.me) throw new Error(`Look '${target.name}' has no M/E data - recapture it`)

    const pgm = mix.programInput
    const targetPgm = target.me.programInput
    const ssNow = pgm === this.ssInput
    const ssTarget = targetPgm === this.ssInput
    const liveKeys = this.atem.getUskSettings()
    const liveBoxes = this.atem.getBoxes().map((b) => (b ? { ...b } : null))

    // Mix rates: border-key fades run at their own fast rate (keyFadeMs);
    // background mixes and SS-fed blend fades use the normal rate, or the
    // explicit per-goto duration. Rate changes are emitted lazily and the
    // resting rate is restored at the end of the plan.
    const videoFps = config.transition?.videoFps ?? 50
    const toFrames = (ms) => Math.max(2, Math.round((ms / 1000) * videoFps))
    const prevRate = this.atem.getMixRate?.()
    const keyRate = toFrames(config.transition?.keyFadeMs ?? 150)
    const bgRate = duration
      ? toFrames(duration)
      : config.transition?.mixRateFrames ?? prevRate
    let plannedRate = prevRate
    const ensureRate = (frames) => {
      if (!frames || plannedRate === frames) return []
      plannedRate = frames
      return [{ type: 'setMixRate', frames }]
    }

    // ---- HyperDeck (idempotent) -----------------------------------------
    if (target.hyperdeck?.status === 'play' || target.hyperdeck?.status === 'stop') {
      steps.push({
        type: 'hyperdeckEnsure',
        status: target.hyperdeck.status,
        clipId: target.hyperdeck.clipId,
        loop: target.hyperdeck.loop,
        singleClip: target.hyperdeck.singleClip,
      })
    }

    // ---- USK diff -------------------------------------------------------
    const wantOn = target.me.uskOnAir ?? []
    const remove = []
    const add = []
    liveKeys.forEach((k, i) => {
      if (!k) return
      const want = !!wantOn[i]
      if (k.onAir && !want) remove.push(i)
      if (!k.onAir && want) add.push(i)
    })
    const isSsFed = (i) =>
      liveKeys[i]?.fillSource === this.ssInput || target.me.usk?.[i]?.fillSource === this.ssInput
    const removeSs = remove.filter(isSsFed)
    const removeNorm = remove.filter((i) => !isSsFed(i))
    const addSs = add.filter(isSsFed)
    const addNorm = add.filter((i) => !isSsFed(i))
    const sel = (idxs) => idxs.map((i) => `key${i + 1}`)
    // Pure border-key fades run fast; any fade involving an SS-fed key
    // (the blend) keeps the normal/background rate.
    const keysFade = (idxs) => {
      if (!idxs.length) return []
      const rate = idxs.every((i) => !isSsFed(i)) ? keyRate : bgRate
      return [
        ...ensureRate(rate),
        { type: 'setNextTransition', selection: sel(idxs), style: 'mix' },
        { type: 'auto' },
      ]
    }

    // Keys that stay on but are fed by SS while the layout changes must be
    // recycled (faded out and back in around the layout change).
    const boxesChange = this._boxesDiffer(liveBoxes, target.boxes)
    const recycle = liveKeys
      .map((k, i) => (k?.onAir && wantOn[i] && isSsFed(i) && boxesChange && !ssTarget ? i : null))
      .filter((i) => i !== null)

    // Keys on in BOTH looks whose settings differ: same pattern style ->
    // slide the params live (morph); different style/type/source -> must
    // be recycled (fade off, reconfigure, fade on) since a style change
    // would pop on air.
    const morph = []
    liveKeys.forEach((k, i) => {
      if (!k?.onAir || !wantOn[i] || recycle.includes(i)) return
      const change = this._uskChange(k, target.me.usk?.[i])
      if (change === 'morph') morph.push(i)
      else if (change === 'recycle') recycle.push(i)
    })
    // Keys coming on fresh get their settings applied while still off air.
    const configureOffline = add.filter((i) => this._uskChange(liveKeys[i], target.me.usk?.[i]))
    const uskConfig = (idxs) =>
      idxs.map((i) => ({ type: 'uskSettings', keyer: i, settings: target.me.usk[i] }))
    const uskMorph = (idxs) =>
      idxs.map((i) => ({
        type: 'animateUskPattern', keyer: i,
        pattern: target.me.usk[i].pattern, duration,
      }))
    const recycleFadeOut = (idxs) => keysFade(idxs)
    const recycleFadeIn = (idxs) => [...uskConfig(idxs), ...keysFade(idxs)]


    // ---- Branch on background change ------------------------------------
    if (ssNow && ssTarget) {
      // Blend-key swap (e.g. USK3 off + USK4 on) with no layout change:
      // configure the incoming key offline, then crossfade both in ONE
      // transition so the overlay never fully disappears.
      const swap = !boxesChange && removeSs.length && addSs.length && !recycle.length
      if (swap) {
        steps.push(...uskConfig(configureOffline))
        steps.push(...keysFade([...remove, ...add]))
        steps.push(...uskMorph(morph))
      } else {
        steps.push(...keysFade([...remove, ...recycle]))
        if (boxesChange) steps.push(...this._animatePhase(liveBoxes, target.boxes, duration))
        steps.push(...uskMorph(morph))
        steps.push(...uskConfig(configureOffline))
        steps.push(...keysFade([...add]))
        steps.push(...recycleFadeIn(recycle))
      }
      if (!boxesChange && !remove.length && !add.length && !morph.length && !recycle.length) {
        notes.push('nothing to change on M/E')
      }
    } else if (ssNow && !ssTarget) {
      // Leaving SuperSource for a direct feed.
      steps.push(...keysFade([...remove, ...recycle]))
      const handoff = this._handoffFrame(liveBoxes, targetPgm)
      if (handoff.retargeted) notes.push(`box ${this.displayBox + 1} source cut to carry incoming feed`)
      if (handoff.frame) steps.push(...this._animatePhase(liveBoxes, handoff.frame, duration))
      steps.push(...uskConfig(configureOffline.filter((i) => addNorm.includes(i))))
      steps.push({ type: 'preview', input: targetPgm })
      steps.push(...ensureRate(bgRate))
      steps.push({ type: 'setNextTransition', selection: ['background', ...sel(addNorm)], style: 'mix' })
      steps.push({ type: 'auto' })
      // SS is now offline: snap it to the target layout for the blend/next use.
      steps.push({ type: 'setBoxes', boxes: this._fullFrame(target.boxes) })
      steps.push(...this._artSteps(target))
      steps.push(...uskMorph(morph))
      steps.push(...uskConfig(configureOffline.filter((i) => addSs.includes(i))))
      steps.push(...keysFade([...addSs]))
      steps.push(...recycleFadeIn(recycle))
    } else if (!ssNow && ssTarget) {
      // Entering SuperSource from a direct feed. If the target layout has a
      // box carrying the current program source, mirror the leaving-SS
      // handoff: prep that box true-fullscreen so the background mix is
      // seamless (the feed fades into an identical picture), THEN animate
      // the box to its recorded spot, then fade keys in. Without a carrier
      // box the mix is a genuine content change, so just prep and fade.
      const entry = this._entryFrame(pgm, target.boxes)
      steps.push(...keysFade([...removeSs, ...recycle]))
      steps.push({
        type: 'setBoxes',
        boxes: this._fullFrame(entry ?? target.boxes),
      })
      steps.push(...this._artSteps(target))
      steps.push(...keysFade([...removeNorm]))
      steps.push({ type: 'preview', input: this.ssInput })
      steps.push(...uskConfig(configureOffline))
      if (entry) {
        steps.push(...ensureRate(bgRate))
        steps.push({ type: 'setNextTransition', selection: ['background'], style: 'mix' })
        steps.push({ type: 'auto' })
        steps.push(...this._animatePhase(entry, target.boxes, duration))
        steps.push(...uskMorph(morph))
        steps.push(...keysFade([...addNorm, ...addSs]))
        steps.push(...recycleFadeIn(recycle))
      } else {
        notes.push('no target box carries the outgoing feed - straight crossfade into the layout')
        steps.push(...ensureRate(bgRate))
        steps.push({ type: 'setNextTransition', selection: ['background', ...sel(addNorm)], style: 'mix' })
        steps.push({ type: 'auto' })
        steps.push(...uskMorph(morph))
        steps.push(...keysFade([...addSs]))
        steps.push(...recycleFadeIn(recycle))
      }
    } else {
      // Direct feed to direct feed.
      const swap = pgm === targetPgm && !boxesChange && removeSs.length && addSs.length && !recycle.length
      if (swap) {
        // Blend-key swap: crossfade out/in keys together in one transition.
        steps.push(...uskConfig(configureOffline.filter((i) => addSs.includes(i))))
        steps.push(...keysFade([...removeNorm]))
        steps.push(...keysFade([...removeSs, ...addSs]))
        addSs.length = 0
      } else {
        steps.push(...keysFade([...remove, ...recycle]))
      }
      steps.push(...uskConfig(configureOffline.filter((i) => addNorm.includes(i))))
      if (pgm !== targetPgm) {
        steps.push({ type: 'preview', input: targetPgm })
        steps.push(...ensureRate(bgRate))
        steps.push({ type: 'setNextTransition', selection: ['background', ...sel(addNorm)], style: 'mix' })
        steps.push({ type: 'auto' })
      } else {
        steps.push(...keysFade([...addNorm]))
      }
      if (boxesChange) {
        steps.push({ type: 'setBoxes', boxes: this._fullFrame(target.boxes) })
        steps.push(...this._artSteps(target))
      }
      steps.push(...uskMorph(morph))
      steps.push(...uskConfig(configureOffline.filter((i) => addSs.includes(i))))
      steps.push(...keysFade([...addSs]))
      steps.push(...recycleFadeIn(recycle))
    }

    // Leave the switcher at its resting rate (config pin or whatever it
    // was before this plan touched it).
    steps.push(...ensureRate(config.transition?.mixRateFrames ?? prevRate))

    // Restore the recorded "next transition" so manual ops behave normally.
    if (target.me.nextTransition) {
      steps.push({
        type: 'setNextTransition',
        selection: target.me.nextTransition.selection,
        style: target.me.nextTransition.style,
      })
    }
    steps.push({ type: 'setCurrentLook', look: target.name })
    return { steps: steps.filter(Boolean), notes }
  }

  // ---- helpers ----------------------------------------------------------

  /**
   * Steps for a visible SuperSource move: boxes turning on grow from size 0
   * at their target position; boxes turning off shrink in place then get
   * disabled with their recorded geometry restored.
   */
  _animatePhase(liveBoxes, targetBoxes, duration) {
    const prep = {}
    const anim = [null, null, null, null]
    const cleanup = {}
    for (let i = 0; i < 4; i++) {
      const f = liveBoxes[i]
      const t = targetBoxes?.[i]
      if (!f || !t) continue
      if (t.enabled && !f.enabled) {
        // Grow in: place it (still disabled), then enable + tween size up.
        prep[i] = {
          source: t.source, x: t.x, y: t.y, size: 0,
          cropped: !!t.cropped, cropTop: t.cropTop, cropBottom: t.cropBottom,
          cropLeft: t.cropLeft, cropRight: t.cropRight,
        }
        anim[i] = { ...pickTween(t), enabled: true }
      } else if (!t.enabled && f.enabled) {
        // Shrink out, then disable and restore recorded geometry.
        anim[i] = { size: 0 }
        cleanup[i] = { enabled: false, ...pickTween(t), cropped: !!t.cropped }
      } else if (t.enabled) {
        anim[i] = { ...pickTween(t), source: t.source, cropped: !!t.cropped }
      }
    }
    const steps = []
    if (Object.keys(prep).length) steps.push({ type: 'setBoxes', boxes: prep })
    if (anim.some(Boolean)) steps.push({ type: 'animateBoxes', targets: anim, duration })
    if (Object.keys(cleanup).length) steps.push({ type: 'setBoxes', boxes: cleanup })
    return steps
  }

  /**
   * Frame used when leaving SS: the box carrying the incoming program
   * source goes true fullscreen; every other enabled box shrinks out.
   * If no live box carries that source, the configured display box is
   * retargeted to it (a visible source cut inside that box).
   */
  _handoffFrame(liveBoxes, targetPgm) {
    let carrier = liveBoxes.findIndex((b) => b?.enabled && b.source === targetPgm)
    let retargeted = false
    if (carrier === -1) {
      carrier = this.displayBox
      retargeted = true
      if (!liveBoxes[carrier]) return { frame: null, retargeted: false }
    }
    const frame = [null, null, null, null]
    for (let i = 0; i < 4; i++) {
      const b = liveBoxes[i]
      if (!b) continue
      if (i === carrier) {
        frame[i] = {
          enabled: true, source: targetPgm,
          x: 0, y: 0, size: 1000,
          cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
        }
      } else if (b.enabled) {
        frame[i] = { enabled: false, size: 0, x: b.x, y: b.y }
      }
    }
    return { frame, retargeted }
  }

  /**
   * The state SS should be in when it fades onto program from a direct
   * feed: the target box carrying that feed sits true-fullscreen (so the
   * mix is invisible); every other box is parked disabled at its target
   * geometry, ready to grow in. Returns null if no enabled target box
   * carries the outgoing program source.
   */
  _entryFrame(pgm, targetBoxes) {
    const carrier = (targetBoxes ?? []).findIndex((b) => b?.enabled && b.source === pgm)
    if (carrier === -1) return null
    const frame = [null, null, null, null]
    for (let i = 0; i < 4; i++) {
      const t = targetBoxes[i]
      if (!t) continue
      if (i === carrier) {
        frame[i] = {
          enabled: true, source: pgm,
          x: 0, y: 0, size: 1000,
          cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
        }
      } else {
        frame[i] = {
          enabled: false, source: t.source, x: t.x, y: t.y, size: 0,
          cropped: !!t.cropped, cropTop: t.cropTop, cropBottom: t.cropBottom,
          cropLeft: t.cropLeft, cropRight: t.cropRight,
        }
      }
    }
    return frame
  }

  /** Full offline snap frame from a look's recorded boxes. */
  _fullFrame(targetBoxes) {
    const frame = {}
    ;(targetBoxes ?? []).forEach((b, i) => {
      if (!b) return
      frame[i] = {
        enabled: b.enabled, source: b.source, x: b.x, y: b.y, size: b.size,
        cropped: b.cropped, cropTop: b.cropTop, cropBottom: b.cropBottom,
        cropLeft: b.cropLeft, cropRight: b.cropRight,
      }
    })
    return frame
  }

  _artSteps(target) {
    const want = target.ssProperties
    if (!want) return []
    const live = this.atem.getSsProperties()
    if (
      live &&
      live.artFillSource === want.artFillSource &&
      live.artCutSource === want.artCutSource &&
      live.artOption === want.artOption
    ) {
      return []
    }
    return [{
      type: 'setSsProperties',
      props: {
        artFillSource: want.artFillSource,
        artCutSource: want.artCutSource,
        artOption: want.artOption,
        artPreMultiplied: want.artPreMultiplied,
        artClip: want.artClip,
        artGain: want.artGain,
        artInvertKey: want.artInvertKey,
      },
    }]
  }

  /**
   * Classify how a keyer's settings differ between live and target:
   *   null      - nothing meaningful differs
   *   'morph'   - same type/sources/pattern style; only numeric pattern
   *               params differ -> can be tweened on air
   *   'recycle' - type, fill/cut source or pattern style differ -> must go
   *               off air to change
   */
  _uskChange(live, want, tol = 5) {
    if (!live || !want) return null
    if (want.keyType && want.keyType !== live.keyType) return 'recycle'
    if (want.fillSource !== undefined && want.fillSource !== live.fillSource) return 'recycle'
    if (want.cutSource !== undefined && want.cutSource !== live.cutSource) return 'recycle'
    if (want.keyType === 'pattern' && want.pattern) {
      const lp = live.pattern ?? {}
      if (want.pattern.style !== lp.style) return 'recycle'
      if (!!want.pattern.invert !== !!lp.invert) return 'recycle'
      for (const f of ['size', 'softness', 'symmetry', 'positionX', 'positionY']) {
        if (Math.abs((want.pattern[f] ?? 0) - (lp[f] ?? 0)) > tol) return 'morph'
      }
    }
    if (want.mask) {
      const lm = live.mask ?? {}
      if (!!want.mask.maskEnabled !== !!lm.maskEnabled) return 'recycle'
      if (want.mask.maskEnabled) {
        for (const f of ['maskTop', 'maskBottom', 'maskLeft', 'maskRight']) {
          if (Math.abs((want.mask[f] ?? 0) - (lm[f] ?? 0)) > tol) return 'recycle'
        }
      }
    }
    return null
  }

  _boxesDiffer(liveBoxes, targetBoxes, tol = 10) {
    for (let i = 0; i < 4; i++) {
      const f = liveBoxes[i]
      const t = targetBoxes?.[i]
      if (!t || !f) continue
      if (!!f.enabled !== !!t.enabled) return true
      if (!t.enabled) continue
      if (f.source !== t.source) return true
      for (const k of TWEENABLE) {
        if (Math.abs((f[k] ?? 0) - (t[k] ?? 0)) > tol) return true
      }
      if (!!f.cropped !== !!t.cropped) return true
    }
    return false
  }
}

function pickTween(b) {
  const out = {}
  for (const k of TWEENABLE) {
    if (typeof b[k] === 'number') out[k] = b[k]
  }
  return out
}
