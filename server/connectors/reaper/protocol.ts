/**
 * REAPER's built-in web remote, `GET /_/CMD1;CMD2;…`.
 *
 * The response is plain text, one record per line, tab-separated, with the
 * record name in the first field. It has been stable for a decade, which is
 * exactly why the multitrack rig at most festivals can be read this way at
 * all — but it is also generous with trailing fields, so nothing here may
 * assume a fixed column count.
 */

/**
 * Show networks hand out IPv6 addresses more often than anyone expects, and a
 * bare `::1` in a URL parses as a host with a port. Bracket it.
 */
export function baseUrl(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${port}`
}

export type TransportState =
  | 'stopped'
  | 'playing'
  | 'paused'
  | 'recording'
  | 'record-paused'
  | 'unknown'

export interface ReaperTransport {
  state: TransportState
  positionSeconds: number
  positionString: string
  isRepeatOn: boolean
}

export interface ReaperTrack {
  number: number
  name: string
  recordArmed: boolean
  muted: boolean
  soloed: boolean
  /** Last meter peak in dB. REAPER reports silence as a large negative number. */
  peakDb: number
}

export interface ReaperPoll {
  transport: ReaperTransport | null
  /** From NTRACK — the project's own count, which may exceed what we report. */
  trackCount: number | null
  tracks: ReaperTrack[]
  /** Keyed `SECTION/KEY`, matching the way GET_EXTSTATE is addressed. */
  extState: Map<string, string>
}

/**
 * REAPER's playstate is a bitfield (1 = playing, 2 = paused, 4 = recording),
 * but only these combinations are ever produced, and crew think in named
 * states rather than bits. Anything else is reported as unknown instead of
 * guessed at: a dashboard that invents "playing" during a REAPER beta is worse
 * than one that admits it does not know.
 */
export function playStateToTransport(playState: number): TransportState {
  switch (playState) {
    case 0:
      return 'stopped'
    case 1:
      return 'playing'
    case 2:
      return 'paused'
    case 5:
      return 'recording'
    case 6:
      return 'record-paused'
    default:
      return 'unknown'
  }
}

/** Bit positions in a TRACK record's flags field. */
export const TRACK_FLAGS = {
  folder: 1,
  selected: 2,
  hasFx: 4,
  muted: 8,
  soloed: 16,
  soloInPlace: 32,
  recordArmed: 64,
} as const

export type TrackFlags = { [K in keyof typeof TRACK_FLAGS]: boolean }

export function decodeTrackFlags(flags: number): TrackFlags {
  const bits = Number.isFinite(flags) ? Math.trunc(flags) : 0
  return {
    folder: (bits & TRACK_FLAGS.folder) !== 0,
    selected: (bits & TRACK_FLAGS.selected) !== 0,
    hasFx: (bits & TRACK_FLAGS.hasFx) !== 0,
    muted: (bits & TRACK_FLAGS.muted) !== 0,
    soloed: (bits & TRACK_FLAGS.soloed) !== 0,
    soloInPlace: (bits & TRACK_FLAGS.soloInPlace) !== 0,
    recordArmed: (bits & TRACK_FLAGS.recordArmed) !== 0,
  }
}

/** Meter fields are dB × 10, so -300 is -30 dB and 0 is unity. */
export function meterToDb(raw: number): number {
  return Number.isFinite(raw) ? raw / 10 : Number.NEGATIVE_INFINITY
}

/**
 * Splits the body into tab-separated records, discarding blank lines and
 * tolerating CRLF. Nothing is validated here — a record with the wrong shape
 * is dropped by whoever asked for it, not by the splitter.
 */
export function splitRecords(body: string): string[][] {
  return body
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
}

/**
 * Turns one web-remote response into the pieces this connector publishes.
 *
 * Records that cannot be understood are skipped rather than thrown on: REAPER
 * emits records we never asked for after some actions, and a proxy sitting in
 * front of it can return an HTML login page mid-show. Neither is an outage.
 */
export function parseReaperResponse(body: string): ReaperPoll {
  const poll: ReaperPoll = { transport: null, trackCount: null, tracks: [], extState: new Map() }

  for (const fields of splitRecords(body)) {
    switch (fields[0]) {
      case 'TRANSPORT': {
        const transport = parseTransportRecord(fields)
        if (transport) poll.transport = transport
        break
      }
      case 'NTRACK': {
        const count = Number(fields[1])
        if (Number.isFinite(count)) poll.trackCount = Math.trunc(count)
        break
      }
      case 'TRACK': {
        const track = parseTrackRecord(fields)
        if (track) poll.tracks.push(track)
        break
      }
      case 'EXTSTATE': {
        const [, section, key, value] = fields
        if (section && key) poll.extState.set(`${section}/${key}`, value ?? '')
        break
      }
      default:
        // Unrecognised records are ignored on purpose: REAPER adds them
        // between versions and that must never take an instance offline.
        break
    }
  }

  return poll
}

/** `TRANSPORT \t playstate \t position \t repeat \t position_string \t position_beats` */
function parseTransportRecord(fields: string[]): ReaperTransport | null {
  const playState = Number(fields[1])
  if (!Number.isFinite(playState)) return null

  const positionSeconds = Number(fields[2])

  return {
    state: playStateToTransport(playState),
    positionSeconds: Number.isFinite(positionSeconds) ? positionSeconds : 0,
    positionString: fields[4] ?? '',
    isRepeatOn: fields[3] === '1',
  }
}

/** `TRACK \t number \t name \t flags \t volume \t pan \t peak \t meter_pos \t …` */
function parseTrackRecord(fields: string[]): ReaperTrack | null {
  const number = Number(fields[1])
  if (!Number.isFinite(number)) return null

  const flags = decodeTrackFlags(Number(fields[3]))

  return {
    number: Math.trunc(number),
    // An unnamed track in REAPER shows as its number; keeping the empty string
    // would put a blank row on the wall where a channel should be.
    name: fields[2] && fields[2].length > 0 ? fields[2] : `Track ${Math.trunc(number)}`,
    recordArmed: flags.recordArmed,
    muted: flags.muted,
    soloed: flags.soloed,
    peakDb: meterToDb(Number(fields[6])),
  }
}
