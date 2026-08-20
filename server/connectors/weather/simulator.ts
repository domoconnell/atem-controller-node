import { createServer, type Server } from 'node:http'
import type { SimulatorHandle } from '../core/types.js'

/**
 * A fake met.no.
 *
 * Weather is the one connector whose real source is on the internet, which a
 * venue may not have — so the simulator is what demo mode and pre-show
 * rehearsal actually run against, not just the tests.
 */
export class WeatherSimulator implements SimulatorHandle {
  private server: Server | null = null
  private garbage = false
  private failing = false

  /** Nudged by tests to prove the wind and rain conditions fire. */
  windMs = 4
  gustMs = 7
  temperatureC = 16
  rainMm = 0

  /** Where the connector last asked about, so a test can check it asked right. */
  lastQuery: { lat: string | null; lon: string | null } = { lat: null, lon: null }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((request, response) => {
      const asked = new URL(request.url ?? '/', 'http://simulator')
      this.lastQuery = {
        lat: asked.searchParams.get('lat'),
        lon: asked.searchParams.get('lon'),
      }

      if (this.failing) {
        response.writeHead(503).end('service unavailable')
        return
      }
      if (this.garbage) {
        this.garbage = false
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"properties":')
        return
      }

      // The real API rejects a request that does not identify itself, and a
      // connector that forgets the User-Agent should fail here too.
      if (!request.headers['user-agent']) {
        response.writeHead(403).end('identify yourself')
        return
      }

      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.body()))
    })

    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve))
    const address = this.server.address()
    if (typeof address === 'string' || address === null) throw new Error('no address')
    return { host, port: address.port }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
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

  private body(): unknown {
    const start = Date.now()
    const timeseries = []

    // Three days of hourly entries: enough for the daily aggregation to have
    // something real to fold.
    for (let hour = 0; hour < 72; hour++) {
      const at = new Date(start + hour * 3_600_000)
      timeseries.push({
        time: at.toISOString(),
        data: {
          instant: {
            details: {
              air_temperature: this.temperatureC + Math.sin(hour / 4) * 3,
              relative_humidity: 62,
              wind_speed: this.windMs,
              wind_speed_of_gust: this.gustMs,
              wind_from_direction: 210,
            },
          },
          next_1_hours: {
            summary: { symbol_code: this.rainMm > 0 ? 'rain' : 'partlycloudy_day' },
            details: { precipitation_amount: this.rainMm },
          },
        },
      })
    }

    return { properties: { timeseries } }
  }
}
