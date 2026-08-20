/**
 * Weather provider adapters.
 *
 * Two providers, one shape. met.no is the default because it is free for
 * commercial use with no key — it just asks for an identifying User-Agent and
 * attribution. Open-Meteo's commercial plan is offered as an alternative
 * because its single response carries precipitation *probability* and daily
 * gust maxima, which met.no only populates in the Nordics.
 */

export interface CurrentWeather {
  temperatureC: number | null
  humidityPct: number | null
  windMs: number | null
  gustMs: number | null
  windFromDeg: number | null
  precipitationMm: number | null
  /** Provider's own symbol code, if it gives one. */
  symbol: string | null
  observedAt: number
}

export interface ForecastDay {
  /** ISO date, local to the venue. */
  date: string
  minTempC: number | null
  maxTempC: number | null
  precipitationMm: number | null
  /** Null where the provider does not model it — met.no outside the Nordics. */
  precipitationProbabilityPct: number | null
  maxWindMs: number | null
  maxGustMs: number | null
  symbol: string | null
}

export interface WeatherReading {
  current: CurrentWeather
  days: ForecastDay[]
  attribution: string
}

export interface WeatherProvider {
  readonly id: 'met.no' | 'open-meteo'
  /** Everything in one call: both providers support that, so we lean on it. */
  fetch(input: {
    latitude: number
    longitude: number
    days: number
    signal: AbortSignal
  }): Promise<WeatherReading>
}

const MET_NO_ATTRIBUTION = 'Data from MET Norway'
const OPEN_METEO_ATTRIBUTION = 'Data from Open-Meteo'

/**
 * met.no Locationforecast 2.0.
 *
 * Free including commercial use under CC BY 4.0, no API key, but it will
 * reject a request without an identifying User-Agent — so that is required
 * config rather than an optional nicety.
 */
export class MetNoProvider implements WeatherProvider {
  readonly id = 'met.no' as const

  constructor(private readonly userAgent: string) {}

  async fetch(input: {
    latitude: number
    longitude: number
    days: number
    signal: AbortSignal
  }): Promise<WeatherReading> {
    const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/complete')
    url.searchParams.set('lat', input.latitude.toFixed(4))
    url.searchParams.set('lon', input.longitude.toFixed(4))

    const response = await fetch(url, {
      signal: input.signal,
      headers: { 'user-agent': this.userAgent, accept: 'application/json' },
    })
    if (!response.ok) throw new WeatherRefused(response.status, 'met.no')

    return parseMetNo(await response.json(), input.days)
  }
}

/**
 * A weather service that answered and said no.
 *
 * Distinct from a dropped connection because the two want opposite responses.
 * A show site loses its uplink constantly and that is nothing to act on; a
 * refusal will still be a refusal in an hour, and somebody has to change a
 * setting. Carrying the status lets the connector say which happened rather
 * than reporting both as "unreachable" — which is what it did, and which sent
 * the reader to look at the network.
 */
export class WeatherRefused extends Error {
  constructor(
    readonly status: number,
    readonly service: string,
  ) {
    super(`${service} returned ${status}`)
  }
}

/** Open-Meteo commercial: one call, every field we want, plus probabilities. */
export class OpenMeteoProvider implements WeatherProvider {
  readonly id = 'open-meteo' as const

  constructor(private readonly apiKey: string) {}

  async fetch(input: {
    latitude: number
    longitude: number
    days: number
    signal: AbortSignal
  }): Promise<WeatherReading> {
    const url = new URL('https://customer-api.open-meteo.com/v1/forecast')
    url.searchParams.set('apikey', this.apiKey)
    url.searchParams.set('latitude', String(input.latitude))
    url.searchParams.set('longitude', String(input.longitude))
    url.searchParams.set('forecast_days', String(input.days))
    url.searchParams.set('timezone', 'auto')
    url.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation',
    )
    url.searchParams.set(
      'daily',
      'temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max',
    )

