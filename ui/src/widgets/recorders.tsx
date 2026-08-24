'use client'
import { useState, useEffect, useRef } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useStream, useTopic } from '@/hooks/use-topic'
import { usePulseOn, useDanger, dangerHigh, dangerLow } from '@/components/surfaces/pulse'
import { cn } from '@/lib/utils'
import { Circle, Play, HardDrive, Film, Video, Music } from 'lucide-react'

export interface Recorder { id: string; label: string; instanceId: string; typeId: string; role: 'record' | 'playback' }

/** Short "time left" label: 2.1h / 12:30. */
function shortLeft(sec?: number | null): string | null {
  if (sec == null) return null
  const s = Math.max(0, Math.round(sec))
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtHMS(sec?: number | null): string | null {
  if (sec == null) return null
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** A HyperDeck only reports timecode when polled (~2s), so the raw value steps
 *  in 2s jumps while playing. Tick it forward locally between updates for a
 *  smooth clock, snapping to each real value as it arrives (so a loop that wraps
 *  the timecode just snaps back cleanly). Frames are dropped — HH:MM:SS. */
function useTickingTimecode(raw: string | undefined, live: boolean): string | undefined {
  const base = useRef<{ sec: number; at: number } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    const m = raw ? /(\d+):(\d+):(\d+)/.exec(raw) : null
    base.current = m ? { sec: +m[1] * 3600 + +m[2] * 60 + +m[3], at: Date.now() } : null
    tick((v) => v + 1)
  }, [raw])
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((v) => v + 1), 250)
    return () => clearInterval(id)
  }, [live])
  if (!base.current) return raw
  const total = base.current.sec + (live ? Math.max(0, Math.floor((Date.now() - base.current.at) / 1000)) : 0)
  const h = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

type ToneKey = 'rec' | 'play' | 'idle' | 'off'
interface Gauge { frac: number; label: string; warn: boolean }
interface Norm {
  icon: React.ElementType; statusLabel: string; tone: ToneKey
  big?: string | null; format?: string | null; sub?: string | null; gauge?: Gauge | null
}
const TONE_BG: Record<ToneKey, string> = {
  rec: 'border-destructive/60 bg-destructive/[0.09] shadow-[0_0_20px_-8px_var(--destructive)]',
  play: 'border-live/45 bg-live/[0.06]',
  idle: 'border-border/60 bg-card',
  off: 'border-border/40 bg-card/50',
}
const STATUS_PILL: Record<ToneKey, string> = {
  rec: 'bg-destructive text-white', play: 'bg-live text-black', idle: 'bg-muted/70 text-muted-foreground', off: 'bg-muted/50 text-muted-foreground/60',
}
const ACCENT: Record<ToneKey, string> = { rec: 'var(--destructive)', play: 'var(--live)', idle: 'var(--border)', off: 'var(--border)' }

const timeGauge = (sec?: number | null): Gauge | null => sec == null ? null
  : { frac: Math.min(1, sec / 14400), label: `${shortLeft(sec)} left`, warn: sec < 300 }

/** Presentational card shared by all recorder types. */
function Shell({ rec, n }: { rec: Recorder; n: Norm }) {
  const Icon = n.icon
  return (
    <div className={cn('relative overflow-hidden rounded-lg border pl-2.5 pr-2 py-1.5 flex flex-col gap-1', TONE_BG[n.tone], n.tone === 'off' && 'opacity-55')}>
      <span className={cn('absolute left-0 top-0 bottom-0 w-0.5', n.tone === 'rec' && 'animate-pulse')} style={{ background: ACCENT[n.tone] }} />
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('inline-flex items-center gap-1 text-[8.5px] font-black uppercase tracking-wider rounded px-1 py-0.5 shrink-0', STATUS_PILL[n.tone])}>
          {n.tone === 'rec' && <span className="size-1 rounded-full bg-current animate-pulse" />}{n.statusLabel}
        </span>
        <span className="text-[11px] font-bold truncate">{rec.label}</span>
        <span className="ml-auto shrink-0 text-[7px] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">{rec.role}</span>
      </div>
      <div className={cn('text-[16px] font-black font-mono tabular-nums leading-none tracking-tight', n.tone === 'rec' ? 'text-destructive' : n.tone === 'play' ? 'text-live' : 'text-foreground/85')}>{n.big || '––:––:––'}</div>
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground min-w-0">
        <Icon className="size-2.5 shrink-0" />
        <span className="truncate">{[n.format, n.sub].filter(Boolean).join(' · ') || (n.tone === 'off' ? 'offline' : '—')}</span>
      </div>
      {n.gauge && (
        <div className="flex items-center gap-1.5">
          <HardDrive className="size-2.5 text-muted-foreground/50 shrink-0" />
          <div className="flex-1 h-1 rounded-full bg-muted/40 overflow-hidden">
            <div className={cn('h-full rounded-full transition-[width] duration-500', n.gauge.warn ? 'bg-destructive' : n.gauge.frac < 0.25 ? 'bg-busy' : 'bg-live')} style={{ width: `${Math.max(3, n.gauge.frac * 100)}%` }} />
          </div>
          <span className={cn('text-[8.5px] font-semibold tabular-nums shrink-0', n.gauge.warn && 'text-destructive')}>{n.gauge.label}</span>
        </div>
      )}
    </div>
  )
}

