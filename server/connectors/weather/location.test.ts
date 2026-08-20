import { describe, expect, it } from 'vitest'
import { parseCoordinates, resolveLocation } from './location.js'

const VENUE = { latitude: 53.287, longitude: -0.548 }
const config = (over: Partial<Parameters<typeof resolveLocation>[0]> = {}) => ({
  useEventVenue: true,
  coordinates: '',
  latitude: 51.5,
  longitude: -0.13,
  locationName: 'Site',
  ...over,
})

describe('parseCoordinates', () => {
  it('takes what a right-click in Google Maps puts on the clipboard', () => {
    expect(parseCoordinates('53.2870, -0.5480')).toEqual({ latitude: 53.287, longitude: -0.548 })
  })

  it('is forgiving about the separator and the degree signs', () => {
    for (const input of [
      '53.287 -0.548',
      '53.287;-0.548',
      '53.287°, -0.548°',
      '  53.287,-0.548 ',
    ]) {
      expect(parseCoordinates(input), input).toEqual({ latitude: 53.287, longitude: -0.548 })
    }
  })

  it('refuses anything it cannot be sure of', () => {
    // Degrees-minutes-seconds is deliberately unsupported: read as a decimal,
    // "53 17 13" is a place in Kazakhstan, and it would fail silently.
    for (const input of ['', 'Lincoln', '53.287', '53 17 13 N', '53.287, -0.548, 12']) {
      expect(parseCoordinates(input), input).toBeNull()
    }
  })

  it('refuses a coordinate that is not on the planet', () => {
    expect(parseCoordinates('91, 0')).toBeNull()
    expect(parseCoordinates('0, 181')).toBeNull()
  })
})

describe('resolveLocation', () => {
  it('follows the event venue by default', () => {
    // The point of the whole thing: a module added at a new event needs no
    // coordinates, and moving the show moves the weather with it.
    expect(resolveLocation(config(), VENUE)).toEqual({ ...VENUE, name: 'Site', isVenue: true })
  })

  it('falls back to its own coordinates when the event has none yet', () => {
    // A box being set up before anybody has typed the address still shows
    // weather rather than nothing.
    expect(resolveLocation(config(), null)).toMatchObject({ latitude: 51.5, longitude: -0.13 })
  })

  it('watches somewhere else when told to', () => {
    const somewhere = config({
      useEventVenue: false,
      coordinates: '51.4700, -0.4543',
      locationName: 'Heathrow',
    })
    expect(resolveLocation(somewhere, VENUE)).toEqual({
      latitude: 51.47,
      longitude: -0.4543,
      name: 'Heathrow',
      // The widget labels itself only for somewhere that is not the site.
      isVenue: false,
    })
  })

  it('prefers the pasted pair over the two numeric fields', () => {
    const both = config({ useEventVenue: false, coordinates: '10, 20' })
    expect(resolveLocation(both, VENUE)).toMatchObject({ latitude: 10, longitude: 20 })
  })

  it('ignores an unparseable paste rather than fetching nowhere', () => {
    const rubbish = config({ useEventVenue: false, coordinates: 'the car park' })
    expect(resolveLocation(rubbish, VENUE)).toMatchObject({ latitude: 51.5, longitude: -0.13 })
  })

  it('always has a name, so two weather widgets can be told apart', () => {
    expect(resolveLocation(config({ locationName: '' }), VENUE).name).toBe('Site')
  })

  it("says whether it is the show's own site, which is what the widget labels on", () => {
    expect(resolveLocation(config(), VENUE).isVenue).toBe(true)
    // Falling back because the event has no coordinates is not the venue: the
    // shipped default is London, and calling that "the site" would be a lie.
    expect(resolveLocation(config(), null).isVenue).toBe(false)
    expect(resolveLocation(config({ useEventVenue: false }), VENUE).isVenue).toBe(false)
  })
})
