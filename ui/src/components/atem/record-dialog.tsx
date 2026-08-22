'use client'
import { useEffect, useState } from 'react'
import { cmd } from '@/lib/api'
import type { ProLook, ProMedia, Snapshot } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Circle, MonitorPlay, Film } from 'lucide-react'
import { SsMonitor } from './ss-monitor'
import { liveScene } from '@/lib/scene'

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function RecordDialog({ open, onOpenChange, state, locked }: {
  open: boolean; onOpenChange: (o: boolean) => void; state: Snapshot; locked: boolean
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // ProPresenter: the look captured with this Stage It look, plus an optional
  // macro (theme+background bundle) to fire when the look is taken.
  const [pro, setPro] = useState<{ current: ProLook | null; currentMedia: ProMedia | null; macros: ProLook[] } | null>(null)
  const [macroId, setMacroId] = useState('')
  const canon = slug(name)
  const exists = !!canon && state.looks.some((l) => l.name === canon)
  const inputName = (id: number) => state.atem.inputs[id] ?? String(id)
  const me = state.atem.mixEffects[state.mainMe]

  useEffect(() => {
    if (!open) return
    setMacroId('')
    fetch('/api/features/propresenter/looks').then((r) => r.json())
      .then((b) => setPro(b.ok ? { current: b.current ?? null, currentMedia: b.currentMedia ?? null, macros: b.macros ?? [] } : null))
      .catch(() => setPro(null))
  }, [open])

  const go = async () => {
    if (!canon || busy) return
    if (exists && !confirm(`'${canon}' already exists — overwrite it with the current live state?`)) return
    setBusy(true)
    const r = await cmd('/look/capture', [canon])
    // Capture already records the live PP look + background media; attaching a
    // macro re-writes the whole block, so carry the captured look/media through.
    const macro = pro?.macros.find((m) => String(m.uuid) === macroId)
    if (r.ok && macro) {
      await fetch(`/api/looks/${encodeURIComponent(canon)}/pro`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ look: pro?.current ?? null, media: pro?.currentMedia ?? null, macro }),
      }).catch(() => {})
    }
    setBusy(false)
    if (!r.ok) return alert(r.error)
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-background border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Circle className="size-3 fill-pgm text-pgm" /> Record a look
          </DialogTitle>
          <DialogDescription>
            Captures everything live right now: SuperSource boxes + art, M/E {state.mainMe + 1} program/preview,
            all four USKs with settings, and the HyperDeck transport.
          </DialogDescription>
        </DialogHeader>

        <SsMonitor scene={liveScene(state).scene} inputName={inputName} label="Live" tally="pgm"
          sublabel={me ? inputName(me.programInput) : undefined} className="p-1.5" />

        <div className="space-y-1.5">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="look name, e.g. worship-zoom-top" className="h-10 text-[14px] bg-muted/40" disabled={locked} />
          <div className="text-[11px] text-muted-foreground h-4">
            {canon && canon !== name.trim() && <>Saved as <b className="text-foreground">{canon}</b></>}
            {exists && <span className="text-busy"> · will overwrite the existing look</span>}
          </div>
        </div>

        {pro && (
          <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2">
            {pro?.current && (
              <div className="flex items-center gap-1.5 text-[12px]">
                <MonitorPlay className="size-3.5 text-info" />
                <span className="text-muted-foreground">ProPresenter look</span>
                <b className="text-foreground">{pro.current.name}</b>
                <span className="text-[10px] text-muted-foreground/70">— recalled when this look is taken</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[12px]">
              <Film className="size-3.5 text-info" />
              <span className="text-muted-foreground">Background</span>
              {pro?.currentMedia?.item?.name
                ? <b className="text-foreground">{pro.currentMedia.item.name}</b>
                : <span className="text-muted-foreground/60">none on the wall</span>}
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0">Also fire macro</span>
              <select value={macroId} onChange={(e) => setMacroId(e.target.value)} disabled={locked}
                className="flex-1 h-8 rounded-md bg-muted/40 border border-border px-2 text-[12px] text-foreground disabled:opacity-40">
                <option value="">None</option>
                {pro.macros.map((m) => <option key={String(m.uuid)} value={String(m.uuid)}>{m.name}</option>)}
              </select>
            </label>
            {!pro.macros.length && <div className="text-[10px] text-muted-foreground/60">No macros defined in ProPresenter.</div>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={go} disabled={locked || !canon || busy} className="font-bold bg-pgm text-white hover:bg-pgm/90">
            <Circle className="size-3 fill-current" /> {exists ? 'Overwrite' : 'Record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
