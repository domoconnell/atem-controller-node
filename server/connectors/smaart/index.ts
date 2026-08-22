import { WebSocket } from 'ws'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { smaartConditions } from './conditions.js'
import { discoverSmaartInputs } from './discover.js'
import {
  API_ERRORS,
  API_PATH,
  byMetricKind,
  type CalibratedChannel,
  type CalibratedInputs,
  classifyControlFrame,
  DEFAULT_METRIC_NAMES,
  isBadPassword,
  logEndpointFor,
  metricKind,
  parseCalibratedInputs,
  parseLoggedData,
  parseMetricsFrame,
  parseSpectrumFrame,
  parseRootProperties,
  selectChannel,
  slugForMetric,
  slugMetricNames,
  unitForMetric,
} from './protocol.js'
import { SmaartSimulator } from './simulator.js'

export const smaartConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1').describe('Address of the machine running Smaart'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(26_000)
    .describe('The API port shown in Smaart under Options → API. Not the discovery port.'),
  password: z
    .string()
    .optional()
    .describe('Only if the API tab in Smaart has a password set against it'),
  deviceName: z
    .string()
    .optional()
    .describe('Blank means whichever audio device Smaart lists first'),
  channelName: z
    .string()
    .optional()
    .describe('The calibrated input to log — one module per measurement position'),
  targetFps: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(4)
    .describe('Readings per second. Smaart tops out at eight; four is plenty for a wall.'),
  /**
   * A stopped measurement engine holds its socket open and says nothing, which
   * at the TCP level is indistinguishable from a quiet, healthy link. Silence
   * for this long is treated as a dead link so the supervisor reconnects.
   */
  reconnectOnIdleMs: z
    .number()
    .int()
    .min(250)
    .max(120_000)
    .default(15_000)
    .describe('Treat the metric stream as dead after this long with no reading'),
  /**
   * Which of Smaart's own logs to mirror, if any.
   *
   * Names as Smaart writes them, not slugs — this is what an operator reads off
   * its screen. **Empty means none**, and that is the right default.
   *
   * Mirroring is an evidential upgrade, not a free one. Smaart's log is
   * stamped by the instrument and backfills whatever it recorded while we were
   * away, which is worth having for the one or two figures a licence is
   * written on. But its log subsystem serves only about four subscriptions:
   * measured against a 9.6.4, the fifth socket onwards opened and then
   * silently delivered nothing, and past a dozen would not open at all. A
   * connector that mirrored everything would produce a rig where most of the
   * history is missing and nothing says so.
   *
   * Everything not listed here still gets a history — the connector samples
   * the live stream for it, at one reading a second, costing no connection.
   */
  logMetrics: z
    .array(z.string())
    .max(4, 'Smaart’s log serves about four at once; more and some go silent')
    .default([])
    .describe(
      'Smaart metric names whose history should come from Smaart’s own log ' +
        'rather than from sampling the live feed. Up to four. Everything else ' +
        'is still recorded, once a second, from the live feed.',
    ),
})

export type SmaartConfig = z.infer<typeof smaartConfigSchema>

/**
 * How often we re-ask Smaart what it has plugged in.
 *
 * Three seconds rather than something lazier because this is the only path
 * back from degraded: it is how long a module stays amber after somebody
 * plugs the mic back in. One small JSON request on a show LAN costs nothing
 * next to a wall display that stayed wrong for another minute.
 */
const INPUTS_POLL_MS = 3_000

/**
 * How long a log endpoint gets to say its first word.
 *
 * Generous, because the first thing it says is a whole show's history. A
 * socket still silent after this is one the server never wired up, which a
 * real 9.6.4 does whenever log connections arrive on top of each other.
 */
const FIRST_POINT_MS = 4_000

