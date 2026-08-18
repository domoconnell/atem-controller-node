'use client'
import type { Snapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { cmd } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Play, Square, Repeat, Zap, ArrowLeftRight } from 'lucide-react'

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
          {(me?.keyers?.length ? me.keyers : [null, null, null, null]).map((k, i) => (
            <button
              key={i}
              disabled={locked || !k}
              onClick={() => cmd('/usk', [i + 1, 'toggle'])}
              className={cn(
                'h-11 rounded-md border text-[12px] font-bold tabular transition-all',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                k?.onAir
                  ? 'bg-pgm/20 border-pgm text-pgm shadow-[0_0_14px_-3px_var(--pgm)]'
                  : 'bg-muted/40 border-border text-muted-foreground hover:border-foreground/30'
              )}
            >
              <div>K{i + 1}</div>
              <div className="text-[8px] uppercase tracking-[0.18em] font-semibold opacity-80">{k?.onAir ? 'On air' : 'Off'}</div>
            </button>
          ))}
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

      <div className="pt-1 flex gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-[11px] text-muted-foreground" onClick={() => cmd('/reload')}>
          <Zap className="size-3.5" /> Reload files
        </Button>
      </div>
    </div>
  )
}
