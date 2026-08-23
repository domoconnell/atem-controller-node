'use client'
import { useEffect, useRef, useState } from 'react'
import { registerWidget, type WidgetDef, type WidgetProps } from './registry'
import { useStream, useTopic } from '@/hooks/use-topic'
import { usePulseOn, useDanger, dangerHigh, dangerLow } from '@/components/surfaces/pulse'
import { statusTopic } from '@/lib/topics'
import { cn } from '@/lib/utils'
import { ReceiverCard } from './mics'
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

/** One receiver's channels as tinted status cards (shared with the mics look). */
function ReceiverCards({ id, name }: { id: string; name: string }) {
  const d = useStream(id, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const chans = d?.channels ?? []
  const online = !!d?.online
  usePulseOn(chans.map((c) => (c.mute ? '1' : '0')).join('') + (online ? 'o' : 'x'))
  useDanger(!online ? 0.4 : dangerLow(chans.reduce((m, c) => (c.battery != null && c.battery < m ? c.battery : m), 999), 50, 15))
  if (chans.length === 0) return <ReceiverCard ch={{ id: 'x' }} online={false} name={name} />
  return <>{chans.map((ch) => <ReceiverCard key={ch.id} ch={ch} online={online} name={chans.length > 1 ? `${name} · ${ch.id}` : name} />)}</>
}
function MicPanel({ instanceId, title }: WidgetProps) {
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start">
        <ReceiverCards id={instanceId ?? ''} name={title || 'Receiver'} />
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
  usePulseOn(chans.map((c) => (c.mute ? '1' : '0')).join('') + (d?.online ? 'o' : 'x'))
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
      <div className="flex-1 min-h-0 overflow-y-auto p-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start">
        {instances.length === 0 && <div className="text-[11px] text-muted-foreground/50">No receivers.</div>}
        {instances.map((i) => <ReceiverCards key={i.id} id={i.id} name={i.name} />)}
      </div>
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
  usePulseOn(viol)
  useDanger(Math.max(viol > 0 ? 1 : 0, dangerHigh(num(d?.splAFast), 95, 103)))
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
  usePulseOn(splTone(a))
  return (
    <Frame icon={Volume2} label={title}>
      {leq != null && <Pill>LAeq {leq.toFixed(0)}</Pill>}
      <Pill tone={splTone(a)}>{a != null ? `${a.toFixed(1)} dB` : '—'}</Pill>
    </Frame>
  )
}
connector({ typeId: 'smaart', label: 'SPL', icon: Volume2, Panel: SmaartPanel, Strip: SmaartStrip, panelSize: { w: 4, h: 3 } })

/** Live 1/3-octave RTA spectrum with a selectable input. */
interface SpectrumInput { id: string; name: string; magnitudes: number[] }
const SPEC_MIN = 40, SPEC_MAX = 100  // dB display range
function specBarColor(db: number): string {
  const t = Math.max(0, Math.min(1, (db - 60) / 38))      // 60→green … 98→red
  return `hsl(${Math.round(140 - t * 140)} 80% 55%)`
}
const fLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`)
function SmaartSpectrum({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'spectrum') as { freqs?: number[]; inputs?: SpectrumInput[]; weighting?: string; octaveFraction?: number } | null
  const inputs = d?.inputs ?? []
  const freqs = d?.freqs ?? []
  const [sel, setSel] = useState<string>('')
  useEffect(() => { if ((!sel || !inputs.some((i) => i.id === sel)) && inputs[0]) setSel(inputs[0].id) }, [inputs, sel])
  const cur = inputs.find((i) => i.id === sel) ?? inputs[0]
  const mags = cur?.magnitudes ?? []
  usePulseOn(inputs.map((i) => i.id).join())
  const norm = (db: number) => Math.max(0, Math.min(1, (db - SPEC_MIN) / (SPEC_MAX - SPEC_MIN)))
  const labelIdx = [7, 12, 17, 22, 27].filter((i) => i < freqs.length)  // 100 / 315 / 1k / 3.15k / 10k
  return (
    <div className="h-full flex flex-col p-1.5">
      <div className="shrink-0 flex items-center gap-2 px-3 pt-1.5 pb-2">
        {title && <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground truncate">{title}</span>}
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">RTA{d?.octaveFraction ? ` · 1/${d.octaveFraction}` : ''}{d?.weighting ? ` · ${d.weighting}` : ''}</span>
        <select value={cur?.id ?? ''} onChange={(e) => setSel(e.target.value)} className="ml-auto bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[11px] max-w-[45%] truncate">
          {inputs.length === 0 && <option value="">no input</option>}
          {inputs.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </div>
      <div className="flex-1 min-h-0 relative px-3 pb-7 pt-1">
        {/* dB gridlines */}
        {[60, 80, 100].map((db) => (
          <div key={db} className="absolute left-3 right-3 border-t border-border/25 flex" style={{ bottom: `calc(${norm(db) * 100}% + 28px)` }}>
            <span className="text-[7px] text-muted-foreground/40 -mt-2 ml-0.5 tabular-nums">{db}</span>
          </div>
        ))}
        <div className="absolute inset-x-3 top-1 bottom-7 flex items-end gap-[2px]">
          {mags.length === 0 ? <div className="text-[11px] text-muted-foreground/50 m-auto">No spectrum.</div> : mags.map((db, i) => (
            <div key={i} className="flex-1 min-w-0 rounded-t-[1px] transition-[height] duration-100"
              style={{ height: `${norm(db) * 100}%`, background: specBarColor(db) }}
              title={`${fLabel(freqs[i])} Hz · ${db.toFixed(1)} dB`} />
          ))}
        </div>
        {/* frequency axis */}
        <div className="absolute inset-x-3 bottom-1.5 h-5 pointer-events-none">
          {labelIdx.map((i) => (
            <span key={i} className="absolute text-[8px] text-muted-foreground/50 tabular-nums -translate-x-1/2" style={{ left: `${(i / (freqs.length - 1)) * 100}%`, bottom: 0 }}>{fLabel(freqs[i])}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
registerWidget({ type: 'smaart-spectrum', label: 'SPL · spectrum (RTA)', supportedTypeIds: ['smaart'], defaultSize: { w: 6, h: 4 }, Component: SmaartSpectrum })

/* ================================================================== DIGICO */
type DgCh = { channel: number; name: string | null; muted: boolean | null; faderDb: number | null; stereo: boolean | null; inputType: number | null }
type DgMeter = { channel: number; l: number; r: number; lp: number; rp: number }
/** Channels actually in use: patched (input_type ≠ 0) or renamed off default. */
function dgInUse(channels?: DgCh[]): DgCh[] {
  return (channels ?? []).filter((c) => (c.inputType != null && c.inputType !== 0) || (c.name && !/^Ch \d+$/.test(c.name))).sort((a, b) => a.channel - b.channel)
}
/** Parse a channel-range string ("1-16", "1,2,5-8") to channel numbers; blank
 *  defaults to 1..fallback (the first N channels). */
function dgParseChannels(str: string | undefined, fallback = 32): number[] {
  if (!str || !str.trim()) return Array.from({ length: fallback }, (_, i) => i + 1)
  const out = new Set<number>()
  for (const part of str.split(',')) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i) }
    else { const n = Number(part.trim()); if (n > 0) out.add(n) }
  }
  return [...out].sort((a, b) => a - b)
}
/** Resolve the selected channel numbers against the live scan (unscanned ones
 *  become mono placeholders so the layout is stable while the scan fills in). */
function dgSelected(config: Record<string, unknown>, channels?: DgCh[]): DgCh[] {
  const byNum = new Map((channels ?? []).map((c) => [c.channel, c]))
  return dgParseChannels(config.channels as string | undefined).map(
    (n) => byNum.get(n) ?? { channel: n, name: null, muted: null, faderDb: null, stereo: false, inputType: null },
  )
}
/** dB (−60..0) → fill height %. −Infinity / off → 0. */
function dgPct(db: number): number { if (db == null || db === -Infinity) return 0; return Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) }
/** One vertical meter bar: a green→amber→red scale revealed up to the level,
 *  with a thin peak-hold line (the console's fast level + slow peak). */
function DgBar({ db, peak }: { db: number; peak?: number }) {
  const pct = dgPct(db)
  const pk = peak != null ? dgPct(peak) : null
  return (
    <div className="relative w-2.5 flex-1 min-h-0 rounded-sm overflow-hidden bg-muted/30">
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, var(--live) 0%, var(--live) 62%, var(--busy) 80%, var(--destructive) 100%)' }} />
      {/* Linear, ~one-frame transition: smooths between updates without lagging. */}
      <div className="absolute inset-x-0 top-0 bg-card transition-[height] duration-40 ease-linear" style={{ height: `${100 - pct}%` }} />
      {pk != null && pk > 0 ? <div className="absolute inset-x-0 h-px bg-foreground/80" style={{ bottom: `${pk}%` }} /> : null}
    </div>
  )
}
/** Live input meters from a DiGiCo. Which channels show is a widget setting
 *  ("Channels" — a range like 1-16, blank = first 32); each is drawn from the
 *  channel scan (name, mono/stereo). */
function DigicoMeters({ instanceId, title, config }: WidgetProps) {
  // Structure (name, mono/stereo) comes from the channel scan; levels come from
  // the meter stream, keyed by channel (L/R legs). Only channels currently metered
  // by a connected iPad/controller carry a level; the rest sit at the floor.
  const cfg = useStream(instanceId, 'channels') as { channels?: DgCh[] } | null
  const met = useStream(instanceId, 'meters') as { meters?: DgMeter[] } | null
  const channels = dgSelected(config, cfg?.channels)
  const byCh = new Map((met?.meters ?? []).map((m) => [m.channel, m]))
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 flex items-stretch gap-3 px-3 py-2 overflow-x-auto">
        {/* dB scale */}
        <div className="shrink-0 flex flex-col justify-between py-1 text-[8px] text-muted-foreground/50 tabular-nums text-right">
          {[0, -12, -24, -36, -48, -60].map((v) => <span key={v}>{v}</span>)}
        </div>
        {channels.map((c) => {
          const m = byCh.get(c.channel)
          const a = m?.l ?? -Infinity
          const b = m?.r ?? -Infinity
          const ap = m?.lp ?? -Infinity
          const bp = m?.rp ?? -Infinity
          return (
            <div key={c.channel} className="shrink-0 flex flex-col items-center gap-1 min-w-0">
              <span className={cn('text-[8px] font-black uppercase tracking-wider rounded px-1 py-0.5', c.stereo ? 'bg-info/15 text-info' : 'bg-muted/60 text-muted-foreground')}>{c.stereo ? 'ST' : 'M'}</span>
              <div className="flex-1 min-h-0 flex gap-0.5">
                {c.stereo ? <><DgBar db={a} peak={ap} /><DgBar db={b} peak={bp} /></> : <DgBar db={a} peak={ap} />}
              </div>
              <span className="text-[9px] text-muted-foreground truncate max-w-[3.5rem]" title={c.name ?? `Ch ${c.channel}`}>{c.name || `Ch ${c.channel}`}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
registerWidget({ type: 'digico-meters', label: 'DiGiCo · meters', supportedTypeIds: ['digico'], defaultSize: { w: 4, h: 4 }, configFields: [{ key: 'channels', label: 'Channels (e.g. 1-16; blank = first 32)', kind: 'text' }], Component: DigicoMeters })

/** The console's input-channel list: name, mono/stereo, patched, mute + fader.
 *  This is the channel map the meters get mapped onto. */
function DigicoChannels({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'channels') as { channels?: DgCh[] } | null
  const rows = dgInUse(d?.channels)
  const fmtFader = (db: number | null) => (db == null ? '' : db <= -150 || db === -Infinity ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`)
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 space-y-0.5">
        {rows.length === 0 ? <div className="text-[11px] text-muted-foreground/50 px-2 py-3 text-center">No channels scanned yet.<br />Connect the console.</div> : rows.map((c) => (
          <div key={c.channel} className="flex items-center gap-2 rounded-md px-2 py-1 bg-card border border-border/40">
            <span className="shrink-0 w-6 text-[10px] font-mono text-muted-foreground/60 text-right tabular-nums">{c.channel}</span>
            <span className={cn('shrink-0 text-[8px] font-black uppercase tracking-wider rounded px-1 py-0.5', c.stereo ? 'bg-info/15 text-info' : 'bg-muted/60 text-muted-foreground')}>{c.stereo ? 'ST' : 'M'}</span>
            <span className="flex-1 min-w-0 truncate text-[12px] font-medium">{c.name || `Ch ${c.channel}`}</span>
            {c.muted ? <span className="shrink-0 text-[8px] font-bold uppercase text-destructive">mute</span> : null}
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70 w-12 text-right">{fmtFader(c.faderDb)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
registerWidget({ type: 'digico-channels', label: 'DiGiCo · channels', supportedTypeIds: ['digico'], defaultSize: { w: 4, h: 5 }, Component: DigicoChannels })

/* ==================================================================== QLAB */

interface RunCue { id: string; name: string; elapsed: number; remaining: number; percent: number }
function QlabPanel({ instanceId, title }: WidgetProps) {
  const head = useStream(instanceId, 'playhead') as { name?: string | null } | null
  const run = useStream(instanceId, 'running') as { cues?: RunCue[] } | null
  usePulseOn(head?.name)
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
  usePulseOn(head?.name)
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
  usePulseOn(t?.state)
  useDanger(dangerLow(num(disk?.freeMb), 8000, 2000))
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
  usePulseOn(t?.state)
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
  usePulseOn(t?.status)
  useDanger(dangerLow(num(slot?.recordingTimeSeconds), 1800, 300))
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
  usePulseOn(t?.status)
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
  usePulseOn(slide?.current)
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
  usePulseOn(active?.state)
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
  usePulseOn(`${s?.onlineCount ?? ''}/${s?.deviceCount ?? ''}`)
  useDanger(dangerHigh((s?.deviceCount ?? 0) - (s?.onlineCount ?? 0), 0.5, 2))
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
  usePulseOn(`${s?.onlineCount ?? ''}/${s?.deviceCount ?? ''}`)
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
  usePulseOn(chans.map((x) => (x.muted ? '1' : '0')).join('') + '|' + (snap?.current ?? ''))
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
  usePulseOn(muted + '|' + (snap?.current ?? ''))
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
  usePulseOn(t)
  useDanger(Math.max(dangerHigh(g, 12, 20), dangerHigh(w, 10, 16)))
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
  usePulseOn(t)
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
  usePulseOn(d?.up)
  useDanger(d?.up === false ? 1 : dangerHigh(loss, 2, 10))
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
  usePulseOn(d?.up)
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
  usePulseOn([num(d?.cpuPct), num(d?.memUsedPct), num(d?.diskUsedPct)].map((v, i) => (v != null && v > (i === 2 ? 90 : 85) ? '1' : '0')).join(''))
  useDanger(Math.max(dangerHigh(num(d?.cpuPct), 80, 98), dangerHigh(num(d?.memUsedPct), 85, 98), dangerHigh(num(d?.diskUsedPct), 85, 97)))
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
  usePulseOn((cpu != null && cpu > 85 ? '1' : '0') + (mem != null && mem > 85 ? '1' : '0'))
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
  usePulseOn(msgs[msgs.length - 1]?.id)
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
  usePulseOn(last?.id)
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
  usePulseOn(flagged[flagged.length - 1]?.id)
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
  usePulseOn(d?.program)
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
  usePulseOn(d?.program)
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
  usePulseOn(st)
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
