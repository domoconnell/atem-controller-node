'use client'
import { useCallback, useRef, useState } from 'react'
import { getWidget } from '@/widgets/registry'
import { cn } from '@/lib/utils'
import { Settings2, X } from 'lucide-react'
import { PulseContext, DangerContext, dangerColor } from './pulse'

// Base resting shadow (must match .glass) so the pulse animation returns to it.
const BASE_SHADOW = 'inset 0 1px 0 oklch(1 0 0 / 0.05), 0 12px 34px -20px oklch(0 0 0 / 0.85)'

export interface Placement { i: string; widgetType: string; instanceId: string | null; config: Record<string, unknown>; title?: string }
export interface InstanceRef { id: string; typeId: string; name: string }

/** Frames one widget: header (title) + body. In edit mode, config/remove. */
export function WidgetView({ p, instances = [], edit, selected, onSelect, onRemove }: {
  p: Placement; instances?: InstanceRef[]; edit?: boolean; selected?: boolean
  onSelect?: () => void; onRemove?: () => void
}) {
  const def = getWidget(p.widgetType)
  // Widgets show NO title by default - only the opt-in placement title (set in
  // the config sidebar). The widget type label is used solely for the edit
  // drag-handle so you can still tell them apart while designing.
  const title = p.title ?? ''
  const editLabel = p.title || def?.label || p.widgetType
  const boundType = (p.config.typeId as string | undefined) ?? instances.find((x) => x.id === p.instanceId)?.typeId
  // A fit widget (e.g. a logo) sizes to its own content — no container-type,
  // which would otherwise make its width come from the parent and collapse it.
  const stripStyle = def?.stripFit ? undefined : ({ containerType: 'size' } as React.CSSProperties)
  const stripW = def?.stripFit ? 'h-full w-auto' : 'h-full w-full'
  if (def?.strip && !edit) return <div className={stripW} style={stripStyle}><def.Component config={p.config} instanceId={p.instanceId} instances={def.multi === 'all' ? instances : def.multi === 'type' ? instances.filter((x) => x.typeId === boundType) : undefined} title={title} /></div>
  if (def?.strip) return (
    <div className={cn(stripW, 'rounded-lg overflow-hidden', selected && 'ring-1 ring-primary')} style={stripStyle}>
      <def.Component config={p.config} instanceId={p.instanceId} instances={def.multi === 'all' ? instances : def.multi === 'type' ? instances.filter((x) => x.typeId === boundType) : undefined} title={title} />
    </div>
  )
  const multiInstances = def?.multi === 'all' ? instances
    : def?.multi === 'type' ? instances.filter((x) => x.typeId === boundType)
    : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  // Widgets report danger (0..1); the frame takes the worst and tints the accent
  // blue→red. Kept in a ref so pulse() stays stable while reading the latest.
  const dangers = useRef(new Map<string, number>())
  const [danger, setDanger] = useState(0)
  const dangerRef = useRef(0); dangerRef.current = danger
  const reportDanger = useCallback((key: string, level: number | null) => {
    const m = dangers.current
    if (level == null) m.delete(key); else m.set(key, level)
    let max = 0; for (const v of m.values()) if (v > max) max = v
    setDanger(max)
  }, [])
  // A widget flashes its frame by calling pulse() on a meaningful event; the
  // glow colour follows its current danger. WAAPI so rapid events restart cleanly.
  const editRef = useRef(edit); editRef.current = edit
  const pulse = useCallback(() => {
    if (editRef.current) return
    const c = (a: number) => dangerColor(dangerRef.current, a)
    cardRef.current?.animate(
      [
        { boxShadow: `${BASE_SHADOW}, 0 0 0 1px ${c(0.75)}, 0 0 24px -1px ${c(0.6)}` },
        { boxShadow: `${BASE_SHADOW}, 0 0 0 1px ${c(0)}, 0 0 24px -1px ${c(0)}` },
      ],
      { duration: 900, easing: 'ease-out' },
    )
  }, [])
  return (
    <div ref={cardRef} className={cn('h-full w-full rounded-lg overflow-hidden flex flex-col glass', selected && 'glass-selected')}
      style={{ containerType: 'size', ['--accent' as string]: dangerColor(danger) } as React.CSSProperties}>
      {edit && (
        <div className="widget-drag-handle shrink-0 h-6 flex items-center gap-1 px-2 bg-muted/40 cursor-move">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate flex-1">{editLabel}</span>
          <button onClick={(e) => { e.stopPropagation(); onSelect?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent"><Settings2 className="size-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onRemove?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent hover:text-destructive"><X className="size-3" /></button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {def ? <PulseContext.Provider value={pulse}><DangerContext.Provider value={reportDanger}><def.Component config={p.config} instanceId={p.instanceId} instances={multiInstances} title={title} /></DangerContext.Provider></PulseContext.Provider> : <div className="grid place-items-center h-full text-[11px] text-muted-foreground">unknown widget</div>}
      </div>
    </div>
  )
}
