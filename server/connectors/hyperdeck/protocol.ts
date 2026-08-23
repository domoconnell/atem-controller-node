import { LineSplitter } from '../demo/protocol.js'

/**
 * Blackmagic's documented HyperDeck Ethernet protocol (TCP 9993): plain text,
 * CRLF-delimited, no request ids.
 *
 * A response is either a single line, `200 ok`, or a header ending in a colon
 * followed by `key: value` lines and a blank line:
 *
 *     208 transport info:
 *     status: play
 *     speed: 100
 *
 * 5xx codes are pushed by the device rather than answers to anything we sent,
 * which is what makes `notify` worth enabling — the deck tells us when the
 * transport changes instead of us asking twice a second all night.
 */
export interface HyperDeckResponse {
  code: number
  text: string
  fields: Record<string, string>
  /** True for the 5xx pushes, which must never be matched to a command. */
  asynchronous: boolean
}

/**
 * A status line is a 3-digit code, a space, then text with no interior colon —
 * the trailing colon means "fields follow". Field lines never match, because
 * their key comes first.
 */
const STATUS_LINE = /^(\d{3}) ([^:]*)(:)?$/

/** Two line endings back to back: the blank line that terminates a block. */
const BLOCK_TERMINATOR = /\r?\n\r?\n$/

export function isSuccessCode(code: number): boolean {
  return code >= 200 && code < 300
}

export function isAsyncCode(code: number): boolean {
  return code >= 500 && code < 600
}

/**
 * Turns the byte stream into whole responses.
 *
 * Line framing is `LineSplitter`'s job, but it drops empty lines — reasonably,
 * since for every other protocol here they are keepalive noise. Here the empty
 * line is the terminator, so the end of a block is recovered from the raw
 * stream instead: a block closes when the bytes so far end in a blank line, or
 * when the next status line arrives. A response split so that a chunk ends
 * part-way through the *following* status line closes one chunk late, which
 * costs nothing and cannot lose data.
 */
export class HyperDeckResponseAssembler {
  private readonly splitter = new LineSplitter()
  private open: HyperDeckResponse | null = null
  private tail = ''

  push(chunk: string): HyperDeckResponse[] {
    const responses: HyperDeckResponse[] = []

    for (const line of this.splitter.push(chunk)) this.handleLine(line, responses)

    this.tail = (this.tail + chunk).slice(-4)
    if (BLOCK_TERMINATOR.test(this.tail) && this.open) {
      responses.push(this.open)
      this.open = null
    }

    return responses
  }

  reset(): void {
    this.splitter.reset()
    this.open = null
    this.tail = ''
  }

  private handleLine(line: string, responses: HyperDeckResponse[]): void {
    // Blackmagic's own documentation shows the field lines indented and
    // shipping firmware does not; trimming makes the difference irrelevant.
    const trimmed = line.trim()
    if (trimmed === '') return

    const status = STATUS_LINE.exec(trimmed)
    if (status) {
      // The device never interleaves responses, so a new header ends the
      // previous block even if its blank line was lost.
      if (this.open) {
        responses.push(this.open)
        this.open = null
      }

      const code = Number(status[1])
      const response: HyperDeckResponse = {
        code,
        text: status[2]?.trim() ?? '',
        fields: {},
        asynchronous: isAsyncCode(code),
      }

      if (status[3] === ':') this.open = response
      else responses.push(response)
      return
    }

    // A field line with no block open is garbage from a confused device.
    if (!this.open) return

    const separator = trimmed.indexOf(':')
    if (separator === -1) return
    const key = trimmed.slice(0, separator).trim()
    // Values contain colons of their own — `timecode: 01:00:00:00` — so only
    // the first one separates.
    if (key !== '') this.open.fields[key] = trimmed.slice(separator + 1).trim()
  }
}

export interface HyperDeckTransport {
  status: string
  speed: number | null
  slotId: number | null
  clipId: number | null
  timecode: string | null
  displayTimecode: string | null
  loop: boolean | null
  singleClip: boolean | null
}

export interface HyperDeckSlot {
  slotId: number | null
  status: string
  volumeName: string | null
  /** What the crew actually watch: how much longer this card can record. */
  recordingTimeSeconds: number | null
  videoFormat: string | null
}

export interface HyperDeckDevice {
  model: string | null
  protocolVersion: string | null
}

export function parseTransport(fields: Record<string, string>): HyperDeckTransport {
  return {
    status: fields.status ?? 'unknown',
    speed: asInteger(fields.speed),
    slotId: asInteger(fields['slot id']),
    clipId: asInteger(fields['clip id']),
    timecode: fields.timecode ?? null,
    displayTimecode: fields['display timecode'] ?? null,
    loop: fields.loop == null ? null : fields.loop === 'true',
    singleClip: fields['single clip'] == null ? null : fields['single clip'] === 'true',
  }
}

export function parseSlot(fields: Record<string, string>): HyperDeckSlot {
  return {
    slotId: asInteger(fields['slot id']),
    status: fields.status ?? 'unknown',
    volumeName: fields['volume name'] ?? null,
    recordingTimeSeconds: asInteger(fields['recording time']),
    videoFormat: fields['video format'] ?? null,
  }
}

export function parseDevice(fields: Record<string, string>): HyperDeckDevice {
  return {
    model: fields.model ?? null,
    protocolVersion: fields['protocol version'] ?? null,
  }
}

function asInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}
