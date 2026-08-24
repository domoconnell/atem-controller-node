'use client'
import { registerWidget, type WidgetProps } from './registry'
import { useStream, useTopic } from '@/hooks/use-topic'
import { usePulseOn, useDanger, dangerHigh, dangerLow } from '@/components/surfaces/pulse'
import { cn } from '@/lib/utils'
import { MicOff } from 'lucide-react'
import { SegMeter, Battery } from '@/components/mics/meters'
import type { Mic as MicObj, CueState } from '@/components/mics/mic-composite'
import { resolveService, nextItemIndex, firstItemIndex, type Segment, type Service } from '@/lib/runsheet'

/** Mic defs stream over the shared hub (topic 'feature:mics'). */
export function useMicDefs(): MicObj[] {
  const d = useTopic('feature:mics') as { mics?: MicObj[] } | null
  return d?.mics ?? []
}

interface Ch { id: string; name?: string; frequency?: number; rf?: number | null; af?: number | null; battery?: number | null; mute?: boolean }
interface DChan { channel: number; muted: boolean }
export const CUE: Record<CueState, { l: string; c: string }> = {
  live: { l: 'LIVE', c: 'bg-live text-black' }, standby: { l: 'SB', c: 'bg-busy text-black' }, off: { l: 'OFF', c: 'bg-muted text-muted-foreground' },
}
export const batTint = (b: number | null | undefined) => b == null ? 'text-muted-foreground/40' : b <= 20 ? 'text-destructive' : b <= 50 ? 'text-busy' : 'text-live'
const selected = (config: Record<string, unknown>, defs: MicObj[]) =>
  ((config.micIds as string[] | undefined) ?? []).map((id) => defs.find((m) => m.id === id)).filter((m): m is MicObj => !!m)

