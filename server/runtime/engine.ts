import pino from 'pino'
import { buildTopic, statusTopic, type InstanceStatus, SYS_STATUS } from '@stageit/shared'
import { ConnectorRegistry } from '../connectors/core/registry.js'
import { Supervisor } from '../connectors/core/supervisor.js'
import type { ConnectorSink, HistoryPoint, InstanceDefinition } from '../connectors/core/types.js'
import type { Store, InstanceRow } from '../db/store.js'
import { Hub } from './hub.js'

/** Connector types still owned by the legacy JS stack (ported later). The
 *  engine lists them but does not run a second connection to them. */
const LEGACY = new Set(['atem', 'hyperdeck', 'propresenter', 'sennheiser'])

/**
 * The connector runtime: reads instances from the store, runs each through a
 * Supervisor, and pumps their publishes/status into the Hub as topics.
 */
export class Engine {
  readonly registry = new ConnectorRegistry()
  readonly hub = new Hub()
  private readonly supervisors = new Map<string, Supervisor>()
  private readonly statuses = new Map<string, InstanceStatus>()
  private readonly logger = pino({ level: process.env.SIL_LOG_LEVEL ?? 'silent' })

  constructor(private readonly store: Store) {}

  private sink: ConnectorSink = {
    publish: (instanceId, streamId, payload) => this.hub.publish(buildTopic(instanceId, streamId), payload),
    status: (status: InstanceStatus) => {
      this.statuses.set(status.instanceId, status)
      this.hub.publish(statusTopic(status.instanceId), status)
      this.hub.publish(SYS_STATUS, this.statusAggregate())
    },
    publishSystem: (topic, payload) => this.hub.publish(topic, payload),
    recordHistory: (instanceId, points: readonly HistoryPoint[]) =>
      this.store.recordMetrics(points.map((p) => ({ instanceId, metric: p.metric, ts: p.ts, value: p.value }))),
  }

  private statusAggregate(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, s] of this.statuses) out[id] = s.state
    return out
  }

  async start(): Promise<void> {
    this.seedSimConnectors()
    for (const row of this.store.listInstances()) {
      if (row.enabled && !LEGACY.has(row.typeId)) this.startInstance(row)
    }
  }

  private startInstance(row: InstanceRow): void {
    const module = this.registry.get(row.typeId)
    if (!module) { this.logger.warn({ typeId: row.typeId }, 'no connector module'); return }
    const definition: InstanceDefinition = {
      id: row.id, typeId: row.typeId, name: row.name, config: row.config,
      enabled: row.enabled, allowControl: row.allowControl, simulate: row.simulate,
    }
    const sup = new Supervisor({ definition, module, sink: this.sink, logger: this.logger })
    this.supervisors.set(row.id, sup)
    sup.start().catch((err) => this.logger.error({ err, id: row.id }, 'supervisor start failed'))
  }

  async reconcile(id: string): Promise<void> {
    const existing = this.supervisors.get(id)
    if (existing) { await existing.stop().catch(() => {}); this.supervisors.delete(id); this.hub.retire(id) }
    const row = this.store.getInstance(id)
    if (row && row.enabled && !LEGACY.has(row.typeId)) this.startInstance(row)
  }

  async command(instanceId: string, command: string, input: unknown) {
    const sup = this.supervisors.get(instanceId)
    if (!sup) return { ok: false as const, error: { code: 'NOT_CONNECTED', message: 'instance not running' } }
    return sup.exec(command, input)
  }

  listInstances() {
    return this.store.listInstances().map((i) => ({
      ...i,
      engineRun: !LEGACY.has(i.typeId),
      status: this.statuses.get(i.id) ?? null,
    }))
  }
  catalogue() { return this.registry.catalogue() }

  /** First-boot dev convenience: one simulator-backed instance per connector
   *  type we don't already have, so Settings/Surfaces have something to show. */
  private seedSimConnectors(): void {
    const seeded = this.store.db.prepare("SELECT value FROM _meta WHERE key='sim_seeded'").get()
    if (seeded) return
    const have = new Set(this.store.listInstances().map((i) => i.typeId))
    for (const module of this.registry.all()) {
      const typeId = module.meta.typeId
      if (have.has(typeId) || LEGACY.has(typeId)) continue
      this.store.createInstance({ typeId, name: `${module.meta.displayName} (sim)`, simulate: true })
    }
    this.store.db.prepare("INSERT OR REPLACE INTO _meta(key,value) VALUES ('sim_seeded', ?)").run(String(Date.now()))
  }

  async stop(): Promise<void> { await Promise.all([...this.supervisors.values()].map((s) => s.stop().catch(() => {}))) }
}
