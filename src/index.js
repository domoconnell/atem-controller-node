import path from 'node:path'
import { config, projectRoot, applyConfigUpdate } from './config.js'
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
// Connector engine (the new unified backend): SQLite store + the vendored
// connector library. Created BEFORE the LookStore so looks (and other state)
// load from the DB, which is now the source of truth.
let store = null, connectorEngine = null
try {
  const { Store } = await import('../server/db/store.ts')
  const { migrateJson } = await import('../server/db/migrate.ts')
  const { Engine } = await import('../server/runtime/engine.ts')
  store = new Store(process.env.SIL_DB || path.join(projectRoot, 'data', 'stageit.db'))
  const { summary } = migrateJson(store, projectRoot)
  if (Object.values(summary).some((n) => n > 0)) console.log('[store] migrated JSON ->', JSON.stringify(summary))
  // Behavioural settings (SuperSource / animation / transition) are the source
  // of truth in the DB now. Seed them from config.json on first run / older DBs
  // that predate this, then overlay ONLY these sections onto the live config so
  // every module reading `config.*` sees the DB values - and edits apply live.
  // (Boot/port sections like web/osc stay config.json-driven; overlaying them
  // would clobber the port, and migrate always reads the real config.json.)
  const behavioural = {}
  for (const key of ['supersource', 'animation', 'transition']) {
    if (store.getSetting(key, undefined) === undefined && config[key] !== undefined) store.setSetting(key, config[key])
    const v = store.getSetting(key, config[key]); if (v !== undefined) behavioural[key] = v
  }
  applyConfigUpdate(behavioural)
  connectorEngine = new Engine(store)
} catch (e) {
  console.error('[engine] failed to initialise connector engine:', e.message)
}

const looks = new LookStore(atem, hyperdeck, store)
const engine = new TransitionEngine(atem, hyperdeck)
const sequencer = new Sequencer(atem, animator, looks, hyperdeck, engine)
const oscServer = new OscServer({ atem, animator, looks, sequencer, hyperdeck })
const propresenter = new ProPresenter()
const verifier = new Verifier(atem, sequencer, engine, looks)
const sennheiser = new SennheiserMonitor()

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
      connectorEngine.setExternalStatus(inst.id, dev.online ? 'online' : (dev.reachable ? 'degraded' : 'offline'))
    })
  }
  sennheiser.on('update', publishSenn)
  sennheiser.on('presence', publishSenn)

  // Bridge the other legacy stacks (ATEM / ProPresenter / HyperDeck) onto the
  // hub too, so their Surface widgets have live data during the migration. The
  // instance ids match the migration (atem-1 / propresenter-1 / hyperdeck-1).
  const status = (id, online, degraded = false) => connectorEngine.setExternalStatus(id, online ? 'online' : degraded ? 'degraded' : 'offline')

  // ATEM: program / preview of the main M/E (the SuperSource host bus).
  const publishAtem = () => {
    const snap = atem.snapshot()
    const me = snap.mixEffects?.[config.supersource.me] ?? snap.mixEffects?.[0] ?? null
    connectorEngine.hub.publish('mi:atem-1:program', {
      program: me?.programInput ?? null, preview: me?.previewInput ?? null,
      connected: snap.connected || snap.simulated, simulated: snap.simulated,
    })
    status('atem-1', snap.connected || snap.simulated)
  }
  atem.on('stateChanged', publishAtem)
  atem.on('connected', publishAtem)
  atem.on('disconnected', publishAtem)

  // ProPresenter: countdown timers (remaining seconds -> widget's `seconds`).
  const publishPro = () => {
    const snap = propresenter.snapshot()
    connectorEngine.hub.publish('mi:propresenter-1:timers', {
      timers: (snap.timers ?? []).map((t) => ({ name: t.name, seconds: Math.round(t.remaining ?? 0), state: t.state })),
    })
    status('propresenter-1', snap.connected)
  }
  propresenter.on('update', publishPro)

  // HyperDeck: transport (status / timecode / clip / slot).
  const publishHd = () => {
    const snap = hyperdeck.snapshot()
    connectorEngine.hub.publish('mi:hyperdeck-1:transport', { ...(snap.transport ?? {}) })
    status('hyperdeck-1', snap.connected)
  }
  hyperdeck.on('transport', publishHd)
  hyperdeck.on('connected', publishHd)
  hyperdeck.on('disconnected', publishHd)

  // Seed an initial status now (all currently disconnected) so a legacy stack
  // that never connects reports 'offline' rather than the UI assuming online.
  // Real connect/disconnect events update it thereafter.
  publishAtem(); publishPro(); publishHd()
}

// Seed the legacy stacks from their SQLite instances so Settings edits (IP,
// port, pollMs) persist across restarts - the store is the source of truth, not
// config.json (which is only the initial migration seed).
if (store) {
  const cfgOf = (t) => store.listInstances().find((i) => i.typeId === t)?.config
  const at = cfgOf('atem'); if (at) atem.cfg = { ...atem.cfg, ...at }
  const hd = cfgOf('hyperdeck'); if (hd) hyperdeck.cfg = { ...hyperdeck.cfg, ...hd }
  const pp = cfgOf('propresenter'); if (pp) propresenter.cfg = { ...propresenter.cfg, ...pp }
}
propresenter.start()
sennheiser.start().catch((e) => console.error('[senn] start failed:', e.message))
hyperdeck.connect()
atem.connect().catch((e) => console.error('[atem] connect failed:', e.message))

process.on('SIGINT', () => {
  console.log('\nshutting down')
  process.exit(0)
})
