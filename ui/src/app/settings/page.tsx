'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { SchemaForm } from '@/components/settings/schema-form'
import { MicComposite, MicEditor, AddMicButton, useMics, type Mic as MicDef, type CueState } from '@/components/mics/mic-composite'
import { useTopic } from '@/hooks/use-topic'
import type { Recorder } from '@/widgets/recorders'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Instance, ConnectorType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Plus, Trash2, FlaskConical, Globe, Radio, Mic, Disc, Save, Copy, Check, RefreshCw, Download, MonitorSmartphone, ArrowLeftRight, Cable } from 'lucide-react'

type ConnState = 'live' | 'sim' | 'partial' | 'offline' | 'empty'
const DOT: Record<ConnState, string> = { live: 'bg-live', sim: 'bg-busy', partial: 'bg-busy', offline: 'bg-destructive', empty: 'bg-muted-foreground/30' }
// Real status for every connector — engine-run and legacy/bridged alike
// (ATEM, HyperDeck, ProPresenter, Sennheiser report via the hub bridge). Never
// assume 'online' just because it isn't engine-run.
function stateOf(i: Instance): string { return i.status?.state ?? 'connecting' }
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
      {inst.typeId === 'digico' && <DigicoRelayPanel instanceId={inst.id} />}
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

/** Live OSC pass-through relay status for a DiGiCo instance. A DiGiCo takes only
 *  one OSC connection, so we hold it and relay for other tools (Companion). This
 *  shows the relay port and every downstream client currently routed through us. */
