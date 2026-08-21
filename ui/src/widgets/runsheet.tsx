'use client'
import { useEffect, useRef } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useMicDefs, useMicLive, CUE, batTint, MiniBar } from './mics'
import { useTopic } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { MicOff, Star, SkipBack, SkipForward, Square } from 'lucide-react'
import type { Mic as MicObj } from '@/components/mics/mic-composite'
import {
  type Person, type Segment, type Service,
  isHeader, segTitle, nextItemIndex, prevItemIndex, firstItemIndex, lastItemIndex, sectionFor, resolveService, gotoIndex,
} from '@/lib/runsheet'

/** All services, pushed live over the shared WebSocket hub (topic
 *  'feature:services'). Every runsheet widget shares this one subscription, so
 *  they all update together the instant a change lands — no per-widget polling. */
function useServicesTopic(): Service[] {
  const d = useTopic('feature:services') as { services?: Service[] } | null
  return d?.services ?? []
}
/** Service list for the designer's "pin a service" picker. */
export function useServiceList(): Service[] { return useServicesTopic() }

/** One person + their mic's live status, compact — for strips and list rows. */
function PersonMini({ person, mics }: { person: Person; mics: MicObj[] }) {
  const mic = mics.find((m) => m.id === person.micId)
  const live = useMicLive(mic ?? ({ id: '', label: '' } as MicObj)) // stable hooks; null instance => no data
  return (
    <span className="inline-flex items-center gap-1 text-[11px] whitespace-nowrap">
      {person.lead && <Star className="size-2.5 shrink-0 fill-current text-primary" />}
      <span className={cn('truncate', person.lead && 'font-semibold')}>{person.name || '—'}</span>
      {mic && <span className={cn('text-[8px] font-black uppercase tracking-wide rounded px-1 py-px', CUE[live.cue].c)}>{CUE[live.cue].l}</span>}
      {mic && live.muted && <MicOff className="size-2.5 shrink-0 text-destructive" />}
      {mic && live.online && live.ch?.battery != null && <span className={cn('text-[9px] font-bold tabular-nums', batTint(live.ch.battery))}>{live.ch.battery}%</span>}
    </span>
  )
}

/** One person as a full row (Now/Next widget): name · mic · cue · mute · rf · battery. */
function PersonLine({ person, mics }: { person: Person; mics: MicObj[] }) {
  const mic = mics.find((m) => m.id === person.micId)
  const live = useMicLive(mic ?? ({ id: '', label: '' } as MicObj))
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      {person.lead && <Star className="size-3 shrink-0 fill-current text-primary" aria-label="Lead" />}
      <span className={cn('w-20 truncate shrink-0', person.lead ? 'font-bold' : 'font-semibold')}>{person.name || '—'}</span>
      {mic ? (
        <>
          <span className="text-muted-foreground truncate flex-1 min-w-0">{mic.label}</span>
          <span className={cn('shrink-0 text-[8px] font-black uppercase tracking-wide rounded px-1 py-0.5', CUE[live.cue].c)}>{CUE[live.cue].l}</span>
          {live.muted != null && (live.muted
            ? <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-destructive shrink-0"><MicOff className="size-3" />MUTE</span>
            : <span className="text-[9px] font-semibold text-live shrink-0">UNMUTED</span>)}
          {live.online && <MiniBar value={live.ch?.rf} kind="rf" />}
          {live.online && live.ch?.battery != null && <span className={cn('text-[10px] font-bold tabular-nums shrink-0', batTint(live.ch.battery))}>{live.ch.battery}%</span>}
        </>
      ) : <span className="text-muted-foreground/40 text-[11px] flex-1 min-w-0">— no mic —</span>}
    </div>
  )
}

function SectionLabel({ seg }: { seg: Segment }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-3 w-1 rounded-full shrink-0" style={{ background: seg.color || '#6b7280' }} />
      <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground truncate">{segTitle(seg)}</span>
    </div>
  )
}

function SegBlock({ label, tone, seg, mics }: { label: string; tone: 'live' | 'busy'; seg: Segment | null; mics: MicObj[] }) {
  return (
    <div className="mb-2.5">
      <div className={cn('text-[10px] font-bold uppercase tracking-wider mb-1', tone === 'live' ? 'text-live' : 'text-busy')}>
        {label}: <span className="text-foreground normal-case tracking-normal">{seg ? segTitle(seg) : '—'}</span>
        {seg?.time ? <span className="text-muted-foreground/60 ml-1.5 tabular-nums font-normal">{seg.time}</span> : null}
      </div>
      {(seg?.people ?? []).map((p, i) => <PersonLine key={i} person={p} mics={mics} />)}
      {(!seg || seg.people.length === 0) && <div className="text-[11px] text-muted-foreground/40 pl-1">—</div>}
    </div>
  )
}

