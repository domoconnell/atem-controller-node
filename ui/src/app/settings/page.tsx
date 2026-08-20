'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { SchemaForm } from '@/components/settings/schema-form'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Instance, ConnectorType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Plus, Trash2, FlaskConical, Globe, Radio, Mic, Save } from 'lucide-react'

type ConnState = 'live' | 'sim' | 'partial' | 'offline' | 'empty'
const DOT: Record<ConnState, string> = { live: 'bg-live', sim: 'bg-busy', partial: 'bg-busy', offline: 'bg-destructive', empty: 'bg-muted-foreground/30' }
function stateOf(i: Instance): string { return i.engineRun ? (i.status?.state ?? 'connecting') : 'online' }
function ledForType(list: Instance[]): ConnState {
  if (list.length === 0) return 'empty'
  const states = list.map(stateOf)
  if (states.some((s) => s === 'offline' || s === 'error')) return 'offline'
  if (list.some((i) => i.simulate) || states.some((s) => s !== 'online')) return 'sim'
  return 'live'
}
// Core connectors our apps own, pinned to the top of the list.
const PINNED = ['atem', 'hyperdeck', 'sennheiser', 'propresenter']
const DISPLAY: Record<string, string> = { atem: 'ATEM' }

function InstanceCard({ inst, schema, liveState, onSaved, onDelete }: {
  inst: Instance; schema: unknown; liveState: string
  onSaved: () => void; onDelete: () => void
}) {
  const [name, setName] = useState(inst.name)
  const [simulate, setSimulate] = useState(inst.simulate)
  const [enabled, setEnabled] = useState(inst.enabled)
  const [config, setConfig] = useState<Record<string, unknown>>(inst.config ?? {})
  const [saving, setSaving] = useState(false)
  const hasSchema = !!(schema as { properties?: object } | null)?.properties
  const save = async () => {
    setSaving(true)
    await fetch(`/api/instances/${inst.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, simulate, enabled, config }) }).catch(() => {})
    setSaving(false); onSaved()
  }
  const st = liveState
  return (
    <div className="surface rounded-xl border border-border/60 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={cn('size-2 rounded-full shrink-0', DOT[st === 'online' ? 'live' : st === 'offline' || st === 'error' ? 'offline' : 'sim'])} />
        <input value={name} onChange={(e) => setName(e.target.value)}
          className="bg-transparent text-[14px] font-semibold outline-none border-b border-transparent focus:border-border min-w-0 flex-1" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{st}</span>
        <button onClick={onDelete} className="p-1 rounded text-muted-foreground/40 hover:text-destructive hover:bg-accent"><Trash2 className="size-4" /></button>
      </div>
      {hasSchema
        ? <SchemaForm schema={schema as never} value={config} onChange={setConfig} />
        : <textarea value={JSON.stringify(config, null, 2)} onChange={(e) => { try { setConfig(JSON.parse(e.target.value)) } catch { /* keep typing */ } }}
            className="w-full h-28 bg-input/40 border border-border rounded-md px-2 py-1.5 text-[12px] font-mono outline-none" />}
      <div className="flex items-center gap-4 pt-1 border-t border-border/40">
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} className="size-3.5 accent-[var(--busy)]" /><FlaskConical className="size-3" /> Simulator</label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-3.5 accent-[var(--live)]" /> Enabled</label>
        <button onClick={save} disabled={saving} className="ml-auto inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md px-3 py-1.5 bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Save className="size-3.5" /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function ConfigForm({ fields }: { fields: { path: string; label: string; hint?: string; type?: string }[] }) {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null)
  const [restart, setRestart] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setCfg(structuredClone(b.config))).catch(() => {}) }, [])
  const get = (o: unknown, path: string): unknown => path.split('.').reduce((a: unknown, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o)
  const set = (o: Record<string, unknown>, path: string, v: unknown) => {
    const ks = path.split('.'); let cur: Record<string, unknown> = o
    ks.slice(0, -1).forEach((k, i) => { if (cur[k] == null) cur[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; cur = cur[k] as Record<string, unknown> })
    cur[ks[ks.length - 1]] = v
  }
  const save = async () => {
    if (!cfg) return
    const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
    const b = await r.json().catch(() => ({}))
    setRestart(b.restartRequired ?? []); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }
  if (!cfg) return <div className="text-sm text-muted-foreground">Loading…</div>
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        {fields.map((f) => (
          <label key={f.path} className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.label}</span>
            <input type={f.type ?? 'text'} value={(get(cfg, f.path) as string | number | undefined) ?? ''}
              onChange={(e) => { const c = structuredClone(cfg); set(c, f.path, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value); setCfg(c) }}
              className="bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px] font-mono outline-none focus:border-border" />
            {f.hint && <span className="text-[10.5px] text-muted-foreground/50 leading-snug">{f.hint}</span>}
          </label>
        ))}
      </div>
      {restart.length > 0 && <div className="text-[12px] text-busy">Saved — restart needed for: <span className="font-mono">{restart.join(', ')}</span></div>}
      <button onClick={save} className="inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md px-3 py-1.5 bg-primary text-primary-foreground hover:opacity-90"><Save className="size-3.5" /> {saved ? 'Saved' : 'Save'}</button>
    </div>
  )
}

export default function SettingsPage() {
  const { state, connected, tick } = useAtemState()
  const [instances, setInstances] = useState<Instance[]>([])
  const [types, setTypes] = useState<ConnectorType[]>([])
  const [sel, setSel] = useState('g:web')

  const load = useCallback(async () => {
    const [i, t] = await Promise.all([
      fetch('/api/instances').then((r) => r.json()).catch(() => ({ instances: [] })),
      fetch('/api/connector-types').then((r) => r.json()).catch(() => ({ types: [] })),
    ])
    setInstances(i.instances ?? []); setTypes(t.types ?? [])
  }, [])
  useEffect(() => { load(); const h = setInterval(load, 3000); return () => clearInterval(h) }, [load])

  const byType = useMemo(() => { const m = new Map<string, Instance[]>(); for (const i of instances) { const a = m.get(i.typeId) ?? []; a.push(i); m.set(i.typeId, a) } return m }, [instances])
  const typeOrder = useMemo(() => {
    const all = [...new Set([...types.map((t) => t.typeId), ...instances.map((i) => i.typeId)])]
    return all.sort((a, b) => {
      const pa = PINNED.indexOf(a), pb = PINNED.indexOf(b)
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
      return nameOf(a).localeCompare(nameOf(b))
    })
  }, [types, instances])
  function nameOf(typeId: string) { return DISPLAY[typeId] ?? types.find((t) => t.typeId === typeId)?.displayName ?? typeId }
  const schemaOf = (typeId: string) => types.find((t) => t.typeId === typeId)?.['configJsonSchema' as keyof ConnectorType] ?? null

  const addInstance = async (typeId: string) => {
    const n = (byType.get(typeId)?.length ?? 0) + 1
    await fetch('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typeId, name: `${nameOf(typeId)} ${n}`, simulate: true }) })
    load()
  }
  const del = async (id: string) => { await fetch(`/api/instances/${id}`, { method: 'DELETE' }); load() }

  const NavHeader = ({ children }: { children: React.ReactNode }) => <div className="px-3 pt-4 pb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">{children}</div>
  const NavItem = ({ id, icon: Icon, label, led }: { id: string; icon?: React.ElementType; label: string; led?: ConnState }) => (
    <button onClick={() => setSel(id)} className={cn('w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] text-left', sel === id ? 'bg-muted/70 text-foreground' : 'text-foreground/70 hover:bg-accent')}>
      {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      {led && <span className={cn('size-1.5 rounded-full shrink-0', DOT[led])} />}
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="settings" state={state} wsConnected={connected} tick={tick} />
        <div className="flex-1 min-h-0 flex">
          {/* fixed scrollable sidebar */}
          <nav className="w-60 shrink-0 border-r border-border/70 overflow-y-auto py-2">
            <NavHeader>Global</NavHeader>
            <NavItem id="g:web" icon={Globe} label="Web UI" />
            <NavItem id="g:companion" icon={Radio} label="Companion" />
            <NavHeader>Connections</NavHeader>
            {typeOrder.map((typeId) => <NavItem key={typeId} id={`c:${typeId}`} label={nameOf(typeId)} led={ledForType(byType.get(typeId) ?? [])} />)}
            <NavHeader>Features</NavHeader>
            <NavItem id="f:mics" icon={Mic} label="Wireless Mics" />
          </nav>

          {/* detail pane */}
          <main className="flex-1 min-h-0 overflow-y-auto p-6">
            <div className="max-w-[760px]">
              {sel === 'g:web' && (<><h1 className="text-xl font-bold mb-1">Web UI</h1><p className="text-sm text-muted-foreground mb-5">How this dashboard is served.</p><ConfigForm fields={[{ path: 'web.port', label: 'Port', type: 'number', hint: 'The port this dashboard is served on' }]} /></>)}
              {sel === 'g:companion' && (<><h1 className="text-xl font-bold mb-1">Companion</h1><p className="text-sm text-muted-foreground mb-5">The control-surface bridge — receives commands (OSC) and gets our status variables pushed back. Not a monitored device.</p><ConfigForm fields={[
                { path: 'companion.host', label: 'Companion IP' },
                { path: 'companion.port', label: 'Companion OSC API port', type: 'number', hint: 'Where we push status variables over OSC (default 12321)' },
                { path: 'companion.httpPort', label: 'Companion HTTP API port', type: 'number', hint: 'For HTTP variable/button control (default 8000)' },
                { path: 'companion.varPrefix', label: 'Variable prefix', hint: 'Prepended to every variable we write, e.g. sil_' },
                { path: 'osc.listenPort', label: 'OSC command port (receive)', type: 'number', hint: 'Companion sends /goto, /sil here (default 9000)' },
                { path: 'osc.feedback.0.host', label: 'Feedback target IP', hint: 'Usually the Companion machine' },
                { path: 'osc.feedback.0.port', label: 'Feedback OSC port (send)', type: 'number', hint: 'Companion Generic OSC listener (default 9001)' },
              ]} /></>)}
              {sel.startsWith('c:') && (() => {
                const typeId = sel.slice(2); const list = byType.get(typeId) ?? []; const meta = types.find((t) => t.typeId === typeId)
                return (
                  <>
                    <div className="flex items-baseline gap-3 mb-1">
                      <h1 className="text-xl font-bold">{nameOf(typeId)}</h1>
                      <span className="text-sm text-muted-foreground tabular-nums">{list.filter((i) => stateOf(i) === 'online').length}/{list.length} online</span>
                    </div>
                    {meta?.description && <p className="text-sm text-muted-foreground mb-5 max-w-xl">{meta.description}</p>}
                    <div className="space-y-3">
                      {list.map((i) => <InstanceCard key={i.id} inst={i} schema={schemaOf(typeId)} liveState={stateOf(i)} onSaved={load} onDelete={() => del(i.id)} />)}
                      <button onClick={() => addInstance(typeId)} className="w-full flex items-center justify-center gap-1.5 text-[13px] text-muted-foreground rounded-xl border border-dashed border-border/60 py-3 hover:border-border hover:text-foreground">
                        <Plus className="size-4" /> Add {nameOf(typeId)} connection
                      </button>
                    </div>
                  </>
                )
              })()}
              {sel === 'f:mics' && (<><h1 className="text-xl font-bold mb-1">Wireless Mics</h1><p className="text-sm text-muted-foreground mb-4 max-w-xl">A composite feature, not a connection: each mic links a <span className="text-foreground/80">Sennheiser</span> receiver channel to a <span className="text-foreground/80">DiGiCo</span> console channel and a live/standby/off cue. Configure the receivers under Connections → Sennheiser; the channel↔cue mapping lives here.</p><div className="text-[12px] text-muted-foreground/60 rounded-lg border border-dashed border-border/50 px-4 py-6 text-center">Mapping editor coming next.</div></>)}
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
