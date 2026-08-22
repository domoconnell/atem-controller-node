'use client'
import { useCallback, useEffect, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useMicDefs } from '@/widgets/mics'
import { cn } from '@/lib/utils'
import { Plus, Trash2, ChevronDown, ChevronUp, Play, SkipForward, SkipBack, Square, X, Upload, Link2, Link2Off, RefreshCw, Star, Heading, RotateCcw } from 'lucide-react'
import { isValidDuration, isValidClock } from '@/lib/runsheet'
import { useTopic } from '@/hooks/use-topic'

interface Person { name: string; micId?: string; lead?: boolean }
interface Segment { id: string; title: string; titleOverride?: string; time?: string; people: Person[]; proItemId?: string; kind?: 'header'; color?: string; flexible?: boolean }
interface ProLink { playlistId: string; playlistName?: string; lastSync?: number }
interface Service { id: string; name: string; sortOrder?: number; segments?: Segment[]; activeIndex?: number | null; proLink?: ProLink; startTime?: string; startSegmentId?: string }
interface MicDef { id: string; label: string }
interface Playlist { id: string; name: string; path?: string }

const uid = () => Math.random().toString(36).slice(2, 9)

/** Parse a runsheet CSV. Columns (any order, case-insensitive):
 *  Segment, Time, Person, Mic  — rows with the same Segment group into one. */
function parseCsv(text: string, mics: MicDef[]): Segment[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const iSeg = header.indexOf('segment'), iTime = header.indexOf('time'), iPerson = header.indexOf('person'), iMic = header.indexOf('mic')
  const micByLabel = new Map(mics.map((m) => [m.label.toLowerCase(), m.id]))
  const segs: Segment[] = []; const byTitle = new Map<string, Segment>()
  for (const line of lines.slice(1)) {
    const c = line.split(',').map((x) => x.trim())
    const title = (iSeg >= 0 ? c[iSeg] : c[0]) || 'Segment'
    let seg = byTitle.get(title)
    if (!seg) { seg = { id: uid(), title, time: iTime >= 0 ? c[iTime] : undefined, people: [] }; byTitle.set(title, seg); segs.push(seg) }
    const person = iPerson >= 0 ? c[iPerson] : ''
    if (person) seg.people.push({ name: person, micId: iMic >= 0 ? micByLabel.get((c[iMic] ?? '').toLowerCase()) : undefined })
  }
  return segs
}

function useServices() {
  // Read over the shared WebSocket — server-side ProPresenter syncs and every
  // other client's edits flow in as pushes; mutations below still POST/PATCH,
  // and the resulting hub broadcast updates this list. No polling.
  const topic = useTopic('feature:services') as { services?: Service[] } | null
  const services = topic?.services ?? []
  const save = useCallback(async (s: Partial<Service> & { id?: string }) => {
    const method = s.id ? 'PATCH' : 'POST'
    const url = s.id ? `/api/features/services/${s.id}` : '/api/features/services'
    const b = await (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) })).json()
    return b.services as Service[]
  }, [])
  const remove = useCallback(async (id: string) => { await fetch(`/api/features/services/${id}`, { method: 'DELETE' }) }, [])
  const syncNow = useCallback(async (id: string) => { await fetch(`/api/features/services/${id}/sync`, { method: 'POST' }) }, [])
  return { services, save, remove, syncNow }
}

const sc = 'bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]'

