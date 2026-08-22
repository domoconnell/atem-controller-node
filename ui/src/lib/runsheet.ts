/** Shared runsheet model + helpers, used by the Runsheet app and its widgets. */

export interface Person { name: string; micId?: string; lead?: boolean }

/** An automation fired when the playhead lands on a segment (auto-fire, gated by
 *  the global "automation armed" switch). Configured per segment in the runsheet.
 *  Recalling an ATEM look also fires that look's embedded PP look + bg media. */
export type RunActionType = 'atem-look' | 'pp-presentation' | 'pp-media' | 'mic-mute'
export interface RunAction {
  id: string
  type: RunActionType
  enabled?: boolean                       // default true; false = configured but skipped
  look?: string                           // atem-look: look name
  presentationId?: string                 // pp-presentation: PP presentation uuid (defaults to the segment's own)
  presentationName?: string
  index?: number | null                   // pp-presentation: slide index (blank = whole presentation)
  playlistId?: string                     // pp-media: media playlist uuid
  playlistName?: string
  itemId?: string                         // pp-media: media item uuid
  itemName?: string
  micId?: string                          // mic-mute: composite mic id (resolves to DiGiCo channel etc.)
  micLabel?: string
  muteAction?: 'mute' | 'unmute' | 'toggle'
}

/** `flexible`: this item's time can be shortened to catch up (a talk/message);
 *  songs and fixed items leave it off. `actions`: automations fired on entry. */
export interface Segment { id: string; title: string; titleOverride?: string; time?: string; people: Person[]; proItemId?: string; kind?: 'header'; color?: string; flexible?: boolean; actions?: RunAction[] }
/** `startTime` "HH:MM" is the wall-clock the service should hit at `startSegmentId`
 *  (items before it — pre-roll, countdown — are pre-service). */
/** `actuals`: segId -> wall-clock ms the item was actually made active (stamped
 *  each time the playhead lands on it). Lets us show the *frozen* how-far-behind
 *  a past item ended up, independent of what happens later. */
/** `date` "YYYY-MM-DD" + `startTime` place the service on a calendar so the
 *  dashboard can auto-select the current/next one instead of always the first. */
export interface Service { id: string; name: string; sortOrder?: number; segments?: Segment[]; activeIndex?: number | null; activeStartedAt?: number | null; actuals?: Record<string, number>; proLink?: unknown; startTime?: string; startSegmentId?: string; date?: string }

/** A segment's planned duration "M:SS" / "MM:SS" / "H:MM:SS" -> seconds, or null
 *  if blank/invalid. Minutes and seconds fields must each be < 60. */
export function parseDuration(str?: string | null): number | null {
  if (!str || !str.trim()) return null
  const parts = str.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return null
  if (!parts.every((p) => /^\d+$/.test(p))) return null
  const nums = parts.map(Number)
  if (nums[nums.length - 1] >= 60) return null            // seconds
  if (nums[nums.length - 2] >= 60) return null            // minutes
  return nums.reduce((total, n) => total * 60 + n, 0)
}
/** Blank counts as valid (no planned time); otherwise it must parse. */
export const isValidDuration = (str?: string | null): boolean => !str || !str.trim() || parseDuration(str) != null

/** Seconds -> "M:SS" or "H:MM:SS" (negative keeps its sign, for overrun). */
export function fmtDuration(totalSec: number): string {
  const neg = totalSec < 0
  let s = Math.abs(Math.round(totalSec))
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const core = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
  return (neg ? '-' : '') + core
}

/** Parse a "HH:MM" (24h) wall-clock into seconds-since-midnight, or null. */
export function parseClock(str?: string | null): number | null {
  if (!str || !str.trim()) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim())
  if (!m) return null
  const h = +m[1], mm = +m[2]
  return h > 23 || mm > 59 ? null : h * 3600 + mm * 60
}
export const isValidClock = (str?: string | null): boolean => !str || !str.trim() || parseClock(str) != null