/**
 * Rational Acoustics Smaart, over its documented v4 WebSocket API.
 *
 * Two sockets, because that is how the API works. A *control* socket at
 * `/api/v4/` answers questions — what this server is, whether it wants a
 * password, which calibrated inputs it has — and each input carries the path of
 * its own *stream* socket, which is where the numbers come from. One module
 * instance follows one calibrated input, so that a delay tower and front of
 * house can carry different limits and different alert rules.
 *
 * Because a noise log is what depends on this, the bias throughout is towards
 * staying connected and towards saying nothing rather than saying something
 * untrue: bad frames are dropped, unknown frames ignored, an unreadable reading
 * is omitted rather than zeroed, and the only things that end the connection
 * are a closed socket and a metric stream that has gone quiet.
 */
class SmaartConnector implements Connector<SmaartConfig> {
  private ctx: ConnectorContext<SmaartConfig> | null = null
  private control: WebSocket | null = null
  private stream: WebSocket | null = null

  private sequence = 0
  private readonly pending = new Map<
    number,
    (frame: ReturnType<typeof classifyControlFrame>) => void
  >()

  private online = false
  private degradedDetail: string | null = null
  /** Last frame *on the stream socket*. Control traffic must not feed this. */
  private lastReadingAt = 0
  private channel: CalibratedChannel | null = null
  private lastChannelsKey: string | null = null
  /** One socket per metric whose log we are mirroring, keyed by metric name. */
  private readonly logSockets = new Map<string, WebSocket>()
  /**
   * Metrics whose log endpoint refused before ever sending anything.
   *
   * Not every metric is logged: a real machine logs fourteen of its fifteen
   * and hangs the socket up on `FS Peak`, which is a digital full-scale peak
   * rather than a sound level. Without remembering that, the input poll would
   * reopen it every three seconds for the length of the show.
   */
  private readonly logRefused = new Set<string>()
  /** Metrics that have actually delivered a logged point. */
  private readonly logWorking = new Set<string>()
  /** Opening logs is sequential and slow; a poll must not start a second run. */
  private openingLogs = false
  /** Last second we wrote a live-stream sample for, per metric. */
  private readonly sampledAt = new Map<string, number>()
  /** Slugs whose history comes from Smaart's log, so we must not sample them. */
  private readonly mirroredFields = new Set<string>()

  async start(ctx: ConnectorContext<SmaartConfig>): Promise<void> {
    this.ctx = ctx
    this.lastReadingAt = Date.now()

    const control = this.open(API_PATH, ctx)
    this.control = control

    control.on('message', (raw: Buffer) => this.handleControlFrame(raw.toString()))
    control.on('close', () => ctx.fail(new Error('Smaart closed the control connection')))
    control.on('error', (error) => ctx.fail(error))

    await once(control, 'open')

    // Handshake first, and *checked*. The connector this replaces sent its
    // subscribe and never looked at the answer, so a refused one on a socket
    // that stayed open meant a green badge and no data, for ever.
    const ready = await this.handshake(ctx)
    if (!ready) return

    await this.refreshInputs(ctx)
    ctx.setInterval(() => void this.refreshInputs(ctx), INPUTS_POLL_MS)
    ctx.setInterval(() => this.checkIdle(ctx), watchdogIntervalMs(ctx.config))
  }

  async stop(): Promise<void> {
    this.pending.clear()
    this.closeLogs()
    for (const socket of [this.control, this.stream]) {
      if (!socket) continue
      // Terminating a connecting socket makes `ws` emit an error, and Node
      // throws on an unhandled one — so a swallowing listener goes back on.
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.terminate()
    }
    this.control = null
    this.stream = null
    this.ctx = null
  }

  // ------------------------------------------------------------- handshake

