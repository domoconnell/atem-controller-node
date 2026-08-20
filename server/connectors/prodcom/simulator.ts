import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { SimulatorHandle } from '../core/types.js'

/**
 * A ProdCom, faked.
 *
 * **Every string in this file is written out literally, from the published
 * OpenAPI document.** It deliberately imports nothing from `protocol.ts`. The
 * reason is the one the Smaart pair records: sharing a constants block makes a
 * wrong verb wrong *symmetrically*, so the connector and the fake agree
 * perfectly on a protocol neither of them is speaking, and every integration
 * test passes. Two independent transcriptions can both be wrong; they cannot
 * easily be wrong in the same direction.
 *
 * One server on one port, routed on the request path, because that is what
 * ProdCom is: HTTP for the catalogue and the transcript, a WebSocket upgrade at
 * `/api/v1/ws`, and Server-Sent Events at `/api/v1/transcript/stream`.
 */

interface SimKeyword {
  id: string
  text: string
  shouldHighlight: boolean
  highlightColor: string | null
  replacementText: string | null
  isSensitive: boolean
}

interface SimChannel {
  id: string
  name: string
  color: string | null
  sourceType: string
  speechLocale: string | null
  typingEnabled: boolean
  unreadCount: number
  keywords: SimKeyword[]
}

interface SimEntry {
  id: string
  /** Internal: what the entry says once recognition finishes. */
  fullText: string
  channelId: string
  channelName: string
  text: string
  source: string
  inProgress: boolean
  hasBeenSeen: boolean
  date: string
  completeDate: string | null
  seenDate: string | null
  translatedText: string | null
  triggeredAutomations: string[]
}

const DEFAULT_CHANNELS: SimChannel[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Stage Left TB',
    color: '#FF6B35',
    sourceType: 'localAudio',
    speechLocale: 'en-GB',
    typingEnabled: false,
    unreadCount: 0,
    keywords: [],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'FOH',
    color: '#4A90D9',
    sourceType: 'localAudio',
    speechLocale: 'en-GB',
    typingEnabled: true,
    unreadCount: 0,
    keywords: [],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Monitors',
    color: '#5FBF77',
    sourceType: 'network',
    speechLocale: 'en-GB',
    typingEnabled: false,
    unreadCount: 0,
    keywords: [],
  },
]

/**
 * Includes a sensitive one on purpose.
 *
 * `isSensitive` is the only part of ProdCom's keyword model with a consequence
 * beyond colour, and it is the part the demo dashboard should be exercising in
 * front of people: if the redaction ever regresses, a room full of visitors is
 * where you find out.
 */
const DEFAULT_KEYWORDS: SimKeyword[] = [
  {
    id: 'kw-001',
    text: 'standby',
    shouldHighlight: true,
    highlightColor: '#FFFF00',
    replacementText: null,
    isSensitive: false,
  },
  {
    id: 'kw-002',
    text: 'cue',
    shouldHighlight: true,
    highlightColor: '#00FF00',
    replacementText: null,
    isSensitive: false,
  },
  {
    id: 'kw-003',
    text: 'medical',
    shouldHighlight: true,
    highlightColor: '#FF0000',
    replacementText: null,
    isSensitive: false,
  },
  {
    id: 'kw-004',
    text: 'door code',
    shouldHighlight: true,
    highlightColor: null,
    replacementText: null,
    isSensitive: true,
  },
]

/**
 * Show chatter, in a loop.
 *
 * The first line trips a default keyword deliberately. Three separate checks
 * depend on this rig talking, and talking about something flagged, within a
 * couple of seconds of connecting: the end-to-end overflow sweep refuses to
 * measure a dashboard whose widgets have nothing in them, the callouts widget
 * would otherwise be an empty box in every screenshot, and `field-decl.test.ts`
 * fails any stream that emits nothing — which would include `mention`.
 */
const SCRIPT: { channel: number; text: string }[] = [
  { channel: 0, text: 'Standby for cue 12, go on my mark' },
  { channel: 1, text: 'Copy that, holding' },
  { channel: 2, text: 'Can I get a little more vocal in three' },
  { channel: 0, text: 'Dave to stage left when you have a moment' },
  { channel: 1, text: 'House lights coming down now' },
  { channel: 2, text: 'That is better, thank you' },
  { channel: 0, text: 'The door code is four seven two one' },
  { channel: 1, text: 'Interval in ten minutes' },
]

/** Brisk, so a test need not wait and the demo board is never empty. */
const LINE_INTERVAL_MS = 700
/** How long a line sits half-recognised before it firms up. */
const COMPLETE_AFTER_MS = 300
/**
 * Brisk, like the rest of this file, so a test need not wait.
 *
 * A real ProdCom's keep-alive interval is not documented and is on the list of
 * things to settle on the bench — it matters, because the watchdog deadline has
 * to sit comfortably above it.
 */