/** The runsheet at a glance: Now + Next item with each person's mic status.
 *  Auto-follows the running service (activeIndex set); config.serviceId pins one. */
function NowNext({ config, title }: WidgetProps) {
  const services = useServicesTopic()
  const mics = useMicDefs()
  const svc = resolveService(services, config.serviceId as string | undefined)
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const now = idx != null ? segs[idx] ?? null : null
  const next = segs[idx != null ? (nextItemIndex(segs, idx) ?? -1) : (firstItemIndex(segs) ?? -1)] ?? null
  const section = sectionFor(segs, idx)
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {!svc ? <div className="text-[11px] text-muted-foreground/50">No service.</div> : (
          <>
            {section && <div className="mb-1.5"><SectionLabel seg={section} /></div>}
            <SegBlock label="Now" tone="live" seg={now} mics={mics} />
            <SegBlock label="Next" tone="busy" seg={next} mics={mics} />
          </>
        )}
      </div>
    </div>
  )
}
registerWidget({ type: 'runsheet-nownext', label: 'Runsheet · Now / Next', defaultSize: { w: 4, h: 4 }, configFields: [{ key: 'serviceId', label: 'Service', kind: 'service' }], Component: NowNext })

/** The full running order: headers as section dividers, each item with its time
 *  and who's on it (names + live mic status), NOW/NEXT highlighted, auto-scrolls. */
