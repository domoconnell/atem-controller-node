import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type ReaperConfig, reaperModule } from './index.js'
import type { ReaperTrack, TransportState } from './protocol.js'
import type { ReaperSimulator } from './simulator.js'

type Transport = {
  state: TransportState
  positionSeconds: number
  positionString: string
  isRepeatOn: boolean
}
type Tracks = { count: number; armedCount: number; tracks: ReaperTrack[] }
type Disk = { freeMb: number }

/** Fast enough to keep the suite quick, still inside the configured minimum. */
const POLL = 250

/**
 * The REAPER connector against a real HTTP server speaking the web remote's
 * text protocol. The scenarios are the ones that actually happen at a
 * festival: the record op arms channels between sets, the record laptop drops
 * off the show network, and something that is not REAPER answers on port 8080.
 */
describe('reaper connector against its simulator', () => {
  it('connects, reports online, and publishes every declared stream', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('transport')
        await recorder.waitForFrame('tracks')
        await recorder.waitForFrame('disk')

        expect(recorder.payloads<Transport>('transport')[0]?.state).toBe('stopped')
        expect(recorder.payloads<Tracks>('tracks')[0]).toMatchObject({ count: 3, armedCount: 3 })
        expect(recorder.payloads<Disk>('disk')[0]).toEqual({ freeMb: 512_000 })
      },
    )
  })

  it('maps playstate 5 to recording, which is the whole point of the connector', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('transport', (p: Transport) => p.state === 'stopped')

        simulator.setPlayState(5)
        await recorder.waitForFrame('transport', (p: Transport) => p.state === 'recording')
      },
    )
  })

  it('maps the rest of the playstates REAPER reports', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')

        for (const [code, state] of [
          [1, 'playing'],
          [2, 'paused'],
          [6, 'record-paused'],
          // A code from a future REAPER must read as unknown, never as a
          // confident "stopped" over a rig that is actually rolling.
          [9, 'unknown'],
        ] as const) {
          simulator.setPlayState(code)
          await recorder.waitForFrame('transport', (p: Transport) => p.state === state)
        }
      },
    )
  })

  it('publishes the transport position on every tick', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        simulator.setPlayState(5)
        simulator.setPosition(123.456)
        simulator.setRepeat(true)

        await recorder.waitForFrame('transport', (p: Transport) => p.positionSeconds === 123.456)

        const frame = recorder
          .payloads<Transport>('transport')
          .find((p) => p.positionSeconds === 123.456)
        expect(frame).toMatchObject({ positionString: '2:03.456', isRepeatOn: true })
      },
    )
  })

  it('decodes the record-arm bit and the dB × 10 meter format', async () => {
    const simulator = reaperModule.createSimulator() as ReaperSimulator
    simulator.setTracks([
      { name: 'Kick', recordArmed: true, hasFx: true, peakDb: -12 },
      { name: 'Talkback', muted: true, peakDb: -30 },
      { name: 'Ambience', soloed: true, peakDb: 0 },
    ])

    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { simulator, config: { pollIntervalMs: POLL } },
      async ({ recorder }) => {
        await recorder.waitForFrame('tracks')

        const frame = recorder.payloads<Tracks>('tracks')[0]
        expect(frame?.tracks).toEqual([
          { number: 1, name: 'Kick', recordArmed: true, muted: false, soloed: false, peakDb: -12 },
          {
            number: 2,
            name: 'Talkback',
            recordArmed: false,
            muted: true,
            soloed: false,
            peakDb: -30,
          },
          {
            number: 3,
            name: 'Ambience',
            recordArmed: false,
            muted: false,
            soloed: true,
            peakDb: 0,
          },
        ])
        expect(frame?.armedCount).toBe(1)
      },
    )
  })

  it('truncates the track list but still counts the whole project', async () => {
    const simulator = reaperModule.createSimulator() as ReaperSimulator
    simulator.setTracks([
      { name: 'Kick', recordArmed: true },
      { name: 'Snare', recordArmed: true },
      { name: 'OH L', recordArmed: true },
      { name: 'OH R' },
      { name: 'Room' },
    ])

    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { simulator, config: { pollIntervalMs: POLL, trackLimit: 2 } },
      async ({ recorder }) => {
        await recorder.waitForFrame('tracks')

        // "How many channels are armed?" is a question about the session, not
        // about how much of it fits on the panel.
        expect(recorder.payloads<Tracks>('tracks')[0]).toMatchObject({
          count: 5,
          armedCount: 3,
        })
        expect(recorder.payloads<Tracks>('tracks')[0]?.tracks).toHaveLength(2)
      },
    )
  })

  it('tracks free disk space as it falls', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('disk', (p: Disk) => p.freeMb === 512_000)

        simulator.setDiskFreeMb(1_024)
        await recorder.waitForFrame('disk', (p: Disk) => p.freeMb === 1_024)
      },
    )
  })

  it('stays online and silent on disk when the ReaScript is not running', async () => {
    const simulator = reaperModule.createSimulator() as ReaperSimulator
    // The script is optional, so this is a supported setup — not a fault.
    simulator.clearExtState()

    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { simulator, config: { pollIntervalMs: POLL } },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('tracks')

        await new Promise((resolve) => setTimeout(resolve, POLL * 3))

        expect(recorder.payloads('transport').length).toBeGreaterThan(1)
        // Publishing a zero here would look like a full disk to anyone glancing
        // at the wall, so the stream says nothing at all.
        expect(recorder.payloads('disk')).toHaveLength(0)
        expect(supervisor.status.state).toBe('online')
      },
    )
  })

  it('reconnects by itself after the record machine stops answering', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      {
        config: { pollIntervalMs: POLL },
        backoff: { baseMs: 10, capMs: 20, random: () => 1 },
      },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('transport')

        // The record laptop leaves the show network mid-set.
        const backOnline = recorder.waitForNextState('online')
        simulator.failNextRequests(1)
        await recorder.waitForState('offline')

        // ...and it comes back without anyone touching the dashboard.
        await backOnline

        recorder.clear()
        await recorder.waitForFrame('transport')
      },
    )
  })

  it('survives a portal page answering on REAPER’s port once established', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator, supervisor }) => {
        await recorder.waitForState('online')
        recorder.clear()

        simulator.sendGarbage()

        // Still online, still publishing: a proxy hiccup is not an outage.
        await recorder.waitForFrame('transport')
        expect(supervisor.status.state).toBe('online')
        expect(recorder.states).not.toContain('offline')
      },
    )
  })

  it('says so plainly when the port is answering but is not REAPER', async () => {
    const simulator = reaperModule.createSimulator() as ReaperSimulator
    // Nothing REAPER-shaped has ever come back, so there is no reason to
    // believe the port is right — and "online, publishing nothing" is the
    // hardest kind of fault to diagnose at 8pm.
    simulator.sendGarbage()

    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      {
        simulator,
        config: { pollIntervalMs: POLL },
        backoff: { baseMs: 10, capMs: 20, random: () => 1 },
      },
      async ({ recorder }) => {
        await recorder.waitForState('offline')

        const offline = recorder.statuses.find((status) => status.state === 'offline')
        expect(offline?.detail).toContain('Not a REAPER web interface')

        // Once the real thing answers again it recovers on its own.
        await recorder.waitForState('online')
      },
    )
  })

  it('records, stops and plays, and the transport follows', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator, exec }) => {
        await recorder.waitForState('online')

        expect((await exec('record')).ok).toBe(true)
        await recorder.waitForFrame('transport', (p: Transport) => p.state === 'recording')

        expect((await exec('stop')).ok).toBe(true)
        await recorder.waitForFrame('transport', (p: Transport) => p.state === 'stopped')

        expect((await exec('play')).ok).toBe(true)
        await recorder.waitForFrame('transport', (p: Transport) => p.state === 'playing')

        expect(simulator.recordedActions).toEqual([1013, 1016, 1007])
      },
    )
  })

  it('rejects a transport command given nonsense input', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('record', 'start the whole festival')
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
        expect(simulator.recordedActions).toHaveLength(0)
      },
    )
  })

  it('rejects an unknown command', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('render', {})
        expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
      },
    )
  })

  it('stops cleanly and goes quiet', async () => {
    await withConnector<ReaperConfig, ReaperSimulator>(
      reaperModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        await supervisor.stop()
        expect(supervisor.status.state).toBe('stopped')

        // No frames may arrive after stop, or a removed widget would keep
        // updating from a connector nobody is supervising any more.
        recorder.clear()
        await new Promise((resolve) => setTimeout(resolve, POLL * 3))
        expect(recorder.frames).toHaveLength(0)
      },
    )
  })
})
