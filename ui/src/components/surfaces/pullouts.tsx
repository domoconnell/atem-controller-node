'use client'
import { useState } from 'react'
import { WidgetView } from './widget-view'
import type { Surface, Edge } from './model'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X } from 'lucide-react'

const EDGES: Edge[] = ['top', 'bottom', 'left', 'right']
const OPEN_ICON = { left: ChevronRight, right: ChevronLeft, top: ChevronDown, bottom: ChevronUp }
const CLOSE_ICON = { left: ChevronLeft, right: ChevronRight, top: ChevronUp, bottom: ChevronDown }

/** Edge pull-out drawers: a tab per enabled edge that slides a partial panel
 *  in over the surface (never covering the whole thing). Shared by the
 *  designer (editable) and the viewer (read-only). Absolutely positioned, so
 *  the host must be `relative`. */
export function Pullouts({ surface, instances, edit, sel, onSelect, onRemove, openEdge, onOpenEdge }: {
  surface: Surface
  instances: { id: string; typeId: string; name: string }[]
  edit?: boolean
  sel?: { region: string; i: string } | null
  onSelect?: (region: Edge, i: string) => void
  onRemove?: (region: Edge, i: string) => void
  /** Controlled open edge (e.g. driven by OSC); falls back to internal state. */
  openEdge?: Edge | null
  onOpenEdge?: (e: Edge | null) => void
}) {
  const [internal, setInternal] = useState<Edge | null>(null)
  const open = openEdge !== undefined ? openEdge : internal
  const setOpen = (e: Edge | null) => { if (onOpenEdge) onOpenEdge(e); else setInternal(e) }
  return (
    <>
      {EDGES.filter((e) => surface.pullouts[e].enabled).map((e) => {
        const isOpen = open === e
        const Icon = isOpen ? CLOSE_ICON[e] : OPEN_ICON[e]
        const widgets = surface.pullouts[e].widgets
        const tabPos = { left: 'left-0 top-1/2 -translate-y-1/2 rounded-r-lg', right: 'right-0 top-1/2 -translate-y-1/2 rounded-l-lg', top: 'top-0 left-1/2 -translate-x-1/2 rounded-b-lg', bottom: 'bottom-0 left-1/2 -translate-x-1/2 rounded-t-lg' }[e]
        const panelPos = {
          left: cn('left-0 top-0 bottom-0 w-[30%] min-w-[240px] max-w-[440px] border-r flex-col', isOpen ? 'translate-x-0' : '-translate-x-full'),
          right: cn('right-0 top-0 bottom-0 w-[30%] min-w-[240px] max-w-[440px] border-l flex-col', isOpen ? 'translate-x-0' : 'translate-x-full'),
          top: cn('top-0 left-0 right-0 h-[38%] min-h-[140px] max-h-[320px] border-b flex-row', isOpen ? 'translate-y-0' : '-translate-y-full'),
          bottom: cn('bottom-0 left-0 right-0 h-[38%] min-h-[140px] max-h-[320px] border-t flex-row', isOpen ? 'translate-y-0' : 'translate-y-full'),
        }[e]
        return (
          <div key={e}>
            <button onClick={(ev) => { ev.stopPropagation(); setOpen(isOpen ? null : e) }}
              className={cn('absolute z-40 bg-card border border-border/70 p-1.5 shadow-lg hover:bg-accent', tabPos)} title={`${e} drawer`}>
              <Icon className="size-4" />
            </button>
            <div className={cn('absolute z-30 bg-background/95 backdrop-blur-sm border-border shadow-2xl transition-transform duration-300 ease-out flex', panelPos)}
              onClick={(ev) => ev.stopPropagation()}>
              {/* One widget per drawer, filling it entirely. */}
              <div className="flex-1 min-h-0 p-2">
                {widgets.length === 0 ? (
                  <div className="h-full w-full grid place-items-center text-[11px] text-muted-foreground/50 uppercase tracking-wider">{e} drawer{edit ? ' — add a widget' : ''}</div>
                ) : (
                  <div onClick={(ev) => { ev.stopPropagation(); if (edit) onSelect?.(e, widgets[0].i) }}
                    className={cn('relative h-full w-full', edit && sel?.i === widgets[0].i && 'ring-1 ring-primary rounded-xl')}>
                    <WidgetView p={widgets[0]} instances={instances} />
                    {edit && <button onClick={(ev) => { ev.stopPropagation(); onRemove?.(e, widgets[0].i) }} className="absolute top-0.5 right-0.5 p-0.5 rounded bg-background/80 hover:text-destructive z-10"><X className="size-3" /></button>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
