import { type CommandResult, commandFail, type InstanceStatus, SYS_STATUS } from '@stageit/shared'
import type { Logger } from 'pino'
import type { BackoffOptions } from './backoff.js'
import type { ConnectorRegistry } from './registry.js'
import { Supervisor } from './supervisor.js'
import type { ConnectorSink, InstanceDefinition, SimulatorHandle } from './types.js'

export interface ConnectorManagerOptions {
  registry: ConnectorRegistry
  sink: ConnectorSink
  logger: Logger
  /** Reads the current definition; null means "no longer exists". */
  loadDefinition: (instanceId: string) => InstanceDefinition | null
  loadAllDefinitions: () => InstanceDefinition[]
  /** Called after any instance is added, reconfigured or removed. */
  onInstancesChanged?: () => void
  /** Where the event is, for connectors that default to the venue. */
  venue?: () => { latitude: number; longitude: number } | null
  /** The comms purge watermark, for connectors that publish speech. */
  purgedBefore?: () => number
  backoff?: BackoffOptions
}

/**
 * Supervises one connector per enabled instance row and applies configuration
 * changes without restarting the process — an admin adding a HyperDeck at
 * 20:55 must not interrupt the SPL log that is already running.
 */
export class ConnectorManager {
  private readonly supervisors = new Map<string, Supervisor>()
  /** Per-instance serialisation: rapid enable/disable toggles must not interleave. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly logger: Logger
  private stopped = false

  constructor(private readonly opts: ConnectorManagerOptions) {
    this.logger = opts.logger.child({ component: 'connector-manager' })
  }

  async start(): Promise<void> {
    const definitions = this.opts.loadAllDefinitions()
    await Promise.all(definitions.filter((d) => d.enabled).map((d) => this.apply(d.id)))
    this.publishStatusAggregate()
    this.logger.info({ count: this.supervisors.size }, 'connectors started')
  }

  /**
   * Reconciles one instance against the database: starts, restarts, or stops
   * its supervisor. Reconfiguration is always stop-then-start — predictable,
   * and no connector has to implement in-place config swapping.
   */
  apply(instanceId: string): Promise<void> {
    const previous = this.queues.get(instanceId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.applyNow(instanceId))
      .then(() => this.opts.onInstancesChanged?.())
      .catch((error) => this.logger.error({ err: error, instanceId }, 'failed to apply instance'))

    this.queues.set(instanceId, next)
    return next
  }

  private async applyNow(instanceId: string): Promise<void> {
    if (this.stopped) return

    const existing = this.supervisors.get(instanceId)
    if (existing) {
      this.supervisors.delete(instanceId)
      await existing.stop()
    }

    const definition = this.opts.loadDefinition(instanceId)
    if (!definition?.enabled) {
      if (existing) {
        // Tombstone: clients drop the widget's data instead of showing a value
        // frozen at whatever it was when the instance was removed.
        this.opts.sink.status({
          instanceId,
          state: 'stopped',
          detail: definition ? 'Disabled' : 'Removed',
          since: Date.now(),
          attempt: 0,
          lastError: null,
          pollIntervalMs: null,
        })
        this.publishStatusAggregate()
      }
      return
    }

    const module = this.opts.registry.get(definition.typeId)
    if (!module) {
      this.logger.error({ instanceId, typeId: definition.typeId }, 'unknown connector type')
      this.opts.sink.status({
        instanceId,
        state: 'error',
        detail: `Unknown connector type "${definition.typeId}"`,
        since: Date.now(),
        attempt: 0,
        lastError: 'unknown type',
        pollIntervalMs: null,
      })
      return
    }

    const supervisor = new Supervisor({
      definition,
      module,
      /*
       * Only `status` needs wrapping — it also refreshes the aggregate; the
       * rest are forwarded unchanged.
       *
       * Listed one by one, which is what let a fourth method go missing here
       * once: `recordHistory` was added to `ConnectorSink`, never forwarded,
       * and every connector in the product recorded nothing while every test
       * passed — the harness builds a Supervisor directly and never comes
       * through here. Spreading `this.opts.sink` is not the fix either: the
       * hub is a class, and a spread copies its fields and leaves its methods
       * on the prototype. What stops it happening again is that
       * `recordHistory` is no longer optional on the interface, so omitting it
       * below will not compile.
       */
      sink: {
        publish: (id, stream, payload) => this.opts.sink.publish(id, stream, payload),
        publishSystem: (topic, payload) => this.opts.sink.publishSystem(topic, payload),
        recordHistory: (id, points) => this.opts.sink.recordHistory(id, points),
        status: (status) => {
          this.opts.sink.status(status)
          this.publishStatusAggregate()
        },
      },
      logger: this.opts.logger,
      backoff: this.opts.backoff,
      venue: this.opts.venue,
      purgedBefore: this.opts.purgedBefore,
    })

    this.supervisors.set(instanceId, supervisor)
    await supervisor.start()
    this.publishStatusAggregate()
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    const supervisors = [...this.supervisors.values()]
    this.supervisors.clear()
    await Promise.all(supervisors.map((s) => s.stop().catch(() => {})))
    this.logger.info('connectors stopped')
  }

  getStatus(instanceId: string): InstanceStatus | null {
    return this.supervisors.get(instanceId)?.status ?? null
  }

  getAllStatuses(): Record<string, InstanceStatus> {
    const statuses: Record<string, InstanceStatus> = {}
    for (const [id, supervisor] of this.supervisors) statuses[id] = supervisor.status
    return statuses
  }

  getDefinition(instanceId: string): InstanceDefinition | null {
    return this.supervisors.get(instanceId)?.definition ?? null
  }

  /** See `Supervisor.simulatorHandle`. Tests only. */
  simulatorFor(instanceId: string): SimulatorHandle | null {
    return this.supervisors.get(instanceId)?.simulatorHandle ?? null
  }

  async exec(instanceId: string, commandId: string, input: unknown): Promise<CommandResult> {
    const supervisor = this.supervisors.get(instanceId)
    if (!supervisor) return commandFail('NOT_FOUND', 'Instance is not running')
    return supervisor.exec(commandId, input)
  }

  /** Republishes the aggregate unprompted; see `HealthEngine.announce`. */
  announce(): void {
    this.publishStatusAggregate()
  }

  /** One topic the status board can subscribe to instead of N per-instance ones. */
  private publishStatusAggregate(): void {
    this.opts.sink.publishSystem(SYS_STATUS, this.getAllStatuses())
  }
}
