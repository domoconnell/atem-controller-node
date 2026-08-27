'use client'
import { useEffect, useMemo, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { cmd } from '@/lib/api'
import type { Look, Snapshot } from '@/lib/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StatusBar } from '@/components/atem/status-bar'
import { SsMonitor } from '@/components/atem/ss-monitor'
import { MePanel } from '@/components/atem/me-panel'
import { TransitionTimeline } from '@/components/atem/transition-timeline'
import { LookTile } from '@/components/atem/look-tile'
import { LookSheet } from '@/components/atem/look-sheet'
import { PlanStoryboard } from '@/components/atem/plan-storyboard'
import { lookScene, liveScene, ppMediaThumb } from '@/lib/scene'
import { fetchPlanGrades } from '@/lib/api'
import type { PlanGrades } from '@/lib/types'
import { RecordDialog } from '@/components/atem/record-dialog'
import { SettingsDialog } from '@/components/atem/settings-dialog'
import { WireLog } from '@/components/atem/wire-log'
import { Button } from '@/components/ui/button'
import { Play, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function Page() {
  const { state, connected, tick, wire, wireVersion, clearWire } = useAtemState()
  const [targetName, setTargetName] = useState<string | null>(null)
  const [openLook, setOpenLook] = useState<Look | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [grades, setGrades] = useState<PlanGrades>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Keep the take timeline on screen ~2s after the transition finishes, showing
  // every step complete, before reverting to the status panel.
  const [heldBusy, setHeldBusy] = useState<Snapshot['busy']>(null)
  useEffect(() => {
    if (state?.busy) { setHeldBusy(state.busy); return }
    if (!heldBusy) return
    const t = setTimeout(() => setHeldBusy(null), 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.busy])

  const locked = !!(state?.busy || state?.animating)

  // Group looks into folders; unfoldered looks fall under '' (rendered last).
  const folderGroups = useMemo<[string, Look[]][]>(() => {
    const m = new Map<string, Look[]>()
    for (const l of state?.looks ?? []) { const f = l.folder?.trim() || ''; if (!m.has(f)) m.set(f, []); m.get(f)!.push(l) }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
  }, [state?.looks])
  const foldered = folderGroups.length > 1 || (folderGroups[0] && folderGroups[0][0] !== '')
  const gradeKey = state ? `${state.currentLook}|${state.atem.mixEffects[state.mainMe]?.programInput}|${state.busy?.name ?? ''}|${state.looks.length}` : ''
  useEffect(() => {
    if (!state?.atem.connected || locked) return
    let alive = true
    fetchPlanGrades().then((g) => alive && setGrades(g)).catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradeKey, state?.atem.connected, locked])
  const inputName = (id: number) => state?.atem.inputs[id] ?? String(id)

  // Preview monitor shows: the look currently transitioning to, else the
  // hovered/selected look, else the current look's recording.
  const target: Look | null = useMemo(() => {
    if (!state) return null
    const want = state.busy?.to ?? targetName ?? state.currentLook
    return state.looks.find((l) => l.name === want) ?? null
  }, [state, targetName])

  const me = state?.atem.mixEffects[state.mainMe]
  // Per-monitor width, capped by viewport height so the look grid keeps scroll
  // room; the two monitors are then spread with equal left/middle/right gaps.
  const monW = 'min(540px, max(220px, calc((100dvh - 620px) * 16 / 9)))'

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <StatusBar state={state} wsConnected={connected} tick={tick} locked={locked}
          onRecord={() => setRecordOpen(true)} onSettings={() => setSettingsOpen(true)} />

        {!state ? (
          <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
            <div className="flex items-center gap-3">
              <span className="led warn" /> Connecting to atem-controller…
            </div>
          </div>
        ) : (
          <main className="relative flex-1 min-h-0 overflow-hidden p-4 grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
            {state.atem.simulated && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 z-40 rounded-b-md bg-busy text-black text-[10px] font-bold uppercase tracking-[0.2em] px-3 py-1 shadow-[0_0_16px_-4px_var(--busy)]">
                Simulator — no ATEM connected
              </div>
            )}
            {/* ---- Left column: pinned monitors + scrolling looks ---- */}
            <div className="min-w-0 min-h-0 flex flex-col gap-4">
              <div className="shrink-0 flex justify-evenly items-start">
                <div className="min-w-0" style={{ width: monW }}>
                  <SsMonitor
                    scene={liveScene(state).scene}
                    mixTo={liveScene(state).mixTo}
                    inputName={inputName}
                    mediaThumbUrl={ppMediaThumb(state.propresenter?.currentMedia)}
                    displayBox={state.displayBox} proInput={state.propresenterInput}
                    label="Program"
                    tally="pgm"
                    sublabel={me ? `${inputName(me.programInput)}${me.inTransition ? ` · MIX ${Math.round((me.handlePosition / 10000) * 100)}%` : ''}` : undefined}
                    className={cn(me?.inTransition && 'glow-busy')}
                  />
                  <div className="mt-1 h-8 shrink-0 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                    <span>Live SuperSource</span>
                    <span className="font-medium text-foreground/80">{state.currentLook ?? '—'}</span>
                  </div>
                </div>

                <div className="min-w-0" style={{ width: monW }}>
                  <SsMonitor
                    scene={target ? lookScene(target) : liveScene(state).scene}
                    ghost={target && (target.me?.programInput ?? 6000) === 6000 ? state.atem.boxes : null}
                    inputName={inputName}
                    mediaThumbUrl={ppMediaThumb(target ? target.pro?.media : state.propresenter?.currentMedia)}
                    displayBox={state.displayBox} proInput={state.propresenterInput}
                    label={state.busy?.to ? 'Going to' : 'Preview'}
                    tally="pvw"
                    sublabel={target ? `${target.name}${target.me?.programInputName ? ' · ' + target.me.programInputName : ''}` : 'hover a look'}
                    className={cn(target && target.name !== state.currentLook && !state.busy && 'glow-pvw')}
                  />
                  <div className="mt-1 h-8 shrink-0 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                    <span>{target && target.name !== state.currentLook ? 'Target layout · live ghosted underneath' : target ? 'Recorded layout of the current look' : 'Hover a look to preview'}</span>
                    {target && !locked && target.name !== state.currentLook && (
                      <Button size="sm" className="h-7 text-[11px] font-bold" onClick={() => cmd('/goto', [target.name])}>
                        <Play className="size-3 fill-current" /> Take {target.name}
                      </Button>
                    )}
                    {target && target.name === state.currentLook && <span className="text-live font-medium">already on air</span>}
                  </div>
                </div>
              </div>

              {/* transition storyboard: what the engine will do + simulator verdict */}
              <div className="shrink-0 surface rounded-xl px-3 h-[76px] flex flex-col justify-center overflow-hidden">
                <div className="text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground mb-1 truncate flex items-center gap-3">
                  <span>Transition plan {target && target.name !== state.currentLook ? `→ ${target.name}` : ''}</span>
                  {state.verify?.results[0] && (
                    <span className={cn('normal-case tracking-normal font-semibold', state.verify.results[0].ok ? 'text-live/80' : 'text-pgm')}
                      title={state.verify.results[0].ok ? 'last transition: hardware state matched the simulator prediction' : state.verify.results[0].diffs.map((d) => `${d.what}: ${d.expected}→${d.actual}`).join('\n')}>
                      last: {state.verify.results[0].ok ? '● hw ok' : `◆ hw diverged (${state.verify.results[0].diffs.length})`}
                    </span>
                  )}
                </div>
                <PlanStoryboard look={target && target.name !== state.currentLook && state.atem.connected ? target.name : null} inputName={inputName} />
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                <div className="shrink-0 flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-[13px] font-semibold tracking-tight">Looks <span className="text-muted-foreground font-normal">· {state.looks.length}</span></h2>
                    <p className="text-[11px] text-muted-foreground">Hover to preview · Take runs from live state</p>
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 pb-2">
                {state.looks.length === 0 ? (
                  <div className="surface rounded-xl p-10 text-center text-muted-foreground text-[13px]">
                    No looks recorded yet — set the switcher up and hit <b className="text-foreground">Record</b> in the header.
                  </div>
                ) : (() => {
                  const tile = (look: Look) => (
                    <LookTile
                      key={look.name}
                      look={look}
                      state={state}
                      isCurrent={state.currentLook === look.name}
                      isTarget={targetName === look.name}
                      grade={grades[look.name]?.grade}
                      locked={locked}
                      onSelect={() => setTargetName(look.name)}
                      onGoto={() => cmd('/goto', [look.name])}
                      onOpen={() => { setOpenLook(look); setSheetOpen(true) }}
                      onDelete={() => cmd('/look/delete', [look.name])}
                    />
                  )
                  const gridCls = 'grid gap-2.5 grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[2000px]:grid-cols-8'
                  if (!foldered) return <div className={gridCls}>{state.looks.map(tile)}</div>
                  return (
                    <div className="space-y-4">
                      {folderGroups.map(([folder, looks]) => {
                        const isOpen = !collapsed.has(folder)
                        return (
                          <section key={folder || '_ungrouped'}>
                            <button
                              onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(folder) ? n.delete(folder) : n.add(folder); return n })}
                              className="w-full flex items-center gap-1.5 mb-2 text-left group/f"
                            >
                              <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-foreground/80 group-hover/f:text-foreground">{folder || 'Ungrouped'}</span>
                              <span className="text-[11px] text-muted-foreground font-normal">· {looks.length}</span>
                              <span className="flex-1 h-px bg-border/60 ml-2" />
                            </button>
                            {isOpen && <div className={gridCls}>{looks.map(tile)}</div>}
                          </section>
                        )
                      })}
                    </div>
                  )
                })()}

                </div>
              </div>
            </div>

            {/* ---- Right rail: status panel, or the live take timeline ---- */}
            <aside className="min-w-0 min-h-0 overflow-y-auto">
              {state.busy || heldBusy ? <TransitionTimeline busy={(state.busy ?? heldBusy)!} done={!state.busy} /> : <MePanel state={state} locked={locked} />}
            </aside>
          </main>
        )}

        {state && <RecordDialog open={recordOpen} onOpenChange={setRecordOpen} state={state} locked={locked} />}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} state={state} />

        <WireLog lines={wire} version={wireVersion} onClear={clearWire} />

        <LookSheet
          look={openLook ? state?.looks.find((l) => l.name === openLook.name) ?? openLook : null}
          state={state!}
          open={sheetOpen && !!state}
          onOpenChange={setSheetOpen}
          locked={locked}
        />
      </div>
    </TooltipProvider>
  )
}
