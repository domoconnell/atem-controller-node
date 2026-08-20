import type { WeatherConfig } from './index.js'

export interface WeatherLocation {
  latitude: number
  longitude: number
  /** What the widget calls it. */
  name: string
  /**
   * Is this the show's own site?
   *
   * The widget labels itself only when it is not. A board where every weather
   * widget announces the venue everybody is standing in spends pixels saying
   * nothing; a board with a second widget for the car park needs to say which
   * is which, or the two are indistinguishable.
   */
  isVenue: boolean
}

/**
 * A coordinate pair as somebody would paste it.
 *
 * "53.2870, -0.5480" is what a right-click in Google Maps puts on the
 * clipboard, and typing two numbers into two boxes is where a decimal point
 * goes missing and the weather comes from the North Sea. Also accepts a space
 * or a semicolon between them, and tolerates the degree signs some sites add.
 *
 * Deliberately does not accept degrees-minutes-seconds. Half-supporting a
 * format is worse than not: "53 17 13 N" parsed as a decimal is a place in
 * Kazakhstan, and it would fail silently.
 */
export function parseCoordinates(input: string): { latitude: number; longitude: number } | null {
  const cleaned = input.trim().replace(/[°\s]+/g, ' ')
  if (cleaned === '') return null

  const parts = cleaned.split(/[,;]|\s+/).filter(Boolean)
  if (parts.length !== 2) return null

  const latitude = Number(parts[0])
  const longitude = Number(parts[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90) return null
  if (longitude < -180 || longitude > 180) return null

  return { latitude, longitude }
}

/**
 * Where this module should fetch the weather for.
 *
 * In order: the event's venue when the module is following it, then a pasted
 * coordinate pair, then the two numeric fields. The venue wins because that is
 * the whole point — a module that follows the show should not need touching
 * when the show moves — and it falls through when the event has no coordinates
 * yet, so a box being set up before anybody has typed the address still shows
 * weather rather than nothing.
 */
export function resolveLocation(
  config: Pick<
    WeatherConfig,
    'useEventVenue' | 'coordinates' | 'latitude' | 'longitude' | 'locationName'
  >,
  venue: { latitude: number; longitude: number } | null,
): WeatherLocation {
  if (config.useEventVenue && venue) {
    return { ...venue, name: config.locationName || 'Site', isVenue: true }
  }

  const pasted = parseCoordinates(config.coordinates)
  if (pasted) return { ...pasted, name: config.locationName || 'Site', isVenue: false }

  return {
    latitude: config.latitude,
    longitude: config.longitude,
    name: config.locationName || 'Site',
    isVenue: false,
  }
}
