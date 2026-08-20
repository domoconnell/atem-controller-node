import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type HyperDeckConfig, hyperdeckModule } from './index.js'
import { HyperDeckSimulator } from './simulator.js'

interface TransportPayload {
  status: string
  speed: number | null
  slotId: number | null
  clipId: number | null
  timecode: string | null
  displayTimecode: string | null
}
interface SlotsPayload {
  slotId: number | null
  status: string
  volumeName: string | null
  recordingTimeSeconds: number | null
  videoFormat: string | null
}
interface DevicePayload {
  model: string | null
  protocolVersion: string | null
}

const run = (
  options: Parameters<typeof withConnector<HyperDeckConfig, HyperDeckSimulator>>[1],
  body: Parameters<typeof withConnector<HyperDeckConfig, HyperDeckSimulator>>[2],
) => withConnector<HyperDeckConfig, HyperDeckSimulator>(hyperdeckModule, options, body)

/**
 * The HyperDeck connector against a deck that behaves like the real thing:
 * it greets us, it pushes changes because we asked it to, it refuses to record
 * with no input, and it disappears when someone unplugs the switch.
 */
describe('hyperdeck connector against its simulator', () => {
  it('connects, reports online and publishes every declared stream', async () => {
    await run({}, async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('device')
      await recorder.waitForFrame('transport')
      await recorder.waitForFrame('slots')
    })
  })

  it('publishes the model and protocol version from the connection banner', async () => {
    await run({}, async ({ recorder }) => {
      await recorder.waitForFrame('device')
      expect(recorder.payloads<DevicePayload>('device')[0]).toEqual({
        model: 'HyperDeck Studio Mini',
        protocolVersion: '1.11',
      })
    })
  })

  it('parses a multi-line transport block into the transport stream', async () => {
    await run({}, async ({ recorder }) => {
      await recorder.waitForFrame('transport')
      expect(recorder.payloads<TransportPayload>('transport')[0]).toEqual({
        status: 'preview',
        speed: 0,
        slotId: 1,
        clipId: 1,
        timecode: '00:00:00:00',
        displayTimecode: '00:00:00:00',
      })
    })
  })

  it('publishes the recording time left on the card', async () => {
    await run({}, async ({ recorder, simulator }) => {
      await recorder.waitForFrame('slots')
      expect(recorder.payloads<SlotsPayload>('slots')[0]).toEqual({
        slotId: 1,
        status: 'mounted',
        volumeName: 'HyperDeck 1',
        recordingTimeSeconds: 3600,
        videoFormat: '1080p25',
      })

      // Twelve minutes left is the moment a card gets swapped between bands.
      simulator.setRecordingTime(720)
      await recorder.waitForFrame('slots', (p: SlotsPayload) => p.recordingTimeSeconds === 720)
    })
  })

  it('follows a pushed 508 transport update without waiting for the poll', async () => {
    // notify is the whole point: a record that stops because a card filled up
    // must reach the wall now, not in two seconds.
    await run({ config: { pollIntervalMs: 5_000 } }, async ({ recorder, simulator }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('transport')
      recorder.clear()

      const startedAt = Date.now()
      simulator.setTransport('record', { timecode: '01:00:00:00' })
      await recorder.waitForFrame('transport', (p: TransportPayload) => p.status === 'record')

      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(recorder.payloads<TransportPayload>('transport').at(-1)?.timecode).toBe('01:00:00:00')
    })
  })

  it('keeps polling as a safety net for a notification that never arrives', async () => {
    await run({ config: { pollIntervalMs: 500 } }, async ({ recorder }) => {
      await recorder.waitForState('online')
      recorder.clear()

      // Nothing changed and nothing was pushed; the poll alone must produce
      // fresh frames, or a missed notification would freeze the widget.
      await recorder.waitForFrame('transport')
      await recorder.waitForFrame('slots')
    })
  })

  it('reconnects by itself after the deck disappears', async () => {
    await run(
      { config: { pollIntervalMs: 500 }, backoff: { baseMs: 10, capMs: 20, random: () => 1 } },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('device')

        const backOnline = recorder.waitForNextState('online')
        simulator.dropConnections()
        await recorder.waitForState('offline')
        await backOnline

        // A second banner proves this is a fresh session rather than a stale
        // socket still dribbling data.
        expect(recorder.payloads('device').length).toBeGreaterThanOrEqual(2)

        recorder.clear()
        await recorder.waitForFrame('transport')
      },
    )
  })

  it('survives malformed lines without dropping the connection', async () => {
    await run({ config: { pollIntervalMs: 500 } }, async ({ recorder, simulator, supervisor }) => {
      await recorder.waitForState('online')
      recorder.clear()

      simulator.sendGarbage()

      await recorder.waitForFrame('transport')
      expect(supervisor.status.state).toBe('online')
      expect(recorder.states).not.toContain('offline')
    })
  })

  it('starts and stops a record', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      expect(await exec('record', {})).toMatchObject({ ok: true })
      await recorder.waitForFrame('transport', (p: TransportPayload) => p.status === 'record')

      expect(await exec('stop', {})).toMatchObject({ ok: true })
      await recorder.waitForFrame('transport', (p: TransportPayload) => p.status === 'stopped')
    })
  })

  it('names the clip when a name is given', async () => {
    const simulator = new HyperDeckSimulator()
    await run({ simulator }, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      expect(await exec('record', { name: 'Headliner Set' })).toMatchObject({ ok: true })
      expect(simulator.lastRecordName).toBe('Headliner Set')
    })
  })

  it('plays, at a speed when asked', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      expect(await exec('play', {})).toMatchObject({ ok: true })
      await recorder.waitForFrame(
        'transport',
        (p: TransportPayload) => p.status === 'play' && p.speed === 100,
      )

      expect(await exec('play', { speed: 200 })).toMatchObject({ ok: true })
      await recorder.waitForFrame('transport', (p: TransportPayload) => p.speed === 200)
    })
  })

  it('jumps to a timecode', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      expect(await exec('goto', { timecode: '01:23:45:00' })).toMatchObject({ ok: true })
      await recorder.waitForFrame(
        'transport',
        (p: TransportPayload) => p.timecode === '01:23:45:00',
      )
    })
  })

  it('turns a device refusal into a DEVICE_ERROR rather than an exception', async () => {
    const simulator = new HyperDeckSimulator()
    simulator.setVideoInput(false)

    await run({ simulator }, async ({ recorder, exec, supervisor }) => {
      await recorder.waitForState('online')

      expect(await exec('record', {})).toMatchObject({
        ok: false,
        error: { code: 'DEVICE_ERROR', message: '120 no video input' },
      })
      // A refusal is an answer: the deck is still there and still online.
      expect(supervisor.status.state).toBe('online')
    })
  })

  it('reports a timecode the deck rejects as a device error', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      // Well-formed enough for us, out of range for the deck.
      expect(await exec('goto', { timecode: '99:99:99:99' })).toMatchObject({
        ok: false,
        error: { code: 'DEVICE_ERROR', message: '109 out of range' },
      })
    })
  })

  it('rejects command input the protocol could not carry safely', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      expect(await exec('goto', { timecode: 'top of the show' })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
      expect(await exec('goto', {})).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
      // A newline in a clip name would inject a second command onto the wire.
      expect(await exec('record', { name: 'Set 1\r\nstop' })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
      expect(await exec('play', { speed: 99_999 })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
    })
  })

  it('rejects an unknown command', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      expect(await exec('eject', {})).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      })
    })
  })

  it('stops cleanly and closes its socket', async () => {
    const simulator = new HyperDeckSimulator()

    await run({ simulator }, async ({ recorder, supervisor }) => {
      await recorder.waitForState('online')
      expect(simulator.connectionCount).toBe(1)

      await supervisor.stop()
      expect(supervisor.status.state).toBe('stopped')

      recorder.clear()
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(recorder.frames).toHaveLength(0)
      expect(simulator.connectionCount).toBe(0)
    })
  })
})
