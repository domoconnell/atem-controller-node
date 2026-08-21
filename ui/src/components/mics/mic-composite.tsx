'use client'
import { useCallback, useEffect, useState } from 'react'
import { useStream } from '@/hooks/use-topic'
import { cn } from '@/lib/utils'
import { SegMeter, Battery, Antenna } from './meters'
import { MicOff, Radio, Pencil, Trash2, Plus, X } from 'lucide-react'

/** A composite Mic = Sennheiser receiver channel + DiGiCo channel + internal cue. */
export interface Mic {
  id: string
  label: string
  sortOrder?: number
  sennheiserInstanceId?: string
  sennheiserChannel?: string
  digicoInstanceId?: string
  digicoChannel?: number
  cue?: CueState
}
export type CueState = 'live' | 'standby' | 'off'
interface Ch { id: string; name?: string; frequency?: number; rf?: number | null; af?: number | null; battery?: number | null; batteryPending?: boolean; ant?: number; mute?: boolean }
interface DChan { channel: number; name: string; muted: boolean }

const mhz = (khz?: number) => khz == null ? '—' : `${(khz / 1000).toFixed(3)} MHz`
const CUE: Record<CueState, { label: string; cls: string }> = {
  live: { label: 'LIVE', cls: 'bg-live text-black' },
  standby: { label: 'STANDBY', cls: 'bg-busy text-black' },
  off: { label: 'OFF', cls: 'bg-muted text-muted-foreground' },
}
const nextCue = (c: CueState): CueState => (c === 'off' ? 'standby' : c === 'standby' ? 'live' : 'off')

/** Live composite card: RF/AF meters + battery (Sennheiser), mute (DiGiCo),
 *  cue (internal, click to cycle). Reuses the polished meter components. */
export function MicComposite({ mic, onCue, onEdit }: { mic: Mic; onCue: (id: string, cue: CueState) => void; onEdit: (m: Mic) => void }) {
  const senn = useStream(mic.sennheiserInstanceId ?? null, 'channels') as { channels?: Ch[]; online?: boolean } | null
  const ch = senn?.channels?.find((c) => c.id === mic.sennheiserChannel) ?? senn?.channels?.[0]
  const online = !!senn?.online
  const dig = useStream(mic.digicoInstanceId ?? null, 'channels') as { channels?: DChan[] } | null
  const dch = mic.digicoChannel != null ? dig?.channels?.find((c) => c.channel === mic.digicoChannel) : undefined
  const cue = mic.cue ?? 'off'
  const muted = dch?.muted

  return (
    <div className={cn('surface rounded-xl px-3.5 py-3 flex flex-col gap-2.5 border border-border/60', !online && 'opacity-60')}>
      {/* name + cue */}
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-bold tracking-tight leading-none truncate">{mic.label}</span>
        <button onClick={() => onCue(mic.id, nextCue(cue))} title="Cue state (click to cycle)"
          className={cn('ml-auto shrink-0 text-[9px] font-black uppercase tracking-[0.12em] rounded px-1.5 py-0.5', CUE[cue].cls)}>{CUE[cue].label}</button>
        <button onClick={() => onEdit(mic)} className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"><Pencil className="size-3" /></button>
      </div>

      {/* frequency + channel name */}
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-[12px] text-foreground/90 tabular-nums">{online ? mhz(ch?.frequency) : '— offline —'}</span>
        {ch?.name?.trim() && <span className="text-[10px] text-muted-foreground/70 truncate">{ch.name.trim()}</span>}
      </div>

      {/* meters */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2"><span className="w-[16px] text-[9px] font-bold uppercase text-muted-foreground/70">RF</span><SegMeter value={online ? ch?.rf : null} kind="rf" className="flex-1" /></div>
        <div className="flex items-center gap-2"><span className="w-[16px] text-[9px] font-bold uppercase text-muted-foreground/70">AF</span><SegMeter value={online ? ch?.af : null} kind="af" className="flex-1" /></div>
      </div>

      {/* footer: battery · antenna · DiGiCo mute */}
      <div className="flex items-center gap-2 pt-0.5 border-t border-border/40">
        <Battery pct={online ? ch?.battery : null} pending={online ? ch?.batteryPending : false} />
        {ch?.ant != null && online && <Antenna active={ch.ant} />}
        {mic.digicoInstanceId ? (
          muted == null
            ? <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/50"><Radio className="size-3" />no console</span>
            : muted
              ? <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-semibold text-destructive"><MicOff className="size-3.5" /> MUTED</span>
              : <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-semibold text-live">UNMUTED</span>
        ) : <span className="ml-auto text-[9.5px] text-muted-foreground/40 uppercase tracking-wider">no console ch</span>}
      </div>
    </div>
  )
}

/** Load + mutate the mic objects. */
export function useMics() {
  const [mics, setMics] = useState<Mic[]>([])
  const load = useCallback(() => fetch('/api/features/mics').then((r) => r.json()).then((b) => setMics(b.mics ?? [])).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const save = useCallback(async (m: Partial<Mic> & { id?: string }) => {
    const method = m.id ? 'PATCH' : 'POST'
    const url = m.id ? `/api/features/mics/${m.id}` : '/api/features/mics'
    const b = await (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) })).json()
    setMics(b.mics ?? [])
  }, [])
  const remove = useCallback(async (id: string) => {
    const b = await (await fetch(`/api/features/mics/${id}`, { method: 'DELETE' })).json(); setMics(b.mics ?? [])
  }, [])
  return { mics, save, remove, reload: load }
}

