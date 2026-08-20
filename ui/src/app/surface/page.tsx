'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import '@/widgets/builtin'
import '@/widgets/connectors'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'

const Grid = dynamic(() => import('@/components/surfaces/grid'), { ssr: false })
interface Surface { name: string; widgets: Placement[]; layout: { i: string; x: number; y: number; w: number; h: number }[] }

/** Read-only surface viewer for any screen: /surface?s=<id>. */
export default function SurfaceViewer() {
  const [surface, setSurface] = useState<Surface | null>(null)
  const [missing, setMissing] = useState(false)
  const [instances, setInstances] = useState<{ id: string; typeId: string; name: string }[]>([])
  useEffect(() => {
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances((b.instances ?? []).map((i: { id: string; typeId: string; name: string }) => ({ id: i.id, typeId: i.typeId, name: i.name })))).catch(() => {})
    const id = new URLSearchParams(window.location.search).get('s')
    if (!id) { setMissing(true); return }
    const load = () => fetch(`/api/surfaces/${id}`).then((r) => r.json())
      .then((b) => b.surface ? setSurface(b.surface) : setMissing(true)).catch(() => setMissing(true))
    load()
  }, [])
  if (missing) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Surface not found. Add <code className="mx-1">?s=&lt;id&gt;</code> to the URL.</div>
  if (!surface) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Loading…</div>
  return (
    <div className="min-h-screen bg-background p-2">
      <Grid layouts={{ lg: surface.layout }} breakpoints={{ lg: 0 }} cols={{ lg: 12 }} rowHeight={44} margin={[10, 10]} isDraggable={false} isResizable={false}>
        {surface.widgets.map((p) => <div key={p.i}><WidgetView p={p} instances={instances} /></div>)}
      </Grid>
    </div>
  )
}