  private async handshake(ctx: ConnectorContext<SmaartConfig>): Promise<boolean> {
    const root = await this.request({ action: 'get' })
    if (!root) return false

    if (root.kind !== 'reply') {
      const detail = root.kind === 'error' ? root.message : 'an unreadable frame'
      ctx.fail(new Error(`Smaart refused the connection: ${detail}`))
      return false
    }

    const properties = parseRootProperties(root.response)
    if (!properties) {
      ctx.fail(new Error('Smaart answered with something that is not an API v4 server'))
      return false
    }

    ctx.logger.debug(
      { product: properties.applicationName, version: properties.applicationVersion },
      'connected to Smaart',
    )

    if (!properties.authenticationRequired) return true

    const password = ctx.config.password?.trim() ?? ''
    if (password.length === 0) {
      // Not a fail: reconnecting will not conjure a password, and an amber
      // badge naming the problem is what gets somebody to fix the config.
      this.setDegraded(ctx, 'Smaart is asking for a password and none is configured')
      return false
    }

    const authenticated = await this.request({ action: 'set', properties: [{ password }] })
    if (!authenticated) return false
    if (authenticated.kind !== 'reply') {
      // Not the server's wording: 9.6.4 answers "incorect password", and
      // relaying a vendor's typo helps nobody standing at a laptop.
      const detail =
        authenticated.kind === 'error' && isBadPassword(authenticated.message)
          ? 'Smaart did not accept this password'
          : `Smaart refused the password (${authenticated.kind === 'error' ? authenticated.message : 'no usable answer'})`
      this.setDegraded(ctx, detail)
      return false
    }
    return true
  }

  // ------------------------------------------------------------ the inputs

  /**
   * Ask what is plugged in, and follow it.
   *
   * Polled rather than asked once, because otherwise there is no way back from
   * degraded: a mic that gets plugged in after we looked would leave the module
   * amber for the rest of the night, since nothing failed and the supervisor
   * has no reason to reconnect.
   */
  private async refreshInputs(ctx: ConnectorContext<SmaartConfig>): Promise<void> {
    const reply = await this.request({ action: 'get', target: 'activeCalibratedInputs' })
    if (!reply) return

    if (reply.kind !== 'reply') {
      // RT and LE have no calibrated inputs and say so with this error. Gating
      // on the documented error rather than on the product name is deliberate:
      // the error vocabulary is specified, the product strings are not.
      if (reply.kind === 'unknown') return
      const detail =
        reply.message === API_ERRORS.unknownTarget
          ? 'This edition of Smaart has no calibrated inputs — Suite or SPL is needed for logging'
          : `Smaart refused the input list: ${reply.message}`
      this.setDegraded(ctx, detail)
      return
    }

    const inputs = parseCalibratedInputs(reply.response)
    this.publishChannels(ctx, inputs)

    if (inputs.channels.length === 0) {
      this.setDegraded(ctx, 'Smaart has no calibrated inputs running')
      this.closeStream()
      return
    }

    const wanted = selectChannel(inputs.channels, ctx.config.deviceName, ctx.config.channelName)
    if (!wanted) {
      this.setDegraded(
        ctx,
        `Smaart is not reporting an input called "${describeWanted(ctx.config)}"`,
      )
      this.closeStream()
      return
    }

    // A different input, or the stream died: start again on both sockets.
    const changed =
      this.channel?.streamEndpoint !== wanted.streamEndpoint ||
      this.stream?.readyState !== WebSocket.OPEN

    if (changed) {
      this.channel = wanted
      // What one input logs says nothing about another, so the memory of which
      // metrics refused goes with the input it was learnt on.
      this.logRefused.clear()
      this.logWorking.clear()
      this.mirroredFields.clear()
      this.sampledAt.clear()
      this.openStream(ctx, wanted)
    }

    /*
     * Every poll, not only when the stream was rebuilt.
     *
     * A log socket can be refused on its own — the server hands one out, wires
     * nothing to it and says nothing — while the metric stream carries on
     * perfectly. Tying this to the stream's health meant one unlucky moment at
     * connect cost that metric its history for the rest of the night, with a
     * green badge over it the whole time.
     */
    void this.openLogs(ctx, wanted, inputs.metricNames)
  }

  // --------------------------------------------------------------- the logs

