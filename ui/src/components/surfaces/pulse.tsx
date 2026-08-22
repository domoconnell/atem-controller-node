'use client'
import { createContext, useContext, useEffect, useId, useRef } from 'react'

/** A widget calls this to flash its frame. Provided by WidgetView. */
export const PulseContext = createContext<() => void>(() => {})
export function usePulse() { return useContext(PulseContext) }

/** A widget reports its current danger (0 safe … 1 critical); WidgetView takes
 *  the max across a widget's children and tints the accent from blue to red. */
export const DangerContext = createContext<(key: string, level: number | null) => void>(() => {})

/**
 * Flash the surrounding widget whenever `value` changes to a new value — the
 * semantic "something happened" signal (a new message, an advance, a status
 * change). Never fires on first mount.
 */
export function usePulseOn(value: unknown) {
  const pulse = usePulse()
  const prev = useRef<unknown>(value)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; prev.current = value; return }
    if (prev.current !== value) { prev.current = value; pulse() }
  }, [value, pulse])
}

/** Report this component's danger level (0..1) to its widget frame. */
export function useDanger(level: number) {
  const report = useContext(DangerContext)
  const id = useId()
  useEffect(() => {
    report(id, Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0)
    return () => report(id, null)
  }, [report, id, level])
}

/** Danger where a HIGH value is bad (cpu, disk used, packet loss): 0 below
 *  `warn`, ramping to 1 at `crit`. */
export function dangerHigh(v: number | null | undefined, warn: number, crit: number): number {
  if (v == null || !Number.isFinite(v)) return 0
  if (v >= crit) return 1
  if (v <= warn) return 0
  return (v - warn) / (crit - warn)
}
/** Danger where a LOW value is bad (battery %, free disk, time left): 0 above
 *  `warn`, ramping to 1 at `crit`. */
export function dangerLow(v: number | null | undefined, warn: number, crit: number): number {
  if (v == null || !Number.isFinite(v)) return 0
  if (v <= crit) return 1
  if (v >= warn) return 0
  return (warn - v) / (warn - crit)
}

/** Accent colour for a danger level: blue (safe) → cyan → green → amber → red
 *  (critical). `a` sets alpha. Used for both the orbit accent and the pulse. */
export function dangerColor(d: number, a = 1): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(d) ? d : 0))
  const hue = 232 - t * (232 - 25)          // 232 (blue) → 25 (red)
  const chroma = (0.14 + t * 0.07).toFixed(3)
  const light = (0.80 - t * 0.10).toFixed(3)
  return `oklch(${light} ${chroma} ${hue.toFixed(1)}${a < 1 ? ` / ${a}` : ''})`
}
