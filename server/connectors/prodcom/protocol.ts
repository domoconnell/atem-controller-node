import { findMatches, redact, type Span, type Term, WHOLE_WORD_BY_DEFAULT } from '@stageit/shared'

/**
 * Reading ProdCom, without any I/O.
 *
 * Written against the published OpenAPI 3.1 document (`/docs/openapi.yaml`,
 * version 0.1.0, MIT). Two things about that document shape everything here.
 *
 * The first is that it is honest about most of the API and silent about one
 * part: it documents the WebSocket's `welcome`, `heartbeat` and `subscribe`
 * frames and then never says what an *event* frame looks like. `readEventFrame`
 * is therefore written to recognise a transcript entry wherever it is wrapped,
 * and to shrug at anything else. The REST endpoints underneath it are fully
 * specified, so a socket we cannot read costs latency and not data.
 *
 * The second is that a transcript entry carries no record of which keywords it
 * tripped — ProdCom ships the rules and does the matching at render time. So
 * `feedMessageFrom` does the matching here instead, once, on the way past.
 */

// ── The envelope ────────────────────────────────────────────────────────────

/** The closed set the API documents. Anything else is a broken deployment. */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'METHOD_NOT_ALLOWED',
  'NOT_IMPLEMENTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export class ProdComError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProdComError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const bool = (value: unknown): boolean => value === true
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Pull `data` out of `{data, meta}`, or throw what the server complained about.
 *
 * The error branch matters more than it looks: an expired or wrong pre-shared
 * key comes back as a perfectly well-formed `UNAUTHORIZED` body with a 401, and
 * a connector that only checked the HTTP status would report "no reply from
 * ProdCom" for what is actually a typo in a settings field.
 */
export function unwrap(body: unknown): unknown {
  if (!isRecord(body))
    throw new ProdComError('INTERNAL_ERROR', 'ProdCom sent a reply we could not read')

  const error = body.error
  if (isRecord(error)) {
    throw new ProdComError(
      str(error.code) ?? 'INTERNAL_ERROR',
      str(error.message) ?? 'ProdCom refused the request without saying why',
    )
  }

  return body.data
}

/** Whether an error means the key is wrong, which reconnecting will not fix. */
export function isAuthError(error: unknown): boolean {
  return error instanceof ProdComError && error.code === 'UNAUTHORIZED'
}

/**
 * ISO 8601 to milliseconds.
 *
 * Returns null rather than `NaN` for anything unparseable: a `NaN` timestamp
 * sorts unpredictably and renders as "Invalid Date" on a wall display, and the
 * caller can drop the entry instead.
 */
