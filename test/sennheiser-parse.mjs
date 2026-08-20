// Feed REAL captured device output (scratch/captures/) through the parsers.
import { readFileSync } from 'node:fs'
import { mergeSsc, parseG34Line } from '../src/sennheiser.js'

let fails = 0
const check = (name, cond, detail) => {
  console.log(cond ? `✅ ${name}` : `❌ ${name} — ${detail}`)
  if (!cond) fails++
}
const cap = (f) => readFileSync(new URL(`../scratch/captures/${f}`, import.meta.url), 'utf8')

// EW-DX statics + meters + battery-off
const dx = { channels: [] }
for (const f of ['ewdx-identity.json', 'ewdx-channels.json', 'ewdx-battery-txoff.json']) {
  for (const line of cap(f).split(/\r?\n/).filter(Boolean)) mergeSsc(dx, JSON.parse(line))
}
for (const line of cap('ewdx-meters.jsonl').split(/\r?\n/).filter(Boolean)) mergeSsc(dx, JSON.parse(line))
const rx1 = dx.channels.find((c) => c.id === 'rx1'), rx2 = dx.channels.find((c) => c.id === 'rx2')
check('ewdx identity', dx.product === 'EWDX2CH' && dx.deviceName === 'EWDXEM2', JSON.stringify(dx))
check('ewdx rx1 statics', rx1?.name === 'MC1' && rx1.frequency === 650425 && rx1.mute === false && rx1.gain === 15, JSON.stringify(rx1))
check('ewdx rx2 statics', rx2?.name === 'MC2' && rx2.frequency === 658275 && rx2.gain === 21, JSON.stringify(rx2))
check('ewdx meters merged', rx1.rssi <= -104 && rx1.rsqi === 0 && typeof rx1.af === 'number' && rx1.rf >= 0 && rx1.rf <= 1, JSON.stringify(rx1))
check('ewdx battery unknown when tx off', rx1.battery === null && rx2.battery === null, JSON.stringify([rx1.battery, rx2.battery]))

// G3 receiver
const g3 = {}
for (const line of cap('g3-mixed.txt').split('\r').filter((l) => l.trim())) parseG34Line(line, g3)
check('g3 statics', g3.name === 'VOX 4' && g3.frequency === 639100 && g3.squelch === 17 && g3.afOut === 15 && g3.mute === false, JSON.stringify(g3))
check('g3 live', g3.rf1 === 0 && g3.rf2 === 0 && Array.isArray(g3.afRaw) && g3.battery === null && g3.msg === 'RF_Mute', JSON.stringify(g3))
check('g3 active antenna', g3.ant === 2, `ant=${g3.ant}`) // capture ends RF1 ..0 / RF2 ..1

for (const line of cap('g3-firmware.txt').split('\n').filter((l) => l.trim())) parseG34Line(line, g3)
check('g3 firmware', g3.firmware === '1.8.0', JSON.stringify(g3.firmware))

// IEM
const iem = {}
for (const line of cap('iem-mixed.txt').split('\r').filter((l) => l.trim())) parseG34Line(line, iem)
check('iem statics', iem.name === 'VOX 1' && iem.frequency === 614325 && iem.sensitivity === -24 && iem.stereo === true && iem.mute === false, JSON.stringify(iem))
check('iem live af', iem.af === 0 && iem.afRaw.length === 4 && iem.msg === 'OK', JSON.stringify(iem))

for (const line of cap('iem-firmware.txt').split('\n').filter((l) => l.trim())) parseG34Line(line, iem)
check('iem firmware', iem.firmware === '1.2.0', JSON.stringify(iem.firmware))

process.exit(fails ? 1 : 0)
