'use client'
import { useEffect, useState } from 'react'
import { Monitor, ChevronDown } from 'lucide-react'

type Client = { browserId: string; surfaceId?: string | null; surfaceName?: string | null }

/** Header control: lists the browser sessions currently showing a surface and
 *  lets you switch any of them to another surface (in place, no reload). */
export function LiveDisplays({ list }: { list: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false)
  const [clients, setClients] = useState<Client[]>([])
  useEffect(() => {
    const load = () => fetch('/api/surface-clients').then((r) => r.json()).then((b) => setClients(b.clients ?? [])).catch(() => {})
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [])
  const show = (browserId: string, surfaceId: string) =>
    fetch('/api/companion/surface-show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browserId, surfaceId }) })
      .then(() => setClients((cs) => cs.map((c) => (c.browserId === browserId ? { ...c, surfaceId } : c))))
      .catch(() => {})
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] rounded-md px-2.5 py-1.5 hover:bg-accent border border-border">
        <Monitor className="size-3.5" /> Displays <span className="text-muted-foreground">· {clients.length}</span> <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border border-border bg-popover shadow-2xl p-2" onMouseLeave={() => setOpen(false)}>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground px-1.5 pb-1.5">Live displays</div>
          {clients.length === 0 ? (
            <div className="text-[12px] text-muted-foreground px-2 py-3 text-center">No surface displays connected.<br />Open <b className="text-foreground">/surface?s=…</b> on a screen.</div>
          ) : clients.map((c) => (
            <div key={c.browserId} className="flex items-center gap-2 px-1.5 py-1.5">
              <span className="font-mono text-[10px] text-muted-foreground shrink-0 w-14 truncate" title={c.browserId}>{c.browserId}</span>
              <select value={c.surfaceId ?? ''} onChange={(e) => show(c.browserId, e.target.value)}
                className="flex-1 h-8 rounded-md bg-muted/40 border border-border px-2 text-[12px]">
                {!list.some((s) => s.id === c.surfaceId) && <option value={c.surfaceId ?? ''}>{c.surfaceName ?? '— none —'}</option>}
                {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
