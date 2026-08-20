import { createServer, type Server } from 'node:http'
import type { SimulatorHandle } from '../core/types.js'

interface FakeDevice {
  id: string
  name: string
  model: string
  state: string
  cpu: number
  memory: number
  clients: number
}

/**
 * A fake UniFi controller.
 *
 * Plain HTTP rather than HTTPS: the connector's TLS handling is a
 * configuration concern (consoles ship self-signed certificates), while what
 * matters to test here is the API-key header, the endpoint shapes and the
 * two-call device/statistics pattern.
 */
export class UnifiSimulator implements SimulatorHandle {
  private server: Server | null = null
  private garbage = false
  private failing = false
  /** Set to reject the key, proving the connector reports auth clearly. */
  rejectKey = false

  devices: FakeDevice[] = [
    {
      id: 'ap1',
      name: 'Stage AP',
      model: 'U6-Pro',
      state: 'ONLINE',
      cpu: 12,
      memory: 44,
      clients: 18,
    },
    {
      id: 'ap2',
      name: 'Bar AP',
      model: 'U6-Lite',
      state: 'ONLINE',
      cpu: 8,
      memory: 39,
      clients: 7,
    },
    {
      id: 'sw1',
      name: 'Stage switch',
      model: 'USW-24-PoE',
      state: 'OFFLINE',
      cpu: 0,
      memory: 0,
      clients: 0,
    },
  ]

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((request, response) => {
      if (this.failing) {
        response.destroy()
        return
      }
      if (this.rejectKey || request.headers['x-api-key'] !== 'test-key') {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key"}')
        return
      }
      if (this.garbage) {
        this.garbage = false
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":')
        return
      }

      const url = request.url ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })

      if (url.includes('/statistics/latest')) {
        const id = /devices\/([^/]+)\/statistics/.exec(url)?.[1]
        const device = this.devices.find((entry) => entry.id === id)
        response.end(
          JSON.stringify({
            cpuUtilizationPct: device?.cpu ?? 0,
            memoryUtilizationPct: device?.memory ?? 0,
            uptimeSec: 86_400,
            clientCount: device?.clients ?? 0,
          }),
        )
        return
      }

      if (url.includes('/clients')) {
        const total = this.devices.reduce((sum, device) => sum + device.clients, 0)
        response.end(
          JSON.stringify({
            data: Array.from({ length: total }, (_, index) => ({
              id: `c${index}`,
              type: index % 5 === 0 ? 'WIRED' : 'WIRELESS',
            })),
          }),
        )
        return
      }

      if (url.includes('/devices')) {
        response.end(
          JSON.stringify({
            data: this.devices.map((device) => ({
              id: device.id,
              name: device.name,
              model: device.model,
              state: device.state,
              ipAddress: '10.0.0.2',
              uptimeSec: 86_400,
            })),
          }),
        )
        return
      }

      // Site list.
      response.end(JSON.stringify({ data: [{ id: 'default', name: 'Festival' }] }))
    })

    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve))
    const address = this.server?.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    return { host, port: address.port }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  dropConnections(): void {
    this.server?.closeAllConnections?.()
  }

  sendGarbage(): void {
    this.garbage = true
  }

  setFailing(failing: boolean): void {
    this.failing = failing
  }
}
