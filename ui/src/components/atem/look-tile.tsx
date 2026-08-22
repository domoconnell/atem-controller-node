'use client'
import type { Look, Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SsMonitor } from './ss-monitor'
import { lookScene, liveScene, ppMediaThumb } from '@/lib/scene'
import { useLookPreview } from '@/hooks/use-look-preview'
import { Play, Info, MonitorPlay, Zap, Film } from 'lucide-react'

export function LookTile({
  look, state, isCurrent, isTarget, grade, locked, onGoto, onSelect, onOpen,
}: {
  look: Look
  state: Snapshot
  isCurrent: boolean
  isTarget: boolean
  grade?: string
  locked: boolean
  onGoto: () => void
  onSelect: () => void
  onOpen: () => void
}) {
  const inputName = (id: number) => state.atem.inputs[id] ?? String(id)
  const usks = look.me?.uskOnAir ?? []
  const pgm = look.me?.programInputName ?? (look.me?.programInput != null ? inputName(look.me.programInput) : '—')
  // On hover, animate this thumbnail through the transition from the live state
  // to this look (loops); static otherwise. Box changes tween; program/USK/art
  // changes crossfade — so it always reflects roughly what taking it does.
  const toScene = lookScene(look)
  const animate = isTarget && !isCurrent && !state.busy
  const anim = useLookPreview(liveScene(state).scene, toScene, animate, look.name)

  return (
    <div
      onMouseEnter={onSelect}
      onFocus={onSelect}
      className={cn(
        'group relative rounded-xl surface p-2 transition-all duration-200 outline-none',
        isCurrent && 'glow-live',
        isTarget && !isCurrent && 'glow-pvw',
        !isCurrent && !isTarget && 'hover:border-foreground/25'
      )}
    >
      <SsMonitor scene={anim.scene} mixTo={anim.mixTo} inputName={inputName} mediaThumbUrl={ppMediaThumb(look.pro?.media, 200)} displayBox={state.displayBox} proInput={state.propresenterInput} showLabels showGrid={false} className="p-1 rounded-lg" />

      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold truncate">{look.name}</span>
            {isCurrent && <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-live">● Live</span>}
            {!isCurrent && grade === 'has-cuts' && <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-pgm" title="the plan to reach this look has a visible cut">▲ cut</span>}
            {!isCurrent && grade === 'dip' && <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-busy" title="no cuts, but this transition fades through black to make the change">◐ dip</span>}
            {!isCurrent && grade === 'clean' && <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-live/60" title="simulator: clean transition">✓</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
            <span className="truncate">{pgm}</span>
            <span className="opacity-40">·</span>
            <span className="flex gap-0.5">
              {usks.map((on, i) => (
                <span key={i} className={cn('inline-block size-1.5 rounded-full', on ? 'bg-pgm' : 'bg-muted-foreground/30')} title={`USK${i + 1} ${on ? 'on' : 'off'}`} />
              ))}
            </span>
            {look.hyperdeck?.clipId != null && (
              <>
                <span className="opacity-40">·</span>
                <span>clip {look.hyperdeck.clipId}</span>
              </>
            )}
          </div>
          {(look.pro?.look?.name || look.pro?.media?.item?.name || look.pro?.macro?.name) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-info/80 truncate" title="ProPresenter recalled with this look">
              <MonitorPlay className="size-3 shrink-0" />
              {look.pro?.look?.name && <span className="truncate">{look.pro.look.name}</span>}
              {look.pro?.media?.item?.name && (
                <span className="flex items-center gap-0.5 shrink-0 min-w-0"><Film className="size-2.5 shrink-0" /><span className="truncate">{look.pro.media.item.name}</span></span>
              )}
              {look.pro?.macro?.name && (
                <span className="flex items-center gap-0.5 shrink-0"><Zap className="size-2.5" />{look.pro.macro.name}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-[1fr_auto] gap-1.5">
        <button
          disabled={locked || isCurrent}
          onClick={onGoto}
          className={cn(
            'h-8 rounded-md text-[11px] font-bold uppercase tracking-[0.12em] transition-all',
            'flex items-center justify-center gap-1.5',
            isCurrent
              ? 'bg-live/15 text-live cursor-default'
              : 'bg-primary text-primary-foreground hover:brightness-110 active:scale-[0.98] shadow-[0_0_16px_-6px_var(--primary)]',
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none'
          )}
        >
          <Play className="size-3.5 fill-current" /> {isCurrent ? 'On air' : 'Take'}
        </button>
        <button
          onClick={onOpen}
          className="h-8 w-8 rounded-md bg-muted/60 border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 grid place-items-center transition-colors"
          title="Details, plan, re-record, delete"
        >
          <Info className="size-4" />
        </button>
      </div>
    </div>
  )
}
