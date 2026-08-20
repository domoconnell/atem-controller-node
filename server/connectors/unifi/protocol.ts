/**
 * UniFi Network local Integration API.
 *
 * The official one: an API key in `X-API-KEY`, stateless JSON, no cookie
 * juggling or CSRF token scraping. Requires Network application 9.0.108 or
 * later on UniFi OS 4.1.9 or later — earlier controllers only have the legacy
 * login-and-cookie API, which this deliberately does not implement.
 */

export interface UnifiDevice {
  id: string
  name: string
  model: string | null
  /** 'ONLINE', 'OFFLINE', 'ADOPTING'… as the controller words it. */
  state: string
  online: boolean
  ipAddress: string | null
  uptimeSeconds: number | null
  cpuPct: number | null
  memoryPct: number | null
  clientCount: number | null
  /** Watts drawn over PoE, where the device reports it. */
  poeWatts: number | null
}

export interface UnifiSummary {
  siteName: string
  deviceCount: number
  onlineCount: number
  clientCount: number
  wirelessClientCount: number
}

export function parseDevices(body: unknown): UnifiDevice[] {
  const data = asArray(asRecord(body).data)

  return data.map((entry) => {
    const device = asRecord(entry)
    const state = str(device.state) ?? 'UNKNOWN'

    return {
      id: str(device.id) ?? str(device.macAddress) ?? 'unknown',
      name: str(device.name) ?? str(device.model) ?? 'Unnamed device',
      model: str(device.model),
      state,
      online: state.toUpperCase() === 'ONLINE',
      ipAddress: str(device.ipAddress),
      uptimeSeconds: num(device.uptimeSec) ?? num(device.uptime),
      cpuPct: null,
      memoryPct: null,
      clientCount: null,
      poeWatts: null,
    }
  })
}

/**
 * Folds `/statistics/latest` onto a device.
 *
 * The list endpoint gives identity and state; load figures come from a
 * separate call, which is why they start null rather than zero — an unknown
 * CPU and an idle CPU are different claims.
 */
export function mergeStatistics(device: UnifiDevice, body: unknown): UnifiDevice {
  const root = asRecord(body)
  const stats = Object.keys(root).length > 0 ? root : asRecord(asRecord(body).data)

  const uplink = asRecord(stats.uplink)
  return {
    ...device,
    cpuPct: num(stats.cpuUtilizationPct) ?? num(asRecord(stats.system).cpuUtilizationPct),
    memoryPct: num(stats.memoryUtilizationPct) ?? num(asRecord(stats.system).memoryUtilizationPct),
    uptimeSeconds: num(stats.uptimeSec) ?? device.uptimeSeconds,
    clientCount: num(stats.clientCount) ?? device.clientCount,
    poeWatts: num(uplink.txRateBps) === null ? num(stats.poePowerW) : num(stats.poePowerW),
  }
}

export function parseClients(body: unknown): { total: number; wireless: number } {
  const data = asArray(asRecord(body).data)
  let wireless = 0

  for (const entry of data) {
    const client = asRecord(entry)
    // The API words this variously across versions; treat anything that is
    // not explicitly wired as wireless, which is the safer read for a venue.
    const type = (str(client.type) ?? '').toUpperCase()
    if (type !== 'WIRED') wireless++
  }

  return { total: data.length, wireless }
}

export function parseSites(body: unknown): { id: string; name: string }[] {
  return asArray(asRecord(body).data).map((entry) => {
    const site = asRecord(entry)
    return {
      id: str(site.id) ?? 'default',
      name: str(site.name) ?? str(site.internalReference) ?? 'Site',
    }
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
