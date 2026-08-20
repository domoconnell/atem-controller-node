import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { weatherConditions } from './conditions.js'
import { resolveLocation, type WeatherLocation } from './location.js'
import {
  MetNoProvider,
  OpenMeteoProvider,
  parseMetNo,
  type WeatherProvider,
  type WeatherReading,
  WeatherRefused,
} from './protocol.js'
import { WeatherSimulator } from './simulator.js'

/**
 * The address the module ships with, which met.no will not accept.
 *
 * It cannot ship with a working one — the point of the header is that it
 * identifies *you*, so MET Norway can get in touch when an integration
 * misbehaves. A default that cannot work is still worth having, because the
 * alternative is a required field that stops a demo instance being created at
 * all: `seedDemoInstances` passes `config: {}` and the supervisor parses that
 * before `simulatedConfig` has a chance to fill anything in.
 *
 * So it ships, and the connector refuses to send it. Named here so the check
 * and the default cannot drift apart.
 */
export const PLACEHOLDER_USER_AGENT = 'StageItLive/1.0 (ops@example.com)'

export const weatherConfigSchema = z.object({
  /**
   * Follow the event's venue, which is where the show is.
   *
   * On by default, so a module added at a new event needs no coordinates at
   * all — and so moving the show moves the weather with it. Turn it off for a
   * second module watching somewhere else: the car park two miles away, the
   * airfield the helicopter is coming from.
   */
  useEventVenue: z.boolean().default(true),
  /**
   * Somewhere else, when this module is not following the venue.
   *
   * Paste a coordinate pair as one string — "53.2870, -0.5480" is exactly what
   * a right-click in Google Maps gives you, so the convenient path is also the
   * one that avoids transcribing two numbers by hand. Left empty, the latitude
   * and longitude below are used instead.
   */
  coordinates: z.string().default(''),
  latitude: z.number().min(-90).max(90).default(51.5),
  longitude: z.number().min(-180).max(180).default(-0.13),
  locationName: z.string().default('Site'),
  forecastDays: z.number().int().min(1).max(7).default(3),
  /**
   * met.no asks for an identifying User-Agent and will refuse without one.
   * Put a real contact address here — it is how they reach you if the
   * integration misbehaves.
   */
  userAgent: z.string().min(1).default(PLACEHOLDER_USER_AGENT),
  /** Set to use Open-Meteo's commercial API, which adds rain probability. */
  openMeteoApiKey: z.string().optional(),
  /**
   * Seconds between fetches. The default is ten minutes — weather does not
   * move faster than that and providers ask not to be hammered — but a site
   * watching a wind limit may reasonably want it tighter.
   */
  pollIntervalSeconds: z.number().int().min(5).max(10_800).default(600),
  /** Test/simulator hook: overrides the provider's base URL. */
  baseUrlOverride: z.string().optional(),
})

export type WeatherConfig = z.infer<typeof weatherConfigSchema>

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Site weather, fetched by the server.
 *
 * Browsers never call the provider directly: one venue with thirty tablets
 * would otherwise be thirty times over whatever rate limit applies, from
 * thirty addresses, with no shared cache.
 */
class WeatherConnector implements Connector<WeatherConfig> {
  private ctx: ConnectorContext<WeatherConfig> | null = null
  private cancel: (() => void) | null = null
  private provider: WeatherProvider | null = null
  private fetching = false

  async start(ctx: ConnectorContext<WeatherConfig>): Promise<void> {
    this.ctx = ctx
    this.provider = ctx.config.openMeteoApiKey
      ? new OpenMeteoProvider(ctx.config.openMeteoApiKey)
      : new MetNoProvider(ctx.config.userAgent)

    this.cancel = ctx.setInterval(() => void this.poll(), ctx.config.pollIntervalSeconds * 1_000)
    await this.poll()
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
    this.ctx = null
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted || this.fetching) return
    this.fetching = true

    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(() => controller.abort(new Error('timed out')), REQUEST_TIMEOUT_MS)