export default function RunsheetPage() {
  const { state, connected, tick } = useAtemState()
  const { services, save, remove, syncNow } = useServices()
  const mics = useMicDefs()
  const [selId, setSelId] = useState<string | null>(null)
  const svc = services.find((s) => s.id === selId) ?? services[0] ?? null
  useEffect(() => { if (!selId && services[0]) setSelId(services[0].id) }, [selId, services])

  const segments = svc?.segments ?? []
  const active = svc?.activeIndex ?? null

  // Persist a change to the current service.
  const update = (patch: Partial<Service>) => { if (svc) save({ id: svc.id, ...patch }) }
  const setSegments = (segs: Segment[]) => update({ segments: segs })

  // Headers are section dividers — the running position skips over them.
  const nextItem = (from: number | null, dir: 1 | -1): number | null => {
    let i = from == null ? (dir === 1 ? -1 : segments.length) : from
    do { i += dir } while (i >= 0 && i < segments.length && segments[i]?.kind === 'header')
    return i >= 0 && i < segments.length ? i : from
  }
  const firstItem = segments.findIndex((s) => s.kind !== 'header')
  const lastItem = (() => { for (let i = segments.length - 1; i >= 0; i--) if (segments[i]?.kind !== 'header') return i; return -1 })()

  // Just move the playhead — the server re-cues the mapped mics.
  const goto = (idx: number | null) => update({ activeIndex: idx })
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= segments.length) return; const c = [...segments]; [c[i], c[j]] = [c[j], c[i]]; setSegments(c) }
  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const segs = parseCsv(String(reader.result), mics)
      if (!segs.length) return
      const list = await save({ name: file.name.replace(/\.csv$/i, '') || 'Imported', segments: segs })
      const created = list[list.length - 1]; if (created) setSelId(created.id)
    }
    reader.readAsText(file); e.target.value = ''
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="runsheet" state={state} wsConnected={connected} tick={tick}>
          <ServicePicker services={services} current={svc} onPick={setSelId}
            onNew={async () => { const list = await save({ name: 'New service', segments: [] }); const created = list[list.length - 1]; if (created) setSelId(created.id) }} />
          {svc && <input value={svc.name} onChange={(e) => update({ name: e.target.value })} className={cn(sc, 'w-40')} />}
          {svc && <input value={svc.startTime ?? ''} onChange={(e) => update({ startTime: e.target.value })} placeholder="Start 10:30"
            title="Service start time (wall clock) — the estimated finish is measured against this"
            className={cn(sc, 'w-24 tabular-nums', !isValidClock(svc.startTime) && 'border-destructive text-destructive')} />}
          {svc && <select value={svc.startSegmentId ?? ''} onChange={(e) => update({ startSegmentId: e.target.value || undefined })}
            title="Which item the start time applies to — items before it (pre-roll, countdown) are pre-service"
            className={cn(sc, 'max-w-[150px]')}>
            <option value="">Starts at first item</option>
            {segments.filter((s) => s.kind !== 'header').map((s) => <option key={s.id} value={s.id}>↳ {s.titleOverride || s.title}</option>)}
          </select>}
          {svc && <ProLinkControl link={svc.proLink}
            onLink={async (pl) => { await save({ id: svc.id, proLink: { playlistId: pl.id, playlistName: pl.path || pl.name } }); await syncNow(svc.id) }}
            onUnlink={() => save({ id: svc.id, proLink: null as unknown as undefined })}
            onResync={() => syncNow(svc.id)} />}
          <label className="cursor-pointer inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 border border-border hover:bg-accent" title="Import a CSV: columns Segment, Time, Person, Mic">
            <Upload className="size-3.5" /> CSV
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onImport} />
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => goto(firstItem < 0 ? null : firstItem)} disabled={firstItem < 0} className="inline-flex items-center gap-1 text-[12px] rounded-md px-2.5 py-1.5 bg-live/15 text-live hover:bg-live/25 disabled:opacity-40"><Play className="size-3.5" /> Start</button>
            <button onClick={() => goto(active == null ? firstItem : nextItem(active, -1))} disabled={active == null || active <= firstItem} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30"><SkipBack className="size-4" /></button>
            <button onClick={() => goto(active == null ? firstItem : nextItem(active, 1))} disabled={active == null || active >= lastItem} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30"><SkipForward className="size-4" /></button>
            <button onClick={() => goto(null)} disabled={active == null} className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30" title="Stop / clear cues"><Square className="size-4" /></button>
          </div>
        </AppHeader>

        <main className="flex-1 min-h-0 overflow-y-auto p-4">
          {!svc ? (
            <div className="h-full grid place-items-center text-muted-foreground text-sm">No service — create one from the picker.</div>
          ) : (
            <div className="max-w-[900px] mx-auto space-y-2">
              {segments.map((seg, i) => seg.kind === 'header' ? (
                <HeaderRow key={seg.id} seg={seg} idx={i} count={segments.length} synced={!!seg.proItemId}
                  onChange={(s) => setSegments(segments.map((x, j) => j === i ? s : x))}
                  onRemove={() => setSegments(segments.filter((_, j) => j !== i))}
                  onMove={(dir) => move(i, dir)} />
              ) : (
                <SegmentRow key={seg.id} seg={seg} idx={i} count={segments.length} state={active} mics={mics} synced={!!seg.proItemId}
                  onChange={(s) => setSegments(segments.map((x, j) => j === i ? s : x))}
                  onRemove={() => setSegments(segments.filter((_, j) => j !== i))}
                  onMove={(dir) => move(i, dir)}
                  onGoto={() => goto(i)} />
              ))}
              <div className="flex gap-2">
                <button onClick={() => setSegments([...segments, { id: uid(), title: 'Segment', people: [] }])}
                  className="flex-1 rounded-lg border border-dashed border-border/70 py-3 text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground inline-flex items-center justify-center gap-1.5">
                  <Plus className="size-3.5" /> Add segment
                </button>
                <button onClick={() => setSegments([...segments, { id: uid(), kind: 'header', title: 'Section', people: [] }])}
                  className="rounded-lg border border-dashed border-border/70 px-4 py-3 text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground inline-flex items-center justify-center gap-1.5">
                  <Heading className="size-3.5" /> Add header
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  )
}

