'use client'
import { useEffect, useState } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useMicDefs, useMicLive, CUE, batTint, MiniBar } from './mics'
import { cn } from '@/lib/utils'
import { MicOff, Star } from 'lucide-react'
import type { Mic as MicObj } from '@/components/mics/mic-composite'

interface Person { name: string; micId?: string; lead?: boolean }
interface Segment { id: string; title: string; time?: string; people: Person[]; kind?: 'header'; color?: string }
interface Service { id: string; name: string; segments?: Segment[]; activeIndex?: number | null }

function useServices(): Service[] {
  const [s, setS] = useState<Service[]>([])
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/features/services').then((r) => r.json()).then((b) => { if (live) setS(b.services ?? []) }).catch(() => {})
    load(); const h = setInterval(load, 5000)
    return () => { live = false; clearInterval(h) }
  }, [])
  return s
}

/** One person + their mic's live status (cue · mute · rf · battery). */
function PersonLine({ person, mics }: { person: Person; mics: MicObj[] }) {
  const mic = mics.find((m) => m.id === person.micId)
  const live = useMicLive(mic ?? ({ id: '', label: '' } as MicObj)) // stable hooks; null instance => no data
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

function SegBlock({ label, tone, seg, mics }: { label: string; tone: 'live' | 'busy'; seg: Segment | null; mics: MicObj[] }) {
  return (
    <div className="mb-2.5">
      <div className={cn('text-[10px] font-bold uppercase tracking-wider mb-1', tone === 'live' ? 'text-live' : 'text-busy')}>
        {label}: <span className="text-foreground normal-case tracking-normal">{seg?.title ?? '—'}</span>
        {seg?.time ? <span className="text-muted-foreground/60 ml-1.5 tabular-nums font-normal">{seg.time}</span> : null}
      </div>
      {(seg?.people ?? []).map((p, i) => <PersonLine key={i} person={p} mics={mics} />)}
      {(!seg || seg.people.length === 0) && <div className="text-[11px] text-muted-foreground/40 pl-1">—</div>}
    </div>
  )
}

/** The runsheet at a glance: Now + Next segment with each person's mic status.
 *  Auto-follows the running service (activeIndex set); config.serviceId pins one. */
function NowNext({ config, title }: WidgetProps) {
  const services = useServices()
  const mics = useMicDefs()
  const svc = (config.serviceId ? services.find((s) => s.id === config.serviceId) : null) ?? services.find((s) => s.activeIndex != null) ?? services[0]
  const segs = svc?.segments ?? []
  const isH = (s?: Segment) => s?.kind === 'header'
  const nextItem = (from: number) => { let j = from + 1; while (j < segs.length && isH(segs[j])) j++; return j }
  const idx = svc?.activeIndex ?? null
  const now = idx != null ? segs[idx] ?? null : null
  const next = segs[idx != null ? nextItem(idx) : (() => { let j = 0; while (j < segs.length && isH(segs[j])) j++; return j })()] ?? null
  // Section = nearest preceding header for the Now item.
  const section = idx != null ? (() => { for (let j = idx; j >= 0; j--) if (isH(segs[j])) return segs[j]; return null })() : null
  return (
    <div className="h-full flex flex-col">
      {title ? <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div> : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {!svc ? <div className="text-[11px] text-muted-foreground/50">No service.</div> : (
          <>
            {section && (
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="h-3 w-1 rounded-full shrink-0" style={{ background: section.color || '#6b7280' }} />
                <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground truncate">{section.title}</span>
              </div>
            )}
            <SegBlock label="Now" tone="live" seg={now} mics={mics} />
            <SegBlock label="Next" tone="busy" seg={next} mics={mics} />
          </>
        )}
      </div>
    </div>
  )
}
registerWidget({ type: 'runsheet-nownext', label: 'Runsheet · Now / Next', defaultSize: { w: 4, h: 4 }, Component: NowNext })
