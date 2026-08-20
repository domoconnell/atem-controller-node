import { createServer, type Server, type Socket } from 'node:net'
import type { SimulatorHandle } from '../core/types.js'
import { LineSplitter } from './protocol.js'

export interface DemoSimulatorOptions {
  /** Milliseconds between meter frames. */
  meterIntervalMs?: number
  initialState?: string
  deviceName?: string
}

/**
 * A fake device speaking the demo protocol. Tests drive it to reproduce the
 * things that actually happen at a festival: a device that vanishes when
 * someone unplugs a switch, and one that emits malformed frames.
 */
export class DemoSimulator implements SimulatorHandle {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private timer: ReturnType<typeof setInterval> | null = null

  private state: string
  private stateSince = Date.now()
  private tick = 0

  constructor(private readonly options: DemoSimulatorOptions = {}) {
    this.state = options.initialState ?? 'idle'
  }

  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      this.server = server

      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('simulator failed to bind'))
          return
        }
        this.startMeters()
        resolve({ host: address.address, port: address.port })
      })
    })
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null

    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Simulates the switch being unplugged: connections die, server stays up. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Simulates a firmware quirk emitting frames the parser has never seen. */
  sendGarbage(): void {
    for (const socket of this.sockets) {
      socket.write('{"type":"meter",,,broken\n')
      socket.write('not json at all\n')
      socket.write('{"type":"unknown-frame","surprise":true}\n')
    }
  }

  setState(state: string): void {
    this.state = state
    this.stateSince = Date.now()
    this.broadcastState()
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))

    const splitter = new LineSplitter()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.handleCommand(socket, line)
    })

    this.send(socket, {
      type: 'hello',
      device: this.options.deviceName ?? 'Demo Device',
      version: '1.0',
    })
    this.send(socket, { type: 'state', state: this.state, elapsed: this.elapsed() })
  }

  private handleCommand(socket: Socket, line: string): void {
    let frame: { type?: string; id?: string; cmd?: string; args?: Record<string, unknown> }
    try {
      frame = JSON.parse(line)
    } catch {
      this.send(socket, { type: 'ack', id: 'unknown', ok: false, error: 'malformed command' })
      return
    }

    if (frame.type !== 'cmd' || typeof frame.id !== 'string') return

    if (frame.cmd === 'setState') {
      const next = frame.args?.state
      if (typeof next !== 'string' || next.length === 0) {
        this.send(socket, { type: 'ack', id: frame.id, ok: false, error: 'state required' })
        return
      }
      this.setState(next)
      this.send(socket, { type: 'ack', id: frame.id, ok: true })
      return
    }

    this.send(socket, {
      type: 'ack',
      id: frame.id,
      ok: false,
      error: `unknown command ${frame.cmd}`,
    })
  }

  private startMeters(): void {
    const interval = this.options.meterIntervalMs ?? 50
    this.timer = setInterval(() => {
      this.tick += 1
      /*
       * A slow drift plus jitter, which is what a room actually does.
       *
       * This used to be `85 + sin(tick / 10) * 8`, and at a 50ms tick that is
       * a swing of eighteen decibels every three seconds — no room on earth,
       * and it straddled the demo's own 80dB condition, so the problems board
       * gained and lost a row twice a cycle and the list jumped under whoever
       * was reading it. The comment claimed it looked like a real meter; it
       * looked like a siren.
       *
       * Two minutes for a full cycle, a few decibels of movement, and clear of
       * the threshold: the meter still visibly lives, and what the board says
       * about it stays still.
       */
      const value = 92 + Math.sin(this.tick / 400) * 3 + Math.random() * 0.8
      const frame = {
        type: 'meter' as const,
        value: Math.round(value * 10) / 10,
        peak: Math.round((value + 3) * 10) / 10,
      }
      for (const socket of this.sockets) this.send(socket, frame)
    }, interval)
    this.timer.unref()
  }

  private broadcastState(): void {
    for (const socket of this.sockets) {
      this.send(socket, { type: 'state', state: this.state, elapsed: this.elapsed() })
    }
  }

  private elapsed(): number {
    return Math.round((Date.now() - this.stateSince) / 1000)
  }

  private send(socket: Socket, frame: unknown): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(frame)}\n`)
  }
}
