import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { unifiConditions } from './conditions.js'
import {
  mergeStatistics,
  parseClients,
  parseDevices,
  parseSites,
  type UnifiDevice,
} from './protocol.js'
import { UnifiSimulator } from './simulator.js'

export const unifiConfigSchema = z.object({
  /** Console or self-hosted server address. */
  baseUrl: z.string().min(1).default('https://192.168.1.1'),
  apiKey: z.string().default(''),
  /** Blank uses the first site the controller reports, which is the usual one. */
  siteId: z.string().optional(),
  pollIntervalSeconds: z.number().int().min(5).max(600).default(30),
  /**
   * UniFi consoles ship a self-signed certificate. Accepting it is the normal
   * case on a closed show network; the alternative is asking crew to install
   * a CA at load-in.
   */
  allowSelfSignedCert: z.boolean().default(true),
  /** Per-device load figures cost one call each; skip on a very large site. */
  includeStatistics: z.boolean().default(true),
})

export type UnifiConfig = z.infer<typeof unifiConfigSchema>

const REQUEST_TIMEOUT_MS = 10_000
/** Beyond this, the per-device statistics calls cost more than they are worth. */
const STATISTICS_DEVICE_LIMIT = 40

/**
 * UniFi network health, read-only.
 *
 * Answers the two questions asked when the Wi-Fi "stops working": is every AP
 * still up, and is one of them carrying the whole site?
 */
class UnifiConnector implements Connector<UnifiConfig> {
  private ctx: ConnectorContext<UnifiConfig> | null = null
  private cancelPoll: (() => void) | null = null
  private polling = false
  private siteId: string | null = null

  async start(ctx: ConnectorContext<UnifiConfig>): Promise<void> {
    this.ctx = ctx
    this.cancelPoll = ctx.setInterval(
      () => void this.poll(),
      ctx.config.pollIntervalSeconds * 1_000,
    )
    await this.poll()
  }

  stop(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
    this.ctx = null
    this.siteId = null
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted || this.polling) return
    this.polling = true

    try {
      const siteId = await this.resolveSite(ctx)
      const devices = parseDevices(await this.get(ctx, `/sites/${siteId}/devices`))

      const detailed = ctx.config.includeStatistics
        ? await this.withStatistics(ctx, siteId, devices)
        : devices

      const clients = parseClients(await this.get(ctx, `/sites/${siteId}/clients`))
      if (ctx.signal.aborted) return

      ctx.setStatus('online')
      ctx.publish('devices', { devices: detailed })
      ctx.publish('summary', {
        siteName: siteId,
        deviceCount: detailed.length,
        onlineCount: detailed.filter((device) => device.online).length,
        clientCount: clients.total,
        wirelessClientCount: clients.wireless,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') || message.includes('403')) {
        // A bad key will never fix itself, and retrying quietly for an hour
        // helps nobody: say what is wrong.
        ctx.setStatus('degraded', 'Controller rejected the API key')
      } else {
        ctx.fail(error, 'Controller unreachable')
      }
    } finally {
      this.polling = false
    }
  }

  private async resolveSite(ctx: ConnectorContext<UnifiConfig>): Promise<string> {
    if (ctx.config.siteId) return ctx.config.siteId
    if (this.siteId) return this.siteId

    const sites = parseSites(await this.get(ctx, '/sites'))
    const first = sites[0]
    if (!first) throw new Error('controller reported no sites')

    this.siteId = first.id
    return first.id
  }

  private async withStatistics(
    ctx: ConnectorContext<UnifiConfig>,
    siteId: string,
    devices: UnifiDevice[],
  ): Promise<UnifiDevice[]> {
    const results: UnifiDevice[] = []

    for (const device of devices.slice(0, STATISTICS_DEVICE_LIMIT)) {
      // Offline devices have no current statistics to report.
      if (!device.online) {
        results.push(device)
        continue
      }

      try {
        const body = await this.get(ctx, `/sites/${siteId}/devices/${device.id}/statistics/latest`)
        results.push(mergeStatistics(device, body))
      } catch {
        // One device failing to report should not lose the whole site view.
        results.push(device)
      }
    }

    results.push(...devices.slice(STATISTICS_DEVICE_LIMIT))
    return results
  }

  private async get(ctx: ConnectorContext<UnifiConfig>, path: string): Promise<unknown> {
    const base = ctx.config.baseUrl.replace(/\/$/, '')
    const url = `${base}/proxy/network/integration/v1${path}`

    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(() => controller.abort(new Error('timed out')), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'x-api-key': ctx.config.apiKey, accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`controller returned ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(deadline)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}

export const unifiModule: ConnectorModule<UnifiConfig> = {
  meta: {
    typeId: 'unifi',
    displayName: 'UniFi network',
    description:
      'Access point and switch health from a UniFi controller: what is online, how loaded it ' +
      'is, and where the clients are. Read-only — this dashboard watches the show network, it ' +
      'does not reconfigure it mid-set.',
    configSchema: unifiConfigSchema,
    streams: [
      { id: 'devices', label: 'Devices', rateClass: 'slow' },
      {
        id: 'summary',
        label: 'Site summary',
        rateClass: 'slow',
        history: 'metric',
        metricFields: ['onlineCount', 'clientCount', 'wirelessClientCount'],
        fields: [
          { id: 'onlineCount', kind: 'number', label: 'Devices online' },
          { id: 'deviceCount', kind: 'number', label: 'Devices' },
          { id: 'clientCount', kind: 'number', label: 'Clients' },
          { id: 'wirelessClientCount', kind: 'number', label: 'Wireless clients' },
          { id: 'siteName', kind: 'string', label: 'Site' },
        ],
      },
    ],
    commands: [],
    conditions: unifiConditions,
    capabilities: { control: false },
    tier: 'official',
    vendorNotes:
      'Uses the official local Integration API, which needs UniFi Network 9.0.108 or later on ' +
      'UniFi OS 4.1.9 or later. Create the key in Settings → Control Plane → Integrations and ' +
      'paste it here. Older controllers only expose the legacy cookie-based API, which this ' +
      'connector does not use. Consoles present a self-signed certificate; accepting it is on ' +
      'by default because a closed show network is the normal deployment. Read-only by design.',
  },
  create: () => new UnifiConnector(),
  createSimulator: () => new UnifiSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    baseUrl: `http://${address.host}:${address.port}`,
    apiKey: 'test-key',
    siteId: 'default',
  }),
}
