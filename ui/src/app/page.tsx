'use client'
import { useMemo, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { cmd } from '@/lib/api'
import type { Look } from '@/lib/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StatusBar } from '@/components/atem/status-bar'
import { SsMonitor } from '@/components/atem/ss-monitor'
import { MePanel } from '@/components/atem/me-panel'
import { LookTile } from '@/components/atem/look-tile'
import { LookSheet } from '@/components/atem/look-sheet'
import { RecordDialog } from '@/components/atem/record-dialog'
import { SettingsDialog } from '@/components/atem/settings-dialog'
import { Button } from '@/components/ui/button'
import { Play } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function Page() {
  const { state, connected, tick } = useAtemState()
  const [targetName, setTargetName] = useState<string | null>(null)
  const [openLook, setOpenLook] = useState<Look | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const locked = !!(state?.busy || state?.animating)
  const inputName = (id: number) => state?.atem.inputs[id] ?? String(id)

  // Preview monitor shows: the look currently transitioning to, else the
  // hovered/selected look, else the current look's recording.
  const target: Look | null = useMemo(() => {
    if (!state) return null
    const want = state.busy?.to ?? targetName ?? state.currentLook
    return state.looks.find((l) => l.name === want) ?? null
  }, [state, targetName])

  const me = state?.atem.mixEffects[state.mainMe]

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
          <main className="flex-1 min-h-0 p-4 grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
            {/* ---- Left column: pinned monitors + scrolling looks ---- */}
            <div className="min-w-0 min-h-0 flex flex-col gap-4">
              <div className="shrink-0 grid gap-4 grid-cols-2 max-w-[1100px]">
                <div>
                  <SsMonitor
                    boxes={state.atem.boxes}
                    inputName={inputName}
                    label="Program"
                    tally="pgm"
                    sublabel={me ? `${inputName(me.programInput)}${me.inTransition ? ' · IN TRANSITION' : ''}` : undefined}
                    className={cn(me?.inTransition && 'glow-busy')}
                  />
                  <div className="mt-1 h-8 shrink-0 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                    <span>Live SuperSource</span>
                    <span className="font-medium text-foreground/80">{state.currentLook ?? '—'}</span>
                  </div>
                </div>

                <div>
                  <SsMonitor
                    boxes={target?.boxes ?? state.atem.boxes}
                    ghost={target ? state.atem.boxes : null}
                    inputName={inputName}
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
                ) : (
                  <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[2000px]:grid-cols-6">
                    {state.looks.map((look) => (
                      <LookTile
                        key={look.name}
                        look={look}
                        state={state}
                        isCurrent={state.currentLook === look.name}
                        isTarget={targetName === look.name}
                        locked={locked}
                        onSelect={() => setTargetName(look.name)}
                        onGoto={() => cmd('/goto', [look.name])}
                        onOpen={() => { setOpenLook(look); setSheetOpen(true) }}
                      />
                    ))}
                  </div>
                )}

                </div>
              </div>
            </div>

            {/* ---- Right rail ---- */}
            <aside className="min-w-0 min-h-0 overflow-y-auto">
              <MePanel state={state} locked={locked} />
            </aside>
          </main>
        )}

        {state && <RecordDialog open={recordOpen} onOpenChange={setRecordOpen} state={state} locked={locked} />}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

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
