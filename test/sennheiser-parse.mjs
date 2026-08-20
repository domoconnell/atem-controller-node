// Feed REAL captured device output (scratch/captures/) through the parsers.
import { readFileSync } from 'node:fs'
import { mergeSsc, parseG34Line, parseLegacyFrame, buildLegacySubscribe } from '../src/sennheiser.js'

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

// Legacy 8133 binary protocol - real frames captured from the .73 receiver
const tele = Buffer.from('29f8f7ca00001b667a8edb0100000003000000000000000000000001010100000101010101010100', 'hex')
const ctl  = Buffer.from('8823f1ca00001b667a8edb0100000000000000000000000000000000000a0a0aa20101010101010101', 'hex')
const pt = parseLegacyFrame(tele)
check('legacy telemetry frame MAC', pt?.mac === '00:1b:66:7a:8e:db' && pt.kind === 'telemetry', JSON.stringify(pt))
check('legacy control frame kind', parseLegacyFrame(ctl)?.kind === 'control', JSON.stringify(parseLegacyFrame(ctl)))
check('legacy subscribe builder', buildLegacySubscribe('10.10.10.162').toString('hex') === '4f1ff1ca0a0a0aa20a0a0aa2010001010101',
  buildLegacySubscribe('10.10.10.162').toString('hex'))

// Real 85-byte ASCII identity beacon captured from the .73 receiver
const ident = Buffer.from('002512064d6f64656c3d454d333030473320202049443d3030314236363741384544422020204950413d31302e31302e31302e3733000000000000000000000000000000', 'hex')
const pi = parseLegacyFrame(ident)
check('legacy identity beacon', pi?.kind === 'identity' && pi.model === 'EM300G3' && pi.mac === '00:1b:66:7a:8e:db' && pi.ip === '10.10.10.73', JSON.stringify(pi))

// Legacy telemetry decode (calibrated byte offsets, real mic-on frames)
const loud = parseLegacyFrame(Buffer.from('29f8f7ca00001b667a8edb010400000001e102250000da01fb010001010101000101010101010100', 'hex'))
const quiet = parseLegacyFrame(Buffer.from('29f8f7ca00001b667a8edb0104000000015e03770200000000000001010101000101010101010100', 'hex'))
check('legacy telemetry decodes RF+AF', loud?.kind === 'telemetry' && loud.rf > 0 && loud.af > quiet.af,
  JSON.stringify({loud:{rf:loud?.rf,af:loud?.af}, quiet:{af:quiet?.af}}))
check('legacy AF drops in silence', quiet.af < 0.2 && loud.af > 0.5, JSON.stringify({loudAf:loud.af, quietAf:quiet.af}))

process.exit(fails ? 1 : 0)
