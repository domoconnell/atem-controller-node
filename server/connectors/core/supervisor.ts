import {
  COMMAND_TIMEOUT_MS,
  type CommandResult,
  type ConnectorState,
  commandFail,
  type InstanceStatus,
  STATUS_STREAM,
} from '@stageit/shared'
import type { Logger } from 'pino'
import { Backoff, type BackoffOptions } from './backoff.js'
import type {
  Connector,
  ConnectorContext,
  ConnectorModule,
  ConnectorSink,
  InstanceDefinition,
  SimulatorHandle,
} from './types.js'

export interface SupervisorOptions {
  definition: InstanceDefinition
  module: ConnectorModule<unknown>
  sink: ConnectorSink
  logger: Logger
  backoff?: BackoffOptions
  now?: () => number
  /** Injectable so tests can drive reconnect timing without real waiting. */
  scheduler?: (fn: () => void, ms: number) => { cancel: () => void }
  /** Where the event is; read at poll time. See `ConnectorContext.venue`. */
  venue?: () => { latitude: number; longitude: number } | null
  /** The comms purge watermark; read at publish time. See `ConnectorContext.purgedBefore`. */
  purgedBefore?: () => number
  stopTimeoutMs?: number
}

const defaultScheduler = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

/**
 * Owns one module instance's lifecycle: config validation, connect, health
 * reporting, reconnect-with-backoff, command dispatch, and teardown.
 *
 * Connectors deliberately do not implement their own retry logic — every
 * vendor protocol would reinvent it slightly differently. A connector reports
 * "I lost it" through `ctx.fail()` and this class decides what happens next.
 */
export class Supervisor {
  private readonly opts: Required<Pick<SupervisorOptions, 'now' | 'scheduler' | 'stopTimeoutMs'>> &
    SupervisorOptions
  private readonly backoff: Backoff
  private readonly logger: Logger

  private connector: Connector<unknown> | null = null
  private simulator: SimulatorHandle | null = null
  private abortController: AbortController | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private intervals = new Set<ReturnType<typeof setInterval>>()
  /**
   * Every interval this connector asked for, so its rhythm can be published.
   *
   * The longest is the one that matters: a connector with a fast probe and a
   * slow poll is judged by the slow one, and any stream quicker than that
   * corrects the estimate itself once two frames have been seen.
   */
  private registeredIntervals: number[] = []
  private retryHandle: { cancel: () => void } | null = null

  /**
   * Incremented on every start/stop. Callbacks captured by a previous run
   * compare against it and become no-ops — this is what stops a socket that
   * closes during teardown from publishing into a reconfigured instance.
   */
  private generation = 0
  private running = false

  private state: ConnectorState = 'configuring'
  private detail: string | null = null
  private since: number
  private lastError: string | null = null
  private onlineSince: number | null = null

  constructor(options: SupervisorOptions) {
    this.opts = {
      now: () => Date.now(),
      scheduler: defaultScheduler,
      stopTimeoutMs: 5_000,
      ...options,
    }
    this.backoff = new Backoff(options.backoff)
    this.logger = options.logger.child({
      instanceId: options.definition.id,
      typeId: options.definition.typeId,
    })
    this.since = this.opts.now()
  }

  get definition(): InstanceDefinition {
    return this.opts.definition
  }

  get status(): InstanceStatus {
    return {
      instanceId: this.definition.id,
      state: this.state,
      detail: this.detail,
      since: this.since,
      attempt: this.backoff.attempts,
      lastError: this.lastError,
      pollIntervalMs:
        this.registeredIntervals.length > 0 ? Math.max(...this.registeredIntervals) : null,
    }
  }

