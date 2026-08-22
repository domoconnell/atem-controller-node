'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Check, Loader2, ArrowRight, Square, Waves, Scissors, Eye, Move, Film, MonitorPlay,
  Clock, Layers, Sparkles, CircleCheck,
} from 'lucide-react'

type Step = { type: string; label: string }

/** Icon for a plan step type — mirrors the storyboard vocabulary. */
function stepIcon(type: string) {
  switch (type) {
    case 'auto': return Waves
    case 'setNextTransition': case 'setMixRate': return Waves
    case 'cut': return Scissors
    case 'preview': case 'program': return Eye
    case 'animate': case 'animateBoxes': case 'animateUskPattern': return Move
    case 'setBoxes': case 'setSsProperties': case 'mediaPlayerSource': case 'uskSettings': return Film
    case 'uskOnAir': return Layers
    case 'hyperdeck': case 'hyperdeckEnsure': return Film
    case 'propresenter': return MonitorPlay
    case 'wait': case 'waitForTransition': return Clock
    case 'setCurrentLook': case 'applyLook': return Sparkles
    default: return Sparkles
  }
}

/**
 * Live take timeline — replaces the status sidebar while a transition runs, and
 * lingers ~2s afterwards showing every step complete (`done`). Ticks steps off
 * as the sequencer advances (stepIndex).
 */
export function TransitionTimeline({ busy, done = false }: { busy: NonNullable<Snapshot['busy']>; done?: boolean }) {
  const steps: Step[] = busy.steps ?? []
  const total = busy.totalSteps || steps.length || 1
  const idx = done ? total : busy.stepIndex
  const pct = done ? 100 : Math.min(100, Math.round(((idx + 1) / total) * 100))

  return (
    <div className="surface rounded-xl p-4 space-y-4">
      <div>
        <div className={cn('text-[10px] uppercase tracking-[0.18em] mb-1.5 flex items-center gap-1.5', done ? 'text-live' : 'text-live/80')}>
          {done ? <><CircleCheck className="size-3.5" /> Done</> : <><Loader2 className="size-3 animate-spin" /> Taking</>}
        </div>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="text-muted-foreground truncate">{busy.from ?? 'live'}</span>
          <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-live truncate">{busy.to ?? busy.name}</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-live transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-[10.5px] text-muted-foreground tabular">{done ? `${total} steps` : `step ${Math.min(idx + 1, total)} / ${total}`}</div>
      </div>

      <ol className="space-y-0.5">
        {steps.map((s, i) => {
          const stepDone = done || i < idx
          const active = !done && i === idx
          const Icon = stepIcon(s.type)
          return (
            <li key={i} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors', active ? 'bg-live/10' : 'bg-transparent')}>
              <span className={cn('grid place-items-center size-4 shrink-0', stepDone ? 'text-live' : active ? 'text-live' : 'text-muted-foreground/45')}>
                {stepDone ? <Check className="size-3.5" /> : active ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3.5" />}
              </span>
              <Icon className={cn('size-3.5 shrink-0', stepDone ? 'text-muted-foreground/60' : active ? 'text-live' : 'text-muted-foreground/50')} />
              <span className={cn('truncate', active ? 'text-foreground font-medium' : 'text-muted-foreground')}>{s.label}</span>
            </li>
          )
        })}
      </ol>

      {!done && (
        <Button size="sm" variant="secondary" className="w-full h-8 text-[11px]" onClick={() => cmd('/stop')}>
          <Square className="size-3.5" /> Stop
        </Button>
      )}
    </div>
  )
}
