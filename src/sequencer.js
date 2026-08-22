import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { macrosDir } from './config.js'

/**
 * Runs transition macros: ordered step lists that choreograph M/E
 * transitions, USKs, SuperSource animations and HyperDeck control.
 *
 * A macro can declare `from` and `to` look names. `goto(target)` picks the
 * best macro for (currentLook -> target):
 *   1. exact from + to match
 *   2. from: "*" + to match
 *   3. no macro: plain animate to the target look
 *
 * Emits: 'busy' (macro name), 'idle', 'step' ({index, total, step}), 'error'
 */
export class Sequencer extends EventEmitter {
  constructor(atemController, animator, lookStore, hyperdeck, engine, propresenter = null) {
    super()
    this.atem = atemController
    this.animator = animator
    this.looks = lookStore
    this.hyperdeck = hyperdeck
    this.engine = engine
    this.propresenter = propresenter
    this.macros = new Map()
    this.current = null // { name, stepIndex, totalSteps }
    this._stopRequested = false
    if (!existsSync(macrosDir)) mkdirSync(macrosDir, { recursive: true })
    this.loadAll()
  }

  loadAll() {
    this.macros.clear()
    for (const f of readdirSync(macrosDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const macro = JSON.parse(readFileSync(path.join(macrosDir, f), 'utf8'))
        this.macros.set(macro.name, macro)
      } catch (e) {
        console.error(`[sequencer] failed to load ${f}:`, e.message)
      }
    }
    console.log(`[sequencer] loaded ${this.macros.size} macro(s)`)
  }

  list() {
    return [...this.macros.values()]
  }

  get busy() {
    return this.current !== null
  }

  /** Request the running macro stops after its current step. */
  stop() {
    this._stopRequested = true
    this.animator.cancel()
  }

  /**
   * Transition to `target`. Rejects if a sequence is already running -
   * live operation wants a predictable "one thing at a time", with the
   * busy state surfaced loudly (UI buttons disable, Companion
   * `transitioning` variable) instead of queueing surprises.
   */
  async goto(target, opts = {}) {
    if (this.busy) {
      throw new Error(`Busy running '${this.current.name}' - wait or send /stop first`)
    }
    const from = this.looks.currentLook
    if (from === target && !opts.force) {
      console.log(`[sequencer] already at '${target}', ignoring`)
      return
    }
    const macro =
      [...this.macros.values()].find((m) => m.from === from && m.to === target) ??
      [...this.macros.values()].find((m) => (m.from === '*' || m.from == null) && m.to === target)

    if (macro) {
      await this.run(macro.name)
    } else {
      // No hand-written macro: let the engine plan from the live state.
      const look = this.looks.mustGet(target)
      const { steps, notes } = this.engine.plan(look, { duration: opts.duration })
      for (const n of notes) console.log(`[engine] note: ${n}`)
      console.log(`[engine] ${from ?? '(live state)'} -> ${target}:`,
        steps.map((s) => s.type).join(', '))
      await this._runSteps(`goto:${target}`, steps, { from, to: target })
    }
  }

  async run(name) {
    const macro = this.macros.get(name)
    if (!macro) throw new Error(`Unknown macro '${name}'`)
    const steps = [...macro.steps]
    // If the macro declares a destination look, mark it current at the end
    // unless the steps already do so explicitly.
    if (macro.to && !steps.some((s) => s.type === 'setCurrentLook')) {
      steps.push({ type: 'setCurrentLook', look: macro.to })
    }
    await this._runSteps(name, steps, { from: macro.from ?? this.looks.currentLook, to: macro.to })
  }

