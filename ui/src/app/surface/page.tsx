'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import '@/widgets/builtin'
import '@/widgets/connectors'
import '@/widgets/strips'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'
import { useMeasure } from '@/components/surfaces/use-measure'
import { displayDef, gridDims, normaliseSurface, type Surface, type Edge, type Layout } from '@/components/surfaces/model'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'

const Grid = dynamic(() => import('@/components/surfaces/grid'), { ssr: false })
type IRef = { id: string; typeId: string; name: string }
const EDGES: Edge[] = ['top', 'bottom', 'left', 'right']
const TAB_ICON = { left: ChevronRight, right: ChevronLeft, top: ChevronDown, bottom: ChevronUp }

function Strip({ widgets, instances }: { widgets: Placement[]; instances: IRef[] }) {
  return (
    <div className="bg-muted/20 flex gap-1 p-1 h-14 overflow-hidden shrink-0 border-y border-border/40">
      {widgets.map((p) => (<div key={p.i} className="flex-1 min-w-0 h-full"><WidgetView p={p} instances={instances} /></div>))}
    </div>
  )
}

function MainGrid({ surface, instances }: { surface: Surface; instances: IRef[] }) {
  const [ref, { w, h }] = useMeasure<HTMLDivElement>()
  const { cols, rows } = gridDims(surface.display)
  const rowH = h > 0 ? h / rows : 44
  const lmap = Object.fromEntries(surface.main.layout.map((l) => [l.i, l]))
  return (
    <div ref={ref} className="flex-1 min-h-0 min-w-0 overflow-hidden">
      {w > 0 && h > 0 && (
        <Grid className="layout" breakpoints={{ lg: 0 }} cols={{ lg: cols }} rowHeight={rowH} maxRows={rows} margin={[0, 0]} containerPadding={[0, 0]} compactType={null} isDraggable={false} isResizable={false}>
          {surface.main.widgets.map((p) => (<div key={p.i} data-grid={{ ...(lmap[p.i] ?? { x: 0, y: 0, w: 3, h: 2 }), i: p.i }}><WidgetView p={p} instances={instances} /></div>))}
        </Grid>
      )}
    </div>
  )
}

export default function SurfaceViewer() {
  const [surface, setSurface] = useState<Surface | null>(null)
  const [missing, setMissing] = useState(false)
  const [instances, setInstances] = useState<IRef[]>([])
  const [open, setOpen] = useState<Edge | null>(null)
  useEffect(() => {
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances((b.instances ?? []).map((i: IRef) => ({ id: i.id, typeId: i.typeId, name: i.name })))).catch(() => {})
    const id = new URLSearchParams(window.location.search).get('s')
    if (!id) { setMissing(true); return }
    fetch(`/api/surfaces/${id}`).then((r) => r.json()).then((b) => b.surface ? setSurface(normaliseSurface({ ...b.surface, id })) : setMissing(true)).catch(() => setMissing(true))
  }, [])
  if (missing) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Surface not found.</div>
  if (!surface) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Loading…</div>
  const P = surface.pullouts
  return (
    <div className="h-screen w-screen bg-background flex flex-col relative overflow-hidden">
      {surface.header.enabled && <Strip widgets={surface.header.widgets} instances={instances} />}
      <div className="flex flex-1 min-h-0">
        <MainGrid surface={surface} instances={instances} />
      </div>
      {surface.footer.enabled && <Strip widgets={surface.footer.widgets} instances={instances} />}

      {/* pull-out tabs + panels */}
      {EDGES.filter((e) => P[e].enabled).map((e) => {
        const Icon = TAB_ICON[e]
        const isOpen = open === e
        const edgePos = { left: 'left-0 top-1/2 -translate-y-1/2', right: 'right-0 top-1/2 -translate-y-1/2', top: 'top-0 left-1/2 -translate-x-1/2', bottom: 'bottom-0 left-1/2 -translate-x-1/2' }[e]
        const panelPos = {
          left: cn('left-0 top-0 bottom-0 w-72 flex-col', isOpen ? 'translate-x-0' : '-translate-x-full'),
          right: cn('right-0 top-0 bottom-0 w-72 flex-col', isOpen ? 'translate-x-0' : 'translate-x-full'),
          top: cn('top-0 left-0 right-0 h-40 flex-row', isOpen ? 'translate-y-0' : '-translate-y-full'),
          bottom: cn('bottom-0 left-0 right-0 h-40 flex-row', isOpen ? 'translate-y-0' : 'translate-y-full'),
        }[e]
        return (
          <div key={e}>
            <button onClick={() => setOpen(isOpen ? null : e)} className={cn('absolute z-40 bg-card border border-border/70 rounded-md p-1.5 shadow-lg hover:bg-accent', edgePos)}><Icon className="size-4" /></button>
            <div className={cn('absolute z-30 bg-background/95 border-border/70 shadow-2xl flex gap-1.5 p-2 overflow-auto transition-transform duration-200', panelPos, e === 'left' && 'border-r', e === 'right' && 'border-l', e === 'top' && 'border-b', e === 'bottom' && 'border-t')}>
              {P[e].widgets.map((p) => (<div key={p.i} className={cn('shrink-0', e === 'left' || e === 'right' ? 'w-full h-28' : 'w-56 h-full')}><WidgetView p={p} instances={instances} /></div>))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
