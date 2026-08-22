'use client'
import { useEffect, useState } from 'react'
import type { Look, Snapshot, Plan } from '@/lib/types'
import { PATTERN_NAMES } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd, fetchPlan } from '@/lib/api'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SsMonitor } from './ss-monitor'
import { lookScene, ppMediaThumb } from '@/lib/scene'
import { Play, Route, Zap, MoveRight, RefreshCcw, Trash2 } from 'lucide-react'

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-1.5 text-[12.5px] border-b border-border/50 last:border-0">
      <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground pt-0.5">{k}</span>
      <span className="tabular">{v}</span>
    </div>
  )
}

const BOX_TXT = ['text-box-1', 'text-box-2', 'text-box-3', 'text-box-4']

export function LookSheet({
  look, state, open, onOpenChange, locked,
}: { look: Look | null; state: Snapshot; open: boolean; onOpenChange: (o: boolean) => void; locked: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [tab, setTab] = useState('details')
  const inputName = (id?: number) => (id == null ? '—' : state.atem.inputs[id] ?? String(id))

  useEffect(() => { setPlan(null); setTab('details') }, [look?.name, open])

  const loadPlan = async () => {
    if (!look) return
    setTab('plan')
    setPlan(await fetchPlan(look.name))
  }

  if (!look) return null
  const isCurrent = state.currentLook === look.name
  const usk = look.me?.usk ?? []
  const p = look.ssProperties

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[560px] p-0 border-l border-border bg-background border-l-border/80">
        <SheetHeader className="p-5 pb-3">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-[18px] font-semibold tracking-tight">{look.name}</SheetTitle>
            {isCurrent && <Badge className="bg-live/15 text-live border-live/30">On air</Badge>}
          </div>
          <SheetDescription className="text-[12px]">
            Captured {look.capturedAt ? new Date(look.capturedAt).toLocaleString() : '—'}
          </SheetDescription>
        </SheetHeader>

        <div className="px-5">
          <SsMonitor scene={lookScene(look)} inputName={inputName} mediaThumbUrl={ppMediaThumb(look.pro?.media)} displayBox={state.displayBox} proInput={state.propresenterInput} label={isCurrent ? 'PGM' : 'Look'} tally={isCurrent ? 'pgm' : 'plain'} sublabel={look.me?.programInputName} />
        </div>

        <div className="px-5 pt-3 grid grid-cols-4 gap-1.5">
          <Button disabled={locked || isCurrent} className="col-span-2 font-bold" onClick={() => cmd('/goto', [look.name])}>
            <Play className="size-4 fill-current" /> Take
          </Button>
          <Button variant="secondary" onClick={loadPlan}><Route className="size-4" /> Plan</Button>
          <Button variant="secondary" disabled={locked} onClick={() => cmd('/look/animate', [look.name])} title="Animate SuperSource only"><MoveRight className="size-4" /> Anim</Button>
        </div>

        <div className="px-5 pt-4">
          <div className="grid grid-cols-3 rounded-lg bg-muted/60 p-[3px] gap-[3px]">
            {(['details', 'keyers', 'plan'] as const).map((t) => (
              <button
                key={t}
                onClick={() => (t === 'plan' ? loadPlan() : setTab(t))}
                className={cn(
                  'h-8 rounded-md text-[12px] font-semibold capitalize transition-colors',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <ScrollArea className="h-[calc(100vh-520px)] mt-3 pr-3">
            {tab === 'details' && <div className="space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">SuperSource boxes</div>
                {(look.boxes ?? []).map((b, i) => b && (
                  <div key={i} className={cn('flex items-center gap-3 py-1.5 text-[12.5px] border-b border-border/50 last:border-0', !b.enabled && 'opacity-45')}>
                    <span className={cn('font-black w-4', BOX_TXT[i])}>{i + 1}</span>
                    <span className="font-semibold min-w-[110px] truncate">{b.sourceName ?? inputName(b.source)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular">
                      ({(b.x / 100).toFixed(1)}, {(b.y / 100).toFixed(1)}) · {(b.size / 10).toFixed(0)}%{b.cropped ? ' · crop' : ''}
                    </span>
                    {!b.enabled && <Badge variant="outline" className="ml-auto text-[9px]">off</Badge>}
                  </div>
                ))}
              </div>
              {p && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">SuperSource art</div>
                  <KV k="Fill / key" v={<><b>{p.artFillSourceName ?? inputName(p.artFillSource)}</b> / {p.artCutSourceName ?? inputName(p.artCutSource)}</>} />
                  <KV k="Mode" v={p.artOptionName ?? (p.artOption === 1 ? 'foreground' : 'background')} />
                  <KV k="Key" v={p.artPreMultiplied ? 'pre-multiplied' : `clip ${(p.artClip / 10).toFixed(1)}% · gain ${(p.artGain / 10).toFixed(1)}%`} />
                </div>
              )}
              {look.me && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">M/E {(look.me.index ?? 1) + 1}</div>
                  <KV k="Program" v={<b className="text-pgm">{look.me.programInputName ?? inputName(look.me.programInput)}</b>} />
                  <KV k="Preview" v={<span className="text-pvw">{look.me.previewInputName ?? inputName(look.me.previewInput)}</span>} />
                  {look.me.nextTransition && <KV k="Next trans" v={`${look.me.nextTransition.style} [${look.me.nextTransition.selection.join(', ')}]`} />}
                </div>
              )}
              {look.mediaPlayers && look.mediaPlayers.some(Boolean) && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">Media players</div>
                  {look.mediaPlayers.map((mp) => mp && (
                    <KV key={mp.index} k={`MP ${mp.index + 1}`} v={<><b>{mp.name}</b> <span className="text-muted-foreground">· {mp.sourceType} {(mp.sourceType === 'still' ? mp.stillIndex : mp.clipIndex) + 1}</span></>} />
                  ))}
                </div>
              )}
              {look.hyperdeck && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">HyperDeck</div>
                  <KV k="Transport" v={look.hyperdeck.connected ? `${look.hyperdeck.status} · clip ${look.hyperdeck.clipId ?? '—'}${look.hyperdeck.loop ? ' · loop' : ''}${look.hyperdeck.singleClip ? ' · single' : ''}` : 'not connected'} />
                </div>
              )}
              {look.pro && (look.pro.look?.name || look.pro.media?.item?.name || look.pro.macro?.name) && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">ProPresenter</div>
                  {look.pro.look?.name && <KV k="Look" v={<b className="text-info">{look.pro.look.name}</b>} />}
                  {look.pro.media?.item?.name && <KV k="Background" v={<><b>{look.pro.media.item.name}</b>{look.pro.media.playlist?.name ? <span className="text-muted-foreground"> · {look.pro.media.playlist.name}</span> : null}</>} />}
                  {look.pro.macro?.name && <KV k="Macro" v={look.pro.macro.name} />}
                </div>
              )}
            </div>}

            {tab === 'keyers' && <div className="space-y-2">
              {usk.map((k, i) => k && (
                <div key={i} className={cn('rounded-lg border p-3', k.onAir ? 'border-pgm/40 bg-pgm/5' : 'border-border bg-muted/30')}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={cn('text-[12px] font-black', k.onAir ? 'text-pgm' : 'text-muted-foreground')}>USK {i + 1}</span>
                    <Badge variant="outline" className="text-[9px] uppercase">{k.keyType}</Badge>
                    {k.onAir && <Badge className="text-[9px] uppercase bg-pgm text-black border-0">On air</Badge>}
                    {k.flyEnabled && <Badge variant="outline" className="text-[9px]">fly</Badge>}
                    {k.mask?.maskEnabled && <Badge variant="outline" className="text-[9px]">mask</Badge>}
                  </div>
                  <KV k="Fill / key" v={<>{k.fillSourceName ?? inputName(k.fillSource)} / {k.cutSourceName ?? inputName(k.cutSource)}</>} />
                  {k.keyType === 'luma' && k.luma && (
                    <KV k="Luma" v={`clip ${(k.luma.clip / 10).toFixed(1)}% · gain ${(k.luma.gain / 10).toFixed(1)}%${k.luma.preMultiplied ? ' · premult' : ''}${k.luma.invert ? ' · invert' : ''}`} />
                  )}
                  {k.keyType === 'pattern' && k.pattern && (
                    <>
                      <KV k="Pattern" v={`${PATTERN_NAMES[k.pattern.style] ?? 'style ' + k.pattern.style}${k.pattern.invert ? ' · inverted' : ''}`} />
                      <KV k="Params" v={`size ${(k.pattern.size / 100).toFixed(1)}% · soft ${(k.pattern.softness / 100).toFixed(1)}% · sym ${(k.pattern.symmetry / 100).toFixed(0)}% · pos (${(k.pattern.positionX / 100).toFixed(0)}, ${(k.pattern.positionY / 100).toFixed(0)})`} />
                    </>
                  )}
                  {k.keyType === 'dve' && k.dve && (
                    <KV k="DVE" v={`pos (${k.dve.positionX}, ${k.dve.positionY}) · size (${k.dve.sizeX}, ${k.dve.sizeY})${k.dve.borderEnabled ? ' · border' : ''}`} />
                  )}
                </div>
              ))}
            </div>}

            {tab === 'plan' && <div>
              {!plan ? (
                <div className="text-[12px] text-muted-foreground py-6 text-center">
                  <Button variant="secondary" size="sm" onClick={loadPlan}><Route className="size-4" /> Compute plan from live state</Button>
                </div>
              ) : !plan.ok ? (
                <div className="text-[12px] text-destructive">{plan.error}</div>
              ) : (
                <ol className="space-y-1">
                  {plan.steps.map((s, i) => {
                    const { type, ...rest } = s
                    const args = JSON.stringify(rest)
                    return (
                      <li key={i} className="flex gap-2.5 text-[12px] rounded-md bg-muted/40 px-2.5 py-1.5 border border-border/60">
                        <span className="font-mono text-[10px] text-muted-foreground w-5 tabular pt-0.5">{String(i + 1).padStart(2, '0')}</span>
                        <div className="min-w-0">
                          <span className="font-semibold">{type}</span>
                          {args !== '{}' && <span className="ml-2 font-mono text-[10.5px] text-muted-foreground break-all">{args.length > 160 ? args.slice(0, 160) + '…' : args}</span>}
                        </div>
                      </li>
                    )
                  })}
                  {plan.notes?.length > 0 && (
                    <li className="text-[11.5px] text-busy pt-2">Notes: {plan.notes.join('; ')}</li>
                  )}
                </ol>
              )}
            </div>}
          </ScrollArea>
        </div>

        <Separator className="mt-2" />
        <div className="p-5 pt-3 flex gap-2">
          <Button variant="secondary" size="sm" disabled={locked} onClick={() => cmd('/look/apply', [look.name])} title="Snap SuperSource to this layout (no animation)">
            <Zap className="size-4" /> Snap
          </Button>
          <Button variant="secondary" size="sm" disabled={locked} onClick={() => { if (confirm(`Overwrite '${look.name}' with the current live state?`)) cmd('/look/capture', [look.name]) }}>
            <RefreshCcw className="size-4" /> Re-record
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" disabled={locked} onClick={() => { if (confirm(`Delete look '${look.name}'?`)) { cmd('/look/delete', [look.name]); onOpenChange(false) } }}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
