'use client'
import { useEffect, useState } from 'react'
import type { Plan, PlanStep } from '@/lib/types'
import { fetchPlan } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ArrowRight, Scissors, Waves, Move, Film, Eye, Loader2, ShieldCheck, ShieldAlert } from 'lucide-react'

/**
 * Human-readable storyboard of what the engine will do to reach `look`,
 * plus the simulator's verdict. Fetched on demand (hover) and cached briefly.
 */
const cache = new Map<string, { at: number; plan: Plan }>()

function describe(s: PlanStep, inputName: (id: number) => string): { icon: React.ComponentType<{ className?: string }>; text: string; tone: string } | null {
  switch (s.type) {
    case 'setNextTransition': return null
    case 'auto': return { icon: Waves, text: 'mix', tone: 'text-info' }
    case 'cut': return { icon: Scissors, text: 'cut', tone: 'text-muted-foreground' }
    case 'preview': return { icon: Eye, text: `preview ${inputName(s.input as number)}`, tone: 'text-muted-foreground' }
    case 'animateBoxes': {
      const t = (s.targets as (Record<string, number> | null)[]) ?? []
      const moving = t.map((b, i) => (b ? i + 1 : null)).filter(Boolean)
      const out = t.filter((b) => b && b.size === 0).length
      return { icon: Move, text: `animate box ${moving.join(',')}${out ? ` (${out} out)` : ''}`, tone: 'text-live' }
    }
    case 'animateUskPattern': return { icon: Move, text: `morph USK${(s.keyer as number) + 1}`, tone: 'text-live' }
    case 'setBoxes': return { icon: Film, text: 'set SS layout (offline)', tone: 'text-muted-foreground' }
    case 'setSsProperties': return { icon: Film, text: 'set SS art (offline)', tone: 'text-muted-foreground' }
    case 'uskSettings': return { icon: Film, text: `configure USK${(s.keyer as number) + 1}`, tone: 'text-muted-foreground' }
    case 'mediaPlayerSource': return { icon: Film, text: `MP${(s.player as number) + 1} → still ${((s.source as { stillIndex?: number })?.stillIndex ?? 0) + 1}`, tone: 'text-busy' }
    case 'hyperdeckEnsure': return { icon: Film, text: `HyperDeck ${s.status}`, tone: 'text-muted-foreground' }
    case 'setMixRate': return { icon: Waves, text: `rate ${s.frames}f`, tone: 'text-muted-foreground/60' }
    default: return null
  }
}

// Collapse "setNextTransition + auto" into one labelled fade.
function condense(steps: PlanStep[], inputName: (id: number) => string) {
  const out: { icon: React.ComponentType<{ className?: string }>; text: string; tone: string }[] = []
  let pendingSel: string[] | null = null
  for (const s of steps) {
    if (s.type === 'setNextTransition') { pendingSel = s.selection as string[]; continue }
    if (s.type === 'auto') {
      const sel = pendingSel ?? ['background']
      const keys = sel.filter((x) => x.startsWith('key')).map((k) => 'USK' + k.slice(3))
      const bg = sel.includes('background')
      out.push({ icon: Waves, text: bg ? `mix${keys.length ? ' + ' + keys.join(',') : ''}` : `fade ${keys.join(',')}`, tone: bg ? 'text-info' : 'text-pgm' })
      pendingSel = null
      continue
    }
    if (s.type === 'setCurrentLook') continue
    const d = describe(s, inputName)
    if (d) out.push(d)
  }
  return out
}

export function PlanStoryboard({ look, inputName, className }: { look: string | null; inputName: (id: number) => string; className?: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!look) { setPlan(null); return }
    const c = cache.get(look)
    if (c && Date.now() - c.at < 4000) { setPlan(c.plan); return }
    let alive = true
    setLoading(true)
    fetchPlan(look).then((p) => {
      if (!alive) return
      cache.set(look, { at: Date.now(), plan: p })
      setPlan(p); setLoading(false)
    }).catch(() => alive && setLoading(false))
    return () => { alive = false }
  }, [look])

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className={cn('h-[48px] flex items-center text-[11px] text-muted-foreground', className)}>{children}</div>
  )
  if (!look) return <Shell>Hover a look to preview its transition plan.</Shell>
  if (loading && !plan) return <Shell><Loader2 className="size-3 animate-spin mr-2" /> planning…</Shell>
  if (!plan || !plan.ok) return <Shell><span className="text-destructive">{plan?.error ?? 'no plan'}</span></Shell>

  const items = condense(plan.steps, inputName)
  const sim = plan.sim
  const clean = sim?.grade === 'clean'
  const dip = sim?.grade === 'dip'

  // Fixed two-line layout so the strip never changes height: line 1 =
  // verdict + counts + notes (single line, truncates), line 2 = the chips
  // in ONE row that scrolls horizontally when long.
  const extra = [
    ...(plan.notes ?? []),
    ...(sim && !clean ? sim.visibleCuts.map((c) => c.detail) : []),
  ].join(' · ')
  return (
    <div className={cn('flex flex-col gap-1 min-w-0', className)}>
      <div className="flex items-center gap-2 h-5 min-w-0">
        <span className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0',
          clean ? 'bg-live/15 text-live' : dip ? 'bg-busy/15 text-busy' : 'bg-pgm/15 text-pgm'
        )} title={dip ? 'No cuts, but the output fades through black to make the change — consider recording an intermediate look' : undefined}>
          {clean ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
          {clean ? 'clean' : dip ? 'dips through black' : `${sim?.counts.visibleCuts} visible cut${sim?.counts.visibleCuts === 1 ? '' : 's'}`}
        </span>
        {sim && (
          <span className="text-[10.5px] text-muted-foreground tabular shrink-0">
            {sim.counts.fades} fade{sim.counts.fades === 1 ? '' : 's'} · {sim.counts.animations} move{sim.counts.animations === 1 ? '' : 's'} · ~{(sim.approxDurationMs / 1000).toFixed(1)}s
          </span>
        )}
        {extra && (
          <span className={cn('text-[10.5px] truncate min-w-0', clean || dip ? 'text-busy/90' : 'text-pgm')} title={extra}>
            · {extra}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 h-6 overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:thin] min-w-0">
        {items.length === 0 && <span className="text-[11px] text-muted-foreground">nothing to do</span>}
        {items.map((it, i) => (
          <span key={i} className="inline-flex items-center gap-1 shrink-0">
            <span className={cn('inline-flex items-center gap-1 rounded-md bg-muted/50 border border-border/60 px-1.5 py-0.5 text-[10.5px] whitespace-nowrap', it.tone)}>
              <it.icon className="size-3" /> {it.text}
            </span>
            {i < items.length - 1 && <ArrowRight className="size-3 text-muted-foreground/40" />}
          </span>
        ))}
      </div>
    </div>
  )
}
