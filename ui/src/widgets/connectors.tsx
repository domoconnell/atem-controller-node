'use client'
import { registerWidget, type WidgetProps } from './registry'
import { useStream } from '@/hooks/use-topic'
import { statusTopic } from '@/lib/topics'
import { useTopic } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pct = (v: number | null, min: number, max: number) => v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)))
function Bar({ value, kind = 'af' }: { value: number; kind?: 'af' | 'rf' }) {
  const c = kind === 'rf' ? 'bg-[#2dd4bf]' : value > 0.88 ? 'bg-destructive' : value > 0.7 ? 'bg-busy' : 'bg-live'
  return <div className="h-1.5 flex-1 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full transition-[width] duration-200', c)} style={{ width: `${value * 100}%` }} /></div>
}
function Title({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1">{children}</div>
}

// ---- Sennheiser wireless rack (ALL receivers) ----
interface Ch { id: string; name?: string; frequency?: number; rf?: number | null; af?: number | null; battery?: number | null; ant?: number }
function RxCard({ id, name }: { id: string; name: string }) {
  const d = useStream(id, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const chans = d?.channels ?? []
  return (
    <div className={cn('rounded-lg border border-border/60 p-2 space-y-1.5', !d?.online && 'opacity-40')}>
      {chans.length === 0 && <div className="text-[11px] text-muted-foreground/60">{name}</div>}
      {chans.map((ch) => (
        <div key={ch.id} className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-semibold truncate">{ch.name?.trim() || name}</span>
            <span className="text-[10px] font-mono text-muted-foreground/70">{ch.frequency ? (ch.frequency / 1000).toFixed(3) : ''}</span>
          </div>
          <div className="flex items-center gap-1.5"><span className="text-[8px] w-3 text-muted-foreground">RF</span><Bar value={ch.rf ?? 0} kind="rf" /></div>
          <div className="flex items-center gap-1.5"><span className="text-[8px] w-3 text-muted-foreground">AF</span><Bar value={ch.af ?? 0} /></div>
          <div className="flex items-center justify-between text-[10px]">
            <span className={cn('tabular-nums', ch.battery == null ? 'text-muted-foreground/50' : ch.battery <= 20 ? 'text-destructive' : ch.battery <= 50 ? 'text-busy' : 'text-live')}>{ch.battery != null ? `${ch.battery}%` : 'tx off'}</span>
            {ch.ant ? <span className="text-muted-foreground/60">ant {ch.ant === 1 ? 'A' : 'B'}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
function SennheiserRack({ instances = [], title }: WidgetProps) {
  return (
    <div className="h-full flex flex-col">
      <Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(130px,1fr))] content-start">
        {instances.length === 0 && <div className="text-[11px] text-muted-foreground/50">No receivers.</div>}
        {instances.map((i) => <RxCard key={i.id} id={i.id} name={i.name} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'rf-rack', label: 'Wireless rack (all)', supportedTypeIds: ['sennheiser'], multi: 'type', defaultSize: { w: 6, h: 5 }, Component: SennheiserRack })

// ---- Weather ----
function Weather({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'current') as Record<string, unknown> | null
  const t = num(d?.temperatureC), w = num(d?.windMs), g = num(d?.gustMs), r = num(d?.precipitationMm)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 grid place-items-center">
        <div className="text-center">
          <div className="text-[clamp(2rem,14cqw,4rem)] font-bold tabular-nums leading-none">{t != null ? t.toFixed(0) : '—'}<span className="text-[0.35em] text-muted-foreground">°C</span></div>
          <div className="text-[12px] text-muted-foreground mt-1">{d?.location as string ?? ''}</div>
          <div className="flex gap-4 justify-center text-[12px] mt-2 tabular-nums">
            <span>wind <b>{w != null ? w.toFixed(0) : '—'}</b> <span className="text-muted-foreground">m/s</span></span>
            {g != null && <span>gust <b>{g.toFixed(0)}</b></span>}
            {r != null && r > 0 && <span className="text-info">rain <b>{r.toFixed(1)}</b>mm</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
registerWidget({ type: 'weather', label: 'Weather', supportedTypeIds: ['weather'], defaultSize: { w: 3, h: 3 }, Component: Weather })

// ---- Computer (sysmon) ----
function Gauge({ label, value, unit = '%', warn = 85 }: { label: string; value: number | null; unit?: string; warn?: number }) {
  const p = value == null ? 0 : Math.max(0, Math.min(1, value / 100))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]"><span className="text-muted-foreground uppercase tracking-wide">{label}</span><span className="tabular-nums font-semibold">{value != null ? value.toFixed(0) : '—'}{unit}</span></div>
      <div className="h-2 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full', value != null && value > warn ? 'bg-destructive' : value != null && value > warn * 0.8 ? 'bg-busy' : 'bg-live')} style={{ width: `${p * 100}%` }} /></div>
    </div>
  )
}
function SystemW({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'metrics') as Record<string, unknown> | null
  const disk = num(d?.diskUsedPct)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-2.5 px-3 pb-2">
        <Gauge label="CPU" value={num(d?.cpuPct)} />
        <Gauge label="Memory" value={num(d?.memUsedPct)} />
        <Gauge label="Disk" value={disk} warn={90} />
        {num(d?.batteryPct) != null && <Gauge label="Battery" value={num(d?.batteryPct)} warn={100} />}
      </div>
    </div>
  )
}
registerWidget({ type: 'system', label: 'Computer', supportedTypeIds: ['sysmon'], defaultSize: { w: 3, h: 3 }, Component: SystemW })

// ---- Smaart SPL ----
const SPL_FIELDS = [['splASlow', 'A slow'], ['splAFast', 'A fast'], ['splCSlow', 'C slow'], ['splCFast', 'C fast'], ['laeq1', 'LAeq'], ['peakC', 'Peak C']]
function SplW({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'spl') as Record<string, unknown> | null
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 grid grid-cols-2 gap-x-4 gap-y-1.5 content-start">
        {SPL_FIELDS.map(([f, label]) => {
          const v = num(d?.[f])
          return (
            <div key={f} className="space-y-0.5">
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>{label}</span><span className="tabular-nums font-semibold text-foreground">{v != null ? v.toFixed(1) : '—'}</span></div>
              <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden"><div className={cn('h-full rounded-full', (v ?? 0) > 100 ? 'bg-destructive' : (v ?? 0) > 95 ? 'bg-busy' : 'bg-live')} style={{ width: `${pct(v, 60, 110) * 100}%` }} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
registerWidget({ type: 'spl', label: 'SPL readings', supportedTypeIds: ['smaart'], defaultSize: { w: 4, h: 3 }, Component: SplW })

// ---- Connection check ----
function ConnectionW({ instanceId, title }: WidgetProps) {
  const d = useStream(instanceId, 'latency') as Record<string, unknown> | null
  const up = d?.up === true, rtt = num(d?.rttAvgMs), loss = num(d?.lossPct)
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 grid place-items-center">
        <div className="text-center">
          <div className={cn('text-[clamp(1rem,7cqw,1.8rem)] font-bold uppercase', up ? 'text-live' : 'text-destructive')}>{d?.up == null ? '—' : up ? 'Up' : 'Down'}</div>
          <div className="flex gap-4 justify-center text-[12px] mt-2 tabular-nums">
            <span>{rtt != null ? rtt.toFixed(0) : '—'} <span className="text-muted-foreground">ms</span></span>
            {loss != null && loss > 0 && <span className="text-busy">{loss.toFixed(0)}% loss</span>}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1 font-mono">{d?.host as string ?? ''}</div>
        </div>
      </div>
    </div>
  )
}
registerWidget({ type: 'connection', label: 'Connection', supportedTypeIds: ['netcheck'], defaultSize: { w: 3, h: 2 }, Component: ConnectionW })

// ---- Platform: connections status board (ALL) ----
function StatusRow({ id, name, typeId }: { id: string; name: string; typeId: string }) {
  const st = (useTopic(statusTopic(id)) as { state?: string } | null)?.state ?? 'connecting'
  const dot = st === 'online' ? 'bg-live' : st === 'offline' || st === 'error' ? 'bg-destructive' : 'bg-busy'
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={cn('size-2 rounded-full shrink-0', dot)} />
      <span className="text-[12px] truncate">{name}</span>
      <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{st}</span>
    </div>
  )
}
function StatusBoard({ instances = [], title }: WidgetProps) {
  return (
    <div className="h-full flex flex-col"><Title>{title}</Title>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 divide-y divide-border/40">
        {instances.map((i) => <StatusRow key={i.id} id={i.id} name={i.name} typeId={i.typeId} />)}
      </div>
    </div>
  )
}
registerWidget({ type: 'status-board', label: 'Connections status', multi: 'all', defaultSize: { w: 3, h: 5 }, Component: StatusBoard })
