import { readFileSync } from 'node:fs'
import { TransitionEngine } from '../src/engine.js'
import { Simulator } from '../src/simulator.js'
const load = (n) => JSON.parse(readFileSync(`${new URL('../looks/', import.meta.url).pathname}${n}.json`,'utf8'))
const fakeAtem = (l) => ({
  getMixEffect: () => ({ programInput: l.me.programInput }),
  getBoxes: () => JSON.parse(JSON.stringify(l.boxes)), getUskSettings: () => JSON.parse(JSON.stringify(l.me.usk)),
  getSsProperties: () => l.ssProperties, getMixRate: () => 25,
  getMediaPlayers: () => l.mediaPlayers ?? [], mediaPlayerInputs: (i) => ({ fill: 3010 + i * 10, key: 3011 + i * 10 }),
})
const toLive = (l) => ({ programInput: l.me.programInput, boxes: l.boxes, usk: l.me.usk, art: l.ssProperties, mediaPlayers: l.mediaPlayers ?? [] })
const MP = (a, b) => [{index:0,sourceType:'still',stillIndex:a,clipIndex:0,name:'mp1-'+a},{index:1,sourceType:'still',stillIndex:b,clipIndex:0,name:'mp2-'+b}]
function test(label, from, to) {
  const { steps, notes } = new TransitionEngine(fakeAtem(from), {}).plan(to)
  const rep = new Simulator(toLive(from)).run(steps)
  const icon = rep.grade === 'clean' ? '✅' : rep.grade === 'dip' ? '🟡' : '❌'
  console.log(`${icon} ${label}  [${rep.grade}: ${rep.counts.fades} fades, ${rep.counts.animations} anims, ${rep.counts.dips ?? 0} dips, ${rep.counts.visibleCuts} cuts, ~${(rep.approxDurationMs/1000).toFixed(1)}s]`)
  for (const c of rep.visibleCuts) console.log(`     CUT #${c.step} ${c.type}: ${c.detail}`)
  for (const n of notes) console.log(`     note: ${n}`)
}

// A: MP1 change behind live USK1 (SS art also keyed by MP1)
{ const a = load('propres-full'); a.mediaPlayers = MP(0,1); const b = JSON.parse(JSON.stringify(a)); b.name='x'; b.mediaPlayers = MP(4,1)
  test('MP1 change, USK1 live, SS art keyed by MP1, no carrier', a, b) }
// B: MP1 change + border key toggles, from a look with a valid carrier
{ const a = load('propres-zoom-top'); a.mediaPlayers = MP(0,1); a.me.uskOnAir[0]=true; a.me.usk[0].onAir=true
  const b = JSON.parse(JSON.stringify(a)); b.name='x'; b.mediaPlayers = MP(4,1)
  test('MP1 change behind live USK1, carrier available (zoom-top)', a, b) }
// C: source swap + MP change + leaving SS all at once
{ const a = load('propres-zoom-top'); a.mediaPlayers = MP(0,1); a.me.uskOnAir[0]=true; a.me.usk[0].onAir=true
  const b = load('worship-zoom-imag'); b.mediaPlayers = MP(4,1)
  test('COMBO: swap+MP+leave SS to blend look', a, b) }
// D: source swap with NO carrier (zoom-cen has top crop)
{ const a = load('propres-zoom-cen'); const b = JSON.parse(JSON.stringify(a)); b.name='x'; b.boxes[3].source = 9
  test('box4 swap, top-cropped carrier (should degrade honestly)', a, b) }
// E: swap where the imag boxes ALSO change source (cam1 -> cam3)
{ const a = load('propres-zoom-top'); const b = JSON.parse(JSON.stringify(a)); b.name='x'; b.boxes[1].source = 3; b.boxes[2].source = 3
  test('imag box source change cam1->cam3 (no carrier for imag boxes)', a, b) }
// F: entering SS where target has MP1 in art AND MP1 changes
{ const a = load('propres-zoom-imag'); a.mediaPlayers = MP(0,1); const b = load('propres-full'); b.mediaPlayers = MP(4,1)
  test('enter SS + MP change (SS offline anyway)', a, b) }
