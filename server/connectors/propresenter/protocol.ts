/**
 * Shapes and parsers for ProPresenter 7's REST API.
 *
 * Everything ProPresenter tells us about time arrives as a formatted string,
 * so the parsers live here rather than inline: a stage display counting down
 * to a curfew is only as trustworthy as this file, and it is worth being able
 * to test it without a Mac running ProPresenter on the desk.
 */

export interface TimerReading {
  uuid: string
  name: string
  /** Negative once a countdown has run past zero — ProPresenter keeps going. */
  seconds: number
  /** `running` | `stopped` | `complete` in every version we have seen. */
  state: string
}

export interface SlideReading {
  current: string | null
  next: string | null
}

/**
 * Turns `"00:04:32"` (or `"-00:00:07"` once a timer is in overrun) into
 * seconds. Returns null for anything it cannot read, so callers can drop the
 * value rather than publish a plausible-looking lie to a countdown widget.
 */
export function parseTimecode(value: unknown): number | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const negative = trimmed.startsWith('-')
  const parts = (negative ? trimmed.slice(1) : trimmed).split(':')
  // Two parts is MM:SS, three is HH:MM:SS; ProPresenter has shipped both.
  if (parts.length < 2 || parts.length > 3) return null

  let total = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null
    total = total * 60 + Number(part)
  }

  // Guard against -0, which survives arithmetic but reads as "0" everywhere
  // except a strict equality check in a test.
  if (total === 0) return 0

  const rounded = Math.round(total * 1000) / 1000
  return negative ? -rounded : rounded
}

/** The inverse of `parseTimecode`, used by the simulator to speak the same dialect. */
export function formatTimecode(seconds: number): string {
  const whole = Math.floor(Math.abs(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  const body = `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`
  return seconds < 0 ? `-${body}` : body
}

/** Reads `GET /v1/timers/current`. */
export function parseTimers(body: unknown): TimerReading[] {
  if (!Array.isArray(body)) return []

  const timers: TimerReading[] = []
  for (const entry of body) {
    const record = asRecord(entry)
    const id = asRecord(record.id)
    const uuid = typeof id.uuid === 'string' && id.uuid.length > 0 ? id.uuid : null
    const seconds = parseTimecode(record.time)

    // A timer we cannot identify or cannot read the clock of is skipped
    // entirely. A blank slot on the wall is recoverable; a wrong number that
    // a stage manager clears the stage by is not.
    if (uuid === null || seconds === null) continue

    timers.push({
      uuid,
      name: typeof id.name === 'string' && id.name.length > 0 ? id.name : uuid,
      seconds,
      state: typeof record.state === 'string' ? record.state : 'stopped',
    })
  }
  return timers
}

/** Reads `GET /v1/timer/system_time`. */
export function parseSystemTime(body: unknown): string | null {
  const time = asRecord(body).time
  return typeof time === 'string' && time.length > 0 ? time : null
}

/** Reads `GET /v1/status/slide`. An empty stage or the end of a playlist gives nulls. */
export function parseSlide(body: unknown): SlideReading {
  const record = asRecord(body)
  return { current: slideText(record.current), next: slideText(record.next) }
}

/**
 * Reads `GET /v1/stage/message`, which answers with a bare JSON string when a
 * message is up and an empty body when there is none.
 */
export function parseStageMessage(body: unknown): string {
  if (typeof body === 'string') return body
  const message = asRecord(body).message
  return typeof message === 'string' ? message : ''
}

function slideText(value: unknown): string | null {
  const text = asRecord(value).text
  return typeof text === 'string' ? text : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
