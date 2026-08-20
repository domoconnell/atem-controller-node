'use client'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LayoutDashboard } from 'lucide-react'

export default function SurfacesPage() {
  const { state, connected, tick } = useAtemState()
  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="surfaces" state={state} wsConnected={connected} tick={tick} />
        <main className="flex-1 min-h-0 grid place-items-center p-6 text-center">
          <div className="space-y-3 max-w-md">
            <LayoutDashboard className="size-8 mx-auto text-muted-foreground/40" />
            <h1 className="text-lg font-semibold">Surfaces</h1>
            <p className="text-sm text-muted-foreground">Design a screen of widgets for any display — a wide monitor above the console, a lobby screen, a phone — and open it at <code className="text-foreground/80">/surface?s=&lt;name&gt;</code>. Each connector exposes configurable widgets you drop onto the grid. Coming together next.</p>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
