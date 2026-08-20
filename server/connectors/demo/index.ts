import { Socket } from 'node:net'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { demoConditions } from './conditions.js'
import { LineSplitter } from './protocol.js'
import { DemoSimulator } from './simulator.js'

export const demoConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(9500),
  /** How long to wait for the device to answer before treating it as gone. */
  connectTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
})

export type DemoConfig = z.infer<typeof demoConfigSchema>

const setStateInput = z.object({
  state: z.string().min(1).max(40),
})

/**
 * Reference connector. Everything a vendor connector needs to do — connect,
 * parse a framed stream, publish typed streams, report health, accept a
 * command, and survive garbage — is shown here and nowhere else in miniature.
 */
class DemoConnector implements Connector<DemoConfig> {
  private socket: Socket | null = null
  private ctx: ConnectorContext<DemoConfig> | null = null
  private readonly splitter = new LineSplitter()
  private pending = new Map<string, (result: CommandResult) => void>()
  private commandSeq = 0

  start(ctx: ConnectorContext<DemoConfig>): Promise<void> {
    this.ctx = ctx
    const { host, port, connectTimeoutMs } = ctx.config

    return new Promise<void>((resolve) => {
      const socket = new Socket()
      this.socket = socket
      socket.setNoDelay(true)
      socket.setEncoding('utf8')

      // Without this, an unreachable host sits in SYN_SENT for ~75 seconds and
      // the dashboard shows "connecting" long after the truth is knowable.
      socket.setTimeout(connectTimeoutMs, () => {
        if (socket.connecting) ctx.fail(new Error('connect timed out'))
      })

      socket.on('connect', () => {
        socket.setTimeout(0)
        this.splitter.reset()
        ctx.setStatus('online')
        resolve()
      })

      socket.on('data', (chunk: string) => {
        for (const line of this.splitter.push(chunk)) this.handleLine(line)
      })

      socket.on('error', (error) => {
        ctx.fail(error)
        resolve()
      })

      socket.on('close', () => {
        // Only meaningful if we were up: a close during teardown is expected,
        // and ctx.fail() is a no-op by then anyway.
        ctx.fail(new Error('connection closed by device'))
        resolve()
      })

      // Aborting the signal is how the supervisor stops us mid-connect.
      ctx.signal.addEventListener('abort', () => socket.destroy(), { once: true })

      socket.connect(port, host)
    })
  }

  stop(): void {
    for (const resolve of this.pending.values()) {
      resolve(commandFail('NOT_CONNECTED', 'Connector stopped'))
    }
    this.pending.clear()

    const socket = this.socket
    this.socket = null
    // A socket can still emit an error while being torn down (a reset
    // arriving as we close). Node throws on an unhandled 'error' event, so a
    // swallowing listener goes back on before we destroy it.
    socket?.removeAllListeners()
    socket?.on('error', () => {})
    socket?.destroy()
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const socket = this.socket
    if (!socket || socket.destroyed) return commandFail('NOT_CONNECTED', 'Not connected')

    if (commandId !== 'setState') {
      return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
    }

    const parsed = setStateInput.safeParse(input)
    if (!parsed.success)
      return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')

    const id = `c${++this.commandSeq}`
    return new Promise<CommandResult>((resolve) => {
      this.pending.set(id, resolve)
      socket.write(`${JSON.stringify({ type: 'cmd', id, cmd: 'setState', args: parsed.data })}\n`)
    })
  }

  private handleLine(line: string): void {
    const ctx = this.ctx
    if (!ctx) return

    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line)
    } catch {
      // Malformed input from a device is a fact of life, not an outage: count
      // it, keep the connection, and let the next good frame through.
      ctx.logger.debug({ line: line.slice(0, 120) }, 'ignoring malformed frame')
      return
    }

    switch (frame.type) {
      case 'meter': {
        if (typeof frame.value !== 'number') return
        ctx.publish('meter', { value: frame.value, peak: frame.peak ?? frame.value })
        break
      }
      case 'state': {
        if (typeof frame.state !== 'string') return
        ctx.publish('state', { state: frame.state, elapsed: frame.elapsed ?? 0 })
        break
      }
      case 'hello': {
        ctx.publish('device', { device: frame.device ?? 'unknown', version: frame.version ?? '?' })
        break
      }
      case 'ack': {
        const id = typeof frame.id === 'string' ? frame.id : ''
        const resolve = this.pending.get(id)
        if (!resolve) return
        this.pending.delete(id)
        resolve(
          frame.ok === true
            ? commandOk()
            : commandFail('DEVICE_ERROR', String(frame.error ?? 'device rejected command')),
        )
        break
      }
      default:
        // Unknown frame types are ignored on purpose: vendors add fields in
        // firmware updates, and that must never take an instance offline.
        break
    }
  }
}

export const demoModule: ConnectorModule<DemoConfig> = {
  meta: {
    typeId: 'demo',
    displayName: 'Demo Device',
    description:
      'Built-in reference device speaking a simple line-JSON protocol. Useful for training, ' +
      'building dashboards before load-in, and verifying the system end to end.',
    configSchema: demoConfigSchema,
    streams: [
      {
        id: 'meter',
        label: 'Level meter',
        rateClass: 'fast',
        history: 'metric',
        metricFields: ['value'],
        fields: [
          { id: 'value', kind: 'number', label: 'Level' },
          { id: 'peak', kind: 'number', label: 'Peak' },
        ],
      },
      {
        id: 'state',
        label: 'Device state',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'elapsed', kind: 'number', label: 'Elapsed', unit: 's' },
          { id: 'state', kind: 'string', label: 'State' },
        ],
      },
      {
        id: 'device',
        label: 'Device info',
        rateClass: 'change',
        fields: [
          { id: 'device', kind: 'string', label: 'Device' },
          { id: 'version', kind: 'string', label: 'Version' },
        ],
      },
    ],
    commands: [
      {
        id: 'setState',
        label: 'Set state',
        description: 'Sets the simulated device state.',
        inputSchema: setStateInput,
      },
    ],
    conditions: demoConditions,
    capabilities: { control: true },
    tier: 'official',
  },
  create: () => new DemoConnector(),
  createSimulator: () => new DemoSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
