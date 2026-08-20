import { describe, expect, it } from 'vitest'
import {
  describeFailure,
  PLACEHOLDER_USER_AGENT,
  placeholderRefusal,
  weatherConfigSchema,
} from './index.js'
import { parseMetNo, parseOpenMeteo, WeatherRefused } from './protocol.js'

/** One hour of met.no's shape, which the aggregation folds into day rows. */
function metNoHour(time: string, overrides: Record<string, unknown> = {}) {
  return {
    time,
    data: {
      instant: {
        details: {
          air_temperature: 12,
          relative_humidity: 70,
          wind_speed: 5,
          wind_speed_of_gust: 9,
          wind_from_direction: 180,
          ...overrides,
        },
      },
      next_1_hours: {
        summary: { symbol_code: 'cloudy' },
        details: { precipitation_amount: 0.4 },
      },
    },
  }
}

describe('met.no parsing', () => {
  it('reads current conditions from the first entry', () => {
    const reading = parseMetNo(
      { properties: { timeseries: [metNoHour('2026-08-07T12:00:00Z')] } },
      1,
    )

    expect(reading.current).toMatchObject({
      temperatureC: 12,
      humidityPct: 70,
      windMs: 5,
      gustMs: 9,
    })
    expect(reading.attribution).toContain('MET Norway')
  })

  it('folds hourly entries into daily minimum, maximum and total', () => {
    // met.no has no daily endpoint, so this aggregation is the day row.
    const reading = parseMetNo(
      {
        properties: {
          timeseries: [
            metNoHour('2026-08-07T09:00:00Z', { air_temperature: 8, wind_speed: 3 }),
            metNoHour('2026-08-07T15:00:00Z', { air_temperature: 19, wind_speed: 12 }),
            metNoHour('2026-08-08T09:00:00Z', { air_temperature: 11 }),
          ],
        },
      },
      7,
    )

    expect(reading.days).toHaveLength(2)
    expect(reading.days[0]).toMatchObject({
      date: '2026-08-07',
      minTempC: 8,
      maxTempC: 19,
      maxWindMs: 12,
    })
    // 0.4 mm in each of two hours.
    expect(reading.days[0]?.precipitationMm).toBeCloseTo(0.8)
  })

  it('reports rain probability as absent rather than zero outside the Nordics', () => {
    // A silent zero would read as "definitely dry", which is a different and
    // much more dangerous claim than "not modelled here".
    const reading = parseMetNo(
      { properties: { timeseries: [metNoHour('2026-08-07T12:00:00Z')] } },
      1,
    )
    expect(reading.days[0]?.precipitationProbabilityPct).toBeNull()
  })

  it('honours the requested number of days', () => {
    const series = Array.from({ length: 5 }, (_, day) => metNoHour(`2026-08-0${day + 1}T12:00:00Z`))
    const reading = parseMetNo({ properties: { timeseries: series } }, 2)
    expect(reading.days).toHaveLength(2)
  })

  it('refuses an empty forecast rather than publishing nothing useful', () => {
    expect(() => parseMetNo({ properties: { timeseries: [] } }, 3)).toThrow()
  })

  it('survives missing fields', () => {
    const reading = parseMetNo(
      { properties: { timeseries: [{ time: '2026-08-07T12:00:00Z', data: {} }] } },
      1,
    )
    expect(reading.current.temperatureC).toBeNull()
    expect(reading.current.windMs).toBeNull()
  })
})

describe('Open-Meteo parsing', () => {
  it('maps the single response onto the same shape, with probability', () => {
    const reading = parseOpenMeteo({
      current: {
        time: '2026-08-07T12:00',
        temperature_2m: 21.4,
        relative_humidity_2m: 55,
        wind_speed_10m: 6.2,
        wind_gusts_10m: 11.8,
        wind_direction_10m: 200,
        precipitation: 0,
      },
      daily: {
        time: ['2026-08-07', '2026-08-08'],
        temperature_2m_min: [12, 13],
        temperature_2m_max: [23, 25],
        precipitation_sum: [0, 4.2],
        precipitation_probability_max: [10, 80],
        wind_speed_10m_max: [7, 9],
        wind_gusts_10m_max: [14, 19],
      },
    })

    expect(reading.current.temperatureC).toBe(21.4)
    expect(reading.days[1]).toMatchObject({
      date: '2026-08-08',
      precipitationProbabilityPct: 80,
      maxGustMs: 19,
    })
  })
})

describe('what a failure says on the badge', () => {
  it('names the User-Agent when met.no refuses it', () => {
    /*
     * The badge is the whole diagnosis for most people. This said "Weather
     * service unreachable", which on a show site sends the reader to check a
     * network that is working perfectly — met.no answered, and said no.
     */
    const detail = describeFailure(new WeatherRefused(403, 'met.no'))
    expect(detail).toContain('User-Agent')
    expect(detail).toContain('contact address')
    expect(detail).not.toContain('unreachable')
  })

  it('gives the status for any other refusal', () => {
    expect(describeFailure(new WeatherRefused(500, 'met.no'))).toBe('met.no returned 500')
  })

  it('still says unreachable when the connection actually failed', () => {
    // The normal case on a show site, and the one that genuinely is the
    // network: report it, keep the last reading, let staleness speak.
    expect(describeFailure(new Error('fetch failed'))).toBe('Weather service unreachable')
  })
})

describe('the address the module ships with', () => {
  it('is what the schema defaults to, so the check cannot drift', () => {
    // Two copies of this string is two chances to disagree, and the
    // disagreement would be a module that sends the placeholder and gets a
    // 403 it was supposed to have caught.
    expect(weatherConfigSchema.parse({}).userAgent).toBe(PLACEHOLDER_USER_AGENT)
  })

  it('identifies nobody, which is the point', () => {
    // met.no refuses it — verified against the real service, not assumed.
    // A default that works is impossible here: the header exists so they can
    // reach *you*.
    expect(PLACEHOLDER_USER_AGENT).toContain('example.com')
  })
})

describe('refusing to send the example address', () => {
  const real = 'StageItLive/1.0 (foh@greenfields.example)'

  it('refuses the shipped placeholder before asking met.no', () => {
    /*
     * On a show site the round trip usually fails for a different reason
     * first — no uplink — and "unreachable" hides the real problem until the
     * network comes back. Answered without a request, so it is legible from an
     * office with the kit still in the truck.
     */
    const config = { baseUrlOverride: undefined, userAgent: PLACEHOLDER_USER_AGENT }
    expect(placeholderRefusal(config)).toContain('contact address')
  })

  it('says nothing about an address somebody actually typed', () => {
    expect(placeholderRefusal({ baseUrlOverride: undefined, userAgent: real })).toBeNull()
  })

  it('leaves the simulator alone, which is not met.no and does not care', () => {
    // Demo mode and every integration test run through an override, and the
    // fake has no opinion about who is asking.
    expect(
      placeholderRefusal({
        baseUrlOverride: 'http://127.0.0.1:9',
        userAgent: PLACEHOLDER_USER_AGENT,
      }),
    ).toBeNull()
  })
})
