'use client'
import { useState } from 'react'
import type { LayoutElement } from '@/lib/designer-types'
import { elementLabel } from '@/lib/designer-types'
import { cn } from '@/lib/utils'
import { GripVertical, Clock, Type, Square, Circle as CircleIcon } from 'lucide-react'

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  timer: Clock, text: Type, rect: Square, ellipse: CircleIcon,
}

/**
 * Layers list: front-most first, drag to reorder (element array order is
 * paint order — last paints on top).
 */
export function LayersPanel({
  elements, selectedId, onSelect, onReorder,
}: {
  elements: LayoutElement[]
  selectedId: string | null
  onSelect: (id: string) => void
  onReorder: (from: number, to: number) => void   // indices in the elements array
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)   // display index
  const [overIdx, setOverIdx] = useState<number | null>(null)
  // display order: front-most (last in array) first
  const display = [...elements].reverse()
  const toArrayIdx = (di: number) => elements.length - 1 - di

  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
        Layers <span className="normal-case tracking-normal">· front to back</span>
      </div>
      <div className="space-y-1">
        {display.map((el, di) => {
          const Icon = TYPE_ICON[el.params.type ?? 'timer'] ?? Clock
          return (
            <div
              key={el.id}
              draggable
              onDragStart={() => setDragIdx(di)}
              onDragOver={(e) => { e.preventDefault(); setOverIdx(di) }}
              onDragLeave={() => setOverIdx((o) => (o === di ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIdx != null && dragIdx !== di) onReorder(toArrayIdx(dragIdx), toArrayIdx(di))
                setDragIdx(null); setOverIdx(null)
              }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
              onClick={() => onSelect(el.id)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer transition-colors',
                selectedId === el.id ? 'border-primary bg-primary/10' : 'border-border bg-muted/30 hover:border-foreground/25',
                dragIdx === di && 'opacity-40',
                overIdx === di && dragIdx !== null && dragIdx !== di && 'border-info border-dashed'
              )}
            >
              <GripVertical className="size-3.5 text-muted-foreground/60 cursor-grab shrink-0" />
              <Icon className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-[12px] font-medium truncate">{elementLabel(el)}</span>
              <span className="ml-auto text-[9.5px] font-mono text-muted-foreground">{toArrayIdx(di) + 1}</span>
            </div>
          )
        })}
        {elements.length === 0 && <div className="text-[11.5px] text-muted-foreground px-1">No layers yet.</div>}
      </div>
    </div>
  )
}
