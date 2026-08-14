import { EventEmitter } from 'node:events'
import { config } from './config.js'

// Numeric SuperSource box fields that get tweened. Everything else
// (enabled, source, cropped) is switched at the start or end of the move.
const TWEEN_FIELDS = ['x', 'y', 'size', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight']

export const EASINGS = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => --t * t * t + 1,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
}

/**
 * MixEffect-style SuperSource animation: tween box position/size/crop from
 * the live state to a target set of box states, sending updates at a fixed
 * tick rate.
 *
 * Emits: 'start', 'progress' (0..1), 'done', 'cancelled'
 */
export class Animator extends EventEmitter {
  constructor(atemController) {
    super()
    this.atem = atemController
    this.running = false
    this._cancel = null
  }

  /**
   * Animate the live SuperSource to `targetBoxes` (array of up to 4 box
   * objects, or null/undefined to leave a box alone).
   * Resolves when the animation has finished.
   */
  async animateTo(targetBoxes, { durationMs, easing } = {}) {
    const duration = durationMs ?? config.animation.defaultDurationMs
    const ease = EASINGS[easing ?? config.animation.defaultEasing] ?? EASINGS.easeInOutQuad
    const tickMs = Math.max(20, Math.round(1000 / (config.animation.fps ?? 25)))

    // Cancel any in-flight animation - the new one takes over from wherever
    // the boxes currently are, which is exactly what you want when mashing
    // buttons mid-move.
    this.cancel()

    const startBoxes = this.atem.getBoxes().map((b) => (b ? { ...b } : null))
    const moves = []
    for (let i = 0; i < 4; i++) {
      const target = targetBoxes?.[i]
      const from = startBoxes[i]
      if (!target || !from) continue
      moves.push({ boxId: i, from, to: target })
    }
    if (moves.length === 0) return

    // Boxes that are being switched ON get snapped to their start values and
    // enabled immediately; boxes being switched OFF are disabled at the end.
    const disableAtEnd = []
    for (const m of moves) {
      const startProps = {}
      if (m.to.enabled && !m.from.enabled) {
        startProps.enabled = true
      }
      if (m.to.source !== undefined && m.to.source !== m.from.source) {
        startProps.source = m.to.source
      }
      if (m.to.cropped !== undefined && m.to.cropped !== m.from.cropped) {
        // Enabling crop snaps on at the start; the crop values then tween.
        if (m.to.cropped) startProps.cropped = true
        else disableAtEnd.push({ boxId: m.boxId, props: { cropped: false } })
      }
      if (m.from.enabled && m.to.enabled === false) {
        disableAtEnd.push({ boxId: m.boxId, props: { enabled: false } })
      }
      if (Object.keys(startProps).length) {
        await this.atem.setBox(m.boxId, startProps)
      }
    }

    this.running = true
    this.emit('start')

    let cancelled = false
    this._cancel = () => {
      cancelled = true
    }

    const startTime = Date.now()
    let inflight = 0
    try {
      while (!cancelled) {
        const t = Math.min(1, (Date.now() - startTime) / duration)
        const k = ease(t)
        const frame = {}
        for (const m of moves) {
          const props = {}
          for (const f of TWEEN_FIELDS) {
            const a = m.from[f]
            const b = m.to[f]
            if (typeof a === 'number' && typeof b === 'number' && a !== b) {
              props[f] = Math.round(a + (b - a) * k)
            }
          }
          if (Object.keys(props).length) frame[m.boxId] = props
        }
        // Fire-and-forget so network round-trips never throttle the tick
        // rate; drop frames rather than queue them if acks fall behind.
        if (Object.keys(frame).length && inflight < 2) {
          inflight++
          this.atem
            .setBoxes(frame)
            .catch((e) => console.error('[animator] send failed:', e.message))
            .finally(() => inflight--)
        }
        this.emit('progress', t)
        if (t >= 1) break
        await sleep(tickMs)
      }

      if (!cancelled) {
        // Land exactly on the target values and apply end-of-move switches.
        const finalFrame = {}
        for (const m of moves) {
          const props = {}
          for (const f of TWEEN_FIELDS) {
            if (typeof m.to[f] === 'number') props[f] = m.to[f]
          }
          finalFrame[m.boxId] = props
        }
        await this.atem.setBoxes(finalFrame)
        for (const d of disableAtEnd) {
          await this.atem.setBox(d.boxId, d.props)
        }
        this.emit('done')
      } else {
        this.emit('cancelled')
      }
    } finally {
      this.running = false
      this._cancel = null
    }
  }

  cancel() {
    if (this._cancel) this._cancel()
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
