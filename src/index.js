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

// Wire the self-managing legacy stacks into the engine (single owner of all
// connector data + status). The engine keeps letting them manage their own
// reconnection; this replaces the ad-hoc bridge that used to live here.
connectorEngine?.attachLegacy({ atem, hyperdeck, propresenter, sennheiser })

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
