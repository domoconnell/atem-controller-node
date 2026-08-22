'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { useTopic } from '@/hooks/use-topic'
import { AppHeader } from '@/components/app-header'
import { Brand } from '@/components/brand'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolveService, segTitle, nextItemIndex, firstItemIndex, sectionFor, type Service } from '@/lib/runsheet'
import type { Snapshot } from '@/lib/types'
import { SlidersHorizontal, Clock, Mic, LayoutDashboard, Settings2, ListChecks, ArrowRight, Radio, Video } from 'lucide-react'
import { cn } from '@/lib/utils'

const TILES = [
  { href: '/atem', icon: SlidersHorizontal, title: 'ATEM Transitions', sub: 'SuperSource looks & the transition engine', tile: 'from-primary to-amber-700' },
  { href: '/mics', icon: Mic, title: 'Wireless Mics', sub: 'Sennheiser RF, AF & battery per channel', tile: 'from-[#2dd4bf] to-teal-800' },
  { href: '/runsheet', icon: ListChecks, title: 'Runsheet', sub: 'Services, segments, people & mic cues', tile: 'from-[#f0abfc] to-fuchsia-800' },
  { href: '/designer', icon: Clock, title: 'Timers', sub: 'ProPresenter countdown designer', tile: 'from-info to-blue-800' },
  { href: '/surfaces', icon: LayoutDashboard, title: 'Surfaces', sub: 'Design screens of widgets for any display', tile: 'from-[#a78bfa] to-violet-800' },
  { href: '/settings', icon: Settings2, title: 'Settings', sub: 'All device connections', tile: 'from-slate-500 to-slate-800' },
] as const

interface Inst { id: string; typeId: string; name: string }

function useClock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const f = () => setT(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    f(); const h = setInterval(f, 1000); return () => clearInterval(h)
  }, [])
  return t
}
function useInstances(): Inst[] {
  const d = useTopic('sys:instances') as { instances?: Inst[] } | null
  return d?.instances ?? []
}

function Card({ title, href, accent, children }: { title: string; href?: string; accent?: string; children: React.ReactNode }) {
  const body = (
    <div className="surface rounded-xl border border-border/60 p-4 h-full flex flex-col hover:border-border transition-colors">
      <div className="flex items-center gap-2 mb-2.5">
        <span className={cn('h-3.5 w-1 rounded-full', accent ?? 'bg-primary')} />
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{title}</span>
        {href && <ArrowRight className="ml-auto size-3.5 text-muted-foreground/40" />}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  )
  return href ? <Link href={href} className="group block">{body}</Link> : body
}

const Dot = ({ c }: { c: string }) => <span className={cn('inline-block size-2 rounded-full shrink-0', c)} />

/** Connections health from the live sys:status aggregate. */
function ConnectionsCard({ instances, status }: { instances: Inst[]; status: Record<string, string> | null }) {
  const graded = instances.map((i) => ({ ...i, state: status?.[i.id] ?? 'connecting' }))
  const online = graded.filter((g) => g.state === 'online').length
  const down = graded.filter((g) => g.state === 'offline' || g.state === 'error')
  const dot = (s: string) => s === 'online' ? 'bg-live' : s === 'offline' || s === 'error' ? 'bg-destructive' : 'bg-busy'
  return (
    <Card title="Connections" href="/settings" accent="bg-live">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{online}</span>
        <span className="text-sm text-muted-foreground">/ {instances.length} online</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {graded.map((g) => <span key={g.id} title={`${g.name} — ${g.state}`} className="inline-flex items-center gap-1 rounded-md bg-muted/40 pl-1.5 pr-2 py-0.5 text-[10.5px]"><Dot c={dot(g.state)} />{g.name}</span>)}
        {instances.length === 0 && <span className="text-[11px] text-muted-foreground/50">No connections configured.</span>}
      </div>
      {down.length > 0 && <div className="mt-2 text-[11px] text-destructive">{down.length} offline: {down.map((d) => d.name).join(', ')}</div>}
    </Card>
  )
}

/** The running service's now / next, live over the shared hub. */
function RunsheetCard() {
  const d = useTopic('feature:services') as { services?: Service[] } | null
  const svc = resolveService(d?.services ?? [], undefined, Date.now())
  const segs = svc?.segments ?? []
  const idx = svc?.activeIndex ?? null
  const now = idx != null ? segs[idx] ?? null : null
  const next = segs[idx != null ? (nextItemIndex(segs, idx) ?? -1) : (firstItemIndex(segs) ?? -1)] ?? null
  const section = sectionFor(segs, idx)
  const names = (s: typeof now) => (s?.people ?? []).map((p) => (p.lead ? '★ ' : '') + p.name).filter(Boolean).join(', ')
  return (
    <Card title="Runsheet" href="/runsheet" accent="bg-[#f0abfc]">
      {!svc ? <div className="text-[12px] text-muted-foreground/60">No service.</div> : (
        <div className="space-y-2">
          {section && <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{segTitle(section)}</div>}
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-live">Now</div>
            <div className="text-[15px] font-bold leading-tight truncate">{now ? segTitle(now) : <span className="text-muted-foreground/50 font-normal">not started</span>}</div>
            {now && names(now) && <div className="text-[11px] text-muted-foreground truncate">{names(now)}</div>}
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-busy">Next</div>
            <div className="text-[13px] font-semibold leading-tight truncate text-muted-foreground">{next ? segTitle(next) : '—'}</div>
          </div>
        </div>
      )}
    </Card>
  )
}

