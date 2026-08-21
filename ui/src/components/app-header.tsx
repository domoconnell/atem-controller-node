'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SlidersHorizontal, Clock, ChevronDown, Mic, House, LayoutDashboard, Settings2, ListChecks } from 'lucide-react'
import { Brand } from '@/components/brand'

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
    id: 'runsheet', href: '/runsheet', icon: ListChecks,
    title: 'Runsheet', tile: 'from-[#f0abfc] to-fuchsia-800 shadow-[0_0_18px_-4px_#f0abfc]',
    sub: () => 'Services · segments · mics',
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

/**
 * Shared header: app icon + title as an app-switcher dropdown, then app-specific
 * content (right-aligned via ml-auto in children) and the live-update pulse.
 * Connection status now lives on the Settings / dashboard surfaces, not here.
 */
export function AppHeader({ app, state, tick, children }: {
  app: 'home' | 'surfaces' | 'atem' | 'timers' | 'runsheet' | 'mics' | 'settings' | 'acceptance'
  state: Snapshot | null
  wsConnected: boolean
  tick: number
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 160)
    return () => clearTimeout(t)
  }, [tick])

  const cur = APPS.find((a) => a.id === app) ?? APPS[0]

  return (
    <header className="shrink-0 flex items-center gap-4 px-4 h-14 border-b border-border/70 bg-background/80 z-30">
      {/* persistent Stage It brand, links home */}
      <Link href="/" title="Stage It Live" className="shrink-0 text-foreground/85 hover:text-foreground transition-colors">
        <Brand variant="full" className="h-5" />
      </Link>
      <div className="h-6 w-px bg-border shrink-0" />
      {/* app switcher */}
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-3 group outline-none">
          <div className={cn('size-7 rounded-md bg-gradient-to-br grid place-items-center', cur.tile)}>
            {cur.id === 'home' ? <Brand variant="icon" className="size-4 text-black/80" /> : <cur.icon className="size-4 text-black/80" />}
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
                  {a.id === 'home' ? <Brand variant="icon" className="size-4 text-black/80" /> : <a.icon className="size-4 text-black/80" />}
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

      {/* all app-specific controls + the live pulse float right */}
      <div className="ml-auto flex items-center gap-2 min-w-0">
        {children}
        <span className={cn('led', pulse && 'pulse')} title="flashes on every state update" />
      </div>
    </header>
  )
}