  /**
   * Mirror Smaart's own log into this event's history.
   *
   * Not a copy of the live feed. The live feed is stamped with whenever our
   * socket saw it and has a hole wherever the link blinked; Smaart's log is
   * stamped by the instrument and, on connect, hands over everything it
   * already logged — so the hole fills itself. For a noise licence that is the
   * difference between a record and an approximation of one.
   */
  private async openLogs(
    ctx: ConnectorContext<SmaartConfig>,
    channel: CalibratedChannel,
    metricNames: readonly string[],
  ): Promise<void> {
    const prefix = channel.logEndpointPrefix
    if (prefix === null) {
      ctx.logger.debug('this input reports no log endpoint; keeping no history for it')
      return
    }

    // Explicit opt-in, never "all". See the note on `logMetrics`.
    const wanted = ctx.config.logMetrics
    const chosen = metricNames
      .filter((name) => wanted.includes(name))
      .filter((name) => !this.logRefused.has(name))

    // Anything no longer wanted, or on a channel we have stopped following.
    for (const [name, socket] of this.logSockets) {
      if (chosen.includes(name)) continue
      closeQuietly(socket)
      this.logSockets.delete(name)
    }

    /*
     * One at a time, and not while another is still arriving.
     *
     * Each log socket dumps its whole history the instant it connects — every
     * point Smaart has logged today — and while that is in flight the server
     * has nothing left for anybody. Opening them in a loop took the live
     * reading from four a second to one every two seconds, and past the fourth
     * the sockets connected and then never said anything at all.
     */
    if (this.openingLogs) return
    this.openingLogs = true
    try {
      for (const metricName of chosen) await this.openOneLog(ctx, prefix, metricName)
    } finally {
      this.openingLogs = false
    }
  }

  private async openOneLog(
    ctx: ConnectorContext<SmaartConfig>,
    prefix: string,
    metricName: string,
  ): Promise<void> {
    {
      if (this.logSockets.has(metricName)) return
      const field = slugForMetric(metricName)
      if (field.length === 0) return

      const socket = this.open(logEndpointFor(prefix, metricName), ctx)
      this.logSockets.set(metricName, socket)
      let delivered = false

      let lastAt = Date.now()
      socket.on('message', (raw: Buffer) => {
        delivered = true
        lastAt = Date.now()
        this.logWorking.add(metricName)
        // Claimed on the first real point, not on connect: a socket that opens
        // and says nothing must not stop the live sampler covering it.
        this.mirroredFields.add(field)
        this.handleLogFrame(ctx, field, raw.toString())
      })

      /*
       * Closing without ever having said anything means this metric is not
       * logged, and no amount of reopening will change that. Closing *after*
       * delivering is a dropped link, which the next poll should pick back up.
       * A log going quiet is never an outage either way — plenty of metrics
       * simply are not logged, and liveness is judged on the live stream.
       */
      const onGone = () => {
        this.logSockets.delete(metricName)
        if (delivered) return
        this.logRefused.add(metricName)
        this.mirroredFields.delete(field)
        ctx.logger.debug({ metric: metricName }, 'Smaart is not logging this metric')
      }
      socket.on('error', onGone)
      socket.on('close', onGone)

      /*
       * Three outcomes, and they are not the same failure.
       *
       * Closed without a word: this metric is not logged, and no amount of
       * reopening changes that — handled above, remembered for good.
       *
       * Open but silent: the server is busy. A real 9.6.4 does exactly this
       * when log connections arrive on top of each other — the socket opens
       * and simply never delivers. Holding it would look configured and stay
       * empty for the rest of the night, so it is dropped and the next poll
       * tries again.
       *
       * Talking: wait for the backfill to go quiet before opening the next,
       * or the one after it gets the silent treatment.
       */
      const spoke = await waitFor(() => delivered, FIRST_POINT_MS)
      if (!spoke) {
        ctx.logger.debug({ metric: metricName }, 'log endpoint went quiet; will try again')
        closeQuietly(socket)
        this.logSockets.delete(metricName)
        return
      }
      await settle(() => lastAt, 400, 20_000)
    }
  }

