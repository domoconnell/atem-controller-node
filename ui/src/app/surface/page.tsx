'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import '@/widgets/builtin'
import '@/widgets/connectors'
import '@/widgets/strips'
import '@/widgets/mics'
import '@/widgets/atem'
import '@/widgets/recorders'
import '@/widgets/runsheet'
import '@/widgets/calls'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'
import { useMeasure } from '@/components/surfaces/use-measure'
import { displayDef, gridDims, normaliseSurface, stripFlexStyle, type Surface, type Layout, type Edge } from '@/components/surfaces/model'
import { Pullouts } from '@/components/surfaces/pullouts'
import { useTopic } from '@/hooks/use-topic'
import { realtime } from '@/lib/realtime'
import { cn } from '@/lib/utils'

/** A stable per-browser id (localStorage) so OSC can target this exact display.
 *  `?id=<name>` pins it — kiosks pass a fixed, human name (e.g. kiosk-1) so the
 *  identity survives a re-flash and reads nicely in Companion/Settings. */
function useBrowserId(): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    const override = new URLSearchParams(window.location.search).get('id')
    if (override) { localStorage.setItem('sil-browser-id', override); setId(override); return }
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
      {widgets.map((p) => (<div key={p.i} className="min-w-0 h-full" style={stripFlexStyle(p.config)}><WidgetView p={p} instances={instances} /></div>))}
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
          {surface.main.widgets.map((p) => (<div key={p.i} data-grid={{ ...(lmap[p.i] ?? { x: 0, y: 0, w: 3, h: 2 }), i: p.i }} className="p-2.5"><WidgetView p={p} instances={instances} /></div>))}
        </Grid>
      )}
    </div>
  )
}

/** The kiosk landing / identify screen: shown when a display has never been
 *  assigned a surface. Big, readable-across-the-room identity (its name, or the
 *  raw browser id) so an operator can pick it out and point it at a surface from
 *  Companion. Once assigned, that choice is remembered and the start page
 *  redirects straight to it on the next boot. */
function StartScreen({ name, browserId }: { name: string | null; browserId: string | null }) {
  return (
    <div className="h-screen w-screen surface-bg flex flex-col items-center justify-center relative overflow-hidden text-center px-8">
      <div className="surface-aurora" />
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">Stage It Live · Display</div>
        <div className="text-5xl md:text-7xl font-black text-foreground leading-none break-words max-w-[90vw]">{name || browserId || '…'}</div>
        {name && browserId ? <div className="font-mono text-sm text-muted-foreground/70">{browserId}</div> : null}
        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-block size-2 rounded-full bg-live animate-pulse" />
          Waiting to be assigned a surface
        </div>
        <div className="text-[11px] text-muted-foreground/60 max-w-md">Point this display at a surface from Companion or the dashboard — its choice is remembered, and it opens straight to it next time.</div>
      </div>
    </div>
  )
}

