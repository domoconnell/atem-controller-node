import { Store } from './store.js'
import { migrateJson } from './migrate.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let fails = 0
const check = (name: string, cond: boolean, detail = '') => { console.log(cond ? `✅ ${name}` : `❌ ${name} — ${detail}`); if (!cond) fails++ }

const store = new Store(':memory:')
const { migrated, summary } = migrateJson(store, projectRoot)
console.log('migration summary:', JSON.stringify(summary))
check('ran once', migrated)
check('idempotent (second run skips)', migrateJson(store, projectRoot).migrated === false)

const settings = store.allSettings()
check('global settings imported (web/osc/companion)', 'web' in settings && 'osc' in settings && 'companion' in settings, JSON.stringify(Object.keys(settings)))

const insts = store.listInstances()
const atem = insts.filter((i) => i.typeId === 'atem')
const senn = insts.filter((i) => i.typeId === 'sennheiser')
check('one ATEM instance, connection-only config', atem.length === 1 && !!(atem[0].config as any).ip && (atem[0].config as any).ssInput === undefined, JSON.stringify(atem[0]?.config))
check('a HyperDeck + ProPresenter instance', insts.some((i) => i.typeId === 'hyperdeck') && insts.some((i) => i.typeId === 'propresenter'))
check('sennheiser multi-instance (one per receiver)', senn.length >= 10, `got ${senn.length}`)
check('sennheiser instance carries ip + kind', senn.length > 0 && !!(senn[0].config as any).ip && !!(senn[0].config as any).kind, JSON.stringify(senn[0]?.config))

const looks = store.listLooks()
check('looks imported (9)', looks.length === 9, `got ${looks.length}`)
check('a look round-trips its data', looks.length > 0 && typeof looks[0].name === 'string')

// metrics smoke
store.recordMetrics([{ instanceId: 'x', metric: 'spl.a', ts: 1000, value: 92 }, { instanceId: 'x', metric: 'spl.a', ts: 2000, value: 94 }])
check('metrics store + query', store.queryMetrics('x', 'spl.a', 0).length === 2)

process.exit(fails ? 1 : 0)
