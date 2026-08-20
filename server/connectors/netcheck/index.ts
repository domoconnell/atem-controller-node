import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { netcheckConditions } from './conditions.js'
import { httpProbe, icmpPing, type LatencyResult, measureThroughput, tcpProbe } from './protocol.js'
import { NetcheckSimulator } from './simulator.js'

export const netcheckConfigSchema = z.object({
  host: z.string().min(1).default('1.1.1.1'),
  /**
   * ICMP first, falling back to a TCP connect when it is unavailable — either
   * because the container has no raw-socket capability or because the target
   * drops pings, which most managed switches do.
   */
  method: z.enum(['auto', 'icmp', 'tcp', 'http']).default('auto'),
  /** For tcp/auto-fallback probing, and ignored otherwise. */
  tcpPort: z.number().int().min(1).max(65535).default(443),
  httpUrl: z.string().optional(),
  probes: z.number().int().min(1).max(20).default(5),
  probeIntervalMs: z.number().int().min(50).max(5_000).default(200),
  timeoutMs: z.number().int().min(100).max(30_000).default(2_000),
  pollIntervalSeconds: z.number().int().min(5).max(3_600).default(30),

  /** Throughput testing is off by default: it is not free on a live network. */
  speedTestEnabled: z.boolean().default(false),
  speedTestUrl: z.string().optional(),
  speedTestUploadUrl: z.string().optional(),
  speedTestStreams: z.number().int().min(1).max(8).default(4),
  speedTestSeconds: z.number().int().min(2).max(30).default(8),
  /** 0 disables the schedule; the manual command still works. */
  speedTestIntervalMinutes: z.number().int().min(0).max(1_440).default(0),
})

export type NetcheckConfig = z.infer<typeof netcheckConfigSchema>

const runSpeedTestInput = z.object({}).default({})

/**
 * Is that thing still there, and how well?
 *
 * Answers the question crew actually ask over comms — "have we lost the
 * internet, or is it just Spotify?" — and does it from the server so every
 * screen agrees.
 */
class NetcheckConnector implements Connector<NetcheckConfig> {
  private ctx: ConnectorContext<NetcheckConfig> | null = null
  private cancelCheck: (() => void) | null = null
  private cancelSpeed: (() => void) | null = null
  private checking = false
  private speedRunning = false
  /** Sticky once ICMP has proven unavailable, so we stop paying to find out. */
  private icmpUnavailable = false

  async start(ctx: ConnectorContext<NetcheckConfig>): Promise<void> {
    this.ctx = ctx

    this.cancelCheck = ctx.setInterval(
      () => void this.check(),
      ctx.config.pollIntervalSeconds * 1_000,
    )

    if (ctx.config.speedTestEnabled && ctx.config.speedTestIntervalMinutes > 0) {
      this.cancelSpeed = ctx.setInterval(
        () => void this.speedTest(),
        ctx.config.speedTestIntervalMinutes * 60_000,
      )
    }

    await this.check()
  }

  stop(): void {
    this.cancelCheck?.()
    this.cancelSpeed?.()
    this.cancelCheck = null
    this.cancelSpeed = null
    this.ctx = null
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not running')
    if (commandId !== 'speedtest.run') {
      return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
    }
    if (!runSpeedTestInput.safeParse(input).success) {
      return commandFail('INVALID_INPUT', 'This command takes no arguments')
    }
    if (!ctx.config.speedTestEnabled) {
      return commandFail('NOT_ALLOWED', 'Speed testing is disabled for this check')
    }
    if (this.speedRunning) return commandFail('NOT_ALLOWED', 'A speed test is already running')

    const result = await this.speedTest()
    return result ? commandOk(result) : commandFail('DEVICE_ERROR', 'Speed test failed')
  }

  private async check(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted || this.checking) return
    this.checking = true