  private handleLogFrame(ctx: ConnectorContext<SmaartConfig>, field: string, raw: string): void {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      ctx.logger.debug('ignoring malformed log frame')
      return
    }

    const batch = parseLoggedData(value)
    if (!batch || batch.points.length === 0) return

    ctx.recordHistory(
      batch.points.map((point) => ({ metric: `spl.${field}`, ts: point.ts, value: point.value })),
    )

    // An overload is an event, not a level: it belongs in the timeline beside
    // the connection changes, not as a number in a series.
    const overloads = batch.points.filter((point) => point.overload)
    if (overloads.length > 0) {
      ctx.publish('overload', {
        metric: batch.metricName,
        at: overloads[overloads.length - 1]?.ts ?? null,
        count: overloads.length,
      })
    }
  }

  private closeLogs(): void {
    for (const socket of this.logSockets.values()) closeQuietly(socket)
    this.logSockets.clear()
  }

  private publishChannels(ctx: ConnectorContext<SmaartConfig>, inputs: CalibratedInputs): void {
    const { pairs, collisions } = slugMetricNames(inputs.metricNames)
    if (collisions.length > 0) {
      ctx.logger.debug({ collisions }, 'two Smaart metrics share a field name; keeping the first')
    }

    const payload = {
      channels: inputs.channels.map((channel) => ({
        deviceName: channel.deviceName,
        channelName: channel.channelName,
        alarms: channel.alarms,
      })),
      /*
       * Paired with the slug, so the browser never re-implements the slug
       * rule to label a reading — and with Smaart's own display colours,
       * which turn out to be positional against the metric list. Paired here
       * because the pairing is only knowable next to the list it came from;
       * one hop further on it is an array of numbers with no key.
       */
      metrics: byMetricKind(pairs).map((pair) => {
        const at = inputs.metricNames.indexOf(pair.name)
        const thresholds = at >= 0 ? inputs.colorThresholds[at] : undefined
        return {
          ...pair,
          /*
           * The name and unit travel with the slug so the browser can label a
           * metric this build never declared.
           *
           * The declared fields are the eleven both the specification and a
           * real machine agree on, and the ones a rig is actually configured
           * for — `LAeq 5`, `LAeq 15` — are by definition not among them. Left
           * to the payload alone the browser had nothing but the slug, so the
           * two figures most likely to be on a licence appeared as `laeq15`
           * with no unit, below `FS Peak`. Everything needed to label them
           * properly was already here.
           */
          ...(unitForMetric(pair.name) ? { unit: unitForMetric(pair.name) } : {}),
          kind: metricKind(pair.name),
          ...(thresholds ? { smaartColours: thresholds } : {}),
          /*
           * Whether this series is coming from Smaart's own log rather than
           * from our sampling of the live feed. Both are histories; only one
           * is stamped by the instrument and backfilled across a dropped
           * link, and "which record is this?" is not a question to answer
           * after a licensing officer has asked it.
           */
          fromSmaartLog: this.logWorking.has(pair.name),
        }
      }),
    }

    // Published on change only — this is a `change` stream, and republishing an
    // identical list several times a minute is noise on every dashboard.
    const key = JSON.stringify(payload)
    if (key === this.lastChannelsKey) return
    this.lastChannelsKey = key
    ctx.publish('channels', payload)
  }

  // ------------------------------------------------------------ the stream

  private openStream(ctx: ConnectorContext<SmaartConfig>, channel: CalibratedChannel): void {
    this.closeStream()
    this.closeLogs()

    const socket = this.open(channel.streamEndpoint, ctx)
    this.stream = socket

    socket.on('open', () => {
      // Fire and forget: the specification is explicit that stream-altering
      // commands get no reply, so awaiting one would hang here and only here.
      socket.send(
        JSON.stringify({ action: 'set', properties: [{ targetFPS: ctx.config.targetFps }] }),
      )
    })
    socket.on('message', (raw: Buffer) => this.handleStreamFrame(ctx, raw.toString()))
    socket.on('error', (error) => ctx.fail(error))
    socket.on('close', () => {
      // Only a surprise if we still wanted it. A deliberate swap closes the old
      // socket after clearing `this.stream`.
      if (this.stream === socket) ctx.fail(new Error('Smaart closed the metric stream'))
    })
  }

  private closeStream(): void {
    const socket = this.stream
    this.stream = null
    if (socket) closeQuietly(socket)
  }

  private handleStreamFrame(ctx: ConnectorContext<SmaartConfig>, raw: string): void {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      // Never drop the link over a bad frame: a reconnect costs seconds of SPL
      // history, and that history is the point of this connector.
      ctx.logger.debug({ frame: raw.slice(0, 120) }, 'ignoring malformed stream frame')
      return
    }

    // A live RTA spectrum rides on the same stream (independent of the SPL
    // metrics), so publish it before the metrics-liveness gates below.
    const spectrum = parseSpectrumFrame(value)
    if (spectrum) ctx.publish('spectrum', spectrum)

    const frame = parseMetricsFrame(value)
    if (!frame) return

    // An empty reading is not proof of life. The connector this replaces
    // refreshed its watchdog before noticing, so a Smaart running with nothing
    // to measure showed green over a frozen number until somebody looked at it.
    if (Object.keys(frame.values).length === 0) {
      ctx.logger.debug('metric frame carried no readable values')
      return
    }

    this.lastReadingAt = Date.now()
    if (!this.online || this.degradedDetail !== null) {
      this.online = true
      this.degradedDetail = null
      ctx.setStatus('online')
    }

    ctx.publish('spl', {
      ...frame.values,
      violations: frame.violations,
      device: frame.deviceName,
      channel: frame.channelName,
    })

    this.sampleForHistory(ctx, frame)
  }

  /**
   * A history for everything Smaart's log is not covering.
   *
   * Sampling happens here rather than in the platform recorder for one reason:
   * this is the only place that knows which metrics are already being mirrored
   * from Smaart's own log, and a reading that arrived twice under two clocks is
   * not a better record than one — it is a worse one. A metric is written from
   * exactly one source, ever.
   *
   * One reading a second, which is the rate a noise log is read back at. The
   * stream runs faster than that so a wall display moves; storing all of it
   * would multiply a festival's disk for no extra evidential value.
   */
  private sampleForHistory(
    ctx: ConnectorContext<SmaartConfig>,
    frame: { values: Record<string, number>; ts: number | null },
  ): void {
    // Smaart's clock where it gave us one, so a sampled series and a mirrored
    // series can sit in the same export without arguing about the time.
    const ts = frame.ts ?? Date.now()
    const second = Math.floor(ts / 1000)

    const points: { metric: string; ts: number; value: number }[] = []
    for (const [field, value] of Object.entries(frame.values)) {
      if (this.mirroredFields.has(field)) continue
      if (this.sampledAt.get(field) === second) continue
      this.sampledAt.set(field, second)
      points.push({ metric: `spl.${field}`, ts, value })
    }
    if (points.length > 0) ctx.recordHistory(points)
  }

  /**
   * Counts the *metric stream* only.
   *
   * With two sockets this matters: the control socket's poll replies arrive
   * every ten seconds regardless, so a watchdog fed by any traffic at all would
   * sit happily green while the numbers stopped — the exact failure it exists
   * to catch.
   */
  private checkIdle(ctx: ConnectorContext<SmaartConfig>): void {
    if (this.stream === null) return
    const idleMs = Date.now() - this.lastReadingAt
    if (idleMs < idleDeadlineMs(ctx.config)) return
    ctx.fail(new Error(`no readings from Smaart for ${idleMs}ms`))
  }

  // ------------------------------------------------------------- plumbing

  private open(path: string, ctx: ConnectorContext<SmaartConfig>): WebSocket {
    const { host, port } = ctx.config
    const socket = new WebSocket(`ws://${host}:${port}${path}`)
    ctx.signal.addEventListener(
      'abort',
      () => {
        socket.removeAllListeners('error')
        socket.on('error', () => {})
        socket.terminate()
      },
      { once: true },
    )
    return socket
  }

  private handleControlFrame(raw: string): void {
    const ctx = this.ctx
    if (!ctx) return

    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      ctx.logger.debug({ frame: raw.slice(0, 120) }, 'ignoring malformed control frame')
      return
    }

    const frame = classifyControlFrame(value)
    if (frame.kind === 'unknown') return
    if (frame.sequenceNumber === null) return

    const resolve = this.pending.get(frame.sequenceNumber)
    if (!resolve) return
    this.pending.delete(frame.sequenceNumber)
    resolve(frame)
  }

  /**
   * One request on the control socket, awaited.
   *
   * Times out rather than waiting for ever, and clears its own entry either
   * way — the previous implementation only emptied `pending` in `stop()`, so a
   * request that never came back leaked until the instance did.
   */
  private request(
    body: Record<string, unknown>,
  ): Promise<ReturnType<typeof classifyControlFrame> | null> {
    const socket = this.control
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(null)

    const sequenceNumber = ++this.sequence
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequenceNumber)
        resolve(null)
      }, 5_000)
      timer.unref()

      this.pending.set(sequenceNumber, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      socket.send(JSON.stringify({ ...body, sequenceNumber }))
    })
  }

  private setDegraded(ctx: ConnectorContext<SmaartConfig>, detail: string): void {
    if (this.degradedDetail === detail) return
    this.degradedDetail = detail
    this.online = false
    ctx.setStatus('degraded', detail)
  }
}

