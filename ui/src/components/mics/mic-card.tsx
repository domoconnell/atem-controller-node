'use client'
import type { SennChannel, SennDevice } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SegMeter, Battery, Antenna } from './meters'
import { MicOff, Radio } from 'lucide-react'

const FAMILY = {
  ewdx: { label: 'EW-DX', accent: 'text-[#2dd4bf] border-[#2dd4bf]/30 bg-[#2dd4bf]/5' },
  g3: { label: 'G3', accent: 'text-primary border-primary/30 bg-primary/5' },
  iemg4: { label: 'IEM G4', accent: 'text-[#d77df0] border-[#d77df0]/30 bg-[#d77df0]/5' },
  g3legacy: { label: 'G3', accent: 'text-primary border-primary/30 bg-primary/5' },
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

/**
 * "Present but mute" card: the unit answers ping but not the telemetry
 * protocol (e.g. an ew G3 on firmware < 1.7). We can only show that it's
 * powered and linked - honest about the rest.
 */
function MuteCard({ dev }: { dev: SennDevice }) {
  const fam = FAMILY[dev.type]
  return (
    <div className="surface rounded-xl px-3.5 py-3 flex flex-col gap-2.5 border border-busy/40 bg-busy/[0.04]">
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-bold tracking-tight leading-none truncate">{(dev.label ?? dev.ip).replace('127.0.0.1', 'sim')}</span>
        <span className={cn('ml-auto shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] rounded px-1.5 py-0.5 border', fam.accent)}>{fam.label}</span>
      </div>
      <div className="flex items-center gap-2 text-busy">
        <Radio className="size-3.5 shrink-0 animate-pulse" />
        <span className="text-[12px] font-semibold leading-tight">Connecting…</span>
      </div>
      <p className="text-[10.5px] leading-snug text-muted-foreground">
        Reachable on the network — waiting for telemetry from the receiver.
      </p>
      <div className="flex items-center gap-2 pt-0.5 border-t border-border/40">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-live"><Radio className="size-3" />link up</span>
        {dev.pingMs != null && <span className="text-[10px] tabular-nums text-muted-foreground">ping {dev.pingMs} ms</span>}
        <span className="ml-auto text-[9.5px] font-mono text-muted-foreground/50">{dev.ip.replace('127.0.0.1', 'sim')}</span>
      </div>
    </div>
  )
}

/** One card per wireless channel (an EW-DX EM2 yields two). */
export function MicCard({ dev, ch }: { dev: SennDevice; ch: SennChannel }) {
  const hasTelemetry = dev.online
  // Reachable via ping but silent on every protocol -> present-but-mute card.
  if (!hasTelemetry && dev.reachable) return <MuteCard dev={dev} />

  // A receiver reached over the legacy protocol is just a G3 to the user.
  const dtype = dev.type === 'g3legacy' ? 'g3' : dev.type
  const fam = FAMILY[dtype]
  const offline = !hasTelemetry
  const isIem = dtype === 'iemg4'
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
          {dtype === 'ewdx' && ch.gain != null && `gain ${ch.gain} dB`}
          {dtype === 'g3' && ch.squelch != null && `squelch ${ch.squelch} dB · out ${ch.afOut} dB`}
          {isIem && ch.sensitivity != null && `sens ${ch.sensitivity} dB · ${ch.stereo ? 'stereo' : 'mono'}`}
        </span>
      </div>

      {/* meters */}
      <div className="flex flex-col gap-1.5">
        {!isIem && (
          <MeterRow label="RF" kind="rf" value={ch.rf ?? null}
            right={dtype === 'ewdx'
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
            right={dtype === 'ewdx' && ch.afDb != null ? `${ch.afDb} dB` : undefined} />
        )}
      </div>

      {/* footer */}
      <div className="flex items-center gap-2 pt-0.5 border-t border-border/40">
        {isIem
          ? <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><Radio className="size-3" />rack send</span>
          : <Battery pct={offline ? null : ch.battery} pending={!offline && ch.batteryPending} />}
        {dtype === 'ewdx' && ch.rsqi != null && !offline && (
          <span className="text-[10px] tabular-nums text-muted-foreground" title="RF signal quality">Q {ch.rsqi}%</span>
        )}
        {!isIem && <Antenna active={offline ? undefined : ch.ant} />}
        <span className="ml-auto text-[9.5px] font-mono text-muted-foreground/50" title={dev.version ? `firmware ${dev.version}` : undefined}>
          {offline ? 'OFFLINE' : dev.ip.replace('127.0.0.1', 'sim')}{dtype === 'ewdx' ? ` · ${ch.id}` : ''}{dev.version && !offline ? ` · fw ${dev.version}` : ''}
        </span>
      </div>
    </div>
  )
}