/** Resolve a "HH:MM" wall-clock to a timestamp on the same local day as `now`. */
export function resolveClock(str: string | null | undefined, now: number): number | null {
  const sec = parseClock(str)
  if (sec == null) return null
  const d = new Date(now)
  d.setHours(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), 0, 0)
  return d.getTime()
}
/** A timestamp -> local "HH:MM" (or "HH:MM:SS"). */
export function fmtClockTs(ts: number, withSec = false): string {
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, '0')
  return withSec ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface RunTiming {
  plannedEnd: number | null            // ts the service is scheduled to finish
  estFinish: number | null             // live projection of when it will finish
  deltaSec: number | null              // estFinish - plannedEnd (+ over / - under time)
  suggest: Map<string, { start: number; dur: number; trimmed: boolean }>  // per upcoming segment id
  // Per-item "if nothing changes" baseline, for every runnable segment:
  //  plannedStart — the originally-intended wall-clock start (fixed by the plan)
  //  plannedDur   — the item's planned duration (seconds)
  //  behindSec    — how far behind schedule (+late / -early). Live & identical
  //                 for the current + upcoming items; frozen once an item is past.
  plan: Map<string, { plannedStart: number | null; plannedDur: number; behindSec: number | null }>
}

/** The whole live-timing picture for a service at time `now` (ms):
 *  the scheduled finish (from Service start time + item durations), the live
 *  estimate, how far over/under, and — the clever bit — suggested start times
 *  that shorten *flexible* items (talks) but never fixed ones (songs) to try to
 *  land back on the scheduled finish. Deterministic; no guessing. */
