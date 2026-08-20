import { createHash } from 'node:crypto'
// ssh2 is CommonJS. A named import type-checks and passes under Vitest's
// interop, then fails at runtime in the bundled ESM server — so take the
// default export and destructure it.
import type { ClientChannel, Client as SshClient } from 'ssh2'
import ssh2 from 'ssh2'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { sysmonConditions } from './conditions.js'
import { MAC_INFO_COMMAND, MAC_POLL_COMMAND, parseMacInfo, parseMacMetrics } from './protocol.js'
import { SysmonSimulator } from './simulator.js'

const { Client } = ssh2

export const sysmonConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default('monitor'),
  password: z.string().optional(),
  /** PEM private key, as an alternative to a password. */
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  /**
   * Only macOS for now. The Linux and Windows command sets are known and
   * documented, but Macs are what festival production actually runs on, and a
   * half-tested Windows path is worse than an honest gap.
   */
  os: z.literal('mac').default('mac'),
  pollIntervalSeconds: z.number().int().min(3).max(600).default(10),
  /**
   * Pinned on first connect. If it ever changes, the machine was re-imaged or
   * something is impersonating it — either way a human should look before we
   * keep sending credentials.
   */
  hostFingerprint: z.string().optional(),
})

export type SysmonConfig = z.infer<typeof sysmonConfigSchema>

/** Detects a sleeping or rebooting Mac within ~15s rather than hanging. */
const KEEPALIVE_MS = 5_000
const KEEPALIVE_COUNT_MAX = 2
const EXEC_TIMEOUT_MS = 20_000

/**
 * Show-machine health, over SSH, with nothing installed on the machine.
 *
 * Enabling Remote Login is the entire setup: no agent to deploy, update, or
 * explain to a venue's IT, and nothing extra running on a Mac that is busy
 * playing back a show.
 */
class SysmonConnector implements Connector<SysmonConfig> {
  private ctx: ConnectorContext<SysmonConfig> | null = null
  private client: SshClient | null = null
  private cancelPoll: (() => void) | null = null
  private polling = false
  private infoSent = false

  async start(ctx: ConnectorContext<SysmonConfig>): Promise<void> {
    this.ctx = ctx
    await this.connect(ctx)
  }

  stop(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
    this.client?.end()
    this.client = null
    this.ctx = null
    this.infoSent = false
  }

  private connect(ctx: ConnectorContext<SysmonConfig>): Promise<void> {
    return new Promise((resolve) => {
      const client = new Client()
      this.client = client

      client
        .on('ready', () => {
          ctx.setStatus('online')
          // One connection, one exec per tick: channel setup is cheap, a
          // fresh handshake every ten seconds is not.
          this.cancelPoll = ctx.setInterval(
            () => void this.poll(),
            ctx.config.pollIntervalSeconds * 1_000,
          )
          void this.readInfo().then(() => this.poll())
          resolve()
        })
        .on('error', (error: Error & { level?: string }) => {
          // Auth failures are worth distinguishing: retrying a wrong password
          // every ten seconds can lock an account out.
          const detail =
            error.level === 'client-authentication'
              ? 'Authentication failed — check the username and password'
              : error.message
          ctx.fail(error, detail)
          resolve()
        })
        .on('close', () => {
          if (!ctx.signal.aborted) ctx.fail(new Error('connection closed'), 'Host went away')
        })

      client.connect({
        host: ctx.config.host,
        port: ctx.config.port,
        username: ctx.config.username,
        password: ctx.config.password,
        privateKey: ctx.config.privateKey,
        passphrase: ctx.config.passphrase,
        readyTimeout: 15_000,
        keepaliveInterval: KEEPALIVE_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        // Trust on first use: record the fingerprint, then refuse if it ever
        // changes underneath us.
        hostHash: 'sha256',
        hostVerifier: (hash: string) => {
          const expected = ctx.config.hostFingerprint
          if (!expected) {
            ctx.publish('host', { fingerprint: hash, trustedAt: Date.now() })
            return true
          }
          if (expected === hash) return true

          ctx.logger.error(
            { expected, actual: hash },
            'host key changed; refusing to send credentials',
          )
          return false
        },
      })
    })
  }

  private async readInfo(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.infoSent) return

