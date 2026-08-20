/** Smoke harness: boot a few vendored connectors against their simulators. */
import pino from 'pino'
import { Supervisor } from './connectors/core/supervisor.js'
import { demoModule } from './connectors/demo/index.js'
import { weatherModule } from './connectors/weather/index.js'
import { hyperdeckModule } from './connectors/hyperdeck/index.js'
import { sennheiserModule } from './connectors/sennheiser/index.js'
import { smaartModule } from './connectors/smaart/index.js'
import type { ConnectorSink, ConnectorModule, InstanceStatus } from './connectors/core/types.js'

const logger = pino({ level: 'silent' })
const seen = new Map<string, unknown>()
const states = new Map<string, string>()
const sink: ConnectorSink = {
  publish(instanceId, streamId, payload) { seen.set(`${instanceId}:${streamId}`, payload) },
  status(s: InstanceStatus) { states.set(s.instanceId, s.state) },
  publishSystem() {},
  recordHistory() {},
}

const specs: [string, ConnectorModule<unknown>][] = [
  ['demo', demoModule], ['weather', weatherModule], ['hyperdeck', hyperdeckModule],
  ['sennheiser', sennheiserModule], ['smaart', smaartModule],
]
const sups = specs.map(([id, module]) => new Supervisor({
  definition: { id, typeId: id, name: id, config: {}, enabled: true, allowControl: false, simulate: true },
  module, sink, logger,
}))
await Promise.all(sups.map((s) => s.start()))
setTimeout(async () => {
  console.log('\n=== connector states ===')
  for (const [id] of specs) console.log(`  ${id.padEnd(12)} ${states.get(id) ?? '(none)'}`)
  console.log('\n=== live data published to the sink ===')
  for (const [k, v] of seen) console.log(`  ${k.padEnd(24)} ${JSON.stringify(v).slice(0, 90)}`)
  await Promise.all(sups.map((s) => s.stop()))
  process.exit(0)
}, 4500)