  async _runSteps(name, steps, meta = {}) {
    if (this.busy) throw new Error(`Sequencer busy running '${this.current.name}'`)
    this.current = {
      name, stepIndex: 0, totalSteps: steps.length,
      from: meta.from ?? null, to: meta.to ?? null,
    }
    this._stopRequested = false
    this.emit('busy', this.current)
    console.log(`[sequencer] running '${name}' (${steps.length} steps)`)
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this._stopRequested) {
          console.log(`[sequencer] '${name}' stopped at step ${i + 1}`)
          break
        }
        this.current.stepIndex = i
        this.emit('step', { index: i, total: steps.length, step: steps[i] })
        await this._execStep(steps[i])
      }
    } catch (e) {
      console.error(`[sequencer] '${name}' failed:`, e.message)
      this.emit('error', { macro: name, error: e.message })
      throw e
    } finally {
      this.current = null
      this.emit('idle')
    }
  }

  async _execStep(step) {
    const me = step.me // undefined -> AtemController default M/E
    switch (step.type) {
      case 'setNextTransition':
        await this.atem.setNextTransition(step.selection, step.style, me)
        break

      case 'auto':
        if (step.wait === false) await this.atem.atem.autoTransition(me ?? this.atem.me)
        else await this.atem.autoTransition(me)
        break

      case 'cut':
        await this.atem.cut(me)
        break

      case 'preview':
        await this.atem.setPreview(step.input, me)
        break

      case 'program':
        await this.atem.setProgram(step.input, me)
        break

      case 'uskOnAir':
        await this.atem.setUskOnAir(step.keyer, step.onAir, me)
        break

      case 'animate': {
        const look = this.looks.mustGet(step.look)
        await this.animator.animateTo(look.boxes, {
          durationMs: step.duration,
          easing: step.easing,
        })
        break
      }

      case 'applyLook':
        await this.looks.apply(step.look)
        break

      case 'setCurrentLook':
        this.looks.setCurrent(step.look)
        break
      case 'propresenter':
        if (step.look) await this.propresenter?.triggerLook(step.look.uuid || step.look.name)
        if (step.media?.item?.uuid) await this.propresenter?.triggerMedia(step.media.playlist?.uuid, step.media.item.uuid)
        if (step.macro) await this.propresenter?.triggerMacro(step.macro.uuid || step.macro.name)
        break

      case 'wait':
        await new Promise((r) => setTimeout(r, step.ms ?? 500))
        break

      case 'waitForTransition':
        await this.atem.waitForTransitionEnd(me)
        break

      case 'hyperdeck':
        await this.hyperdeck.command(step)
        break

      case 'setBoxes':
        await this.atem.setBoxes(step.boxes)
        break

      case 'animateBoxes':
        await this.animator.animateTo(step.targets, {
          durationMs: step.duration,
          easing: step.easing,
        })
        break

      case 'uskSettings':
        await this.atem.applyUskSettings(step.keyer, step.settings, me)
        break

      case 'animateUskPattern':
        await this.animator.animateUskPattern(step.keyer, step.pattern, {
          durationMs: step.duration,
          easing: step.easing,
        })
        break

      case 'mediaPlayerSource':
        await this.atem.setMediaPlayerSource(step.player, step.source)
        break

      case 'setMixRate':
        await this.atem.setMixRate(step.frames, me)
        break

      case 'setSsProperties':
        await this.atem.atem.setSuperSourceProperties(step.props, this.atem.ssrcId)
        break

      case 'hyperdeckEnsure': {
        // Only touch the deck if it isn't already doing what we want.
        if (!this.hyperdeck.connected) {
          console.log('[sequencer] hyperdeckEnsure: deck not connected, skipping')
          break
        }
        const t = this.hyperdeck.transport
        const playing = t.status === 'play'
        const clipNow = t['clip id'] != null ? Number(t['clip id']) : null
        const loopNow = t.loop === 'true'
        if (step.status === 'play') {
          const rightClip = step.clipId == null || clipNow === step.clipId
          if (playing && rightClip && loopNow === !!step.loop) break // already good
          if (!rightClip && step.clipId != null) {
            await this.hyperdeck.command({ command: 'gotoClip', clip: step.clipId })
          }
          await this.hyperdeck.command({
            command: 'play', loop: step.loop, singleClip: step.singleClip,
          })
        } else if (step.status === 'stop' && playing) {
          await this.hyperdeck.command({ command: 'stop' })
        }
        break
      }

      default:
        throw new Error(`Unknown step type '${step.type}'`)
    }
  }
}
