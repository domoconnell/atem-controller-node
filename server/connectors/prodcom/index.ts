import { once } from 'node:events'
import type { Term } from '@stageit/shared'
import { WebSocket } from 'ws'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { prodcomConditions } from './conditions.js'
import {
  channelWanted,
  type FeedMessage,
  feedMessageFrom,
  isAuthError,
  looksLikeList,
  type ProdComChannel,
  type ProdComEntry,
  type ProdComGroup,
  type ProdComKeyword,
  type ProdComStatus,
  parseChannels,
  parseGroups,
  parseKeywords,
  parseSseBlock,
  parseStatus,
  parseTranscriptPage,
  readEventFrame,
  takeSseBlocks,
  termsFor,
  unwrap,
} from './protocol.js'
import { ProdComSimulator } from './simulator.js'

/**
 * ProdCom — live comms, transcribed.
 *
 * The only module on this dashboard that carries what people are *saying*
 * rather than what a machine is doing, which changes what it has to be good at.
 * A level meter is glanced at; a comms feed is read continuously by someone
 * doing another job, and its value is entirely in the one line they needed to
 * notice.
 *
 * Two decisions are worth knowing before reading the rest.
 *
 * **The socket is not trusted with the data.** ProdCom's API document specifies
 * the WebSocket's housekeeping frames and never says what an event frame looks
 * like. So the socket is treated as a latency optimisation over a REST
 * reconciliation poll that *is* fully specified — if every frame turns out to
 * be unreadable, the feed still fills, a few seconds late.
 *
 * **Matching happens here, not in the browser.** ProdCom publishes keyword
 * rules but not keyword matches, so somebody has to run one against the other.
 * Doing it on this side means the alerting and the highlighting cannot
 * disagree, and — the part that matters — a keyword the operator marked
 * sensitive is blanked before the line is published, rather than after it has
 * already crossed the bus and been written to the event database.
 */

