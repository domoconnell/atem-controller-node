/** Shared runsheet model + helpers, used by the Runsheet app and its widgets. */

export interface Person { name: string; micId?: string; lead?: boolean }
export interface Segment { id: string; title: string; titleOverride?: string; time?: string; people: Person[]; proItemId?: string; kind?: 'header'; color?: string }
export interface Service { id: string; name: string; sortOrder?: number; segments?: Segment[]; activeIndex?: number | null; proLink?: unknown }

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
export async function gotoIndex(serviceId: string, idx: number | null, mics: MicLike[], segs: Segment[]): Promise<Service[]> {
  const b = await (await fetch(`/api/features/services/${serviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeIndex: idx }) })).json()
  await applyCues(mics, segs, idx)
  return (b.services as Service[]) ?? []
}
