import { readFileSync, readdirSync } from 'node:fs'
import { TransitionEngine } from '../src/engine.js'
import { Simulator } from '../src/simulator.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../looks')
const looks = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(dir + '/' + f, 'utf8')))
const fakeAtem = (l) => ({
  getMixEffect: () => ({ programInput: l.me.programInput }),
  getBoxes: () => JSON.parse(JSON.stringify(l.boxes)), getUskSettings: () => JSON.parse(JSON.stringify(l.me.usk)),
  getSsProperties: () => l.ssProperties, getMixRate: () => 25,
  getMediaPlayers: () => l.mediaPlayers ?? [], mediaPlayerInputs: (i) => ({ fill: 3010 + i * 10, key: 3011 + i * 10 }),
})
const toLive = (l) => ({ programInput: l.me.programInput, boxes: l.boxes, usk: l.me.usk, art: l.ssProperties, mediaPlayers: l.mediaPlayers ?? [] })

let clean = 0, dirty = 0
const bad = []
for (const from of looks) for (const to of looks) {
  if (from.name === to.name) continue
  const { steps, notes } = new TransitionEngine(fakeAtem(from), {}).plan(to)
  const rep = new Simulator(toLive(from)).run(steps)
  // did we end in the target state?
  const endOk = rep.final.program === to.me.programInput
  if (rep.grade === 'clean' && endOk) clean++
  else { dirty++; bad.push({ from: from.name, to: to.name, cuts: rep.visibleCuts.map(c => `#${c.step} ${c.type}: ${c.detail}`), endOk, notes }) }
}
console.log(`pairs: ${clean + dirty}  clean: ${clean}  with-visible-cuts/wrong-end: ${dirty}`)
for (const b of bad) console.log(`\n${b.from} -> ${b.to}${b.endOk ? '' : '  [WRONG END STATE]'}\n   ${b.cuts.join('\n   ')}${b.notes.length ? '\n   notes: ' + b.notes.join('; ') : ''}`)
