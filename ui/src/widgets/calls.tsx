'use client'
import { useEffect, useState } from 'react'
import { registerWidget, type WidgetProps } from './registry'
import { useTopic } from '@/hooks/use-topic'
import { usePulseOn, useDanger } from '@/components/surfaces/pulse'
import { cn } from '@/lib/utils'
import { PhoneCall, Phone } from 'lucide-react'

/** This browser session's id (the position it represents). */
function useBrowserId(): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => { setId(localStorage.getItem('sil-browser-id')) }, [])
  return id
}
type CallState = { name?: string | null; calls?: { from: string; fromName: string; at: number }[] }
type Position = { browserId: string; name?: string | null; surfaceName?: string | null }

function useCalls(browserId: string | null) {
  return useTopic(browserId ? `usr:calls:${browserId}` : null) as CallState | null
}
/** All named browser sessions (positions), polled. */
function usePositions(): Position[] {
  const [pos, setPos] = useState<Position[]>([])
  useEffect(() => {
    const load = () => fetch('/api/surface-clients').then((r) => r.json()).then((b) => setPos(b.clients ?? [])).catch(() => {})
    load(); const t = setInterval(load, 3000); return () => clearInterval(t)
  }, [])
  return pos
}
const posName = (p: Position) => p.name || p.surfaceName || p.browserId
const doCall = (from: string, to: string) => fetch('/api/companion/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) }).catch(() => {})
const doClear = (to: string) => fetch('/api/companion/call/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) }).catch(() => {})

/** Header/footer strip: shows who's calling this position, with a clear button. */
function CallStrip({ title }: WidgetProps) {
  const browserId = useBrowserId()
  const cs = useCalls(browserId)
  const incoming = cs?.calls ?? []
  usePulseOn(incoming.map((c) => c.from).join())
  useDanger(incoming.length ? 1 : 0)
  return (
    <div className={cn('h-full w-full flex items-center gap-2 px-3 rounded-lg border overflow-hidden', incoming.length ? 'border-destructive/50 bg-destructive/10' : 'border-border/50 bg-card')}>
      <PhoneCall className={cn('size-4 shrink-0', incoming.length ? 'text-destructive' : 'text-muted-foreground')} />
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground truncate">{title || cs?.name || 'Calls'}</span>
      {incoming.length > 0 ? (
        <span className="ml-auto flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-bold text-destructive truncate">{incoming.map((c) => c.fromName).join(', ')} Calling</span>
          <button onClick={() => browserId && doClear(browserId)} className="shrink-0 rounded bg-destructive text-white text-[10px] font-bold uppercase px-2 py-1 hover:brightness-110">Clear</button>
        </span>
      ) : <span className="ml-auto text-[11px] text-muted-foreground/50">no calls</span>}
    </div>
  )
}

/** Panel: an incoming banner + a button per other position to call it. */
function CallPanel({ title }: WidgetProps) {
  const browserId = useBrowserId()
  const cs = useCalls(browserId)
  const incoming = cs?.calls ?? []
  const positions = usePositions().filter((p) => p.browserId !== browserId)
  usePulseOn(incoming.map((c) => c.from).join())
  useDanger(incoming.length ? 1 : 0)
  return (
    <div className="h-full flex flex-col">
      {title && <div className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground px-3 pt-2 pb-1 truncate">{title}</div>}
      {incoming.length > 0 && (
        <div className="shrink-0 mx-3 mt-1 mb-2 rounded-lg bg-destructive/15 border border-destructive/40 px-3 py-2 flex items-center gap-2">
          <PhoneCall className="size-4 text-destructive shrink-0 animate-pulse" />
          <span className="text-[14px] font-bold text-destructive truncate">{incoming.map((c) => c.fromName).join(', ')} Calling</span>
          <button onClick={() => browserId && doClear(browserId)} className="ml-auto shrink-0 rounded bg-destructive text-white text-[11px] font-bold uppercase px-2.5 py-1 hover:brightness-110">Clear</button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 grid grid-cols-2 gap-2 content-start">
        {positions.length === 0 && <div className="col-span-2 text-[11px] text-muted-foreground/50">No other positions online. Name sessions in the Surfaces app.</div>}
        {positions.map((p) => (
          <button key={p.browserId} onClick={() => browserId && doCall(browserId, p.browserId)}
            className="rounded-lg border border-border bg-muted/30 hover:bg-accent hover:border-info/50 px-3 py-3 text-left flex items-center gap-2 transition-colors">
            <Phone className="size-4 text-info shrink-0" />
            <span className="text-[13px] font-semibold truncate">{posName(p)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

registerWidget({ type: 'call-strip', label: 'Call · indicator (strip)', strip: true, defaultSize: { w: 5, h: 1 }, Component: CallStrip })
registerWidget({ type: 'call-panel', label: 'Call · panel', defaultSize: { w: 4, h: 4 }, Component: CallPanel })
