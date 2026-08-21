'use client'
import { useEffect, useRef } from 'react'
import { registerWidget, type WidgetDef, type WidgetProps } from './registry'
import { useStream, useTopic } from '@/hooks/use-topic'
import { statusTopic } from '@/lib/topics'
import { cn } from '@/lib/utils'
import {
  Mic, MicOff, CloudSun, Cpu, Activity, Volume2, Disc3,
  SlidersHorizontal, Wifi, MessageSquare, Timer, Play, Film, Video,
} from 'lucide-react'

/* ------------------------------------------------------------------ helpers */

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pct = (v: number | null, min: number, max: number) => v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)))
const mmss = (s: number | null | undefined) => {
  if (s == null || !Number.isFinite(s)) return '—'
  const neg = s < 0, a = Math.floor(Math.abs(s))
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}
const fmtTime = (at: number) => { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

type Tone = 'muted' | 'live' | 'busy' | 'alarm' | 'info'
const DOT: Record<string, string> = { online: 'bg-live', offline: 'bg-destructive', error: 'bg-destructive', degraded: 'bg-busy', connecting: 'bg-busy' }

function Title({ children }: { children: React.ReactNode }) {
  if (!children) return null // no title by default (see WidgetView) - opt-in only
  return <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{children}</div>
}
function Bar({ value, kind = 'af' }: { value: number; kind?: 'af' | 'rf' | 'ok' }) {
  const c = kind === 'rf' ? 'bg-[#2dd4bf]' : kind === 'ok' ? 'bg-live' : value > 0.88 ? 'bg-destructive' : value > 0.7 ? 'bg-busy' : 'bg-live'
  return <div className="h-1.5 flex-1 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full transition-[width] duration-200', c)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>
}
/** Long/thin header/footer frame: leading icon, label, right-aligned pills. */
function Frame({ icon: Icon, label, tint, children }: { icon: React.ElementType; label?: string; tint?: string; children?: React.ReactNode }) {
  return (
    <div className="h-full w-full flex items-center gap-2 px-2.5 rounded-lg border border-border/50 bg-card overflow-hidden">
      <Icon className={cn('size-4 shrink-0', tint ?? 'text-muted-foreground')} />
      {label && <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground truncate">{label}</span>}
      <div className="ml-auto flex items-center gap-1.5 min-w-0 overflow-hidden">{children}</div>
    </div>
  )
}
function Pill({ tone = 'muted', children }: { tone?: Tone; children: React.ReactNode }) {
  const c: Record<Tone, string> = {
    muted: 'bg-muted/50 text-foreground/90', live: 'bg-live/15 text-live',
    busy: 'bg-busy/15 text-busy', alarm: 'bg-destructive/15 text-destructive', info: 'bg-info/15 text-info',
  }
  return <span className={cn('text-[11px] font-semibold tabular-nums rounded px-1.5 py-0.5 shrink-0 truncate max-w-full', c[tone])}>{children}</span>
}

/* -------------------------------------------------------- overview factories */

/** Overview panel: the connector's own instance panel, tiled per instance. */
function makeOverview(Panel: React.ComponentType<WidgetProps>) {
  return function OverviewGrid({ instances = [], title }: WidgetProps) {
    return (
      <div className="h-full flex flex-col"><Title>{title}</Title>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(230px,1fr))] content-start">
          {instances.length === 0 && <div className="text-[11px] text-muted-foreground/50">No instances.</div>}
          {instances.map((i) => (
            <div key={i.id} className="h-[210px] rounded-lg border border-border/50 overflow-hidden bg-card/40">
              <Panel instanceId={i.id} title={i.name} config={{}} instances={[]} />
            </div>
          ))}
        </div>
      </div>
    )
  }
}
/** Overview strip: state dots + online/total count for a connector type. */
function makeOverviewStrip(icon: React.ElementType, label: string) {
  return function OverviewStrip({ instances = [], title }: WidgetProps) {
    const agg = useTopic('sys:status') as Record<string, string> | null
    const states = instances.map((i) => agg?.[i.id] ?? 'connecting')
    const online = states.filter((s) => s === 'online').length
    const worst: Tone = states.some((s) => s === 'offline' || s === 'error') ? 'alarm' : states.some((s) => s !== 'online') ? 'busy' : 'live'
    return (
      <Frame icon={icon} label={title || label}>
        <div className="flex items-center gap-[3px] min-w-0 overflow-hidden">
          {states.map((s, i) => <span key={i} className={cn('size-1.5 rounded-full shrink-0', DOT[s] ?? 'bg-busy')} />)}
        </div>
        <Pill tone={worst}>{online}/{instances.length}</Pill>
      </Frame>
    )
  }
}