export function parseTimestamp(value: unknown): number | null {
  const text = str(value)
  if (text === null) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

// ── The objects ─────────────────────────────────────────────────────────────

export interface ProdComStatus {
  version: string
  platform: string
  configuration: string
  channelCount: number
}

export interface ProdComKeyword {
  id: string
  text: string
  highlight: boolean
  colour: string | null
  replacement: string | null
  sensitive: boolean
}

export interface ProdComChannel {
  id: string
  name: string
  colour: string | null
  sourceType: string
  locale: string | null
  typingEnabled: boolean
  unread: number
  keywords: ProdComKeyword[]
}

export interface ProdComGroup {
  id: string
  name: string
  channelIds: string[]
  keywords: ProdComKeyword[]
}

export type EntrySource = 'audio' | 'typed' | 'automation'

export interface ProdComEntry {
  id: string
  channelId: string
  channelName: string | null
  text: string
  source: EntrySource
  live: boolean
  at: number
  completedAt: number | null
  translated: string | null
}

const ENTRY_SOURCES: readonly string[] = ['audio', 'typed', 'automation']

export function parseStatus(data: unknown): ProdComStatus | null {
  if (!isRecord(data)) return null
  return {
    version: str(data.version) ?? 'unknown',
    platform: str(data.platform) ?? 'unknown',
    // Not an empty string: `configuration` is this stream's first declared
    // string, so a newly added state light binds to it, and a ProdCom that
    // omits the field would leave that widget permanently blank.
    configuration: str(data.activeConfigurationName) || 'Unnamed configuration',
    channelCount: num(data.channelCount) ?? 0,
  }
}

export function parseKeyword(value: unknown): ProdComKeyword | null {
  if (!isRecord(value)) return null
  const text = str(value.text)
  if (text === null || text.trim().length === 0) return null
  return {
    id: str(value.id) ?? `kw:${text}`,
    text,
    // Absent means true: the API marks `shouldHighlight` optional, and a
    // keyword an operator bothered to create is one they want to see.
    highlight: value.shouldHighlight !== false,
    colour: str(value.highlightColor),
    replacement: str(value.replacementText),
    sensitive: bool(value.isSensitive),
  }
}

/**
 * A rig cannot make us do unbounded work.
 *
 * Matching is O(terms x text) per line and runs on the server thread before
 * anything is published, so a configuration with thousands of one-character
 * keywords would stall the connector and then fan the stall out to every
 * browser. Nobody has a real list this long; a rig that reports one is broken
 * or hostile, and either way the cap is the right answer.
 */
export const MAX_KEYWORDS = 500
/** Long enough for any real utterance, short enough not to be a weapon. */
export const MAX_TEXT_LENGTH = 4_000

export function parseKeywords(data: unknown): ProdComKeyword[] {
  if (!Array.isArray(data)) return []
  return data
    .slice(0, MAX_KEYWORDS)
    .map(parseKeyword)
    .filter((keyword): keyword is ProdComKeyword => keyword !== null)
}

/**
 * Did the catalogue actually parse, or did it merely come back empty?
 *
 * The difference decides whether redaction is safe. "No keywords configured"
 * and "this 0.1.0 API changed shape under us" both produce an empty list, and
 * treating the second as the first publishes every line unredacted with no
 * status change to show for it.
 */
export function looksLikeList(data: unknown): boolean {
  return Array.isArray(data)
}

export function parseChannel(value: unknown): ProdComChannel | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  if (id === null) return null
  return {
    id,
    name: str(value.name) ?? id,
    colour: str(value.color),
    sourceType: str(value.sourceType) ?? 'localAudio',
    locale: str(value.speechLocale),
    typingEnabled: bool(value.typingEnabled),
    unread: num(value.unreadCount) ?? 0,
    keywords: parseKeywords(value.keywords),
  }
}

export function parseChannels(data: unknown): ProdComChannel[] {
  if (!Array.isArray(data)) return []
  return data.map(parseChannel).filter((channel): channel is ProdComChannel => channel !== null)
}

export function parseGroups(data: unknown): ProdComGroup[] {
  if (!Array.isArray(data)) return []
  const groups: ProdComGroup[] = []
  for (const value of data) {
    if (!isRecord(value)) continue
    const id = str(value.id)
    if (id === null) continue
    groups.push({
      id,
      name: str(value.name) ?? id,
      channelIds: Array.isArray(value.channelIds)
        ? value.channelIds.filter((each): each is string => typeof each === 'string')
        : [],
      keywords: parseKeywords(value.keywords),
    })
  }
  return groups
}

export function parseEntry(value: unknown): ProdComEntry | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const raw = str(value.text)
  const text = raw === null ? null : raw.slice(0, MAX_TEXT_LENGTH)
  const at = parseTimestamp(value.date)
  // An entry with no id cannot be de-duplicated against its own completion, and
  // one with no timestamp cannot be placed in the feed. Both are unusable
  // rather than merely odd, so they are dropped here instead of downstream.
  if (id === null || text === null || at === null) return null

  const source = str(value.source)
  return {
    id,
    channelId: str(value.channelId) ?? '',
    channelName: str(value.channelName),
    text,
    source: source !== null && ENTRY_SOURCES.includes(source) ? (source as EntrySource) : 'audio',
    live: bool(value.inProgress),
    at,
    completedAt: parseTimestamp(value.completeDate),
    translated: str(value.translatedText)?.slice(0, MAX_TEXT_LENGTH) ?? null,
  }
}

export interface TranscriptPage {
  entries: ProdComEntry[]
  totalCount: number | null
  hasMore: boolean
}

/** `GET /transcript` — the whole body, because the count lives in `meta`. */
export function parseTranscriptPage(body: unknown): TranscriptPage {
  const data = unwrap(body)
  const entries = Array.isArray(data)
    ? data.map(parseEntry).filter((entry): entry is ProdComEntry => entry !== null)
    : []
  const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {}
  return { entries, totalCount: num(meta.totalCount), hasMore: bool(meta.hasMore) }
}

// ── The live stream ─────────────────────────────────────────────────────────

