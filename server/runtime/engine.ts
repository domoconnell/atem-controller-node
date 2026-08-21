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
/** Types that never appear as user connections: the demo device, and
 *  Companion (it's the core control bridge, configured under Global, not a
 *  monitored device). */
const EXCLUDED = new Set(['demo', 'companion'])

/** Config schemas for the connectors still on the legacy stack, so Settings
 *  renders a proper form for them (not a raw JSON box) ahead of the full port. */
const LEGACY_SCHEMAS: Record<string, unknown> = {
  atem: { type: 'object', properties: {
    ip: { type: 'string', default: '10.10.10.51', description: 'ATEM switcher IP address' },
    simFallbackMs: { type: 'integer', default: 4000, description: 'Wait this long for the real switcher before the simulator takes over' },
  } },
  hyperdeck: { type: 'object', properties: {
    ip: { type: 'string', default: '10.10.10.55', description: 'HyperDeck IP address' },
    port: { type: 'integer', default: 9993, description: 'Ethernet protocol port' },
  } },
  propresenter: { type: 'object', properties: {
    ip: { type: 'string', default: '127.0.0.1', description: 'The Mac running ProPresenter (Preferences -> Network)' },
    port: { type: 'integer', default: 49773, description: 'ProPresenter API port' },
    pollMs: { type: 'integer', default: 500, description: 'Poll interval' },
  } },
  sennheiser: { type: 'object', properties: {
    ip: { type: 'string', description: 'Receiver IP address' },
    kind: { type: 'string', enum: ['ewdx', 'g3', 'g3legacy', 'iemg4'], default: 'ewdx', description: 'EW-DX (SSC), ew G3 (UDP 53212), G3 legacy (fw <1.7, UDP 8133), or IEM G4' },
    port: { type: 'integer', description: 'Override the default port for the protocol' },
    label: { type: 'string', description: 'Display name for this receiver' },
  } },
}
const LEGACY_META: Record<string, { displayName: string; description: string }> = {
  atem: { displayName: 'ATEM', description: 'Blackmagic ATEM switcher — SuperSource looks and the transition engine.' },
}

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
      this.publishInstanceList()
    },
    publishSystem: (topic, payload) => this.hub.publish(topic, payload),
    recordHistory: (instanceId, points: readonly HistoryPoint[]) =>
      this.store.recordMetrics(points.map((p) => ({ instanceId, metric: p.metric, ts: p.ts, value: p.value }))),
  }

  /** Feed a status from a legacy/bridged stack (ATEM, ProPresenter, HyperDeck,
   *  Sennheiser) into the same aggregate + per-instance topic the engine-run
   *  connectors use, so overview widgets count them correctly. */
  setExternalStatus(instanceId: string, state: InstanceStatus['state']): void {
    this.statuses.set(instanceId, { instanceId, state, detail: null, since: Date.now(), attempt: 0, lastError: null, pollIntervalMs: null })
    this.hub.publish(statusTopic(instanceId), this.statuses.get(instanceId))
    this.hub.publish(SYS_STATUS, this.statusAggregate())
    this.publishInstanceList()
  }

  /** Push the instance list (with fresh live status) so views subscribe over the
   *  hub instead of polling /api/instances. Fires on status transitions, which
   *  are infrequent (connect/disconnect/degrade), not on every data tick. */
  private publishInstanceList(): void {
    this.hub.publish('sys:instances', { instances: this.listInstances() })
  }

  private statusAggregate(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, s] of this.statuses) out[id] = s.state
    return out
  }

  /**
   * Wire the self-managing legacy stacks (ATEM / HyperDeck / ProPresenter /
   * Sennheiser) into the same hub + status aggregate the supervisor-run
   * connectors use. They keep owning their own reconnection (so the supervisor
   * lifecycle never fights them and offline stays offline, not amber); the
   * engine is simply the single place every connector is wired now, instead of
   * an ad-hoc bridge in index.js. The instance ids match the migration.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachLegacy(legacy: { atem?: any; hyperdeck?: any; propresenter?: any; sennheiser?: any }): void {
    const { atem, hyperdeck, propresenter, sennheiser } = legacy
    const st = (id: string, ok: boolean, degraded = false) => this.setExternalStatus(id, ok ? 'online' : degraded ? 'degraded' : 'offline')

    if (sennheiser) {
      const publish = () => {
        const snap = sennheiser.snapshot()
        const insts = this.store.listInstances().filter((i) => i.typeId === 'sennheiser').sort((a, b) => a.sortOrder - b.sortOrder)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(snap.devices ?? []).forEach((dev: any, idx: number) => {
          const inst = insts[idx]; if (!inst) return
          this.hub.publish(buildTopic(inst.id, 'channels'), { channels: dev.channels ?? [], deviceName: dev.deviceName, product: dev.product, online: dev.online })
          st(inst.id, dev.online, dev.reachable)
        })
      }
      sennheiser.on('update', publish); sennheiser.on('presence', publish)
    }
    if (atem) {
      const publish = () => {
        const snap = atem.snapshot()
        const me = snap.mixEffects?.[atem.me] ?? snap.mixEffects?.[0] ?? null
        this.hub.publish(buildTopic('atem-1', 'program'), { program: me?.programInput ?? null, preview: me?.previewInput ?? null, connected: snap.connected || snap.simulated, simulated: snap.simulated })
        st('atem-1', snap.connected || snap.simulated)
      }
      atem.on('stateChanged', publish); atem.on('connected', publish); atem.on('disconnected', publish); publish()
    }
    if (propresenter) {
      const publish = () => {
        const snap = propresenter.snapshot()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.hub.publish(buildTopic('propresenter-1', 'timers'), { timers: (snap.timers ?? []).map((t: any) => ({ name: t.name, seconds: Math.round(t.remaining ?? 0), remaining: t.remaining ?? 0, duration: t.duration ?? null, state: t.state })) })
        st('propresenter-1', snap.connected)
      }
      propresenter.on('update', publish); publish()
    }
    if (hyperdeck) {
      const publish = () => {
        const snap = hyperdeck.snapshot()
        this.hub.publish(buildTopic('hyperdeck-1', 'transport'), { ...(snap.transport ?? {}) })
        st('hyperdeck-1', snap.connected)
      }
      hyperdeck.on('transport', publish); hyperdeck.on('connected', publish); hyperdeck.on('disconnected', publish); publish()
    }
  }

  async start(): Promise<void> {
    // Remove any connections of excluded types left in the store (e.g. a
    // previously-seeded demo device).
    for (const row of this.store.listInstances()) if (EXCLUDED.has(row.typeId)) this.store.deleteInstance(row.id)
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
  catalogue() {
    const base = this.registry.catalogue(this.registry.all())
      .filter((t) => !EXCLUDED.has(t.typeId))
      .map((t) => LEGACY_SCHEMAS[t.typeId] ? { ...t, configJsonSchema: LEGACY_SCHEMAS[t.typeId] } : t)
    // ATEM has no connector module yet; surface it in the catalogue so Settings
    // renders its form (it still runs on the legacy stack for now).
    if (!base.some((t) => t.typeId === 'atem')) {
      base.unshift({ typeId: 'atem', displayName: LEGACY_META.atem.displayName, description: LEGACY_META.atem.description,
        configJsonSchema: LEGACY_SCHEMAS.atem, streams: [], commands: [], capabilities: { control: true, discovery: false }, tier: 'official', vendorNotes: null } as never)
    }
    return base
  }

  /** First-boot dev convenience: one simulator-backed instance per connector
   *  type we don't already have, so Settings/Surfaces have something to show. */
  private seedSimConnectors(): void {
    const seeded = this.store.db.prepare("SELECT value FROM _meta WHERE key='sim_seeded'").get()
    if (seeded) return
    const have = new Set(this.store.listInstances().map((i) => i.typeId))
    for (const module of this.registry.all()) {
      const typeId = module.meta.typeId
      if (have.has(typeId) || LEGACY.has(typeId) || EXCLUDED.has(typeId)) continue
      this.store.createInstance({ typeId, name: `${module.meta.displayName} (sim)`, simulate: true })
    }
    this.store.db.prepare("INSERT OR REPLACE INTO _meta(key,value) VALUES ('sim_seeded', ?)").run(String(Date.now()))
  }

  async stop(): Promise<void> { await Promise.all([...this.supervisors.values()].map((s) => s.stop().catch(() => {}))) }
}
