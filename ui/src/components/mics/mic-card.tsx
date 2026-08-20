'use client'
import type { SennChannel, SennDevice } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SegMeter, Battery, Antenna } from './meters'
import { MicOff, Radio } from 'lucide-react'

const FAMILY = {
  ewdx: { label: 'EW-DX', accent: 'text-[#2dd4bf] border-[#2dd4bf]/30 bg-[#2dd4bf]/5' },
  g3: { label: 'G3', accent: 'text-primary border-primary/30 bg-primary/5' },
  iemg4: { label: 'IEM G4', accent: 'text-[#d77df0] border-[#d77df0]/30 bg-[#d77df0]/5' },
}

const mhz = (khz?: number) => khz == null ? '—' : `${(khz / 1000).toFixed(3)} MHz`

function MeterRow({ label, value, kind, right }: { label: string; value: number | null | undefined; kind: 'af' | 'rf'; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[16px] text-[9px] font-bold uppercase text-muted-foreground/70">{label}</span>
      <SegMeter value={value} kind={kind} className="flex-1" />
      <span className="w-[64px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{right}</span>
    </div>
  )
}

/** One card per wireless channel (an EW-DX EM2 yields two). */
export function MicCard({ dev, ch }: { dev: SennDevice; ch: SennChannel }) {
  const fam = FAMILY[dev.type]
  const offline = !dev.online
  const isIem = dev.type === 'iemg4'
  const name = (ch.name ?? dev.label ?? dev.ip).trim()
  return (
    <div className={cn(
      'surface rounded-xl px-3.5 py-3 flex flex-col gap-2.5 border border-border/60 transition-opacity',
      offline && 'opacity-40 grayscale'
    )}>
      {/* name row */}
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-bold tracking-tight leading-none truncate">{name}</span>
        {ch.mute && <MicOff className="size-3.5 text-red-500" aria-label="muted" />}
        <span className={cn('ml-auto shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] rounded px-1.5 py-0.5 border', fam.accent)}>
          {isIem ? 'IEM →' : fam.label}
        </span>
      </div>

      {/* frequency + tuning info */}
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-[13px] text-foreground/90 tabular-nums">{offline ? '— offline —' : mhz(ch.frequency)}</span>
        <span className="text-[10px] text-muted-foreground/70 truncate">
          {dev.type === 'ewdx' && ch.gain != null && `gain ${ch.gain} dB`}
          {dev.type === 'g3' && ch.squelch != null && `squelch ${ch.squelch} dB · out ${ch.afOut} dB`}
          {isIem && ch.sensitivity != null && `sens ${ch.sensitivity} dB · ${ch.stereo ? 'stereo' : 'mono'}`}
        </span>
      </div>

      {/* meters */}
      <div className="flex flex-col gap-1.5">
        {!isIem && (
          <MeterRow label="RF" kind="rf" value={ch.rf ?? null}
            right={dev.type === 'ewdx'
              ? (ch.rssi != null ? `${ch.rssi} dBm` : '—')
              : (ch.rf1 != null ? `${Math.max(ch.rf1 ?? 0, ch.rf2 ?? 0)}` : '—')}
          />
        )}
        {isIem ? (
          <>
            <MeterRow label="L" kind="af" value={(ch.afRaw?.[0] ?? 0) / 100} right={ch.afRaw ? `${ch.afRaw[0]}` : '—'} />
            <MeterRow label="R" kind="af" value={(ch.afRaw?.[1] ?? 0) / 100} right={ch.afRaw ? `${ch.afRaw[1]}` : '—'} />
          </>
        ) : (
          <MeterRow label="AF" kind="af" value={ch.af ?? null}
            right={dev.type === 'ewdx' && ch.afDb != null ? `${ch.afDb} dB` : undefined} />
        )}
      </div>

      {/* footer */}
      <div className="flex items-center gap-2 pt-0.5 border-t border-border/40">
        {isIem
          ? <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><Radio className="size-3" />rack send</span>
          : <Battery pct={offline ? null : ch.battery} />}
        {!isIem && dev.type !== 'ewdx' && <Antenna active={offline ? undefined : ch.ant} />}
        {dev.type === 'ewdx' && ch.rsqi != null && !offline && (
          <span className="text-[10px] tabular-nums text-muted-foreground" title="RF signal quality">Q {ch.rsqi}%</span>
        )}
        {dev.type === 'ewdx' && <Antenna active={offline ? undefined : ch.ant} />}
        <span className="ml-auto text-[9.5px] font-mono text-muted-foreground/50" title={dev.version ? `firmware ${dev.version}` : undefined}>
          {offline ? 'OFFLINE' : dev.ip.replace('127.0.0.1', 'sim')}{dev.type === 'ewdx' ? ` · ${ch.id}` : ''}{dev.version && !offline ? ` · fw ${dev.version}` : ''}
        </span>
      </div>
    </div>
  )
}
