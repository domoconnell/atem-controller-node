'use client'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { MicCard } from '@/components/mics/mic-card'
import { WireLog } from '@/components/atem/wire-log'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SennDevice } from '@/lib/types'
import { cn } from '@/lib/utils'
import { MicVocal, AlertTriangle } from 'lucide-react'

const SECTIONS: { type: SennDevice['type']; title: string; sub: string }[] = [
  { type: 'ewdx', title: 'EW-DX', sub: 'digital · SSC' },
  { type: 'g3', title: 'ew300 G3', sub: 'receivers' },
  { type: 'iemg4', title: 'IEM G4', sub: 'in-ear sends' },
]

export default function MicsPage() {
  const { state, connected, tick, senn, wire, wireVersion, clearWire } = useAtemState()

  // Every channel with battery data, worst first - drives the warning chip.
  const lowBat = (senn?.devices ?? [])
    .flatMap((d) => d.online ? d.channels.map((c) => ({ name: c.name?.trim() ?? d.ip, pct: c.battery })) : [])
    .filter((b): b is { name: string; pct: number } => b.pct != null)
    .sort((a, b) => a.pct - b.pct)[0]

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="mics" state={state} wsConnected={connected} tick={tick}>
          <div className="ml-auto flex items-center gap-3">
            {lowBat && lowBat.pct <= 25 && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 text-red-400 px-2 py-1 text-[11px] font-semibold">
                <AlertTriangle className="size-3.5" /> {lowBat.name} battery {lowBat.pct}%
              </span>
            )}
            {senn && (
              <span className={cn('text-[11px] uppercase tracking-[0.14em] tabular-nums',
                senn.online === senn.total ? 'text-muted-foreground' : 'text-busy')}>
                {senn.online}/{senn.total} online
              </span>
            )}
          </div>
        </AppHeader>

        {senn?.simulated && (
          <div className="shrink-0 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-black bg-busy py-0.5">
            Simulator — not the real rig
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          {!senn?.enabled ? (
            <div className="h-full grid place-items-center text-muted-foreground">
              <div className="text-center space-y-2">
                <MicVocal className="size-8 mx-auto opacity-40" />
                <div className="text-sm">Sennheiser monitoring is not configured.</div>
                <div className="text-xs opacity-70">Add a `sennheiser` section with your devices to config.json and restart.</div>
              </div>
            </div>
          ) : (
            <div className="max-w-[1500px] mx-auto space-y-6">
              {SECTIONS.map(({ type, title, sub }) => {
                const devs = (senn?.devices ?? []).filter((d) => d.type === type || (type === 'g3' && d.type === 'g3legacy'))
                if (!devs.length) return null
                const cards = devs.flatMap((d) =>
                  (d.channels.length ? d.channels : [{ id: 'ch' }]).map((ch) => ({ d, ch }))
                )
                return (
                  <section key={type}>
                    <div className="flex items-baseline gap-2.5 mb-2">
                      <h2 className="text-[13px] font-bold uppercase tracking-[0.16em]">{title}</h2>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{sub}</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground/60">
                        {devs.filter((d) => d.online).length}/{devs.length} units
                      </span>
                    </div>
                    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(252px,1fr))]">
                      {cards.map(({ d, ch }) => <MicCard key={`${d.ip}:${d.type}:${ch.id}`} dev={d} ch={ch} />)}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </main>

        <WireLog lines={wire} version={wireVersion} onClear={clearWire} />
      </div>
    </TooltipProvider>
  )
}