export function computeTiming(svc: Service | undefined, now: number): RunTiming {
  const empty: RunTiming = { plannedEnd: null, estFinish: null, deltaSec: null, suggest: new Map(), plan: new Map() }
  if (!svc) return empty
  const segs = svc.segments ?? []
  const dur = (s: Segment) => parseDuration(s.time) ?? 0
  const startIdx = svc.startSegmentId ? segs.findIndex((s) => s.id === svc.startSegmentId) : (firstItemIndex(segs) ?? -1)
  const startTs = resolveClock(svc.startTime, now)

  let plannedEnd: number | null = null
  if (startTs != null && startIdx >= 0) {
    let total = 0
    for (let j = startIdx; j < segs.length; j++) if (!isHeader(segs[j])) total += dur(segs[j])
    plannedEnd = startTs + total * 1000
  }

  const idx = svc.activeIndex ?? null
  const elapsed = idx != null && svc.activeStartedAt ? (now - svc.activeStartedAt) / 1000 : 0
  const curRemain = idx != null ? Math.max(0, dur(segs[idx]) - elapsed) : 0
  let estFinish: number | null = null
  if (idx != null) {
    let future = 0
    for (let j = idx + 1; j < segs.length; j++) if (!isHeader(segs[j])) future += dur(segs[j])
    estFinish = now + (curRemain + future) * 1000
  } else if (plannedEnd != null) {
    estFinish = plannedEnd
  }
  const deltaSec = estFinish != null && plannedEnd != null ? Math.round((estFinish - plannedEnd) / 1000) : null

  const suggest = new Map<string, { start: number; dur: number; trimmed: boolean }>()
  if (plannedEnd != null) {
    // When the first upcoming item should start, and which items are upcoming.
    let clock: number, firstUpcoming: number
    if (idx != null) { clock = now + curRemain * 1000; firstUpcoming = nextItemIndex(segs, idx) ?? segs.length }
    else { clock = startTs ?? now; firstUpcoming = startIdx >= 0 ? startIdx : (firstItemIndex(segs) ?? segs.length) }
    const upcoming: Segment[] = []
    for (let j = firstUpcoming; j < segs.length; j++) if (!isHeader(segs[j])) upcoming.push(segs[j])
    const required = upcoming.reduce((a, s) => a + dur(s), 0)
    const available = (plannedEnd - clock) / 1000
    const overrun = Math.max(0, required - available)
    // How much each flexible item can give up (never below 40% or 30s).
    const floor = (s: Segment) => Math.max(30, dur(s) * 0.4)
    const reducible = upcoming.reduce((a, s) => a + (s.flexible ? Math.max(0, dur(s) - floor(s)) : 0), 0)
    const cut = Math.min(overrun, reducible)
    for (const s of upcoming) {
      let d = dur(s), trimmed = false
      if (s.flexible && reducible > 0 && cut > 0) {
        const give = Math.max(0, dur(s) - floor(s))
        const take = (give / reducible) * cut
        if (take > 1) { d = dur(s) - take; trimmed = true }
      }
      suggest.set(s.id, { start: clock, dur: d, trimmed })
      clock += d * 1000
    }
  }
  // ---- Per-item baseline: planned start clock + how-far-behind ----------
  // Planned start of each runnable item, anchored at the service start item and
  // walked both ways (items before the anchor — pre-roll/countdown — get earlier
  // clocks). Independent of the live run, so it's the "as scheduled" column.
  const plannedStart = new Array<number | null>(segs.length).fill(null)
  if (startTs != null && startIdx >= 0) {
    let acc = 0
    for (let j = startIdx; j < segs.length; j++) { if (isHeader(segs[j])) continue; plannedStart[j] = startTs + acc * 1000; acc += dur(segs[j]) }
    let back = 0
    for (let j = startIdx - 1; j >= 0; j--) { if (isHeader(segs[j])) continue; back += dur(segs[j]); plannedStart[j] = startTs - back * 1000 }
  }
  const actuals = svc.actuals ?? {}
  const startedAt = (i: number): number | null => { const s = segs[i]; return s ? (actuals[s.id] ?? null) : null }
  const plan = new Map<string, { plannedStart: number | null; plannedDur: number; behindSec: number | null }>()
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (isHeader(s)) continue
    let behindSec: number | null
    if (idx != null && i < idx) {
      // Past item — frozen at the drift it ended up with. Its actual end is the
      // next started item's actual start; behind = that vs the next item's plan.
      let k: number | null = nextItemIndex(segs, i)
      while (k != null && startedAt(k) == null) k = nextItemIndex(segs, k)
      if (k != null && plannedStart[k] != null) behindSec = Math.round((startedAt(k)! - plannedStart[k]!) / 1000)
      else if (plannedStart[i] != null && startedAt(i) != null) behindSec = Math.round((startedAt(i)! - plannedStart[i]!) / 1000)
      else behindSec = null
    } else {
      // Current + upcoming — the live projected drift (same for all of them).
      behindSec = deltaSec
    }
    plan.set(s.id, { plannedStart: plannedStart[i], plannedDur: dur(s), behindSec })
  }
  return { plannedEnd, estFinish, deltaSec, suggest, plan }
}

export const isHeader = (s?: Segment | null) => s?.kind === 'header'
/** The name to display: a local rename wins over the ProPresenter/base title. */
export const segTitle = (s?: Segment | null) => (s?.titleOverride?.trim() ? s.titleOverride : s?.title) ?? ''

/** The next runnable item after `from` (headers are skipped); null past the end. */
export function nextItemIndex(segs: Segment[], from: number | null): number | null {
  let i = from == null ? -1 : from
  do { i++ } while (i < segs.length && isHeader(segs[i]))
  return i < segs.length ? i : null
}
/** The previous runnable item before `from` (headers skipped); null past the start. */
export function prevItemIndex(segs: Segment[], from: number | null): number | null {
  let i = from == null ? segs.length : from
  do { i-- } while (i >= 0 && isHeader(segs[i]))
  return i >= 0 ? i : null
}
export const firstItemIndex = (segs: Segment[]) => nextItemIndex(segs, null)
export const lastItemIndex = (segs: Segment[]) => prevItemIndex(segs, null)

