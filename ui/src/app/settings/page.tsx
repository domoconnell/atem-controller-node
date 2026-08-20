'use client'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Settings2 } from 'lucide-react'

export default function SettingsPage() {
  const { state, connected, tick } = useAtemState()
  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="settings" state={state} wsConnected={connected} tick={tick} />
        <main className="flex-1 min-h-0 grid place-items-center p-6 text-center">
          <div className="space-y-3 max-w-md">
            <Settings2 className="size-8 mx-auto text-muted-foreground/40" />
            <h1 className="text-lg font-semibold">Settings — Connections</h1>
            <p className="text-sm text-muted-foreground">Every device connection lives here: ATEM, HyperDeck, Sennheiser (one per receiver), ProPresenter, Smaart, QLab, REAPER, Companion, Weather, Computer, UniFi, ProdCom — each configurable, several of the same kind allowed. Coming together next.</p>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