const sc = 'h-9 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px]'

/** Create / edit a mic mapping. */
export function MicEditor({ mic, sennInstances, digicoInstances, onSave, onDelete, onClose }: {
  mic: Partial<Mic> | null
  sennInstances: { id: string; name: string }[]
  digicoInstances: { id: string; name: string }[]
  onSave: (m: Partial<Mic>) => void; onDelete: (id: string) => void; onClose: () => void
}) {
  const [m, setM] = useState<Partial<Mic>>(mic ?? { label: '', cue: 'off' })
  if (!mic) return null
  const set = (patch: Partial<Mic>) => setM((x) => ({ ...x, ...patch }))
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 grid place-items-center" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-border bg-background p-5 space-y-3.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="text-[15px] font-bold">{m.id ? 'Edit mic' : 'New mic'}</h2><button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"><X className="size-4" /></button></div>
        <label className="block"><div className="text-[11.5px] mb-1">Name</div>
          <input autoFocus value={m.label ?? ''} onChange={(e) => set({ label: e.target.value })} placeholder="Dan" className={sc} /></label>
        <label className="block"><div className="text-[11.5px] mb-1">Sennheiser receiver</div>
          <select value={m.sennheiserInstanceId ?? ''} onChange={(e) => set({ sennheiserInstanceId: e.target.value })} className={sc}>
            <option value="">— none —</option>
            {sennInstances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><div className="text-[11.5px] mb-1">DiGiCo console</div>
            <select value={m.digicoInstanceId ?? ''} onChange={(e) => set({ digicoInstanceId: e.target.value })} className={sc}>
              <option value="">— none —</option>
              {digicoInstances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select></label>
          <label className="block"><div className="text-[11.5px] mb-1">DiGiCo channel #</div>
            <input type="number" value={m.digicoChannel ?? ''} onChange={(e) => set({ digicoChannel: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="1" className={sc} /></label>
        </div>
        <div className="flex items-center gap-2 pt-1">
          {m.id && <button onClick={() => { onDelete(m.id!); onClose() }} className="inline-flex items-center gap-1.5 text-[12px] text-destructive px-2.5 py-1.5 rounded-md hover:bg-destructive/10"><Trash2 className="size-3.5" /> Delete</button>}
          <button onClick={onClose} className="ml-auto text-[12px] px-3 py-1.5 rounded-md hover:bg-accent">Cancel</button>
          <button onClick={() => { onSave(m); onClose() }} disabled={!m.label?.trim()} className="text-[12px] px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  )
}

export const AddMicButton = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} className="inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md px-2.5 py-1.5 border border-border hover:bg-accent">
    <Plus className="size-3.5" /> Mic
  </button>
)
