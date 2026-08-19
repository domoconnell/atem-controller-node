import { EventEmitter } from 'node:events'
import { Simulator } from './simulator.js'

/**
 * Hardware-truth verifier.
 *
 * Before a plan runs, the Simulator predicts the end state. After the
 * sequencer finishes, the REAL switcher state is read back and diffed
 * against the prediction. Any divergence is exactly where reality differs
 * from the model - the thing the office session must surface.
 *
 * Emits 'verified' with { name, from, to, ok, diffs, predicted, actual }.
 * Keeps the last N results for the UI.
 */
export class Verifier extends EventEmitter {
  constructor(atem, sequencer, engine, looks) {
    super()
    this.atem = atem
    this.engine = engine
    this.looks = looks
    this.results = []      // newest first
    this.pending = null    // { name, from, to, predicted }
    this.lastGrade = null  // { look, grade, cuts } for Companion "next will be clean"

    // The sequencer emits 'busy' AFTER planning; we need the plan. Hook goto
    // instead: wrap it so we can capture steps + predict before execution.
    const origRunSteps = sequencer._runSteps.bind(sequencer)
    sequencer._runSteps = async (name, steps, meta = {}) => {
      this.pending = null
      try {
        const sim = new Simulator(this._liveForSim())
        const rep = sim.run(steps)
        this.pending = { name, from: meta.from ?? null, to: meta.to ?? null, predicted: rep.final, grade: rep.grade, at: Date.now() }
      } catch (e) {
        console.error('[verify] predict failed:', e.message)
      }
      try {
        return await origRunSteps(name, steps, meta)
      } finally {
        // Let the last state change land (real switcher acks lag a little).
        setTimeout(() => this._settle(), 350)
      }
    }
  }

  _liveForSim() {
    const me = this.atem.getMixEffect()
    return {
      programInput: me?.programInput,
      previewInput: me?.previewInput,
      boxes: this.atem.getBoxes().map((b) => (b ? { ...b } : null)),
      usk: this.atem.getUskSettings(),
      art: this.atem.getSsProperties(),
      mediaPlayers: this.atem.getMediaPlayers(),
      ssInput: this.engine.ssInput,
      dipInput: this.engine._dipSource(),
    }
  }

  _settle() {
    const p = this.pending
    if (!p) return
    this.pending = null
    const actual = this._liveForSim()
    const diffs = diffState(p.predicted, actual, this.engine.ssInput)
    const result = {
      name: p.name, from: p.from, to: p.to,
      ok: diffs.length === 0,
      simGrade: p.grade,
      diffs,
      simulated: !!this.atem.simulated,
      at: new Date().toISOString(),
      durationMs: Date.now() - p.at,
    }
    this.results.unshift(result)
    if (this.results.length > 50) this.results.length = 50
    if (result.ok) console.log(`[verify] ✓ ${p.name}: hardware matches prediction`)
    else console.warn(`[verify] ✗ ${p.name}: ${diffs.length} divergence(s): ${diffs.map((d) => d.what).join('; ')}`)
    this.emit('verified', result)
  }

  snapshot() {
    return { results: this.results.slice(0, 20), lastGrade: this.lastGrade }
  }
}

/** Field-by-field diff of the things the engine controls. */
export function diffState(pred, act, ssInput) {
  const out = []
  const push = (what, expected, actual) => out.push({ what, expected, actual })
  if (pred.program !== act.programInput) push('program', pred.program, act.programInput)
  for (let i = 0; i < 4; i++) {
    const a = pred.boxes?.[i], b = act.boxes?.[i]
    if (!a && !b) continue
    if (!!a?.enabled !== !!b?.enabled) { push(`box${i + 1} enabled`, !!a?.enabled, !!b?.enabled); continue }
    if (!a?.enabled) continue
    if (a.source !== b.source) push(`box${i + 1} source`, a.source, b.source)
    for (const k of ['x', 'y', 'size']) {
      if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 15) push(`box${i + 1} ${k}`, a[k], b[k])
    }
    if (!!a.cropped !== !!b.cropped) push(`box${i + 1} cropped`, !!a.cropped, !!b.cropped)
    else if (a.cropped) for (const k of ['cropTop', 'cropBottom', 'cropLeft', 'cropRight']) {
      if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 60) push(`box${i + 1} ${k}`, a[k], b[k])
    }
  }
  ;(pred.usk ?? []).forEach((k, i) => {
    const m = act.usk?.[i]
    if (!k || !m) return
    if (!!k.onAir !== !!m.onAir) push(`USK${i + 1} onAir`, !!k.onAir, !!m.onAir)
    if (k.fillSource != null && k.fillSource !== m.fillSource) push(`USK${i + 1} fill`, k.fillSource, m.fillSource)
    if (k.keyType && m.keyType && k.keyType !== m.keyType) push(`USK${i + 1} type`, k.keyType, m.keyType)
    if (k.pattern && m.pattern && k.pattern.style !== m.pattern.style) push(`USK${i + 1} pattern`, k.pattern.style, m.pattern.style)
  })
  ;(pred.mediaPlayers ?? []).forEach((mp, i) => {
    const a = act.mediaPlayers?.[i]
    if (!mp || !a) return
    const pi = mp.sourceType === 'clip' ? mp.clipIndex : mp.stillIndex
    const ai = a.sourceType === 'clip' ? a.clipIndex : a.stillIndex
    if (pi !== ai) push(`MP${i + 1}`, pi, ai)
  })
  if (pred.art && act.art && pred.art.artFillSource !== act.art.artFillSource) push('SS art fill', pred.art.artFillSource, act.art.artFillSource)
  return out
}
