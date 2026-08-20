import { Socket } from 'node:net'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { hyperdeckConditions } from './conditions.js'
import {
  type HyperDeckResponse,
  HyperDeckResponseAssembler,
  isSuccessCode,
  parseDevice,
  parseSlot,
  parseTransport,
} from './protocol.js'
import { HyperDeckSimulator } from './simulator.js'

export const hyperdeckConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(9993),
  /** Only a safety net: the deck pushes changes once `notify` is enabled. */
  pollIntervalMs: z.number().int().min(500).max(60_000).default(2_000),
})

export type HyperDeckConfig = z.infer<typeof hyperdeckConfigSchema>

/**
 * A clip name goes straight into the command line, so a newline would let a
 * name typed into a web form inject a second command — `stop`, for instance —
 * and a colon would be read as the start of another parameter.
 */
const CLIP_NAME = /^[^\r\n:]+$/

const recordInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(CLIP_NAME, 'name cannot contain a colon or newline')
    .optional(),
})
const stopInput = z.object({})
/** HyperDeck speed is a percentage: -1600 (fast reverse) to 1600. */
const playInput = z.object({ speed: z.number().int().min(-1600).max(1600).optional() })
const gotoInput = z.object({
  timecode: z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/, 'timecode must look like 01:23:45:00'),
})

const CONNECT_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000

