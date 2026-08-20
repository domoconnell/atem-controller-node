import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { Store, Json } from './store.js'

/**
 * One-time import of the legacy flat-JSON stores into the SQLite store:
 *   config.json          -> settings (global) + instances (atem/hyperdeck/propresenter/sennheiser*)
 *   looks/*.json         -> looks
 *   data/timer-layouts   -> timer_layouts
 *   data/renderer-presets-> renderer_presets
 *   data/acceptance      -> acceptance
 * Idempotent: a `_meta.json_migrated` flag stops it re-running.
 */
export function migrateJson(store: Store, projectRoot: string): { migrated: boolean; summary: Record<string, number> } {
  const done = store.db.prepare("SELECT value FROM _meta WHERE key='json_migrated'").get() as { value: string } | undefined
  if (done) return { migrated: false, summary: {} }

  const summary: Record<string, number> = { settings: 0, instances: 0, looks: 0, timerLayouts: 0, presets: 0, acceptance: 0 }
  const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'))

  // --- config.json ---
  const configPath = path.join(projectRoot, 'config.json')
  if (existsSync(configPath)) {
    const c = readJson(configPath) as Json & Record<string, any>
    // Global (non-device) settings
    for (const key of ['web', 'osc', 'companion', 'wireLog', 'wireConsole']) {
      if (c[key] !== undefined) { store.setSetting(key, c[key]); summary.settings++ }
    }
    // ATEM connection (engine params fold into its config)
    if (c.atem) {
      store.createInstance({
        id: 'atem-1', typeId: 'atem', name: 'ATEM', simulate: !!c.atem.simulate, allowControl: true,
        config: {
          ip: c.atem.ip, simFallbackMs: c.atem.simFallbackMs,
          supersource: c.supersource, animation: c.animation, transition: c.transition,
        },
      }); summary.instances++
    }
    if (c.hyperdeck) { store.createInstance({ id: 'hyperdeck-1', typeId: 'hyperdeck', name: 'HyperDeck', config: { ip: c.hyperdeck.ip, port: c.hyperdeck.port }, allowControl: true }); summary.instances++ }
    if (c.propresenter) { store.createInstance({ id: 'propresenter-1', typeId: 'propresenter', name: 'ProPresenter', config: { ip: c.propresenter.ip, port: c.propresenter.port, pollMs: c.propresenter.pollMs } }); summary.instances++ }
    // Sennheiser: one instance per receiver (this is the multi-instance win)
    for (const [i, d] of (c.sennheiser?.devices ?? []).entries()) {
      store.createInstance({
        id: `sennheiser-${d.ip.split('.').pop()}`, typeId: 'sennheiser',
        name: d.label ?? `RX ${d.ip}`, sortOrder: i,
        config: { ip: d.ip, kind: d.type, port: d.port, label: d.label, name: d.name, frequency: d.frequency },
      }); summary.instances++
    }
  }

  // --- looks/ ---
  const looksDir = path.join(projectRoot, 'looks')
  if (existsSync(looksDir)) {
    for (const f of readdirSync(looksDir)) {
      if (!f.endsWith('.json')) continue
      const data = readJson(path.join(looksDir, f))
      const name = data.name ?? f.replace(/\.json$/, '')
      const slug = data.slug ?? f.replace(/\.json$/, '')
      store.putLook(slug, name, data); summary.looks++
    }
  }

  // --- data/ blobs ---
  const dataDir = path.join(projectRoot, 'data')
  const layoutsFile = path.join(dataDir, 'timer-layouts.json')
  if (existsSync(layoutsFile)) {
    for (const l of readJson(layoutsFile) as any[]) { store.putTimerLayout(l.id, l.name ?? l.id, l); summary.timerLayouts++ }
  }
  const presetsFile = path.join(dataDir, 'renderer-presets.json')
  if (existsSync(presetsFile)) {
    for (const p of readJson(presetsFile) as any[]) { store.putPreset(p.name, p); summary.presets++ }
  }
  const acceptFile = path.join(dataDir, 'acceptance.json')
  if (existsSync(acceptFile)) {
    for (const [k, v] of Object.entries(readJson(acceptFile) as Json)) { store.putAcceptance(k, v as Json); summary.acceptance++ }
  }

  store.db.prepare("INSERT OR REPLACE INTO _meta(key,value) VALUES ('json_migrated', ?)").run(String(Date.now()))
  return { migrated: true, summary }
}