interface ConnDef {
  typeId: string; label: string; icon: React.ElementType
  Panel: React.ComponentType<WidgetProps>; Strip: React.ComponentType<WidgetProps>
  Overview?: React.ComponentType<WidgetProps>
  panelSize?: { w: number; h: number }; overviewSize?: { w: number; h: number }
}
/** Register the four purpose-built widgets for a connector: instance panel,
 *  instance strip, overview panel (all instances), overview strip. */
function connector(d: ConnDef) {
  const base: Partial<WidgetDef> = { supportedTypeIds: [d.typeId] }
  registerWidget({ ...base, type: d.typeId, label: d.label, defaultSize: d.panelSize ?? { w: 4, h: 3 }, Component: d.Panel })
  registerWidget({ ...base, type: `${d.typeId}-strip`, label: `${d.label} · strip`, strip: true, defaultSize: { w: 4, h: 1 }, Component: d.Strip })
  registerWidget({ ...base, type: `${d.typeId}-all`, label: `${d.label} · all`, multi: 'type', defaultSize: d.overviewSize ?? { w: 6, h: 4 }, Component: d.Overview ?? makeOverview(d.Panel) })
  registerWidget({ ...base, type: `${d.typeId}-all-strip`, label: `${d.label} · all · strip`, multi: 'type', strip: true, defaultSize: { w: 5, h: 1 }, Component: makeOverviewStrip(d.icon, d.label) })
}

/* ============================================================== SENNHEISER */

interface Ch { id: string; name?: string; frequency?: number; rf?: number | null; af?: number | null; battery?: number | null; ant?: number; mute?: boolean }
function batTone(b: number | null | undefined): Tone { return b == null ? 'muted' : b <= 20 ? 'alarm' : b <= 50 ? 'busy' : 'live' }