/**
 * Pull a socket down without Node throwing.
 *
 * Terminating one that is still connecting makes `ws` emit an error, and an
 * unhandled 'error' event is fatal — so a swallowing listener goes back on.
 */
/**
 * Waits until nothing has arrived for a while, or until patience runs out.
 *
 * Used between log connections: each one dumps a whole show's history on
 * connect, and starting the next before that has drained is what took the live
 * reading down to one frame every two seconds.
 */
/** Polls a condition until it holds, or until the deadline. */
async function waitFor(condition: () => boolean, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return condition()
}

async function settle(lastAt: () => number, quietMs: number, capMs: number): Promise<void> {
  const deadline = Date.now() + capMs
  while (Date.now() < deadline && Date.now() - lastAt() < quietMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function closeQuietly(socket: WebSocket): void {
  socket.removeAllListeners()
  socket.on('error', () => {})
  socket.terminate()
}

function describeWanted(config: SmaartConfig): string {
  const device = config.deviceName?.trim() ?? ''
  const channel = config.channelName?.trim() ?? ''
  return [device, channel].filter(Boolean).join(' / ') || 'any input'
}

/**
 * Never call a link dead faster than it was asked to speak.
 *
 * `reconnectOnIdleMs` goes down to 250ms, and at one frame a second that would
 * kill a perfectly healthy stream every time. The floor is three frames'
 * grace at the configured rate.
 */
function idleDeadlineMs(config: SmaartConfig): number {
  return Math.max(config.reconnectOnIdleMs, (3 * 1000) / config.targetFps)
}

/**
 * Check often enough that the watchdog fires close to the deadline rather than
 * up to a whole period late, but not so often that a Pi spends its evening
 * waking up to compare two timestamps.
 */
function watchdogIntervalMs(config: SmaartConfig): number {
  return Math.max(200, Math.floor(idleDeadlineMs(config) / 3))
}

function once(socket: WebSocket, event: 'open'): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve()
      return
    }
    socket.once(event, () => resolve())
    socket.once('close', () => resolve())
    socket.once('error', () => resolve())
  })
}

