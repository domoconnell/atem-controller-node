'use client'
import { useEffect, useMemo, useState } from 'react'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { cmd, fetchPlan } from '@/lib/api'
import type { Plan } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Play, Check, AlertTriangle, SkipForward, RotateCcw, ShieldCheck, ShieldAlert, Loader2, ClipboardList } from 'lucide-react'

interface Result {
  from: string; to: string; verdict: 'clean' | 'issue' | 'skip'; note: string; at: string
  verify?: { ok: boolean; diffs: { what: string; expected: unknown; actual: unknown }[]; simGrade: string; simulated: boolean } | null
}

/**
 * Acceptance runner for the office test session: walk every look pair,
 * see the simulator's verdict, run it live, mark what you saw.
 */
export default function AcceptancePage() {
  const { state, connected, tick } = useAtemState()
  const [results, setResults] = useState<Record<string, Result>>({})
  const [sel, setSel] = useState<{ from: string; to: string } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [note, setNote] = useState('')
  const [onlyPending, setOnlyPending] = useState(true)
  const [running, setRunning] = useState(false)

  const looks = useMemo(() => state?.looks.map((l) => l.name) ?? [], [state])
  const pairs = useMemo(() => {
    const out: { from: string; to: string }[] = []
    for (const a of looks) for (const b of looks) if (a !== b) out.push({ from: a, to: b })
    return out
  }, [looks])
  const key = (p: { from: string; to: string }) => `${p.from}→${p.to}`
  const visible = pairs.filter((p) => !onlyPending || !results[key(p)])
  const done = pairs.filter((p) => results[key(p)]).length
  const issues = Object.values(results).filter((r) => r.verdict === 'issue').length

  const refresh = () => fetch('/api/acceptance').then((r) => r.json()).then((b) => setResults(b.results ?? {})).catch(() => {})
  useEffect(() => { refresh() }, [])

  // plan preview for the selected pair (only meaningful when live == from)
  const liveIsFrom = !!sel && state?.currentLook === sel.from
  useEffect(() => {
    if (!sel || !liveIsFrom) { setPlan(null); return }
    fetchPlan(sel.to).then(setPlan).catch(() => setPlan(null))
  }, [sel, liveIsFrom, state?.currentLook])

  const mark = async (verdict: 'clean' | 'issue' | 'skip' | 'clear') => {
    if (!sel) return
    await fetch('/api/acceptance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sel, verdict, note }) })
    setNote('')
    await refresh()
    // auto-advance to next pending pair
    const idx = visible.findIndex((p) => key(p) === key(sel))
    const next = visible[idx + 1] ?? visible.find((p) => key(p) !== key(sel))
    setSel(next ?? null)
  }

  const goToFrom = async () => { if (sel) { setRunning(true); await cmd('/goto', [sel.from]); setRunning(false) } }
  const runIt = async () => { if (sel) { setRunning(true); await cmd('/goto', [sel.to]); setRunning(false) } }
  const busy = !!(state?.busy || state?.animating) || running

  return (
    <TooltipProvider>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="acceptance" state={state} wsConnected={connected} tick={tick}>
          <div className="ml-auto flex items-center gap-3 text-[12px]">
            <ClipboardList className="size-4 text-muted-foreground" />
            <span className="font-semibold">Acceptance</span>
            <span className="text-muted-foreground tabular">{done}/{pairs.length} checked · <span className={cn(issues && 'text-pgm')}>{issues} issue{issues === 1 ? '' : 's'}</span></span>
            <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} className="accent-primary" /> pending only
            </label>
          </div>
        </AppHeader>

        <main className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_420px] gap-4 p-4">
          {/* pair list */}
          <div className="surface rounded-xl min-h-0 overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card border-b border-border text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <tr><th className="text-left p-2.5 font-semibold">From</th><th className="text-left p-2.5 font-semibold">To</th><th className="text-left p-2.5 font-semibold">Result</th><th className="text-left p-2.5 font-semibold" title="hardware state after the run vs simulator prediction">HW</th><th className="text-left p-2.5 font-semibold">Note</th></tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const r = results[key(p)]
                  const isSel = sel && key(sel) === key(p)
                  return (
                    <tr key={key(p)} onClick={() => setSel(p)}
                      className={cn('border-b border-border/40 cursor-pointer hover:bg-accent/40', isSel && 'bg-primary/10')}>
                      <td className="p-2.5 font-medium">{p.from}</td>
                      <td className="p-2.5 font-medium">{p.to}</td>
                      <td className="p-2.5">
                        {r?.verdict === 'clean' && <span className="text-live font-bold">✓ clean</span>}
                        {r?.verdict === 'issue' && <span className="text-pgm font-bold">▲ issue</span>}
                        {r?.verdict === 'skip' && <span className="text-muted-foreground">skipped</span>}
                        {!r && <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="p-2.5">
                        {r?.verify ? (r.verify.ok
                          ? <span className="text-live" title="hardware matched prediction">●</span>
                          : <span className="text-pgm font-bold" title={r.verify.diffs.map((d) => `${d.what}: ${d.expected}→${d.actual}`).join('\n')}>◆ {r.verify.diffs.length}</span>)
                          : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="p-2.5 text-muted-foreground truncate max-w-[280px]">{r?.note}</td>
                    </tr>
                  )
                })}
                {visible.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{pairs.length ? 'All pairs checked 🎉' : 'No looks recorded yet.'}</td></tr>}
              </tbody>
            </table>
          </div>

          {/* runner */}
          <aside className="surface rounded-xl p-4 min-h-0 overflow-y-auto space-y-4">
            {!sel ? (
              <div className="text-[12.5px] text-muted-foreground">
                Pick a pair. Workflow per pair: <b className="text-foreground">1. Set up</b> puts the switcher on the “from” look,
                <b className="text-foreground"> 2. Run</b> transitions to “to” — watch the output — then <b className="text-foreground">mark</b> what you saw.
              </div>
            ) : (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">Pair</div>
                  <div className="text-[15px] font-semibold">{sel.from} <span className="text-muted-foreground">→</span> {sel.to}</div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" disabled={busy || liveIsFrom} onClick={goToFrom} className="h-9">
                    <RotateCcw className="size-4" /> 1. Set up ({liveIsFrom ? 'ready' : 'go to from'})
                  </Button>
                  <Button disabled={busy || !liveIsFrom} onClick={runIt} className="h-9 font-bold">
                    {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} 2. Run
                  </Button>
                </div>
                {!liveIsFrom && <div className="text-[11px] text-busy">Live is “{state?.currentLook ?? 'untracked'}” — set up first so the run starts from the right place.</div>}

                {plan && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                    <div className="flex items-center gap-2 text-[11px]">
                      {plan.sim?.grade === 'clean'
                        ? <span className="inline-flex items-center gap-1 text-live font-bold"><ShieldCheck className="size-3.5" /> simulator: clean</span>
                        : plan.sim?.grade === 'dip'
                        ? <span className="inline-flex items-center gap-1 text-busy font-bold"><ShieldAlert className="size-3.5" /> simulator: dips through black</span>
                        : <span className="inline-flex items-center gap-1 text-pgm font-bold"><ShieldAlert className="size-3.5" /> simulator: {plan.sim?.counts.visibleCuts} visible cut(s)</span>}
                      <span className="text-muted-foreground">· {plan.steps.length} steps · ~{((plan.sim?.approxDurationMs ?? 0) / 1000).toFixed(1)}s</span>
                    </div>
                    {plan.notes.length > 0 && <div className="text-[10.5px] text-busy">{plan.notes.join(' · ')}</div>}
                    <div className="text-[10.5px] font-mono text-muted-foreground break-words">{plan.steps.map((s) => s.type).join(' › ')}</div>
                  </div>
                )}

                {(() => {
                  const v = state?.verify?.results.find((r) => r.to === sel.to && (r.from === sel.from || r.from == null))
                  if (!v) return null
                  return (
                    <div className={cn('rounded-lg border p-3 space-y-1', v.ok ? 'border-live/40 bg-live/5' : 'border-pgm/50 bg-pgm/10')}>
                      <div className={cn('text-[11px] font-bold uppercase tracking-wider', v.ok ? 'text-live' : 'text-pgm')}>
                        {v.ok ? '● Hardware matched the simulator' : `◆ Hardware DIVERGED from simulator (${v.diffs.length})`}
                        {v.simulated && <span className="ml-2 text-busy font-normal normal-case tracking-normal">(against the ATEM sim — run in the office for the real answer)</span>}
                      </div>
                      {!v.ok && (
                        <ul className="text-[11px] font-mono text-pgm/90 space-y-0.5">
                          {v.diffs.map((d, i) => <li key={i}>{d.what}: expected {String(d.expected)} → got {String(d.actual)}</li>)}
                        </ul>
                      )}
                      <div className="text-[10.5px] text-muted-foreground">read back {Math.round(v.durationMs / 100) / 10}s after start · this is what the office session is for</div>
                    </div>
                  )
                })()}

                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">What did you see?</div>
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional for clean, please for issues)" className="h-9 bg-muted/40 text-[12.5px]" />
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    <Button onClick={() => mark('clean')} className="h-10 bg-live text-black hover:bg-live/90 font-bold"><Check className="size-4" /> Clean</Button>
                    <Button onClick={() => mark('issue')} className="h-10 bg-pgm text-white hover:bg-pgm/90 font-bold"><AlertTriangle className="size-4" /> Issue</Button>
                    <Button variant="secondary" onClick={() => mark('skip')} className="h-10"><SkipForward className="size-4" /> Skip</Button>
                  </div>
                  {results[key(sel)] && (
                    <button onClick={() => mark('clear')} className="mt-2 text-[11px] text-muted-foreground hover:text-foreground">clear this result</button>
                  )}
                </div>
              </>
            )}
          </aside>
        </main>
      </div>
    </TooltipProvider>
  )
}