function ChannelRow({ ch, fallback }: { ch: Ch; fallback: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold truncate">{ch.name?.trim() || fallback}</span>
        <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0">{ch.frequency ? `${(ch.frequency / 1000).toFixed(3)}` : ''}</span>
      </div>
      <div className="flex items-center gap-1.5"><span className="text-[8px] w-3 text-muted-foreground">RF</span><Bar value={ch.rf ?? 0} kind="rf" /></div>
      <div className="flex items-center gap-1.5"><span className="text-[8px] w-3 text-muted-foreground">AF</span><Bar value={ch.af ?? 0} /></div>
      <div className="flex items-center justify-between text-[10px]">
        <span className={cn('tabular-nums', batTone(ch.battery) === 'alarm' ? 'text-destructive' : batTone(ch.battery) === 'busy' ? 'text-busy' : ch.battery == null ? 'text-muted-foreground/50' : 'text-live')}>{ch.battery != null ? `${ch.battery}%` : 'tx off'}</span>
        <span className="flex items-center gap-2">
          {ch.mute && <span className="text-destructive">mute</span>}
          {ch.ant ? <span className="text-muted-foreground/60">ant {ch.ant === 1 ? 'A' : 'B'}</span> : null}
        </span>
      </div>
    </div>
  )
}
function MicPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const chans = d?.channels ?? []
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className={cn('flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2.5', !d?.online && 'opacity-50')}>
        {chans.length === 0 && <div className="text-[11px] text-muted-foreground/50">{d?.online ? 'No channels.' : 'Offline.'}</div>}
        {chans.map((ch) => <ChannelRow key={ch.id} ch={ch} fallback={title} />)}
      </div>
    </div>
  )
}
function MicStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const chans = d?.channels ?? []
  const bats = chans.map((c) => c.battery).filter((b): b is number => b != null)
  const worstBat = bats.length ? Math.min(...bats) : null
  const rf = chans.length ? Math.max(...chans.map((c) => c.rf ?? 0)) : 0
  return (
    <Frame icon={Mic} label={title} tint={d?.online ? 'text-[#2dd4bf]' : 'text-muted-foreground/40'}>
      {chans.some((c) => c.mute) && <Pill tone="alarm">mute</Pill>}
      <span className="w-8 hidden sm:flex"><Bar value={rf} kind="rf" /></span>
      <Pill tone={batTone(worstBat)}>{worstBat != null ? `${worstBat}%` : (d?.online ? 'tx off' : 'off')}</Pill>
    </Frame>
  )
}
function MicRack({ instances = [], title }: WidgetProps) {
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start">
        {instances.length === 0 && <div className="text-[11px] text-muted-foreground/50">No receivers.</div>}
        {instances.map((i) => (
          <div key={i.id} className="rounded-lg border border-border/60 p-2"><MicPanelInline id={i.id} name={i.name} /></div>
        ))}
      </div>
    </div>
  )
}
function MicPanelInline({ id, name }: { id: string; name: string }) {
  const d = useStream(id, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const chans = d?.channels ?? []
  return (
    <div className={cn('space-y-1.5', !d?.online && 'opacity-40')}>
      {chans.length === 0 && <div className="text-[11px] text-muted-foreground/60">{name}</div>}
      {chans.map((ch) => <ChannelRow key={ch.id} ch={ch} fallback={name} />)}
    </div>
  )
}
connector({ typeId: 'sennheiser', label: 'Wireless mic', icon: Mic, Panel: MicPanel, Strip: MicStrip, Overview: MicRack, panelSize: { w: 3, h: 3 }, overviewSize: { w: 6, h: 5 } })

/** Header/footer overview: one mic icon per receiver, spread across the strip,
 *  tinted by battery/online, with the % — icons, not just LEDs. */
function MicStripIcon({ id, name }: { id: string; name: string }) {
  const d = useStream(id, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const bats = (d?.channels ?? []).map((c) => c.battery).filter((b): b is number => b != null)
  const bat = bats.length ? Math.min(...bats) : null
  const muted = (d?.channels ?? []).some((c) => c.mute)
  const tint = !d?.online ? 'text-muted-foreground/40' : batTone(bat) === 'alarm' ? 'text-destructive' : batTone(bat) === 'busy' ? 'text-busy' : 'text-[#2dd4bf]'
  return (
    <div className="flex-1 min-w-0 flex items-center justify-center gap-1" title={`${(d?.channels?.[0]?.name || name).trim()}${bat != null ? ` · ${bat}%` : ''}`}>
      <Mic className={cn('size-4 shrink-0', tint)} />
      {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
      {bat != null && <span className={cn('text-[10px] font-bold tabular-nums', tint)}>{bat}%</span>}
    </div>
  )
}
function MicsOverviewStrip({ instances = [] }: WidgetProps) {
  return (
    <div className="h-full w-full flex items-center gap-1 px-2 rounded-lg border border-border/50 bg-card overflow-hidden">
      {instances.length === 0 && <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mx-auto">no receivers</span>}
      {instances.map((i) => <MicStripIcon key={i.id} id={i.id} name={i.name} />)}
    </div>
  )
}
registerWidget({ type: 'sennheiser-all-strip', label: 'Wireless mic · all · strip', supportedTypeIds: ['sennheiser'], multi: 'type', strip: true, defaultSize: { w: 6, h: 1 }, Component: MicsOverviewStrip })

/* ================================================================== SMAART */

const SPL_FIELDS: [string, string][] = [['splASlow', 'A slow'], ['splAFast', 'A fast'], ['splCFast', 'C fast'], ['laeq1', 'LAeq'], ['laeq15', 'LAeq 15'], ['peakC', 'Peak C']]
function splTone(v: number | null): Tone { return v == null ? 'muted' : v > 100 ? 'alarm' : v > 95 ? 'busy' : 'live' }
function SmaartPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'spl') as Record<string, unknown> | null
  const viol = (d?.violations as unknown[] | undefined)?.length ?? 0
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 grid grid-cols-2 gap-x-4 gap-y-1.5 content-start">
        {SPL_FIELDS.map(([f, label]) => {
          const v = num(d?.[f])
          return (
            <div key={f} className="space-y-0.5">
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>{label}</span><span className="tabular-nums font-semibold text-foreground">{v != null ? v.toFixed(1) : '—'}</span></div>
              <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full', splTone(v) === 'alarm' ? 'bg-destructive' : splTone(v) === 'busy' ? 'bg-busy' : 'bg-live')} style={{ width: `${pct(v, 60, 110) * 100}%` }} /></div>
            </div>
          )
        })}
        {viol > 0 && <div className="col-span-2 text-[11px] text-destructive font-semibold">{viol} SPL violation{viol > 1 ? 's' : ''}</div>}
      </div>
    </div>
  )
}
function SmaartStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'spl') as Record<string, unknown> | null
  const a = num(d?.splAFast), leq = num(d?.laeq15 ?? d?.laeq1)
  return (
    <Frame icon={Volume2} label={title}>
      {leq != null && <Pill>LAeq {leq.toFixed(0)}</Pill>}
      <Pill tone={splTone(a)}>{a != null ? `${a.toFixed(1)} dB` : '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'smaart', label: 'SPL', icon: Volume2, Panel: SmaartPanel, Strip: SmaartStrip, panelSize: { w: 4, h: 3 } })

/* ==================================================================== QLAB */

interface RunCue { id: string; name: string; elapsed: number; remaining: number; percent: number }
function QlabPanel({ instanceId, title }: WidgetProps) {
  const head = useStream(instanceId, 'playhead') as { name?: string | null } | null
  const run = useStream(instanceId, 'running') as { cues?: RunCue[] } | null
  const cues = run?.cues ?? []
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2">
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Playhead</div>
          <div className="text-[15px] font-bold truncate">{head?.name || '—'}</div>
        </div>
        <div className="text-[9px] uppercase tracking-wide text-muted-foreground pt-1">Running{cues.length ? ` · ${cues.length}` : ''}</div>
        {cues.length === 0 && <div className="text-[11px] text-muted-foreground/50">Nothing running.</div>}
        {cues.map((c) => (
          <div key={c.id} className="space-y-1">
            <div className="flex justify-between text-[12px]"><span className="truncate">{c.name || c.id}</span><span className="tabular-nums text-muted-foreground shrink-0 ml-2">{mmss(c.remaining)}</span></div>
            <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden"><div className="h-full rounded-full bg-info transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(1, c.percent)) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  )
}
function QlabStrip({ instanceId, title }: WidgetProps) {
  const head = useStream(instanceId, 'playhead') as { name?: string | null } | null
  const run = useStream(instanceId, 'running') as { cues?: RunCue[] } | null
  const n = run?.cues?.length ?? 0
  return (
    <Frame icon={Play} label={title}>
      <Pill>{head?.name || '—'}</Pill>
      {n > 0 && <Pill tone="info">▶ {n}</Pill>}
    </Frame>
  )
}
connector({ typeId: 'qlab', label: 'QLab', icon: Play, Panel: QlabPanel, Strip: QlabStrip, panelSize: { w: 4, h: 4 } })

/* ================================================================== REAPER */

interface Trk { number: number; name: string; recordArmed: boolean; muted: boolean; soloed: boolean; peakDb: number }
function reaperTone(state?: string): Tone { return state === 'recording' ? 'alarm' : state === 'playing' ? 'live' : state === 'paused' ? 'busy' : 'muted' }
function ReaperPanel({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'transport') as { state?: string; positionString?: string; armedCount?: number; isRepeatOn?: boolean } | null
  const tk = useStream(instanceId, 'tracks') as { tracks?: Trk[]; count?: number; armedCount?: number } | null
  const disk = useStream(instanceId, 'disk') as { freeMb?: number } | null
  const tracks = tk?.tracks ?? []
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <Pill tone={reaperTone(t?.state)}>{(t?.state ?? '—').toUpperCase()}</Pill>
          <span className="text-[18px] font-bold tabular-nums font-mono">{t?.positionString ?? '—'}</span>
          {(t?.armedCount ?? 0) > 0 && <span className="ml-auto text-[11px] text-destructive font-semibold">● {t?.armedCount} armed</span>}
        </div>
        {tracks.map((tr) => (
          <div key={tr.number} className="flex items-center gap-2 text-[11px]">
            {tr.recordArmed ? <span className="size-2 rounded-full bg-destructive shrink-0" /> : <span className="size-2 rounded-full bg-muted shrink-0" />}
            <span className="truncate flex-1">{tr.name || `Track ${tr.number}`}</span>
            <span className="tabular-nums text-muted-foreground shrink-0">{tr.peakDb != null ? `${tr.peakDb} dB` : ''}</span>
          </div>
        ))}
        {disk?.freeMb != null && <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/40">Disk free {(disk.freeMb / 1000).toFixed(1)} GB</div>}
      </div>
    </div>
  )
}
function ReaperStrip({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'transport') as { state?: string; positionString?: string; armedCount?: number } | null
  return (
    <Frame icon={Disc3} label={title}>
      {(t?.armedCount ?? 0) > 0 && <Pill tone="alarm">●{t?.armedCount}</Pill>}
      <span className="text-[12px] tabular-nums font-mono truncate">{t?.positionString ?? '—'}</span>
      <Pill tone={reaperTone(t?.state)}>{(t?.state ?? '—').slice(0, 4).toUpperCase()}</Pill>
    </Frame>
  )
}
connector({ typeId: 'reaper', label: 'REAPER', icon: Disc3, Panel: ReaperPanel, Strip: ReaperStrip, panelSize: { w: 4, h: 4 } })

/* =============================================================== HYPERDECK */

function hdTone(s?: string): Tone { return s === 'record' ? 'alarm' : s === 'play' ? 'live' : s === 'preview' ? 'info' : 'muted' }
function HyperdeckPanel({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'transport') as { status?: string; timecode?: string; displayTimecode?: string; speed?: number; slotId?: number; clipId?: number } | null
  const slot = useStream(instanceId, 'slots') as { recordingTimeSeconds?: number; videoFormat?: string; status?: string; volumeName?: string } | null
  const dev = useStream(instanceId, 'device') as { model?: string } | null
  const tc = t?.displayTimecode || t?.timecode || '––:––:––:––'
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-2 px-3 pb-2">
        <div className="flex items-center gap-2">
          <Pill tone={hdTone(t?.status)}>{(t?.status ?? '—').toUpperCase()}</Pill>
          {dev?.model && <span className="ml-auto text-[10px] text-muted-foreground truncate">{dev.model}</span>}
        </div>
        <div className="text-[26px] font-bold tabular-nums font-mono text-center leading-none">{tc}</div>
        <div className="flex justify-between text-[10px] text-muted-foreground pt-1">
          <span>{slot?.videoFormat ?? ''}</span>
          {slot?.recordingTimeSeconds != null && <span>rec {mmss(slot.recordingTimeSeconds)} left</span>}
        </div>
      </div>
    </div>
  )
}
function HyperdeckStrip({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'transport') as { status?: string; timecode?: string; displayTimecode?: string } | null
  return (
    <Frame icon={Film} label={title}>
      <span className="text-[12px] tabular-nums font-mono truncate">{t?.displayTimecode || t?.timecode || '––:––:––:––'}</span>
      <Pill tone={hdTone(t?.status)}>{(t?.status ?? '—').toUpperCase()}</Pill>
    </Frame>
  )
}
connector({ typeId: 'hyperdeck', label: 'HyperDeck', icon: Film, Panel: HyperdeckPanel, Strip: HyperdeckStrip, panelSize: { w: 4, h: 3 } })

/* ============================================================ PROPRESENTER */

interface PpTimer { uuid?: string; name: string; seconds: number; state: string }
function ppTone(s?: string): Tone { return s === 'running' ? 'live' : s === 'overrun' ? 'alarm' : s === 'stopped' ? 'muted' : 'busy' }
function ProPresenterPanel({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'timers') as { timers?: PpTimer[] } | null
  const slide = useStream(instanceId, 'slide') as { current?: string; next?: string } | null
  const timers = t?.timers ?? []
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2">
        {timers.length === 0 && <div className="text-[11px] text-muted-foreground/50">No timers.</div>}
        {timers.map((tm, i) => (
          <div key={tm.uuid ?? i} className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full shrink-0', ppTone(tm.state) === 'live' ? 'bg-live' : ppTone(tm.state) === 'alarm' ? 'bg-destructive' : 'bg-muted')} />
            <span className="text-[12px] truncate flex-1">{tm.name}</span>
            <span className={cn('text-[16px] font-bold tabular-nums shrink-0', tm.seconds < 0 && 'text-destructive')}>{mmss(tm.seconds)}</span>
          </div>
        ))}
        {(slide?.current || slide?.next) && (
          <div className="pt-1.5 border-t border-border/40 space-y-0.5">
            <div className="text-[12px]"><span className="text-muted-foreground text-[10px] uppercase mr-1.5">now</span>{slide?.current || '—'}</div>
            {slide?.next && <div className="text-[11px] text-muted-foreground"><span className="text-[10px] uppercase mr-1.5">next</span>{slide.next}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
function ProPresenterStrip({ instanceId, title }: WidgetProps) {
  const t = useStream(instanceId, 'timers') as { timers?: PpTimer[] } | null
  const timers = t?.timers ?? []
  const active = timers.find((x) => x.state === 'running') ?? timers[0]
  return (
    <Frame icon={Timer} label={title}>
      {active && <span className="text-[10px] text-muted-foreground truncate">{active.name}</span>}
      <Pill tone={ppTone(active?.state)}>{active ? mmss(active.seconds) : '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'propresenter', label: 'ProPresenter', icon: Timer, Panel: ProPresenterPanel, Strip: ProPresenterStrip, panelSize: { w: 4, h: 3 } })

/* =================================================================== UNIFI */

interface UniDev { id: string; name: string; model: string; online: boolean; clientCount: number | null; cpuPct: number | null }
function UnifiPanel({ instanceId, title }: WidgetProps) {
  const s = useStream(instanceId, 'summary') as { onlineCount?: number; deviceCount?: number; clientCount?: number; wirelessClientCount?: number; siteName?: string } | null
  const d = useStream(instanceId, 'devices') as { devices?: UniDev[] } | null
  const devs = d?.devices ?? []
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2">
        <div className="flex items-center gap-4">
          <div><div className="text-[20px] font-bold tabular-nums leading-none">{s?.onlineCount ?? '—'}<span className="text-[12px] text-muted-foreground">/{s?.deviceCount ?? '—'}</span></div><div className="text-[9px] uppercase text-muted-foreground">devices</div></div>
          <div><div className="text-[20px] font-bold tabular-nums leading-none">{s?.clientCount ?? '—'}</div><div className="text-[9px] uppercase text-muted-foreground">clients</div></div>
          {s?.wirelessClientCount != null && <div><div className="text-[20px] font-bold tabular-nums leading-none">{s.wirelessClientCount}</div><div className="text-[9px] uppercase text-muted-foreground">wireless</div></div>}
        </div>
        <div className="space-y-1 pt-1 border-t border-border/40">
          {devs.map((dev) => (
            <div key={dev.id} className="flex items-center gap-2 text-[11px]">
              <span className={cn('size-2 rounded-full shrink-0', dev.online ? 'bg-live' : 'bg-destructive')} />
              <span className="truncate flex-1">{dev.name}</span>
              <span className="text-muted-foreground/60 shrink-0">{dev.model}</span>
              {dev.clientCount != null && <span className="tabular-nums text-muted-foreground shrink-0 w-8 text-right">{dev.clientCount}c</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
function UnifiStrip({ instanceId, title }: WidgetProps) {
  const s = useStream(instanceId, 'summary') as { onlineCount?: number; deviceCount?: number; clientCount?: number } | null
  const down = (s?.deviceCount ?? 0) - (s?.onlineCount ?? 0)
  return (
    <Frame icon={Wifi} label={title}>
      {s?.clientCount != null && <Pill>{s.clientCount} cl</Pill>}
      <Pill tone={down > 0 ? 'alarm' : 'live'}>{s?.onlineCount ?? '—'}/{s?.deviceCount ?? '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'unifi', label: 'UniFi', icon: Wifi, Panel: UnifiPanel, Strip: UnifiStrip, panelSize: { w: 4, h: 3 } })

/* ================================================================== DIGICO */

interface DChan { channel: number; name: string; muted: boolean; faderDb: number | null }
function DigicoPanel({ instanceId, title }: WidgetProps) {
  const c = useStream(instanceId, 'channels') as { channels?: DChan[] } | null
  const snap = useStream(instanceId, 'snapshots') as { current?: number } | null
  const chans = c?.channels ?? []
  const muted = chans.filter((x) => x.muted).length
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-1.5">
        <div className="flex items-center gap-3 text-[11px]">
          {snap?.current != null && <Pill tone="info">snap {snap.current}</Pill>}
          <span className="text-muted-foreground">{chans.length} ch</span>
          {muted > 0 && <span className="text-destructive font-semibold ml-auto">{muted} muted</span>}
        </div>
        {chans.map((ch) => (
          <div key={ch.channel} className="flex items-center gap-2 text-[11px]">
            <span className="tabular-nums text-muted-foreground/60 w-5 shrink-0">{ch.channel}</span>
            <span className={cn('truncate flex-1', ch.muted && 'text-destructive line-through')}>{ch.name}</span>
            {ch.faderDb != null && <span className="tabular-nums text-muted-foreground shrink-0">{ch.faderDb} dB</span>}
            {ch.muted && <span className="text-[9px] font-bold text-destructive shrink-0">M</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
function DigicoStrip({ instanceId, title }: WidgetProps) {
  const c = useStream(instanceId, 'channels') as { channels?: DChan[] } | null
  const snap = useStream(instanceId, 'snapshots') as { current?: number } | null
  const muted = (c?.channels ?? []).filter((x) => x.muted).length
  return (
    <Frame icon={SlidersHorizontal} label={title}>
      {muted > 0 && <Pill tone="alarm">{muted} mute</Pill>}
      <Pill tone="info">snap {snap?.current ?? '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'digico', label: 'DiGiCo', icon: SlidersHorizontal, Panel: DigicoPanel, Strip: DigicoStrip, panelSize: { w: 4, h: 4 } })

/* ================================================================= WEATHER */

function WeatherPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'current') as Record<string, unknown> | null
  const t = num(d?.temperatureC), w = num(d?.windMs), g = num(d?.gustMs), r = num(d?.precipitationMm), h = num(d?.humidityPct)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 grid place-items-center">
        <div className="text-center">
          <div className="text-[clamp(2rem,14cqw,4rem)] font-bold tabular-nums leading-none">{t != null ? t.toFixed(0) : '—'}<span className="text-[0.35em] text-muted-foreground">°C</span></div>
          <div className="text-[12px] text-muted-foreground mt-1">{(d?.location as string) ?? ''}</div>
          <div className="flex gap-4 justify-center text-[12px] mt-2 tabular-nums flex-wrap">
            <span>wind <b>{w != null ? w.toFixed(0) : '—'}</b> <span className="text-muted-foreground">m/s</span></span>
            {g != null && <span>gust <b>{g.toFixed(0)}</b></span>}
            {h != null && <span>hum <b>{h.toFixed(0)}</b>%</span>}
            {r != null && r > 0 && <span className="text-info">rain <b>{r.toFixed(1)}</b>mm</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
function WeatherStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'current') as Record<string, unknown> | null
  const t = num(d?.temperatureC), w = num(d?.windMs)
  return (
    <Frame icon={CloudSun} label={title}>
      {w != null && <Pill>{w.toFixed(0)} m/s</Pill>}
      <Pill tone="info">{t != null ? `${t.toFixed(0)}°C` : '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'weather', label: 'Weather', icon: CloudSun, Panel: WeatherPanel, Strip: WeatherStrip, panelSize: { w: 3, h: 3 } })

/* ================================================================ NETCHECK */

function NetcheckPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'latency') as Record<string, unknown> | null
  const up = d?.up === true, rtt = num(d?.rttAvgMs), loss = num(d?.lossPct), jit = num(d?.jitterMs)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 grid place-items-center">
        <div className="text-center">
          <div className={cn('text-[clamp(1rem,7cqw,1.8rem)] font-bold uppercase', d?.up == null ? 'text-muted-foreground' : up ? 'text-live' : 'text-destructive')}>{d?.up == null ? '—' : up ? 'Up' : 'Down'}</div>
          <div className="flex gap-4 justify-center text-[12px] mt-2 tabular-nums flex-wrap">
            <span>{rtt != null ? rtt.toFixed(0) : '—'} <span className="text-muted-foreground">ms</span></span>
            {jit != null && <span className="text-muted-foreground">±{jit.toFixed(0)}</span>}
            {loss != null && loss > 0 && <span className="text-busy">{loss.toFixed(0)}% loss</span>}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1 font-mono">{(d?.method as string) ?? ''}</div>
        </div>
      </div>
    </div>
  )
}
function NetcheckStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'latency') as Record<string, unknown> | null
  const up = d?.up === true, rtt = num(d?.rttAvgMs)
  return (
    <Frame icon={Activity} label={title}>
      {rtt != null && <Pill>{rtt.toFixed(0)} ms</Pill>}
      <Pill tone={d?.up == null ? 'muted' : up ? 'live' : 'alarm'}>{d?.up == null ? '—' : up ? 'up' : 'down'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'netcheck', label: 'Connection', icon: Activity, Panel: NetcheckPanel, Strip: NetcheckStrip, panelSize: { w: 3, h: 2 } })

/* ================================================================== SYSMON */

function SysGauge({ label, value, warn = 85 }: { label: string; value: number | null; warn?: number }) {
  const p = value == null ? 0 : Math.max(0, Math.min(1, value / 100))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]"><span className="text-muted-foreground uppercase tracking-wide">{label}</span><span className="tabular-nums font-semibold">{value != null ? value.toFixed(0) : '—'}%</span></div>
      <div className="h-2 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full', value != null && value > warn ? 'bg-destructive' : value != null && value > warn * 0.8 ? 'bg-busy' : 'bg-live')} style={{ width: `${p * 100}%` }} /></div>
    </div>
  )
}
function SysmonPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'metrics') as Record<string, unknown> | null
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-2.5 px-3 pb-2">
        <SysGauge label="CPU" value={num(d?.cpuPct)} />
        <SysGauge label="Memory" value={num(d?.memUsedPct)} />
        <SysGauge label="Disk" value={num(d?.diskUsedPct)} warn={90} />
        {num(d?.batteryPct) != null && <SysGauge label="Battery" value={num(d?.batteryPct)} warn={100} />}
      </div>
    </div>
  )
}
function SysmonStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'metrics') as Record<string, unknown> | null
  const cpu = num(d?.cpuPct), mem = num(d?.memUsedPct)
  return (
    <Frame icon={Cpu} label={title}>
      <Pill tone={mem != null && mem > 85 ? 'alarm' : 'muted'}>M {mem != null ? mem.toFixed(0) : '—'}%</Pill>
      <Pill tone={cpu != null && cpu > 85 ? 'alarm' : 'muted'}>C {cpu != null ? cpu.toFixed(0) : '—'}%</Pill>
    </Frame>
  )
}
connector({ typeId: 'sysmon', label: 'Computer', icon: Cpu, Panel: SysmonPanel, Strip: SysmonStrip, panelSize: { w: 3, h: 3 } })

/* ================================================================= PRODCOM */

interface FeedMsg { id: string; text: string; at: number; channel: string; colour: string | null; live?: boolean; redacted?: boolean; flags?: { keyword: string; colour?: string | null }[] }
function CommsTranscript({ instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, 'feed') as { messages?: FeedMsg[] } | null
  const msgs = data?.messages ?? []
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight })
  const onScroll = () => { const el = ref.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div ref={ref} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-1">
        {msgs.length === 0 && <div className="text-muted-foreground/40 text-[11px]">No traffic yet…</div>}
        {msgs.map((m) => (
          <div key={m.id} className={cn('text-[12px] leading-snug', m.live && 'opacity-55 italic')}>
            <span className="font-semibold" style={{ color: m.colour ?? undefined }}>{m.channel}</span>
            <span className="text-muted-foreground/40 text-[10px] ml-1.5 tabular-nums">{fmtTime(m.at)}</span>
            <span className="ml-2 text-foreground/90">{m.redacted ? '████████' : m.text}</span>
            {m.flags?.map((f, i) => (
              <span key={i} className="ml-1.5 text-[9px] font-bold uppercase rounded px-1 py-px align-middle" style={{ background: (f.colour ?? '#888') + '33', color: f.colour ?? undefined }}>{f.keyword}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
function CommsStrip({ instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, 'feed') as { messages?: FeedMsg[] } | null
  const msgs = data?.messages ?? []
  const last = msgs[msgs.length - 1]
  const flagged = msgs.filter((m) => (m.flags?.length ?? 0) > 0).length
  return (
    <Frame icon={MessageSquare} label={title}>
      {flagged > 0 && <Pill tone="busy">{flagged} ⚑</Pill>}
      {last && <span className="text-[11px] truncate"><span className="font-semibold" style={{ color: last.colour ?? undefined }}>{last.channel}</span> <span className="text-muted-foreground">{last.redacted ? '████' : last.text}</span></span>}
    </Frame>
  )
}
connector({ typeId: 'prodcom', label: 'Comms', icon: MessageSquare, Panel: CommsTranscript, Strip: CommsStrip, panelSize: { w: 5, h: 5 } })

/** ProdCom call-outs — an additional instance panel (just the flagged lines). */
function CommsCallouts({ instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, 'feed') as { messages?: FeedMsg[] } | null
  const flagged = (data?.messages ?? []).filter((m) => (m.flags?.length ?? 0) > 0)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-1.5">
        {flagged.length === 0 && <div className="text-muted-foreground/40 text-[11px]">No call-outs.</div>}
        {flagged.slice(-12).reverse().map((m) => (
          <div key={m.id} className="text-[12px] leading-snug">
            <div className="flex items-center gap-1.5">
              {m.flags?.map((f, i) => <span key={i} className="text-[9px] font-bold uppercase rounded px-1 py-px" style={{ background: (f.colour ?? '#888') + '33', color: f.colour ?? undefined }}>{f.keyword}</span>)}
              <span className="text-muted-foreground/40 text-[10px] ml-auto tabular-nums">{fmtTime(m.at)}</span>
            </div>
            <div className="text-foreground/90 mt-0.5"><span className="font-semibold" style={{ color: m.colour ?? undefined }}>{m.channel}:</span> {m.redacted ? '████' : m.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
registerWidget({ type: 'prodcom-callouts', label: 'Comms · call-outs', supportedTypeIds: ['prodcom'], defaultSize: { w: 4, h: 4 }, Component: CommsCallouts })

/* ==================================================================== ATEM */

function AtemPanel({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'program') as { program?: number; preview?: number; connected?: boolean; simulated?: boolean } | null
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-3 px-4 pb-2">
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wide text-destructive w-16">Program</span>
          <span className="text-[30px] font-bold tabular-nums text-destructive leading-none">{d?.program != null ? d.program : '—'}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wide text-live w-16">Preview</span>
          <span className="text-[30px] font-bold tabular-nums text-live leading-none">{d?.preview != null ? d.preview : '—'}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">{d?.connected ? (d?.simulated ? 'simulator' : 'connected') : 'offline'}</div>
      </div>
    </div>
  )
}
function AtemStrip({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'program') as { program?: number; preview?: number; connected?: boolean } | null
  return (
    <Frame icon={Video} label={title} tint={d?.connected ? undefined : 'text-muted-foreground/40'}>
      <Pill tone="live">PV {d?.preview ?? '—'}</Pill>
      <Pill tone="alarm">PGM {d?.program ?? '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'atem', label: 'ATEM', icon: Video, Panel: AtemPanel, Strip: AtemStrip, panelSize: { w: 3, h: 3 } })

/* ============================================ PLATFORM (any / all connectors) */

function StatusRow({ id, name }: { id: string; name: string }) {
  const st = (useTopic(statusTopic(id)) as { state?: string } | null)?.state ?? 'connecting'
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={cn('size-2 rounded-full shrink-0', DOT[st] ?? 'bg-busy')} />
      <span className="text-[12px] truncate">{name}</span>
      <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{st}</span>
    </div>
  )
}
function StatusBoard({ instances = [], title }: WidgetProps) {
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 divide-y divide-border/40">
        {instances.map((i) => <StatusRow key={i.id} id={i.id} name={i.name} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'status-board', label: 'Connections status', multi: 'all', defaultSize: { w: 3, h: 5 }, Component: StatusBoard })
