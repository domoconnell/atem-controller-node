import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEventSchema, dayShift, updateEventSchema, venueCoords } from './event.js'

/**
 * An event has to know where it is.
 *
 * Widgets read the coordinates — the weather at the site, sunset over the
 * field — and every one of them is wrong at the wrong moment if this holds the
 * office's location, or half a pair, or a default that happens to be a place.
 */
describe('where the venue is', () => {
  const base = { name: 'Awaken 2026' }

  it('takes an address and a coordinate pair', () => {
    const parsed = createEventSchema.parse({
      ...base,
      address: 'Lincolnshire Showground\nGrange-de-Lings\nLincoln\nLN2 2NA',
      latitude: 53.287,
      longitude: -0.548,
    })
    expect(parsed.latitude).toBe(53.287)
    expect(parsed.longitude).toBe(-0.548)
    expect(parsed.address).toContain('LN2 2NA')
  })

  it('defaults to no location rather than to a place', () => {
    // Zero, zero is in the Gulf of Guinea. "We have not said yet" has to be
    // expressible, or every event without coordinates claims to be at sea.
    const parsed = createEventSchema.parse(base)
    expect(parsed.latitude).toBeNull()
    expect(parsed.longitude).toBeNull()
    expect(parsed.address).toBe('')
  })

  it('refuses half a coordinate', () => {
    // A latitude with no longitude is a line round the earth, not a place.
    expect(createEventSchema.safeParse({ ...base, latitude: 53.287 }).success).toBe(false)
    expect(createEventSchema.safeParse({ ...base, longitude: -0.548 }).success).toBe(false)
    expect(updateEventSchema.safeParse({ latitude: 53.287, longitude: null }).success).toBe(false)
  })

  it('lets an update touch one of the pair, since the other is already stored', () => {
    expect(updateEventSchema.safeParse({ latitude: 53.3 }).success).toBe(true)
    expect(updateEventSchema.safeParse({ address: 'somewhere else' }).success).toBe(true)
  })

  it('refuses a coordinate that is not on the planet', () => {
    expect(createEventSchema.safeParse({ ...base, latitude: 91, longitude: 0 }).success).toBe(false)
    expect(createEventSchema.safeParse({ ...base, latitude: 0, longitude: 181 }).success).toBe(
      false,
    )
  })
})

describe('venueCoords', () => {
  it('gives both or nothing', () => {
    expect(venueCoords({ latitude: 53.287, longitude: -0.548 })).toEqual({
      latitude: 53.287,
      longitude: -0.548,
    })
    expect(venueCoords({ latitude: null, longitude: null })).toBeNull()
  })

  it('treats a half-set record as unset rather than as the equator', () => {
    // The schema refuses these on the way in, but a row written by an older
    // build, restored from a backup, or edited by hand can still hold one.
    expect(venueCoords({ latitude: 53.287, longitude: null })).toBeNull()
    expect(venueCoords({ latitude: null, longitude: -0.548 })).toBeNull()
  })
})

/**
 * Moving a duplicated event's running order onto its own dates.
 *
 * Pinned to a zone with a clock change in it, because the whole reason this
 * counts days rather than milliseconds is what happens across one — and on a
 * CI box running UTC the interesting case quietly stops existing.
 */
describe('how far a duplicate moves', () => {
  const zone = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/London'
  })
  afterAll(() => {
    process.env.TZ = zone
  })

  const day = (year: number, month: number, dayOfMonth: number, hour = 0) =>
    new Date(year, month - 1, dayOfMonth, hour).getTime()

  it('counts whole days between the two start dates', () => {
    expect(dayShift(day(2026, 8, 7), day(2026, 8, 14))).toBe(7)
    expect(dayShift(day(2026, 8, 7), day(2027, 8, 6))).toBe(364)
  })

  it('counts the same number of days across a clock change', () => {
    // 92 calendar days, but 92 × 24 hours plus one: BST ends between them. A
    // shift measured in milliseconds would land the running order an hour out.
    expect(dayShift(day(2026, 8, 7), day(2026, 11, 7))).toBe(92)
  })

  it('ignores the time of day the dates happen to carry', () => {
    // `startsOn` is a date, but nothing stops a row holding a time with it —
    // and a stray fifteen hours must not round the shift to the wrong day.
    expect(dayShift(day(2026, 8, 7, 23), day(2026, 8, 8, 1))).toBe(1)
  })

  it('moves backwards as readily as forwards', () => {
    expect(dayShift(day(2027, 8, 6), day(2026, 8, 7))).toBe(-364)
  })

  it('does not guess when either event has no start date', () => {
    expect(dayShift(null, day(2027, 8, 6))).toBe(0)
    expect(dayShift(day(2026, 8, 7), null)).toBe(0)
    expect(dayShift(null, null)).toBe(0)
  })
})