/** Live data hook for one composite mic (Sennheiser channel + DiGiCo channel). */
export function useMicLive(mic: MicObj) {
  const senn = useStream(mic.sennheiserInstanceId ?? null, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const ch = senn?.channels?.find((c) => c.id === mic.sennheiserChannel) ?? senn?.channels?.[0]
  const dig = useStream(mic.digicoInstanceId ?? null, 'channels') as { channels?: DChan[] } | null
  const dch = mic.digicoChannel != null ? dig?.channels?.find((c) => c.channel === mic.digicoChannel) : undefined
  return { online: !!senn?.online, ch, muted: dch?.muted as boolean | undefined, cue: (mic.cue ?? 'off') as CueState }
}

// ---- status → colour, in keeping with the UI ------------------------------
// Red is reserved for a genuine FAULT you'd read as "down": the receiver is
// OFFLINE, or the battery is low. Green: online, live and actually transmitting
// (RF present), unmuted. Orange: online but standby — muted, not cued live, or
// no transmitter RF (e.g. the handheld isn't keyed). A receiver being online
// with no RF is NOT offline, so it must not go red (it just isn't live yet).
type Tone = 'green' | 'orange' | 'red'
const TONE: Record<Tone, string> = {
  green: 'border-live/25 bg-live/[0.04]',
  orange: 'border-busy/30 bg-busy/[0.05]',
  red: 'border-destructive/35 bg-destructive/[0.05]',
}
const noSignal = (rf: number | null | undefined) => rf == null || rf <= 0.02
const lowBat = (b: number | null | undefined) => b != null && b <= 20
function compositeTone(online: boolean, rf: number | null | undefined, battery: number | null | undefined, muted: boolean, cue: CueState): Tone {
  if (!online || lowBat(battery)) return 'red'
  if (cue === 'live' && !muted && !noSignal(rf)) return 'green'
  return 'orange'
}
function receiverTone(online: boolean, rf: number | null | undefined, battery: number | null | undefined, muted: boolean): Tone {
  void rf
  if (!online || lowBat(battery)) return 'red'
  return muted ? 'orange' : 'green'
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

/** Small mute pill: green UNMUTED / red MUTED for one source (TX or DESK). */
function MuteChip({ label, muted }: { label: string; muted: boolean | undefined }) {
  if (muted == null) return null
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[8px] font-bold uppercase tracking-wide rounded px-1 py-px', muted ? 'bg-destructive/20 text-destructive' : 'bg-live/12 text-live/90')}>
      {muted && <MicOff className="size-2" />}{label}
    </span>
  )
}
function NowNextLine({ tone, label, name }: { tone: 'live' | 'busy'; label: string; name: string }) {
  return (
    <div className="flex items-baseline gap-1 min-w-0">
      <span className={cn('shrink-0 text-[7.5px] font-black uppercase tracking-wider', tone === 'live' ? 'text-live' : 'text-busy')}>{label}</span>
      <span className="truncate text-[10px]">{name}</span>
    </div>
  )
}

/** Compact composite mic card — name, cue, who's on it now/next, RF/AF meters,
 *  battery, TX + DESK mute; a subtle status tint. */
function MicCard({ mic, nowNext }: { mic: MicObj; nowNext?: { now?: string; next?: string } }) {
  const { online, ch, muted, cue } = useMicLive(mic)
  const rf = online ? ch?.rf : null
  const af = online ? ch?.af : null
  const battery = online ? ch?.battery : null
  const sennMute = mic.sennheiserInstanceId ? (ch?.mute ?? false) : undefined
  usePulseOn(`${cue}|${muted ? 1 : 0}|${sennMute ? 1 : 0}|${online ? 1 : 0}`)
  useDanger(Math.max(dangerLow(battery, 50, 15), (cue === 'live' && (!!muted || !!sennMute)) ? 0.85 : 0))
  const tone = compositeTone(online, rf, battery, !!muted || !!sennMute, cue)
  return (
    <div className={cn('rounded-md border p-1.5 flex flex-col gap-1', TONE[tone])}>
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-bold tracking-tight truncate">{mic.label}</span>
        <span className={cn('ml-auto shrink-0 text-[8px] font-black uppercase tracking-wider rounded px-1 py-px', CUE[cue].c)}>{CUE[cue].l}</span>
      </div>
      {(nowNext?.now || nowNext?.next) && (
        <div className="flex flex-col gap-px">
          {nowNext?.now && <NowNextLine tone="live" label="Now" name={nowNext.now} />}
          {nowNext?.next && <NowNextLine tone="busy" label="Next" name={nowNext.next} />}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 min-w-0"><span className="text-[7.5px] font-bold uppercase text-muted-foreground/60">RF</span><SegMeter value={rf} kind="rf" segs={12} className="w-14" /></span>
        <span className="flex items-center gap-1 min-w-0"><span className="text-[7.5px] font-bold uppercase text-muted-foreground/60">AF</span><SegMeter value={af} kind="af" segs={12} className="w-14" /></span>
      </div>
      <div className="flex items-center gap-1.5">
        <Battery pct={battery} pending={online ? ch?.battery == null : false} />
        <div className="ml-auto flex items-center gap-1">
          <MuteChip label="TX" muted={sennMute} />
          <MuteChip label="Desk" muted={mic.digicoInstanceId ? (muted ?? false) : undefined} />
        </div>
      </div>
    </div>
  )
}

/** Now/next person name per mic id, from the running service. */
function useMicNowNext(): Map<string, { now?: string; next?: string }> {
  const d = useTopic('feature:services') as { services?: Service[] } | null
  const svc = resolveService(d?.services ?? [], undefined, Date.now())
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const nowSeg = idx != null ? segs[idx] ?? null : null
  const nextSeg = segs[idx != null ? (nextItemIndex(segs, idx) ?? -1) : (firstItemIndex(segs) ?? -1)] ?? null
  const map = new Map<string, { now?: string; next?: string }>()
  const add = (seg: Segment | null, key: 'now' | 'next') => (seg?.people ?? []).forEach((p) => { if (p.micId) { const e = map.get(p.micId) ?? {}; e[key] = p.name; map.set(p.micId, e) } })
  add(nowSeg, 'now'); add(nextSeg, 'next')
  return map
}

function MicsPanel({ config, title }: WidgetProps) {
  const defs = useMicDefs()
  const sel = selected(config, defs)
  const nn = useMicNowNext()
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start">
        {sel.length === 0 && <div className="text-[11px] text-muted-foreground/50 p-1">No mics selected.</div>}
        {sel.map((m) => <MicCard key={m.id} mic={m} nowNext={nn.get(m.id)} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'mics-panel', label: 'Mics', feature: 'mics', defaultSize: { w: 6, h: 4 }, Component: MicsPanel })

/** One mic as a compact strip cell, tinted by status. */
function StripCell({ mic }: { mic: MicObj }) {
  const { online, ch, muted, cue } = useMicLive(mic)
  const sennMute = mic.sennheiserInstanceId ? (ch?.mute ?? false) : undefined
  const tone = compositeTone(online, online ? ch?.rf : null, online ? ch?.battery : null, !!muted || !!sennMute, cue)
  return (
    <div className={cn('flex-1 min-w-0 h-full flex items-center gap-1.5 px-2 justify-center rounded-md border', TONE[tone])} title={mic.label}>
      <span className={cn('shrink-0 text-[9px] font-black uppercase tracking-wide rounded px-1 py-0.5', CUE[cue].c)}>{CUE[cue].l}</span>
      <span className="text-[11px] font-semibold truncate min-w-0">{mic.label}</span>
      {(muted || sennMute) && <MicOff className="size-3 shrink-0 text-destructive" />}
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
    <div className="h-full w-full flex items-center gap-1 px-1 rounded-lg border border-border/50 bg-card overflow-hidden">
      {sel.length === 0 && <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mx-auto">no mics selected</span>}
      {sel.map((m) => <StripCell key={m.id} mic={m} />)}
    </div>
  )
}
registerWidget({ type: 'mics-strip', label: 'Mics · strip', feature: 'mics', strip: true, defaultSize: { w: 8, h: 1 }, Component: MicsStrip })

// ---- All wireless receivers (Sennheiser), same look, no DiGiCo/runsheet ----
export function ReceiverCard({ ch, online, name }: { ch: Ch; online: boolean; name: string }) {
  const rf = online ? ch.rf : null
  const af = online ? ch.af : null
  const battery = online ? ch.battery : null
  const tone = receiverTone(online, rf, battery, !!ch.mute)
  const label = ch.name?.trim() || name
  return (
    <div className={cn('rounded-md border p-1.5 flex flex-col gap-1', TONE[tone])}>
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-bold tracking-tight truncate">{label}</span>
        {ch.mute != null && <div className="ml-auto shrink-0"><MuteChip label="TX" muted={ch.mute} /></div>}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 min-w-0"><span className="text-[7.5px] font-bold uppercase text-muted-foreground/60">RF</span><SegMeter value={rf} kind="rf" segs={12} className="w-14" /></span>
        <span className="flex items-center gap-1 min-w-0"><span className="text-[7.5px] font-bold uppercase text-muted-foreground/60">AF</span><SegMeter value={af} kind="af" segs={12} className="w-14" /></span>
      </div>
      <div className="flex items-center gap-1.5">
        <Battery pct={battery} pending={online ? ch.battery == null : false} />
        {!online && <span className="ml-auto text-[9px] uppercase tracking-wider text-muted-foreground/40">offline</span>}
      </div>
    </div>
  )
}
