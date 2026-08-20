import { createSocket, type Socket } from 'node:dgram'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { sennheiserConditions } from './conditions.js'
import {
  type ChannelReading,
  type DeviceReading,
  identifyMessage,
  muteMessage,
  parseSscMessage,
  queryMessage,
  SSC_PORT,
  subscribeMessage,
} from './protocol.js'
import { SennheiserSimulator } from './simulator.js'

export const sennheiserConfigSchema = z.object({
  host: z.string().min(1).default('192.168.1.50'),
  port: z.number().int().min(1).max(65535).default(SSC_PORT),
  /**
   * How long the receiver should keep pushing before we renew. Short enough
   * that a restarted server stops receiving quickly, long enough not to spend
   * the show renewing.
   */
  subscriptionLifetimeSeconds: z.number().int().min(30).max(600).default(120),
  /** A full read on this interval catches names and anything a push missed. */
  pollIntervalSeconds: z.number().int().min(5).max(300).default(30),
  /** Silence for this long means the receiver has gone. */
  timeoutSeconds: z.number().int().min(5).max(120).default(15),
  /** Muting a live vocal mic by accident is a bad evening; off by default. */
  allowMute: z.boolean().default(false),
})

export type SennheiserConfig = z.infer<typeof sennheiserConfigSchema>

const identifyInput = z.object({ channel: z.enum(['1', '2']) })
const muteInput = z.object({ channel: z.enum(['1', '2']), muted: z.boolean() })

/**
 * EW-DX and Digital 6000 receivers, over SSC.
 *
 * Straight to the receiver rather than through Wireless Systems Manager: WSM
 * has no third-party interface, and the RF techs need it for their own work.
 */
class SennheiserConnector implements Connector<SennheiserConfig> {
  private ctx: ConnectorContext<SennheiserConfig> | null = null
  private socket: Socket | null = null
  private cancelRefresh: (() => void) | null = null
  private cancelResubscribe: (() => void) | null = null
  private cancelWatchdog: (() => void) | null = null
  private lastMessageAt = 0
  private channels = new Map<string, ChannelReading>()
  private device: DeviceReading = { name: null, model: null, warnings: [] }

  async start(ctx: ConnectorContext<SennheiserConfig>): Promise<void> {
    this.ctx = ctx
    this.lastMessageAt = Date.now()

    const socket = createSocket('udp4')
    this.socket = socket

    socket.on('message', (message) => this.onMessage(message.toString()))
    socket.on('error', (error) => ctx.fail(error, 'UDP socket error'))

    await new Promise<void>((resolve, reject) => {
      socket.bind(0, () => resolve())
      socket.once('error', reject)
    })

    this.send(subscribeMessage(ctx.config.subscriptionLifetimeSeconds))
    this.send(queryMessage())

    // Renew before the receiver forgets us; a lapsed subscription is silent,
    // which is the worst kind of failure for RF monitoring.
    const renewMs = Math.max(15_000, ctx.config.subscriptionLifetimeSeconds * 500)
    this.cancelResubscribe = ctx.setInterval(
      () => this.send(subscribeMessage(ctx.config.subscriptionLifetimeSeconds)),
      renewMs,
    )
    this.cancelRefresh = ctx.setInterval(
      () => this.send(queryMessage()),
      ctx.config.pollIntervalSeconds * 1_000,
    )
    this.cancelWatchdog = ctx.setInterval(() => this.checkAlive(), 2_000)
  }

  stop(): void {
    this.cancelRefresh?.()
    this.cancelResubscribe?.()
    this.cancelWatchdog?.()
    this.cancelRefresh = null
    this.cancelResubscribe = null
    this.cancelWatchdog = null
    this.socket?.close()
    this.socket = null
    this.ctx = null
    this.channels.clear()
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not connected')

    if (commandId === 'identify') {
      const parsed = identifyInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Pick a channel')
      this.send(identifyMessage(parsed.data.channel))
      return commandOk()
    }

    if (commandId === 'mute') {
      if (!ctx.config.allowMute) {
        return commandFail('NOT_ALLOWED', 'Muting is disabled for this receiver')
      }
      const parsed = muteInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Pick a channel and a state')
      this.send(muteMessage(parsed.data.channel, parsed.data.muted))
      return commandOk()
    }

    return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
  }