export default function SurfaceViewer() {
  const [surface, setSurface] = useState<Surface | null>(null)
  const [missing, setMissing] = useState(false)
  const [start, setStart] = useState(false) // kiosk identify/landing screen
  const [instances, setInstances] = useState<IRef[]>([])
  const [openEdge, setOpenEdge] = useState<Edge | null>(null)
  const browserId = useBrowserId()

  const loadSurface = useCallback((id: string, updateUrl = false) => {
    fetch(`/api/surfaces/${id}`).then((r) => r.json()).then((b) => {
      if (!b?.surface) { setMissing(true); return }
      setStart(false); setMissing(false)
      setSurface(normaliseSurface({ ...b.surface, id }))
      if (updateUrl) { const u = new URL(window.location.href); u.searchParams.set('s', id); window.history.replaceState(null, '', u.toString()) }
    }).catch(() => setMissing(true))
  }, [])
  // Animated accent style: 'orbit' (glow circles each widget) or 'sweep' (glow
  // travels back and forth along the top). Switch live with ?fx=sweep.
  const [fx, setFx] = useState<'orbit' | 'sweep'>('orbit')
  useEffect(() => { const v = new URLSearchParams(window.location.search).get('fx'); if (v === 'sweep' || v === 'orbit') setFx(v) }, [])

  // Announce this display so OSC/Companion can target it (usr:surface:<browserId>).
  // openEdge is included so Companion drawer feedbacks can light when open.
  useEffect(() => {
    if (!browserId) return
    if (surface) realtime.register({ browserId, surfaceId: surface.id, surfaceName: surface.name, openEdge })
    else if (start) realtime.register({ browserId, surfaceId: 'start', surfaceName: null, openEdge: null })
  }, [browserId, surface, start, openEdge])

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

  // Incoming calls for this session (usr:calls:<browserId>) — drives the
  // flashing popover + whole-screen pulsing border.
  const callState = useTopic(browserId ? `usr:calls:${browserId}` : null) as { name?: string | null; calls?: { from: string; fromName: string; at: number }[] } | null
  const incoming = callState?.calls ?? []
  const clearCalls = () => { if (browserId) fetch('/api/companion/call/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: browserId }) }).catch(() => {}) }

  useEffect(() => {
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances((b.instances ?? []).map((i: IRef) => ({ id: i.id, typeId: i.typeId, name: i.name })))).catch(() => {})
  }, [])

  // Resolve which surface to show. `?s=<id>` loads it directly. `?s=start` (or no
  // s) is the kiosk landing: redirect to this display's remembered surface, or —
  // if it's never been assigned — show the identify screen so an operator can
  // point it at a surface from Companion/the app.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('s')
    if (s && s !== 'start') { loadSurface(s); return }
    if (!browserId) return // need the id before the server can tell us its last surface
    fetch(`/api/surface-last/${browserId}`).then((r) => r.json()).then((b) => {
      if (b?.surfaceId) loadSurface(b.surfaceId, true)
      else setStart(true)
    }).catch(() => setStart(true))
  }, [browserId, loadSurface])
  if (start && !surface) return <StartScreen name={callState?.name ?? null} browserId={browserId} />
  if (missing) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Surface not found.</div>
  if (!surface) return <div className="h-screen grid place-items-center bg-background text-muted-foreground text-sm">Loading…</div>
  const P = surface.pullouts
  return (
    <div className={cn('h-screen w-screen surface-bg flex flex-col relative overflow-hidden', `fx-${fx}`)}>
      <div className="surface-aurora" />
      <div className="relative z-10 flex flex-col flex-1 min-h-0">
        {surface.header.enabled && <Strip widgets={surface.header.widgets} instances={instances} />}
        <div className="flex flex-1 min-h-0">
          <MainGrid surface={surface} instances={instances} />
        </div>
        {surface.footer.enabled && <Strip widgets={surface.footer.widgets} instances={instances} />}
      </div>

      <Pullouts surface={surface} instances={instances} openEdge={openEdge} onOpenEdge={setOpenEdge} />
      {browserId && <div className="absolute top-0 left-1/2 -translate-x-1/2 z-50 text-[10px] font-mono text-foreground/70 tabular-nums pointer-events-none select-none bg-black/45 rounded-b-md px-2 py-0.5 border border-t-0 border-border/50 backdrop-blur-sm">{callState?.name || browserId}</div>}

      {/* Backstage call — pulsing whole-screen border + flashing popover. */}
      {incoming.length > 0 && (
        <>
          <div className="call-border pointer-events-none absolute inset-0 z-[60]" style={{ boxShadow: 'inset 0 0 0 5px oklch(0.63 0.24 25), inset 0 0 40px -6px oklch(0.63 0.24 25 / 0.8)' }} aria-hidden />
          <div className="call-flash absolute inset-x-0 top-1/2 z-[70] flex justify-center px-6">
            <div className="rounded-2xl bg-black/85 border-2 px-10 py-6 shadow-2xl text-center backdrop-blur-md" style={{ borderColor: 'oklch(0.63 0.24 25)' }}>
              <div className="text-[11px] uppercase tracking-[0.28em] font-bold" style={{ color: 'oklch(0.7 0.22 25)' }}>Incoming call</div>
              <div className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black leading-none text-white">
                {incoming.map((c) => c.fromName).join(', ')} <span style={{ color: 'oklch(0.7 0.22 25)' }}>Calling</span>
              </div>
              <button onClick={clearCalls} className="mt-4 inline-flex items-center gap-1.5 rounded-lg text-white px-5 py-2 text-[14px] font-bold hover:brightness-110 active:scale-95" style={{ background: 'oklch(0.55 0.22 25)' }}>Clear</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
