/**
 * The Smaart API v4 wire format.
 *
 * Every string here comes from the vendor specification rather than from a
 * reading of the protocol's shape — which is what the previous version of this
 * file was, and it said so. It was wrong in every particular: one socket where
 * there are two, a `subscribe` verb that does not exist, invented field names,
 * and a password sent in a frame that is not how authentication works.
 *
 * The shape, in brief. A control socket at `/api/v4/` answers `get` and `set`
 * requests, each optionally carrying a `sequenceNumber` the reply echoes. One
 * of those requests hands back a list of calibrated inputs, each with its own
 * *stream* endpoint; opening a second socket there yields metric frames until
 * it is closed. A third endpoint per metric yields Smaart's own log.
 *
 * Nothing in here does I/O. The parsers are total: anything unrecognised comes
 * back as null or an empty list rather than throwing, because a connector that
 * drops its link over one surprising frame is worse than one that ignores it.
 */

/** The path every control conversation happens on. */
export const API_PATH = '/api/v4/'

/**
 * The metrics every Smaart appears to have, whatever it is configured for.
 *
 * Deliberately shorter than the specification's example list. That example
 * ends `Leq 10, LAeq 10, LCeq 10` and calls them "the default user Leq
 * metrics" — configurable, and a 9.6.4 machine on the bench had none of them:
 * it reported `LAeq 5`, `LAeq 15`, `Exposure O` and `Exposure N` instead.
 * Declaring the ten-minute trio would have declared three fields that rig
 * never sends, and seeded a widget onto one of them.
 *
 * So this is the intersection of two independent sources — the specification's
 * example and a real machine — which is the eight built-in levels plus the
 * one-minute Leq trio. Anything else a rig is configured for rides along in
 * the payload under its own slug and is offered from live data; it simply is
 * not something the platform can promise in advance.
 *
 * Declaration order is contractual: the first number field is what a newly
 * added level meter binds itself to. A-weighted slow leads because that is
 * what a licence is normally written on, and `FS Peak` is last because a dBFS
 * peak on a 60–110 dB scale reads as a broken widget.
 */
export const DEFAULT_METRIC_NAMES = [
  'SPL A Slow',
  'SPL A Fast',
  'SPL C Slow',
  'SPL C Fast',
  'SPL Slow',
  'SPL Fast',
  'LAeq 1',
  'LCeq 1',
  'Leq 1',
  'Peak C',
  'FS Peak',
] as const

/**
 * A metric name as it becomes a field id.
 *
 * **Frozen.** A slug is not a display detail: it becomes the `metrics.metric`
 * series name in SQLite, a value saved inside a widget's configuration, and a
 * parameter on an alert rule. Change the rule later and every one of those
 * silently points at nothing — the history does not error, it just stops having
 * a line, which is the failure nobody notices until a licensing officer asks.
 *
 * First token lowercased, the rest kept exactly as they came and joined:
 * `SPL A Fast` → `splAFast`, `LAeq 10` → `laeq10`, `FS Peak` → `fsPeak`.
 * Preserving the case of later tokens is what keeps `LAeq 10` and `Leq 10`
 * apart, which matters more here than a tidier-looking identifier.
 */
export function slugForMetric(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const [first, ...rest] = tokens
  // Non-alphanumerics are dropped rather than mapped: a name that differs only
  // by punctuation would otherwise produce a slug that is not a usable key.
  const clean = (token: string) => token.replace(/[^A-Za-z0-9]/g, '')
  return [clean(first as string).toLowerCase(), ...rest.map(clean)].join('')
}

/**
 * Slugs for a list of names, first one wins on a collision.
 *
 * Two different metrics slugging alike would otherwise overwrite each other in
 * the payload and, worse, in the history — one series holding two measurements
 * is not evidence of anything. The loser is reported so a caller can log it.
 */
export function slugMetricNames(names: readonly string[]): {
  pairs: { name: string; field: string }[]
  collisions: string[]
} {
  const pairs: { name: string; field: string }[] = []
  const collisions: string[] = []
  const taken = new Set<string>()

  for (const name of names) {
    const field = slugForMetric(name)
    if (field.length === 0) continue
    if (taken.has(field)) {
      collisions.push(name)
      continue
    }
    taken.add(field)
    pairs.push({ name, field })
  }
  return { pairs, collisions }
}