/** A section divider. From ProPresenter it's read-only (title + colour synced);
 *  added manually it's an editable, reorderable, removable label. */
function HeaderRow({ seg, idx, count, synced, onChange, onRemove, onMove }: {
  seg: Segment; idx: number; count: number; synced?: boolean
  onChange: (s: Segment) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void
}) {
  const color = seg.color || '#6b7280'
  return (
    <div className="flex items-center gap-2 pt-4 pb-0.5">
      {synced ? <span className="w-4 shrink-0" /> : (
        <div className="flex flex-col shrink-0 -my-1">
          <button onClick={() => onMove(-1)} disabled={idx === 0} className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"><ChevronUp className="size-3.5" /></button>
          <button onClick={() => onMove(1)} disabled={idx === count - 1} className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"><ChevronDown className="size-3.5" /></button>
        </div>
      )}
      <span className="h-5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
      {synced ? (
        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <input value={seg.titleOverride ?? seg.title}
            onChange={(e) => { const v = e.target.value; onChange({ ...seg, titleOverride: v === seg.title ? undefined : v }) }}
            className="flex-1 min-w-0 bg-transparent text-[11px] font-bold uppercase tracking-[0.16em] outline-none border-b border-transparent focus:border-border" />
          {seg.titleOverride != null && (
            <button onClick={() => onChange({ ...seg, titleOverride: undefined })} title={`Reset to ProPresenter title: “${seg.title}”`} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"><RotateCcw className="size-3.5" /></button>
          )}
          <span className="shrink-0 text-[8px] font-black uppercase tracking-wider rounded px-1 py-0.5 bg-primary/15 text-primary" title={`Synced from ProPresenter: ${seg.title}`}>PP</span>
        </span>
      ) : (
        <input value={seg.title} onChange={(e) => onChange({ ...seg, title: e.target.value })} placeholder="Section" className="flex-1 bg-transparent text-[11px] font-bold uppercase tracking-[0.16em] outline-none border-b border-transparent focus:border-border" />
      )}
      <div className="flex-1 h-px bg-border/50" />
      {synced ? <span className="w-7.5 shrink-0" /> : <button onClick={onRemove} className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"><Trash2 className="size-3.5" /></button>}
    </div>
  )
}

function SegmentRow({ seg, idx, count, state, mics, synced, onChange, onRemove, onMove, onGoto }: {
  seg: Segment; idx: number; count: number; state: number | null; mics: { id: string; label: string }[]; synced?: boolean
  onChange: (s: Segment) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void; onGoto: () => void
}) {
  const isNow = state === idx, isNext = state != null && state + 1 === idx
  const setPeople = (people: Person[]) => onChange({ ...seg, people })
  return (
    <div className={cn('rounded-xl border p-3 space-y-2', isNow ? 'border-live bg-live/[0.06]' : isNext ? 'border-busy/60 bg-busy/[0.04]' : 'border-border/60 bg-card')}>
      <div className="flex items-center gap-2">
        {synced ? (
          // Order & membership come from ProPresenter — no reorder handles.
          <span className="w-4 shrink-0" />
        ) : (
          <div className="flex flex-col shrink-0 -my-1">
            <button onClick={() => onMove(-1)} disabled={idx === 0} className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"><ChevronUp className="size-3.5" /></button>
            <button onClick={() => onMove(1)} disabled={idx === count - 1} className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground disabled:opacity-20"><ChevronDown className="size-3.5" /></button>
          </div>
        )}
        <button onClick={onGoto} className={cn('shrink-0 w-16 text-center text-[9px] font-black uppercase tracking-wider rounded px-1 py-0.5', isNow ? 'bg-live text-black' : isNext ? 'bg-busy text-black' : 'bg-muted/60 text-muted-foreground hover:bg-muted')}>
          {isNow ? 'NOW' : isNext ? 'NEXT' : `#${idx + 1}`}</button>
        {synced ? (
          <div className="flex-1 flex items-center gap-1.5 min-w-0">
            {/* Editable rename: overrides the PP title locally, kept across syncs. */}
            <input value={seg.titleOverride ?? seg.title}
              onChange={(e) => { const v = e.target.value; onChange({ ...seg, titleOverride: v === seg.title ? undefined : v }) }}
              className={cn(sc, 'flex-1 min-w-0 font-semibold')} />
            {seg.titleOverride != null && (
              <button onClick={() => onChange({ ...seg, titleOverride: undefined })} title={`Reset to ProPresenter title: “${seg.title}”`} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"><RotateCcw className="size-3.5" /></button>
            )}
            <span className="shrink-0 text-[8px] font-black uppercase tracking-wider rounded px-1 py-0.5 bg-primary/15 text-primary" title={`Synced from ProPresenter: ${seg.title}`}>PP</span>
          </div>
        ) : (
          <input value={seg.title} onChange={(e) => onChange({ ...seg, title: e.target.value })} placeholder="Segment title" className={cn(sc, 'flex-1 font-semibold')} />
        )}
        <input value={seg.time ?? ''} onChange={(e) => onChange({ ...seg, time: e.target.value })} placeholder="10:00"
          title={isValidDuration(seg.time) ? 'Planned duration — M:SS or H:MM:SS' : 'Invalid time — use M:SS or H:MM:SS'}
          className={cn(sc, 'w-20 tabular-nums', !isValidDuration(seg.time) && 'border-destructive text-destructive focus:border-destructive')} />
        <button onClick={() => onChange({ ...seg, flexible: !seg.flexible })}
          title={seg.flexible ? 'Flexible — may be shortened to catch up (a talk/message). Click to make fixed.' : 'Fixed length (e.g. a song). Click to allow shortening to keep on time.'}
          className={cn('shrink-0 w-11 rounded px-1 py-1 text-[9px] font-black uppercase tracking-wider', seg.flexible ? 'bg-busy/15 text-busy' : 'bg-muted/40 text-muted-foreground/50 hover:text-muted-foreground')}>
          {seg.flexible ? 'Flex' : 'Fixed'}
        </button>
        {synced
          ? <span className="w-7.5 shrink-0" />
          : <button onClick={onRemove} className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"><Trash2 className="size-3.5" /></button>}
      </div>
      <div className="pl-7 flex flex-wrap gap-1.5">
        {seg.people.map((p, i) => (
          <div key={i} className={cn('inline-flex items-center gap-1 rounded-md border pl-1 pr-1 py-1', p.lead ? 'border-primary/60 bg-primary/10' : 'border-border/60 bg-muted/30')}>
            <button onClick={() => setPeople(seg.people.map((x, j) => j === i ? { ...x, lead: !x.lead } : x))} title={p.lead ? 'Lead — click to unset' : 'Set as lead'}
              className={cn('p-0.5 rounded shrink-0', p.lead ? 'text-primary' : 'text-muted-foreground/40 hover:text-muted-foreground')}>
              <Star className={cn('size-3', p.lead && 'fill-current')} />
            </button>
            <input value={p.name} onChange={(e) => setPeople(seg.people.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Name" className={cn('bg-transparent text-[12px] w-20 outline-none', p.lead && 'font-semibold')} />
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

/** Link a service to a live ProPresenter playlist. When linked, the server keeps
 *  segment titles + order in sync with PP; people/mics/times are layered on here. */
function ProLinkControl({ link, onLink, onUnlink, onResync }: {
  link?: ProLink; onLink: (pl: Playlist) => void; onUnlink: () => void; onResync: () => void
}) {
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const openMenu = () => {
    setOpen((o) => !o)
    if (playlists) return
    fetch('/api/features/propresenter/playlists').then((r) => r.json()).then((b) => {
      if (b.ok) { setPlaylists(b.playlists ?? []); setErr(null) } else setErr(b.error || 'ProPresenter unreachable')
    }).catch((e) => setErr(String(e)))
  }
  if (link?.playlistId) {
    return (
      <div className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 pl-2 pr-1 py-1 text-[12px] text-primary" title="Synced from ProPresenter">
        <Link2 className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate font-medium">{link.playlistName || 'ProPresenter'}</span>
        <button onClick={onResync} className="p-1 rounded hover:bg-primary/20" title="Re-sync now"><RefreshCw className="size-3" /></button>
        <button onClick={onUnlink} className="p-1 rounded hover:bg-destructive/15 hover:text-destructive" title="Unlink"><Link2Off className="size-3" /></button>
      </div>
    )
  }
  return (
    <div className="relative">
      <button onClick={openMenu} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 border border-border hover:bg-accent" title="Link this service to a ProPresenter playlist">
        <Link2 className="size-3.5" /> Link PP
      </button>
      {open && <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-popover shadow-2xl p-1 max-h-72 overflow-y-auto" onMouseLeave={() => setOpen(false)}>
        {err && <div className="text-[11px] text-destructive px-2 py-2">{err}</div>}
        {!err && playlists == null && <div className="text-[11px] text-muted-foreground px-2 py-2">Loading playlists…</div>}
        {!err && playlists?.length === 0 && <div className="text-[11px] text-muted-foreground px-2 py-2">No playlists found in ProPresenter.</div>}
        {playlists?.map((pl) => (
          <button key={pl.id} onClick={() => { onLink(pl); setOpen(false) }} className="w-full text-left text-[12px] rounded-md px-2 py-1.5 hover:bg-accent truncate">{pl.path || pl.name}</button>
        ))}
      </div>}
    </div>
  )
}

function ServicePicker({ services, current, onPick, onNew }: { services: Service[]; current: Service | null; onPick: (id: string) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent border border-border w-44 justify-between"><span className="truncate">{current?.name || 'Services'}</span> <ChevronDown className="size-3 shrink-0" /></button>
      {open && <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-border bg-popover shadow-2xl p-1" onMouseLeave={() => setOpen(false)}>
        {services.map((s) => <button key={s.id} onClick={() => { onPick(s.id); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent">{s.name}</button>)}
        <button onClick={() => { onNew(); setOpen(false) }} className="w-full text-left text-[12.5px] rounded-md px-2 py-1.5 hover:bg-accent text-muted-foreground border-t border-border/40 mt-1"><Plus className="size-3 inline mr-1" /> New service</button>
      </div>}
    </div>
  )
}