/**
 * One Server-Sent Events block, as ProdCom actually sends them.
 *
 * Measured on 2.3.2 rather than taken from the document:
 *
 *     event: transcript.added
 *     data: {"id":"77A7…","text":" okay","inProgress":true,…}
 *
 *     event: transcript.updated
 *     data: {"id":"77A7…","text":" okay I'm saying","inProgress":true,…}
 *
 * The `data` payload is the bare entry, and — the part everything here depends
 * on — **the id is stable across updates**. A sentence arrives a word at a
 * time under one id and is upserted in place, which is why the feed shows one
 * line firming up rather than six.
 */
export function parseSseBlock(block: string): ProdComEntry | null {
  let payload = ''
  for (const line of block.split('\n')) {
    // Only `data:` matters. The `event:` name is informative — `added` versus
    // `updated` — but the entry carries `inProgress` and an id, which say the
    // same thing without our having to trust the naming.
    if (line.startsWith('data:')) payload += line.slice(5).trim()
  }
  if (payload.length === 0 || payload === '[DONE]') return null

  try {
    return parseEntry(JSON.parse(payload))
  } catch {
    return null
  }
}

/**
 * Split a buffer into complete SSE blocks, returning the unconsumed remainder.
 *
 * A chunk boundary lands mid-block often enough that not doing this drops
 * lines at random, which is the sort of fault that looks like the recogniser
 * misbehaving rather than like our bug.
 */
export function takeSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  return { blocks: parts.filter((part) => part.trim().length > 0), rest }
}

// ── The WebSocket ───────────────────────────────────────────────────────────

export type EventFrame =
  | { kind: 'welcome' }
  | { kind: 'heartbeat'; reply: boolean }
  | { kind: 'entry'; entry: ProdComEntry }
  | { kind: 'unknown' }

/**
 * Where an event frame might be hiding.
 *
 * Kept, but no longer the main road. ProdCom 2.3.2 advertises a `transcript`
 * stream in its welcome frame and then **never sends one** — ninety seconds of
 * real speech across the socket produced `welcome` and three `ping`s and
 * nothing else, under all four plausible spellings of the subscribe frame. The
 * live path is Server-Sent Events; see `parseSseBlock`.
 *
 * This stays because the socket is still worth holding open for the day a
 * firmware starts using it, and because reading an entry out of whatever
 * wrapper it eventually arrives in costs nothing.
 */
const ENTRY_KEYS = ['data', 'entry', 'transcript', 'payload', 'transcriptEntry'] as const

export function readEventFrame(raw: string): EventFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unknown' }
  }
  if (!isRecord(parsed)) return { kind: 'unknown' }

  const type = str(parsed.type)
  if (type === 'welcome') return { kind: 'welcome' }
  /*
   * Two names for the keep-alive, because the document and the software
   * disagree.
   *
   * The specification says the server sends `heartbeat` and the client echoes
   * it. ProdCom 2.3.2 on the bench sends `{"type":"ping"}` about every thirty
   * seconds and is perfectly content with no reply at all — a socket left
   * silent for ninety-five seconds stayed open. So: both are recognised as
   * proof of life, and only the documented one is answered. Replying to
   * something a server did not ask to have answered is a good way to find out
   * how strict it is, on a show.
   */
  if (type === 'heartbeat') return { kind: 'heartbeat', reply: true }
  if (type === 'ping') return { kind: 'heartbeat', reply: false }

  const direct = parseEntry(parsed)
  if (direct !== null) return { kind: 'entry', entry: direct }

  for (const key of ENTRY_KEYS) {
    const nested = parseEntry(parsed[key])
    if (nested !== null) return { kind: 'entry', entry: nested }
  }

  return { kind: 'unknown' }
}

// ── Turning an entry into something a widget can draw ───────────────────────

export interface MessageFlag {
  keyword: string
  source: 'prodcom' | 'watch'
  colour: string | null
}

/** What the `feed` stream publishes. A superset of the console-message shape. */
export interface FeedMessage {
  id: string
  text: string
  at: number
  channelId: string
  channel: string
  colour: string | null
  source: EntrySource
  live: boolean
  translated: string | null
  redacted: boolean
  flags: MessageFlag[]
}

/**
 * Every keyword this module should be watching for, in one list.
 *
 * ProdCom scopes keywords three ways — global, per channel, per group — and a
 * line should be judged against its own channel's rules plus the global ones,
 * not against every keyword on the machine. The module's own watch words are
 * folded in on top, and are the ones that default to whole-word matching.
 */
