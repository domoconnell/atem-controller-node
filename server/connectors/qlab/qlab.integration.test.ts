import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type QLabConfig, qlabModule } from './index.js'
import { QLabSimulator, type QLabSimulatorCue } from './simulator.js'

interface CuesPayload {
  cues: { id: string; number: string; name: string; type: string }[]
}
interface PlayheadPayload {
  cueId: string | null
  name: string | null
}
interface RunningPayload {
  cues: { id: string; name: string; elapsed: number; remaining: number; percent: number }[]
}

const run = (
  options: Parameters<typeof withConnector<QLabConfig, QLabSimulator>>[1],
  body: Parameters<typeof withConnector<QLabConfig, QLabSimulator>>[2],
) => withConnector<QLabConfig, QLabSimulator>(qlabModule, options, body)

/**
 * QLab over a real socket, real OSC and real SLIP. The scenarios are the ones
 * that happen on a festival stage: a passcode nobody wrote on the tech sheet,
 * two workspaces open on the same machine, a show laptop that drops off the
 * network, and cues that have to keep counting down through all of it.
 */
describe('qlab connector against its simulator', () => {
  it('connects, selects the only workspace and reports online', async () => {
    await run({}, async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('cues')
      await recorder.waitForFrame('playhead')
      await recorder.waitForFrame('running')
    })
  })

  it('publishes the cue list flattened out of QLab’s tree', async () => {
    await run({}, async ({ recorder }) => {
      await recorder.waitForFrame('cues')
      const cues = recorder.payloads<CuesPayload>('cues').at(-1)?.cues

      // The group's child is in the list; the cue list container is not.
      expect(cues).toEqual([
        { id: 'cue-1', number: '1', name: 'House to half', type: 'Light' },
        { id: 'cue-2', number: '2', name: 'Walk-in music', type: 'Group' },
        { id: 'cue-2.1', number: '2.1', name: 'Bed loop', type: 'Audio' },
        { id: 'cue-3', number: '3', name: 'Band intro video', type: 'Video' },
      ])
    })
  })

  it('publishes the playhead on connect and follows QLab’s pushed updates', async () => {
    await run({}, async ({ recorder, simulator }) => {
      await recorder.waitForFrame('playhead')
      expect(recorder.payloads<PlayheadPayload>('playhead')[0]).toEqual({
        cueId: 'cue-1',
        name: 'House to half',
      })

      // No poll fires this: QLab pushes the new position because the
      // connector asked for updates at connect time.
      simulator.startCue('cue-3')
      await recorder.waitForFrame('playhead', (p: PlayheadPayload) => p.cueId === 'cue-3')
      expect(recorder.payloads<PlayheadPayload>('playhead').at(-1)).toEqual({
        cueId: 'cue-3',
        name: 'Band intro video',
      })
    })
  })

  it('reports elapsed, remaining and percent for a running cue', async () => {
    await run({}, async ({ recorder, simulator }) => {
      await recorder.waitForState('online')
      simulator.startCue('cue-3')
      simulator.advance(9)

      await recorder.waitForFrame('running', (p: RunningPayload) => (p.cues[0]?.elapsed ?? 0) > 0)
      const running = recorder
        .payloads<RunningPayload>('running')
        .findLast((p) => p.cues.length === 1)

      // cue-3 runs 30s, so nine seconds in it is 30% done with 21 to go.
      expect(running?.cues[0]).toEqual({
        id: 'cue-3',
        name: 'Band intro video',
        elapsed: 9,
        remaining: 21,
        percent: 0.3,
      })
    })
  })

  it('only asks about cues that are actually running', async () => {
    // A festival show file holds thousands of cues; querying elapsed time for
    // all of them every poll would flatten both ends of the socket.
    const simulator = new QLabSimulator()
    const cues: QLabSimulatorCue[] = Array.from({ length: 200 }, (_, i) => ({
      id: `cue-${i}`,
      number: String(i),
      name: `Cue ${i}`,
      type: 'Audio',
      duration: 60,
    }))
    simulator.setCues(cues)

    await run({ simulator, config: { pollIntervalMs: 200 } }, async ({ recorder }) => {
      await recorder.waitForState('online')
      simulator.startCue('cue-7')

      await recorder.waitForFrame('running', (p: RunningPayload) => p.cues.length === 1)
      const afterFirstPoll = simulator.cueQueryCount
      await recorder.waitForFrame('running', (p: RunningPayload) => p.cues.length === 1)

      expect(recorder.payloads<CuesPayload>('cues').at(-1)?.cues).toHaveLength(200)
      // Two queries per running cue per poll, plus the odd name lookup — the
      // point is that it does not scale with the size of the show file.
      expect(simulator.cueQueryCount - afterFirstPoll).toBeLessThan(10)
    })
  })

  it('reconnects by itself after the show laptop disappears', async () => {
    await run(
      { backoff: { baseMs: 10, capMs: 20, random: () => 1 } },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('cues')

        const backOnline = recorder.waitForNextState('online')
        simulator.dropConnections()
        await recorder.waitForState('offline')
        await backOnline

        recorder.clear()
        await recorder.waitForFrame('running')
      },
    )
  })

  it('survives garbage on the socket without going offline', async () => {
    await run({}, async ({ recorder, simulator, supervisor }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('cues')
      await recorder.waitForFrame('playhead')
      recorder.clear()

      simulator.sendGarbage()

      await recorder.waitForFrame('running')
      expect(supervisor.status.state).toBe('online')
      expect(recorder.states).not.toContain('offline')
      // A pushed position for another workspace must not move our playhead.
      expect(recorder.payloads<PlayheadPayload>('playhead')).toEqual([])
    })
  })

  it.each(['go', 'stop', 'pause', 'resume', 'panic'])('executes %s', async (command) => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      expect(await exec(command, {})).toMatchObject({ ok: true })
    })
  })

  it('fires the cue at the playhead on go and moves the playhead on', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('playhead')
      recorder.clear()

      expect(await exec('go', {})).toMatchObject({ ok: true })

      await recorder.waitForFrame('running', (p: RunningPayload) => p.cues[0]?.id === 'cue-1')
      await recorder.waitForFrame('playhead', (p: PlayheadPayload) => p.cueId === 'cue-2')
    })
  })

  it('clears the running list on panic', async () => {
    await run({}, async ({ recorder, simulator, exec }) => {
      await recorder.waitForState('online')
      simulator.startCue('cue-3')
      await recorder.waitForFrame('running', (p: RunningPayload) => p.cues.length === 1)

      expect(await exec('panic', {})).toMatchObject({ ok: true })
      await recorder.waitForFrame('running', (p: RunningPayload) => p.cues.length === 0)
    })
  })

  it('rejects a command whose input is not an object', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      expect(await exec('go', 'space bar')).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
    })
  })

  it('rejects an unknown command', async () => {
    await run({}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      expect(await exec('fadeToBlack', {})).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      })
    })
  })

  it('connects to a workspace protected by a passcode', async () => {
    const simulator = new QLabSimulator()
    simulator.setPasscodeRequired('2468')

    await run({ simulator, config: { passcode: '2468' } }, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('cues')
      expect(await exec('go', {})).toMatchObject({ ok: true })
    })
  })

  it('says so in plain words when the passcode is wrong', async () => {
    const simulator = new QLabSimulator()
    simulator.setPasscodeRequired('2468')

    await run(
      {
        simulator,
        config: { passcode: '1234' },
        // Slow the retries down: this is a settings mistake, and hammering the
        // show machine with bad passcodes helps nobody.
        backoff: { baseMs: 400, capMs: 400, random: () => 1 },
      },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('offline')

        expect(supervisor.status.lastError).toMatch(/passcode/i)
        expect(supervisor.status.detail).toMatch(/control-level/i)
        expect(recorder.states).not.toContain('online')
      },
    )
  })

  it('reports a missing passcode as a passcode problem, not a network one', async () => {
    const simulator = new QLabSimulator()
    simulator.setPasscodeRequired('2468')

    await run(
      { simulator, backoff: { baseMs: 400, capMs: 400, random: () => 1 } },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('offline')
        expect(supervisor.status.lastError).toMatch(/passcode/i)
      },
    )
  })

  it('uses the configured workspace when QLab has several open', async () => {
    const simulator = new QLabSimulator({
      workspaces: [
        { id: 'ws-a', displayName: 'Main Stage' },
        { id: 'ws-b', displayName: 'Tent Stage' },
      ],
    })
    simulator.setCues([{ id: 'tent-1', number: '1', name: 'Tent opener', type: 'Audio' }], 'ws-b')

    await run({ simulator, config: { workspaceId: 'ws-b' } }, async ({ recorder }) => {
      await recorder.waitForFrame('cues')
      expect(recorder.payloads<CuesPayload>('cues').at(-1)?.cues).toEqual([
        { id: 'tent-1', number: '1', name: 'Tent opener', type: 'Audio' },
      ])
    })
  })

  it('falls back to the first workspace when none is configured', async () => {
    const simulator = new QLabSimulator({
      workspaces: [
        { id: 'ws-a', displayName: 'Main Stage' },
        { id: 'ws-b', displayName: 'Tent Stage' },
      ],
    })
    simulator.setCues([{ id: 'main-1', number: '1', name: 'Main opener', type: 'Audio' }], 'ws-a')

    await run({ simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('cues')
      expect(recorder.payloads<CuesPayload>('cues').at(-1)?.cues).toEqual([
        { id: 'main-1', number: '1', name: 'Main opener', type: 'Audio' },
      ])
    })
  })

  it('names the workspace it cannot find', async () => {
    await run(
      {
        config: { workspaceId: 'ws-that-was-closed' },
        backoff: { baseMs: 400, capMs: 400, random: () => 1 },
      },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('offline')
        expect(supervisor.status.lastError).toMatch(/ws-that-was-closed/)
      },
    )
  })

  it('stops cleanly and closes its socket', async () => {
    const simulator = new QLabSimulator()

    await run({ simulator }, async ({ recorder, supervisor }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('cues')
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
