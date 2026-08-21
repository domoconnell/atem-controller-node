'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AppHeader } from '@/components/app-header'
import { TransitionWidget } from './transition-strip'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import Link from 'next/link'
import { Circle, Settings, ClipboardCheck } from 'lucide-react'

export function StatusBar({ state, wsConnected, tick, locked, onRecord, onSettings }: {
  state: Snapshot | null; wsConnected: boolean; tick: number; locked: boolean
  onRecord: () => void; onSettings: () => void
}) {
  const me = state?.atem.mixEffects[state.mainMe]
  return (
    <AppHeader app="atem" state={state} wsConnected={wsConnected} tick={tick}>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-muted-foreground uppercase tracking-[0.14em] text-[10px]">Look</span>
          <span className={cn('font-semibold', state?.currentLook ? 'text-live' : 'text-muted-foreground')}>
            {state?.currentLook ?? '—'}
          </span>
        </div>
        {me && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 text-[12px] tabular">
                <span className="text-muted-foreground uppercase tracking-[0.14em] text-[10px]">Mix</span>
                <span className="font-mono">{me.mixRate ?? '—'}<span className="text-muted-foreground">f</span></span>
              </div>
            </TooltipTrigger>
            <TooltipContent>M/E mix rate (frames)</TooltipContent>
          </Tooltip>
        )}
        <div className="h-6 w-px bg-border" />
        <TransitionWidget state={state} />
        <div className="h-6 w-px bg-border" />
        <Button size="sm" variant="secondary" className="h-8 text-[11px] font-bold uppercase tracking-wider" disabled={locked || !state} onClick={onRecord} title="Record the live state as a new look">
          <Circle className="size-3 fill-pgm text-pgm" /> Record
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground" title="Acceptance testing">
          <Link href="/acceptance"><ClipboardCheck className="size-4" /></Link>
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground" onClick={onSettings} title="Settings">
          <Settings className="size-4" />
        </Button>
      </div>
    </AppHeader>
  )
}
