import Database from 'better-sqlite3'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

export type Json = Record<string, unknown>
export interface InstanceRow {
  id: string; typeId: string; name: string; config: Json
  enabled: boolean; allowControl: boolean; simulate: boolean; sortOrder: number
  createdAt: number; updatedAt: number
}

const now = () => Date.now()
let counter = 0
/** Deterministic-ish id without Math.random (blocked in some runtimes). */
export function newId(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}_${now().toString(36)}${counter.toString(36)}`
}

/** The single store. Open once, pass around. */
export class Store {
  readonly db: Database.Database
  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.db.prepare('INSERT OR IGNORE INTO _meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION))
  }
  close() { this.db.close() }

  // ---- settings (global k/v) ----
  getSetting<T = unknown>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as { value_json: string } | undefined
    return row ? (JSON.parse(row.value_json) as T) : fallback
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json')
      .run(key, JSON.stringify(value))
  }
  allSettings(): Json {
    const out: Json = {}
    for (const r of this.db.prepare('SELECT key,value_json FROM settings').all() as { key: string; value_json: string }[]) {
      out[r.key] = JSON.parse(r.value_json)
    }
    return out
  }

  // ---- instances (device connections, multi-instance) ----
  listInstances(): InstanceRow[] {
    return (this.db.prepare('SELECT * FROM instances ORDER BY sort_order, created_at').all() as any[]).map(rowToInstance)
  }
  instancesOfType(typeId: string): InstanceRow[] {
    return (this.db.prepare('SELECT * FROM instances WHERE type_id=? ORDER BY sort_order, created_at').all(typeId) as any[]).map(rowToInstance)
  }
  createInstance(i: { id?: string; typeId: string; name: string; config?: Json; enabled?: boolean; allowControl?: boolean; simulate?: boolean; sortOrder?: number }): InstanceRow {
    const id = i.id ?? newId('inst')
    const t = now()
    this.db.prepare(`INSERT INTO instances(id,type_id,name,config_json,enabled,allow_control,simulate,sort_order,created_at,updated_at)
      VALUES (@id,@typeId,@name,@config,@enabled,@allowControl,@simulate,@sortOrder,@t,@t)`).run({
      id, typeId: i.typeId, name: i.name, config: JSON.stringify(i.config ?? {}),
      enabled: i.enabled === false ? 0 : 1, allowControl: i.allowControl ? 1 : 0,
      simulate: i.simulate ? 1 : 0, sortOrder: i.sortOrder ?? 0, t,
    })
    return this.getInstance(id)!
  }
  getInstance(id: string): InstanceRow | null {
    const r = this.db.prepare('SELECT * FROM instances WHERE id=?').get(id) as any
    return r ? rowToInstance(r) : null
  }
  updateInstance(id: string, patch: Partial<{ name: string; config: Json; enabled: boolean; allowControl: boolean; simulate: boolean; sortOrder: number }>): void {
    const cur = this.getInstance(id); if (!cur) return
    const next = { ...cur, ...patch }
    this.db.prepare(`UPDATE instances SET name=@name,config_json=@config,enabled=@enabled,allow_control=@allowControl,simulate=@simulate,sort_order=@sortOrder,updated_at=@t WHERE id=@id`).run({
      id, name: next.name, config: JSON.stringify(next.config), enabled: next.enabled ? 1 : 0,
      allowControl: next.allowControl ? 1 : 0, simulate: next.simulate ? 1 : 0, sortOrder: next.sortOrder, t: now(),
    })
  }
  deleteInstance(id: string): void { this.db.prepare('DELETE FROM instances WHERE id=?').run(id) }

  // ---- looks ----
  listLooks() { return (this.db.prepare('SELECT slug,name,data_json FROM looks ORDER BY name').all() as any[]).map((r) => ({ slug: r.slug, name: r.name, ...JSON.parse(r.data_json) })) }
  putLook(slug: string, name: string, data: Json) {
    const t = now()
    this.db.prepare(`INSERT INTO looks(slug,name,data_json,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,updated_at=excluded.updated_at`).run(slug, name, JSON.stringify(data), t, t)
  }
  deleteLook(slug: string) { this.db.prepare('DELETE FROM looks WHERE slug=?').run(slug) }

  // ---- surfaces ----
  listSurfaces() { return (this.db.prepare('SELECT id,name,data_json,is_default FROM surfaces ORDER BY name').all() as any[]).map((r) => ({ id: r.id, name: r.name, isDefault: !!r.is_default, ...JSON.parse(r.data_json) })) }
  putSurface(id: string, name: string, data: Json, isDefault = false) {
    const t = now()
    this.db.prepare(`INSERT INTO surfaces(id,name,data_json,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,is_default=excluded.is_default,updated_at=excluded.updated_at`).run(id, name, JSON.stringify(data), isDefault ? 1 : 0, t, t)
  }
  deleteSurface(id: string) { this.db.prepare('DELETE FROM surfaces WHERE id=?').run(id) }

  // ---- mics (composite objects: Sennheiser + DiGiCo + internal cue) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listMics() { return (this.db.prepare('SELECT id,label,data_json,sort_order FROM mics ORDER BY sort_order,label').all() as any[]).map((r) => ({ id: r.id, label: r.label, sortOrder: r.sort_order, ...JSON.parse(r.data_json) })) }
  putMic(id: string, label: string, data: Json, sortOrder = 0) {
    const t = now()
    this.db.prepare(`INSERT INTO mics(id,label,data_json,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,data_json=excluded.data_json,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
      .run(id, label, JSON.stringify(data), sortOrder, t, t)
  }
  deleteMic(id: string) { this.db.prepare('DELETE FROM mics WHERE id=?').run(id) }

  // ---- services (runsheet: ordered timed segments with people + mics) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listServices() { return (this.db.prepare('SELECT id,name,data_json,sort_order FROM services ORDER BY sort_order,name').all() as any[]).map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, ...JSON.parse(r.data_json) })) }
  putService(id: string, name: string, data: Json, sortOrder = 0) {
    const t = now()
    this.db.prepare(`INSERT INTO services(id,name,data_json,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
      .run(id, name, JSON.stringify(data), sortOrder, t, t)
  }
  deleteService(id: string) { this.db.prepare('DELETE FROM services WHERE id=?').run(id) }

  // ---- timer layouts / renderer presets / acceptance (generic keyed blobs) ----
  listTimerLayouts() { return (this.db.prepare('SELECT id,name,data_json FROM timer_layouts').all() as any[]).map((r) => ({ id: r.id, name: r.name, ...JSON.parse(r.data_json) })) }
  putTimerLayout(id: string, name: string, data: Json) { const t = now(); this.db.prepare(`INSERT INTO timer_layouts(id,name,data_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,updated_at=excluded.updated_at`).run(id, name, JSON.stringify(data), t) }
  deleteTimerLayout(id: string) { this.db.prepare('DELETE FROM timer_layouts WHERE id=?').run(id) }
  listPresets() { return (this.db.prepare('SELECT name,data_json FROM renderer_presets').all() as any[]).map((r) => ({ name: r.name, ...JSON.parse(r.data_json) })) }
  putPreset(name: string, data: Json) { this.db.prepare(`INSERT INTO renderer_presets(name,data_json,updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(name, JSON.stringify(data), now()) }
  deletePreset(name: string) { this.db.prepare('DELETE FROM renderer_presets WHERE name=?').run(name) }
  getAcceptance(): Json { const out: Json = {}; for (const r of this.db.prepare('SELECT pair_key,data_json FROM acceptance').all() as any[]) out[r.pair_key] = JSON.parse(r.data_json); return out }
  putAcceptance(pairKey: string, data: Json) { this.db.prepare(`INSERT INTO acceptance(pair_key,data_json,updated_at) VALUES (?,?,?) ON CONFLICT(pair_key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(pairKey, JSON.stringify(data), now()) }
  deleteAcceptance(pairKey: string) { this.db.prepare('DELETE FROM acceptance WHERE pair_key=?').run(pairKey) }

  // ---- metrics (time-series) ----
  recordMetric(instanceId: string, metric: string, ts: number, value: number) {
    this.db.prepare('INSERT OR REPLACE INTO metrics(instance_id,metric,ts,value) VALUES (?,?,?,?)').run(instanceId, metric, Math.floor(ts), value)
  }
  recordMetrics(points: { instanceId: string; metric: string; ts: number; value: number }[]) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO metrics(instance_id,metric,ts,value) VALUES (?,?,?,?)')
    const tx = this.db.transaction((ps: typeof points) => { for (const p of ps) stmt.run(p.instanceId, p.metric, Math.floor(p.ts), p.value) })
    tx(points)
  }
  queryMetrics(instanceId: string, metric: string, since: number, until = Date.now()) {
    return this.db.prepare('SELECT ts,value FROM metrics WHERE instance_id=? AND metric=? AND ts>=? AND ts<=? ORDER BY ts').all(instanceId, metric, since, until) as { ts: number; value: number }[]
  }
}

function rowToInstance(r: any): InstanceRow {
  return {
    id: r.id, typeId: r.type_id, name: r.name, config: JSON.parse(r.config_json),
    enabled: !!r.enabled, allowControl: !!r.allow_control, simulate: !!r.simulate,
    sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
