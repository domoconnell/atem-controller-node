'use client'
import { useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Hardware-style segmented LED meter with a decaying peak-hold tick.
 * `value` is 0..1 (null = no data). Ramp: green -> amber (>70%) -> red (>88%)
 * for AF; RF uses a single teal hue. CSS transitions smooth the 8Hz updates.
 */
export function SegMeter({ value, kind = 'af', className, segs = 26 }: { value: number | null | undefined; kind?: 'af' | 'rf'; className?: string; segs?: number }) {
  const SEGS = segs
  const peak = useRef({ v: 0, t: 0 })
  const now = Date.now()
  const v = value ?? 0
  // peak hold: grab new peaks instantly, hold 800ms, then fall
  if (v >= peak.current.v) peak.current = { v, t: now }
  else {
    const age = now - peak.current.t - 800
    if (age > 0) peak.current.v = Math.max(v, peak.current.v - age * 0.0009)
  }
  const lit = Math.round(v * SEGS)
  const peakSeg = Math.min(SEGS - 1, Math.round(peak.current.v * SEGS) - 1)
  return (
    <div className={cn('flex items-center gap-[2px] h-[10px]', className)}>
      {Array.from({ length: SEGS }, (_, i) => {
        const frac = i / SEGS
        const on = i < lit
        const isPeak = value != null && i === peakSeg && peak.current.v > 0.03
        const color = kind === 'rf'
          ? 'bg-[#2dd4bf]'
          : frac > 0.88 ? 'bg-red-500' : frac > 0.7 ? 'bg-busy' : 'bg-live'
        return (
          <span key={i}
            className={cn('flex-1 h-full rounded-[1px] transition-opacity duration-150',
              color, on ? 'opacity-100' : isPeak ? 'opacity-70' : 'opacity-[0.13]')}
          />
        )
      })}
    </div>
  )
}

/** Battery pill: filled bars + %, colour-coded; null = transmitter off. */
export function Battery({ pct, pending }: { pct: number | null | undefined; pending?: boolean }) {
  if (pct == null && pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground/70" title="Battery reading not available for this receiver yet">
        <BatteryGlyph fill={0} />
        <span className="text-[11px]">—</span>
      </span>
    )
  }
  if (pct == null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground/60" title="No battery data - transmitter off?">
        <BatteryGlyph fill={0} className="opacity-40" />
        <span className="text-[10px]">tx off</span>
      </span>
    )
  }
  const color = pct <= 20 ? 'text-red-500' : pct <= 50 ? 'text-busy' : 'text-live'
  return (
    <span className={cn('inline-flex items-center gap-1.5 tabular-nums', color)} title={`Transmitter battery ${pct}%`}>
      <BatteryGlyph fill={pct / 100} className={cn(pct <= 20 && 'animate-pulse')} />
      <span className="text-[11px] font-semibold">{pct}%</span>
    </span>
  )
}

function BatteryGlyph({ fill, className }: { fill: number; className?: string }) {
  return (
    <span className={cn('relative inline-flex items-center', className)}>
      <span className="w-[20px] h-[10px] rounded-[2px] border border-current p-[1.5px] flex">
        <span className="h-full rounded-[1px] bg-current transition-[width] duration-300" style={{ width: `${Math.max(4, fill * 100)}%` }} />
      </span>
      <span className="w-[2px] h-[4px] bg-current rounded-r-[1px]" />
    </span>
  )
}

/** A/B diversity antenna indicator. */
export function Antenna({ active }: { active?: number }) {
  return (
    <span className="inline-flex gap-[3px] text-[9px] font-bold">
      {[1, 2].map((n) => (
        <span key={n} className={cn('w-[14px] text-center rounded-[3px] border leading-[13px] transition-colors',
          active === n ? 'border-[#2dd4bf]/60 text-[#2dd4bf] bg-[#2dd4bf]/10' : 'border-border text-muted-foreground/40')}>
          {n === 1 ? 'A' : 'B'}
        </span>
      ))}
    </span>
  )
}
