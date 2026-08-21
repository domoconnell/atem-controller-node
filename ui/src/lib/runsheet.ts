/** Shared runsheet model + helpers, used by the Runsheet app and its widgets. */

export interface Person { name: string; micId?: string; lead?: boolean }
export interface Segment { id: string; title: string; titleOverride?: string; time?: string; people: Person[]; proItemId?: string; kind?: 'header'; color?: string }
export interface Service { id: string; name: string; sortOrder?: number; segments?: Segment[]; activeIndex?: number | null; activeStartedAt?: number | null; proLink?: unknown }

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

/** Resolve which service a widget targets: a pinned id, else the running one
 *  (activeIndex set), else the first service. */
export function resolveService(services: Service[], serviceId?: string): Service | undefined {
  return (serviceId ? services.find((s) => s.id === serviceId) : undefined)
    ?? services.find((s) => s.activeIndex != null)
    ?? services[0]
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
