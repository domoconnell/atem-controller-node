'use client'
import { registerWidget, type WidgetProps } from './registry'
import { useStream, useTopic } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { Circle, Play, HardDrive, Film, Video, Music } from 'lucide-react'

export interface Recorder { id: string; label: string; instanceId: string; typeId: string; role: 'record' | 'playback' }

function fmtLeft(sec?: number | null): string | null {
  if (sec == null) return null
  const s = Math.max(0, Math.round(sec))
  if (s >= 3600) return `${(s / 3600).toFixed(1)} hr left`
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')} left`
}
function fmtHMS(sec?: number | null): string | null {
  if (sec == null) return null
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

type ToneKey = 'rec' | 'play' | 'idle' | 'off'
interface Norm {
  icon: React.ElementType; statusLabel: string; tone: ToneKey
  big?: string | null; format?: string | null; diskText?: string | null; diskWarn?: boolean
}
const TONE_BG: Record<ToneKey, string> = {
  rec: 'border-destructive/55 bg-destructive/[0.08]',
  play: 'border-live/45 bg-live/[0.06]',
  idle: 'border-border/60 bg-card',
  off: 'border-border/40 bg-card/60',
}
const STATUS_PILL: Record<ToneKey, string> = {
  rec: 'bg-destructive text-white', play: 'bg-live text-black', idle: 'bg-muted/70 text-muted-foreground', off: 'bg-muted/50 text-muted-foreground/60',
}

/** Presentational card shared by all recorder types. */
function Shell({ rec, n }: { rec: Recorder; n: Norm }) {
  const Icon = n.icon
  return (
    <div className={cn('rounded-lg border p-2.5 flex flex-col gap-1.5', TONE_BG[n.tone], n.tone === 'off' && 'opacity-60')}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('inline-flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0', STATUS_PILL[n.tone])}>
          {n.tone === 'rec' && <Circle className="size-1.5 fill-current animate-pulse" />}{n.statusLabel}
        </span>
        <span className="text-[13px] font-bold truncate">{rec.label}</span>
        <span className="ml-auto shrink-0 text-[8px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">{rec.role}</span>
      </div>
      <div className={cn('text-[22px] font-bold font-mono tabular-nums leading-none', n.tone === 'rec' ? 'text-destructive' : n.tone === 'play' ? 'text-live' : 'text-foreground/90')}>{n.big || '––:––:––'}</div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground border-t border-border/30 pt-1">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{n.format || (n.tone === 'off' ? 'offline' : '')}</span>
        {n.diskText && <span className={cn('ml-auto inline-flex items-center gap-1 shrink-0 tabular-nums', n.diskWarn && 'text-destructive font-semibold')}><HardDrive className="size-3" />{n.diskText}</span>}
      </div>
    </div>
  )
}

function HyperdeckRec({ rec }: { rec: Recorder }) {
  const t = useStream(rec.instanceId, 'transport') as { status?: string; displayTimecode?: string; timecode?: string } | null
  const slot = useStream(rec.instanceId, 'slots') as { recordingTimeSeconds?: number; videoFormat?: string; volumeName?: string } | null
  const dev = useStream(rec.instanceId, 'device') as { model?: string } | null
  const s = (t?.status ?? '').toLowerCase()
  const recording = s === 'record'
  const playing = /play|forward|jog|shuttle|var/.test(s)
  const tone: ToneKey = t == null ? 'off' : recording ? 'rec' : playing ? 'play' : 'idle'
  const diskLeft = slot?.recordingTimeSeconds
  const n: Norm = {
    icon: Film, tone,
    statusLabel: t == null ? 'OFFLINE' : recording ? 'REC' : playing ? 'PLAY' : (s ? s.toUpperCase() : 'STOP'),
    big: t?.displayTimecode || t?.timecode,
    format: slot?.videoFormat || dev?.model,
    diskText: rec.role === 'record' ? (fmtLeft(diskLeft) || slot?.volumeName) : slot?.volumeName,
    diskWarn: diskLeft != null && diskLeft < 300,
  }
  return <Shell rec={rec} n={n} />
}

function ReaperRec({ rec }: { rec: Recorder }) {
  const t = useStream(rec.instanceId, 'transport') as { state?: string; positionString?: string; armedCount?: number } | null
  const disk = useStream(rec.instanceId, 'disk') as { freeMb?: number } | null
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
    diskText: freeGb != null ? `${freeGb.toFixed(1)} GB free` : null,
    diskWarn: freeGb != null && freeGb < 10,
  }
  return <Shell rec={rec} n={n} />
}

function AtemRec({ rec }: { rec: Recorder }) {
  const r = useStream(rec.instanceId, 'recording') as { state?: string; durationSeconds?: number; timeAvailableSeconds?: number; volumeName?: string } | null
  const recording = r?.state === 'recording' || r?.state === 'stopping'
  const tone: ToneKey = r == null ? 'off' : recording ? 'rec' : 'idle'
  const n: Norm = {
    icon: Video, tone,
    statusLabel: r == null ? 'OFFLINE' : recording ? 'REC' : 'IDLE',
    big: fmtHMS(r?.durationSeconds),
    format: r?.volumeName || 'ISO record',
    diskText: fmtLeft(r?.timeAvailableSeconds),
    diskWarn: r?.timeAvailableSeconds != null && r.timeAvailableSeconds < 300,
  }
  return <Shell rec={rec} n={n} />
}

function RecorderCard({ rec }: { rec: Recorder }) {
  if (rec.typeId === 'hyperdeck') return <HyperdeckRec rec={rec} />
  if (rec.typeId === 'reaper') return <ReaperRec rec={rec} />
  if (rec.typeId === 'atem') return <AtemRec rec={rec} />
  return <Shell rec={rec} n={{ icon: Play, tone: 'idle', statusLabel: '—' }} />
}

/** Record status: every configured record/playback device with its status,
 *  timecode, format and disk time-left. Configure devices in Settings. */
function RecordStatus({ title }: WidgetProps) {
  const d = useTopic('feature:recorders') as { recorders?: Recorder[] } | null
  const recorders = d?.recorders ?? []
  const records = recorders.filter((r) => r.role !== 'playback')
  const playback = recorders.filter((r) => r.role === 'playback')
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(210px,1fr))] content-start">
        {recorders.length === 0 && <div className="text-[11px] text-muted-foreground/50 p-1">No recorders configured. Add them in Settings → Recorders.</div>}
        {records.map((r) => <RecorderCard key={r.id} rec={r} />)}
        {playback.map((r) => <RecorderCard key={r.id} rec={r} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'record-status', label: 'Record status', defaultSize: { w: 6, h: 4 }, Component: RecordStatus })
