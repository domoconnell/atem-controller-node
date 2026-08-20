'use client'
import { getWidget } from '@/widgets/registry'
import { cn } from '@/lib/utils'
import { Settings2, X } from 'lucide-react'

export interface Placement { i: string; widgetType: string; instanceId: string | null; config: Record<string, unknown>; title?: string }

/** Frames one widget: header (title) + body. In edit mode, config/remove. */
export function WidgetView({ p, edit, selected, onSelect, onRemove }: {
  p: Placement; edit?: boolean; selected?: boolean
  onSelect?: () => void; onRemove?: () => void
}) {
  const def = getWidget(p.widgetType)
  const title = p.title || def?.label || p.widgetType
  return (
    <div className={cn('h-full w-full rounded-xl border bg-card overflow-hidden flex flex-col',
      selected ? 'border-primary' : 'border-border/60')}
      style={{ containerType: 'size' } as React.CSSProperties}>
      {edit && (
        <div className="widget-drag-handle shrink-0 h-6 flex items-center gap-1 px-2 bg-muted/40 cursor-move">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate flex-1">{title}</span>
          <button onClick={(e) => { e.stopPropagation(); onSelect?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent"><Settings2 className="size-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onRemove?.() }} className="widget-no-drag p-0.5 rounded hover:bg-accent hover:text-destructive"><X className="size-3" /></button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {def ? <def.Component config={p.config} instanceId={p.instanceId} title={title} /> : <div className="grid place-items-center h-full text-[11px] text-muted-foreground">unknown widget</div>}
      </div>
    </div>
  )
}