interface PendingCommand {
  line: string
  resolve: (response: HyperDeckResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Blackmagic HyperDeck over its documented Ethernet protocol.
 *
 * `notify` is enabled on connect so the deck pushes transport and slot changes
 * the instant they happen: a record that stops because a card filled up has to
 * reach the wall in under a second, not on the next poll. The poll stays as a
 * safety net for a notification that never arrives.
 */
class HyperDeckConnector implements Connector<HyperDeckConfig> {
  private socket: Socket | null = null
  private ctx: ConnectorContext<HyperDeckConfig> | null = null
  private readonly assembler = new HyperDeckResponseAssembler()
  private pending: PendingCommand[] = []
  private pollInFlight = false

  async start(ctx: ConnectorContext<HyperDeckConfig>): Promise<void> {
    this.ctx = ctx
    await this.openSocket(ctx)

    // openSocket resolves on failure too, having already reported it.
    if (!this.socket || this.socket.destroyed) return

    // The `500 connection info:` greeting is asynchronous, so it can never be
    // mistaken for this reply and there is nothing to wait for before asking.
    const notify = await this.request('notify: transport: true slot: true')
    if (!isSuccessCode(notify.code)) {
      throw new Error(`HyperDeck refused notifications: ${notify.code} ${notify.text}`)
    }

    // One round of state before going online, so the dashboard never shows a
    // connected deck with three empty widgets.
    await this.refresh(ctx)
    ctx.setStatus('online')

    ctx.setInterval(() => void this.poll(ctx), ctx.config.pollIntervalMs)
  }

  stop(): void {
    this.failPending(new Error('Connector stopped'))

    const socket = this.socket
    this.socket = null
    // A socket can still emit an error while being torn down (a reset
    // arriving as we close). Node throws on an unhandled 'error' event, so a
    // swallowing listener goes back on before we destroy it.
    socket?.removeAllListeners()
    socket?.on('error', () => {})
    socket?.destroy()
    this.assembler.reset()
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const line = this.commandLine(commandId, input)
    if ('error' in line) return line.error

    if (!this.socket || this.socket.destroyed) {
      return commandFail('NOT_CONNECTED', 'Not connected to the HyperDeck')
    }

    try {
      const response = await this.request(line.value)
      if (isSuccessCode(response.code)) return commandOk()
      // "120 no video input" is the deck telling us it cannot do what was
      // asked. That is an answer, not a fault of ours.
      return commandFail('DEVICE_ERROR', `${response.code} ${response.text}`)
    } catch (error) {
      if (!this.socket || this.socket.destroyed) {
        return commandFail('NOT_CONNECTED', 'Connection to the HyperDeck was lost')
      }
      return commandFail('TIMEOUT', (error as Error).message)
    }
  }

  /** Builds the wire line for a command, or the failure to report instead. */
  private commandLine(
    commandId: string,
    input: unknown,
  ): { value: string } | { error: CommandResult } {
    const invalid = (message: string) => ({ error: commandFail('INVALID_INPUT', message) })

    switch (commandId) {
      case 'record': {
        const parsed = recordInput.safeParse(input ?? {})
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'bad input')
        return { value: parsed.data.name ? `record: name: ${parsed.data.name}` : 'record' }
      }
      case 'stop': {
        const parsed = stopInput.safeParse(input ?? {})
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'bad input')
        return { value: 'stop' }
      }
      case 'play': {
        const parsed = playInput.safeParse(input ?? {})
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'bad input')
        return {
          value: parsed.data.speed === undefined ? 'play' : `play: speed: ${parsed.data.speed}`,
        }
      }
      case 'goto': {
        const parsed = gotoInput.safeParse(input ?? {})
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'bad input')
        return { value: `goto: timecode: ${parsed.data.timecode}` }
      }
      default:
        return { error: commandFail('NOT_FOUND', `Unknown command ${commandId}`) }
    }
  }

  // ------------------------------------------------------------------ connection

  private openSocket(ctx: ConnectorContext<HyperDeckConfig>): Promise<void> {
    const { host, port } = ctx.config

    return new Promise<void>((resolve) => {
      const socket = new Socket()
      this.socket = socket
      socket.setNoDelay(true)
      socket.setEncoding('utf8')

      // Without this, an unreachable deck sits in SYN_SENT for ~75 seconds and
      // the dashboard shows "connecting" long after the truth is knowable.
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (socket.connecting) ctx.fail(new Error('connect timed out'))
      })

      socket.on('connect', () => {
        socket.setTimeout(0)
        this.assembler.reset()
        resolve()
      })

      socket.on('data', (chunk: string) => {
        for (const response of this.assembler.push(chunk)) this.handleResponse(ctx, response)
      })

      socket.on('error', (error) => {
        this.failPending(error)
        ctx.fail(error)
        resolve()
      })

      socket.on('close', () => {
        this.failPending(new Error('connection closed by the HyperDeck'))
        ctx.fail(new Error('connection closed by the HyperDeck'))
        resolve()
      })

      ctx.signal.addEventListener('abort', () => socket.destroy(), { once: true })

      socket.connect(port, host)
    })
  }

  private request(line: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HyperDeckResponse> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('not connected to the HyperDeck'))
    }

    return new Promise<HyperDeckResponse>((resolve, reject) => {
      const entry: PendingCommand = {
        line,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter((candidate) => candidate !== entry)
          const error = new Error(`HyperDeck did not answer "${line}" within ${timeoutMs}ms`)
          reject(error)
          // The protocol has no request ids: replies are matched by order, so
          // a missing one means we can no longer tell which answer belongs to
          // which command. Reconnecting is the only way back to certainty.
          this.ctx?.fail(error)
        }, timeoutMs),
      }

      this.pending.push(entry)
      socket.write(`${line}\r\n`)
    })
  }

  private async poll(ctx: ConnectorContext<HyperDeckConfig>): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      await this.refresh(ctx)
    } catch (error) {
      // The socket handlers own connection health; a missed poll is a missed
      // frame, and the deck's own pushes are the primary source anyway.
      ctx.logger.debug({ err: error }, 'HyperDeck poll failed')
    } finally {
      this.pollInFlight = false
    }
  }

  /**
   * Asked one at a time rather than pipelined: replies are matched by arrival
   * order, and a deck that answers only one of two in-flight commands would
   * hand the wrong answer to the wrong caller.
   */
  private async refresh(ctx: ConnectorContext<HyperDeckConfig>): Promise<void> {
    const transport = await this.request('transport info')
    if (!isSuccessCode(transport.code)) {
      ctx.logger.debug({ code: transport.code }, 'HyperDeck refused transport info')
    }

    const slot = await this.request('slot info')
    if (!isSuccessCode(slot.code)) {
      // A deck with no card in the active slot answers with an error here, and
      // that is a perfectly normal state before load-in.
      ctx.logger.debug({ code: slot.code }, 'HyperDeck refused slot info')
    }
  }

  private handleResponse(
    ctx: ConnectorContext<HyperDeckConfig>,
    response: HyperDeckResponse,
  ): void {
    // Publish first: by the time a command's promise resolves, the state it
    // changed is already on its way to the dashboard.
    this.publish(ctx, response)

    if (response.asynchronous) return

    const entry = this.pending.shift()
    if (!entry) {
      ctx.logger.debug({ code: response.code }, 'HyperDeck response nobody asked for')
      return
    }
    clearTimeout(entry.timer)
    entry.resolve(response)
  }

  /**
   * Dispatches on the response text rather than the numeric code: the deck
   * uses one code for a polled answer and another for the pushed version of
   * the same thing, and the numbering has moved between firmware releases.
   */
  private publish(ctx: ConnectorContext<HyperDeckConfig>, response: HyperDeckResponse): void {
    switch (response.text) {
      case 'transport info':
        ctx.publish('transport', parseTransport(response.fields))
        break
      case 'slot info':
        ctx.publish('slots', parseSlot(response.fields))
        break
      case 'connection info':
        ctx.publish('device', parseDevice(response.fields))
        break
      default:
        // Everything else is an ack or an error, which the caller deals with.
        break
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending
    this.pending = []
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

export const hyperdeckModule: ConnectorModule<HyperDeckConfig> = {
  meta: {
    typeId: 'hyperdeck',
    displayName: 'Blackmagic HyperDeck',
    description:
      'Blackmagic HyperDeck recorder over its Ethernet protocol. Reports transport state, ' +
      'timecode and the recording time left on each card, and can start and stop a record ' +
      'from the dashboard.',
    configSchema: hyperdeckConfigSchema,
    streams: [
      {
        id: 'transport',
        label: 'Transport',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'speed', kind: 'number', label: 'Speed' },
          { id: 'slotId', kind: 'number', label: 'Slot' },
          { id: 'clipId', kind: 'number', label: 'Clip' },
          { id: 'status', kind: 'string', label: 'Transport' },
          { id: 'timecode', kind: 'string', label: 'Timecode' },
          { id: 'displayTimecode', kind: 'string', label: 'Display timecode' },
        ],
      },
      {
        id: 'slots',
        label: 'Media slots',
        rateClass: 'slow',
        history: 'metric',
        // Recording time left is the number that decides whether a card gets
        // swapped between bands, so it belongs in the history log.
        metricFields: ['recordingTimeSeconds'],
        fields: [
          { id: 'recordingTimeSeconds', kind: 'number', label: 'Recording time left', unit: 's' },
          { id: 'slotId', kind: 'number', label: 'Slot' },
          { id: 'status', kind: 'string', label: 'Slot status' },
          { id: 'volumeName', kind: 'string', label: 'Volume' },
          { id: 'videoFormat', kind: 'string', label: 'Video format' },
        ],
      },
      {
        id: 'device',
        label: 'Device info',
        rateClass: 'change',
        fields: [
          { id: 'model', kind: 'string', label: 'Model' },
          { id: 'protocolVersion', kind: 'string', label: 'Protocol version' },
        ],
      },
    ],
    commands: [
      {
        id: 'record',
        label: 'Record',
        description: 'Starts recording, optionally naming the clip.',
        inputSchema: recordInput,
        // Both of these end a take. A stray click on `stop` during the
        // headline set loses footage nobody can shoot again, and `record` on a
        // deck already rolling is how you find that out.
        dangerous: true,
      },
      {
        id: 'stop',
        label: 'Stop',
        description: 'Stops playback or recording.',
        inputSchema: stopInput,
        dangerous: true,
      },
      {
        id: 'play',
        label: 'Play',
        description: 'Starts playback, optionally at a speed percentage.',
        inputSchema: playInput,
      },
      {
        id: 'goto',
        label: 'Go to timecode',
        description: 'Jumps the transport to a timecode.',
        inputSchema: gotoInput,
      },
    ],
    conditions: hyperdeckConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'Blackmagic publish the HyperDeck Ethernet protocol (plain text on TCP 9993) in the ' +
      'product manual, and it is the same on every model from the Studio Mini up. Newer ' +
      'Extreme and Shuttle HD decks also expose a REST API; this connector does not need it, ' +
      'so one integration covers the whole fleet a festival is likely to have on site.',
  },
  create: () => new HyperDeckConnector(),
  createSimulator: () => new HyperDeckSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
