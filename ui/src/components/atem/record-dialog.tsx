'use client'
import { useState } from 'react'
import { cmd } from '@/lib/api'
import type { Snapshot } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Circle } from 'lucide-react'
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
  const canon = slug(name)
  const exists = !!canon && state.looks.some((l) => l.name === canon)
  const inputName = (id: number) => state.atem.inputs[id] ?? String(id)
  const me = state.atem.mixEffects[state.mainMe]

  const go = async () => {
    if (!canon || busy) return
    if (exists && !confirm(`'${canon}' already exists — overwrite it with the current live state?`)) return
    setBusy(true)
    const r = await cmd('/look/capture', [canon])
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