const HEARTBEAT_MS = 1_000

export class ProdComSimulator implements SimulatorHandle {
  private server: Server | null = null
  private sockets: WebSocketServer | null = null
  private streams = new Set<ServerResponse>()
  private ticker: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private pending: NodeJS.Timeout[] = []

  private channels = DEFAULT_CHANNELS.map((channel) => ({ ...channel }))
  private keywords = DEFAULT_KEYWORDS.map((keyword) => ({ ...keyword }))
  private groups = [
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'All stage',
      channelIds: [DEFAULT_CHANNELS[0]?.id ?? '', DEFAULT_CHANNELS[2]?.id ?? ''],
      shareOnNetwork: true,
      keywords: [] as SimKeyword[],
    },
  ]

  private entries: SimEntry[] = []
  private nextLine = 0
  private seq = 0
  private emitting = true
  private garbage = false
  private failing = false
  private apiKey: string | null = null

  /** Assertion surfaces. */
  subscriptions: string[][] = []
  transcriptQueries: Record<string, string>[] = []
  heartbeatsEchoed = 0
  rejectedRequests = 0

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((request, response) => this.route(request, response))
    this.sockets = new WebSocketServer({ noServer: true })

    this.server.on('upgrade', (request, socket, head) => {
      if (!(request.url ?? '').startsWith('/api/v1/ws')) {
        socket.destroy()
        return
      }
      if (!this.authorised(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        this.rejectedRequests += 1
        return
      }
      this.sockets?.handleUpgrade(request, socket, head, (client) => {
        this.sockets?.emit('connection', client, request)
      })
    })

    this.sockets.on('connection', (client) => {
      // The welcome frame ProdCom 2.3.2 actually sends, streams list and all —
      // including `activity`, which the specification calls `channel`.
      client.send(
        JSON.stringify({
          type: 'welcome',
          streams: ['transcript', 'status', 'automation', 'activity'],
          message: 'Connected to ProdCom WebSocket API',
        }),
      )
      client.on('message', (raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(raw))
        } catch {
          return
        }
        if (typeof parsed !== 'object' || parsed === null) return
        const frame = parsed as Record<string, unknown>
        if (frame.type === 'subscribe' && Array.isArray(frame.events)) {
          this.subscriptions.push(frame.events.map(String))
        }
        if (frame.type === 'heartbeat') this.heartbeatsEchoed += 1
      })
      client.on('error', () => {})
    })

    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve))
    const address = this.server.address() as AddressInfo
    this.start()
    return { host, port: address.port }
  }

  async close(): Promise<void> {
    this.stop()
    for (const stream of this.streams) stream.end()
    this.streams.clear()

    const sockets = this.sockets
    this.sockets = null
    if (sockets) {
      for (const client of sockets.clients) client.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
    }

    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  dropConnections(): void {
    for (const client of this.sockets?.clients ?? []) client.terminate()
    this.server?.closeAllConnections?.()
  }

  sendGarbage(): void {
    this.garbage = true
    this.broadcast('not json at all {{{')
    for (const stream of this.streams) stream.write('event: nonsense\ndata: {{{ not json\n\n')
  }

  /** Answer everything with a 503, as a machine that has fallen over would. */
  setFailing(failing: boolean): void {
    this.failing = failing
  }

  /** How many event-stream readers are attached. */
  get streamCount(): number {
    return this.streams.size
  }

  /** Resolves once the connector is reading the event stream. */
  async whenStreaming(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.streams.size === 0) {
      if (Date.now() > deadline) throw new Error('no ProdCom event-stream reader in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  stopEmitting(): void {
    this.emitting = false
  }

  /**
   * Stop the keep-alive as well, which is what a genuinely dead socket looks
   * like — as opposed to a quiet room, which `stopEmitting` alone models.
   */
  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** Settle the named entry, keeping its id — the mutation clients get wrong. */
  complete(id: string): void {
    this.completeEntry(id)
  }

  /**
   * Speak from a channel that is not in the catalogue.
   *
   * ProdCom's transcript entries carry a `channelId` and nothing promises it
   * matches something `/channels` returned — a channel added since the last
   * poll, or a group, would both land here.
   */
  sayUnknownChannel(text: string): void {
    this.emit(
      {
        id: '99999999-9999-4999-8999-999999999999',
        name: 'Not in the catalogue',
        color: null,
        sourceType: 'localAudio',
        speechLocale: null,
        typingEnabled: false,
        unreadCount: 0,
        keywords: [],
      },
      text,
      false,
    )
  }

  resumeEmitting(): void {
    this.emitting = true
  }

  setApiKey(key: string | null): void {
    this.apiKey = key
  }

  setKeywords(keywords: SimKeyword[]): void {
    this.keywords = keywords
  }

  setChannels(channels: SimChannel[]): void {
    this.channels = channels
  }

  /** How many live WebSocket clients are attached. */
  get clientCount(): number {
    return this.sockets?.clients.size ?? 0
  }

  /**
   * Resolves once a client is listening.
   *
   * Tests need this because the connector reports itself online as soon as the
   * REST backfill parses, which is deliberately *before* its socket finishes
   * connecting — the socket is an optimisation over a poll that already works.
   * Without waiting, a test that says something immediately after "online" is
   * racing the handshake, and a test that drops connections finds none.
   */
  async whenConnected(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.clientCount === 0) {
      if (Date.now() > deadline) throw new Error('no ProdCom client connected in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** Say something now, rather than waiting for the script to come round. */
  say(channelIndex: number, text: string, options: { live?: boolean } = {}): SimEntry | null {
    const channel = this.channels[channelIndex]
    if (!channel) return null
    return this.emit(channel, text, options.live ?? false)
  }

  private start(): void {
    this.ticker = setInterval(() => {
      if (!this.emitting) return
      const line = SCRIPT[this.nextLine % SCRIPT.length]
      this.nextLine += 1
      const channel = this.channels[line?.channel ?? 0] ?? this.channels[0]
      if (!channel || !line) return

      // Emitted half-recognised first, then completed. This mutation is the
      // behaviour most likely to be got wrong by a client, and a simulator that
      // only ever produced finished lines would hide every bug in it.
      const entry = this.emit(channel, line.text, true)
      const timer = setTimeout(() => this.completeEntry(entry.id), COMPLETE_AFTER_MS)
      this.pending.push(timer)
    }, LINE_INTERVAL_MS)

    this.heartbeat = setInterval(() => {
      // `ping`, not `heartbeat`. The document says the latter; the software
      // sends the former, roughly every thirty seconds, and is content with no
      // reply at all.
      this.broadcast(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_MS)
  }

  private stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const timer of this.pending) clearTimeout(timer)
    this.ticker = null
    this.heartbeat = null
    this.pending = []
  }

  private emit(channel: SimChannel, text: string, live: boolean): SimEntry {
    this.seq += 1
    const now = new Date()
    const entry: SimEntry = {
      id: `e${this.seq}-0000-4000-8000-00000000${String(this.seq).padStart(4, '0')}`,
      channelId: channel.id,
      channelName: channel.name,
      // Half a sentence while it is still being recognised, which is what the
      // recogniser actually does.
      text: live ? text.slice(0, Math.max(4, Math.floor(text.length / 2))) : text,
      // What the recogniser will settle on. Kept here so completing an entry
      // restores what was actually said, rather than guessing.
      fullText: text,
      source: 'audio',
      inProgress: live,
      hasBeenSeen: false,
      date: now.toISOString(),
      completeDate: live ? null : now.toISOString(),
      seenDate: null,
      translatedText: null,
      triggeredAutomations: [],
    }
    this.entries.push(entry)
    if (this.entries.length > 400) this.entries.shift()
    this.push(entry)
    return entry
  }

  private completeEntry(id: string): void {
    const entry = this.entries.find((each) => each.id === id)
    if (!entry) return
    /*
     * The full text was remembered when the entry was emitted.
     *
     * This used to look the line back up in `SCRIPT` by its first four
     * characters, which quietly rewrote any line a test had injected itself
     * into whichever scripted line happened to share a prefix — so an
     * upsert test that said "Standby for the walk-up music" got back
     * "Standby for cue 12" and could never find what it was looking for.
     */
    entry.text = entry.fullText
    entry.inProgress = false
    entry.completeDate = new Date().toISOString()
    // Same id, deliberately: a completing entry replaces the half-heard one
    // rather than arriving as a second line.
    this.push(entry)
  }

  /**
   * Down the event stream, and *not* down the WebSocket.
   *
   * This is the fidelity that matters most in this file. ProdCom 2.3.2
   * advertises a `transcript` stream in its welcome frame and then never sends
   * one — ninety seconds of real speech across the socket produced three pings
   * and nothing else. A simulator that pushed transcript frames over the
   * socket would have let the connector look perfect in tests and show an
   * empty widget on the night.
   */
  private push(entry: SimEntry): void {
    const name =
      entry.inProgress && entry.text.length > 0 ? 'transcript.updated' : 'transcript.added'
    for (const stream of this.streams) {
      stream.write(`event: ${name}\ndata: ${JSON.stringify(entry)}\n\n`)
    }
  }

  /**
   * Send an entry over the WebSocket instead, as a future firmware might.
   *
   * The connector still reads socket frames, because the vendor documents them
   * as the live path and this is a 0.1.0 API. Nothing exercises that unless a
   * test asks for it — hence this.
   */
  sayOverSocket(text: string): void {
    const channel = this.channels[0]
    if (!channel) return
    this.seq += 1
    const now = new Date().toISOString()
    this.broadcast(
      JSON.stringify({
        type: 'transcript',
        data: {
          id: `ws${this.seq}-0000-4000-8000-000000000000`,
          channelId: channel.id,
          channelName: channel.name,
          text,
          source: 'audio',
          inProgress: false,
          hasBeenSeen: false,
          date: now,
          completeDate: now,
        },
      }),
    )
  }

  private broadcast(frame: string): void {
    for (const client of this.sockets?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(frame)
    }
  }

  private authorised(request: IncomingMessage): boolean {
    if (this.apiKey === null) return true
    const header = request.headers.authorization
    if (header === `Bearer ${this.apiKey}`) return true
    const asked = new URL(request.url ?? '/', 'http://simulator')
    return asked.searchParams.get('key') === this.apiKey
  }

  private route(request: IncomingMessage, response: ServerResponse): void {
    const asked = new URL(request.url ?? '/', 'http://simulator')
    const path = asked.pathname.replace(/\/+$/, '')

    if (!this.authorised(request)) {
      this.rejectedRequests += 1
      this.fail(response, 401, 'UNAUTHORIZED', 'API key required')
      return
    }

    if (this.failing) {
      this.fail(response, 503, 'INTERNAL_ERROR', 'ProdCom is not well')
      return
    }

    if (this.garbage) {
      this.garbage = false
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":')
      return
    }

    if (path === '/api/v1/ping') {
      this.ok(response, { pong: true })
      return
    }
    if (path === '/api/v1/status') {
      this.ok(response, {
        version: '2.3.0',
        platform: 'macOS',
        uptime: 3621.5,
        activeConfigurationName: 'Simulated Show',
        channelCount: this.channels.length,
        apiPort: (this.server?.address() as AddressInfo | null)?.port ?? 24480,
        oscPort: 9000,
        networkBroadcastPort: null,
      })
      return
    }
    if (path === '/api/v1/channels') {
      this.ok(response, this.channels)
      return
    }
    if (path === '/api/v1/groups') {
      this.ok(response, this.groups)
      return
    }
    if (path === '/api/v1/keywords') {
      this.ok(response, this.keywords)
      return
    }
    if (path === '/api/v1/items') {
      this.ok(response, [
        ...this.channels.map((channel) => ({
          type: 'channel',
          id: channel.id,
          name: channel.name,
          channel,
        })),
        ...this.groups.map((group) => ({
          type: 'group',
          id: group.id,
          name: group.name,
          group,
        })),
      ])
      return
    }
    if (path === '/api/v1/transcript/stream') {
      this.openStream(request, response)
      return
    }
    if (path === '/api/v1/transcript') {
      this.transcript(asked, response)
      return
    }

    this.fail(response, 404, 'NOT_FOUND', `no route for ${path}`)
  }

  private transcript(asked: URL, response: ServerResponse): void {
    const query: Record<string, string> = {}
    for (const [key, value] of asked.searchParams) query[key] = value
    this.transcriptQueries.push(query)

    const rawLimit = Number(query.limit ?? '50')
    // The document says 1..200 with a default of 50, and a real server that
    // clamps is one a client can rely on. A simulator that silently returns
    // more than it was asked for would hide a pagination bug.
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50
    const offset = Math.max(0, Math.trunc(Number(query.offset ?? '0')) || 0)

    let matching = this.entries
    if (query.channelId) {
      const wanted = query.channelId.toLowerCase()
      matching = matching.filter(
        (entry) =>
          entry.channelId.toLowerCase() === wanted || entry.channelName.toLowerCase() === wanted,
      )
    }
    if (query.since) {
      const since = Date.parse(query.since)
      if (Number.isFinite(since)) {
        matching = matching.filter((entry) => Date.parse(entry.date) > since)
      }
    }

    const page = matching.slice(offset, offset + limit)
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        data: page,
        meta: {
          timestamp: new Date().toISOString(),
          totalCount: matching.length,
          hasMore: offset + page.length < matching.length,
        },
      }),
    )
  }

  private openStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    this.streams.add(response)
    request.on('close', () => {
      this.streams.delete(response)
    })
  }

  private ok(response: ServerResponse, data: unknown): void {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data, meta: { timestamp: new Date().toISOString() } }))
  }

  private fail(response: ServerResponse, status: number, code: string, message: string): void {
    response
      .writeHead(status, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ error: { code, message }, meta: { timestamp: new Date().toISOString() } }),
      )
  }
}
