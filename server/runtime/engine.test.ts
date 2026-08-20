import { Store } from '../db/store.js'
import { Engine } from './engine.js'
import { buildTopic, statusTopic } from '@stageit/shared'

let fails = 0
const check = (name: string, cond: boolean, detail = '') => { console.log(cond ? `✅ ${name}` : `❌ ${name} — ${detail}`); if (!cond) fails++ }

const store = new Store(':memory:')
const engine = new Engine(store)
await engine.start()
await new Promise((r) => setTimeout(r, 4000))

const insts = engine.listInstances()
const run = insts.filter((i) => i.engineRun)
check('seeded sim connectors for non-legacy types', run.length >= 8, `got ${run.length}`)
const online = run.filter((i) => i.status?.state === 'online')
check('most seeded connectors come online against sims', online.length >= Math.floor(run.length * 0.7), `${online.length}/${run.length} online`)

// a known connector published a topic snapshot into the hub
const weather = insts.find((i) => i.typeId === 'weather')
check('weather instance exists', !!weather)
if (weather) {
  const snap = engine.hub.snapshot(buildTopic(weather.id, 'current'))
  check('weather published its "current" stream', !!snap && !!(snap.data as any)?.temperatureC, JSON.stringify(snap?.data)?.slice(0, 80))
  const st = engine.hub.snapshot(statusTopic(weather.id))
  check('status topic carries the instance state', (st?.data as any)?.state === 'online', JSON.stringify(st?.data))
}

// subscribe path delivers a snapshot immediately
const got: any[] = []
const sub = { topics: new Set<string>(), send: (m: unknown) => got.push(JSON.parse(m as string)) }
const smaart = insts.find((i) => i.typeId === 'smaart')!
engine.hub.subscribe(sub, [buildTopic(smaart.id, 'spl')])
check('subscribe delivers an immediate snapshot frame', got.some((f) => f.t === 'snap' && f.topic.includes(smaart.id)), JSON.stringify(got[0])?.slice(0, 80))

// idempotent seeding: a second engine on the same store does not re-seed
const engine2 = new Engine(store)
const before = store.listInstances().length
await engine2.start(); await engine2.stop()
check('seeding is idempotent', store.listInstances().length === before, `before ${before}, after ${store.listInstances().length}`)

await engine.stop()
process.exit(fails ? 1 : 0)
