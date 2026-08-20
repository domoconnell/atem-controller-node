'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import dynamic from 'next/dynamic'
import '@/widgets/builtin'
import { widgetsForType, getWidget, listWidgets } from '@/widgets/registry'
import { WidgetView, type Placement } from '@/components/surfaces/widget-view'
import type { Instance, ConnectorType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Plus, Pencil, Save, Eye, Trash2, ChevronDown, ExternalLink } from 'lucide-react'

const Grid = dynamic(() => import('@/components/surfaces/grid'), { ssr: false })
type Layout = { i: string; x: number; y: number; w: number; h: number }
interface Surface { id: string; name: string; widgets: Placement[]; layout: Layout[] }

export default function SurfacesPage() {
  const { state, connected, tick } = useAtemState()
  const [instances, setInstances] = useState<Instance[]>([])
  const [types, setTypes] = useState<(ConnectorType & { streams?: { id: string; label: string; fields?: { id: string; label?: string }[] }[] })[]>([])
  const [surfaces, setSurfaces] = useState<{ id: string; name: string }[]>([])
  const [surface, setSurface] = useState<Surface | null>(null)
  const [edit, setEdit] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances(b.instances ?? [])).catch(() => {})
    fetch('/api/connector-types').then((r) => r.json()).then((b) => setTypes(b.types ?? [])).catch(() => {})
    fetch('/api/surfaces').then((r) => r.json()).then((b) => {
      setSurfaces(b.surfaces ?? [])
      if (b.surfaces?.[0]) loadSurface(b.surfaces[0].id)
      else setSurface({ id: '', name: 'New surface', widgets: [], layout: [] })
    }).catch(() => {})
  }, [])

  const loadSurface = useCallback(async (id: string) => {
    const b = await fetch(`/api/surfaces/${id}`).then((r) => r.json()).catch(() => null)
    if (b?.surface) setSurface({ id, name: b.surface.name, widgets: b.surface.widgets ?? [], layout: b.surface.layout ?? [] })
  }, [])

  const save = async () => {
    if (!surface) return
    const body = { id: surface.id || undefined, name: surface.name, widgets: surface.widgets, layout: surface.layout }
    const r = await fetch(surface.id ? `/api/surfaces/${surface.id}` : '/api/surfaces', {
      method: surface.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json())
    const id = surface.id || r.id
    setSurface((s) => s && { ...s, id })
    fetch('/api/surfaces').then((x) => x.json()).then((b) => setSurfaces(b.surfaces ?? []))
  }

  const addWidget = (typeId: string, instanceId: string, widgetType: string) => {
    const def = getWidget(widgetType); if (!def || !surface) return
    const t = types.find((x) => x.typeId === typeId)
    const firstStream = t?.streams?.[0]
    const firstField = firstStream?.fields?.[0]
    const i = `w${Date.now().toString(36)}`
    const placement: Placement = { i, widgetType, instanceId,
      config: { stream: firstStream?.id, field: firstField?.id }, title: '' }
    const y = surface.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0)
    setSurface({ ...surface, widgets: [...surface.widgets, placement], layout: [...surface.layout, { i, x: 0, y, w: def.defaultSize.w, h: def.defaultSize.h }] })
    setAdding(false); setSel(i)
  }
  const removeWidget = (i: string) => setSurface((s) => s && ({ ...s, widgets: s.widgets.filter((w) => w.i !== i), layout: s.layout.filter((l) => l.i !== i) }))
  const patchWidget = (i: string, patch: Partial<Placement>) => setSurface((s) => s && ({ ...s, widgets: s.widgets.map((w) => w.i === i ? { ...w, ...patch, config: { ...w.config, ...(patch.config ?? {}) } } : w) }))

  const selected = surface?.widgets.find((w) => w.i === sel) ?? null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="surfaces" state={state} wsConnected={connected} tick={tick}>
          <div className="ml-auto flex items-center gap-2">
            <SurfacePicker surfaces={surfaces} current={surface} onPick={loadSurface} onNew={() => { setSurface({ id: '', name: 'New surface', widgets: [], layout: [] }); setSel(null) }} />
            {surface && edit && (
              <input value={surface.name} onChange={(e) => setSurface({ ...surface, name: e.target.value })}
                className="bg-input/40 border border-border rounded-md px-2 py-1 text-[12px] w-40" />
            )}
            <button onClick={() => setAdding(true)} disabled={!edit} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent disabled:opacity-40"><Plus className="size-3.5" /> Widget</button>
            <button onClick={() => setEdit((e) => !e)} className={cn('inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5', edit ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>{edit ? <><Eye className="size-3.5" /> View</> : <><Pencil className="size-3.5" /> Edit</>}</button>
            <button onClick={save} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 bg-live text-black font-medium hover:opacity-90"><Save className="size-3.5" /> Save</button>
            {surface?.id && <a href={`/surface?s=${surface.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
          </div>
        </AppHeader>

        <div className="flex-1 min-h-0 flex">
          <main className="flex-1 min-h-0 overflow-auto p-3" onClick={() => setSel(null)}>
            {surface && (
              <Grid className="layout" layouts={{ lg: surface.layout }} breakpoints={{ lg: 0 }} cols={{ lg: 12 }}
                rowHeight={44} margin={[10, 10]} isDraggable={edit} isResizable={edit}
                draggableHandle=".widget-drag-handle" draggableCancel=".widget-no-drag"
                onLayoutChange={(l: Layout[]) => setSurface((s) => s && ({ ...s, layout: l as Layout[] }))}>
                {surface.widgets.map((p) => (
                  <div key={p.i} onClick={(e) => { e.stopPropagation(); if (edit) setSel(p.i) }}>
                    <WidgetView p={p} edit={edit} selected={sel === p.i} onSelect={() => setSel(p.i)} onRemove={() => removeWidget(p.i)} />
                  </div>
                ))}
              </Grid>
            )}
            {surface && surface.widgets.length === 0 && (
              <div className="h-full grid place-items-center text-muted-foreground text-sm">Empty surface — add a widget.</div>
            )}
          </main>

          {edit && selected && (
            <ConfigPanel key={selected.i} placement={selected} instances={instances} types={types}
              onChange={(patch) => patchWidget(selected.i, patch)} onClose={() => setSel(null)} />
          )}
        </div>

        {adding && <AddWidgetDialog instances={instances} types={types} onAdd={addWidget} onClose={() => setAdding(false)} />}
      </div>
    </TooltipProvider>
  )
}

function SurfacePicker({ surfaces, current, onPick, onNew }: { surfaces: { id: string; name: string }[]; current: Surface | null; onPick: (id: string) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent border border-border">
        {current?.name || 'Surfaces'} <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-border bg-popover shadow-2xl p-1" onMouseLeave={() => setOpen(false)}>
          {surfaces.map((s) => <button key={s.id} onClick={() => { onPick(s.id); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent">{s.name}</button>)}
          <button onClick={() => { onNew(); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent text-muted-foreground border-t border-border/40 mt-1"><Plus className="size-3 inline mr-1" /> New surface</button>
        </div>
      )}
    </div>
  )
}

function AddWidgetDialog({ instances, types, onAdd, onClose }: { instances: Instance[]; types: ConnectorType[]; onAdd: (typeId: string, instanceId: string, widgetType: string) => void; onClose: () => void }) {
  const withInstances = types.filter((t) => instances.some((i) => i.typeId === t.typeId))
  const [typeId, setTypeId] = useState(withInstances[0]?.typeId ?? '')
  const insts = instances.filter((i) => i.typeId === typeId)
  const [instanceId, setInstanceId] = useState(insts[0]?.id ?? '')
  const widgets = widgetsForType(typeId)
  const [widgetType, setWidgetType] = useState(widgets[0]?.type ?? 'stat')
  useEffect(() => { const n = instances.filter((i) => i.typeId === typeId); setInstanceId(n[0]?.id ?? ''); const w = widgetsForType(typeId); setWidgetType(w[0]?.type ?? 'stat') }, [typeId])
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 grid place-items-center" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-border bg-background p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-bold">Add widget</h2>
        <Field label="Connector"><select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]">{withInstances.map((t) => <option key={t.typeId} value={t.typeId}>{t.displayName}</option>)}</select></Field>
        <Field label="Instance"><select value={instanceId} onChange={(e) => setInstanceId(e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]">{insts.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="Widget"><select value={widgetType} onChange={(e) => setWidgetType(e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]">{widgets.map((w) => <option key={w.type} value={w.type}>{w.label}</option>)}</select></Field>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md hover:bg-accent">Cancel</button>
          <button onClick={() => onAdd(typeId, instanceId, widgetType)} disabled={!instanceId} className="text-[12px] px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40">Add</button>
        </div>
      </div>
    </div>
  )
}

function ConfigPanel({ placement, instances, types, onChange, onClose }: {
  placement: Placement; instances: Instance[]
  types: (ConnectorType & { streams?: { id: string; label: string; fields?: { id: string; label?: string }[] }[] })[]
  onChange: (patch: Partial<Placement>) => void; onClose: () => void
}) {
  const inst = instances.find((i) => i.id === placement.instanceId)
  const type = types.find((t) => t.typeId === inst?.typeId)
  const streams = type?.streams ?? []
  const def = getWidget(placement.widgetType)
  const curStream = streams.find((s) => s.id === placement.config.stream)
  const set = (k: string, v: unknown) => onChange({ config: { [k]: v } })
  return (
    <aside className="w-64 shrink-0 border-l border-border/70 overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-bold uppercase tracking-wider">{def?.label}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">done</button>
      </div>
      <Field label="Title"><input value={placement.title ?? ''} placeholder={def?.label} onChange={(e) => onChange({ title: e.target.value })} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]" /></Field>
      {def?.configFields?.map((f) => {
        if (f.kind === 'stream') return <Field key={f.key} label="Stream"><select value={String(placement.config.stream ?? '')} onChange={(e) => set('stream', e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]">{streams.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
        if (f.kind === 'field') return <Field key={f.key} label="Field"><select value={String(placement.config.field ?? '')} onChange={(e) => set('field', e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]">{(curStream?.fields ?? []).map((x) => <option key={x.id} value={x.id}>{x.label ?? x.id}</option>)}</select></Field>
        return <Field key={f.key} label={f.label}><input type={f.kind === 'number' ? 'number' : 'text'} value={String(placement.config[f.key] ?? '')} onChange={(e) => set(f.key, f.kind === 'number' ? Number(e.target.value) : e.target.value)} className="w-full bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]" /></Field>
      })}
    </aside>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>{children}</label>
}