    try {
      const result = await this.probe(ctx)
      if (ctx.signal.aborted) return

      ctx.publish('latency', result)
      ctx.publish('status', {
        up: result.up,
        method: result.method,
        host: ctx.config.host,
        checkedAt: Date.now(),
      })

      // A target that is down is a fact this module is reporting correctly,
      // not a fault in the module: staying online is what lets the condition
      // and its alert do their job.
      ctx.setStatus(result.up ? 'online' : 'degraded', result.up ? undefined : 'Target unreachable')
    } catch (error) {
      ctx.logger.debug({ err: error }, 'check failed')
      ctx.setStatus('degraded', 'Check failed')
    } finally {
      this.checking = false
    }
  }

  private async probe(ctx: ConnectorContext<NetcheckConfig>): Promise<LatencyResult> {
    const { config } = ctx

    if (config.method === 'http') {
      const url = config.httpUrl ?? `http://${config.host}`
      const result = await httpProbe(url, config.timeoutMs, ctx.signal)
      return {
        method: 'tcp',
        up: result.up,
        rttMinMs: result.responseMs,
        rttAvgMs: result.responseMs,
        rttMaxMs: result.responseMs,
        lossPct: result.up ? 0 : 100,
        jitterMs: null,
        probes: 1,
      }
    }

    if (config.method !== 'tcp' && !this.icmpUnavailable) {
      const icmp = await icmpPing({
        host: config.host,
        probes: config.probes,
        intervalMs: config.probeIntervalMs,
        timeoutMs: config.timeoutMs,
        signal: ctx.signal,
      })
      if (icmp) return icmp

      if (config.method === 'icmp') {
        // Explicitly asked for ICMP and it is not available: say so rather
        // than silently reporting a different measurement.
        throw new Error('fping is unavailable — install it or grant CAP_NET_RAW')
      }

      this.icmpUnavailable = true
      ctx.logger.info('ICMP unavailable; falling back to TCP connect timing')
    }

    return tcpProbe({
      host: config.host,
      port: config.tcpPort,
      probes: config.probes,
      timeoutMs: config.timeoutMs,
      signal: ctx.signal,
    })
  }

  private async speedTest(): Promise<{ downMbps: number | null; upMbps: number | null } | null> {
    const ctx = this.ctx
    if (!ctx || this.speedRunning) return null
    this.speedRunning = true

    try {
      const downloadUrl =
        ctx.config.speedTestUrl ?? 'https://speed.cloudflare.com/__down?bytes=26214400'
      const uploadUrl = ctx.config.speedTestUploadUrl

      const result = await measureThroughput({
        downloadUrl,
        uploadUrl,
        streams: ctx.config.speedTestStreams,
        durationMs: ctx.config.speedTestSeconds * 1_000,
        signal: ctx.signal,
      })

      ctx.publish('speed', result)
      return { downMbps: result.downMbps, upMbps: result.upMbps }
    } catch (error) {
      ctx.logger.warn({ err: error }, 'speed test failed')
      return null
    } finally {
      this.speedRunning = false
    }
  }
}

export const netcheckModule: ConnectorModule<NetcheckConfig> = {
  meta: {
    typeId: 'netcheck',
    displayName: 'Connection check',
    description:
      'Watches whether a host is reachable and how well: round-trip time, packet loss and ' +
      'jitter, plus an optional throughput test. Answers "have we lost the internet, or is ' +
      'it just that one device?" from the server, so every screen agrees.',
    configSchema: netcheckConfigSchema,
    streams: [
      {
        id: 'latency',
        label: 'Latency',
        rateClass: 'normal',
        history: 'metric',
        metricFields: ['rttAvgMs', 'lossPct', 'jitterMs'],
        fields: [
          { id: 'rttAvgMs', kind: 'number', label: 'Round trip (avg)', unit: 'ms' },
          { id: 'rttMinMs', kind: 'number', label: 'Round trip (min)', unit: 'ms' },
          { id: 'rttMaxMs', kind: 'number', label: 'Round trip (max)', unit: 'ms' },
          { id: 'lossPct', kind: 'number', label: 'Packet loss', unit: '%' },
          { id: 'jitterMs', kind: 'number', label: 'Jitter', unit: 'ms' },
          { id: 'probes', kind: 'number', label: 'Probes' },
          { id: 'method', kind: 'string', label: 'Method' },
          { id: 'up', kind: 'boolean', label: 'Reachable' },
        ],
      },
      {
        id: 'status',
        label: 'Reachability',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'checkedAt', kind: 'number', label: 'Checked at' },
          { id: 'host', kind: 'string', label: 'Host' },
          { id: 'method', kind: 'string', label: 'Method' },
          { id: 'up', kind: 'boolean', label: 'Reachable' },
        ],
      },
      {
        id: 'speed',
        label: 'Throughput',
        rateClass: 'slow',
        history: 'metric',
        metricFields: ['downMbps', 'upMbps'],
        // No `fields` here on purpose. The speed test is off unless someone
        // turns it on, and it measures itself against a host on the internet,
        // so the simulator cannot produce a frame and nothing can check a
        // declaration against reality. An unverifiable declaration is worse
        // than none: it is the drift this contract exists to prevent.
      },
    ],
    commands: [
      {
        id: 'speedtest.run',
        label: 'Run speed test',
        description: 'Measures throughput now. Uses real bandwidth, so not during a set.',
        inputSchema: runSpeedTestInput,
      },
    ],
    conditions: netcheckConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'ICMP needs the fping binary and permission to open a raw socket. The container ships ' +
      'fping; under host networking it works as root, and a hardened deployment needs ' +
      'cap_add: [NET_RAW] or the net.ipv4.ping_group_range sysctl on the host. Where ICMP is ' +
      'unavailable — or the target drops pings, as most managed switches do — the check ' +
      'falls back to TCP connect timing and says so in the stream. The default internet ' +
      'speed test uses speed.cloudflare.com, which is not a contractual API; for LAN tests ' +
      'point it at a LibreSpeed container on the target machine.',
  },
  create: () => new NetcheckConnector(),
  createSimulator: () => new NetcheckSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    host: address.host,
    // TCP against the simulator's own listener: deterministic, and it needs no
    // privileges in CI.
    method: 'tcp' as const,
    tcpPort: address.port,
    speedTestEnabled: true,
    speedTestUrl: `http://${address.host}:${address.port}/download`,
    speedTestUploadUrl: `http://${address.host}:${address.port}/upload`,
    speedTestSeconds: 2,
  }),
}
