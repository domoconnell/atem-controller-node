'use client'
import { useEffect, useRef, useState } from 'react'
import type { Box } from '@/lib/types'
import type { Scene } from '@/components/atem/ss-monitor'

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Interpolate the SuperSource box layout from `from` to `to` at 0..1.
 *  Boxes present in both tween their geometry; boxes appearing pop in (size
 *  grows), boxes leaving pop out (size shrinks) — mirroring how the switcher
 *  brings SuperSource boxes on and off during a real transition. */
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
      out.push({ ...b!, enabled: true, size: b!.size * t })          // pop in
    } else if (aOn) {
      out.push({ ...a!, enabled: t < 1, size: a!.size * (1 - t) })   // pop out
    } else {
      out.push(null)
    }
  }
  return out
}

/**
 * When `active`, loop an animated preview of the transition from the live
 * scene to the target scene: tween in, hold, restart. When inactive, return
 * the static target scene. Keyed on `key` (the target look name) so the loop
 * only restarts when the hovered look — not every state tick — changes.
 */
export function useLookPreview(fromBoxes: (Box | null)[], to: Scene | null, active: boolean, key: string | null): Scene | null {
  const fromRef = useRef(fromBoxes); fromRef.current = fromBoxes
  const toRef = useRef(to); toRef.current = to
  const [scene, setScene] = useState<Scene | null>(to)

  useEffect(() => {
    if (!active || !to) { setScene(to); return }
    const DUR = 1100, HOLD = 950, CYCLE = DUR + HOLD
    let raf = 0, start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const el = (now - start) % CYCLE
      const t = el < DUR ? easeInOutCubic(el / DUR) : 1
      const tgt = toRef.current!
      setScene({ ...tgt, boxes: animBoxes(fromRef.current, tgt.boxes, t) })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key])

  return active && to ? scene : to
}