function RunsheetList({ config, title }: WidgetProps) {
  const services = useServicesTopic()
  const mics = useMicDefs()
  const svc = resolveService(services, config.serviceId as string | undefined)
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const nextIdx = idx != null ? nextItemIndex(segs, idx) : firstItemIndex(segs)
  const nowRef = useRef<HTMLDivElement>(null)
  useEffect(() => { nowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [idx])
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5">
        {!svc ? <div className="text-[11px] text-muted-foreground/50 px-1">No service.</div> : segs.length === 0 ? <div className="text-[11px] text-muted-foreground/50 px-1">Empty runsheet.</div> : (
          segs.map((seg, i) => isHeader(seg) ? (
            <div key={seg.id} className="flex items-center gap-2 pt-2.5 pb-1 first:pt-1">
              <span className="h-3.5 w-1 rounded-full shrink-0" style={{ background: seg.color || '#6b7280' }} />
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground truncate">{segTitle(seg)}</span>
              <div className="flex-1 h-px bg-border/40" />
            </div>
          ) : (
            <div key={seg.id} ref={i === idx ? nowRef : undefined}
              className={cn('rounded-md px-2 py-1', i === idx ? 'bg-live/15' : i === nextIdx ? 'bg-busy/10' : '')}>
              <div className="flex items-baseline gap-2">
                <span className={cn('shrink-0 w-9 text-center text-[8px] font-black uppercase tracking-wider rounded px-1 py-0.5 -translate-y-px',
                  i === idx ? 'bg-live text-black' : i === nextIdx ? 'bg-busy text-black' : 'bg-muted/50 text-muted-foreground')}>
                  {i === idx ? 'NOW' : i === nextIdx ? 'NEXT' : ''}</span>
                <span className="text-[12.5px] font-semibold truncate">{segTitle(seg)}</span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{seg.time || ''}</span>
              </div>
              {seg.people.length > 0 && (
                <div className="pl-11 pt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                  {seg.people.map((p, k) => <PersonMini key={k} person={p} mics={mics} />)}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
registerWidget({ type: 'runsheet-list', label: 'Runsheet · running order', defaultSize: { w: 4, h: 6 }, configFields: [{ key: 'serviceId', label: 'Service', kind: 'service' }], Component: RunsheetList })

/** Thin header/footer strip: section · NOW title + who's live → NEXT title + who's up. */
function RunsheetStrip({ config }: WidgetProps) {
  const services = useServicesTopic()
  const mics = useMicDefs()
  const svc = resolveService(services, config.serviceId as string | undefined)
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const now = idx != null ? segs[idx] ?? null : null
  const next = segs[idx != null ? (nextItemIndex(segs, idx) ?? -1) : (firstItemIndex(segs) ?? -1)] ?? null
  const section = sectionFor(segs, idx)
  return (
    <div className="h-full w-full flex items-center gap-2.5 px-3 rounded-lg border border-border/50 bg-card overflow-hidden">
      {section && <span className="shrink-0 inline-flex items-center gap-1.5"><span className="h-3.5 w-1 rounded-full" style={{ background: section.color || '#6b7280' }} /><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground max-w-24 truncate">{segTitle(section)}</span></span>}
      <span className="shrink-0 text-[9px] font-black uppercase tracking-wider rounded px-1.5 py-0.5 bg-live text-black">NOW</span>
      <span className="shrink-0 text-[13px] font-semibold truncate max-w-40">{now ? segTitle(now) : '—'}</span>
      {now?.time && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{now.time}</span>}
      <span className="flex items-center gap-2.5 overflow-hidden min-w-0">
        {(now?.people ?? []).map((p, i) => <PersonMini key={i} person={p} mics={mics} />)}
      </span>
      <span className="mx-0.5 shrink-0 text-muted-foreground/40">→</span>
      <span className="shrink-0 text-[9px] font-black uppercase tracking-wider rounded px-1.5 py-0.5 bg-busy text-black">NEXT</span>
      <span className="shrink-0 text-[13px] font-medium text-muted-foreground truncate max-w-40">{next ? segTitle(next) : '—'}</span>
      <span className="flex items-center gap-2.5 overflow-hidden min-w-0 text-muted-foreground">
        {(next?.people ?? []).map((p, i) => <PersonMini key={i} person={p} mics={mics} />)}
      </span>
    </div>
  )
}
registerWidget({ type: 'runsheet-strip', label: 'Runsheet · strip', strip: true, defaultSize: { w: 10, h: 1 }, configFields: [{ key: 'serviceId', label: 'Service', kind: 'service' }], Component: RunsheetStrip })

/** Transport control: ◀ / Next / Stop drives the active position and cues the
 *  mapped mics — the operator's runsheet remote on any surface. Next also
 *  starts the show from the first item when nothing is running. */
function RunsheetControl({ config, title }: WidgetProps) {
  const services = useServicesTopic()
  const mics = useMicDefs()
  const svc = resolveService(services, config.serviceId as string | undefined)
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const first = firstItemIndex(segs), last = lastItemIndex(segs)
  const now = idx != null ? segs[idx] ?? null : null
  const next = segs[idx != null ? (nextItemIndex(segs, idx) ?? -1) : (first ?? -1)] ?? null
  const running = idx != null
  // PATCH the position; the server pushes the new state to every widget over WS.
  const go = (n: number | null) => { if (svc) gotoIndex(svc.id, n, mics, segs) }
  return (
    <div className="h-full flex flex-col p-2.5">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground pb-1.5 truncate">{title}</div> : null}
      {!svc ? <div className="text-[11px] text-muted-foreground/50">No service.</div> : (
        <>
          <div className="flex-1 min-h-0 flex flex-col justify-center gap-0.5 overflow-hidden">
            <div className="text-[9px] font-bold uppercase tracking-wider text-live">Now</div>
            <div className="text-[15px] font-bold truncate leading-tight">{now ? segTitle(now) : <span className="text-muted-foreground/50 font-normal">— not started —</span>}</div>
            <div className="text-[11px] text-muted-foreground truncate"><span className="text-busy font-semibold">Next:</span> {next ? segTitle(next) : '—'}</div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5 pt-2">
            <button onClick={() => go(prevItemIndex(segs, idx))} disabled={!running || idx === first} className="p-2 rounded-md hover:bg-accent disabled:opacity-30" title="Previous"><SkipBack className="size-4" /></button>
            <button onClick={() => go(running ? nextItemIndex(segs, idx) : first)} disabled={first == null || (running && idx === last)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold rounded-md py-2 bg-live/15 text-live hover:bg-live/25 disabled:opacity-40">
              <SkipForward className="size-4" /> Next</button>
            <button onClick={() => go(null)} disabled={!running} className="p-2 rounded-md hover:bg-accent disabled:opacity-30" title="Stop / clear cues"><Square className="size-4" /></button>
          </div>
        </>
      )}
    </div>
  )
}
registerWidget({ type: 'runsheet-control', label: 'Runsheet · transport', defaultSize: { w: 4, h: 2 }, configFields: [{ key: 'serviceId', label: 'Service', kind: 'service' }], Component: RunsheetControl })