/**
 * What a metric *is*, which is not something its name makes obvious.
 *
 * A real 9.6.4 reports fifteen of these and three are not sound levels at all.
 * They sit in the same list as the decibels, in the machine's own order, which
 * puts the least useful one first — so the board offers `FS Peak` above the
 * `LAeq 15` somebody's licence is written around.
 *
 * Nothing is hidden on the strength of this. A licence can be written around
 * any figure Smaart measures, and this connector is not the thing that decides
 * which. It orders, and it labels; the picker still offers everything the
 * machine sent.
 */
export type MetricKind = 'level' | 'peak' | 'other'

export function metricKind(name: string): MetricKind {
  // Before the peak test, because it is one by name and not by nature.
  if (name === 'FS Peak') return 'other'
  if (name.startsWith('Exposure')) return 'other'
  return /peak/i.test(name) ? 'peak' : 'level'
}

/**
 * The unit to print beside a reading, or nothing when we do not know.
 *
 * `FS Peak` is digital full scale — a number around −145 on a quiet input,
 * which beside a room's 78 dB reads as a fault rather than a different scale.
 *
 * **`Exposure O` and `Exposure N` get no unit, deliberately.** They appear in
 * no Smaart documentation we have found; they are presumably OSHA and NIOSH
 * dose, which would make them percentages, and "presumably" is not a unit to
 * print next to a compliance figure. ProdCom taught this the hard way: a
 * plausible reading of an undocumented field is still a guess. Ask a real
 * machine what they are before naming them.
 */
export function unitForMetric(name: string): string | undefined {
  if (name === 'FS Peak') return 'dBFS'
  if (name.startsWith('Exposure')) return undefined
  return 'dB'
}

/** Levels first, then peaks, then whatever is not a sound level. */
const KIND_ORDER: Record<MetricKind, number> = { level: 0, peak: 1, other: 2 }

/**
 * The machine's own order, re-grouped by kind and otherwise left alone.
 *
 * Stable within a kind on purpose: which Leq window matters is the operator's
 * business and the rig's, and a connector that thought it knew would sort the
 * wrong one to the top.
 */
export function byMetricKind<T extends { name: string }>(metrics: readonly T[]): T[] {
  return [...metrics].sort(
    (left, right) => KIND_ORDER[metricKind(left.name)] - KIND_ORDER[metricKind(right.name)],
  )
}

// --------------------------------------------------------------- control side

export type ControlFrame =
  | { kind: 'reply'; sequenceNumber: number | null; response: Record<string, unknown> }
  | { kind: 'error'; sequenceNumber: number | null; message: string }
  | { kind: 'unknown' }

/**
 * Documented error strings worth branching on.
 *
 * `unknownTarget` is how a Smaart RT or LE answers a question about calibrated
 * inputs, which those editions do not have. Branching on the error rather than
 * on `applicationName` is deliberate: the error vocabulary is specified, the
 * product name strings are not.
 */
export const API_ERRORS = {
  authRequired: 'authentication required',
  unknownTarget: 'unknown target',
} as const

/**
 * Was that a rejected password?
 *
 * The specification prints `incorrect password`. Smaart 9.6.4 sends
 * **`incorect password`** — one 'r'. Both are matched, because the typo is
 * clearly not deliberate and will presumably be fixed one day, and because
 * showing either spelling to an operator is no help at all: what they need to
 * be told is that the password is wrong.
 */
export function isBadPassword(message: string): boolean {
  return /inco[r]{1,2}ect password/i.test(message)
}

/** Sorts a decoded control-socket frame into reply, error, or neither. */
export function classifyControlFrame(value: unknown): ControlFrame {
  const frame = asRecord(value)
  const sequenceNumber = typeof frame.sequenceNumber === 'number' ? frame.sequenceNumber : null
  const response = frame.response

  if (typeof response !== 'object' || response === null) return { kind: 'unknown' }

  const record = response as Record<string, unknown>
  if (typeof record.error === 'string') {
    return { kind: 'error', sequenceNumber, message: record.error }
  }
  return { kind: 'reply', sequenceNumber, response: record }
}

export interface RootProperties {
  applicationName: string
  applicationVersion: string
  authenticationRequired: boolean
}

/**
 * What the server says about itself.
 *
 * `authenticationRequired` decides whether to send a password at all, so it
 * defaults to false only when the server omitted it — never as a guess in the
 * face of something unparseable, which returns null instead.
 */
export function parseRootProperties(response: Record<string, unknown>): RootProperties | null {
  const name = response.applicationName
  if (typeof name !== 'string') return null
  return {
    applicationName: name,
    applicationVersion:
      typeof response.applicationVersion === 'string' ? response.applicationVersion : '',
    authenticationRequired: response.authenticationRequired === true,
  }
}

export interface SmaartAlarm {
  metric: string
  level: number
}

