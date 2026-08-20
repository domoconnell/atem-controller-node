'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WireLine } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ChevronUp, ChevronDown, Pause, Play, Trash2, ArrowDownToLine } from 'lucide-react'

/**
 * Live device wire log: one compact monospace line per message to/from the
 * ATEM (or sim), HyperDeck, OSC/Companion and ProPresenter. Collapsed by
 * default to a one-line ticker; expands to a scrollable drawer with
 * per-protocol filters, pause and clear. Fixed heights - no layout shift.
 */
const PROTO_META: Record<string, { tag: string; color: string }> = {
  atem:      { tag: 'ATEM', color: 'text-primary' },
  asim:      { tag: 'ASIM', color: 'text-busy' },
  hyperdeck: { tag: 'HDCK', color: 'text-[#26c6da]' },
  osc:       { tag: 'OSC',  color: 'text-live' },
  companion: { tag: 'CMPN', color: 'text-[#d77df0]' },
  propres:   { tag: 'PRO',  color: 'text-info' },
}
const meta = (p: string) => PROTO_META[p] ?? { tag: p.slice(0, 4).toUpperCase(), color: 'text-muted-foreground' }

function ts(t: number) {
  return new Date(t).toISOString().slice(11, 23)
}

function Row({ l }: { l: WireLine }) {
  const m = meta(l.proto)
  if (l.repeat) {
    return (
      <div className="flex gap-2 text-muted-foreground/60 leading-[1.5]">
        <span className="w-[86px] shrink-0" />
        <span className="shrink-0">⋮</span>
        <span className={cn('shrink-0 font-bold', m.color, 'opacity-60')}>{l.dir === 'tx' ? '→' : '←'} {m.tag}</span>
        <span className="truncate">{l.kind} ×{l.repeat} more</span>
      </div>
    )
  }
  return (
    <div className={cn('flex gap-2 leading-[1.5]', l.dir === 'rx' && 'opacity-80')}>
      <span className="w-[86px] shrink-0 text-muted-foreground/50">{ts(l.t)}</span>
      <span className={cn('shrink-0 font-bold w-[52px]', m.color)}>{l.dir === 'tx' ? '→' : '←'} {m.tag}</span>
      <span className="shrink-0 text-foreground/90 whitespace-pre">{l.summary}</span>
      {l.detail && <span className="truncate text-muted-foreground/60">{l.detail}</span>}
    </div>
  )
}

export function WireLog({ lines, version, onClear }: { lines: WireLine[]; version: number; onClear: () => void }) {
  const [open, setOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [filters, setFilters] = useState<Record<string, boolean>>({})
  const [follow, setFollow] = useState(true)
  const frozen = useRef<WireLine[]>([])
  const scroller = useRef<HTMLDivElement>(null)

  if (!paused) frozen.current = lines
  const shown = useMemo(
    () => frozen.current.filter((l) => filters[l.proto] !== false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, paused, filters]
  )

  useEffect(() => {
    if (open && follow && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  }, [version, open, follow, paused, filters])

  const protos = ['atem', 'asim', 'hyperdeck', 'osc', 'companion', 'propres']
  const last = lines[lines.length - 1]

  return (
    <div className="shrink-0 border-t border-border/70 bg-background/90 font-mono text-[10.5px]">
      {/* ticker / header bar - fixed height */}
      <div className="h-8 flex items-center gap-3 px-4 select-none">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[10px] font-sans font-bold uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />} Wire log
        </button>
        {!open && last && !last.repeat && (
          <div className="flex-1 min-w-0 flex gap-2 items-center opacity-70">
            <Row l={last} />
          </div>
        )}
        {open && (
          <>
            <div className="flex items-center gap-1 font-sans">
              {protos.map((p) => {
                const m = meta(p)
                const on = filters[p] !== false
                return (
                  <button key={p}
                    onClick={() => setFilters((f) => ({ ...f, [p]: !(f[p] !== false) }))}
                    className={cn('px-1.5 py-0.5 rounded text-[9px] font-bold border transition-colors',
                      on ? cn(m.color, 'border-current/40 bg-current/5') : 'text-muted-foreground/40 border-border')}>
                    {m.tag}
                  </button>
                )
              })}
            </div>
            <div className="ml-auto flex items-center gap-1 font-sans">
              <button onClick={() => setFollow((f) => !f)} title="auto-scroll to newest"
                className={cn('p-1 rounded hover:bg-accent', follow ? 'text-live' : 'text-muted-foreground')}>
                <ArrowDownToLine className="size-3.5" />
              </button>
              <button onClick={() => setPaused((p) => !p)} title={paused ? 'resume' : 'pause'}
                className={cn('p-1 rounded hover:bg-accent', paused ? 'text-busy' : 'text-muted-foreground')}>
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </button>
              <button onClick={onClear} title="clear" className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
              <span className="text-[9px] font-sans text-muted-foreground tabular ml-1">{shown.length}</span>
            </div>
          </>
        )}
      </div>
      {/* drawer - fixed height when open */}
      {open && (
        <div
          ref={scroller}
          onWheel={() => setFollow(false)}
          className="h-[228px] overflow-y-auto overflow-x-hidden px-4 pb-2 border-t border-border/40"
        >
          {shown.length === 0 && <div className="text-muted-foreground/50 pt-2">no traffic yet</div>}
          {shown.map((l, i) => <Row key={i} l={l} />)}
        </div>
      )}
    </div>
  )
}
