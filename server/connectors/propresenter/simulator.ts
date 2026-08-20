import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { SimulatorHandle } from '../core/types.js'
import { formatTimecode } from './protocol.js'

/** Endpoints an older or differently-licensed ProPresenter may simply not serve. */
export type ProPresenterFeature = 'systemTime' | 'slide' | 'stageMessage'

interface SimulatedTimer {
  name: string
  seconds: number
  state: string
  /** What `timer.reset` puts the clock back to, as the real app does. */
  resetSeconds: number
}

const TIMER_COMMAND_PATH = /^\/v1\/timer\/([^/]+)\/(start|stop|reset)$/

/**
 * A real HTTP server speaking ProPresenter's REST API, so the connector under
 * test does actual sockets, keep-alive and JSON — the places integrations
 * break. Tests drive it to reproduce a festival's greatest hits: a timer in
 * overrun, an operator quitting the app mid-set, and a version that has never
 * heard of the stage-message endpoint.
 */
export class ProPresenterSimulator implements SimulatorHandle {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  private readonly timers = new Map<string, SimulatedTimer>()
  private slide: { current: string | null; next: string | null }
  private stageMessage = ''
  private readonly absent = new Set<ProPresenterFeature>()

  private failPending = 0
  private garbagePending = 0
  private refusePending = 0

  /** Every path asked for, so a test can prove the poll loop is actually looping. */
  readonly requestedPaths: string[] = []

  constructor() {
    this.setTimer('timer-main', 'Main Set', 272, 'running')
    this.setTimer('timer-change', 'Changeover', 900, 'stopped')
    this.slide = { current: 'Welcome to the Meadow Stage', next: 'Please silence your phones' }
  }

  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      this.server = server

      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })

      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('simulator failed to bind'))
          return
        }
        resolve({ host: address.address, port: address.port })
      })
    })
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * Models the operator quitting ProPresenter. Killing the open keep-alive
   * sockets alone is usually invisible to a polling client — the HTTP pool
   * just opens a fresh one — so the next few requests are refused too, which
   * is what a client sees while the app is genuinely gone.
   */
  dropConnections(refuseCount = 4): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.refusePending = refuseCount
  }

  /** Answers 200 with a body that is not JSON, as a crashing plugin does. */
  sendGarbage(count = 4): void {
    this.garbagePending = count
  }

  /** Answers HTTP 500 for the next `count` requests. */
  failNextRequests(count: number): void {
    this.failPending = count
  }

  setTimer(uuid: string, name: string, seconds: number, state: string): void {
    this.timers.set(uuid, { name, seconds, state, resetSeconds: seconds })
  }

  /**
   * Moves every running timer on by `seconds`. Show timers count down, so this
   * takes them towards — and past — zero, which is where the interesting
   * formatting lives.
   */
  advanceTimers(seconds: number): void {
    for (const timer of this.timers.values()) {
      if (timer.state === 'running') timer.seconds -= seconds
    }
  }

  setSlide(current: string | null, next: string | null): void {
    this.slide = { current, next }
  }

  setStageMessage(text: string): void {
    this.stageMessage = text
  }

  /** Makes an endpoint answer 404, as a ProPresenter without that feature does. */
  setAbsent(feature: ProPresenterFeature): void {
    this.absent.add(feature)
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    this.requestedPaths.push(path)

    if (this.refusePending > 0) {
      this.refusePending -= 1
      req.socket.destroy()
      return
    }
    if (this.failPending > 0) {
      this.failPending -= 1
      this.send(res, 500, 'text/plain', 'simulated ProPresenter failure')
      return
    }
    if (this.garbagePending > 0) {
      this.garbagePending -= 1
      this.send(res, 200, 'application/json', '{"current":{"text": ,,,')
      return
    }

    const command = TIMER_COMMAND_PATH.exec(path)
    if (command) {
      this.runTimerCommand(res, decodeURIComponent(command[1] ?? ''), command[2] ?? '')
      return
    }

    switch (path) {
      case '/v1/timers/current':
        this.send(res, 200, 'application/json', JSON.stringify(this.timersBody()))
        return
      case '/v1/timer/system_time':
        if (this.absent.has('systemTime')) break
        this.send(res, 200, 'application/json', JSON.stringify({ time: wallClock() }))
        return
      case '/v1/status/slide':
        if (this.absent.has('slide')) break
        this.send(res, 200, 'application/json', JSON.stringify(this.slideBody()))
        return
      case '/v1/stage/message': {
        if (this.absent.has('stageMessage')) break
        // No message up means an empty body, not `""` — the real app does this
        // and it is the shape most likely to trip a naive JSON.parse.
        const body = this.stageMessage.length === 0 ? '' : JSON.stringify(this.stageMessage)
        this.send(res, 200, 'application/json', body)
        return
      }
      default:
        break
    }

    this.send(res, 404, 'text/plain', 'not found')
  }

  private runTimerCommand(res: ServerResponse, uuid: string, action: string): void {
    const timer = this.timers.get(uuid)
    if (!timer) {
      this.send(res, 404, 'text/plain', 'no such timer')
      return
    }

    if (action === 'start') timer.state = 'running'
    if (action === 'stop') timer.state = 'stopped'
    if (action === 'reset') {
      timer.seconds = timer.resetSeconds
      timer.state = 'stopped'
    }

    // ProPresenter acknowledges these with an empty 200.
    this.send(res, 200, 'text/plain', '')
  }

  private timersBody(): unknown[] {
    return [...this.timers.entries()].map(([uuid, timer], index) => ({
      id: { uuid, name: timer.name, index },
      time: formatTimecode(timer.seconds),
      state: timer.state,
    }))
  }

  private slideBody(): unknown {
    return {
      current: slideBody(this.slide.current, 'current'),
      next: slideBody(this.slide.next, 'next'),
    }
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'content-type': contentType })
    res.end(body)
  }
}

function slideBody(text: string | null, slot: string): unknown {
  if (text === null) return null
  return { uuid: `slide-${slot}`, text, notes: '' }
}

function wallClock(): string {
  const now = new Date()
  return formatTimecode(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds())
}