/** The fourteen the specification documents, as declared fields. */
const declaredFields = DEFAULT_METRIC_NAMES.map((name) => ({
  id: slugForMetric(name),
  kind: 'number' as const,
  label: name,
  unit: name === 'FS Peak' ? 'dBFS' : 'dB',
}))

export const smaartModule: ConnectorModule<SmaartConfig> = {
  meta: {
    typeId: 'smaart',
    displayName: 'Rational Acoustics Smaart',
    description:
      'Sound level from a calibrated input in Smaart Suite or Smaart SPL, over the documented ' +
      'v4 API. Every figure — the time-weighted levels and each Leq window — is measured and ' +
      'named by Smaart; none of it is calculated here. One module follows one measurement ' +
      'position, so front of house and a delay tower can carry different limits.',
    configSchema: smaartConfigSchema,
    streams: [
      {
        id: 'spl',
        label: 'Sound level',
        rateClass: 'fast',
        // History comes from Smaart's own log rather than from resampling this
        // feed — see the log mirror. A resampled copy has a hole wherever the
        // socket blinked; Smaart's log backfills it and is stamped by the
        // instrument that measured it.
        history: 'none',
        /*
         * Declared evidential-first, and that order is load-bearing: a newly
         * added level meter binds itself to the first number field. Put
         * `fsPeak` first and every wall display seeds onto a dBFS peak — a
         * negative number on a 60–110 dB scale, bar pinned at zero.
         *
         * These are the fourteen the specification documents as default. The
         * user Leq windows are configurable in Smaart, so a rig may send more
         * (an `LAeq 5`) or fewer; extras ride along in the payload under their
         * own slug and the config dialogue offers them from live data.
         */
        fields: [
          ...declaredFields,
          { id: 'device', kind: 'string', label: 'Device' },
          { id: 'channel', kind: 'string', label: 'Input' },
        ],
      },
      {
        id: 'overload',
        label: 'Input overload',
        // `change`: an overload is a moment, not a level, and most nights
        // there is not one. History goes to the timeline rather than to the
        // metrics table, where a count would be meaningless between events.
        rateClass: 'change',
        history: 'events',
      },
      {
        id: 'channels',
        label: 'Calibrated inputs',
        // `change`, not `slow`: this publishes once and then only when
        // something is plugged in or out. Under `slow` it would be `$stale`
        // fifteen seconds after every connect and never clear.
        rateClass: 'change',
      },
      {
        id: 'spectrum',
        label: 'Spectrum (RTA)',
        // A live real-time-analyzer curve — 1/3-octave band magnitudes per
        // calibrated input. `fast`, no resampled history (it's a live view).
        rateClass: 'fast',
        history: 'none',
      },
    ],
    commands: [],
    conditions: smaartConditions,
    // Read-only. The v4 API has no way to reset an SPL accumulator — the only
    // control surface is a keypress handler needing Smaart's own bindings —
    // and a compliance feed is arguably the last thing that should write back.
    capabilities: { control: false },
    tier: 'caveated',
    vendorNotes:
      'In Smaart open Options → API and enable the server; put the port shown there in this ' +
      'module, and the password if one is set. Needs Smaart Suite or Smaart SPL — RT and LE ' +
      'have no calibrated inputs and cannot log. The Leq windows on offer are the ones ' +
      'configured in Smaart itself, so if a licence is written around LAeq 5 minutes, set that ' +
      'up there first. Verified against a real Smaart 9.6.4, including a calibrated input — see ' +
      'the run 4p notes — but confirm the readings on site before a show relies on them.',
  },
  create: () => new SmaartConnector(),
  createSimulator: () => new SmaartSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
  // The device and channel names, asked of the machine rather than typed off a
  // patch sheet. See `discover.ts` for why it is not a method on the connector.
  discoverConfigOptions: (config, signal) => discoverSmaartInputs(config, signal),
}
