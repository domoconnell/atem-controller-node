'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd } from '@/lib/api'
import { OctagonX, ArrowRight, Loader2 } from 'lucide-react'

/** Compact transition state widget for the header bar. */
export function TransitionWidget({ state }: { state: Snapshot | null }) {
  const busy = state?.busy
  const active = !!busy || !!state?.animating
  const pct = busy ? Math.round(((busy.stepIndex + 1) / busy.totalSteps) * 100) : 0

  if (!active) {
    return (
      <div className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/60 bg-muted/30">
        <span className="led on" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Ready</span>
      </div>
    )
  }
  return (
    <div className={cn('relative overflow-hidden flex items-center gap-3 h-8 pl-3 pr-1 rounded-md border border-busy/60 glow-busy')}>
      <div className="absolute inset-0 stripe-busy opacity-60 pointer-events-none" />
      <Loader2 className="relative size-3.5 text-busy animate-spin" />
      <div className="relative flex items-center gap-2 text-[12px] whitespace-nowrap">
        {busy?.to ? (
          <>
            <span className="text-muted-foreground max-w-[140px] truncate">{busy.from ?? 'live'}</span>
            <ArrowRight className="size-3 text-busy" />
            <span className="font-semibold max-w-[160px] truncate">{busy.to}</span>
          </>
        ) : (
          <span className="font-semibold">Animating</span>
        )}
      </div>
      {busy && (
        <div className="relative flex items-center gap-2">
          <span className="text-[10px] tabular text-muted-foreground font-mono">{busy.stepIndex + 1}/{busy.totalSteps}</span>
          <div className="w-16 h-1 rounded-full bg-black/40 overflow-hidden">
            <div className="h-full bg-busy transition-[width] duration-200" style={{ width: pct + '%' }} />
          </div>
        </div>
      )}
      <button
        onClick={() => cmd('/stop')}
        className="relative h-6 px-2 rounded bg-destructive text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 hover:brightness-110"
      >
        <OctagonX className="size-3" /> Stop
      </button>
    </div>
  )
}
