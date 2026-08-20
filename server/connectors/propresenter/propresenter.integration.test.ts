import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type ProPresenterConfig, propresenterModule } from './index.js'
import { ProPresenterSimulator } from './simulator.js'

interface TimersPayload {
  timers: { uuid: string; name: string; seconds: number; state: string }[]
}

/** Fast enough that a test does not spend its life waiting for the next tick. */
const FAST_POLL = { pollIntervalMs: 250 }

const timer = (payload: TimersPayload, uuid: string) =>
  payload.timers.find((entry) => entry.uuid === uuid)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The connector runs against a real HTTP server speaking ProPresenter's API.
 * The scenarios are the ones that actually happen on site: the operator quits
 * the app, a timer runs into overrun, and a machine turns up with a version
 * that has never heard of the stage-message endpoint.
 */
describe('propresenter connector against its simulator', () => {
  it('connects, reports online, and publishes the show timers', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')

        const [payload] = recorder.payloads<TimersPayload>('timers')
        expect(payload?.timers).toContainEqual({
          uuid: 'timer-main',
          name: 'Main Set',
          seconds: 272,
          state: 'running',
        })
        expect(payload?.timers).toHaveLength(2)
      },
    )
  })

  it('publishes the system time the timers are counted against', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder }) => {
        await recorder.waitForFrame('systemTime')
        const [payload] = recorder.payloads<{ time: string }>('systemTime')
        expect(payload?.time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      },
    )
  })

  it('publishes the current and next slide', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder }) => {
        await recorder.waitForFrame('slide')
        expect(recorder.payloads('slide')[0]).toEqual({
          current: 'Welcome to the Meadow Stage',
          next: 'Please silence your phones',
        })
      },
    )
  })

  it('publishes a null next slide at the end of a playlist', async () => {
    const simulator = new ProPresenterSimulator()
    simulator.setSlide('Encore', null)

    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL, simulator },
      async ({ recorder }) => {
        await recorder.waitForFrame('slide')
        expect(recorder.payloads('slide')[0]).toEqual({ current: 'Encore', next: null })
      },
    )
  })

  it('publishes the stage message when one goes up', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator }) => {
        // Nothing is up at load-in, and the blank is worth publishing so the
        // widget shows empty rather than nothing at all.
        await recorder.waitForFrame('stageMessage', (p: { message: string }) => p.message === '')

        simulator.setStageMessage('Wrap up — 5 minutes to curfew')
        await recorder.waitForFrame(
          'stageMessage',
          (p: { message: string }) => p.message === 'Wrap up — 5 minutes to curfew',
        )
      },
    )
  })

  it('reads an overrunning timer as negative seconds', async () => {
    const simulator = new ProPresenterSimulator()
    simulator.setTimer('timer-main', 'Main Set', 5, 'running')

    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL, simulator },
      async ({ recorder }) => {
        await recorder.waitForFrame('timers')

        // The set runs twelve seconds past its slot: the number the noise
        // officer cares about is -7, not 7.
        simulator.advanceTimers(12)
        await recorder.waitForFrame(
          'timers',
          (p: TimersPayload) => timer(p, 'timer-main')?.seconds === -7,
        )
      },
    )
  })

  it('keeps polling every endpoint on the interval', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        recorder.clear()
        // Two more frames means two more complete cycles have gone round.
        await recorder.waitForFrame('timers')
        recorder.clear()
        await recorder.waitForFrame('timers')

        const paths = simulator.requestedPaths
        expect(paths.filter((p) => p === '/v1/timers/current').length).toBeGreaterThanOrEqual(2)
        expect(paths).toContain('/v1/timer/system_time')
        expect(paths).toContain('/v1/status/slide')
        expect(paths).toContain('/v1/stage/message')
      },
    )
  })

  it('republishes the slide only when it actually changes', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('slide')
        recorder.clear()

        // Three polls' worth of an unchanged slide must not become three
        // entries in the event history the show report is written from.
        await sleep(800)
        expect(recorder.payloads('slide')).toHaveLength(0)
        expect(recorder.payloads('timers').length).toBeGreaterThanOrEqual(2)

        simulator.setSlide('Headliner walk-on', 'Curfew notice')
        await recorder.waitForFrame(
          'slide',
          (p: { current: string | null }) => p.current === 'Headliner walk-on',
        )
      },
    )
  })

  it('stays online when an optional endpoint is not served at all', async () => {
    const simulator = new ProPresenterSimulator()
    simulator.setAbsent('stageMessage')
    simulator.setAbsent('slide')

    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL, simulator },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')
        recorder.clear()
        await recorder.waitForFrame('timers')

        // A 404 on a stage-display endpoint means the feature is absent, not
        // that the machine is down: the timers must keep flowing.
        expect(supervisor.status.state).toBe('online')
        expect(recorder.payloads('slide')).toHaveLength(0)
        expect(recorder.payloads('stageMessage')).toHaveLength(0)
      },
    )
  })

  it('goes offline and reconnects when the timers endpoint starts failing', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')

        const backOnline = recorder.waitForNextState('online')
        // A whole cycle's worth of failures, so the required endpoint is
        // certain to be among them whatever point in the cycle we are at.
        simulator.failNextRequests(4)
        await recorder.waitForState('offline')
        await backOnline

        recorder.clear()
        await recorder.waitForFrame('timers')
      },
    )
  })

  it('reconnects by itself after the operator quits the app', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')

        const backOnline = recorder.waitForNextState('online')
        simulator.dropConnections()
        await recorder.waitForState('offline')

        // ...and it comes back without anyone touching the dashboard.
        await backOnline
        recorder.clear()
        await recorder.waitForFrame('timers')
      },
    )
  })

  it('survives a body that is not JSON without dropping offline', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, simulator, supervisor }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')
        recorder.clear()

        simulator.sendGarbage(8)
        await sleep(600)

        // Still online, still polling: an HTML error page from a crashing
        // plugin is not a reason to declare the machine gone.
        expect(supervisor.status.state).toBe('online')
        expect(recorder.states).not.toContain('offline')

        recorder.clear()
        await recorder.waitForFrame('timers')
      },
    )
  })

  it('stops and starts a timer, and the change shows up in the stream', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        expect(await exec('timer.stop', { uuid: 'timer-main' })).toMatchObject({ ok: true })
        await recorder.waitForFrame(
          'timers',
          (p: TimersPayload) => timer(p, 'timer-main')?.state === 'stopped',
        )

        expect(await exec('timer.start', { uuid: 'timer-main' })).toMatchObject({ ok: true })
        await recorder.waitForFrame(
          'timers',
          (p: TimersPayload) => timer(p, 'timer-main')?.state === 'running',
        )
      },
    )
  })

  it('resets a timer back to its configured duration', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, exec, simulator }) => {
        await recorder.waitForFrame('timers')

        simulator.advanceTimers(60)
        await recorder.waitForFrame(
          'timers',
          (p: TimersPayload) => timer(p, 'timer-main')?.seconds === 212,
        )

        expect(await exec('timer.reset', { uuid: 'timer-main' })).toMatchObject({ ok: true })
        await recorder.waitForFrame(
          'timers',
          (p: TimersPayload) =>
            timer(p, 'timer-main')?.seconds === 272 && timer(p, 'timer-main')?.state === 'stopped',
        )
      },
    )
  })

  it('rejects a command whose input fails validation', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        expect(await exec('timer.start', { uuid: '' })).toMatchObject({
          ok: false,
          error: { code: 'INVALID_INPUT' },
        })
        expect(await exec('timer.start', {})).toMatchObject({
          ok: false,
          error: { code: 'INVALID_INPUT' },
        })
      },
    )
  })

  it('rejects an unknown command', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        expect(await exec('timer.explode', { uuid: 'timer-main' })).toMatchObject({
          ok: false,
          error: { code: 'NOT_FOUND' },
        })
      },
    )
  })

  it('reports a device error for a timer the machine does not have', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('timer.start', { uuid: 'timer-that-left-with-the-trucks' })
        expect(result).toMatchObject({ ok: false, error: { code: 'DEVICE_ERROR' } })
      },
    )
  })

  it('sends the network password when one is configured', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: { ...FAST_POLL, password: 'meadow-2026' } },
      async ({ recorder }) => {
        // The simulator does not enforce it; what matters here is that a
        // configured password does not stop the connector working.
        await recorder.waitForState('online')
        await recorder.waitForFrame('timers')
      },
    )
  })

  it('stops polling and goes quiet when the supervisor stops', async () => {
    await withConnector<ProPresenterConfig, ProPresenterSimulator>(
      propresenterModule,
      { config: FAST_POLL },
      async ({ recorder, supervisor, simulator }) => {
        await recorder.waitForState('online')
        await supervisor.stop()
        expect(supervisor.status.state).toBe('stopped')

        recorder.clear()
        const requestsAtStop = simulator.requestedPaths.length
        await sleep(600)

        // A removed instance must stop both publishing and knocking on the
        // show Mac's door.
        expect(recorder.frames).toHaveLength(0)
        expect(simulator.requestedPaths).toHaveLength(requestsAtStop)
      },
    )
  })
})
