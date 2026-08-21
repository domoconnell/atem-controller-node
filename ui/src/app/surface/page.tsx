'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import '@/widgets/builtin'
import '@/widgets/connectors'
import '@/widgets/strips'
import '@/widgets/mics'
import '@/widgets/atem'
import '@/widgets/recorders'
import '@/widgets/runsheet'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'
import { useMeasure } from '@/components/surfaces/use-measure'
import { displayDef, gridDims, normaliseSurface, type Surface, type Layout } from '@/components/surfaces/model'
import { Pullouts } from '@/components/surfaces/pullouts'
import { cn } from '@/lib/utils'

const Grid = dynamic(() => import('@/components/surfaces/grid'), { ssr: false })
type IRef = { id: string; typeId: string; name: string }

function Strip({ widgets, instances }: { widgets: Placement[]; instances: IRef[] }) {
  return (
    <div className="glass-strip flex gap-2 p-2 h-16 overflow-hidden shrink-0 border-y">
      {widgets.map((p) => (<div key={p.i} className="min-w-0 h-full" style={p.config.stripW === 0 ? { flex: '0 0 auto' } : { flexGrow: (p.config.stripW as number) || 1, flexBasis: 0 }}><WidgetView p={p} instances={instances} /></div>))}
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
        <Grid className="layout" layouts={{ lg: surface.main.layout }} breakpoints={{ lg: 0 }} cols={{ lg: cols }} rowHeight={rowH} maxRows={rows} margin={[0, 0]} containerPadding={[0, 0]} compactType={null} isDraggable={false} isResizable={false}>
          {surface.main.widgets.map((p) => (<div key={p.i} data-grid={{ ...(lmap[p.i] ?? { x: 0, y: 0, w: 3, h: 2 }), i: p.i }} className="p-1.5"><WidgetView p={p} instances={instances} /></div>))}
        </Grid>
      )}
    </div>
  )
}

export default function SurfaceViewer() {
  const [surface, setSurface] = useState<Surface | null>(null)
  const [missing, setMissing] = useState(false)
  const [instances, setInstances] = useState<IRef[]>([])
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
    <div className="h-screen w-screen surface-bg flex flex-col relative overflow-hidden">
      {surface.header.enabled && <Strip widgets={surface.header.widgets} instances={instances} />}
      <div className="flex flex-1 min-h-0">
        <MainGrid surface={surface} instances={instances} />
      </div>
      {surface.footer.enabled && <Strip widgets={surface.footer.widgets} instances={instances} />}

      <Pullouts surface={surface} instances={instances} />
    </div>
  )
}
