'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/widgets/builtin'
import '@/widgets/connectors'
import { widgetsForType, getWidget } from '@/widgets/registry'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'
import { useMeasure } from '@/components/surfaces/use-measure'
import { DISPLAYS, displayDef, gridDims, emptySurface, normaliseSurface, type Surface, type Display, type Edge, type Layout } from '@/components/surfaces/model'
import type { Instance, ConnectorType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Plus, Pencil, Save, Eye, Trash2, ChevronDown, ExternalLink, X } from 'lucide-react'

const Grid = dynamic(() => import('@/components/surfaces/grid'), { ssr: false })
type CType = ConnectorType & { streams?: { id: string; label: string; fields?: { id: string; label?: string }[] }[] }
const EDGES: Edge[] = ['top', 'bottom', 'left', 'right']
type Target = 'main' | 'header' | 'footer' | Edge

export default function SurfacesPage() {
  const { state, connected, tick } = useAtemState()
  const [instances, setInstances] = useState<Instance[]>([])
  const [types, setTypes] = useState<CType[]>([])
  const [list, setList] = useState<{ id: string; name: string }[]>([])
  const [surface, setSurface] = useState<Surface>(emptySurface())
  const [edit, setEdit] = useState(true)
  const [sel, setSel] = useState<{ region: Target; i: string } | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances(b.instances ?? [])).catch(() => {})
    fetch('/api/connector-types').then((r) => r.json()).then((b) => setTypes(b.types ?? [])).catch(() => {})
    fetch('/api/surfaces').then((r) => r.json()).then((b) => { setList(b.surfaces ?? []); if (b.surfaces?.[0]) load(b.surfaces[0].id) }).catch(() => {})
  }, [])
  const load = useCallback(async (id: string) => {
    const b = await fetch(`/api/surfaces/${id}`).then((r) => r.json()).catch(() => null)
    if (b?.surface) setSurface(normaliseSurface({ ...b.surface, id }))
  }, [])
  const save = async () => {
    const r = await fetch(surface.id ? `/api/surfaces/${surface.id}` : '/api/surfaces', {
      method: surface.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(surface),
    }).then((x) => x.json())
    const id = surface.id || r.id
    setSurface((s) => ({ ...s, id }))
    fetch('/api/surfaces').then((x) => x.json()).then((b) => setList(b.surfaces ?? []))
  }

  const instRefs = instances.map((x) => ({ id: x.id, typeId: x.typeId, name: x.name }))
  const regionOf = (t: Target) => t === 'main' ? null : t === 'header' ? surface.header : t === 'footer' ? surface.footer : surface.pullouts[t]
  const setRegion = (t: Target, fn: (w: Placement[]) => Placement[]) => setSurface((s) => {
    if (t === 'main') return { ...s, main: { ...s.main, widgets: fn(s.main.widgets) } }
    if (t === 'header') return { ...s, header: { ...s.header, widgets: fn(s.header.widgets) } }
    if (t === 'footer') return { ...s, footer: { ...s.footer, widgets: fn(s.footer.widgets) } }
    return { ...s, pullouts: { ...s.pullouts, [t]: { ...s.pullouts[t], widgets: fn(s.pullouts[t].widgets) } } }
  })
  const toggleRegion = (t: Exclude<Target, 'main'>) => setSurface((s) => {
    if (t === 'header') return { ...s, header: { ...s.header, enabled: !s.header.enabled } }
    if (t === 'footer') return { ...s, footer: { ...s.footer, enabled: !s.footer.enabled } }
    return { ...s, pullouts: { ...s.pullouts, [t]: { ...s.pullouts[t], enabled: !s.pullouts[t].enabled } } }
  })

  const addWidget = (target: Target, typeId: string, instanceId: string, widgetType: string) => {
    const def = getWidget(widgetType); if (!def) return
    let config: Record<string, unknown> = {}
    if (def.multi === 'type') config = { typeId }
    else if (!def.multi) { const t = types.find((x) => x.typeId === typeId); const fs = t?.streams?.[0]; config = { stream: fs?.id, field: fs?.fields?.[0]?.id } }
    const i = `w${Date.now().toString(36)}`
    const placement: Placement = { i, widgetType, instanceId: def.multi ? null : instanceId, config, title: '' }
    if (target === 'main') {
      const y = surface.main.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0)
      setSurface((s) => { const g = gridDims(s.display); return { ...s, main: { widgets: [...s.main.widgets, placement], layout: [...s.main.layout, { i, x: 0, y: Math.min(y, Math.max(0, g.rows - Math.min(def.defaultSize.h, g.rows))), w: Math.min(def.defaultSize.w, g.cols), h: Math.min(def.defaultSize.h, g.rows) }] } } })
    } else setRegion(target, (w) => [...w, placement])
    setAdding(false); setSel({ region: target, i })
  }
  const removeWidget = (t: Target, i: string) => { setRegion(t, (w) => w.filter((x) => x.i !== i)); if (t === 'main') setSurface((s) => ({ ...s, main: { ...s.main, layout: s.main.layout.filter((l) => l.i !== i) } })); setSel(null) }
  const patchWidget = (t: Target, i: string, patch: Partial<Placement>) => setRegion(t, (w) => w.map((x) => x.i === i ? { ...x, ...patch, config: { ...x.config, ...(patch.config ?? {}) } } : x))

  const selectedPlacement = sel ? (sel.region === 'main' ? surface.main.widgets : regionOf(sel.region)?.widgets ?? []).find((w) => w.i === sel.i) ?? null : null
  const disp = displayDef(surface.display)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="surfaces" state={state} wsConnected={connected} tick={tick}>
          <div className="ml-auto flex items-center gap-2">
            <SurfacePicker list={list} current={surface} onPick={load} onNew={() => { setSurface(emptySurface()); setSel(null) }} />
            {edit && <input value={surface.name} onChange={(e) => setSurface({ ...surface, name: e.target.value })} className="bg-input/40 border border-border rounded-md px-2 py-1 text-[12px] w-36" />}
            {edit && <select value={surface.display} onChange={(e) => setSurface({ ...surface, display: e.target.value as Display })} className="bg-input/40 border border-border rounded-md px-2 py-1.5 text-[12px]">{DISPLAYS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>}
            <button onClick={() => setAdding(true)} disabled={!edit} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent disabled:opacity-40"><Plus className="size-3.5" /> Widget</button>
            <button onClick={() => setEdit((e) => !e)} className={cn('inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5', edit ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>{edit ? <><Eye className="size-3.5" /> View</> : <><Pencil className="size-3.5" /> Edit</>}</button>
            <button onClick={save} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 bg-live text-black font-medium hover:opacity-90"><Save className="size-3.5" /> Save</button>
            {surface.id && <a href={`/surface?s=${surface.id}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
          </div>
        </AppHeader>

        {edit && (
          <div className="shrink-0 h-9 flex items-center gap-3 px-4 border-b border-border/50 text-[11px]">
            <span className="uppercase tracking-wider text-muted-foreground">Regions</span>
            {(['header', 'footer', 'left', 'right', 'top', 'bottom'] as const).map((t) => {
              const on = t === 'header' ? surface.header.enabled : t === 'footer' ? surface.footer.enabled : surface.pullouts[t as Edge].enabled
              return <button key={t} onClick={() => toggleRegion(t)} className={cn('rounded px-2 py-0.5 border capitalize', on ? 'border-primary/50 text-primary bg-primary/10' : 'border-border text-muted-foreground')}>{t}</button>
            })}
          </div>
        )}

        <div className="flex-1 min-h-0 flex">
          <main className="flex-1 min-h-0 grid place-items-center p-4 overflow-hidden bg-black/20" onClick={() => setSel(null)}>
            <Canvas surface={surface} edit={edit} sel={sel} instances={instRefs}
              onSelect={(region, i) => setSel({ region, i })} onRemove={removeWidget}
              onLayout={(l) => setSurface((s) => ({ ...s, main: { ...s.main, layout: l } }))} />
          </main>
          {edit && sel && selectedPlacement && (
            <ConfigPanel key={sel.i} placement={selectedPlacement} instances={instances} types={types}
              onChange={(patch) => patchWidget(sel.region, sel.i, patch)} onClose={() => setSel(null)} />
          )}
        </div>

        {adding && <AddDialog surface={surface} instances={instances} types={types} onAdd={addWidget} onClose={() => setAdding(false)} />}
      </div>
    </TooltipProvider>
  )
}

/** The letterboxed screen preview with all its regions. */
function Canvas({ surface, edit, sel, instances, onSelect, onRemove, onLayout }: {
  surface: Surface; edit: boolean; sel: { region: Target; i: string } | null
  instances: { id: string; typeId: string; name: string }[]
  onSelect: (r: Target, i: string) => void; onRemove: (r: Target, i: string) => void; onLayout: (l: Layout[]) => void
}) {
  const [ref, { w, h }] = useMeasure<HTMLDivElement>()
  const disp = displayDef(surface.display)
  // letterbox the aspect box inside the available area
  let bw = w, bh = w / disp.aspect
  if (bh > h) { bh = h; bw = h * disp.aspect }
  const P = surface.pullouts
  return (
    <div ref={ref} className="w-full h-full grid place-items-center" onClick={(e) => e.stopPropagation()}>
      <div className="relative rounded-lg overflow-hidden border border-border/60 bg-background shadow-2xl flex flex-col" style={{ width: bw || '100%', height: bh || '100%' }}>
        {P.top.enabled && <RegionStrip region="top" horizontal {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
        <div className="flex flex-1 min-h-0">
          {P.left.enabled && <RegionStrip region="left" {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
          <div className="flex flex-col flex-1 min-w-0">
            {surface.header.enabled && <RegionStrip region="header" horizontal small {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
            <MainGrid surface={surface} edit={edit} sel={sel} instances={instances} onSelect={onSelect} onRemove={onRemove} onLayout={onLayout} />
            {surface.footer.enabled && <RegionStrip region="footer" horizontal small {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
          </div>
          {P.right.enabled && <RegionStrip region="right" {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
        </div>
        {P.bottom.enabled && <RegionStrip region="bottom" horizontal {...{ surface, edit, sel, instances, onSelect, onRemove }} />}
      </div>
    </div>
  )
}

function regionWidgets(surface: Surface, region: Target): Placement[] {
  if (region === 'header') return surface.header.widgets
  if (region === 'footer') return surface.footer.widgets
  if (region === 'main') return surface.main.widgets
  return surface.pullouts[region].widgets
}

function RegionStrip({ region, surface, edit, sel, instances, onSelect, onRemove, horizontal, small }: {
  region: Exclude<Target, 'main'>; surface: Surface; edit: boolean; sel: { region: Target; i: string } | null
  instances: { id: string; typeId: string; name: string }[]
  onSelect: (r: Target, i: string) => void; onRemove: (r: Target, i: string) => void; horizontal?: boolean; small?: boolean
}) {
  const widgets = regionWidgets(surface, region)
  return (
    <div className={cn('shrink-0 bg-muted/20 flex gap-1 p-1 overflow-auto',
      horizontal ? (small ? 'h-14' : 'h-24') : 'w-40 flex-col',
      'border-border/50', horizontal ? 'border-y' : 'border-x')}>
      {widgets.length === 0 && <div className="text-[10px] text-muted-foreground/40 grid place-items-center w-full uppercase tracking-wider">{region}</div>}
      {widgets.map((p) => (
        <div key={p.i} onClick={(e) => { e.stopPropagation(); if (edit) onSelect(region, p.i) }}
          className={cn('relative shrink-0', horizontal ? (small ? 'w-40 h-full' : 'w-52 h-full') : 'w-full h-24',
            edit && sel?.i === p.i && 'ring-1 ring-primary rounded-lg')}>
          <WidgetView p={p} instances={instances} />
          {edit && <button onClick={(e) => { e.stopPropagation(); onRemove(region, p.i) }} className="absolute top-0.5 right-0.5 p-0.5 rounded bg-background/80 hover:text-destructive"><X className="size-3" /></button>}
        </div>
      ))}
    </div>
  )
}

function MainGrid({ surface, edit, sel, instances, onSelect, onRemove, onLayout }: {
  surface: Surface; edit: boolean; sel: { region: Target; i: string } | null
  instances: { id: string; typeId: string; name: string }[]
  onSelect: (r: Target, i: string) => void; onRemove: (r: Target, i: string) => void; onLayout: (l: Layout[]) => void
}) {
  const [ref, { w, h }] = useMeasure<HTMLDivElement>()
  const { cols, rows } = gridDims(surface.display)
  const rowH = h > 0 ? h / rows : 44
  const cellW = w > 0 ? w / cols : 44
  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-hidden relative">
      {edit && w > 0 && h > 0 && (
        <div className="absolute inset-0 pointer-events-none z-0"
          style={{ backgroundSize: `${cellW}px ${rowH}px`, backgroundImage: 'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)', opacity: 0.5 }} />
      )}
      {w > 0 && h > 0 && (
        <Grid className="layout relative z-10" layouts={{ lg: surface.main.layout }} breakpoints={{ lg: 0 }} cols={{ lg: cols }}
          rowHeight={rowH} maxRows={rows} margin={[0, 0]} containerPadding={[0, 0]} compactType={null} preventCollision isBounded
          isDraggable={edit} isResizable={edit} draggableHandle=".widget-drag-handle" draggableCancel=".widget-no-drag"
          onLayoutChange={(l: Layout[]) => onLayout(l)}>
          {surface.main.widgets.map((p) => (
            <div key={p.i} className="p-[3px]" onClick={(e) => { e.stopPropagation(); if (edit) onSelect('main', p.i) }}>
              <WidgetView p={p} instances={instances} edit={edit} selected={sel?.region === 'main' && sel.i === p.i}
                onSelect={() => onSelect('main', p.i)} onRemove={() => onRemove('main', p.i)} />
            </div>
          ))}
        </Grid>
      )}
    </div>
  )
}

function SurfacePicker({ list, current, onPick, onNew }: { list: { id: string; name: string }[]; current: Surface; onPick: (id: string) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent border border-border">{current.name || 'Surfaces'} <ChevronDown className="size-3" /></button>
      {open && <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-border bg-popover shadow-2xl p-1" onMouseLeave={() => setOpen(false)}>
        {list.map((s) => <button key={s.id} onClick={() => { onPick(s.id); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent">{s.name}</button>)}
        <button onClick={() => { onNew(); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent text-muted-foreground border-t border-border/40 mt-1"><Plus className="size-3 inline mr-1" /> New surface</button>
      </div>}
    </div>
  )
}

function AddDialog({ surface, instances, types, onAdd, onClose }: { surface: Surface; instances: Instance[]; types: ConnectorType[]; onAdd: (t: Target, typeId: string, instanceId: string, widgetType: string) => void; onClose: () => void }) {
  const targets: Target[] = ['main', ...(surface.header.enabled ? ['header'] as Target[] : []), ...(surface.footer.enabled ? ['footer'] as Target[] : []), ...EDGES.filter((e) => surface.pullouts[e].enabled)]
  const [target, setTarget] = useState<Target>('main')
  const sources = [...types.filter((t) => instances.some((i) => i.typeId === t.typeId)), { typeId: '__platform__', displayName: 'Platform' } as ConnectorType]
  const [typeId, setTypeId] = useState(sources[0]?.typeId ?? '')
  const platform = typeId === '__platform__'
  const [mode, setMode] = useState<'overview' | 'instance'>('instance')
  const insts = instances.filter((i) => i.typeId === typeId)
  const [instanceId, setInstanceId] = useState(insts[0]?.id ?? '')
  const all = platform ? widgetsForType(null) : widgetsForType(typeId)
  const overviewW = all.filter((w) => w.multi)
  const instanceW = all.filter((w) => !w.multi)
  const widgets = platform || mode === 'overview' ? (platform ? all : overviewW) : instanceW
  const [widgetType, setWidgetType] = useState(widgets[0]?.type ?? '')
  useEffect(() => {
    const n = instances.filter((i) => i.typeId === typeId); setInstanceId(n[0]?.id ?? '')
    const w = typeId === '__platform__' ? widgetsForType(null) : widgetsForType(typeId)
    if (typeId !== '__platform__' && w.filter((x) => !x.multi).length === 0) setMode('overview')
  }, [typeId])
  useEffect(() => { const w = platform ? all : (mode === 'overview' ? overviewW : instanceW); setWidgetType(w[0]?.type ?? '') }, [typeId, mode, platform])
  const needInstance = !platform && mode === 'instance'
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 grid place-items-center" onClick={onClose}>
      <div className="w-[440px] rounded-xl border border-border bg-background p-5 space-y-3.5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-bold">Add widget</h2>
        <F label="Place in">
          <select value={target} onChange={(e) => setTarget(e.target.value as Target)} className={sc}>
            {targets.map((t) => (<option key={t} value={t}>{t === 'main' ? 'Main grid' : cap(t)}</option>))}
          </select>
        </F>
        <F label="Connector">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={sc}>
            {sources.map((t) => (<option key={t.typeId} value={t.typeId}>{t.displayName}</option>))}
          </select>
        </F>
        {!platform ? (
          <div className="flex gap-2">
            {MODES.map((m) => (
              <button key={m} onClick={() => setMode(m)} className={cn('flex-1 text-[12px] rounded-md py-1.5 border capitalize', mode === m ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
                {m === 'instance' ? 'This instance' : 'Overview (all)'}
              </button>
            ))}
          </div>
        ) : null}
        {needInstance ? (
          <F label="Instance">
            <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)} className={sc}>
              {insts.map((i) => (<option key={i.id} value={i.id}>{i.name}</option>))}
            </select>
          </F>
        ) : null}
        <F label="Widget">
          <select value={widgetType} onChange={(e) => setWidgetType(e.target.value)} className={sc}>
            {widgets.map((w) => (<option key={w.type} value={w.type}>{w.label}</option>))}
          </select>
        </F>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md hover:bg-accent">Cancel</button>
          <button onClick={() => onAdd(target, typeId, instanceId, widgetType)} disabled={(needInstance && !instanceId) || !widgetType} className="text-[12px] px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40">Add</button>
        </div>
      </div>
    </div>
  )
}
const sc = 'w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]'
const MODES = ['instance', 'overview'] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
function F({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1"><span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>{children}</label> }

function ConfigPanel({ placement, instances, types, onChange, onClose }: {
  placement: Placement; instances: Instance[]; types: CType[]; onChange: (patch: Partial<Placement>) => void; onClose: () => void
}) {
  const inst = instances.find((i) => i.id === placement.instanceId)
  const type = types.find((t) => t.typeId === (inst?.typeId ?? placement.config.typeId))
  const streams = type?.streams ?? []
  const def = getWidget(placement.widgetType)
  const curStream = streams.find((s) => s.id === placement.config.stream)
  const set = (k: string, v: unknown) => onChange({ config: { [k]: v } })
  return (
    <aside className="w-64 shrink-0 border-l border-border/70 overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between"><h3 className="text-[12px] font-bold uppercase tracking-wider">{def?.label}</h3><button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">done</button></div>
      <F label="Title"><input value={placement.title ?? ''} placeholder={def?.label} onChange={(e) => onChange({ title: e.target.value })} className={sc} /></F>
      {def?.configFields?.map((f) => {
        if (f.kind === 'stream') return <F key={f.key} label="Stream"><select value={String(placement.config.stream ?? '')} onChange={(e) => set('stream', e.target.value)} className={sc}>{streams.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></F>
        if (f.kind === 'field') return <F key={f.key} label="Field"><select value={String(placement.config.field ?? '')} onChange={(e) => set('field', e.target.value)} className={sc}>{(curStream?.fields ?? []).map((x) => <option key={x.id} value={x.id}>{x.label ?? x.id}</option>)}</select></F>
        return <F key={f.key} label={f.label}><input type={f.kind === 'number' ? 'number' : 'text'} value={String(placement.config[f.key] ?? '')} onChange={(e) => set(f.key, f.kind === 'number' ? Number(e.target.value) : e.target.value)} className={sc} /></F>
      })}
    </aside>
  )
}
