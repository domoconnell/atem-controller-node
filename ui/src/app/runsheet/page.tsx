'use client'
import { useCallback, useEffect, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useMicDefs } from '@/widgets/mics'
import { cn } from '@/lib/utils'
import { Plus, Trash2, ChevronDown, Play, SkipForward, SkipBack, Square, GripVertical, X } from 'lucide-react'

interface Person { name: string; micId?: string }
interface Segment { id: string; title: string; time?: string; people: Person[] }
interface Service { id: string; name: string; sortOrder?: number; segments?: Segment[]; activeIndex?: number | null }

const uid = () => Math.random().toString(36).slice(2, 9)

function useServices() {
  const [services, setServices] = useState<Service[]>([])
  const load = useCallback(() => fetch('/api/features/services').then((r) => r.json()).then((b) => setServices(b.services ?? [])).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const save = useCallback(async (s: Partial<Service> & { id?: string }) => {
    const method = s.id ? 'PATCH' : 'POST'
    const url = s.id ? `/api/features/services/${s.id}` : '/api/features/services'
    const b = await (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) })).json()
    setServices(b.services ?? [])
    return b.services as Service[]
  }, [])
  const remove = useCallback(async (id: string) => { const b = await (await fetch(`/api/features/services/${id}`, { method: 'DELETE' })).json(); setServices(b.services ?? []) }, [])
  return { services, save, remove }
}

const sc = 'bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]'

