import { createServer, type Server } from 'node:http'
import type { SimulatorHandle } from '../core/types.js'

/**
 * A target to check.
 *
 * Doubles as the HTTP endpoint and, because it listens on TCP, as the target
 * for the connect-time probe — so one fake exercises both paths the connector
 * actually uses on a show network.
 */
export class NetcheckSimulator implements SimulatorHandle {
  private server: Server | null = null

  /** Scripted degradation, so the conditions have something to fire on. */
  latencyMs = 0
  failing = false
  garbage = false

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer(async (request, response) => {
      if (this.failing) {
        response.destroy()
        return
      }
      if (this.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
      }

      if (request.url?.startsWith('/download')) {
        // A fixed payload is enough: the engine measures bytes over time, and
        // a loopback socket will always look absurdly fast. The point is that
        // the plumbing works, not that the number is meaningful.
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(Buffer.alloc(512 * 1024, 1))
        return
      }
      if (request.method === 'POST') {
        request.resume()
        request.on('end', () => response.writeHead(200).end('ok'))
        return
      }

      if (this.garbage) {
        this.garbage = false
        response.writeHead(500).end('kaboom')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })

    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve))
    const address = this.server.address()
    if (typeof address === 'string' || address === null) throw new Error('no address')
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
