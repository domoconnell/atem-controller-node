'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Snapshot } from '@/lib/types'
import { Settings, Save, AlertTriangle, Loader2, Check } from 'lucide-react'

type Cfg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Opt = { value: number | string; label: string }

interface Field {
  path: string
  label: string
  hint?: string
  type?: 'text' | 'number' | 'select'
  options?: string[]
  /** dynamic option source from the live ATEM: supersource id / me / input / box */
  dyn?: 'ss' | 'me' | 'input' | 'box'
}
interface Group { title: string; desc?: string; fields: Field[] }

// Behavioural settings — all DB-backed and applied live (no restart).
const GROUPS: Group[] = [
  { title: 'SuperSource / M/E', desc: 'Applied live. Options come from the connected switcher.', fields: [
    { path: 'supersource.id', label: 'SuperSource', dyn: 'ss' },
    { path: 'supersource.me', label: 'Main M/E', dyn: 'me' },
    { path: 'supersource.ssInput', label: 'SuperSource input', dyn: 'input', hint: 'the ATEM input the SuperSource is on (normally 6000)' },
    { path: 'supersource.displayBox', label: 'Display box', dyn: 'box', hint: 'the box carrying the main display feed' },
    { path: 'supersource.propresenterInput', label: 'ProPresenter input', dyn: 'input', hint: 'the ATEM input carrying ProPresenter — its background media is shown full-frame on program and inside any box on this source' },
  ]},
  { title: 'Timing', desc: 'Applied live.', fields: [
    { path: 'animation.defaultDurationMs', label: 'Box move (ms)', type: 'number' },
    { path: 'animation.fps', label: 'Animation fps', type: 'number' },
    { path: 'animation.defaultEasing', label: 'Easing', type: 'select',
      options: ['linear','easeInQuad','easeOutQuad','easeInOutQuad','easeInCubic','easeOutCubic','easeInOutCubic','easeInOutSine'] },
    { path: 'transition.keyFadeMs', label: 'Border key fade (ms)', type: 'number' },
    { path: 'transition.mixRateFrames', label: 'Pinned mix rate (frames)', type: 'number', hint: 'blank = inherit the switcher' },
    { path: 'transition.videoFps', label: 'Video fps', type: 'number', hint: 'for seconds → frames (50, or 60 for 59.94/60p)' },
  ]},
]

const get = (o: Cfg, p: string): any => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o) // eslint-disable-line @typescript-eslint/no-explicit-any
function set(o: Cfg, p: string, v: unknown) {
  const ks = p.split('.'); let cur = o
  ks.slice(0, -1).forEach((k) => { if (cur[k] == null) cur[k] = {}; cur = cur[k] })
  cur[ks[ks.length - 1]] = v
}

/** Build the dropdown options for a dynamic SuperSource/M-E field from the live
 *  ATEM state; empty until the switcher is connected. */
function dynOptions(dyn: NonNullable<Field['dyn']>, state: Snapshot | null): Opt[] {
  const o = state?.atem?.options
  const connected = state?.atem?.connected
  if (!connected || !o) return []
  if (dyn === 'ss') return Array.from({ length: o.superSourceCount }, (_, i) => ({ value: i, label: `SuperSource ${i + 1}` }))
  if (dyn === 'me') return Array.from({ length: o.meCount }, (_, i) => ({ value: i, label: `M/E ${i + 1}` }))
  if (dyn === 'box') return Array.from({ length: o.boxCount }, (_, i) => ({ value: i, label: `Box ${i + 1}` }))
  // input: from the ATEM's input list, numeric ids sorted
  return Object.entries(state!.atem.inputs)
    .map(([id, name]) => ({ value: Number(id), label: `${name} · ${id}` }))
    .sort((a, b) => (a.value as number) - (b.value as number))
}

