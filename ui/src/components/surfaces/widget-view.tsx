'use client'
import { getWidget } from '@/widgets/registry'
import { cn } from '@/lib/utils'
import { Settings2, X } from 'lucide-react'

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
  return (
    <div className={cn('h-full w-full rounded-xl border bg-card overflow-hidden flex flex-col',
      selected ? 'border-primary' : 'border-border/60')}
      style={{ containerType: 'size' } as React.CSSProperties}>
      {edit && (
        <div className="widget-drag-handle shrink-0 h-6 flex items-center gap-1 px-2 bg-muted/40 cursor-move">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate flex-1">{editLabel}</span>
          <button onClick={(e) => { e.stopPropagation(); onSelect?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent"><Settings2 className="size-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onRemove?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent hover:text-destructive"><X className="size-3" /></button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {def ? <def.Component config={p.config} instanceId={p.instanceId} instances={multiInstances} title={title} /> : <div className="grid place-items-center h-full text-[11px] text-muted-foreground">unknown widget</div>}
      </div>
    </div>
  )
}
