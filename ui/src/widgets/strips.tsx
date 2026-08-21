'use client'
import { useEffect, useState } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useTopic } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { Clock, Circle, Video, Film, Mic, Timer, Volume2, Play, Disc3, Wifi, SlidersHorizontal, CloudSun, Activity, Cpu, MessageSquare } from 'lucide-react'
import { Brand } from '@/components/brand'

const TYPE_ICON: Record<string, React.ElementType> = {
  atem: Video, hyperdeck: Film, sennheiser: Mic, propresenter: Timer, smaart: Volume2,
  qlab: Play, reaper: Disc3, unifi: Wifi, digico: SlidersHorizontal, weather: CloudSun,
  netcheck: Activity, sysmon: Cpu, prodcom: MessageSquare,
}
const stTint = (s: string) => s === 'online' ? 'text-live' : s === 'offline' || s === 'error' ? 'text-destructive' : 'text-busy'

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

/** Platform: all connections as spread icons — one per connector type, coloured
 *  by state, with an online/total count when a type has several instances. */
function StripConnections({ instances = [] }: WidgetProps) {
  const agg = useTopic('sys:status') as Record<string, string> | null
  const byType = new Map<string, string[]>()
  for (const i of instances) { const a = byType.get(i.typeId) ?? []; a.push(agg?.[i.id] ?? 'connecting'); byType.set(i.typeId, a) }
  return (
    <div className="h-full w-full flex items-center gap-1 px-2 rounded-lg border border-border/50 bg-card overflow-hidden">
      {[...byType.entries()].map(([t, states]) => {
        const Icon = TYPE_ICON[t] ?? Circle
        const online = states.filter((s) => s === 'online').length
        const worst = states.some((s) => s === 'offline' || s === 'error') ? 'offline' : states.some((s) => s !== 'online') ? 'connecting' : 'online'
        return (
          <div key={t} className="flex-1 min-w-0 flex items-center justify-center gap-1" title={`${t}: ${online}/${states.length} online`}>
            <Icon className={cn('size-[18px] shrink-0', stTint(worst))} />
            {states.length > 1 && <span className={cn('text-[10px] font-bold tabular-nums', stTint(worst))}>{online}/{states.length}</span>}
          </div>
        )
      })}
      {instances.length === 0 && <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mx-auto">no connections</span>}
    </div>
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

/** Platform: the Stage It logo, to brand a dashboard header/footer. Set the
 *  config's variant to "icon" for just the mark, or leave blank for the wordmark;
 *  align defaults to centre. */
function StripBrand({ config }: WidgetProps) {
  const icon = (config.variant as string | undefined) === 'icon'
  return (
    <div className="h-full flex items-center justify-center px-3 rounded-lg text-foreground/90">
      <Brand variant={icon ? 'icon' : 'full'} className={icon ? 'h-4 w-4' : 'h-4 w-[84px]'} />
    </div>
  )
}
registerWidget({
  type: 'strip-brand', label: 'Logo · strip', strip: true, stripFit: true, defaultSize: { w: 3, h: 1 },
  configFields: [{ key: 'variant', label: 'Variant (blank = wordmark, "icon" = mark)', kind: 'text' }, { key: 'align', label: 'Align (left / center / right)', kind: 'text' }],
  Component: StripBrand,
})