export default function RunsheetPage() {
  const { state, connected, tick } = useAtemState()
  const { services, save, remove } = useServices()
  const mics = useMicDefs()
  const [selId, setSelId] = useState<string | null>(null)
  const svc = services.find((s) => s.id === selId) ?? services[0] ?? null
  useEffect(() => { if (!selId && services[0]) setSelId(services[0].id) }, [selId, services])

  const segments = svc?.segments ?? []
  const active = svc?.activeIndex ?? null

  // Persist a change to the current service.
  const update = (patch: Partial<Service>) => { if (svc) save({ id: svc.id, ...patch }) }
  const setSegments = (segs: Segment[]) => update({ segments: segs })

  // Drive the mapped mics' cue from the active/next segment.
  const applyCues = useCallback(async (segs: Segment[], idx: number | null) => {
    const live = new Set(idx != null ? (segs[idx]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
    const standby = new Set(idx != null ? (segs[idx + 1]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
    await Promise.all(mics.map((m) => {
      const want = live.has(m.id) ? 'live' : standby.has(m.id) ? 'standby' : 'off'
      return (m.cue ?? 'off') === want ? null : fetch(`/api/features/mics/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cue: want }) })
    }).filter(Boolean))
  }, [mics])
  const goto = (idx: number | null) => { update({ activeIndex: idx }); applyCues(segments, idx) }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="runsheet" state={state} wsConnected={connected} tick={tick}>
          <ServicePicker services={services} current={svc} onPick={setSelId}
            onNew={async () => { const list = await save({ name: 'New service', segments: [] }); const created = list[list.length - 1]; if (created) setSelId(created.id) }} />
          {svc && <input value={svc.name} onChange={(e) => update({ name: e.target.value })} className={cn(sc, 'w-40')} />}
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => goto(0)} disabled={!segments.length} className="inline-flex items-center gap-1 text-[12px] rounded-md px-2.5 py-1.5 bg-live/15 text-live hover:bg-live/25 disabled:opacity-40"><Play className="size-3.5" /> Start</button>
            <button onClick={() => goto(active == null ? 0 : Math.max(0, active - 1))} disabled={active == null} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30"><SkipBack className="size-4" /></button>
            <button onClick={() => goto(active == null ? 0 : Math.min(segments.length - 1, active + 1))} disabled={active == null || active >= segments.length - 1} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30"><SkipForward className="size-4" /></button>
            <button onClick={() => goto(null)} disabled={active == null} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30" title="Stop / clear cues"><Square className="size-4" /></button>
          </div>
        </AppHeader>

        <main className="flex-1 min-h-0 overflow-y-auto p-4">
          {!svc ? (
            <div className="h-full grid place-items-center text-muted-foreground text-sm">No service — create one from the picker.</div>
          ) : (
            <div className="max-w-[900px] mx-auto space-y-2">
              {segments.map((seg, i) => (
                <SegmentRow key={seg.id} seg={seg} idx={i} state={active} mics={mics}
                  onChange={(s) => setSegments(segments.map((x, j) => j === i ? s : x))}
                  onRemove={() => setSegments(segments.filter((_, j) => j !== i))}
                  onGoto={() => goto(i)} />
              ))}
              <button onClick={() => setSegments([...segments, { id: uid(), title: 'Segment', people: [] }])}
                className="w-full rounded-lg border border-dashed border-border/70 py-3 text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground inline-flex items-center justify-center gap-1.5">
                <Plus className="size-3.5" /> Add segment
              </button>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  )
}

function SegmentRow({ seg, idx, state, mics, onChange, onRemove, onGoto }: {
  seg: Segment; idx: number; state: number | null; mics: { id: string; label: string }[]
  onChange: (s: Segment) => void; onRemove: () => void; onGoto: () => void
}) {
  const isNow = state === idx, isNext = state != null && state + 1 === idx
  const setPeople = (people: Person[]) => onChange({ ...seg, people })
  return (
    <div className={cn('rounded-xl border p-3 space-y-2', isNow ? 'border-live bg-live/[0.06]' : isNext ? 'border-busy/60 bg-busy/[0.04]' : 'border-border/60 bg-card')}>
      <div className="flex items-center gap-2">
        <GripVertical className="size-4 text-muted-foreground/40 shrink-0" />
        <button onClick={onGoto} className={cn('shrink-0 w-16 text-center text-[9px] font-black uppercase tracking-wider rounded px-1 py-0.5', isNow ? 'bg-live text-black' : isNext ? 'bg-busy text-black' : 'bg-muted/60 text-muted-foreground hover:bg-muted')}>
          {isNow ? 'NOW' : isNext ? 'NEXT' : `#${idx + 1}`}</button>
        <input value={seg.title} onChange={(e) => onChange({ ...seg, title: e.target.value })} placeholder="Segment title" className={cn(sc, 'flex-1 font-semibold')} />
        <input value={seg.time ?? ''} onChange={(e) => onChange({ ...seg, time: e.target.value })} placeholder="10:00" className={cn(sc, 'w-20 tabular-nums')} />
        <button onClick={onRemove} className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"><Trash2 className="size-3.5" /></button>
      </div>
      <div className="pl-7 flex flex-wrap gap-1.5">
        {seg.people.map((p, i) => (
          <div key={i} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 pl-2 pr-1 py-1">
            <input value={p.name} onChange={(e) => setPeople(seg.people.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Name" className="bg-transparent text-[12px] w-20 outline-none" />
            <select value={p.micId ?? ''} onChange={(e) => setPeople(seg.people.map((x, j) => j === i ? { ...x, micId: e.target.value || undefined } : x))} className="bg-transparent text-[11px] text-muted-foreground outline-none max-w-[90px]">
              <option value="">no mic</option>
              {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <button onClick={() => setPeople(seg.people.filter((_, j) => j !== i))} className="p-0.5 rounded hover:text-destructive text-muted-foreground/60"><X className="size-3" /></button>
          </div>
        ))}
        <button onClick={() => setPeople([...seg.people, { name: '' }])} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground rounded-md border border-dashed border-border/60 px-2 py-1 hover:bg-accent"><Plus className="size-3" /> person</button>
      </div>
    </div>
  )
}

function ServicePicker({ services, current, onPick, onNew }: { services: Service[]; current: Service | null; onPick: (id: string) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent border border-border">{current?.name || 'Services'} <ChevronDown className="size-3" /></button>
      {open && <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-border bg-popover shadow-2xl p-1" onMouseLeave={() => setOpen(false)}>
        {services.map((s) => <button key={s.id} onClick={() => { onPick(s.id); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent">{s.name}</button>)}
        <button onClick={() => { onNew(); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent text-muted-foreground border-t border-border/40 mt-1"><Plus className="size-3 inline mr-1" /> New service</button>
      </div>}
    </div>
  )
}
