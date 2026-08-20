import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { weatherModule } from './index.js'
import { WeatherSimulator } from './simulator.js'

/** Fast enough to observe a recovery, slow enough not to hammer a real provider. */
const FAST_POLL = { pollIntervalSeconds: 5 } as never

describe('weather connector', () => {
  it('publishes current conditions and a forecast', async () => {
    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      { config: { forecastDays: 2, pollIntervalSeconds: 5 } as never },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('forecast')

        const current = recorder.frames.find((frame) => frame.streamId === 'current')?.payload as {
          temperatureC: number
          windMs: number
        }
        expect(current.temperatureC).toBeTypeOf('number')
        expect(current.windMs).toBe(4)

        const forecast = recorder.frames.find((frame) => frame.streamId === 'forecast')
          ?.payload as {
          days: unknown[]
          attribution: string
          hasProbability: boolean
        }
        expect(forecast.days).toHaveLength(2)
        // The attribution is a licence condition, not decoration.
        expect(forecast.attribution).toContain('MET Norway')
        // met.no does not model rain probability outside the Nordics; the
        // widget states that rather than showing an empty column.
        expect(forecast.hasProbability).toBe(false)
      },
    )
  })

  it('fetches the event venue without being told where it is', async () => {
    /*
     * The whole point of the venue default: a weather module added at a new
     * event needs no coordinates, and moving the show moves the weather. The
     * config below deliberately carries the shipped default of London while
     * the event is at the Lincolnshire Showground.
     */
    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      {
        config: { pollIntervalSeconds: 5 } as never,
        venue: { latitude: 53.287, longitude: -0.548 },
      },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('current')
        expect(simulator.lastQuery).toEqual({ lat: '53.2870', lon: '-0.5480' })
      },
    )
  })

  it('watches somewhere else when a module is told not to follow the venue', async () => {
    // A second module for the car park, the airfield, the campsite gate.
    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      {
        config: {
          pollIntervalSeconds: 5,
          useEventVenue: false,
          coordinates: '51.4700, -0.4543',
        } as never,
        venue: { latitude: 53.287, longitude: -0.548 },
      },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('current')
        expect(simulator.lastQuery).toEqual({ lat: '51.4700', lon: '-0.4543' })
      },
    )
  })

  it('falls back to its own coordinates when the event has no venue yet', async () => {
    // A box being set up before anybody has typed the address still shows
    // weather rather than nothing.
    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      { config: { pollIntervalSeconds: 5, latitude: 12.5, longitude: 34.25 } as never },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('current')
        expect(simulator.lastQuery).toEqual({ lat: '12.5000', lon: '34.2500' })
      },
    )
  })

  it('degrades rather than failing when the service is unreachable', async () => {
    // A show network with no internet is a normal Tuesday and must not look
    // like a broken integration. Pre-armed so the first poll already fails,
    // rather than waiting out two polling intervals.
    const simulator = new WeatherSimulator()
    simulator.setFailing(true)

    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      { config: FAST_POLL, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('degraded')

        simulator.setFailing(false)
        await recorder.waitForNextState('online', 15_000)
      },
    )
  })

  it('survives a truncated response', async () => {
    const simulator = new WeatherSimulator()
    simulator.sendGarbage()

    await withConnector<never, WeatherSimulator>(
      weatherModule as never,
      { config: FAST_POLL, simulator },
      async ({ recorder }) => {
        // Unparseable data degrades the module rather than taking it down, and
        // the next poll recovers on its own.
        await recorder.waitForState('degraded')
        await recorder.waitForNextState('online', 15_000)
      },
    )
  })

  it('flags high wind through its condition', () => {
    const wind = weatherModule.meta.conditions?.find((c) => c.id === 'wind.over')
    expect(wind).toBeDefined()

    expect(wind?.evaluate({ windMs: 4 }, { ms: 11 })[0]?.active).toBe(false)
    expect(wind?.evaluate({ windMs: 14.2 }, { ms: 11 })[0]).toMatchObject({
      active: true,
      value: 14.2,
    })
  })
})
