/**
 * Rate classes govern how often a stream may reach clients, and how long a
 * client waits before it distrusts the value on screen.
 *
 * The server conflates to `MIN_PUBLISH_INTERVAL_MS`; the client independently
 * greys out a widget after `STALENESS_MS`. `change` streams are event-driven
 * (a transport state may legitimately sit still for an hour), so their
 * freshness comes from the owning instance's connection status instead.
 */
export const RATE_CLASSES = ['fast', 'normal', 'slow', 'change'] as const

export type RateClass = (typeof RATE_CLASSES)[number]

/** Server-side conflation window: at most one frame per topic per interval. */
export const MIN_PUBLISH_INTERVAL_MS: Record<RateClass, number> = {
  fast: 100, // ≤10 Hz — meters, SPL bars
  normal: 1000, // ≤1 Hz — timers, counters
  slow: 5000, // ≤0.2 Hz — slowly drifting gauges (temperatures, disk space)
  change: 100, // pass-through, floored to protect against a chatty connector
}

/** Client-side "this number may be lying to you" threshold; null = never by time. */
export const STALENESS_MS: Record<RateClass, number | null> = {
  fast: 3_000,
  normal: 5_000,
  slow: 15_000,
  change: null,
}

export function isRateClass(value: unknown): value is RateClass {
  return typeof value === 'string' && (RATE_CLASSES as readonly string[]).includes(value)
}

/**
 * How far past its own rhythm a stream may drift before it is called late.
 *
 * A stream that arrives every ten seconds has not stopped when eleven seconds
 * have passed. Two and a half beats is late enough to mean something and slow
 * enough that one delayed poll — a busy Pi, a device that took an extra
 * second — does not light up a board in the middle of a show.
 */
export const STALE_GRACE = 2.5

/** How many recent gaps are kept to work out what a stream's rhythm is. */
export const GAP_SAMPLES = 3

/**
 * How long a module has to be unreachable before a widget greys out.
 *
 * Reconnection starts at a one-second backoff, so a device that drops a packet
 * or a switch that reboots a port is usually back before anyone could read the
 * warning. Greying a widget for that teaches people to ignore grey widgets,
 * which costs more than the two seconds of silence it bought.
 *
 * Only on the way in. Recovery shows at once: "is it fixed yet" is a question
 * somebody is actively asking, and a widget still greyed after the module came
 * back is the same lie in the other direction.
 */
export const OFFLINE_GRACE_MS = 8_000

/**
 * Should a widget show this module as unreachable yet?
 *
 * `since` is when the state began, so this asks how long it has been wrong
 * rather than whether it is wrong at this instant. A screen that has just
 * loaded and finds a module offline for an hour says so immediately, because
 * `since` was an hour ago.
 */
export function offlineLongEnough(since: number | null, now: number): boolean {
  if (since === null) return true
  return now - since >= OFFLINE_GRACE_MS
}

/**
 * The gaps between the last few frames, newest first.
 *
 * Kept rather than a running average because the question is "what is the
 * longest this normally goes quiet for", and an average is dragged down by a
 * burst. Three samples is enough to survive one irregular poll and short
 * enough to follow a connector whose interval an admin has just changed.
 */
export type GapHistory = readonly number[]

export function trackGap(history: GapHistory, gapMs: number): GapHistory {
  if (gapMs <= 0) return history
  return [gapMs, ...history].slice(0, GAP_SAMPLES)
}

/**
 * What this stream's own rhythm appears to be, or null while unknown.
 *
 * Null until two frames have been seen, and that matters: a stream that has
 * published once has told us nothing about how often it intends to, and
 * accusing it of being late is a guess. Whether the device is reachable at all
 * is the connector's status to answer, not this.
 */
export function expectedGapMs(history: GapHistory): number | null {
  return history.length === 0 ? null : Math.max(...history)
}

/**
 * How long silence has to last before it means something.
 *
 * The rate class is a floor, not the answer. It was the answer once, and the
 * result was that most polled connectors were declared stale between their own
 * polls: sysmon polls every ten seconds against a five-second threshold and
 * was grey half the time, weather polls every ten minutes against fifteen
 * seconds and was grey essentially always. The board that shouts constantly is
 * the board nobody reads.
 */
export function staleAfterMs(rateClass: RateClass, expected: number | null): number | null {
  const floor = STALENESS_MS[rateClass]
  if (floor === null) return null
  return expected === null ? floor : Math.max(floor, expected * STALE_GRACE)
}

/**
 * True when a value last updated at `lastTs` should be presented as stale.
 *
 * `change`-class topics never go stale on silence alone — a transport that has
 * not moved publishes nothing, and calling that stale would be a lie.
 */
export function isStale(
  rateClass: RateClass,
  lastTs: number | null,
  now: number,
  expected: number | null = null,
): boolean {
  if (lastTs === null) return true
  const threshold = staleAfterMs(rateClass, expected)
  if (threshold === null) return false
  return now - lastTs > threshold
}
