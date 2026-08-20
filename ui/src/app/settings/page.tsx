'use client'
import { useEffect, useState, useCallback } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Instance, ConnectorType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Plus, Trash2, FlaskConical } from 'lucide-react'

const STATE_DOT: Record<string, string> = {
  online: 'bg-live', degraded: 'bg-busy', connecting: 'bg-busy', configuring: 'bg-busy',
  offline: 'bg-destructive', error: 'bg-destructive', stopped: 'bg-muted-foreground/40',
}
function stateOf(i: Instance) { return i.engineRun ? (i.status?.state ?? 'connecting') : 'online' }

export default function SettingsPage() {
  const { state, connected, tick } = useAtemState()
  const [instances, setInstances] = useState<Instance[]>([])
  const [types, setTypes] = useState<ConnectorType[]>([])

  const load = useCallback(async () => {
    const [i, t] = await Promise.all([
      fetch('/api/instances').then((r) => r.json()).catch(() => ({ instances: [] })),
      fetch('/api/connector-types').then((r) => r.json()).catch(() => ({ types: [] })),
    ])
    setInstances(i.instances ?? [])
    setTypes(t.types ?? [])
  }, [])
  useEffect(() => { load(); const h = setInterval(load, 2000); return () => clearInterval(h) }, [load])

  const addInstance = async (typeId: string, displayName: string) => {
    const n = instances.filter((x) => x.typeId === typeId).length + 1
    await fetch('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ typeId, name: `${displayName} ${n}`, simulate: true }) })
    load()
  }
  const removeInstance = async (id: string) => { await fetch(`/api/instances/${id}`, { method: 'DELETE' }); load() }

  // group instances by type, keep type order from the catalogue
  const byType = new Map<string, Instance[]>()
  for (const i of instances) { const a = byType.get(i.typeId) ?? []; a.push(i); byType.set(i.typeId, a) }
  const order = [...new Set([...types.map((t) => t.typeId), ...instances.map((i) => i.typeId)])]
  const nameOf = (typeId: string) => types.find((t) => t.typeId === typeId)?.displayName ?? typeId
  const online = instances.filter((i) => stateOf(i) === 'online').length

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="settings" state={state} wsConnected={connected} tick={tick} />
        <main className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-[900px] mx-auto">
            <div className="flex items-baseline gap-3 mb-5">
              <h1 className="text-xl font-bold tracking-tight">Connections</h1>
              <span className="text-sm text-muted-foreground tabular-nums">{online}/{instances.length} online</span>
            </div>
            <div className="space-y-5">
              {order.map((typeId) => {
                const list = byType.get(typeId) ?? []
                return (
                  <section key={typeId}>
                    <div className="flex items-center gap-2 mb-2">
                      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-foreground/90">{nameOf(typeId)}</h2>
                      <span className="text-[11px] tabular-nums text-muted-foreground/60">{list.length}</span>
                      <button onClick={() => addInstance(typeId, nameOf(typeId))}
                        className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                        <Plus className="size-3.5" /> Add
                      </button>
                    </div>
                    {list.length === 0 ? (
                      <div className="text-[12px] text-muted-foreground/50 px-3 py-2 rounded-lg border border-dashed border-border/50">No connections — add one.</div>
                    ) : (
                      <div className="space-y-1.5">
                        {list.map((i) => {
                          const st = stateOf(i)
                          return (
                            <div key={i.id} className="surface rounded-lg border border-border/60 px-3.5 py-2.5 flex items-center gap-3">
                              <span className={cn('size-2 rounded-full shrink-0', STATE_DOT[st] ?? 'bg-muted-foreground/40')} />
                              <span className="text-[13px] font-medium">{i.name}</span>
                              {i.simulate && <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-busy border border-busy/40 rounded px-1 py-0.5"><FlaskConical className="size-2.5" />sim</span>}
                              {typeof i.config?.ip === 'string' && <span className="text-[11px] font-mono text-muted-foreground/70">{i.config.ip as string}</span>}
                              {typeof i.config?.host === 'string' && <span className="text-[11px] font-mono text-muted-foreground/70">{i.config.host as string}</span>}
                              <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">{st}</span>
                              <button onClick={() => removeInstance(i.id)} className="p-1 rounded text-muted-foreground/50 hover:text-destructive hover:bg-accent">
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
