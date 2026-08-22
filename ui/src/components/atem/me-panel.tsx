'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Play, Square, Repeat, Zap, ArrowLeftRight, MonitorPlay } from 'lucide-react'
import { sourceColor } from './ss-monitor'
import { ppMediaThumb } from '@/lib/scene'

// Compact source names for the keyer tiles.
function shortSource(n: string): string {
  const mp = /^Media Player\s*(\d+)(\s*Key)?/i.exec(n); if (mp) return `MP${mp[1]}${mp[2] ? 'K' : ''}`
  if (/^SuperSource/i.test(n)) return 'SuperSrc'
  const cam = /^Cam(?:era)?\s*(\d+)/i.exec(n); if (cam) return `Cam ${cam[1]}`
  return n.length > 9 ? n.slice(0, 8) + '…' : n
}

// Short pattern names for the keyer tiles (ATEM Pattern enum order).
const PATTERN_SHORT: Record<number, string> = {
  0: 'L→R', 1: 'T→B', 2: 'H doors', 3: 'V doors', 4: 'corners', 5: 'rect', 6: 'diamond', 7: 'circle',
  8: 'TL box', 9: 'TR box', 10: 'BR box', 11: 'BL box', 12: 'T box', 13: 'R box', 14: 'B box', 15: 'L box', 16: 'TL diag', 17: 'TR diag',
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{k}</span>
      <span className="text-[12.5px] font-medium tabular text-right">{children}</span>
    </div>
  )
}

export function MePanel({ state, locked }: { state: Snapshot; locked: boolean }) {
  const me = state.atem.mixEffects[state.mainMe]
  const name = (id?: number) => (id == null ? '—' : state.atem.inputs[id] ?? String(id))
  const t = state.hyperdeck.transport || {}

  return (
    <div className="surface rounded-xl p-4 space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">M/E {state.mainMe + 1}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className={cn('rounded-lg p-3 border', 'border-pgm/40 bg-pgm/10')}>
            <div className="text-[9px] uppercase tracking-[0.2em] text-pgm font-bold">Program</div>
            <div className="text-[13px] font-semibold truncate mt-0.5">{name(me?.programInput)}</div>
          </div>
          <div className={cn('rounded-lg p-3 border', 'border-pvw/40 bg-pvw/10')}>
            <div className="text-[9px] uppercase tracking-[0.2em] text-pvw font-bold">Preview</div>
            <div className="text-[13px] font-semibold truncate mt-0.5">{name(me?.previewInput)}</div>
          </div>
        </div>
        {me?.inTransition && (
          <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-busy transition-[width] duration-75" style={{ width: `${Math.round((me.handlePosition / 10000) * 100)}%` }} />
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" className="flex-1 h-8 text-[11px]" disabled={locked} onClick={() => cmd('/transition/auto')}>
            <ArrowLeftRight className="size-3.5" /> Auto
          </Button>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">Upstream keyers</div>
        <div className="grid grid-cols-4 gap-1.5">
          {(me?.keyers?.length ? me.keyers : [null, null, null, null]).map((k, i) => {
            const fill = k?.fillSource != null ? name(k.fillSource) : null
            const type = k?.keyType ?? '—'
            const pat = k?.keyType === 'pattern' && k.pattern ? PATTERN_SHORT[k.pattern.style] ?? `p${k.pattern.style}` : null
            return (
              <button
                key={i}
                disabled={locked || !k}
                onClick={() => cmd('/usk', [i + 1, 'toggle'])}
                title={k ? `USK${i + 1} · ${type}${pat ? ' · ' + pat : ''} · fill: ${fill}${k.onAir ? ' · ON AIR' : ''}` : undefined}
                className={cn(
                  'h-[58px] rounded-md border text-[12px] font-bold tabular transition-all flex flex-col items-center justify-center gap-0.5 px-1 overflow-hidden',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  k?.onAir
                    ? 'bg-pgm/20 border-pgm text-pgm shadow-[0_0_14px_-3px_var(--pgm)]'
                    : 'bg-muted/40 border-border text-muted-foreground hover:border-foreground/30'
                )}
              >
                <div className="leading-none">K{i + 1}</div>
                <div className={cn('text-[8.5px] uppercase tracking-[0.1em] font-semibold leading-none whitespace-nowrap truncate max-w-full', k?.onAir ? 'text-pgm/90' : 'text-foreground/70')}>
                  {pat ? pat : type}
                </div>
                <div className="text-[8px] leading-none font-medium truncate max-w-full opacity-75 whitespace-nowrap" style={fill && !k?.onAir ? { color: sourceColor(k!.fillSource!) } : undefined}>
                  {fill ? shortSource(fill) : (k?.onAir ? 'On air' : 'Off')}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {state.atem.mediaPlayers && state.atem.mediaPlayers.some(Boolean) && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">Media players</div>
          <div className="rounded-lg bg-muted/40 border border-border p-3">
            {state.atem.mediaPlayers.map((mp) => mp && (
              <Row key={mp.index} k={`MP ${mp.index + 1}`}><span className="truncate max-w-[160px] inline-block align-bottom" title={mp.name}>{mp.name}</span></Row>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">HyperDeck</div>
        <div className="rounded-lg bg-muted/40 border border-border p-3">
          <Row k="Status">
            <span className={cn(t.status === 'play' && 'text-live')}>{t.status ?? '—'}</span>
          </Row>
          <Row k="Clip">{t['clip id'] ?? '—'}</Row>
          <Row k="Loop">{t.loop ?? '—'}</Row>
          <Row k="Format">{t['video format'] ?? '—'}</Row>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="secondary" className="h-8 text-[11px]" disabled={locked} onClick={() => cmd('/hyperdeck/play', [1])}><Repeat className="size-3.5" /> Loop</Button>
          <Button size="sm" variant="secondary" className="h-8 text-[11px]" disabled={locked} onClick={() => cmd('/hyperdeck/play', [0])}><Play className="size-3.5" /> Play</Button>
          <Button size="sm" variant="secondary" className="h-8 text-[11px]" disabled={locked} onClick={() => cmd('/hyperdeck/stop')}><Square className="size-3.5" /> Stop</Button>
        </div>
      </div>

      {state.propresenter?.configured && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 flex items-center gap-1.5">
            <MonitorPlay className="size-3" /> ProPresenter
            {!state.propresenter.connected && <span className="text-[9px] normal-case tracking-normal text-destructive/80">offline</span>}
          </div>
          <div className="rounded-lg bg-muted/40 border border-border p-3 space-y-2">
            <Row k="Look"><span className={cn(state.propresenter.currentLook?.name && 'text-info')}>{state.propresenter.currentLook?.name ?? '—'}</span></Row>
            <Row k="Background">{state.propresenter.currentMedia?.item?.name ?? '—'}</Row>
            {ppMediaThumb(state.propresenter.currentMedia, 300) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ppMediaThumb(state.propresenter.currentMedia, 300)!} alt="" className="w-full aspect-video object-cover rounded-md border border-border/60" />
            )}
          </div>
        </div>
      )}

      <div className="pt-1 flex gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-[11px] text-muted-foreground" onClick={() => cmd('/reload')}>
          <Zap className="size-3.5" /> Reload files
        </Button>
      </div>
    </div>
  )
}