  private onMessage(raw: string): void {
    const ctx = this.ctx
    if (!ctx) return

    this.lastMessageAt = Date.now()
    const update = parseSscMessage(raw)
    if (!update) return // malformed datagram; the next one will be fine

    if (update.subscriptionExpired) {
      ctx.logger.debug('subscription expired; renewing')
      this.send(subscribeMessage(ctx.config.subscriptionLifetimeSeconds))
      return
    }

    for (const [channel, partial] of update.channels) {
      const existing = this.channels.get(channel) ?? blankChannel(channel)
      this.channels.set(channel, { ...existing, ...partial })
    }

    if (update.device) {
      this.device = { ...this.device, ...stripUndefined(update.device) }
      ctx.publish('device', this.device)
    }

    ctx.setStatus('online')
    if (this.channels.size > 0) {
      ctx.publish('channels', { channels: [...this.channels.values()] })
    }
  }

  private checkAlive(): void {
    const ctx = this.ctx
    if (!ctx) return

    const silentMs = Date.now() - this.lastMessageAt
    if (silentMs > ctx.config.timeoutSeconds * 1_000) {
      // UDP gives no connection to lose, so silence is the only signal that a
      // receiver has been switched off or unplugged.
      ctx.fail(new Error(`no SSC messages for ${Math.round(silentMs / 1000)}s`), 'Receiver silent')
    }
  }

  private send(payload: string): void {
    const ctx = this.ctx
    if (!ctx || !this.socket) return
    this.socket.send(payload, ctx.config.port, ctx.config.host, (error) => {
      if (error) ctx.logger.debug({ err: error }, 'SSC send failed')
    })
  }
}

function blankChannel(channel: string): ChannelReading {
  return {
    channel,
    name: null,
    rsqi: null,
    rfLevelDbm: null,
    afLevelDb: null,
    batteryPct: null,
    batteryRuntimeMin: null,
    muted: null,
    frequencyMhz: null,
    linked: false,
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

export const sennheiserModule: ConnectorModule<SennheiserConfig> = {
  meta: {
    typeId: 'sennheiser',
    displayName: 'Sennheiser wireless',
    description:
      'RF quality, transmitter battery and mute state per channel, straight from an EW-DX or ' +
      'Digital 6000 receiver. Built for problems-only viewing: in a rack of twelve, show the ' +
      'two packs that need a battery.',
    configSchema: sennheiserConfigSchema,
    streams: [
      {
        id: 'channels',
        label: 'Channels',
        rateClass: 'normal',
        history: 'metric',
        metricFields: [],
      },
      {
        id: 'device',
        label: 'Receiver',
        rateClass: 'change',
        fields: [
          { id: 'name', kind: 'string', label: 'Name' },
          { id: 'model', kind: 'string', label: 'Model' },
        ],
      },
    ],
    commands: [
      {
        id: 'identify',
        label: 'Identify',
        description: 'Flashes the channel on the receiver front panel.',
        inputSchema: identifyInput,
      },
      {
        id: 'mute',
        label: 'Mute channel',
        description: 'Mutes or unmutes a receiver channel.',
        inputSchema: muteInput,
        dangerous: true,
      },
    ],
    conditions: sennheiserConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'Talks SSC (JSON over UDP, port 45) directly to the receiver, so Wireless Systems ' +
      'Manager stays free for the RF techs. EW-DX firmware 4.0 and later defaults to SSCv2 ' +
      'over HTTPS — enable Legacy Mode on the receiver for this connector, or keep the ' +
      'receiver on 3.x. Digital 6000 (EM 6000) speaks SSC v1 natively. The dashboard must be ' +
      'on a subnet that can reach the receivers. Muting is off by default: muting a live ' +
      'vocal mic from a dashboard is not a mistake worth making easy.',
  },
  create: () => new SennheiserConnector(),
  createSimulator: () => new SennheiserSimulator(),
  // allowMute is deliberately not forced on here: it stays the admin's
  // decision even against a simulator, so demo mode reflects real behaviour.
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