export function SettingsDialog({ open, onOpenChange, state }: { open: boolean; onOpenChange: (o: boolean) => void; state: Snapshot | null }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [instances, setInstances] = useState<{ id: string; typeId: string; name: string }[]>([])
  const [sel, setSel] = useState<{ atemInstanceId?: string; hyperdeckInstanceId?: string; propresenterInstanceId?: string }>({})

  useEffect(() => {
    if (!open) return
    setError(null); setSaveState('idle')
    fetch('/api/settings').then((r) => r.json()).then((b) => {
      const s = b.settings ?? {}
      setCfg({ supersource: s.supersource ?? {}, animation: s.animation ?? {}, transition: s.transition ?? {} })
      setSel(s.atemTransitions ?? {})
    }).catch((e) => setError(e.message))
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances(b.instances ?? [])).catch(() => {})
  }, [open])

  const saveSel = (next: typeof sel) => {
    setSel(next)
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atemTransitions: next }) }).catch(() => {})
  }
  const atems = instances.filter((i) => i.typeId === 'atem')
  const hyperdecks = instances.filter((i) => i.typeId === 'hyperdeck')
  const propres = instances.filter((i) => i.typeId === 'propresenter')

  // Save one section immediately on change — everything here is live.
  const push = (next: Cfg) => {
    setCfg(next)
    setSaveState('saving')
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supersource: next.supersource, animation: next.animation, transition: next.transition }) })
      .then((r) => r.json()).then((b) => { if (!b.ok) throw new Error(b.error); setSaveState('saved'); setTimeout(() => setSaveState('idle'), 1500) })
      .catch((e) => { setError((e as Error).message); setSaveState('idle') })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] bg-background border-border p-0 gap-0">
        <DialogHeader className="p-5 pb-3">
          <DialogTitle className="flex items-center gap-2"><Settings className="size-4" /> Settings</DialogTitle>
          <DialogDescription>ATEM Transitions engine settings — applied live. Device connections live under Settings → Connections.</DialogDescription>
        </DialogHeader>
        <Separator />

        <ScrollArea className="max-h-[60vh]">
          <div className="p-5 space-y-6">
            {!cfg && !error && <div className="text-muted-foreground text-sm flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
            <section>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-0.5">Instances</div>
              <div className="text-[11px] text-muted-foreground/80 mb-2">Which connections this app drives. Add or configure them under Settings → Connections.</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-2">
                <label className="block">
                  <div className="text-[11.5px] mb-1">ATEM</div>
                  <select value={sel.atemInstanceId ?? ''} onChange={(e) => saveSel({ ...sel, atemInstanceId: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                    <option value="">— select —</option>
                    {atems.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <div className="text-[11.5px] mb-1">HyperDeck</div>
                  <select value={sel.hyperdeckInstanceId ?? ''} onChange={(e) => saveSel({ ...sel, hyperdeckInstanceId: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                    <option value="">— select —</option>
                    {hyperdecks.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <div className="text-[11.5px] mb-1">ProPresenter</div>
                  <select value={sel.propresenterInstanceId ?? ''} onChange={(e) => saveSel({ ...sel, propresenterInstanceId: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                    <option value="">— select —</option>
                    {propres.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
              </div>
            </section>
            {cfg && GROUPS.map((g) => (
              <section key={g.title}>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-0.5">{g.title}</div>
                {g.desc && <div className="text-[11px] text-muted-foreground/80 mb-2">{g.desc}</div>}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-2">
                  {g.fields.map((f) => {
                    const v = get(cfg, f.path)
                    const dynOpts = f.dyn ? dynOptions(f.dyn, state) : null
                    const change = (val: unknown) => { const c = structuredClone(cfg); set(c, f.path, val); push(c) }
                    return (
                      <label key={f.path} className="block">
                        <div className="text-[11.5px] mb-1">{f.label}</div>
                        {f.dyn ? (
                          dynOpts && dynOpts.length ? (
                            <select value={v ?? ''} onChange={(e) => change(e.target.value === '' ? null : Number(e.target.value))}
                              className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                              {v != null && !dynOpts.some((o) => o.value === v) && <option value={v}>{`(current: ${v})`}</option>}
                              {dynOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          ) : (
                            <div className="h-9 flex items-center rounded-md border border-dashed border-border bg-muted/20 px-2.5 text-[12px] text-muted-foreground">
                              connect the ATEM{v != null ? ` (now: ${v})` : ''}
                            </div>
                          )
                        ) : f.type === 'select' ? (
                          <select value={v ?? ''} onChange={(e) => change(e.target.value)}
                            className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                            {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <Input value={v ?? ''} type={f.type === 'number' ? 'number' : 'text'} className="h-9 bg-muted/40 text-[13px] font-mono"
                            onChange={(e) => { const raw = e.target.value; change(f.type === 'number' ? (raw === '' ? null : Number(raw)) : raw) }} />
                        )}
                        {f.hint && <div className="text-[10.5px] text-muted-foreground mt-1">{f.hint}</div>}
                      </label>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>

        <Separator />
        <div className="p-4">
          {error && <div className="text-[12px] text-destructive flex items-center gap-2 mb-2"><AlertTriangle className="size-4" /> {error}</div>}
          <DialogFooter className="items-center">
            <span className={cn('mr-auto text-[12px] flex items-center gap-1.5 transition-opacity',
              saveState === 'idle' ? 'opacity-0' : 'opacity-100 text-live')}>
              {saveState === 'saving' ? <><Loader2 className="size-3.5 animate-spin text-muted-foreground" /> <span className="text-muted-foreground">Saving…</span></> : <><Check className="size-3.5" /> Saved</>}
            </span>
            <Button onClick={() => onOpenChange(false)} variant="secondary">Done</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
