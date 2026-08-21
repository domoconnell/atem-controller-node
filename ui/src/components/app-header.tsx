'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SlidersHorizontal, Clock, ChevronDown, Mic, House, LayoutDashboard, Settings2, Server, Disc3, MonitorPlay, Circle, Video, Film, Volume2, Play, Wifi, CloudSun, Cpu, MessageSquare, Activity } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTopic } from '@/hooks/use-topic'

const APPS = [
  {
    id: 'home', href: '/', icon: House,
    title: 'Stage It Live', tile: 'from-[#fb7185] to-rose-800 shadow-[0_0_18px_-4px_#fb7185]',
    sub: () => 'Home',
  },
  {
    id: 'surfaces', href: '/surfaces', icon: LayoutDashboard,
    title: 'Surfaces', tile: 'from-[#a78bfa] to-violet-800 shadow-[0_0_18px_-4px_#a78bfa]',
    sub: () => 'Screen layouts',
  },
  {
    id: 'atem', href: '/atem', icon: SlidersHorizontal,
    title: 'ATEM Transitions', tile: 'from-primary to-amber-700 shadow-[0_0_18px_-4px_var(--primary)]',
    sub: (s: Snapshot | null) => `SuperSource · M/E ${(s?.mainMe ?? 1) + 1}`,
  },
  {
    id: 'timers', href: '/designer', icon: Clock,
    title: 'Timers', tile: 'from-info to-blue-800 shadow-[0_0_18px_-4px_var(--info)]',
    sub: () => 'ProPresenter countdowns',
  },
  {
    id: 'mics', href: '/mics', icon: Mic,
    title: 'Wireless Mics', tile: 'from-[#2dd4bf] to-teal-800 shadow-[0_0_18px_-4px_#2dd4bf]',
    sub: (s: Snapshot | null) => s?.sennheiser?.enabled ? `${s.sennheiser.online}/${s.sennheiser.total} units online` : 'Sennheiser rig',
  },
  {
    id: 'settings', href: '/settings', icon: Settings2,
    title: 'Settings', tile: 'from-slate-500 to-slate-800 shadow-[0_0_18px_-4px_#64748b]',
    sub: () => 'Connections',
  },
] as const

type ConnState = 'live' | 'sim' | 'partial' | 'offline' | 'empty'
interface ConnGroup { key: string; label: string; online: number; total: number; state: ConnState; icon: React.ElementType }
interface Inst { id: string; typeId: string; name: string }

const TYPE_ICON: Record<string, React.ElementType> = {
  atem: Video, hyperdeck: Film, sennheiser: Mic, propresenter: MonitorPlay, smaart: Volume2,
  qlab: Play, reaper: Disc3, unifi: Wifi, digico: SlidersHorizontal, weather: CloudSun,
  netcheck: Activity, sysmon: Cpu, prodcom: MessageSquare,
}
const TYPE_LABEL: Record<string, string> = {
  atem: 'ATEM', hyperdeck: 'HyperDeck', sennheiser: 'Wireless Mics', propresenter: 'ProPresenter',
  smaart: 'Smaart', qlab: 'QLab', reaper: 'REAPER', unifi: 'UniFi', digico: 'DiGiCo',
  weather: 'Weather', netcheck: 'Connection', sysmon: 'Computer', prodcom: 'Comms',
}

/** Every connector, grouped by type, graded from the live sys:status aggregate
 *  (multi-instance types like mics collapse to online/total). */
function connGroups(instances: Inst[], status: Record<string, string> | null, wsConnected: boolean): ConnGroup[] {
  const grade = (online: number, total: number): ConnState =>
    total === 0 ? 'empty' : online === 0 ? 'offline' : online < total ? 'partial' : 'live'
  const g: ConnGroup[] = [{ key: 'server', label: 'Server', online: wsConnected ? 1 : 0, total: 1, state: wsConnected ? 'live' : 'offline', icon: Server }]
  const byType = new Map<string, string[]>()
  for (const i of instances) { const a = byType.get(i.typeId) ?? []; a.push(status?.[i.id] ?? 'connecting'); byType.set(i.typeId, a) }
  for (const [t, states] of byType) {
    const online = states.filter((s) => s === 'online').length
    g.push({ key: t, label: TYPE_LABEL[t] ?? t, online, total: states.length, state: grade(online, states.length), icon: TYPE_ICON[t] ?? Circle })
  }
  return g
}

