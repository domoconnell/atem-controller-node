'use client'
import { useEffect, useRef, useState } from 'react'
import type { Box } from '@/lib/types'
import type { Scene } from '@/components/atem/ss-monitor'

const SS = 6000
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface PreviewAnim { scene: Scene; mixTo: { scene: Scene; t: number } | null }

/** Signature of the visible SuperSource layout, to tell whether two looks
 *  differ in their box arrangement. */
function boxSig(boxes: (Box | null)[]): string {
  return (boxes ?? []).map((b) => (b && b.enabled && b.size > 0 ? `${b.source},${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.size)}` : '-')).join('|')
}

/** Interpolate the SuperSource layout from `from` to `to` at 0..1 — boxes in
 *  both move/resize, appearing boxes pop in, leaving boxes pop out. */
function animBoxes(from: (Box | null)[], to: (Box | null)[], t: number): (Box | null)[] {
  const n = Math.max(from.length, to.length)
  const out: (Box | null)[] = []
  for (let i = 0; i < n; i++) {
    const a = from[i], b = to[i]
    const aOn = !!(a && a.enabled && a.size > 0)
    const bOn = !!(b && b.enabled && b.size > 0)
    if (aOn && bOn) {
      out.push({
        ...b!, enabled: true,
        x: lerp(a!.x, b!.x, t), y: lerp(a!.y, b!.y, t), size: lerp(a!.size, b!.size, t),
        cropTop: lerp(a!.cropTop ?? 0, b!.cropTop ?? 0, t), cropBottom: lerp(a!.cropBottom ?? 0, b!.cropBottom ?? 0, t),
        cropLeft: lerp(a!.cropLeft ?? 0, b!.cropLeft ?? 0, t), cropRight: lerp(a!.cropRight ?? 0, b!.cropRight ?? 0, t),
      })
    } else if (bOn) {
      out.push({ ...b!, enabled: true, size: b!.size * t })
    } else if (aOn) {
      out.push({ ...a!, enabled: t < 1, size: a!.size * (1 - t) })
    } else {
      out.push(null)
    }
  }
  return out
}

/**
 * Loop an animated preview of the transition from the live scene to the target
 * scene: tween in, hold, replay. Picks the mode automatically —
 *  - both SuperSource with a changed box layout → animate the boxes;
 *  - otherwise (program change, direct feed, USK/art-only change) → crossfade,
 *    which the monitor renders as a mix (keys/art/program fade through).
 * When inactive, returns the static target. Keyed on `key` (the hovered look
 * name) so the loop restarts only when the hovered look changes.
 */
export function useLookPreview(fromScene: Scene, toScene: Scene | null, active: boolean, key: string | null): PreviewAnim {
  const fromRef = useRef(fromScene); fromRef.current = fromScene
  const toRef = useRef(toScene); toRef.current = toScene
  const [anim, setAnim] = useState<PreviewAnim>({ scene: toScene ?? fromScene, mixTo: null })

  useEffect(() => {
    if (!active || !toScene) { setAnim({ scene: toScene ?? fromRef.current, mixTo: null }); return }
    const DUR = 1100, HOLD = 950, CYCLE = DUR + HOLD
    // Decide the mode once per hovered look.
    const from = fromRef.current, to = toRef.current!
    const tween = from.program === SS && to.program === SS && boxSig(from.boxes) !== boxSig(to.boxes)
    let raf = 0, start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const el = (now - start) % CYCLE
      const t = el < DUR ? easeInOutCubic(el / DUR) : 1
      const f = fromRef.current, tg = toRef.current!
      if (tween) {
        setAnim({ scene: { ...tg, boxes: animBoxes(f.boxes, tg.boxes, t) }, mixTo: null })
      } else if (t <= 0.001) {
        setAnim({ scene: f, mixTo: null })
      } else if (t >= 0.999) {
        setAnim({ scene: tg, mixTo: null })   // hold on the target
      } else {
        setAnim({ scene: f, mixTo: { scene: tg, t } })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key])

  return active && toScene ? anim : { scene: toScene ?? fromScene, mixTo: null }
}
