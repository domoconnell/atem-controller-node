'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SlidersHorizontal, Clock, ChevronDown, ClipboardList, Mic } from 'lucide-react'

const APPS = [
  {
    id: 'atem', href: '/', icon: SlidersHorizontal,
    title: 'ATEM Controller', tile: 'from-primary to-amber-700 shadow-[0_0_18px_-4px_var(--primary)]',
    sub: (s: Snapshot | null) => `SuperSource · M/E ${(s?.mainMe ?? 1) + 1}`,
  },
  {
    id: 'timers', href: '/designer', icon: Clock,
    title: 'Timer Designer', tile: 'from-info to-blue-800 shadow-[0_0_18px_-4px_var(--info)]',
    sub: () => 'ProPresenter countdowns',
  },
  {
    id: 'mics', href: '/mics', icon: Mic,
    title: 'Wireless Mics', tile: 'from-[#2dd4bf] to-teal-800 shadow-[0_0_18px_-4px_#2dd4bf]',
    sub: (s: Snapshot | null) => s?.sennheiser?.enabled ? `${s.sennheiser.online}/${s.sennheiser.total} units online` : 'Sennheiser rig',
  },
  {
    id: 'acceptance', href: '/acceptance', icon: ClipboardList,
    title: 'Acceptance', tile: 'from-live to-emerald-800 shadow-[0_0_18px_-4px_var(--live)]',
    sub: () => 'test every transition',
  },
] as const

function Led({ on, label, warn, title }: { on: boolean; label: string; warn?: boolean; title?: string }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className={cn('led', warn ? 'warn' : on && 'on')} />
      <span className={cn('text-[11px] uppercase tracking-[0.14em]', on || warn ? 'text-foreground/80' : 'text-muted-foreground')}>{label}</span>
    </div>
  )
}

/**
 * Shared header: app icon + title as an app-switcher dropdown, the four
 * connection LEDs, then app-specific content (right-aligned via ml-auto in
 * children) and the live-update pulse.
 */
export function AppHeader({ app, state, wsConnected, tick, children }: {
  app: 'atem' | 'timers' | 'acceptance' | 'mics'
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

  const cur = APPS.find((a) => a.id === app)!
  const pp = state?.propresenter

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

      <div className="flex items-center gap-4">
        <Led on={wsConnected} label="Server" />
        <Led
          on={!!state?.atem.connected && !state?.atem.simulated}
          warn={!!state?.atem.connected && !!state?.atem.simulated}
          label={state?.atem.simulated ? 'ATEM · SIM' : 'ATEM'}
          title={state?.atem.simulated ? 'No real ATEM reachable — running the built-in simulator. Everything works, nothing goes to air.' : undefined}
        />
        <Led on={!!state?.hyperdeck.connected} label="HyperDeck" />
        {state?.sennheiser?.enabled && (
          <Led
            on={(state.sennheiser.online ?? 0) > 0 && !state.sennheiser.simulated}
            warn={(state.sennheiser.online ?? 0) > 0 && !!state.sennheiser.simulated}
            label={state.sennheiser.simulated ? 'Mics · SIM' : 'Mics'}
            title={state.sennheiser.simulated ? 'Simulated Sennheiser fleet - not the real rig' : `${state.sennheiser.online}/${state.sennheiser.total} Sennheiser units online`}
          />
        )}
        <Led
          on={!!pp?.connected}
          warn={!!pp?.configured && !pp?.connected}
          label="ProPres"
          title={pp?.configured
            ? (pp.connected ? 'ProPresenter API connected' : 'ProPresenter configured but unreachable')
            : 'No ProPresenter configured — demo timer'}
        />
      </div>

      {children}

      <span className={cn('led', pulse && 'pulse')} title="flashes on every state update" />
    </header>
  )
}
