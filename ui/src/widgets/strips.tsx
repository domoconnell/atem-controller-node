'use client'
import { useEffect, useState } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useTopic } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { Activity, Clock } from 'lucide-react'

/** Long, thin frame for a header/footer widget: leading icon, label, then
 *  right-aligned pills. Fills its share of the strip and truncates as it narrows. */
function Frame({ icon: Icon, label, children }: { icon: React.ElementType; label?: string; children?: React.ReactNode }) {
  return (
    <div className="h-full w-full flex items-center gap-2 px-2.5 rounded-lg border border-border/50 bg-card overflow-hidden">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {label && <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground truncate">{label}</span>}
      <div className="ml-auto flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  )
}
function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'live' | 'busy' | 'alarm'; children: React.ReactNode }) {
  const c = { muted: 'bg-muted/50 text-foreground/90', live: 'bg-live/15 text-live', busy: 'bg-busy/15 text-busy', alarm: 'bg-destructive/15 text-destructive' }[tone]
  return <span className={cn('text-[11px] font-semibold tabular-nums rounded px-1.5 py-0.5 shrink-0', c)}>{children}</span>
}

/** Platform: compact all-connections summary — count pill + a row of state dots. */
function StripConnections({ instances = [], title }: WidgetProps) {
  const agg = useTopic('sys:status') as Record<string, string> | null
  const states = instances.map((i) => agg?.[i.id] ?? 'connecting')
  const online = states.filter((s) => s === 'online').length
  const worst: 'live' | 'busy' | 'alarm' = states.some((s) => s === 'offline' || s === 'error') ? 'alarm' : states.some((s) => s !== 'online') ? 'busy' : 'live'
  return (
    <Frame icon={Activity} label={title || 'Connections'}>
      <div className="flex items-center gap-[3px] min-w-0 overflow-hidden">
        {states.map((s, i) => <span key={i} className={cn('size-1.5 rounded-full shrink-0', s === 'online' ? 'bg-live' : s === 'offline' || s === 'error' ? 'bg-destructive' : 'bg-busy')} />)}
      </div>
      <Pill tone={worst}>{online}/{instances.length}</Pill>
    </Frame>
  )
}
registerWidget({ type: 'strip-connections', label: 'Connections · strip', strip: true, multi: 'all', defaultSize: { w: 4, h: 1 }, Component: StripConnections })

/** Platform: clock. */
function StripClock({ title }: WidgetProps) {
  const [now, setNow] = useState('')
  useEffect(() => { const t = () => setNow(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })); t(); const h = setInterval(t, 1000); return () => clearInterval(h) }, [])
  return <Frame icon={Clock} label={title || 'Time'}><span className="text-[14px] font-bold tabular-nums">{now}</span></Frame>
}
registerWidget({ type: 'strip-clock', label: 'Clock · strip', strip: true, defaultSize: { w: 2, h: 1 }, Component: StripClock })
