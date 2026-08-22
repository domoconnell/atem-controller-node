import { createSocket, type Socket } from 'node:dgram'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { digicoConditions } from './conditions.js'
import {
  type ChannelState,
  decodeOsc,
  encodeOsc,
  fireMacroMessage,
  interpret,
  type MacroState,
  muteChannelMessage,
  queryMessages,
} from './protocol.js'
import { DigicoSimulator } from './simulator.js'

export const digicoConfigSchema = z.object({
  host: z.string().min(1).default('192.168.1.10'),
  /** The console's receive port — "Send" in its External Control panel. */
  sendPort: z.number().int().min(1).max(65535).default(8000),
  /** The port the console sends to; this connector binds it. 0 lets the OS pick. */
  receivePort: z.number().int().min(0).max(65535).default(9000),
  /**
   * Some firmware expects addresses prefixed with `/sd`, some rejects it.
   * Bench-test against the actual console before a show depends on it.
   */
  addressPrefix: z.enum(['', '/sd']).default(''),
  channelCount: z.number().int().min(0).max(128).default(32),
  pollIntervalSeconds: z.number().int().min(5).max(600).default(30),
  timeoutSeconds: z.number().int().min(10).max(300).default(45),
  /**
   * Turns labelled macro presses into a message feed. Console text chat rides
   * the audio transport and cannot be read over the network, so this is the
   * closest honest substitute.
   */
  messagesFromMacros: z.boolean().default(true),
  /** Firing macros back at the console; off until an admin decides otherwise. */
  allowMacroFire: z.boolean().default(false),
})

export type DigicoConfig = z.infer<typeof digicoConfigSchema>

const fireMacroInput = z.object({ index: z.number().int().min(1).max(500) })
const muteChannelInput = z.object({ channel: z.number().int().min(1).max(128), muted: z.boolean() })

/** Keeps the message feed to something a widget can render. */
const MESSAGE_LIMIT = 50

/**
 * DiGiCo SD-series consoles over the Pad OSC command set.
 *
 * Read the vendorNotes before trusting this on a show: there is no published
 * address dictionary, and firmware differs in whether it wants the `/sd`
 * prefix.
 */
class DigicoConnector implements Connector<DigicoConfig> {
  private ctx: ConnectorContext<DigicoConfig> | null = null
  private socket: Socket | null = null
  private cancelRefresh: (() => void) | null = null
  private cancelWatchdog: (() => void) | null = null
  private lastMessageAt = 0
  private channels = new Map<number, ChannelState>()
  private macros = new Map<number, MacroState>()
  private messages: { id: string; text: string; at: number }[] = []
  private messageSeq = 0

  async start(ctx: ConnectorContext<DigicoConfig>): Promise<void> {
    this.ctx = ctx
    this.lastMessageAt = Date.now()

    const socket = createSocket('udp4')
    this.socket = socket
    socket.on('message', (buffer) => this.onDatagram(buffer))
    socket.on('error', (error) => ctx.fail(error, 'UDP socket error'))

    await new Promise<void>((resolve, reject) => {
      socket.bind(ctx.config.receivePort, () => resolve())
      socket.once('error', reject)
    })

    this.query()
    this.cancelRefresh = ctx.setInterval(() => this.query(), ctx.config.pollIntervalSeconds * 1_000)
    this.cancelWatchdog = ctx.setInterval(() => this.checkAlive(), 5_000)
  }

  stop(): void {
    this.cancelRefresh?.()
    this.cancelWatchdog?.()
    this.cancelRefresh = null
    this.cancelWatchdog = null
    this.socket?.close()
    this.socket = null
    this.ctx = null
    this.channels.clear()
    this.macros.clear()
    this.messages = []
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not connected')

    if (commandId === 'macro.fire') {
      if (!ctx.config.allowMacroFire) {
        return commandFail('NOT_ALLOWED', 'Firing macros is disabled for this console')
      }
      const parsed = fireMacroInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Pick a macro number')
      this.send(fireMacroMessage(ctx.config.addressPrefix, parsed.data.index))
      return commandOk()
    }

    // Mute/unmute an input channel — drives runsheet mic-mute automation. The
    // console echoes the new mute back, so the UI catches up on its own.
    if (commandId === 'channel.mute') {
      const parsed = muteChannelInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Need { channel, muted }')
      this.send(muteChannelMessage(ctx.config.addressPrefix, parsed.data.channel, parsed.data.muted))
      return commandOk()
    }

    return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
  }