/** The nearest header at or above `idx` — the section the item sits under. */
export function sectionFor(segs: Segment[], idx: number | null): Segment | null {
  if (idx == null) return null
  for (let j = idx; j >= 0; j--) if (isHeader(segs[j])) return segs[j]
  return null
}

/** A dated service's scheduled start as a timestamp (its `date` at `startTime`),
 *  or null if it has no date (an undated template, excluded from the schedule). */
export function scheduledStart(svc: Service): number | null {
  if (!svc.date) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(svc.date.trim())
  if (!m) return null
  const sec = parseClock(svc.startTime) ?? 0
  return new Date(+m[1], +m[2] - 1, +m[3], Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), 0, 0).getTime()
}
/** Total planned run length (seconds) from the start item to the end. */
export function serviceDurationSec(svc: Service): number {
  const segs = svc.segments ?? []
  const startIdx = svc.startSegmentId ? segs.findIndex((s) => s.id === svc.startSegmentId) : (firstItemIndex(segs) ?? 0)
  let total = 0
  for (let j = Math.max(0, startIdx); j < segs.length; j++) if (!isHeader(segs[j])) total += parseDuration(segs[j].time) ?? 0
  return total
}
/** The scheduled service that should be showing at `now`: the dated services in
 *  time order, handing over to the next at the MIDPOINT between one's planned end
 *  and the next's start. Before the first, it's the first; after the last, it's
 *  the last. Null if no service is dated. */
export function pickScheduledService(services: Service[], now: number): Service | undefined {
  const dated = services
    .map((s) => ({ s, start: scheduledStart(s) }))
    .filter((x): x is { s: Service; start: number } => x.start != null)
    .sort((a, b) => a.start - b.start)
  if (dated.length === 0) return undefined
  for (let i = 0; i < dated.length; i++) {
    const next = dated[i + 1]
    if (!next) return dated[i].s
    const end = dated[i].start + serviceDurationSec(dated[i].s) * 1000
    const boundary = (end + next.start) / 2
    if (now < boundary) return dated[i].s
  }
  return dated[dated.length - 1].s
}

/** Resolve which service a widget targets: a pinned id, else the running one
 *  (activeIndex set), else — when `now` is given and services are dated — the
 *  scheduled current/next one, else the first service. */
export function resolveService(services: Service[], serviceId?: string, now?: number): Service | undefined {
  if (serviceId) { const pinned = services.find((s) => s.id === serviceId); if (pinned) return pinned }
  const running = services.find((s) => s.activeIndex != null)
  if (running) return running
  if (now != null) { const scheduled = pickScheduledService(services, now); if (scheduled) return scheduled }
  return services[0]
}

interface MicLike { id: string; cue?: string }
/** Drive each mapped mic's cue from the now (live) / next-item (standby) segments. */
export async function applyCues(mics: MicLike[], segs: Segment[], idx: number | null) {
  const now = new Set(idx != null ? (segs[idx]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
  const nIdx = nextItemIndex(segs, idx)
  const next = new Set(idx != null && nIdx != null ? (segs[nIdx]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
  await Promise.all(mics.map((m) => {
    const want = now.has(m.id) ? 'live' : next.has(m.id) ? 'standby' : 'off'
    return (m.cue ?? 'off') === want ? null : fetch(`/api/features/mics/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cue: want }) })
  }).filter(Boolean))
}

/** PATCH a service's active position and re-cue mics; returns the updated list. */
/** Move a service's playhead. The server re-cues the mapped mics (single source
 *  of truth for both the UI and OSC), so we just PATCH the position. */
export async function gotoIndex(serviceId: string, idx: number | null): Promise<Service[]> {
  const b = await (await fetch(`/api/features/services/${serviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeIndex: idx }) })).json()
  return (b.services as Service[]) ?? []
}
