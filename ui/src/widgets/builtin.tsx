'use client'
import { registerWidget, type WidgetProps } from './registry'
import { useStream } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Big single number from any connector field. */
function StatWidget({ config, instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, String(config.stream ?? '')) as Record<string, unknown> | null
  const raw = data?.[String(config.field ?? '')]
  const v = num(raw)
  return (
    <div className="h-full flex flex-col justify-center items-center text-center px-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground truncate w-full">{title}</div>
      <div className="text-[clamp(1.5rem,7cqw,3rem)] font-bold tabular-nums leading-none mt-1">
        {v != null ? v.toFixed(config.decimals != null ? Number(config.decimals) : 0) : (raw != null ? String(raw) : '—')}
        {config.unit ? <span className="text-[0.4em] text-muted-foreground ml-1">{String(config.unit)}</span> : null}
      </div>
    </div>
  )
}
registerWidget({ type: 'stat', label: 'Stat', defaultSize: { w: 3, h: 2 },
  configFields: [{ key: 'stream', label: 'Stream', kind: 'stream' }, { key: 'field', label: 'Field', kind: 'field' }, { key: 'unit', label: 'Unit', kind: 'text' }],
  Component: StatWidget })

/** Horizontal level meter for a ranged value. */
function MeterWidget({ config, instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, String(config.stream ?? '')) as Record<string, unknown> | null
  const v = num(data?.[String(config.field ?? '')])
  const min = Number(config.min ?? 0), max = Number(config.max ?? 100)
  const pct = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)))
  const color = pct > 0.88 ? 'bg-destructive' : pct > 0.7 ? 'bg-busy' : 'bg-live'
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{title}</span>
        <span className="text-[13px] font-bold tabular-nums">{v != null ? v.toFixed(1) : '—'}{config.unit ? <span className="text-[9px] text-muted-foreground ml-0.5">{String(config.unit)}</span> : null}</span>
      </div>
      <div className="h-2.5 rounded-full bg-muted/40 overflow-hidden">
        <div className={cn('h-full rounded-full transition-[width] duration-200', color)} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  )
}
registerWidget({ type: 'meter', label: 'Level meter', defaultSize: { w: 4, h: 2 },
  configFields: [{ key: 'stream', label: 'Stream', kind: 'stream' }, { key: 'field', label: 'Field', kind: 'field' }, { key: 'unit', label: 'Unit', kind: 'text' }, { key: 'min', label: 'Min', kind: 'number' }, { key: 'max', label: 'Max', kind: 'number' }],
  Component: MeterWidget })

/** A string state as a badge. */
function StateWidget({ config, instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, String(config.stream ?? '')) as Record<string, unknown> | null
  const v = data?.[String(config.field ?? '')]
  return (
    <div className="h-full flex flex-col justify-center items-center text-center px-2 gap-1">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground truncate w-full">{title}</div>
      <div className="text-[clamp(0.9rem,5cqw,1.6rem)] font-bold uppercase tracking-wide">{v != null ? String(v) : '—'}</div>
    </div>
  )
}
registerWidget({ type: 'state', label: 'State', defaultSize: { w: 3, h: 2 },
  configFields: [{ key: 'stream', label: 'Stream', kind: 'stream' }, { key: 'field', label: 'Field', kind: 'field' }],
  Component: StateWidget })
