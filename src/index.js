import path from 'node:path'
import { config, projectRoot } from './config.js'
import { AtemController } from './atem.js'
import { Animator } from './animator.js'
import { LookStore } from './looks.js'
import { HyperDeck } from './hyperdeck.js'
import { Sequencer } from './sequencer.js'
import { TransitionEngine } from './engine.js'
import { OscServer } from './osc.js'
import { WebServer } from './web.js'
import { ProPresenter } from './propresenter.js'
import { Verifier } from './verify.js'
import { SennheiserMonitor } from './sennheiser.js'

console.log('atem-controller starting')
console.log(`  ATEM      ${config.atem.ip} (main M/E ${config.supersource.me + 1}, SuperSource ${config.supersource.id + 1})`)
console.log(`  HyperDeck ${config.hyperdeck.ip}:${config.hyperdeck.port}`)

const atem = new AtemController()
const animator = new Animator(atem)
const hyperdeck = new HyperDeck()
const looks = new LookStore(atem, hyperdeck)
const engine = new TransitionEngine(atem, hyperdeck)
const sequencer = new Sequencer(atem, animator, looks, hyperdeck, engine)
const oscServer = new OscServer({ atem, animator, looks, sequencer, hyperdeck })
const propresenter = new ProPresenter()
const verifier = new Verifier(atem, sequencer, engine, looks)
const sennheiser = new SennheiserMonitor()
// Connector engine (the new unified backend): SQLite store + the vendored
// connector library. Runs alongside the ATEM stack during the migration.
let store = null, connectorEngine = null
try {
  const { Store } = await import('../server/db/store.ts')
  const { migrateJson } = await import('../server/db/migrate.ts')
  const { Engine } = await import('../server/runtime/engine.ts')
  store = new Store(process.env.SIL_DB || path.join(projectRoot, 'data', 'stageit.db'))
  const { summary } = migrateJson(store, projectRoot)
  if (Object.values(summary).some((n) => n > 0)) console.log('[store] migrated JSON ->', JSON.stringify(summary))
  connectorEngine = new Engine(store)
} catch (e) {
  console.error('[engine] failed to initialise connector engine:', e.message)
}

const web = new WebServer({ atem, animator, looks, sequencer, hyperdeck, oscServer, engine, propresenter, verifier, sennheiser, connectorEngine, store })
oscServer.attachVerifier(verifier)

oscServer.open()
web.start()
connectorEngine?.start().catch((e) => console.error('[engine] start failed:', e.message))

// Bridge the legacy Sennheiser fleet monitor onto the connector hub, so its
// per-receiver data is available to Surface widgets on mi:<instance>:channels
// (until the full connector port). Instance ids match the migration:
// sennheiser-<last-octet>.
if (connectorEngine) {
  const publishSenn = () => {
    const snap = sennheiser.snapshot()
    // Zip the fleet monitor's devices to the store's sennheiser instances in
    // order (both follow config/device order), so ids line up whether we're on
    // real IPs or the simulator's localhost fleet.
    const sennInstances = (store?.listInstances() ?? []).filter((i) => i.typeId === 'sennheiser').sort((a, b) => a.sortOrder - b.sortOrder)
    ;(snap.devices ?? []).forEach((dev, idx) => {
      const inst = sennInstances[idx]
      if (!inst) return
      connectorEngine.hub.publish(`mi:${inst.id}:channels`, { channels: dev.channels ?? [], deviceName: dev.deviceName, product: dev.product, online: dev.online })
      connectorEngine.hub.publish(`mi:${inst.id}:$status`, { instanceId: inst.id, state: dev.online ? 'online' : (dev.reachable ? 'degraded' : 'offline'), detail: null, since: Date.now(), attempt: 0, lastError: null, pollIntervalMs: null })
    })
  }
  sennheiser.on('update', publishSenn)
  sennheiser.on('presence', publishSenn)
}
propresenter.start()
sennheiser.start().catch((e) => console.error('[senn] start failed:', e.message))
hyperdeck.connect()
atem.connect().catch((e) => console.error('[atem] connect failed:', e.message))

process.on('SIGINT', () => {
  console.log('\nshutting down')
  process.exit(0)
})