type RelayClient = { address: string; port: number; lastSeen: number; toConsole: number; fromConsole: number }
type RelayState = { enabled?: boolean; clientSendPort?: number; clientReceivePort?: number; console?: { host: string; sendPort: number }; toConsole?: number; fromConsole?: number; clients?: RelayClient[] }
function DigicoRelayPanel({ instanceId }: { instanceId: string }) {
  const relay = useTopic(`mi:${instanceId}:relay`) as RelayState | null
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t) }, []) // keep "last seen" fresh
  // The address the operator points their iPad app at = the host they browsed to.
  const host = typeof window !== 'undefined' ? window.location.hostname : 'this-machine'
  if (!relay) return null
  const ago = (ts: number) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago` }
  const clients = relay.clients ?? []
  return (
    <div className={cn('rounded-lg border p-3 space-y-2', relay.enabled ? 'border-info/40 bg-info/[0.04]' : 'border-border/60 bg-muted/20')}>
      <div className="flex items-center gap-2">
        <ArrowLeftRight className={cn('size-4', relay.enabled ? 'text-info' : 'text-muted-foreground/50')} />
        <span className="text-[12px] font-semibold">OSC pass-through relay</span>
        <span className={cn('text-[9px] font-black uppercase tracking-wider rounded px-1.5 py-0.5', relay.enabled ? 'bg-info/15 text-info' : 'bg-muted/50 text-muted-foreground')}>{relay.enabled ? 'On' : 'Off'}</span>
        {relay.enabled && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">→ {relay.console?.host}:{relay.console?.sendPort}</span>}
      </div>
      {!relay.enabled ? (
        <p className="text-[11px] text-muted-foreground leading-snug">Off. Enable it above to let iPad apps and Companion reach this console through us — they point their OSC at this machine and share our single console connection.</p>
      ) : (
        <>
          {/* Exact instructions to type into the DiGiCo iPad app / Companion. */}
          <div className="rounded-md bg-card border border-info/30 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-info/80 mb-1">On the DiGiCo iPad app, set:</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] font-mono">
              <span className="text-muted-foreground">IP</span><span className="text-foreground select-all">{host}</span>
              <span className="text-muted-foreground">Send port</span><span className="text-foreground select-all">{relay.clientSendPort}</span>
              <span className="text-muted-foreground">Receive port</span><span className="text-foreground select-all">{relay.clientReceivePort === 0 ? '(any)' : relay.clientReceivePort}</span>
            </div>
            <div className="text-[10px] text-muted-foreground/60 mt-1.5 leading-snug">Their send port is our receive, and vice-versa. Enrol as a <b className="text-foreground/80">DiGiCo Pad</b> device (iPad set), or <b className="text-foreground/80">Other OSC</b> for Companion — matching this connector’s command set.</div>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
            <span className="inline-flex items-center gap-1"><Cable className="size-3" /> {clients.length} client{clients.length === 1 ? '' : 's'}</span>
            <span>▲ {relay.toConsole ?? 0} to console</span>
            <span>▼ {relay.fromConsole ?? 0} to clients</span>
          </div>
          {clients.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60">No clients yet — waiting for an iPad / Companion to connect on port {relay.clientSendPort}.</p>
          ) : (
            <div className="space-y-1">
              {clients.map((c) => (
                <div key={`${c.address}:${c.port}`} className="flex items-center gap-2 text-[11px] rounded-md bg-card border border-border/50 px-2 py-1">
                  <span className="size-1.5 rounded-full bg-info shrink-0" />
                  <span className="font-mono text-foreground/90">{c.address}:{c.port}</span>
                  <span className="text-muted-foreground/60 tabular-nums">▲{c.toConsole} ▼{c.fromConsole}</span>
                  <span className="ml-auto text-muted-foreground/60 tabular-nums">{ago(c.lastSeen)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
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

// Module-scope so the sidebar reconciles in place across the frequent
// useAtemState re-renders (mics stream constantly). Defining these inside the
// component made them new types every render, remounting the whole nav and
// swallowing clicks that landed mid-render.
function NavHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-4 pb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">{children}</div>
}
function NavItem({ id, icon: Icon, label, led, active, onSelect }: { id: string; icon?: React.ElementType; label: string; led?: ConnState; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button onClick={() => onSelect(id)} className={cn('w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] text-left', active ? 'bg-muted/70 text-foreground' : 'text-foreground/70 hover:bg-accent')}>
      {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      {led && <span className={cn('size-1.5 rounded-full shrink-0', DOT[led])} />}
      <span className="truncate">{label}</span>
    </button>
  )
}

export default function SettingsPage() {
  const { state, connected, tick } = useAtemState()
  // Instances (with live status) arrive over the shared WebSocket — the engine
  // republishes sys:instances on every status transition, so the LEDs stay live
  // without polling. The connector-type catalogue is static; fetch it once.
  const instances = (useTopic('sys:instances') as { instances?: Instance[] } | null)?.instances ?? []
  const [types, setTypes] = useState<ConnectorType[]>([])
  const [sel, setSel] = useState('g:web')

  useEffect(() => { fetch('/api/connector-types').then((r) => r.json()).then((b) => setTypes(b.types ?? [])).catch(() => {}) }, [])
  const noop = useCallback(() => {}, []) // instance edits refresh via the WS push

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
  }
  const del = async (id: string) => { await fetch(`/api/instances/${id}`, { method: 'DELETE' }) }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="settings" state={state} wsConnected={connected} tick={tick} />
        <div className="flex-1 min-h-0 flex">
          {/* fixed scrollable sidebar */}
          <nav className="w-60 shrink-0 border-r border-border/70 overflow-y-auto py-2">
            <NavHeader>Global</NavHeader>
            <NavItem id="g:web" icon={Globe} label="Web UI" active={sel === 'g:web'} onSelect={setSel} />
            <NavItem id="g:companion" icon={Radio} label="Companion" active={sel === 'g:companion'} onSelect={setSel} />
            <NavHeader>Connections</NavHeader>
            {typeOrder.map((typeId) => <NavItem key={typeId} id={`c:${typeId}`} label={nameOf(typeId)} led={ledForType(byType.get(typeId) ?? [])} active={sel === `c:${typeId}`} onSelect={setSel} />)}
            <NavHeader>Features</NavHeader>
            <NavItem id="f:mics" icon={Mic} label="Wireless Mics" active={sel === 'f:mics'} onSelect={setSel} />
            <NavItem id="f:recorders" icon={Disc} label="Recorders" active={sel === 'f:recorders'} onSelect={setSel} />
            <NavItem id="f:positions" icon={MonitorSmartphone} label="Positions" active={sel === 'f:positions'} onSelect={setSel} />
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
              ]} /><CompanionReference /></>)}
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
                      {list.map((i) => <InstanceCard key={i.id} inst={i} schema={schemaOf(typeId)} liveState={stateOf(i)} onSaved={noop} onDelete={() => del(i.id)} />)}
                      <button onClick={() => addInstance(typeId)} className="w-full flex items-center justify-center gap-1.5 text-[13px] text-muted-foreground rounded-xl border border-dashed border-border/60 py-3 hover:border-border hover:text-foreground">
                        <Plus className="size-4" /> Add {nameOf(typeId)} connection
                      </button>
                    </div>
                  </>
                )
              })()}
              {sel === 'f:mics' && <MicsSettings />}
              {sel === 'f:recorders' && <RecordersSettings instances={instances} />}
              {sel === 'f:positions' && <PositionsSettings />}
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}

/** Wireless Mics feature panel — mirrors the Mics app's composite editor so the
 *  channel↔cue mapping can be managed from Settings too. Same components, same
 *  data (/api/features/mics), so edits show in both places. */
function MicsSettings() {
  const { mics, save, remove } = useMics()
  const [editing, setEditing] = useState<Partial<MicDef> | null>(null)
  const instances = (useTopic('sys:instances') as { instances?: { id: string; typeId: string; name: string }[] } | null)?.instances ?? []
  const sennInstances = instances.filter((i) => i.typeId === 'sennheiser')
  const digicoInstances = instances.filter((i) => i.typeId === 'digico')
  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold">Wireless Mics</h1>
        <AddMicButton onClick={() => setEditing({ label: '', cue: 'off' })} />
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-xl">A composite feature, not a connection: each mic links a <span className="text-foreground/80">Sennheiser</span> receiver channel to a <span className="text-foreground/80">DiGiCo</span> console channel and a live/standby/off cue. Configure the receivers under Connections → Sennheiser. This mirrors the <a href="/mics" className="underline hover:text-foreground">Mics app</a>.</p>
      {mics.length === 0 ? (
        <button onClick={() => setEditing({ label: '', cue: 'off' })} className="w-full rounded-xl border border-dashed border-border/70 py-6 text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground">
          No mics yet — map a receiver + console channel to a person. <span className="underline">Add one</span>.
        </button>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(252px,1fr))]">
          {mics.map((m) => <MicComposite key={m.id} mic={m} onCue={(id, cue: CueState) => save({ id, cue })} onEdit={(x) => setEditing(x)} />)}
        </div>
      )}
      <MicEditor key={editing?.id ?? 'new'} mic={editing} sennInstances={sennInstances} digicoInstances={digicoInstances}
        onSave={save} onDelete={remove} onClose={() => setEditing(null)} />
    </>
  )
}

/** Positions — name the connected browser sessions (Dave FOH, Joe Mons, …) so
 *  the call system and Companion dropdowns show human names instead of the raw
 *  browser id. Same data (/api/surface-clients, PUT /api/session-name) as the
 *  Displays header control, so a name set here shows there too. */
type PosClient = { browserId: string; name?: string | null; surfaceId?: string | null; surfaceName?: string | null }
function PositionsSettings() {
  const [clients, setClients] = useState<PosClient[]>([])
  useEffect(() => {
    const load = () => fetch('/api/surface-clients').then((r) => r.json()).then((b) => setClients(b.clients ?? [])).catch(() => {})
    load(); const t = setInterval(load, 2000); return () => clearInterval(t)
  }, [])
  const rename = (browserId: string, name: string) => {
    setClients((cs) => cs.map((c) => (c.browserId === browserId ? { ...c, name } : c)))
    fetch('/api/session-name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browserId, name }) }).catch(() => {})
  }
  return (
    <>
      <h1 className="text-xl font-bold mb-1">Positions</h1>
      <p className="text-sm text-muted-foreground mb-5 max-w-xl">Name each connected display so it reads as a person/role (e.g. <b className="text-foreground">Dave FOH</b>). Names drive the backstage call system and the Companion call dropdowns, and persist across reconnects.</p>
      {clients.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-xl border border-dashed border-border/60 py-8 text-center">No displays connected.<br />Open <b className="text-foreground">/surface?s=…</b> on a screen.</div>
      ) : (
        <div className="space-y-2">
          {clients.map((c) => (
            <div key={c.browserId} className="surface rounded-xl border border-border/60 p-3 flex items-center gap-3">
              <MonitorSmartphone className="size-4 text-muted-foreground shrink-0" />
              <input value={c.name ?? ''} onChange={(e) => rename(c.browserId, e.target.value)} placeholder="Name (e.g. Dave FOH)"
                className="flex-1 min-w-0 h-9 rounded-md bg-input/40 border border-border px-2.5 text-[13px] font-semibold outline-none focus:border-border" />
              <span className="text-[11px] text-muted-foreground/70 truncate shrink-0" title={`${c.surfaceName ?? '—'} · ${c.browserId}`}>
                {c.surfaceName ?? '—'} <span className="font-mono text-muted-foreground/40">· {c.browserId}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

const RECORDER_TYPES = ['hyperdeck', 'atem', 'reaper']
const recSc = 'bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px]'

/** Tag connector instances (HyperDeck / ATEM ISO / REAPER) as record or
 *  playback devices for the Record status widget. Config lives in the DB and
 *  is pushed over the hub (feature:recorders). */
function RecordersSettings({ instances }: { instances: Instance[] }) {
  const recorders = ((useTopic('feature:recorders') as { recorders?: Recorder[] } | null)?.recorders) ?? []
  const candidates = instances.filter((i) => RECORDER_TYPES.includes(i.typeId))
  const add = () => {
    const inst = candidates[0]
    fetch('/api/features/recorders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: inst?.name ?? 'Recorder', instanceId: inst?.id ?? '', typeId: inst?.typeId ?? '', role: 'record' }) })
  }
  const patch = (id: string, body: Record<string, unknown>) => fetch(`/api/features/recorders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const del = (id: string) => fetch(`/api/features/recorders/${id}`, { method: 'DELETE' })
  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold">Recorders</h1>
        <button onClick={add} disabled={candidates.length === 0} className="inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md px-2.5 py-1.5 border border-border hover:bg-accent disabled:opacity-40"><Plus className="size-3.5" /> Device</button>
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-xl">Tag your HyperDecks, ATEM ISO recorders and REAPER as <span className="text-foreground/80">record</span> or <span className="text-foreground/80">playback</span> devices. The <span className="text-foreground/80">Record status</span> widget then shows all of them — status, timecode, format and disk time-left. Add that widget from the Surfaces designer.</p>
      {candidates.length === 0 && <div className="text-[12px] text-muted-foreground/70 rounded-lg border border-dashed border-border/50 px-4 py-6 text-center">No HyperDeck, ATEM or REAPER connections yet — add them under Connections first.</div>}
      <div className="space-y-2">
        {recorders.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
            <input value={r.label} onChange={(e) => patch(r.id, { label: e.target.value })} placeholder="Label" className={cn(recSc, 'w-40')} />
            <select value={r.instanceId} onChange={(e) => { const inst = candidates.find((i) => i.id === e.target.value); patch(r.id, { instanceId: e.target.value, typeId: inst?.typeId ?? r.typeId }) }} className={cn(recSc, 'flex-1 min-w-0')}>
              {candidates.every((i) => i.id !== r.instanceId) && <option value={r.instanceId}>{r.instanceId || '— pick device —'}</option>}
              {candidates.map((i) => <option key={i.id} value={i.id}>{i.name} · {i.typeId}</option>)}
            </select>
            <select value={r.role} onChange={(e) => patch(r.id, { role: e.target.value })} className={cn(recSc, 'w-28')}>
              <option value="record">Record</option>
              <option value="playback">Playback</option>
            </select>
            <button onClick={() => del(r.id)} className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground shrink-0"><Trash2 className="size-3.5" /></button>
          </div>
        ))}
        {recorders.length === 0 && candidates.length > 0 && <div className="text-[12px] text-muted-foreground/60 px-1">No recorders yet — click <span className="text-foreground/70">Device</span> to add one.</div>}
      </div>
    </>
  )
}