const CONN_TEXT: Record<ConnState, string> = { live: 'text-live', sim: 'text-busy', partial: 'text-busy', offline: 'text-destructive', empty: 'text-muted-foreground/40' }

/**
 * Shared header: app icon + title as an app-switcher dropdown, the four
 * connection LEDs, then app-specific content (right-aligned via ml-auto in
 * children) and the live-update pulse.
 */
export function AppHeader({ app, state, wsConnected, tick, children }: {
  app: 'home' | 'surfaces' | 'atem' | 'timers' | 'mics' | 'settings' | 'acceptance'
  state: Snapshot | null
  wsConnected: boolean
  tick: number
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pulse, setPulse] = useState(false)
  const [instances, setInstances] = useState<Inst[]>([])
  const status = useTopic('sys:status') as Record<string, string> | null
  useEffect(() => {
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 160)
    return () => clearTimeout(t)
  }, [tick])
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/instances').then((r) => r.json()).then((b) => { if (live) setInstances(b.instances ?? []) }).catch(() => {})
    load(); const h = setInterval(load, 15000) // instances rarely change; status is live via sys:status
    return () => { live = false; clearInterval(h) }
  }, [])

  const cur = APPS.find((a) => a.id === app) ?? APPS[0]
  const groups = connGroups(instances, status, wsConnected)

  return (
    <header className="shrink-0 flex items-center gap-5 px-5 h-14 border-b border-border/70 bg-background/80 z-30">
      {/* app switcher */}
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-3 group outline-none">
          <div className={cn('size-7 rounded-md bg-gradient-to-br grid place-items-center', cur.tile)}>
            <cur.icon className="size-4 text-black/80" />
          </div>
          <div className="leading-tight text-left">
            <div className="text-[13px] font-semibold tracking-tight flex items-center gap-1.5">
              {cur.title}
              <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform group-hover:text-foreground', open && 'rotate-180')} />
            </div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.18em]">{cur.sub(state)}</div>
          </div>
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-2 z-50 w-60 rounded-lg border border-border bg-popover shadow-2xl p-1"
            onMouseLeave={() => setOpen(false)}>
            {APPS.map((a) => (
              <Link key={a.id} href={a.href} onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-accent',
                  a.id === app && 'bg-muted/60'
                )}>
                <div className={cn('size-7 rounded-md bg-gradient-to-br grid place-items-center shrink-0', a.tile)}>
                  <a.icon className="size-4 text-black/80" />
                </div>
                <div className="leading-tight">
                  <div className="text-[12.5px] font-semibold">{a.title}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-[0.14em]">{a.sub(state)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Connections — one icon per type, coloured by state (hover for detail) */}
      <div className="flex items-center gap-0.5">
        {groups.map((g) => {
          const Icon = g.icon ?? Circle
          return (
            <Tooltip key={g.key}>
              <TooltipTrigger asChild>
                <div className="relative size-8 rounded-md grid place-items-center hover:bg-accent">
                  <Icon className={cn('size-[16px]', CONN_TEXT[g.state])} />
                  {g.total > 1 && (
                    <span className={cn('absolute -bottom-0 -right-0 text-[8px] leading-none font-bold tabular-nums px-[2px] py-[1px] rounded bg-background border border-border/60', CONN_TEXT[g.state])}>{g.online}</span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {g.label} — {g.total > 1
                  ? `${g.online}/${g.total} online${g.state === 'sim' ? ' · sim' : ''}`
                  : g.state === 'offline' ? 'offline' : g.state === 'sim' ? 'sim' : g.online ? 'online' : 'off'}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      {children}

      <span className={cn('led', pulse && 'pulse')} title="flashes on every state update" />
    </header>
  )
}
