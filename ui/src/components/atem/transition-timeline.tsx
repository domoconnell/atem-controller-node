'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Check, Loader2, ArrowRight, Square } from 'lucide-react'

/**
 * Live take timeline — replaces the status sidebar while a transition runs.
 * Shows each plan step as a vertical list, ticking them off as the sequencer
 * advances (stepIndex). The parent swaps back to the status panel when the
 * transition ends (busy → null).
 */
export function TransitionTimeline({ busy }: { busy: NonNullable<Snapshot['busy']> }) {
  const steps = busy.steps ?? []
  const idx = busy.stepIndex
  const total = busy.totalSteps || steps.length || 1
  const pct = Math.min(100, Math.round(((idx + 1) / total) * 100))

  return (
    <div className="surface rounded-xl p-4 space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-live/80 mb-1.5 flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" /> Taking
        </div>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="text-muted-foreground truncate">{busy.from ?? 'live'}</span>
          <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-live truncate">{busy.to ?? busy.name}</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-live transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-[10.5px] text-muted-foreground tabular">step {Math.min(idx + 1, total)} / {total}</div>
      </div>

      <ol className="space-y-0.5">
        {steps.map((label, i) => {
          const done = i < idx
          const active = i === idx
          return (
            <li key={i} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] transition-colors',
              active ? 'bg-live/10' : 'bg-transparent')}>
              <span className={cn('grid place-items-center size-4 rounded-full shrink-0',
                done ? 'bg-live/20 text-live' : active ? 'text-live' : 'text-muted-foreground/40')}>
                {done ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <span className={cn('truncate', done ? 'text-muted-foreground' : active ? 'text-foreground font-medium' : 'text-muted-foreground')}>{label}</span>
            </li>
          )
        })}
      </ol>

      <Button size="sm" variant="secondary" className="w-full h-8 text-[11px]" onClick={() => cmd('/stop')}>
        <Square className="size-3.5" /> Stop
      </Button>
    </div>
  )
}
