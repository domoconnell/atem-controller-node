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
import { displayDef, gridDims, normaliseSurface, type Surface, type Layout, type Edge } from '@/components/surfaces/model'
import { Pullouts } from '@/components/surfaces/pullouts'
import { useTopic } from '@/hooks/use-topic'
import { realtime } from '@/lib/realtime'
import { cn } from '@/lib/utils'

/** A stable per-browser id (localStorage) so OSC can target this exact display. */
function useBrowserId(): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    let v = localStorage.getItem('sil-browser-id')
    if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem('sil-browser-id', v) }
    setId(v)
  }, [])
  return id
}
const EDGE_TARGETS: Record<string, Edge> = { left_drawer: 'left', right_drawer: 'right', top_drawer: 'top', bottom_drawer: 'bottom' }

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
        <Grid key={`${surface.id}:${surface.display}`} className="layout" layouts={{ lg: surface.main.layout }} breakpoints={{ lg: 0 }} cols={{ lg: cols }} rowHeight={rowH} maxRows={rows} margin={[0, 0]} containerPadding={[0, 0]} compactType={null} isDraggable={false} isResizable={false}>
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
  const [openEdge, setOpenEdge] = useState<Edge | null>(null)
  const browserId = useBrowserId()

  // Announce this display so OSC/Companion can target it (usr:surface:<browserId>).
  // openEdge is included so Companion drawer feedbacks can light when open.
  useEffect(() => {
    if (browserId && surface) realtime.register({ browserId, surfaceId: surface.id, surfaceName: surface.name, openEdge })
  }, [browserId, surface, openEdge])

  // Control messages from OSC/Companion, targeted at this browser session:
  //  - drawer:  { surfaceId, target: 'left_drawer', action }
  //  - switch:  { showSurface: <surfaceId> }
  const control = useTopic(browserId ? `usr:surface:${browserId}` : null) as { surfaceId?: string | null; target?: string; action?: string; showSurface?: string; at?: number } | null
  useEffect(() => {
    if (!control?.target) return
    const edge = EDGE_TARGETS[control.target]
    if (!edge) return
    if (control.surfaceId && surface && control.surfaceId !== surface.id) return
    setOpenEdge((cur) => control.action === 'open' ? edge : control.action === 'close' ? (cur === edge ? null : cur) : (cur === edge ? null : edge))
  }, [control, surface])

  // Switch this display to a different surface, in place (no reload). The URL is
  // updated so a refresh stays on the new surface, and the register effect
  // re-announces this session under it.
  useEffect(() => {
    const id = control?.showSurface
    if (!id || (surface && id === surface.id)) return
    fetch(`/api/surfaces/${id}`).then((r) => r.json()).then((b) => {
      if (!b?.surface) return
      setOpenEdge(null)
      setSurface(normaliseSurface({ ...b.surface, id }))
      setMissing(false)
      const u = new URL(window.location.href); u.searchParams.set('s', id); window.history.replaceState(null, '', u.toString())
    }).catch(() => {})
  }, [control, surface])

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

      <Pullouts surface={surface} instances={instances} openEdge={openEdge} onOpenEdge={setOpenEdge} />
      {browserId && <div className="absolute bottom-1 right-2 z-50 text-[9px] font-mono text-muted-foreground/30 tabular-nums pointer-events-none select-none">{browserId}</div>}
    </div>
  )
}