export interface CalibratedChannel {
  deviceName: string
  channelName: string
  channelIndex: number
  /** Path on the same server; open a socket here for live metrics. */
  streamEndpoint: string
  /** Path prefix; append an encoded metric name for that metric's log. */
  logEndpointPrefix: string | null
  alarms: SmaartAlarm[]
}

export interface ColorThreshold {
  greenAboveLevel: number
  yellowAboveLevel: number
  redAboveLevel: number
}

export interface CalibratedInputs {
  channels: CalibratedChannel[]
  /** Every metric name this server can report. The authoritative list. */
  metricNames: string[]
  /**
   * Smaart's own display colours, one per metric.
   *
   * The specification never says what the array is indexed by. A 9.6.4 machine
   * returned exactly as many entries as metrics, in the same order, with the
   * two exposure metrics carrying different figures from the thirteen level
   * ones — so it is positional. Paired here rather than left as a bare array,
   * because an array with no key is not information.
   *
   * Carried for information only: these come from a preferences dialogue, not
   * from a licence.
   */
  colorThresholds: ColorThreshold[]
}

/** Flattens the devices/channels reply into the channels we can actually use. */
export function parseCalibratedInputs(response: Record<string, unknown>): CalibratedInputs {
  const channels: CalibratedChannel[] = []
  const devices = Array.isArray(response.devices) ? response.devices : []

  for (const entry of devices) {
    const device = asRecord(entry)
    const deviceName = typeof device.deviceName === 'string' ? device.deviceName : ''
    const list = Array.isArray(device.activeCalibratedChannels)
      ? device.activeCalibratedChannels
      : []

    for (const raw of list) {
      const channel = asRecord(raw)
      const channelName = typeof channel.channelName === 'string' ? channel.channelName : ''
      const streamEndpoint = endpointPath(channel.streamEndpoint)
      // A channel with no usable stream path is not something we can open, and
      // a nameless one cannot be chosen in config. Neither is an error worth
      // dropping the link for; they are simply not offered.
      if (channelName.length === 0 || streamEndpoint === null) continue

      channels.push({
        deviceName,
        channelName,
        channelIndex: typeof channel.channelIndex === 'number' ? channel.channelIndex : -1,
        streamEndpoint,
        logEndpointPrefix: endpointPath(channel.logEndpointPrefix),
        alarms: parseAlarms(channel.alarms),
      })
    }
  }

  return {
    channels,
    metricNames: Array.isArray(response.metrics)
      ? response.metrics.filter((name): name is string => typeof name === 'string')
      : [],
    colorThresholds: parseColorThresholds(response.colorThresholds),
  }
}

/**
 * Validates a path the *device* gave us before it becomes a URL.
 *
 * These arrive over the network and get concatenated onto an origin, so an
 * absolute URL, a protocol-relative `//elsewhere/…` or a `../` climb would all
 * point a socket somewhere nobody asked for. Only a plain absolute path under
 * the API root is accepted; everything else is refused, and the channel it
 * belonged to simply is not offered.
 */
export function endpointPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path.startsWith(API_PATH)) return null
  if (path.includes('..') || path.startsWith('//')) return null
  return path
}

/**
 * Where one metric's log lives.
 *
 * The specification calls `logEndpointPrefix` "a prefix to which a URL-encoded
 * metric can be appended", which reads as though concatenation is enough. It
 * is not: a 9.6.4 machine returns
 * `/api/v4//logs/MacBook%20Pro%20Microphone/Mac%20Mic` — **no trailing
 * slash** — so appending gives `.../Mac%20MicFS%20Peak` and the server hangs
 * the socket up without a word. The separator is added here when it is
 * missing, and not doubled when it is not.
 *
 * (The doubled slash after `v4` is the server's own, and it accepts it back.)
 */