  private onDatagram(buffer: Buffer): void {
    const ctx = this.ctx
    if (!ctx) return

    this.lastMessageAt = Date.now()
    const message = decodeOsc(buffer)
    if (!message) return // not OSC, or truncated; the console will send more

    const update = interpret(message)
    if (!update) return

    ctx.setStatus('online')

    if (update.channel) {
      const existing = this.channels.get(update.channel.channel) ?? {
        channel: update.channel.channel,
        name: null,
        muted: null,
        faderDb: null,
      }
      // Partial merge: the console sends one leaf at a time.
      this.channels.set(update.channel.channel, {
        channel: update.channel.channel,
        name: update.channel.name ?? existing.name,
        muted: update.channel.muted ?? existing.muted,
        faderDb: update.channel.faderDb ?? existing.faderDb,
      })
      ctx.publish('channels', { channels: [...this.channels.values()] })
    }

    if (update.macro) {
      this.macros.set(update.macro.index, update.macro)
      ctx.publish('macros', { macros: [...this.macros.values()] })

      // A macro going *on* is the press; its release is not a second message.
      if (ctx.config.messagesFromMacros && update.macro.on) {
        this.messageSeq += 1
        this.messages = [
          { id: `m${this.messageSeq}`, text: update.macro.name, at: update.macro.at },
          ...this.messages,
        ].slice(0, MESSAGE_LIMIT)
        ctx.publish('messages', { messages: this.messages })
      }
    }

    if (update.snapshotNumber !== undefined) {
      ctx.publish('snapshots', { current: update.snapshotNumber, at: Date.now() })
    }
  }

  private query(): void {
    const ctx = this.ctx
    if (!ctx) return
    for (const message of queryMessages(ctx.config.addressPrefix, ctx.config.channelCount)) {
      this.send(message)
    }
  }

  private checkAlive(): void {
    const ctx = this.ctx
    if (!ctx) return

    const silentMs = Date.now() - this.lastMessageAt
    if (silentMs > ctx.config.timeoutSeconds * 1_000) {
      // Nothing at all from the console: either External Control was switched
      // off, or the port pair does not match. Both need a human.
      ctx.fail(
        new Error(`no OSC from the console for ${Math.round(silentMs / 1000)}s`),
        'Console silent — check External Control and the port pair',
      )
    }
  }

  private send(message: { address: string; args: (number | string)[] }): void {
    const ctx = this.ctx
    if (!ctx || !this.socket) return
    this.socket.send(encodeOsc(message), ctx.config.sendPort, ctx.config.host, (error) => {
      if (error) ctx.logger.debug({ err: error }, 'OSC send failed')
    })
  }
}

export const digicoModule: ConnectorModule<DigicoConfig> = {
  meta: {
    typeId: 'digico',
    displayName: 'DiGiCo SD console',
    description:
      'Channel names and mutes, macro states and snapshot fires from an SD-series console, ' +
      'plus a message feed built from labelled macro presses. Console text chat cannot be ' +
      'read over the network — see the notes — so labelled macros are the substitute.',
    configSchema: digicoConfigSchema,
    streams: [
      { id: 'channels', label: 'Channels', rateClass: 'slow' },
      { id: 'macros', label: 'Macros', rateClass: 'change' },
      { id: 'messages', label: 'Messages', rateClass: 'change', history: 'events' },
      { id: 'snapshots', label: 'Snapshots', rateClass: 'change', history: 'events' },
    ],
    commands: [
      {
        id: 'macro.fire',
        label: 'Fire macro',
        description: 'Presses a macro on the console — for acknowledging a message.',
        inputSchema: fireMacroInput,
        dangerous: true,
      },
      {
        id: 'channel.mute',
        label: 'Mute / unmute channel',
        description: 'Sets an input channel’s mute — drives runsheet mic-mute automation.',
        inputSchema: muteChannelInput,
        dangerous: true,
      },
    ],
    conditions: digicoConditions,
    capabilities: { control: true },
    tier: 'caveated',
    // Never met a console. The `/sd` address-prefix question below is
    // unresolved for exactly that reason, and a module that connects and
    // reports nothing is the failure a show would blame the dashboard for.
    // Clear this when somebody has bench-tested it and written down what the
    // console said.
    unproven: true,
    vendorNotes:
      'Console text chat CANNOT be read over the network. It travels inside the audio ' +
      'transport — the last eight channels of a MADI port set to "Console", or the Optocore ' +
      'loop — and never touches the control LAN; no OSC address for it exists. Instead, label ' +
      'macros on the console with the things people need to say ("Need runner", "Mic 3 down") ' +
      'and this module turns each press into a timestamped message you can alert on. ' +
      'Setup: Setup → External Control → enable, add a "DiGiCo Pad" device pointed at this ' +
      'server, and give it a unique send/receive port pair. There is no published OSC ' +
      'dictionary: the addresses used here are proven against real consoles by the Bitfocus ' +
      'and OSCWebMixer projects, but firmware differs over whether addresses want a "/sd" ' +
      'prefix. Bench-test against your console before a show depends on it.',
  },
  create: () => new DigicoConnector(),
  createSimulator: () => new DigicoSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    host: address.host,
    sendPort: address.port,
    // 0 lets the OS pick the bind port, so parallel tests do not collide.
    receivePort: 0,
    channelCount: 2,
  }),
}