    const response = await fetch(url, {
      signal: input.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new WeatherRefused(response.status, 'Open-Meteo')

    return parseOpenMeteo(await response.json())
  }
}

// ------------------------------------------------------------------- parsing

export function parseMetNo(body: unknown, days: number): WeatherReading {
  const series = asArray(
    (asRecord(asRecord(body).properties).timeseries as unknown[] | undefined) ?? [],
  )
  if (series.length === 0) throw new Error('met.no returned no timeseries')

  const first = asRecord(series[0])
  const details = asRecord(asRecord(asRecord(first.data).instant).details)
  const nextHour = asRecord(asRecord(first.data).next_1_hours)

  const current: CurrentWeather = {
    temperatureC: num(details.air_temperature),
    humidityPct: num(details.relative_humidity),
    windMs: num(details.wind_speed),
    gustMs: num(details.wind_speed_of_gust),
    windFromDeg: num(details.wind_from_direction),
    precipitationMm: num(asRecord(nextHour.details).precipitation_amount),
    symbol: str(asRecord(nextHour.summary).symbol_code),
    observedAt: Date.parse(str(first.time) ?? '') || Date.now(),
  }

  // met.no has no daily endpoint: the day rows are aggregated from the hourly
  // series, which is why the numbers are min/max/sum rather than model output.
  const buckets = new Map<string, ForecastDay>()
  for (const entry of series) {
    const record = asRecord(entry)
    const time = str(record.time)
    if (!time) continue
    const date = time.slice(0, 10)

    const instant = asRecord(asRecord(asRecord(record.data).instant).details)
    const hour = asRecord(asRecord(record.data).next_1_hours)
    const hourDetails = asRecord(hour.details)

    const day = buckets.get(date) ?? {
      date,
      minTempC: null,
      maxTempC: null,
      precipitationMm: null,
      // Only populated in met.no's Nordic post-processed domain; elsewhere it
      // is genuinely absent rather than zero, and the widget says so.
      precipitationProbabilityPct: null,
      maxWindMs: null,
      maxGustMs: null,
      symbol: null,
    }

    const temp = num(instant.air_temperature)
    if (temp !== null) {
      day.minTempC = day.minTempC === null ? temp : Math.min(day.minTempC, temp)
      day.maxTempC = day.maxTempC === null ? temp : Math.max(day.maxTempC, temp)
    }

    const wind = num(instant.wind_speed)
    if (wind !== null) day.maxWindMs = Math.max(day.maxWindMs ?? 0, wind)

    const gust = num(instant.wind_speed_of_gust)
    if (gust !== null) day.maxGustMs = Math.max(day.maxGustMs ?? 0, gust)

    const rain = num(hourDetails.precipitation_amount)
    if (rain !== null) day.precipitationMm = (day.precipitationMm ?? 0) + rain

    const probability = num(hourDetails.probability_of_precipitation)
    if (probability !== null) {
      day.precipitationProbabilityPct = Math.max(day.precipitationProbabilityPct ?? 0, probability)
    }

    // Midday symbol is the one that reads as "what sort of day is it".
    if (!day.symbol && time.slice(11, 13) === '12') {
      day.symbol = str(asRecord(hour.summary).symbol_code)
    }

    buckets.set(date, day)
  }

  return {
    current,
    days: [...buckets.values()].slice(0, days),
    attribution: MET_NO_ATTRIBUTION,
  }
}

export function parseOpenMeteo(body: unknown): WeatherReading {
  const root = asRecord(body)
  const current = asRecord(root.current)
  const daily = asRecord(root.daily)

  const dates = asArray(daily.time as unknown[] | undefined).map((value) => str(value) ?? '')

  return {
    current: {
      temperatureC: num(current.temperature_2m),
      humidityPct: num(current.relative_humidity_2m),
      windMs: num(current.wind_speed_10m),
      gustMs: num(current.wind_gusts_10m),
      windFromDeg: num(current.wind_direction_10m),
      precipitationMm: num(current.precipitation),
      symbol: null,
      observedAt: Date.parse(str(current.time) ?? '') || Date.now(),
    },
    days: dates.map((date, index) => ({
      date,
      minTempC: numAt(daily.temperature_2m_min, index),
      maxTempC: numAt(daily.temperature_2m_max, index),
      precipitationMm: numAt(daily.precipitation_sum, index),
      precipitationProbabilityPct: numAt(daily.precipitation_probability_max, index),
      maxWindMs: numAt(daily.wind_speed_10m_max, index),
      maxGustMs: numAt(daily.wind_gusts_10m_max, index),
      symbol: null,
    })),
    attribution: OPEN_METEO_ATTRIBUTION,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numAt(list: unknown, index: number): number | null {
  return Array.isArray(list) ? num(list[index]) : null
}