export function logEndpointFor(prefix: string, metricName: string): string {
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${base}${encodeURIComponent(metricName)}`
}

function parseAlarms(value: unknown): SmaartAlarm[] {
  if (!Array.isArray(value)) return []
  const alarms: SmaartAlarm[] = []
  for (const entry of value) {
    const alarm = asRecord(entry)
    const level = finite(alarm.level)
    if (typeof alarm.metric !== 'string' || level === null) continue
    alarms.push({ metric: alarm.metric, level })
  }
  return alarms
}

function parseColorThresholds(value: unknown): ColorThreshold[] {
  if (!Array.isArray(value)) return []
  const thresholds: ColorThreshold[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const green = finite(record.greenAboveLevel)
    const yellow = finite(record.yellowAboveLevel)
    const red = finite(record.redAboveLevel)
    if (green === null || yellow === null || red === null) continue
    thresholds.push({ greenAboveLevel: green, yellowAboveLevel: yellow, redAboveLevel: red })
  }
  return thresholds
}

/**
 * Picks the channel an instance is pointed at.
 *
 * Blank means "whichever Smaart lists first", which is the right default for a
 * rig with one measurement position and keeps a single-mic setup zero-config.
 * Matching is case-insensitive because these names get typed by hand, on site,
 * from what somebody read off a screen across the room.
 */
export function selectChannel(
  channels: readonly CalibratedChannel[],
  deviceName?: string,
  channelName?: string,
): CalibratedChannel | null {
  const wantedDevice = deviceName?.trim().toLowerCase() ?? ''
  const wantedChannel = channelName?.trim().toLowerCase() ?? ''

  const matching = channels.filter(
    (channel) =>
      (wantedDevice === '' || channel.deviceName.toLowerCase() === wantedDevice) &&
      (wantedChannel === '' || channel.channelName.toLowerCase() === wantedChannel),
  )
  return matching[0] ?? null
}

// ---------------------------------------------------------------- stream side

export interface MetricsFrame {
  /** Slug → dB. Absent rather than zero when Smaart did not report it. */
  values: Record<string, number>
  /** Slugs Smaart itself flagged as breaching one of its own alarms. */
  violations: string[]
  deviceName: string
  channelName: string
  /** Smaart's own clock, milliseconds, or null if it sent nothing readable. */
  ts: number | null
}

/**
 * Reads one live metrics frame.
 *
 * The wire carries an array of single-key objects rather than one object, so
 * this flattens it. A metric whose value is not a finite number is left *out*
 * rather than zeroed — a gap in a noise log is defensible at a hearing and an
 * invented 0 dB reading is not, and that principle is worth more here than a
 * payload with a predictable set of keys.
 */
export function parseMetricsFrame(value: unknown): MetricsFrame | null {
  const frame = asRecord(value)
  const list = frame.metrics
  if (!Array.isArray(list)) return null

  const values: Record<string, number> = {}
  const violations: string[] = []

  for (const entry of list) {
    const record = asRecord(entry)
    for (const [name, raw] of Object.entries(record)) {
      // `violation` sits alongside the metric in the same object rather than
      // being a metric of its own.
      if (name === 'violation') continue
      const reading = finite(raw)
      if (reading === null) continue
      const field = slugForMetric(name)
      if (field.length === 0 || field in values) continue
      values[field] = reading
      if (record.violation === true) violations.push(field)
    }
  }

  return {
    values,
    violations,
    deviceName: typeof frame.deviceName === 'string' ? frame.deviceName : '',
    channelName: typeof frame.channelName === 'string' ? frame.channelName : '',
    ts: parseTimestamp(frame.timestamp),
  }
}

export interface LoggedPoint {
  ts: number
  value: number
  violation: boolean
  overload: boolean
}

export interface LoggedBatch {
  metricName: string
  points: LoggedPoint[]
}

/**
 * Reads a batch from Smaart's own log.
 *
 * On connect this carries everything already logged, which is the whole reason
 * to prefer it over resampling the live feed: it backfills the hole a reconnect
 * would otherwise leave, and every point is stamped by the instrument that
 * measured it rather than by whenever our socket happened to see it.
 */
export function parseLoggedData(value: unknown): LoggedBatch | null {
  const frame = asRecord(value)
  if (typeof frame.metricName !== 'string') return null
  const list = Array.isArray(frame.loggedData) ? frame.loggedData : []

  const points: LoggedPoint[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const reading = finite(record.value)
    const ts = parseTimestamp(record.timestamp)
    if (reading === null || ts === null) continue
    points.push({
      ts,
      value: reading,
      violation: record.violation === true,
      overload: record.overload === true,
    })
  }

  return { metricName: frame.metricName, points }
}

/**
 * ISO 8601 to epoch milliseconds.
 *
 * The specification's own examples are malformed — `2022-04-02:T16:20:00.000-5:00`
 * has a stray colon before the `T` and a single-digit offset hour — so this
 * repairs both before parsing rather than discarding a timestamp that a real
 * server may well send in exactly that shape. Anything still unreadable comes
 * back null and the caller falls back to arrival time.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const repaired = value
    .replace(/^(\d{4}-\d{2}-\d{2}):T/, '$1T')
    .replace(/([+-])(\d):(\d{2})$/, '$10$2:$3')
  const ms = Date.parse(repaired)
  return Number.isFinite(ms) ? ms : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