function HyperdeckRec({ rec }: { rec: Recorder }) {
  const t = useStream(rec.instanceId, 'transport') as { status?: string; displayTimecode?: string; timecode?: string } | null
  const slot = useStream(rec.instanceId, 'slots') as { recordingTimeSeconds?: number; videoFormat?: string; volumeName?: string } | null
  const dev = useStream(rec.instanceId, 'device') as { model?: string } | null
  usePulseOn(t?.status)
  useDanger(dangerLow(slot?.recordingTimeSeconds ?? null, 1800, 300))
  const s = (t?.status ?? '').toLowerCase()
  const recording = s === 'record'
  const playing = /play|forward|jog|shuttle|var/.test(s)
  const tone: ToneKey = t == null ? 'off' : recording ? 'rec' : playing ? 'play' : 'idle'
  // Tick the timecode locally while moving so it doesn't leap 2s at the poll rate.
  const big = useTickingTimecode(t?.displayTimecode || t?.timecode, recording || playing)
  const n: Norm = {
    icon: Film, tone,
    statusLabel: t == null ? 'OFFLINE' : recording ? 'REC' : playing ? 'PLAY' : (s ? s.toUpperCase() : 'STOP'),
    big,
    format: slot?.videoFormat || dev?.model,
    sub: slot?.volumeName,
    gauge: rec.role === 'record' ? timeGauge(slot?.recordingTimeSeconds) : null,
  }
  return <Shell rec={rec} n={n} />
}

function ReaperRec({ rec }: { rec: Recorder }) {
  const t = useStream(rec.instanceId, 'transport') as { state?: string; positionString?: string; armedCount?: number } | null
  const disk = useStream(rec.instanceId, 'disk') as { freeMb?: number } | null
  usePulseOn(t?.state)
  useDanger(dangerLow(disk?.freeMb ?? null, 8000, 2000))
  const st = (t?.state ?? '').toLowerCase()
  const recording = st === 'recording'
  const playing = st === 'playing'
  const tone: ToneKey = t == null ? 'off' : recording ? 'rec' : playing ? 'play' : 'idle'
  const freeGb = disk?.freeMb != null ? disk.freeMb / 1000 : null
  const n: Norm = {
    icon: Music, tone,
    statusLabel: t == null ? 'OFFLINE' : recording ? 'REC' : playing ? 'PLAY' : 'STOP',
    big: t?.positionString,
    format: (t?.armedCount ?? 0) > 0 ? `${t?.armedCount} armed` : 'session',
    gauge: freeGb != null ? { frac: Math.min(1, freeGb / 500), label: `${freeGb.toFixed(0)} GB`, warn: freeGb < 10 } : null,
  }
  return <Shell rec={rec} n={n} />
}

function AtemRec({ rec }: { rec: Recorder }) {
  const r = useStream(rec.instanceId, 'recording') as { state?: string; durationSeconds?: number; timeAvailableSeconds?: number; volumeName?: string } | null
  const recording = r?.state === 'recording' || r?.state === 'stopping'
  usePulseOn(r?.state)
  useDanger(dangerLow(r?.timeAvailableSeconds ?? null, 1800, 300))
  const tone: ToneKey = r == null ? 'off' : recording ? 'rec' : 'idle'
  const n: Norm = {
    icon: Video, tone,
    statusLabel: r == null ? 'OFFLINE' : recording ? 'REC' : 'IDLE',
    big: fmtHMS(r?.durationSeconds),
    format: r?.volumeName || 'ISO record',
    gauge: timeGauge(r?.timeAvailableSeconds),
  }
  return <Shell rec={rec} n={n} />
}

function RecorderCard({ rec }: { rec: Recorder }) {
  if (rec.typeId === 'hyperdeck') return <HyperdeckRec rec={rec} />
  if (rec.typeId === 'reaper') return <ReaperRec rec={rec} />
  if (rec.typeId === 'atem') return <AtemRec rec={rec} />
  return <Shell rec={rec} n={{ icon: Play, tone: 'idle', statusLabel: '—' }} />
}

function SectionHead({ label, n }: { label: string; n: number }) {
  return (
    <div className="col-span-full flex items-center gap-2 pt-1 first:pt-0">
      <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">{label}</span>
      <span className="text-[9px] tabular-nums text-muted-foreground/40">{n}</span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  )
}

/** Record status: every configured record/playback device with its status,
 *  timecode, format and disk time-left. Configure devices in Settings → Recorders. */
function RecordStatus({ title }: WidgetProps) {
  const d = useTopic('feature:recorders') as { recorders?: Recorder[] } | null
  const recorders = d?.recorders ?? []
  const records = recorders.filter((r) => r.role !== 'playback')
  const playback = recorders.filter((r) => r.role === 'playback')
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))] content-start">
        {recorders.length === 0 && <div className="text-[11px] text-muted-foreground/50 p-1">No recorders configured. Add them in Settings → Recorders.</div>}
        {records.length > 0 && <SectionHead label="Recorders" n={records.length} />}
        {records.map((r) => <RecorderCard key={r.id} rec={r} />)}
        {playback.length > 0 && <SectionHead label="Playback" n={playback.length} />}
        {playback.map((r) => <RecorderCard key={r.id} rec={r} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'record-status', label: 'Record status', defaultSize: { w: 6, h: 4 }, Component: RecordStatus })