function MicsCard({ senn }: { senn: { online: number; total: number } | undefined }) {
  return (
    <Card title="Wireless Mics" href="/mics" accent="bg-[#2dd4bf]">
      {senn && senn.total > 0 ? (
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums">{senn.online}</span>
          <span className="text-sm text-muted-foreground">/ {senn.total} receivers online</span>
        </div>
      ) : <div className="text-[12px] text-muted-foreground/60">No receivers.</div>}
      <div className="mt-2 text-[11px] text-muted-foreground">RF, AF & battery per channel · cue mapping</div>
    </Card>
  )
}

function AtemCard({ atem, mainMe }: { atem: Snapshot['atem'] | undefined; mainMe: number }) {
  const me = atem?.mixEffects?.[mainMe]
  const online = atem?.connected || atem?.simulated
  const nameOf = (n: number | undefined) => (n != null ? atem?.inputs?.[String(n)] ?? `In ${n}` : '—')
  return (
    <Card title="ATEM" href="/atem" accent="bg-primary">
      <div className="flex items-center gap-2 mb-2">
        <Dot c={atem?.connected ? 'bg-live' : atem?.simulated ? 'bg-busy' : 'bg-destructive'} />
        <span className="text-[13px] font-semibold">{atem?.connected ? 'Connected' : atem?.simulated ? 'Simulator' : 'Offline'}</span>
        <span className="text-[11px] text-muted-foreground ml-auto">M/E {mainMe + 1}</span>
      </div>
      {online && me ? (
        <div className="space-y-1 text-[12px]">
          <div className="flex items-center gap-2"><span className="text-[9px] font-black uppercase rounded bg-destructive/80 text-white px-1 py-0.5">PGM</span><span className="truncate font-medium">{nameOf(me.programInput)}</span></div>
          <div className="flex items-center gap-2"><span className="text-[9px] font-black uppercase rounded bg-live/80 text-black px-1 py-0.5">PVW</span><span className="truncate">{nameOf(me.previewInput)}</span></div>
        </div>
      ) : <div className="text-[11px] text-muted-foreground/60">SuperSource looks & transitions</div>}
    </Card>
  )
}

function DeviceLine({ ok, label, detail }: { ok: boolean | undefined; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <Dot c={ok ? 'bg-live' : 'bg-muted-foreground/40'} />
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-[11px] text-muted-foreground truncate">{detail}</span>
    </div>
  )
}

export default function HomePage() {
  const { state, connected, tick, senn } = useAtemState()
  const status = useTopic('sys:status') as Record<string, string> | null
  const instances = useInstances()
  const clock = useClock()

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="home" state={state} wsConnected={connected} tick={tick} />
        <main className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-[1200px] mx-auto space-y-6">
            {/* hero */}
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <Brand variant="full" className="h-8 text-foreground" />
                <p className="text-sm text-muted-foreground mt-2">Live production control — one front door for the whole rig.</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums leading-none">{clock}</div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground mt-1">{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
              </div>
            </div>

            {/* live status cards */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <ConnectionsCard instances={instances} status={status} />
              <RunsheetCard />
              <MicsCard senn={state?.sennheiser} />
              <AtemCard atem={state?.atem} mainMe={state?.mainMe ?? 0} />
            </div>

            {/* devices at a glance */}
            <Card title="Devices">
              <div className="grid gap-x-8 gap-y-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                <DeviceLine ok={state?.atem?.connected || state?.atem?.simulated} label="ATEM" detail={state?.atem?.simulated ? 'simulator' : state?.atem?.connected ? 'live' : 'offline'} />
                <DeviceLine ok={state?.hyperdeck?.connected} label="HyperDeck" detail={state?.hyperdeck?.connected ? (Object.values(state.hyperdeck.transport ?? {})[0] as string ?? 'connected') : 'offline'} />
                <DeviceLine ok={state?.propresenter?.connected} label="ProPresenter" detail={state?.propresenter?.connected ? 'connected' : state?.propresenter?.configured ? 'configured' : 'offline'} />
                <DeviceLine ok={senn ? senn.online > 0 : undefined} label="Sennheiser" detail={senn ? `${senn.online}/${senn.total} online` : '—'} />
                {instances.filter((i) => !['atem', 'hyperdeck', 'propresenter', 'sennheiser'].includes(i.typeId)).map((i) => (
                  <DeviceLine key={i.id} ok={status?.[i.id] === 'online'} label={i.name} detail={status?.[i.id] ?? 'connecting'} />
                ))}
              </div>
            </Card>

            {/* launcher */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground mb-2">Open</div>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
                {TILES.map((t) => (
                  <Link key={t.href} href={t.href} className="group surface rounded-xl border border-border/60 p-3 flex flex-col gap-2 hover:border-border transition-colors">
                    <div className={cn('size-8 rounded-lg bg-gradient-to-br grid place-items-center', t.tile)}><t.icon className="size-4 text-black/80" /></div>
                    <span className="text-[12.5px] font-semibold leading-tight">{t.title}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