const configSchema = z.object({
  host: z
    .string()
    .min(1)
    .default('127.0.0.1')
    .describe('Hostname or IP of the machine running ProdCom — a Mac or an iPad'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(24480)
    .describe('The API port, as shown in ProdCom under Settings → API. 24480 unless changed'),
  apiKey: z
    .string()
    .optional()
    .describe('Only if ProdCom has a pre-shared key set. Leave blank if it does not'),
  channels: z
    .array(z.string())
    .default([])
    .describe('Channel names or IDs to follow. Leave empty for all of them'),
  watchWords: z
    .array(z.string())
    .default([])
    .describe(
      'Words that raise an alert and go in the show record — names, roles, "medical". ' +
        "ProdCom's own keywords are picked up automatically and do not need repeating here",
    ),
  watchWholeWord: z
    .boolean()
    .default(true)
    .describe('Match watch words as whole words, so "Dave" does not fire on "Davenport"'),
  feedLimit: z
    .number()
    .int()
    .min(10)
    .max(200)
    .default(60)
    .describe('How many recent lines to keep. Widgets show at most this many'),
  includeInProgress: z
    .boolean()
    .default(true)
    .describe('Show lines while they are still being recognised, before the words settle'),
  reconcileSeconds: z
    .number()
    .int()
    .min(5)
    .max(300)
    .default(5)
    .describe('How often to re-read the transcript over HTTP, in case the live feed missed one'),
  reconnectOnIdleMs: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(120_000)
    .describe(
      'Quietly re-open the live stream if it has delivered nothing for this long. Never takes ' +
        'the module offline — comms is allowed to be silent',
    ),
})

export type ProdComConfig = z.infer<typeof configSchema>

/** How often the catalogue is re-read: channels come and go mid-show. */
const CATALOGUE_POLL_MS = 30_000
/** How often the clock stream ticks. See `watch` in the stream declarations. */
const WATCH_TICK_MS = 5_000
/**
 * The reconciliation poll asks for a *trailing window* rather than everything
 * since the last line we saw.
 *
 * An entry mutates: it arrives `inProgress` and its text firms up a moment
 * later. If `since` filters on creation time — the document does not say —
 * then asking for "everything after the newest line I have" would never
 * re-deliver an entry that completed late, and the feed would keep a half-heard
 * sentence for ever. Asking for the last half-minute every time and upserting
 * by id makes that self-healing.
 */
const RECONCILE_WINDOW_MS = 30_000
/** How far back the first read reaches. Enough to open on context, not a day. */
const BACKFILL_WINDOW_MS = 15 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
/**
 * How many flagged lines to remember having recorded.
 *
 * Only has to outlast the reconciliation window — it exists to stop the same
 * utterance being written to the show record twice — so a few hundred is
 * generous even on a rig where four channels are all shouting.
 */
const RECORDED_MEMORY = 500

/**
 * How often to look at whether the live stream is still there.
 *
 * Deliberately not derived from `reconnectOnIdleMs`. It was, and that made the
 * check run every forty seconds on the default settings — so a stream dropped
 * a second after a check went unnoticed for the best part of a minute, on the
 * one widget where latency is the whole point. The check itself is a couple of
 * comparisons and returns immediately while the stream is healthy, so there is
 * nothing to save by doing it rarely. The idle deadline still decides when a
 * *connected but silent* stream is worth re-opening.
 */
const STREAM_CHECK_MS = 2_000

/**
 * How many polls in a row have to fail before we call it.
 *
 * Three, against the default five-second poll, is about fifteen seconds — slow
 * enough to ride out a dropped packet, fast enough that somebody looking at the
 * board learns the machine has gone before they have finished wondering.
 */
const POLL_FAILURES_BEFORE_OFFLINE = 3

interface ChannelActivity {
  lastHeardAt: number | null
}

export class ProdComConnector implements Connector<ProdComConfig> {
  private socket: WebSocket | null = null
  private channels: ProdComChannel[] = []
  private groups: ProdComGroup[] = []
  private keywords: ProdComKeyword[] = []
  private status: ProdComStatus | null = null

  /** The rolling feed, keyed by ProdCom's own entry id, oldest first. */
  private messages = new Map<string, FeedMessage>()
  private activity = new Map<string, ChannelActivity>()
  /** Per-channel term lists, rebuilt whenever the catalogue changes. */
  private terms = new Map<string, Term[]>()
  /**
   * Ids already written to the show record, newest last.
   *
   * Bounded on its own rather than following the feed. Tying it to feed
   * membership was wrong twice over: a flagged line evicted by `trim` lost its
   * entry, and the next reconciliation poll — which asks for a trailing window,
   * not "since the last id" — re-absorbed it and wrote a *second* timeline row
   * for one utterance. And an old line evicted by its own insert left an id
   * behind that nothing could ever delete.
   */
  private recorded: string[] = []
  private recordedIndex = new Set<string>()
  /**
   * Bumped whenever the feed actually changes.
   *
   * The change gate used to be "length, plus the last message's id and text",
   * which at steady state is just the last message — `trim` pins the length at
   * `feedLimit`. Two real losses followed. Two channels talking at once: a
   * half-heard line on Stage Left firms up *after* a line from FOH has landed,
   * so the corrected text never reaches the browser. And a line whose text was
   * already final flipping from in-progress to settled changes no part of that
   * key, so it sits greyed out with a caret for ever. A counter cannot miss
   * either.
   */
  private revision = 0
  private publishedRevision = -1
  private lastChannelsKey = ''
  private lastStatusKey = ''
  /** Whether the event stream is currently being read, and when it last spoke. */
  private streaming = false
  private lastStreamAt = 0
  private degradedDetail: string | null = null
  private reconciling = false
  /** Consecutive failed top-ups. See `reconcile`. */
  private pollFailures = 0

  async start(ctx: ConnectorContext<ProdComConfig>): Promise<void> {
    // Catalogue first: without the channel list and the keyword rules there is
    // nothing to match a transcript line against, and publishing unhighlighted
    // lines for the first few seconds would be worse than waiting.
    /*
     * The timers are armed before anything can bail out.
     *
     * `refreshCatalogue` returns false for the recoverable states — ProdCom has
     * no channels loaded yet, or none of the named ones exist — and the
     * supervisor does not restart a *degraded* instance. Returning early with
     * nothing scheduled therefore left the module amber until a human touched
     * it, which is precisely the failure the catalogue poll exists to prevent.
     */
    ctx.setInterval(() => void this.refreshCatalogue(ctx), CATALOGUE_POLL_MS)
    ctx.setInterval(() => void this.reconcile(ctx, false), ctx.config.reconcileSeconds * 1_000)
    ctx.setInterval(() => this.tick(ctx), WATCH_TICK_MS)
    ctx.setInterval(() => this.checkStream(ctx), STREAM_CHECK_MS)

    const ready = await this.refreshCatalogue(ctx)
    if (!ready) return

    // Socket first, then the backfill — not the other way round. Opening it
    // does not block, so it gets the whole backfill round-trip to finish
    // connecting, and the window where we are online but not yet listening
    // closes. Anything said inside that window would otherwise wait for the
    // reconciliation poll to notice it.
    this.lastStreamAt = Date.now()
    void this.openStream(ctx)
    this.openSocket(ctx)
    await this.reconcile(ctx, true)

    // Ticked once straight away rather than only on the interval: both
    // conditions read this stream, and leaving them with nothing to evaluate
    // for the first five seconds of a show is five seconds of a board that
    // cannot tell you anything.
    this.tick(ctx)
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (socket) {
      // Terminating a socket that is still connecting emits an unhandled error
      // and takes the process with it.
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.terminate()
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private base(config: ProdComConfig): string {
    return `http://${config.host}:${config.port}/api/v1`
  }

  private async get(
    ctx: ConnectorContext<ProdComConfig>,
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${this.base(ctx.config)}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timed out')), REQUEST_TIMEOUT_MS)

    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (ctx.config.apiKey) headers.authorization = `Bearer ${ctx.config.apiKey}`
      const response = await fetch(url, { signal: controller.signal, headers })
      return await response.json()
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Channels, groups and keyword rules.
   *
   * Re-read on a timer rather than only at startup: a channel added mid-show
   * would otherwise never appear, and nothing has failed, so the supervisor
   * will never reconnect us into noticing.
   */
  private async refreshCatalogue(ctx: ConnectorContext<ProdComConfig>): Promise<boolean> {
    try {
      const [statusBody, channelsBody, groupsBody, keywordsBody] = await Promise.all([
        this.get(ctx, '/status'),
        this.get(ctx, '/channels'),
        this.get(ctx, '/groups'),
        this.get(ctx, '/keywords'),
      ])

      const keywordData = unwrap(keywordsBody)
      /*
       * "No keywords configured" and "this 0.1.0 API changed shape" both parse
       * to an empty list, and the second one silently switches redaction off
       * for the rest of the show. So the shape is checked separately: keep
       * whatever we had, and say so.
       */
      if (!looksLikeList(keywordData)) {
        this.setDegraded(
          ctx,
          'ProdCom sent a keyword list we could not read — still using the last one',
        )
        return false
      }

      this.status = parseStatus(unwrap(statusBody))
      this.channels = parseChannels(unwrap(channelsBody))
      this.groups = parseGroups(unwrap(groupsBody))
      this.keywords = parseKeywords(keywordData)
      this.terms.clear()
    } catch (error) {
      if (ctx.signal.aborted) return false
      if (isAuthError(error)) {
        // Reconnecting will not conjure a key. Amber with the reason beats a
        // reconnect loop nobody can diagnose from the module list.
        this.setDegraded(ctx, 'ProdCom is asking for an API key and the one configured was refused')
        return false
      }
      ctx.fail(error, 'could not read the ProdCom catalogue')
      return false
    }

    const wanted = this.wantedChannels(ctx)
    if (this.channels.length === 0) {
      this.setDegraded(ctx, 'ProdCom has no channels configured')
      return false
    }
    if (wanted.length === 0) {
      this.setDegraded(
        ctx,
        `none of the channels named in this module exist on ${this.status?.configuration || 'ProdCom'}`,
      )
      return false
    }

    for (const channel of wanted) {
      if (!this.activity.has(channel.id)) this.activity.set(channel.id, { lastHeardAt: null })
    }
    /*
     * And forget the ones that have gone. Without this, a channel deleted in
     * ProdCom mid-show keeps appearing in `watch` under its bare UUID with
     * `quietSeconds` climbing for ever — so `comms.silent` raises a permanent
     * warning against a channel that no longer exists, under an `itemKey`
     * nothing will ever clear.
     */
    const live = new Set(wanted.map((channel) => channel.id))
    for (const id of [...this.activity.keys()]) {
      if (!live.has(id)) this.activity.delete(id)
    }

    // Back from amber. Without this the connector reports online again but the
    // stale detail sticks to the next `setDegraded` comparison and is swallowed.
    this.degradedDetail = null
    this.publishCatalogue(ctx, wanted)
    return true
  }

  private wantedChannels(ctx: ConnectorContext<ProdComConfig>): ProdComChannel[] {
    return this.channels.filter((channel) => channelWanted(channel, ctx.config.channels))
  }

  /**
   * The terms for one channel, built once per catalogue refresh.
   *
   * Rebuilt per message before, which allocated an array and a Set for every
   * line — immaterial in cost, but it also meant the browser and the server
   * could be handed different lists, which is the one thing sharing a matcher
   * was supposed to rule out.
   */
  private termsForChannel(
    ctx: ConnectorContext<ProdComConfig>,
    channel: ProdComChannel | null,
  ): Term[] {
    const key = channel?.id ?? '\u0000global'
    const cached = this.terms.get(key)
    if (cached) return cached

    const built = termsFor({
      global: this.keywords,
      channel,
      groups: this.groups,
      watchWords: ctx.config.watchWords,
      watchWholeWord: ctx.config.watchWholeWord,
    })
    this.terms.set(key, built)
    return built
  }

  /**
   * Re-read the transcript over HTTP and fold anything new or changed in.
   *
   * This is the floor the whole connector stands on: `GET /transcript` is fully
   * specified where the socket is not, so a socket that says nothing readable
   * costs a few seconds of latency rather than the feed.
   */
  private async reconcile(ctx: ConnectorContext<ProdComConfig>, initial: boolean): Promise<void> {
    if (this.reconciling || ctx.signal.aborted) return
    this.reconciling = true

    try {
      /*
       * Both the backfill and the top-up ask for a bounded recent window.
       *
       * The backfill used to ask with no `since` at all, which assumes the
       * endpoint returns the *newest* page first — and the document does not
       * say. If it pages from the oldest, that fetch returns the first sixty
       * lines ProdCom recorded today rather than the last sixty, and a wall
       * display opens on this morning's get-in. A window cannot be wrong in
       * that direction: whatever order it arrives in, it is recent, the ring
       * buffer keeps the newest by timestamp, and live lines displace the rest
       * within a minute. Ordering is on the list of things to settle on the
       * bench.
       */
      const windowMs = initial ? BACKFILL_WINDOW_MS : RECONCILE_WINDOW_MS
      const page = parseTranscriptPage(
        await this.get(ctx, '/transcript', {
          limit: String(Math.min(200, ctx.config.feedLimit)),
          since: new Date(Date.now() - windowMs).toISOString(),
        }),
      )

      let changed = false
      for (const entry of page.entries) changed = this.absorb(ctx, entry) || changed
      if (changed || initial) this.publishFeed(ctx)
      if (initial) ctx.setStatus('online')
      this.pollFailures = 0
    } catch (error) {
      if (ctx.signal.aborted) return
      if (initial) {
        ctx.fail(error, 'could not read the transcript from ProdCom')
        return
      }
      /*
       * One failed top-up is not an outage — a dropped request on a show
       * network is ordinary, and the live stream may well still be feeding us.
       * Several in a row is a different thing, and this is the poll that
       * notices it first: the catalogue refresh only comes round every thirty
       * seconds, so leaning on that meant a ProdCom that had fallen over went
       * on looking healthy for half a minute.
       */
      this.pollFailures += 1
      if (this.pollFailures >= POLL_FAILURES_BEFORE_OFFLINE) {
        ctx.fail(error, `ProdCom stopped answering (${this.pollFailures} polls in a row)`)
        return
      }
      ctx.logger.debug({ err: error }, 'prodcom reconciliation poll failed')
    } finally {
      this.reconciling = false
    }
  }

  // ── The socket ────────────────────────────────────────────────────────────

  /**
   * The live path: Server-Sent Events.
   *
   * Not the WebSocket, which is what the document points at. On ProdCom 2.3.2
   * the socket advertises a `transcript` stream in its welcome frame and then
   * delivers nothing down it — ninety seconds of real speech produced three
   * keep-alive pings and no events, under every plausible spelling of the
   * subscribe frame. `GET /transcript/stream` delivers the same speech
   * word-by-word, immediately, with a stable id per utterance.
   *
   * A dropped stream is not an outage. The reconciliation poll underneath is
   * the floor, so this reconnects quietly and nobody sees a red badge for it.
   */
  private async openStream(ctx: ConnectorContext<ProdComConfig>): Promise<void> {
    if (this.streaming || ctx.signal.aborted) return
    this.streaming = true

    try {
      const url = new URL(`${this.base(ctx.config)}/transcript/stream`)
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (ctx.config.apiKey) headers.authorization = `Bearer ${ctx.config.apiKey}`

      const response = await fetch(url, { signal: ctx.signal, headers })
      if (!response.ok || response.body === null) {
        ctx.logger.debug({ status: response.status }, 'prodcom event stream refused')
        return
      }

      this.lastStreamAt = Date.now()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!ctx.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const { blocks, rest } = takeSseBlocks(buffer)
        buffer = rest

        let changed = false
        for (const block of blocks) {
          this.lastStreamAt = Date.now()
          const entry = parseSseBlock(block)
          // Malformed data is not an outage, and the poll has it anyway.
          if (entry === null) continue
          changed = this.absorb(ctx, entry) || changed
        }
        if (changed) this.publishFeed(ctx)
      }
    } catch (error) {
      if (!ctx.signal.aborted) ctx.logger.debug({ err: error }, 'prodcom event stream ended')
    } finally {
      this.streaming = false
    }
  }

  /** Re-open the stream if it has died or gone unaccountably quiet. */
  private checkStream(ctx: ConnectorContext<ProdComConfig>): void {
    if (ctx.signal.aborted) return
    // Re-open the socket too if it has dropped. Cheap, and it costs nothing to
    // be ready for the firmware that starts using it.
    if (this.socket === null) this.openSocket(ctx)

    const idle = Date.now() - this.lastStreamAt
    if (this.streaming && idle < ctx.config.reconnectOnIdleMs) return
    void this.openStream(ctx)
  }

  /**
   * The WebSocket, held open on spec rather than on evidence.
   *
   * It delivers nothing on 2.3.2 — see `openStream` — so nothing here depends
   * on it, and its dying is not an outage. Kept for two reasons: this is a
   * 0.1.0 API the vendor is still building, and the day a firmware starts
   * pushing transcript events down the socket the document describes, this
   * picks them up with no change. Anything it does send is absorbed exactly as
   * an SSE entry would be.
   */
  private openSocket(ctx: ConnectorContext<ProdComConfig>): void {
    const url = new URL(`ws://${ctx.config.host}:${ctx.config.port}/api/v1/ws`)

    /*
     * Header rather than `?key=`, which the API also accepts. A query string
     * ends up in ProdCom's own access log and in anything between us and it;
     * a header does not. Neither hides it from the network — this is `ws://`
     * on a show LAN and the key crosses in clear either way, which is worth
     * knowing before deciding the key is protecting much.
     */
    const socket = new WebSocket(url, {
      headers: ctx.config.apiKey ? { authorization: `Bearer ${ctx.config.apiKey}` } : undefined,
    })
    this.socket = socket

    socket.on('open', () => {
      /*
       * The category names come from the machine, not the document.
       *
       * The specification lists `transcript`, `channel`, `automation`,
       * `status`. ProdCom 2.3.2 announces `transcript`, `status`, `automation`,
       * `activity` in its own welcome frame — there is no `channel`, which is
       * one of the three the first version of this asked for.
       */
      socket.send(
        JSON.stringify({ type: 'subscribe', events: ['transcript', 'status', 'activity'] }),
      )
    })
    socket.on('message', (raw: Buffer) => this.handleFrame(ctx, raw.toString()))
    // Neither of these is fatal. The transcript arrives over SSE with a REST
    // poll underneath it; a socket carrying only keep-alives can come and go
    // without anybody needing to see a red badge for it.
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
    })
    socket.on('error', (error) => {
      ctx.logger.debug({ err: error }, 'prodcom websocket error')
      if (this.socket === socket) this.socket = null
    })

    void once(socket, 'open').catch(() => {})
  }

  private handleFrame(ctx: ConnectorContext<ProdComConfig>, raw: string): void {
    const frame = readEventFrame(raw)

    if (frame.kind === 'heartbeat') {
      // Echoed only where the vendor documented an echo. See `readEventFrame`.
      if (frame.reply) this.socket?.send(JSON.stringify({ type: 'heartbeat' }))
      return
    }
    if (frame.kind === 'welcome') return
    if (frame.kind === 'unknown') {
      /*
       * Length and nothing else. Logging the frame body was the obvious way to
       * debug an undocumented wire format, and it is also the one that writes
       * every word of the show — sensitive keywords included — to disk the
       * moment somebody turns on debug logging. Since the frame shape is the
       * thing we could not settle from the document, "unreadable" may well mean
       * *every* line, so this is not a rare path.
       */
      ctx.logger.debug({ bytes: raw.length }, 'prodcom frame not understood')
      return
    }

    if (this.absorb(ctx, frame.entry)) this.publishFeed(ctx)
  }

  // ── The feed ──────────────────────────────────────────────────────────────

  /**
   * Fold one entry into the rolling feed. Returns whether anything changed.
   *
   * Upsert, not append: an entry arrives half-recognised and comes back with
   * the same id when its text settles, and appending would show the sentence
   * twice — once wrong.
   */
  private absorb(ctx: ConnectorContext<ProdComConfig>, entry: ProdComEntry): boolean {
    const channel = this.channels.find((each) => each.id === entry.channelId) ?? null
    /*
     * An entry from a channel we have never heard of is only welcome when no
     * filter is set. Skipping the check for unknown channels let a channel
     * added mid-show — or a group id, or anything else this API might put in
     * the field — onto a wall that was deliberately narrowed to two channels.
     */
    const wanted =
      channel !== null
        ? channelWanted(channel, ctx.config.channels)
        : ctx.config.channels.length === 0 ||
          ctx.config.channels.some((each) => {
            const trimmed = each.trim().toLowerCase()
            return (
              trimmed === entry.channelId.toLowerCase() ||
              trimmed === (entry.channelName ?? '').toLowerCase()
            )
          })
    if (!wanted) return false
    if (entry.live && !ctx.config.includeInProgress) return false

    const message = feedMessageFrom(entry, channel, this.termsForChannel(ctx, channel))

    /*
     * Refuse anything from before the purge, rather than only forgetting what
     * we already held.
     *
     * ProdCom serves its transcript as a window and this module re-reads it —
     * every few seconds, and wholesale when the stream drops and it backfills
     * — so purged lines are offered to us again and again for as long as they
     * sit in that window.
     *
     * **Belt and braces, and honestly labelled as such.** `publishFeed` applies
     * the watermark before every publish, so a re-admitted line could not
     * reach a screen even without this check; there is deliberately no
     * mutation guard on it, because removing it changes nothing observable.
     * What it buys is that the text is never held in this process at all,
     * which is worth a line of code for the one feature whose whole purpose is
     * that somebody has asked for those words to stop existing on screens.
     */
    if (message.at <= ctx.purgedBefore()) return false

    const existing = this.messages.get(message.id)
    if (existing && existing.text === message.text && existing.live === message.live) return false

    this.messages.set(message.id, message)
    this.revision += 1
    this.trim(ctx)

    const seen = this.activity.get(entry.channelId)
    if (seen) seen.lastHeardAt = message.at

    // Only a settled line goes in the show's record. A half-heard sentence that
    // happens to contain a watched word is not yet evidence of anything, and it
    // would be superseded a moment later by the real one.
    if (!message.live && message.flags.length > 0) this.record(ctx, message)

    return true
  }

  private trim(ctx: ConnectorContext<ProdComConfig>): void {
    const limit = ctx.config.feedLimit
    if (this.messages.size <= limit) return
    // Same order the widget draws in, so a same-millisecond pair is never
    // evicted in a different order than it was shown.
    for (const message of this.ordered().slice(0, this.messages.size - limit)) {
      this.messages.delete(message.id)
    }
  }

  private ordered(): FeedMessage[] {
    return [...this.messages.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  }

  /**
   * Forgets everything said at or before the purge watermark.
   *
   * **The store, rather than each publish.** `feed` and `watch.mentions` both
   * derive from `this.messages`, and so does the text a watch-word condition
   * quotes into a new alert; dropping the messages here covers all three at
   * once and leaves no path by which a purged line could still be published.
   * Filtering at each publish would be three chances to miss one, and the
   * third — a condition quoting a line into a fresh alert — would put the
   * sensitive words straight back on a screen the moment somebody said the
   * watch-word again.
   *
   * Deleted from memory rather than flagged, because there is no reason to
   * keep them here: the database has the record, and this process holding the
   * only other copy of a line somebody asked to have hidden is not a thing to
   * be relaxed about.
   */
  private applyPurge(ctx: ConnectorContext<ProdComConfig>): void {
    const before = ctx.purgedBefore()
    if (before <= 0) return

    let removed = 0
    for (const [id, message] of this.messages) {
      if (message.at > before) continue
      this.messages.delete(id)
      removed += 1
    }
    if (removed === 0) return

    // A purge is a change the feed has to be told about, and the revision is
    // what `publishFeed` checks — without this the widgets would keep the last
    // published payload, which is precisely the one being taken down.
    //
    // Deliberately does not publish: `publishFeed` calls this, and the two
    // calling each other is a stack overflow at the worst possible moment.
    // Every caller publishes straight afterwards.
    this.revision += 1
    ctx.logger.info({ removed, before }, 'purged comms messages from the feed')
  }

  private publishFeed(ctx: ConnectorContext<ProdComConfig>): void {
    // Before the revision check, not after: a purge changes what may be sent
    // and must not wait for the five-second tick. A line said a moment after
    // somebody pressed the button would otherwise republish the whole store,
    // purged messages included, before the tick came round.
    this.applyPurge(ctx)
    if (this.revision === this.publishedRevision) return
    this.publishedRevision = this.revision
    ctx.publish('feed', { messages: this.ordered() })
  }

  /**
   * One flagged line, on its own, for the timeline.
   *
   * Kept separate from the feed because `history: 'events'` writes the entire
   * payload to the activity table on every change — a rolling window would put
   * a complete copy of the last sixty lines in the show record for every single
   * new one. This carries ProdCom's entry id as well as the text, which matters
   * more than it looks: the recorder de-duplicates on an exact match of the
   * previous payload, so without the id the *second* time somebody says the same
   * thing would be silently dropped.
   */
  private record(ctx: ConnectorContext<ProdComConfig>, message: FeedMessage): void {
    if (this.recordedIndex.has(message.id)) return
    this.recordedIndex.add(message.id)
    this.recorded.push(message.id)
    while (this.recorded.length > RECORDED_MEMORY) {
      const dropped = this.recorded.shift()
      if (dropped !== undefined) this.recordedIndex.delete(dropped)
    }
    ctx.publish('mention', {
      id: message.id,
      text: message.text,
      at: message.at,
      channel: message.channel,
      channelId: message.channelId,
      keywords: message.flags.map((flag) => flag.keyword),
      // `sources`, plural, matching `watch.mentions`. It was a scalar taken
      // from whichever flag happened to be first, which is both a different
      // name and a different shape for the same fact.
      sources: [...new Set(message.flags.map((flag) => flag.source))],
    })
  }

  private publishCatalogue(
    ctx: ConnectorContext<ProdComConfig>,
    wanted: readonly ProdComChannel[],
  ): void {
    const payload = {
      channels: wanted.map((channel) => ({
        id: channel.id,
        name: channel.name,
        colour: channel.colour,
        sourceType: channel.sourceType,
        locale: channel.locale,
        typingEnabled: channel.typingEnabled,
      })),
      groups: this.groups.map((group) => ({
        id: group.id,
        name: group.name,
        channelIds: group.channelIds,
      })),
      /*
       * Sensitive terms are stripped, not merely flagged.
       *
       * They have to be *in* the term list on this side — that is what drives
       * the redaction — but sending them on would hand every tablet the exact
       * words we just blanked. Worse than that: `redact` preserves length, so a
       * client holding the asterisked line and the keyword list can match run
       * length to keyword and work out which secret was said. The widget never
       * needs them; a redacted line already says it was redacted.
       */
      keywords: this.termsForChannel(ctx, null)
        .filter((term) => !term.sensitive)
        .map((term) => ({
          id: term.id,
          text: term.text,
          colour: term.colour ?? null,
          source: term.source,
          whole: term.whole ?? false,
        })),
      // `replacementText` is a display override, so it travels to the widget
      // rather than being applied here — baking it into the stored text would
      // destroy the original.
      replacements: this.keywords
        .filter((keyword) => keyword.replacement !== null && !keyword.sensitive)
        .map((keyword) => ({ text: keyword.text, as: keyword.replacement })),
    }

    const key = JSON.stringify(payload)
    if (key !== this.lastChannelsKey) {
      this.lastChannelsKey = key
      ctx.publish('channels', payload)
    }

    const status = {
      version: this.status?.version ?? 'unknown',
      platform: this.status?.platform ?? 'unknown',
      configuration: this.status?.configuration ?? '',
      channelCount: wanted.length,
      keywordCount: this.keywords.length,
    }
    const statusKey = JSON.stringify(status)
    if (statusKey !== this.lastStatusKey) {
      this.lastStatusKey = statusKey
      ctx.publish('status', status)
    }
  }

  /**
   * The clock.
   *
   * `HealthEngine` only re-evaluates a condition when that condition's stream
   * publishes — a sweep never re-runs one against the last payload it saw. So a
   * condition about the *absence* of speech, or one that should expire after a
   * minute, has nothing to think with unless something keeps ticking. This is
   * that something, and both conditions read it.
   *
   * It also feeds the watchdog: a socket that has stopped delivering while
   * still being open is the failure this module is most likely to suffer.
   */
  private tick(ctx: ConnectorContext<ProdComConfig>): void {
    const now = Date.now()
    this.applyPurge(ctx)
    const recent = this.ordered().filter((message) => !message.live && message.flags.length > 0)

    ctx.publish('watch', {
      at: now,
      channels: [...this.activity.entries()].map(([id, seen]) => {
        const channel = this.channels.find((each) => each.id === id)
        return {
          id,
          name: channel?.name ?? id,
          lastHeardAt: seen.lastHeardAt,
          // Null until the channel has ever been heard from: a channel nobody
          // has spoken on since the module started is not the same as one that
          // has just gone dead, and a condition must be able to tell them apart.
          quietSeconds:
            seen.lastHeardAt === null ? null : Math.round((now - seen.lastHeardAt) / 1_000),
        }
      }),
      mentions: recent.slice(-10).map((message) => ({
        id: message.id,
        at: message.at,
        text: message.text,
        channel: message.channel,
        channelId: message.channelId,
        keywords: message.flags.map((flag) => flag.keyword),
        sources: [...new Set(message.flags.map((flag) => flag.source))],
      })),
    })
  }

  /**
   * Has the feed stopped, while the socket stays politely open?
   *
   * Counts transcript entries only. A ProdCom whose recogniser has died still
   * answers heartbeats and still serves HTTP, so letting either of those keep
   * the deadline alive would reinstate the exact failure this exists to catch:
   * a green badge over a frozen feed.
   */
  private setDegraded(ctx: ConnectorContext<ProdComConfig>, detail: string): void {
    if (this.degradedDetail === detail) return
    this.degradedDetail = detail
    ctx.setStatus('degraded', detail)
  }
}

export const prodcomModule: ConnectorModule<ProdComConfig> = {
  meta: {
    typeId: 'prodcom',
    displayName: 'ProdCom',
    description:
      'Live comms transcribed by ProdCom, with the words that matter picked out of the traffic.',
    configSchema,
    streams: [
      /*
       * `history: 'none'`, and it has to be. The recorder writes an entire
       * `events` payload to the activity table on every change, so a rolling
       * window of sixty lines would put sixty lines in the show record for each
       * new one. `mention` carries the history instead.
       */
      { id: 'feed', label: 'Transcript', rateClass: 'change', history: 'none' },
      {
        id: 'mention',
        label: 'Flagged lines',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'text', kind: 'string', label: 'Line' },
          { id: 'channel', kind: 'string', label: 'Channel' },
        ],
      },
      // The clock. `slow` rather than `change` on purpose: a stream that ticks
      // is eligible for the platform's own staleness check, so a ProdCom that
      // stops answering raises a problem without this module doing anything.
      { id: 'watch', label: 'Channel activity', rateClass: 'slow', history: 'none' },
      { id: 'channels', label: 'Channels', rateClass: 'change', history: 'none' },
      {
        id: 'status',
        label: 'Status',
        rateClass: 'change',
        history: 'none',
        fields: [
          { id: 'configuration', kind: 'string', label: 'Configuration' },
          { id: 'version', kind: 'string', label: 'Version' },
          { id: 'channelCount', kind: 'number', label: 'Channels' },
        ],
      },
    ],
    commands: [],
    conditions: prodcomConditions,
    capabilities: { control: false },
    tier: 'caveated',
    vendorNotes:
      'Written against the published ProdCom OpenAPI document (version 0.1.0), which the ' +
      'vendor still lists as in development. The document specifies the WebSocket handshake ' +
      'and heartbeat but never the shape of an event frame, so the frame reader accepts a ' +
      'transcript entry in any of the obvious wrappers and a fully-specified REST poll runs ' +
      'underneath it — an unreadable socket costs latency, not data. Needs the API enabled in ' +
      "ProdCom's settings; the pre-shared key is optional there and optional here. Read-only: " +
      'ProdCom can be driven over this API, but nothing in this module writes to it.',
  },
  create: () => new ProdComConnector(),
  createSimulator: () => new ProdComSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