// ---- Companion OSC / variable reference ------------------------------------
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {}) }
  return <button onClick={copy} title="Copy" className="shrink-0 p-0.5 rounded hover:bg-accent">{copied ? <Check className="size-3.5 text-live" /> : <Copy className="size-3.5 text-muted-foreground/40 group-hover:text-foreground" />}</button>
}
function CmdRow({ path, label }: { path: string; label?: string }) {
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/50 bg-input/30 px-2.5 py-1.5 hover:border-border">
      {label && <span className="shrink-0 text-[9px] font-black uppercase tracking-wider rounded bg-primary/15 text-primary px-1.5 py-0.5">{label}</span>}
      <code className="text-[12px] font-mono text-foreground/90 truncate flex-1">{path}</code>
      <CopyBtn text={path} />
    </div>
  )
}
function RefSec({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2"><h3 className="text-[12px] font-bold uppercase tracking-wider">{title}</h3>{sub && <span className="text-[11px] text-muted-foreground/60">{sub}</span>}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}
function VarRow({ name, desc }: { name: string; desc?: string }) {
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/40 bg-input/20 px-2.5 py-1.5 hover:border-border">
      <code className="font-mono text-primary/90 text-[12px] truncate">{name}</code>
      {desc && <span className="text-muted-foreground/70 text-[11px] truncate">{desc}</span>}
      <span className="ml-auto"><CopyBtn text={name} /></span>
    </div>
  )
}
interface SurfClient { browserId: string; surfaceId: string | null; surfaceName: string | null }
function CompanionReference() {
  const [cfg, setCfg] = useState<{ companion?: { varPrefix?: string }; osc?: { listenPort?: number } } | null>(null)
  const [clients, setClients] = useState<SurfClient[]>([])
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setCfg(b.config)).catch(() => {}) }, [])
  const loadClients = useCallback(() => fetch('/api/surface-clients').then((r) => r.json()).then((b) => setClients(b.clients ?? [])).catch(() => {}), [])
  useEffect(() => { loadClients() }, [loadClients])
  const mics = ((useTopic('feature:mics') as { mics?: { id: string; label: string }[] } | null)?.mics) ?? []
  const p = cfg?.companion?.varPrefix ?? 'sil_'
  const oscPort = cfg?.osc?.listenPort ?? 9000
  return (
    <div className="mt-8 space-y-6 border-t border-border/50 pt-6">
      <div className="rounded-xl border border-primary/40 bg-primary/[0.06] p-4 flex items-center gap-4">
        <div className="size-10 rounded-lg bg-primary/15 grid place-items-center shrink-0"><Radio className="size-5 text-primary" /></div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold">Stage It Companion module</div>
          <div className="text-[12px] text-muted-foreground">Native buttons for runsheet, mic cues and surface drawers — with live status colours. In Companion: <span className="text-foreground/80">Import module package</span> → upload this file, then add a <span className="text-foreground/80">Stage It</span> connection pointing at this server.</div>
        </div>
        <a href="/companion/stageit.tgz" download className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-md px-3 py-2 bg-primary text-primary-foreground hover:opacity-90"><Download className="size-4" /> Download module</a>
      </div>
      <p className="text-[12px] text-muted-foreground -mt-2">Prefer raw OSC? Everything below works without the module too.</p>
      <div>
        <h2 className="text-[15px] font-bold">OSC commands</h2>
        <p className="text-[12px] text-muted-foreground">Send to this machine on <span className="font-mono text-foreground/80">UDP :{oscPort}</span>. Click a path to copy it.</p>
      </div>
      <RefSec title="Runsheet" sub="global — no variables">
        <CmdRow path="/sil/runsheet/next" /><CmdRow path="/sil/runsheet/back" /><CmdRow path="/sil/runsheet/stop" />
      </RefSec>
      <RefSec title="Mic cues" sub={`${mics.length} mic${mics.length === 1 ? '' : 's'} · toggle / live / standby / off`}>
        {mics.length === 0 && <div className="text-[11px] text-muted-foreground/50">No mics yet — add them under Wireless Mics.</div>}
        {mics.map((m) => (
          <div key={m.id} className="space-y-1 pt-0.5">
            <div className="text-[11px] text-muted-foreground">{m.label} <span className="text-muted-foreground/40 font-mono">{m.id}</span></div>
            <div className="grid grid-cols-2 gap-1">{['toggle', 'live', 'standby', 'off'].map((a) => <CmdRow key={a} path={`/sil/miccue/${m.id}/${a}`} label={a} />)}</div>
          </div>
        ))}
      </RefSec>
      <RefSec title="Surface drawers" sub="target one browser display">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/60">{clients.length} connected display{clients.length === 1 ? '' : 's'}</span>
          <button onClick={loadClients} title="Refresh" className="p-1 rounded hover:bg-accent text-muted-foreground"><RefreshCw className="size-3" /></button>
        </div>
        {clients.length === 0 && <div className="text-[11px] text-muted-foreground/50">Open a surface in a browser (a TV, /surface?s=…) and it appears here with its id.</div>}
        {clients.map((c) => (
          <div key={c.browserId} className="space-y-1 pt-0.5">
            <div className="text-[11px] text-muted-foreground">Browser <span className="font-mono text-foreground/70">{c.browserId}</span> → <span className="text-foreground/70">{c.surfaceName ?? c.surfaceId}</span></div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">{['open', 'close', 'toggle'].map((a) => <CmdRow key={a} path={`/sil/surfaces/${c.browserId}/${c.surfaceId}/left_drawer/${a}`} label={a} />)}</div>
          </div>
        ))}
        <div className="text-[11px] text-muted-foreground/50">Swap <span className="font-mono">left_drawer</span> for <span className="font-mono">right_drawer / top_drawer / bottom_drawer</span>.</div>
      </RefSec>
      <RefSec title="ATEM transitions" sub="looks & switcher">
        <CmdRow path="/goto/<look>" /><CmdRow path="/goto/<look>/<seconds>" /><CmdRow path="/transition/auto" /><CmdRow path="/usk/<1-4>/toggle" /><CmdRow path="/stop" />
      </RefSec>
      <div className="pt-2">
        <h2 className="text-[15px] font-bold">Variables we push to Companion</h2>
        <p className="text-[12px] text-muted-foreground">Create these custom variables in Companion (prefix <code className="font-mono text-primary/90">{p}</code>); they update live on change.</p>
      </div>
      <RefSec title="ATEM">
        {['active_look', 'transitioning', 'going_to', 'coming_from'].map((v) => <VarRow key={v} name={p + v} />)}
      </RefSec>
      <RefSec title="Runsheet">
        <VarRow name={p + 'runsheet_service'} desc="running service" />
        <VarRow name={p + 'runsheet_now'} desc="current segment" />
        <VarRow name={p + 'runsheet_next'} desc="next segment" />
        <VarRow name={p + 'runsheet_now_time'} desc="planned time of current" />
        <VarRow name={p + 'runsheet_running'} desc="true / false" />
      </RefSec>
      <RefSec title="Mics" sub="one pair per mic">
        <VarRow name={`${p}<mic_id>_cue`} desc="live / standby / off" />
        <VarRow name={`${p}<mic_id>_name`} desc="label" />
        {mics.slice(0, 4).map((m) => <VarRow key={m.id} name={`${p}${m.id}_cue`} desc={m.label} />)}
      </RefSec>
    </div>
  )
}