    try {
      const output = await this.run(MAC_INFO_COMMAND)
      ctx.publish('info', parseMacInfo(output))
      this.infoSent = true
    } catch (error) {
      ctx.logger.debug({ err: error }, 'could not read host info')
    }
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted || this.polling) return
    this.polling = true

    try {
      const output = await this.run(MAC_POLL_COMMAND)
      if (ctx.signal.aborted) return

      const metrics = parseMacMetrics(output)
      if (metrics.cpuPct === null && metrics.memTotalBytes === null) {
        // Answered, but with nothing we recognise: usually the wrong OS
        // behind the address, which is worth saying out loud.
        ctx.setStatus('degraded', 'Unexpected response — is this a Mac?')
        return
      }

      ctx.setStatus('online')
      ctx.publish('metrics', metrics)
    } catch (error) {
      ctx.fail(error, 'Poll failed')
    } finally {
      this.polling = false
    }
  }

  /** Runs one command over the open connection. */
  private run(command: string): Promise<string> {
    const client = this.client
    if (!client) return Promise.reject(new Error('not connected'))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('command timed out')), EXEC_TIMEOUT_MS)

      client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
        if (error) {
          clearTimeout(timer)
          reject(error)
          return
        }

        let output = ''
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        // stderr is drained but ignored: `memory_pressure` chatters on some
        // machines and it is not an error.
        stream.stderr?.resume()
        stream.on('close', () => {
          clearTimeout(timer)
          resolve(output)
        })
      })
    })
  }
}

export const sysmonModule: ConnectorModule<SysmonConfig> = {
  meta: {
    typeId: 'sysmon',
    displayName: 'Computer (Mac)',
    description:
      'CPU, memory, disk, uptime and battery from a show Mac over SSH, with nothing installed ' +
      'on the machine. Catches the quiet failures: a playback Mac unplugged during ' +
      'changeover, or a record drive filling up mid-set.',
    configSchema: sysmonConfigSchema,
    streams: [
      {
        id: 'metrics',
        label: 'System metrics',
        rateClass: 'normal',
        history: 'metric',
        metricFields: ['cpuPct', 'memUsedPct', 'diskFreeBytes', 'batteryPct'],
        fields: [
          { id: 'cpuPct', kind: 'number', label: 'CPU', unit: '%' },
          { id: 'memUsedPct', kind: 'number', label: 'Memory used', unit: '%' },
          { id: 'diskFreeBytes', kind: 'number', label: 'Disk free', unit: 'bytes' },
          { id: 'batteryPct', kind: 'number', label: 'Battery', unit: '%' },
          { id: 'loadAvg1', kind: 'number', label: 'Load average' },
          { id: 'memUsedBytes', kind: 'number', label: 'Memory used', unit: 'bytes' },
          { id: 'memTotalBytes', kind: 'number', label: 'Memory total', unit: 'bytes' },
          { id: 'diskTotalBytes', kind: 'number', label: 'Disk total', unit: 'bytes' },
          { id: 'diskUsedPct', kind: 'number', label: 'Disk used', unit: '%' },
          { id: 'uptimeSeconds', kind: 'number', label: 'Uptime', unit: 's' },
          { id: 'memPressure', kind: 'string', label: 'Memory pressure' },
          { id: 'batteryState', kind: 'string', label: 'Battery state' },
          { id: 'onBattery', kind: 'boolean', label: 'On battery' },
        ],
      },
      {
        id: 'info',
        label: 'Machine',
        rateClass: 'change',
        fields: [
          { id: 'hostname', kind: 'string', label: 'Hostname' },
          { id: 'osName', kind: 'string', label: 'Operating system' },
          { id: 'osVersion', kind: 'string', label: 'Version' },
        ],
      },
      {
        id: 'host',
        label: 'Host key',
        rateClass: 'change',
        fields: [
          { id: 'trustedAt', kind: 'number', label: 'Trusted at' },
          { id: 'fingerprint', kind: 'string', label: 'Host key fingerprint' },
        ],
      },
    ],
    commands: [],
    conditions: sysmonConditions,
    capabilities: { control: false },
    tier: 'official',
    vendorNotes:
      'On the Mac: System Settings → General → Sharing → Remote Login. Create a dedicated ' +
      'standard user (not an admin) for monitoring and allow only that account. Every command ' +
      'this connector runs works as a non-admin without a TTY. The host key is pinned on ' +
      'first connect; if the machine is re-imaged, clear the stored fingerprint in the config ' +
      'to trust the new one. Reading CPU costs about two seconds per poll because macOS only ' +
      'reports a true figure across two samples. Linux and Windows are not supported yet.',
  },
  create: () => new SysmonConnector(),
  createSimulator: () => new SysmonSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    host: address.host,
    port: address.port,
    username: 'monitor',
    password: 'simulated',
    // The simulator generates a fresh host key each run, so pinning would
    // fail every time.
    hostFingerprint: undefined,
  }),
}

/** Exposed for the admin UI, which shows the fingerprint a user is trusting. */
export function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64')
}