    try {
      /*
       * Refused here rather than by met.no, and the difference matters on a
       * show site: with no uplink the request fails as "unreachable" and the
       * real problem — an address that identifies nobody — stays hidden until
       * the network comes back. This way it is legible from an office with the
       * kit still in the truck.
       */
      const refusal = placeholderRefusal(ctx.config)
      if (refusal) {
        ctx.setStatus('degraded', refusal)
        return
      }

      const where = resolveLocation(ctx.config, ctx.venue())
      const reading = this.ctx?.config.baseUrlOverride
        ? await this.fetchFromOverride(ctx, where, controller.signal)
        : await this.provider!.fetch({
            latitude: where.latitude,
            longitude: where.longitude,
            days: ctx.config.forecastDays,
            signal: controller.signal,
          })

      if (ctx.signal.aborted) return

      ctx.setStatus('online')
      ctx.publish('current', {
        ...reading.current,
        location: where.name,
        isVenue: where.isVenue,
        /*
         * On both streams, not only the forecast.
         *
         * MET Norway's licence asks for the credit wherever their data is
         * shown, and the current conditions are their data too. It lived on
         * the forecast alone, so a widget configured to show today and nothing
         * else — which the forecast-days setting has always allowed at zero —
         * dropped the attribution with the strip that carried it.
         */
        attribution: reading.attribution,
      })
      ctx.publish('forecast', {
        location: where.name,
        days: reading.days,
        attribution: reading.attribution,
        // Stated rather than left blank: met.no simply does not model rain
        // probability outside the Nordics, and a silently empty column looks
        // like a bug.
        hasProbability: reading.days.some((day) => day.precipitationProbabilityPct !== null),
      })
    } catch (error) {
      /*
       * A refusal and a dropped uplink are both degraded, and they need
       * opposite things said about them.
       *
       * Losing the internet is normal on a show site: report it, keep the last
       * reading on screen, and let staleness speak for itself. A **403** is
       * not that. met.no refuses a User-Agent that does not identify anybody,
       * which the shipped default deliberately does not — and this said
       * "Weather service unreachable", sending whoever read it to look at a
       * network that was working perfectly.
       *
       * The detail is the badge, and the badge is all most people will see.
       * The `vendorNotes` explained this correctly the whole time, in prose,
       * on a different page.
       */
      ctx.setStatus('degraded', describeFailure(error))
      ctx.logger.debug({ err: error }, 'weather fetch failed')
    } finally {
      clearTimeout(deadline)
      ctx.signal.removeEventListener('abort', onAbort)
      this.fetching = false
    }
  }

  /** Simulator path: same parser, different host. */
  /**
   * The simulator path, which must ask the same question as the real one.
   *
   * It used to send no coordinates at all, which meant the simulator could not
   * tell where the connector thought it was — so nothing tested that a module
   * following the venue actually fetches the venue. A protocol simulator that
   * is not asked the real question cannot answer for the real behaviour.
   */
  private async fetchFromOverride(
    ctx: ConnectorContext<WeatherConfig>,
    where: WeatherLocation,
    signal: AbortSignal,
  ): Promise<WeatherReading> {
    const url = new URL(`${ctx.config.baseUrlOverride}/weatherapi/locationforecast/2.0/complete`)
    url.searchParams.set('lat', where.latitude.toFixed(4))
    url.searchParams.set('lon', where.longitude.toFixed(4))

    const response = await fetch(url, {
      signal,
      headers: { 'user-agent': ctx.config.userAgent, accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`weather source returned ${response.status}`)
    return parseMetNo(await response.json(), ctx.config.forecastDays)
  }
}

/**
 * What to put on the badge, which for most people is the whole diagnosis.
 *
 * A 403 from met.no means the User-Agent did not identify anybody — not that
 * the internet is down, which is what this used to say and which sends the
 * reader to check a network that is working.
 */
/**
 * Why not to bother asking, when the answer is already known.
 *
 * The module ships with an address that identifies nobody, and met.no answers
 * that with a 403. Caught here rather than by the round trip because on a show
 * site the round trip usually fails for a different reason first — no uplink —
 * and the real problem stays hidden behind "unreachable" until the network
 * comes back. This way it is legible from an office with the kit in the truck.
 *
 * Skipped when a base URL is overridden: that is the simulator, which is not
 * met.no and does not care who is asking.
 */
export function placeholderRefusal(
  config: Pick<WeatherConfig, 'baseUrlOverride' | 'userAgent'>,
): string | null {
  if (config.baseUrlOverride) return null
  if (config.userAgent !== PLACEHOLDER_USER_AGENT) return null
  return 'Put a real contact address in the User-Agent — met.no refuses the example one'
}

export function describeFailure(error: unknown): string {
  if (error instanceof WeatherRefused && error.status === 403) {
    return `${error.service} refused this User-Agent — put a real contact address in the module settings`
  }
  if (error instanceof WeatherRefused) return `${error.service} returned ${error.status}`
  return 'Weather service unreachable'
}

export const weatherModule: ConnectorModule<WeatherConfig> = {
  meta: {
    typeId: 'weather',
    displayName: 'Site weather',
    description:
      'Current conditions and a short forecast for the site, fetched by the server so every ' +
      'screen shows the same numbers and the provider sees one caller. Wind and gust limits ' +
      'are the ones that stop shows, so they are first-class alert conditions.',
    configSchema: weatherConfigSchema,
    streams: [
      {
        id: 'current',
        label: 'Current conditions',
        rateClass: 'slow',
        history: 'metric',
        metricFields: ['temperatureC', 'windMs', 'gustMs', 'precipitationMm'],
        fields: [
          { id: 'temperatureC', kind: 'number', label: 'Temperature', unit: '°C' },
          { id: 'humidityPct', kind: 'number', label: 'Humidity', unit: '%' },
          { id: 'windMs', kind: 'number', label: 'Wind', unit: 'm/s' },
          { id: 'gustMs', kind: 'number', label: 'Gusts', unit: 'm/s' },
          { id: 'windFromDeg', kind: 'number', label: 'Wind direction', unit: '°' },
          { id: 'precipitationMm', kind: 'number', label: 'Rainfall', unit: 'mm' },
          { id: 'observedAt', kind: 'number', label: 'Observed at' },
          { id: 'symbol', kind: 'string', label: 'Conditions' },
          { id: 'location', kind: 'string', label: 'Location' },
        ],
      },
      {
        id: 'forecast',
        label: 'Forecast',
        rateClass: 'slow',
        fields: [
          { id: 'location', kind: 'string', label: 'Location' },
          { id: 'attribution', kind: 'string', label: 'Attribution' },
          { id: 'hasProbability', kind: 'boolean', label: 'Has probability' },
        ],
      },
    ],
    commands: [],
    conditions: weatherConditions,
    capabilities: { control: false },
    tier: 'official',
    vendorNotes:
      'Uses MET Norway (api.met.no) by default: free for commercial use, no key, but it ' +
      'requires an identifying User-Agent — put a real contact address in the config, and ' +
      'keep the "Data from MET Norway" attribution visible. MET Norway does not model ' +
      'precipitation probability outside the Nordics, so that column stays empty for UK ' +
      'sites; set an Open-Meteo commercial API key to get it. Needs outbound internet, ' +
      'which many show networks do not have — the module degrades rather than failing.',
  },
  create: () => new WeatherConnector(),
  createSimulator: () => new WeatherSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    baseUrlOverride: `http://${address.host}:${address.port}`,
    // The key would send the real connector to Open-Meteo instead of the fake.
    openMeteoApiKey: undefined,
  }),
}