export function termsFor(options: {
  global: readonly ProdComKeyword[]
  channel?: ProdComChannel | null
  groups?: readonly ProdComGroup[]
  watchWords?: readonly string[]
  watchWholeWord?: boolean
}): Term[] {
  const terms: Term[] = []
  const seen = new Set<string>()

  const addKeyword = (keyword: ProdComKeyword, scope: string) => {
    if (!keyword.highlight && !keyword.sensitive) return
    const key = `${scope}:${keyword.text.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    terms.push({
      id: keyword.id,
      text: keyword.text,
      colour: keyword.colour,
      sensitive: keyword.sensitive,
      // ProdCom's own documented semantics: a case-insensitive substring. We
      // copy it so our highlighting agrees with the operator's own window.
      whole: false,
      source: 'prodcom',
    })
  }

  for (const keyword of options.global) addKeyword(keyword, 'global')
  if (options.channel) {
    for (const keyword of options.channel.keywords) addKeyword(keyword, 'global')
  }
  for (const group of options.groups ?? []) {
    if (options.channel && !group.channelIds.includes(options.channel.id)) continue
    for (const keyword of group.keywords) addKeyword(keyword, 'global')
  }

  for (const word of options.watchWords ?? []) {
    const text = word.trim()
    if (text.length === 0) continue
    const key = `watch:${text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({
      id: `watch:${text}`,
      text,
      colour: null,
      sensitive: false,
      whole: options.watchWholeWord ?? WHOLE_WORD_BY_DEFAULT,
      source: 'watch',
    })
  }

  return terms
}

/**
 * An entry plus the rules, ready to publish.
 *
 * Redaction happens here rather than in the browser, and that is the whole
 * point of doing it on this side: a keyword ProdCom marks sensitive is one the
 * operator does not want on a screen, and publishing it raw would put it on our
 * WebSocket bus and in the event database as well.
 */
export function feedMessageFrom(
  entry: ProdComEntry,
  channel: ProdComChannel | null,
  terms: readonly Term[],
): FeedMessage {
  const spans = findMatches(entry.text, terms)
  const text = redact(entry.text, spans)

  /*
   * The translation is redacted on its own, against its own matches.
   *
   * It is a second, independent string — not a view of the first — so blanking
   * only `text` would publish the sensitive words anyway, in the other
   * language, to the same bus and the same database. The words a keyword list
   * holds are usually names and codes, which is exactly the class of thing a
   * translator leaves untranslated.
   */
  const translated =
    entry.translated === null
      ? null
      : redact(entry.translated, findMatches(entry.translated, terms))

  return {
    id: entry.id,
    text,
    at: entry.at,
    channelId: entry.channelId,
    channel: channel?.name ?? entry.channelName ?? 'Unknown channel',
    colour: channel?.colour ?? null,
    source: entry.source,
    live: entry.live,
    translated,
    redacted: text !== entry.text || translated !== entry.translated,
    flags: flagsFrom(spans),
  }
}

/**
 * One flag per keyword, however many times it was said in the line.
 *
 * A sensitive term never produces one. Blanking the text and then naming the
 * keyword beside it gives the secret straight back — and worse, a flag is what
 * raises a mention, which is what raises an alert, which is what gets sent to
 * somebody's phone. `redacted` on the message is how a widget knows something
 * was taken out, without being told what.
 */
export function flagsFrom(spans: readonly Span[]): MessageFlag[] {
  const flags: MessageFlag[] = []
  const seen = new Set<string>()
  for (const span of spans) {
    if (span.term.sensitive) continue
    if (seen.has(span.term.id)) continue
    seen.add(span.term.id)
    flags.push({
      keyword: span.term.text,
      source: span.term.source,
      colour: span.term.colour ?? null,
    })
  }
  return flags
}

/**
 * Does this channel match what the operator typed in the module's channel list?
 *
 * ProdCom accepts a UUID or a name anywhere it takes an id, so a config written
 * by hand will contain names, and one copied from the API will contain UUIDs.
 * Both work, and an empty list means every channel.
 */
export function channelWanted(channel: ProdComChannel, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true
  return wanted.some((each) => {
    const trimmed = each.trim().toLowerCase()
    return trimmed === channel.id.toLowerCase() || trimmed === channel.name.toLowerCase()
  })
}
