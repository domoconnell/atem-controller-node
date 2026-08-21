'use client'
import { useEffect, useState } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useStream } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { MicOff } from 'lucide-react'
import type { Mic as MicObj, CueState } from '@/components/mics/mic-composite'

/** Mic defs are feature objects (not connector instances), so a mics widget
 *  fetches them itself and filters by the config's selected ids. */
export function useMicDefs(): MicObj[] {
  const [mics, setMics] = useState<MicObj[]>([])
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/features/mics').then((r) => r.json()).then((b) => { if (live) setMics(b.mics ?? []) }).catch(() => {})
    load(); const h = setInterval(load, 10000)
    return () => { live = false; clearInterval(h) }
  }, [])
  return mics
}

interface Ch { id: string; name?: string; rf?: number | null; af?: number | null; battery?: number | null }
interface DChan { channel: number; muted: boolean }
export const CUE: Record<CueState, { l: string; c: string }> = {
  live: { l: 'LIVE', c: 'bg-live text-black' }, standby: { l: 'SB', c: 'bg-busy text-black' }, off: { l: 'OFF', c: 'bg-muted text-muted-foreground' },
}
export const batTint = (b: number | null | undefined) => b == null ? 'text-muted-foreground/40' : b <= 20 ? 'text-destructive' : b <= 50 ? 'text-busy' : 'text-live'
const selected = (config: Record<string, unknown>, defs: MicObj[]) =>
  ((config.micIds as string[] | undefined) ?? []).map((id) => defs.find((m) => m.id === id)).filter((m): m is MicObj => !!m)

/** Live data hook for one mic (Sennheiser channel + DiGiCo channel). */
export function useMicLive(mic: MicObj) {
  const senn = useStream(mic.sennheiserInstanceId ?? null, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const ch = senn?.channels?.find((c) => c.id === mic.sennheiserChannel) ?? senn?.channels?.[0]
  const dig = useStream(mic.digicoInstanceId ?? null, 'channels') as { channels?: DChan[] } | null
  const dch = mic.digicoChannel != null ? dig?.channels?.find((c) => c.channel === mic.digicoChannel) : undefined
  return { online: !!senn?.online, ch, muted: dch?.muted as boolean | undefined, cue: (mic.cue ?? 'off') as CueState }
}
export function MiniBar({ value, kind }: { value: number | null | undefined; kind: 'rf' | 'af' }) {
  const v = Math.max(0, Math.min(1, value ?? 0))
  const c = kind === 'rf' ? 'bg-[#2dd4bf]' : v > 0.88 ? 'bg-destructive' : v > 0.7 ? 'bg-busy' : 'bg-live'
  return <span className="w-6 h-1 rounded-full bg-muted/40 overflow-hidden inline-block"><span className={cn('block h-full rounded-full', c)} style={{ width: `${v * 100}%` }} /></span>
}
/** Vertical level meter (fills bottom-up), for the compact strip. */
export function VMeter({ value, kind, label }: { value: number | null | undefined; kind: 'rf' | 'af'; label: string }) {
  const v = Math.max(0, Math.min(1, value ?? 0))
  const c = kind === 'rf' ? 'bg-[#2dd4bf]' : v > 0.88 ? 'bg-destructive' : v > 0.7 ? 'bg-busy' : 'bg-live'
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className="w-1.5 h-4 rounded-sm bg-muted/40 overflow-hidden flex items-end"><span className={cn('w-full rounded-sm transition-[height] duration-150', c)} style={{ height: `${v * 100}%` }} /></span>
      <span className="text-[7px] font-bold uppercase text-muted-foreground/60 leading-none">{label}</span>
    </span>
  )
}

/** One mic as a compact strip cell: cue · name · mute · rf/af · battery. */
function StripCell({ mic }: { mic: MicObj }) {
  const { online, ch, muted, cue } = useMicLive(mic)
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 justify-center" title={mic.label}>
      <span className={cn('shrink-0 text-[9px] font-black uppercase tracking-wide rounded px-1 py-0.5', CUE[cue].c)}>{CUE[cue].l}</span>
      <span className="text-[11px] font-semibold truncate min-w-0">{mic.label}</span>
      {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
      {online ? (
        <span className="shrink-0 flex items-end gap-1.5">
          <VMeter value={ch?.rf} kind="rf" label="RF" />
          <VMeter value={ch?.af} kind="af" label="AF" />
          {ch?.battery != null && (
            <span className="flex flex-col items-center gap-0.5">
              <span className={cn('text-[10px] font-bold tabular-nums leading-none', batTint(ch.battery))}>{ch.battery}%</span>
              <span className="text-[7px] font-bold uppercase text-muted-foreground/60 leading-none">BAT</span>
            </span>
          )}
        </span>
      ) : <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40 shrink-0">off</span>}
    </div>
  )
}
function MicsStrip({ config }: WidgetProps) {
  const defs = useMicDefs()
  const sel = selected(config, defs)
  return (
    <div className="h-full w-full flex items-center gap-0.5 px-1 rounded-lg border border-border/50 bg-card overflow-hidden divide-x divide-border/40">
      {sel.length === 0 && <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mx-auto">no mics selected</span>}
      {sel.map((m) => <StripCell key={m.id} mic={m} />)}
    </div>
  )
}
registerWidget({ type: 'mics-strip', label: 'Mics · strip', feature: 'mics', strip: true, defaultSize: { w: 8, h: 1 }, Component: MicsStrip })

/** One mic as a fuller row (panel). */
function PanelRow({ mic }: { mic: MicObj }) {
  const { online, ch, muted, cue } = useMicLive(mic)
  return (
    <div className={cn('flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0', !online && 'opacity-50')}>
      <span className={cn('shrink-0 w-14 text-center text-[9px] font-black uppercase tracking-wide rounded px-1 py-0.5', CUE[cue].c)}>{CUE[cue].l}</span>
      <span className="text-[13px] font-semibold truncate flex-1">{mic.label}</span>
      {muted ? <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-destructive shrink-0"><MicOff className="size-3" />MUTED</span>
        : mic.digicoInstanceId ? <span className="text-[10.5px] font-semibold text-live shrink-0">UNMUTED</span> : null}
      {online && <span className="flex items-center gap-1 shrink-0"><span className="text-[8px] text-muted-foreground">RF</span><MiniBar value={ch?.rf} kind="rf" /><span className="text-[8px] text-muted-foreground">AF</span><MiniBar value={ch?.af} kind="af" /></span>}
      <span className={cn('text-[11px] font-bold tabular-nums w-9 text-right shrink-0', batTint(online ? ch?.battery : null))}>{online && ch?.battery != null ? `${ch.battery}%` : '—'}</span>
    </div>
  )
}
function MicsPanel({ config, title }: WidgetProps) {
  const defs = useMicDefs()
  const sel = selected(config, defs)
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2">
        {sel.length === 0 && <div className="text-[11px] text-muted-foreground/50 pt-2">No mics selected.</div>}
        {sel.map((m) => <PanelRow key={m.id} mic={m} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'mics-panel', label: 'Mics', feature: 'mics', defaultSize: { w: 4, h: 4 }, Component: MicsPanel })
