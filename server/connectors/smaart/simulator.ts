import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { SimulatorHandle } from '../core/types.js'

/**
 * A Smaart API v4 server, faked.
 *
 * **Every string in this file is written out literally, from the vendor
 * specification.** It deliberately imports nothing from `protocol.ts`. The
 * previous pair shared a constants block, which meant a wrong verb was wrong
 * symmetrically: the connector said `subscribe`, the simulator answered
 * `subscribe`, eighteen integration tests passed, and none of it was the
 * protocol. Two independent transcriptions of the same document can still both
 * be wrong, but they cannot be wrong *in agreement*, and that is the whole
 * point of the duplication below.
 *
 * One server, three kinds of endpoint, routed on the request path:
 *   `/api/v4/`                                   — control
 *   `/api/v4/devices/{device}/channels/{channel}` — live metrics
 *   `/api/v4/logs/{device}/{channel}/{metric}`    — that metric's log
 */

/**
 * What a real Smaart reported, in the order it reported it.
 *
 * Taken from a Smaart Suite 9.6.4 on the bench rather than from the
 * specification's example — the two differ, and the machine wins. Note what is
 * *not* here: the `Leq 10 / LAeq 10 / LCeq 10` trio the specification calls the
 * default. That rig was configured for five and fifteen minutes instead, which
 * is exactly the "user Leq metrics are configurable" caveat made concrete.
 *
 * `Exposure O` and `Exposure N` appear in no documentation at all.
 */
const DEFAULT_METRICS = [
  'FS Peak',
  'Peak C',
  'SPL Fast',
  'SPL A Fast',
  'SPL C Fast',
  'SPL Slow',
  'SPL A Slow',
  'SPL C Slow',
  'Leq 1',
  'LAeq 1',
  'LCeq 1',
  'LAeq 5',
  'LAeq 15',
  'Exposure O',
  'Exposure N',
]

/** Eight frames a second is the specification's maximum, and its default. */
const MAX_FPS = 8
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS)

/** How often a log endpoint emits a point. Brisk, so a test need not wait. */
const LOG_INTERVAL_MS = 100

export interface SimulatedChannel {
  deviceName: string
  channelName: string
  channelIndex: number
  alarms?: { metric: string; level: number }[]
}

const DEFAULT_CHANNELS: SimulatedChannel[] = [
  { deviceName: 'Smaart I-O', channelName: 'Front Left', channelIndex: 0 },
  { deviceName: 'Smaart I-O', channelName: 'Front Right', channelIndex: 1 },
  {
    deviceName: 'OCTA-CAPTURE',
    channelName: 'Mic 1',
    channelIndex: 3,
    alarms: [{ metric: 'SPL A Slow', level: 110 }],
  },
]

interface StreamClient {
  socket: WebSocket
  channel: SimulatedChannel
  targetFps: number
  /** Frames emitted since the last one this client was actually sent. */
  since: number
}

interface LogClient {
  socket: WebSocket
  channel: SimulatedChannel
  metricName: string
}

export class SmaartSimulator implements SimulatorHandle {
  private server: WebSocketServer | null = null
  private frameTimer: ReturnType<typeof setInterval> | null = null
  private logTimer: ReturnType<typeof setInterval> | null = null

  private readonly control = new Set<WebSocket>()
  private readonly streams = new Set<StreamClient>()
  private readonly logs = new Set<LogClient>()

  private channels = [...DEFAULT_CHANNELS]
  private metrics = [...DEFAULT_METRICS]
  private product = 'Smaart Suite'
  private version = '9.0.2'
  private password: string | null = null
  private authRequired = false
  private level = 92
  private tick = 0
  private violating = new Set<string>()
  private unlogged = new Set(['FS Peak'])
  /**
   * True while a backfill is being written.
   *
   * A real 9.6.4 cannot cope with log connections arriving on top of each
   * other: opening several took the metric stream from four frames a second
   * to one every two seconds, and past the fourth the sockets connected and
   * then delivered nothing at all. Modelled here so a connector that opens
   * them in a loop fails in a test rather than on a show night.
   */
  private backfilling = false
  private emitting = true
  /** Points a log endpoint hands over the moment somebody connects to it. */
  private backlog: { ts: number; value: number }[] = []
  private clock = Date.UTC(2026, 7, 28, 21, 0, 0)

  /** Whoever authenticated, so a test can assert the handshake happened. */
  readonly authenticated: string[] = []
  /** Every targetFPS a stream client asked for. */
  readonly fpsRequests: number[] = []
  /** Connections to a log endpoint for a metric that is not logged. */
  readonly refusedLogAttempts: string[] = []