  /** Starts the connector and keeps it running until `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.attemptConnect()
  }

  async stop(): Promise<void> {
    this.running = false
    this.retryHandle?.cancel()
    this.retryHandle = null
    await this.teardown()
    this.setState('stopped')
  }

  /**
   * The running simulator, for tests that need to stand in for the operator.
   *
   * Not for production code, and narrow on purpose. It exists because some
   * protocols will not let a client create the thing it then writes to —
   * Companion refuses to make a custom variable over HTTP, so a test of the
   * feature that writes one has to declare it first, exactly as somebody would
   * on Companion's own page. Doing that through the connector would be
   * pretending the protocol allows something it does not.
   */
  get simulatorHandle(): SimulatorHandle | null {
    return this.simulator
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    // State first: while offline there is no connector object at all, and
    // "not connected" is the answer the operator needs to see — not a
    // misleading "unknown command".
    if (this.state !== 'online' && this.state !== 'degraded') {
      return commandFail('NOT_CONNECTED', `Instance is ${this.state}`)
    }
    const connector = this.connector
    if (!connector?.exec) {
      return commandFail('NOT_FOUND', `Connector does not implement ${commandId}`)
    }

    try {
      // A device that stops answering must not wedge the HTTP request that
      // asked for the command, nor the client waiting on the ack.
      return await Promise.race([
        Promise.resolve(connector.exec(commandId, input)),
        new Promise<CommandResult>((resolve) =>
          this.scheduleTimeout(
            () => resolve(commandFail('TIMEOUT', `Command ${commandId} timed out`)),
            COMMAND_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      this.logger.error({ err: error, commandId }, 'command threw')
      return commandFail('DEVICE_ERROR', (error as Error).message ?? 'Command failed')
    }
  }

  // ------------------------------------------------------------------ internals

  private async attemptConnect(): Promise<void> {
    if (!this.running) return

    const generation = ++this.generation
    this.setState('configuring')

    // Config is validated at start, not only at save time: a migration or a
    // hand-edited database could otherwise hand a connector nonsense.
    const parsed = this.opts.module.meta.configSchema.safeParse(this.definition.config)
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
        .join('; ')
      // Terminal on purpose: retrying a config error on a timer just fills the
      // log with the same message until someone fixes the settings.
      this.lastError = message
      this.setState('error', `Invalid configuration — ${message}`)
      return
    }

    let config = parsed.data as unknown

    try {
      if (this.definition.simulate) {
        this.simulator = this.opts.module.createSimulator()
        const address = await this.simulator.listen('127.0.0.1', 0)
        if (generation !== this.generation) {
          await this.simulator.close().catch(() => {})
          return
        }
        config = this.opts.module.simulatedConfig(address, config)
        this.logger.info({ address }, 'started protocol simulator')
      }

      this.setState('connecting')
      this.abortController = new AbortController()
      this.connector = this.opts.module.create()

      const ctx = this.createContext(generation, config)

      /**
       * Deliberately not awaited. Reaching a device can take as long as its
       * TCP timeout, and an admin saving a typo'd IP must not sit watching a
       * spinner for five seconds — the form returns immediately and the
       * dashboard shows the instance moving through `connecting`.
       */
      void Promise.resolve(this.connector.start(ctx)).catch((error) => {
        if (generation !== this.generation) return
        this.handleFailure(error, 'failed to start')
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.handleFailure(error, 'failed to start')
    }
  }

  private createContext(generation: number, config: unknown): ConnectorContext<unknown> {
    const isCurrent = () => generation === this.generation && this.running

    return {
      instanceId: this.definition.id,
      instanceName: this.definition.name,
      config,
      simulate: this.definition.simulate,
      logger: this.logger,
      signal: this.abortController?.signal ?? new AbortController().signal,

      publish: (streamId, payload) => {
        if (!isCurrent()) return
        if (streamId === STATUS_STREAM) {
          this.logger.warn({ streamId }, 'connector tried to publish the reserved status stream')
          return
        }
        try {
          this.opts.sink.publish(this.definition.id, streamId, payload)
        } catch (error) {
          this.logger.error({ err: error, streamId }, 'sink publish failed')
        }
      },

      recordHistory: (points) => {
        if (!isCurrent()) return
        if (points.length === 0) return
        try {
          this.opts.sink.recordHistory(this.definition.id, points)
        } catch (error) {
          // Losing history is regrettable; failing the show is not acceptable.
          this.logger.error({ err: error, points: points.length }, 'sink recordHistory failed')
        }
      },

      setStatus: (state, detail) => {
        if (!isCurrent()) return
        if (state === 'online' && this.state !== 'online') {
          this.onlineSince = this.opts.now()
        }
        this.setState(state, detail ?? null)
        this.backoff.onConnected(this.opts.now(), this.onlineSince)
      },

      fail: (error, detail) => {
        if (!isCurrent()) return
        this.handleFailure(error, detail)
      },

      venue: () => this.opts.venue?.() ?? null,
      purgedBefore: () => this.opts.purgedBefore?.() ?? 0,

      setInterval: (fn, ms) => {
        const handle = setInterval(() => {
          if (!isCurrent()) return
          try {
            fn()
          } catch (error) {
            // A throwing poll tick is a bug, not a disconnection: log it and
            // keep the instance up rather than triggering a reconnect storm.
            this.logger.error({ err: error }, 'connector interval threw')
          }
        }, ms)
        this.intervals.add(handle)
        this.registeredIntervals.push(ms)
        return () => {
          clearInterval(handle)
          this.intervals.delete(handle)
        }
      },

      setTimeout: (fn, ms) => {
        const handle = setTimeout(() => {
          this.timers.delete(handle)
          if (!isCurrent()) return
          try {
            fn()
          } catch (error) {
            this.logger.error({ err: error }, 'connector timeout threw')
          }
        }, ms)
        this.timers.add(handle)
        return () => {
          clearTimeout(handle)
          this.timers.delete(handle)
        }
      },
    }
  }

  private handleFailure(error: unknown, detail?: string): void {
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = message
    this.onlineSince = null
    this.setState('offline', detail ? `${detail}: ${message}` : message)

    void this.teardown().then(() => {
      if (!this.running) return
      const delay = this.backoff.nextDelay(this.opts.now())
      this.logger.warn({ err: message, delay, attempt: this.backoff.attempts }, 'reconnecting')
      this.retryHandle = this.opts.scheduler(() => {
        this.retryHandle = null
        void this.attemptConnect()
      }, delay)
    })
  }

  /** Releases everything owned by the current generation. Never throws. */
  private async teardown(): Promise<void> {
    this.generation += 1

    for (const handle of this.timers) clearTimeout(handle)
    for (const handle of this.intervals) clearInterval(handle)
    this.timers.clear()
    this.intervals.clear()
    this.registeredIntervals = []

    this.abortController?.abort()
    this.abortController = null

    const connector = this.connector
    this.connector = null
    if (connector) {
      try {
        await withTimeout(Promise.resolve(connector.stop()), this.opts.stopTimeoutMs)
      } catch (error) {
        // Force-disposed: we already aborted its signal and dropped the
        // reference, so a connector that hangs in stop() can't hold us up.
        this.logger.warn({ err: error }, 'connector stop did not settle cleanly')
      }
    }

    const simulator = this.simulator
    this.simulator = null
    if (simulator) {
      try {
        await withTimeout(simulator.close(), this.opts.stopTimeoutMs)
      } catch (error) {
        this.logger.warn({ err: error }, 'simulator close did not settle cleanly')
      }
    }
  }

  private setState(state: ConnectorState, detail: string | null = null): void {
    if (this.state === state && this.detail === detail) return
    this.state = state
    this.detail = detail
    this.since = this.opts.now()
    if (state === 'online') this.lastError = null

    try {
      this.opts.sink.status(this.status)
    } catch (error) {
      this.logger.error({ err: error }, 'sink status failed')
    }
  }

  private scheduleTimeout(fn: () => void, ms: number): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle)
      fn()
    }, ms)
    this.timers.add(handle)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(handle)
        resolve(value)
      },
      (error) => {
        clearTimeout(handle)
        reject(error)
      },
    )
  })
}
