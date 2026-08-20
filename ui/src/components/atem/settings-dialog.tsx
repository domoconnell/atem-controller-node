'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Settings, RotateCcw, Save, AlertTriangle, Loader2 } from 'lucide-react'

type Cfg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Field {
  path: string
  label: string
  hint?: string
  type?: 'text' | 'number' | 'select'
  options?: string[]
  hot?: boolean
}
interface Group { title: string; desc?: string; fields: Field[] }

const GROUPS: Group[] = [
  { title: 'SuperSource / M/E', fields: [
    { path: 'supersource.id', label: 'SuperSource', type: 'number', hint: '0 = SuperSource 1' },
    { path: 'supersource.me', label: 'Main M/E', type: 'number', hint: 'zero-indexed: 1 = M/E 2' },
    { path: 'supersource.ssInput', label: 'SuperSource input #', type: 'number', hint: 'ATEM input number, normally 6000' },
    { path: 'supersource.displayBox', label: 'Display box', type: 'number', hint: 'zero-indexed box carrying the main display (3 = box 4)', hot: true },
  ]},
  { title: 'Timing', desc: 'Applied live.', fields: [
    { path: 'animation.defaultDurationMs', label: 'Box move (ms)', type: 'number', hot: true },
    { path: 'animation.fps', label: 'Animation fps', type: 'number', hot: true },
    { path: 'animation.defaultEasing', label: 'Easing', type: 'select', hot: true,
      options: ['linear','easeInQuad','easeOutQuad','easeInOutQuad','easeInCubic','easeOutCubic','easeInOutCubic','easeInOutSine'] },
    { path: 'transition.keyFadeMs', label: 'Border key fade (ms)', type: 'number', hot: true },
    { path: 'transition.mixRateFrames', label: 'Pinned mix rate (frames)', type: 'number', hint: 'blank = inherit the switcher', hot: true },
    { path: 'transition.videoFps', label: 'Video fps', type: 'number', hint: 'for seconds → frames (50, or 60 for 59.94/60p)', hot: true },
  ]},
]

const get = (o: Cfg, p: string): any => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o) // eslint-disable-line @typescript-eslint/no-explicit-any
function set(o: Cfg, p: string, v: unknown) {
  const ks = p.split('.'); let cur = o
  ks.slice(0, -1).forEach((k, i) => {
    const nextIsIndex = /^\d+$/.test(ks[i + 1])
    if (cur[k] == null) cur[k] = nextIsIndex ? [] : {}
    cur = cur[k]
  })
  cur[ks[ks.length - 1]] = v
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [orig, setOrig] = useState<Cfg | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)
  const [instances, setInstances] = useState<{ id: string; typeId: string; name: string }[]>([])
  const [sel, setSel] = useState<{ atemInstanceId?: string; propresenterInstanceId?: string }>({})

  useEffect(() => {
    if (!open) return
    setError(null); setRestartRequired([])
    fetch('/api/config').then((r) => r.json()).then((b) => {
      setCfg(structuredClone(b.config)); setOrig(structuredClone(b.config))
    }).catch((e) => setError(e.message))
    fetch('/api/instances').then((r) => r.json()).then((b) => setInstances(b.instances ?? [])).catch(() => {})
    fetch('/api/settings').then((r) => r.json()).then((b) => setSel(b.settings?.atemTransitions ?? {})).catch(() => {})
  }, [open])

  const dirty = cfg && orig && JSON.stringify(cfg) !== JSON.stringify(orig)
  const saveSel = (next: typeof sel) => {
    setSel(next)
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atemTransitions: next }) }).catch(() => {})
  }
  const atems = instances.filter((i) => i.typeId === 'atem')
  const propres = instances.filter((i) => i.typeId === 'propresenter')

  const save = async () => {
    if (!cfg) return
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
      const b = await r.json()
      if (!b.ok) throw new Error(b.error)
      setOrig(structuredClone(b.config)); setCfg(structuredClone(b.config))
      setRestartRequired(b.restartRequired ?? [])
    } catch (e) { setError((e as Error).message) }
    setSaving(false)
  }

  const restart = async () => {
    if (!confirm('Restart the service now? Any running transition will be cut short. It comes back within a few seconds under systemd.')) return
    setRestarting(true)
    await fetch('/api/restart', { method: 'POST' }).catch(() => {})
    setTimeout(() => window.location.reload(), 4000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] bg-background border-border p-0 gap-0">
        <DialogHeader className="p-5 pb-3">
          <DialogTitle className="flex items-center gap-2"><Settings className="size-4" /> Settings</DialogTitle>
          <DialogDescription>ATEM Transitions engine settings. Device connections live under Settings → Connections.</DialogDescription>
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
                    const changed = JSON.stringify(v) !== JSON.stringify(get(orig!, f.path))
                    return (
                      <label key={f.path} className="block">
                        <div className="flex items-center gap-1.5 text-[11.5px] mb-1">
                          <span className={cn(changed && 'text-busy font-semibold')}>{f.label}</span>
                          {!f.hot && <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 border border-border rounded px-1">restart</span>}
                        </div>
                        {f.type === 'select' ? (
                          <select value={v ?? ''} onChange={(e) => { const c = structuredClone(cfg); set(c, f.path, e.target.value); setCfg(c) }}
                            className="h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]">
                            {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <Input value={v ?? ''} type={f.type === 'number' ? 'number' : 'text'} className="h-9 bg-muted/40 text-[13px] font-mono"
                            onChange={(e) => {
                              const c = structuredClone(cfg)
                              const raw = e.target.value
                              set(c, f.path, f.type === 'number' ? (raw === '' ? null : Number(raw)) : raw)
                              setCfg(c)
                            }} />
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
        <div className="p-4 space-y-3">
          {error && <div className="text-[12px] text-destructive flex items-center gap-2"><AlertTriangle className="size-4" /> {error}</div>}
          {restartRequired.length > 0 && (
            <div className="rounded-md border border-busy/50 bg-busy/10 p-3 text-[12px] flex items-start gap-3">
              <AlertTriangle className="size-4 text-busy shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold text-busy">Saved — restart needed for: <span className="font-mono">{restartRequired.join(', ')}</span></div>
                <div className="text-muted-foreground mt-0.5">The service exits and systemd brings it straight back; this page reloads itself.</div>
              </div>
              <Button size="sm" variant="secondary" onClick={restart} disabled={restarting} className="shrink-0">
                {restarting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Restart now
              </Button>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => { setCfg(structuredClone(orig)); }} disabled={!dirty}>Revert</Button>
            <Button onClick={save} disabled={!dirty || saving} className="font-bold">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