  /**
   * How many times the connector has asked for the input list.
   *
   * Here so a test can wait for a poll to have happened rather than sleeping
   * for as long as one ought to take. The difference matters in the direction
   * nobody checks: a test asserting "it did not retry" passes trivially on a
   * machine slow enough that the retry had no chance to occur, so a fixed
   * sleep makes that test weaker under exactly the load that should stress
   * it. Review 4s.
   */
  inputPolls = 0
  /** Log points actually delivered, per metric. Lets a test check provenance. */
  readonly loggedPointsSent = new Map<string, number>()
  /** Log connections refused because another backfill was still in flight. */
  readonly logsRefusedWhileBusy: string[] = []

  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host, port })
      this.server = server

      server.once('error', reject)
      server.on('connection', (socket, request) => this.route(socket, request))
      server.once('listening', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('simulator failed to bind'))
          return
        }
        this.resumeEmitting()
        this.startLogging()
        resolve({ host: (address as AddressInfo).address, port: (address as AddressInfo).port })
      })
    })
  }

  async close(): Promise<void> {
    this.stopEmitting()
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = null
    for (const socket of this.allSockets()) socket.terminate()
    this.control.clear()
    this.streams.clear()
    this.logs.clear()

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // ------------------------------------------------------------- injectors

  /** The measurement laptop drops off the show network. */
  dropConnections(): void {
    for (const socket of this.allSockets()) socket.terminate()
    this.control.clear()
    this.streams.clear()
    this.logs.clear()
  }

  sendGarbage(): void {
    for (const socket of this.allSockets()) {
      socket.send('not json at all')
      socket.send('{"response":{')
      socket.send(JSON.stringify({ metrics: 42 }))
    }
  }

  /** The engine stops while the socket stays open — the silent failure. */
  stopEmitting(): void {
    this.emitting = false
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.frameTimer = null
  }

  resumeEmitting(): void {
    if (this.frameTimer) return
    this.emitting = true
    this.frameTimer = setInterval(() => this.emitFrames(), FRAME_INTERVAL_MS)
    this.frameTimer.unref()
  }

  setLevel(level: number): void {
    this.level = level
  }

  setChannels(channels: SimulatedChannel[]): void {
    this.channels = channels
  }

  setMetrics(metrics: string[]): void {
    this.metrics = metrics
  }

  setPassword(password: string | null): void {
    this.password = password
    this.authRequired = password !== null
  }

  /** Pretend to be an edition with no calibrated inputs at all. */
  setProduct(product: string): void {
    this.product = product
  }

  /** Flag a metric the way Smaart does when one of its own alarms is breached. */
  setViolation(metricName: string, violating: boolean): void {
    if (violating) this.violating.add(metricName)
    else this.violating.delete(metricName)
  }

  /** Points a log endpoint replays the instant a client connects. */
  setBacklog(points: { ts: number; value: number }[]): void {
    this.backlog = points
  }

  /**
   * Metrics whose log endpoint hangs up, as a real one does.
   *
   * A 9.6.4 machine logs fourteen of its fifteen metrics and refuses `FS Peak`
   * — a digital full-scale peak is not a sound level. Defaulting to that here
   * keeps the connector honest about not retrying it for ever.
   */
  setUnloggedMetrics(names: string[]): void {
    this.unlogged = new Set(names)
  }

  get connectionCount(): number {
    return this.control.size + this.streams.size + this.logs.size
  }

  get streamCount(): number {
    return this.streams.size
  }

  // ---------------------------------------------------------------- routing

  private route(socket: WebSocket, request: IncomingMessage): void {
    const path = decodeURI(request.url ?? '/')

    // `/+` because the server's own paths carry a doubled slash here.
    const stream = path.match(/^\/api\/v4\/+devices\/(.+)\/channels\/(.+)$/)
    if (stream) {
      const channel = this.findChannel(stream[1] as string, stream[2] as string)
      if (!channel) {
        socket.close(4404)
        return
      }
      const client: StreamClient = { socket, channel, targetFps: MAX_FPS, since: 0 }
      this.streams.add(client)
      socket.on('message', (raw: Buffer) => this.handleStreamMessage(client, raw.toString()))
      socket.on('close', () => this.streams.delete(client))
      return
    }

    const log = path.match(/^\/api\/v4\/+logs\/(.+)\/(.+)\/(.+)$/)
    if (log) {
      const channel = this.findChannel(log[1] as string, log[2] as string)
      if (!channel) {
        socket.close(4404)
        return
      }
      const metricName = log[3] as string
      if (this.unlogged.has(metricName)) {
        // Hung up without a word, which is how a real Smaart says "not logged".
        this.refusedLogAttempts.push(metricName)
        socket.close(4404)
        return
      }
      if (this.backfilling) {
        // Opens, and then never says anything — the real failure exactly.
        this.logsRefusedWhileBusy.push(metricName)
        return
      }
      const client: LogClient = { socket, channel, metricName }
      this.logs.add(client)
      // Everything already logged, the moment somebody connects. This is the
      // whole reason the connector prefers this endpoint to resampling — and
      // the server is busy for as long as it takes.
      if (this.backlog.length > 0) {
        this.backfilling = true
        this.sendLogged(client, this.backlog)
        setTimeout(() => {
          this.backfilling = false
        }, 200).unref()
      }
      socket.on('close', () => this.logs.delete(client))
      return
    }

    if (path.startsWith('/api/v4')) {
      this.control.add(socket)
      socket.on('message', (raw: Buffer) => this.handleControlMessage(socket, raw.toString()))
      socket.on('close', () => this.control.delete(socket))
      return
    }

    // The bare root answers with the version index and nothing else.
    socket.on('message', () => {
      socket.send(JSON.stringify({ supportedApiVersions: [{ '4': '/api/v4/' }] }))
    })
  }

  private findChannel(deviceName: string, channelName: string): SimulatedChannel | null {
    return (
      this.channels.find(
        (channel) => channel.deviceName === deviceName && channel.channelName === channelName,
      ) ?? null
    )
  }

  // ---------------------------------------------------------------- control

  private handleControlMessage(socket: WebSocket, raw: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      this.reply(socket, null, { error: 'parse error' })
      return
    }

    const sequenceNumber =
      typeof frame.sequenceNumber === 'number' && frame.sequenceNumber !== 0
        ? frame.sequenceNumber
        : null
    const properties = Array.isArray(frame.properties) ? frame.properties : []
    const authed = this.authenticated.length > 0

    if (frame.action === 'set') {
      const supplied = properties.find(
        (entry): entry is { password: string } =>
          typeof entry === 'object' && entry !== null && 'password' in entry,
      )
      if (supplied) {
        if (supplied.password === this.password) {
          this.authenticated.push(supplied.password)
          this.reply(socket, sequenceNumber, { status: 'good to go' })
        } else {
          // Smaart 9.6.4's own spelling, one 'r'. The specification says
          // "incorrect"; reproducing the server rather than the document is
          // the whole point of this file.
          this.reply(socket, sequenceNumber, { error: 'incorect password' })
        }
        return
      }
      this.reply(socket, sequenceNumber, { error: 'unknown property' })
      return
    }

    if (frame.action !== 'get') {
      this.reply(socket, sequenceNumber, { error: 'unknown action' })
      return
    }

    if (frame.target === undefined) {
      this.reply(socket, sequenceNumber, {
        applicationName: this.product,
        applicationVersion: this.version,
        authenticationRequired: this.authRequired,
        machineName: 'SmaartServer',
        marshallingTimeout: 4000,
        serializationFormat: 'clear text',
        supportedSerializationFormats: ['clear text', 'BSON', 'MessagePack', 'CBOR', 'UBJSON'],
      })
      return
    }

    if (frame.target !== 'activeCalibratedInputs') {
      this.reply(socket, sequenceNumber, { error: 'unknown target' })
      return
    }

    // Counted before the answer, whatever the answer turns out to be: the
    // thing a test waits on is that the connector *asked*.
    this.inputPolls += 1

    if (this.authRequired && !authed) {
      this.reply(socket, sequenceNumber, { error: 'authentication required' })
      return
    }

    // RT and LE have no calibrated inputs, and answer accordingly.
    if (this.product.includes('RT') || this.product.includes('LE')) {
      this.reply(socket, sequenceNumber, { error: 'unknown target' })
      return
    }

    this.reply(socket, sequenceNumber, this.calibratedInputs())
  }

  private calibratedInputs(): Record<string, unknown> {
    const devices = new Map<string, Record<string, unknown>[]>()

    for (const channel of this.channels) {
      const list = devices.get(channel.deviceName) ?? []
      list.push({
        channelIndex: channel.channelIndex,
        channelName: channel.channelName,
        /*
         * Shaped exactly as a 9.6.4 machine returns them, warts included: a
         * doubled slash after `v4`, and a log prefix with **no** trailing
         * slash despite the specification calling it a prefix to append to.
         * The tidier forms this used to emit are what let a concatenation bug
         * through — the connector built `.../Mac%20MicFS%20Peak` and the real
         * server hung the socket up.
         */
        streamEndpoint: `/api/v4//devices/${encodeURIComponent(channel.deviceName)}/channels/${encodeURIComponent(channel.channelName)}`,
        logEndpointPrefix: `/api/v4//logs/${encodeURIComponent(channel.deviceName)}/${encodeURIComponent(channel.channelName)}`,
        ...(channel.alarms ? { alarms: channel.alarms } : {}),
      })
      devices.set(channel.deviceName, list)
    }

    return {
      devices: [...devices].map(([deviceName, activeCalibratedChannels]) => ({
        deviceName,
        activeCalibratedChannels,
      })),
      metrics: [...this.metrics],
      // One per metric, in the same order — which is what a real 9.6.4
      // returned, and the only reason we know the array is positional.
      colorThresholds: this.metrics.map((name) =>
        name.startsWith('Exposure')
          ? { greenAboveLevel: 0, yellowAboveLevel: 80, redAboveLevel: 100 }
          : { greenAboveLevel: 80, yellowAboveLevel: 100, redAboveLevel: 103 },
      ),
    }
  }

  private reply(
    socket: WebSocket,
    sequenceNumber: number | null,
    response: Record<string, unknown>,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(
      JSON.stringify(sequenceNumber === null ? { response } : { sequenceNumber, response }),
    )
  }

  // ----------------------------------------------------------------- stream

  private handleStreamMessage(client: StreamClient, raw: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.action !== 'set') return

    const properties = Array.isArray(frame.properties) ? frame.properties : []
    for (const entry of properties) {
      const record = entry as Record<string, unknown>
      if (typeof record.targetFPS === 'number') {
        client.targetFps = Math.max(1, Math.min(MAX_FPS, Math.floor(record.targetFPS)))
        this.fpsRequests.push(record.targetFPS)
      }
    }
    // Deliberately no reply: the specification says stream-altering commands
    // produce none, and a connector that grew a dependency on one would work
    // here and hang on the real thing.
  }

  private emitFrames(): void {
    if (!this.emitting) return
    this.tick += 1
    this.clock += FRAME_INTERVAL_MS

    for (const client of this.streams) {
      client.since += 1
      const every = Math.max(1, Math.round(MAX_FPS / client.targetFps))
      if (client.since < every) continue
      client.since = 0
      if (client.socket.readyState !== WebSocket.OPEN) continue
      client.socket.send(JSON.stringify(this.metricsFrame(client.channel)))
    }
  }

  private metricsFrame(channel: SimulatedChannel): Record<string, unknown> {
    // Each channel sits a fixed distance from the first, which is how a test
    // proves the connector opened the stream it was pointed at.
    const offset = channel.channelIndex * 5
    const wobble = Math.sin(this.tick / 8) * 0.3

    const metrics = this.metrics.map((name) => {
      const value = Math.round((this.level + offset + wobble + weightingOffset(name)) * 10) / 10
      return this.violating.has(name) ? { [name]: value, violation: true } : { [name]: value }
    })

    return {
      timestamp: new Date(this.clock).toISOString(),
      deviceName: channel.deviceName,
      channelName: channel.channelName,
      metrics,
    }
  }

  // -------------------------------------------------------------------- log

  private startLogging(): void {
    if (this.logTimer) return
    this.logTimer = setInterval(() => {
      if (!this.emitting) return
      for (const client of this.logs) {
        const offset = client.channel.channelIndex * 5
        this.sendLogged(client, [
          {
            ts: this.clock,
            value: Math.round((this.level + offset + weightingOffset(client.metricName)) * 10) / 10,
          },
        ])
      }
    }, LOG_INTERVAL_MS)
    this.logTimer.unref()
  }

  private sendLogged(client: LogClient, points: { ts: number; value: number }[]): void {
    if (client.socket.readyState !== WebSocket.OPEN) return
    this.loggedPointsSent.set(
      client.metricName,
      (this.loggedPointsSent.get(client.metricName) ?? 0) + points.length,
    )
    client.socket.send(
      JSON.stringify({
        deviceName: client.channel.deviceName,
        channelName: client.channel.channelName,
        metricName: client.metricName,
        loggedData: points.map((point) => ({
          timestamp: new Date(point.ts).toISOString(),
          value: point.value,
          ...(this.violating.has(client.metricName) ? { violation: true } : {}),
        })),
      }),
    )
  }

  private *allSockets(): Generator<WebSocket> {
    yield* this.control
    for (const client of this.streams) yield client.socket
    for (const client of this.logs) yield client.socket
  }
}

/**
 * Keeps the weightings apart by a plausible amount, so a test asserting it read
 * `SPL C Fast` rather than `SPL A Fast` is asserting something.
 */
function weightingOffset(metricName: string): number {
  if (metricName === 'FS Peak') return -145
  if (metricName.includes('Peak')) return 11.4
  if (metricName.includes('C')) return 2.7
  if (metricName.startsWith('Leq') || metricName === 'SPL Fast' || metricName === 'SPL Slow') {
    return 1.1
  }
  return 0
}
