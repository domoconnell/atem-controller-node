'use client'
import { useEffect, useRef } from 'react'
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


// ---- ProdCom comms widgets ----
interface FeedMsg { id: string; text: string; at: number; channel: string; colour: string | null; live?: boolean; redacted?: boolean; flags?: { keyword: string; colour?: string | null }[] }
const fmtTime = (at: number) => { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

/** Live talkback transcript from a ProdCom instance. */
function CommsTranscript({ instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, 'feed') as { messages?: FeedMsg[] } | null
  const msgs = data?.messages ?? []
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, [msgs.length])
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1">{title}</div>
      <div ref={ref} className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-1">
        {msgs.length === 0 && <div className="text-muted-foreground/40 text-[11px]">No traffic yet…</div>}
        {msgs.map((m) => (
          <div key={m.id} className={cn('text-[12px] leading-snug', m.live && 'opacity-55 italic')}>
            <span className="font-semibold" style={{ color: m.colour ?? undefined }}>{m.channel}</span>
            <span className="text-muted-foreground/40 text-[10px] ml-1.5 tabular-nums">{fmtTime(m.at)}</span>
            <span className="ml-2 text-foreground/90">{m.redacted ? '████████' : m.text}</span>
            {m.flags?.map((f, i) => (
              <span key={i} className="ml-1.5 text-[9px] font-bold uppercase rounded px-1 py-px align-middle"
                style={{ background: (f.colour ?? '#888') + '33', color: f.colour ?? undefined }}>{f.keyword}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
registerWidget({ type: 'comms-transcript', label: 'Comms transcript', supportedTypeIds: ['prodcom'], defaultSize: { w: 5, h: 5 }, Component: CommsTranscript })

/** Just the flagged call-outs (mentions) from a ProdCom instance. */
function CommsCallouts({ instanceId, title }: WidgetProps) {
  const data = useStream(instanceId, 'feed') as { messages?: FeedMsg[] } | null
  const flagged = (data?.messages ?? []).filter((m) => (m.flags?.length ?? 0) > 0)
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1">{title}</div>
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
registerWidget({ type: 'comms-callouts', label: 'Comms call-outs', supportedTypeIds: ['prodcom'], defaultSize: { w: 4, h: 4 }, Component: CommsCallouts })
