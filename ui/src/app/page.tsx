'use client'
import Link from 'next/link'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SlidersHorizontal, Clock, Mic, LayoutDashboard, Settings2, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const TILES = [
  { href: '/atem', icon: SlidersHorizontal, title: 'ATEM Transitions', sub: 'SuperSource looks & the transition engine', tile: 'from-primary to-amber-700' },
  { href: '/mics', icon: Mic, title: 'Wireless Mics', sub: 'Sennheiser RF, AF & battery per channel', tile: 'from-[#2dd4bf] to-teal-800' },
  { href: '/designer', icon: Clock, title: 'Timers', sub: 'ProPresenter countdown designer', tile: 'from-info to-blue-800' },
  { href: '/surfaces', icon: LayoutDashboard, title: 'Surfaces', sub: 'Design screens of widgets for any display', tile: 'from-[#a78bfa] to-violet-800' },
  { href: '/settings', icon: Settings2, title: 'Settings', sub: 'All device connections', tile: 'from-slate-500 to-slate-800' },
] as const

export default function HomePage() {
  const { state, connected, tick } = useAtemState()
  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="home" state={state} wsConnected={connected} tick={tick} />
        <main className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-[1100px] mx-auto">
            <div className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight">Stage It Live</h1>
              <p className="text-sm text-muted-foreground">Live production control — one front door for the whole rig.</p>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {TILES.map((t) => (
                <Link key={t.href} href={t.href}
                  className="group surface rounded-xl border border-border/60 p-4 flex flex-col gap-3 hover:border-border transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={cn('size-9 rounded-lg bg-gradient-to-br grid place-items-center', t.tile)}>
                      <t.icon className="size-5 text-black/80" />
                    </div>
                    <span className="text-[15px] font-semibold">{t.title}</span>
                    <ArrowRight className="ml-auto size-4 text-muted-foreground/50 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                  </div>
                  <p className="text-[12.5px] text-muted-foreground leading-snug">{t.sub}</p>
                </Link>
              ))}
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
