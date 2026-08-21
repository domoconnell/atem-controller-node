'use client'
import { registerWidget, type WidgetProps } from './registry'
import { useAtemState } from '@/hooks/use-atem-state'
import { SsMonitor } from '@/components/atem/ss-monitor'
import { liveScene } from '@/lib/scene'
import { cn } from '@/lib/utils'

/** The live ATEM program — the same broadcast monitor as the ATEM Transitions
 *  designer (SuperSource plate + boxes, mixes rendered in flight), sized to fit
 *  the widget. Reads the full ATEM state over the app WebSocket. */
function AtemProgram({ title }: WidgetProps) {
  const { state } = useAtemState()
  const inputName = (id: number) => state?.atem?.inputs?.[id] ?? String(id)
  const me = state?.atem?.mixEffects?.[state?.mainMe ?? 0]
  const live = state ? liveScene(state) : null
  return (
    <div className="h-full w-full flex flex-col p-1.5">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-1 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 grid place-items-center overflow-hidden">
        {live ? (
          <SsMonitor scene={live.scene} mixTo={live.mixTo} inputName={inputName} tally="pgm" label="Program"
            sublabel={me ? `${inputName(me.programInput)}${me.inTransition ? ` · MIX ${Math.round((me.handlePosition / 10000) * 100)}%` : ''}` : undefined}
            className={cn('w-full max-h-full', me?.inTransition && 'glow-busy')} />
        ) : <div className="text-[11px] text-muted-foreground/50">No ATEM connection.</div>}
      </div>
    </div>
  )
}
registerWidget({ type: 'atem-program', label: 'ATEM Transitions · program', defaultSize: { w: 5, h: 4 }, Component: AtemProgram })
