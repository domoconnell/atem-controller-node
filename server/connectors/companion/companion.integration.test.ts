import { describe, expect, it, vi } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type CompanionConfig, companionModule } from './index.js'
import type { CompanionSimulator } from './simulator.js'

type Values = { values: Record<string, string | number | null> }
type Connection = { ok: boolean; variableCount: number; failedCount: number }

/** Fast enough to keep the suite quick, still inside the configured minimum. */
const POLL = 250

/**
 * The Companion connector against a real HTTP server speaking Companion's API.
 * The scenarios are the ones that actually happen at a festival: someone
 * renames a connection and half the variables vanish, the Companion laptop
 * sleeps mid-set, a guest-network portal answers instead of Companion.
 */
describe('companion connector against its simulator', () => {
  it('connects, reports online, and publishes both streams', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { variables: ['obs:streaming', 'custom:show_name'], pollIntervalMs: POLL } },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('variables')
        await recorder.waitForFrame('connection')

        expect(recorder.payloads<Values>('variables')[0]?.values).toEqual({
          'obs:streaming': 'true',
          'custom:show_name': 'Main Stage',
        })
        expect(recorder.payloads<Connection>('connection')[0]).toEqual({
          ok: true,
          variableCount: 2,
          failedCount: 0,
        })
      },
    )
  })

  it('publishes one frame per tick keyed by the config entry exactly as written', async () => {
    const simulator = companionModule.createSimulator() as CompanionSimulator
    // Operators name connections with spaces and punctuation; the key a widget
    // binds to has to survive that untouched.
    simulator.setVariable('ATEM 1', 'pgm_input', 5)

    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      {
        simulator,
        config: { variables: ['ATEM 1:pgm_input', 'obs:streaming'], pollIntervalMs: POLL },
      },
      async ({ recorder }) => {
        await recorder.waitForFrame('variables')

        const frame = recorder.payloads<Values>('variables')[0]
        expect(Object.keys(frame?.values ?? {})).toEqual(['ATEM 1:pgm_input', 'obs:streaming'])
        // A numeric value arrives as a number so a gauge can bind to it.
        expect(frame?.values['ATEM 1:pgm_input']).toBe(5)
      },
    )
  })

  it('publishes null for a variable Companion does not have, and stays online', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      {
        config: { variables: ['obs:streaming', 'obs:ghost'], pollIntervalMs: POLL },
      },
      async ({ recorder, supervisor }) => {
        await recorder.waitForFrame('variables')

        const frame = recorder.payloads<Values>('variables')[0]
        // The key is present and null: a missing key and a failed read mean
        // different things to an operator, and only one of them is a mistake.
        expect(frame?.values).toHaveProperty('obs:ghost', null)
        expect(frame?.values['obs:streaming']).toBe('true')

        // A mistyped variable is a configuration mistake, not an outage.
        expect(supervisor.status.state).toBe('online')
        expect(recorder.states).not.toContain('offline')
        expect(recorder.payloads<Connection>('connection')[0]).toEqual({
          ok: true,
          variableCount: 2,
          failedCount: 1,
        })
      },
    )
  })

  it('reports the failure count changing when a connection is renamed mid-show', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      {
        config: { variables: ['obs:streaming', 'atem:pgm_input'], pollIntervalMs: POLL },
      },
      async ({ recorder, simulator, supervisor }) => {
        await recorder.waitForFrame('connection', (p: Connection) => p.failedCount === 0)

        // Someone renames the OBS connection in Companion during changeover.
        simulator.removeVariable('obs:streaming')

        await recorder.waitForFrame('connection', (p: Connection) => p.failedCount === 1)
        await recorder.waitForFrame('variables', (p: Values) => p.values['obs:streaming'] === null)
        expect(supervisor.status.state).toBe('online')
      },
    )
  })

  it('reconnects by itself after Companion stops answering', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      {
        config: { variables: ['obs:streaming'], pollIntervalMs: POLL },
        backoff: { baseMs: 10, capMs: 20, random: () => 1 },
      },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('variables')

        // The Companion laptop goes to sleep: the socket dies with no reply.
        const backOnline = recorder.waitForNextState('online')
        simulator.failNextRequests(1)
        await recorder.waitForState('offline')

        // ...and it comes back without anyone touching the dashboard.
        await backOnline

        recorder.clear()
        await recorder.waitForFrame(
          'variables',
          (p: Values) => p.values['obs:streaming'] === 'true',
        )
      },
    )
  })

  it('marks the connection stream not-ok on the way offline', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      {
        config: { variables: ['obs:streaming'], pollIntervalMs: POLL },
        backoff: { baseMs: 500, capMs: 500, random: () => 1 },
      },
      async ({ recorder, simulator }) => {
        await recorder.waitForFrame('connection', (p: Connection) => p.ok)

        simulator.failNextRequests(1)

        // A widget bound to `connection` must not keep showing ok:true while
        // the instance is offline.
        await recorder.waitForFrame('connection', (p: Connection) => p.ok === false)
      },
    )
  })

  it('survives a portal page answering instead of Companion', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { variables: ['obs:streaming'], pollIntervalMs: POLL } },
      async ({ recorder, simulator, supervisor }) => {
        await recorder.waitForState('online')
        recorder.clear()

        simulator.sendGarbage()

        // Still online, still publishing: a proxy hiccup is not an outage.
        await recorder.waitForFrame('variables')
        expect(supervisor.status.state).toBe('online')
        expect(recorder.states).not.toContain('offline')
      },
    )
  })

  it('reports online with no variables configured', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, supervisor }) => {
        // A fresh instance with nothing subscribed still has to answer
        // "is Companion up?" — otherwise it sits in `connecting` forever.
        await recorder.waitForState('online')
        await recorder.waitForFrame('variables')

        expect(recorder.payloads<Values>('variables')[0]).toEqual({ values: {} })
        expect(recorder.payloads<Connection>('connection')[0]).toEqual({
          ok: true,
          variableCount: 0,
          failedCount: 0,
        })
        expect(supervisor.status.state).toBe('online')
      },
    )
  })

  it('presses a button at a page/row/column location', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, simulator, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('button.press', { page: 2, row: 1, column: 4 })
        expect(result.ok).toBe(true)
        expect(simulator.recordedPresses).toMatchObject([{ page: 2, row: 1, column: 4 }])
      },
    )
  })

  it('sets a custom variable and reads the new value back on the next poll', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { variables: ['custom:cue'], pollIntervalMs: POLL } },
      async ({ recorder, exec, simulator }) => {
        // The variable does not exist yet, so it starts as a reported failure.
        await recorder.waitForFrame('variables', (p: Values) => p.values['custom:cue'] === null)

        // Somebody adds it on Companion's Custom Variables page. Without this
        // the write below is refused — see the next test.
        simulator.declareCustomVariable('cue')

        const result = await exec('variable.set', { name: 'cue', value: 'GO' })
        expect(result.ok).toBe(true)

        await recorder.waitForFrame('variables', (p: Values) => p.values['custom:cue'] === 'GO')
        await recorder.waitForFrame('connection', (p: Connection) => p.failedCount === 0)
      },
    )
  })

  it('refuses to write a custom variable nobody has created', async () => {
    /*
     * The one that a simulator built from the documentation got wrong for
     * months. Companion will not create a custom variable over HTTP: the name
     * has to exist on its Custom Variables page first, and a write to one that
     * does not is a 404. Verified against a real Companion v5.0.3.
     *
     * It matters because the failure is invisible from the Companion end — the
     * button simply never changes colour — so anything relying on this write
     * has to say "create it first" in its setup instructions.
     */
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('variable.set', { name: 'never_created', value: 'GO' })
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.error.code).toBe('DEVICE_ERROR')
      },
    )
  })

  it('rejects a button location outside the grid', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, exec, simulator }) => {
        await recorder.waitForState('online')

        // Companion pages start at 1; page 0 is a typo, not a location.
        const result = await exec('button.press', { page: 0, row: 1, column: 1 })
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
        expect(simulator.recordedPresses).toHaveLength(0)
      },
    )
  })

  it('rejects a custom variable name that would climb out of the URL path', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('variable.set', { name: '../../api/reset', value: 'x' })
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
      },
    )
  })

  it('rejects an unknown command', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { pollIntervalMs: POLL } },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('button.longPress', { page: 1, row: 0, column: 0 })
        expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
      },
    )
  })

  it('stops cleanly and goes quiet', async () => {
    await withConnector<CompanionConfig, CompanionSimulator>(
      companionModule,
      { config: { variables: ['obs:streaming'], pollIntervalMs: POLL } },
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

  /*
   * ── OSC ───────────────────────────────────────────────────────────────────
   *
   * The same two commands down a UDP socket instead. These run against the
   * simulator's real OSC port, which is bound on an ephemeral number exactly
   * as its HTTP one is — a test that assumed 12321 would fight whatever
   * Companion is running on the machine doing the testing.
   */
  describe('with commands over OSC', () => {
    const osc = { commandTransport: 'osc' as const, pollIntervalMs: POLL }

    it('presses a button, and the simulator can tell which wire it came down', async () => {
      await withConnector<CompanionConfig, CompanionSimulator>(
        companionModule,
        { config: osc },
        async ({ recorder, simulator, exec }) => {
          await recorder.waitForState('online')

          const result = await exec('button.press', { page: 2, row: 1, column: 4 })
          expect(result.ok).toBe(true)

          // UDP has no acknowledgement, so `ok` came back before the datagram
          // had necessarily arrived. Waiting for it is the honest assertion,
          // and is what a caller has to accept when choosing this transport.
          await vi.waitFor(() =>
            expect(simulator.recordedPresses).toMatchObject([
              { page: 2, row: 1, column: 4, via: 'osc' },
            ]),
          )
        },
      )
    })

    it('sets a custom variable, and the value reads back over HTTP', async () => {
      await withConnector<CompanionConfig, CompanionSimulator>(
        companionModule,
        { config: { ...osc, variables: ['custom:cue'] } },
        async ({ recorder, exec, simulator }) => {
          simulator.declareCustomVariable('cue')
          await recorder.waitForState('online')

          const result = await exec('variable.set', { name: 'cue', value: 'standby' })
          expect(result.ok).toBe(true)

          // The round trip that matters: written over OSC, read over HTTP.
          // Keeping the read on HTTP is what makes an OSC rig diagnosable.
          await recorder.waitForFrame(
            'variables',
            (p: Values) => p.values['custom:cue'] === 'standby',
          )
        },
      )
    })

    /**
     * The finding that shaped this whole transport.
     *
     * Companion's OSC handler calls `setCustomVariableValue` and throws away
     * the `'Unknown name'` it returns, so writing a variable nobody created
     * is accepted, ignored, and never mentioned again by either machine. The
     * HTTP path answers 404 for the same mistake. The connector therefore
     * checks over HTTP before it will send the datagram — without it, the
     * commonest setup error in this feature would be undetectable.
     */
    it('refuses to write a variable Companion does not have, rather than sending into silence', async () => {
      await withConnector<CompanionConfig, CompanionSimulator>(
        companionModule,
        { config: osc },
        async ({ recorder, exec, simulator }) => {
          await recorder.waitForState('online')

          const result = await exec('variable.set', { name: 'never_created', value: 'GO' })
          expect(result.ok).toBe(false)
          expect(result.ok === false && result.error.message).toMatch(/Custom Variables/)

          // And the simulator agrees it never heard anything, which is the
          // half a live Companion could never tell us.
          simulator.declareCustomVariable('never_created', 'untouched')
          expect(simulator.customVariable('never_created')).toBe('untouched')
        },
      )
    })

    it('only asks once per variable, so a cue is one datagram and no round trip', async () => {
      await withConnector<CompanionConfig, CompanionSimulator>(
        companionModule,
        { config: osc },
        async ({ recorder, exec, simulator }) => {
          simulator.declareCustomVariable('miccue_mc2')
          await recorder.waitForState('online')

          const before = simulator.customVariableReads
          expect((await exec('variable.set', { name: 'miccue_mc2', value: 'standby' })).ok).toBe(
            true,
          )
          expect((await exec('variable.set', { name: 'miccue_mc2', value: 'live' })).ok).toBe(true)
          expect((await exec('variable.set', { name: 'miccue_mc2', value: 'off' })).ok).toBe(true)

          // One confirmation for three writes. Paying a round trip per cue
          // would undo the reason for choosing OSC in the first place.
          expect(simulator.customVariableReads - before).toBe(1)
          await vi.waitFor(() => expect(simulator.customVariable('miccue_mc2')).toBe('off'))
        },
      )
    })

    it('still reads variables over HTTP, and still goes offline when HTTP dies', async () => {
      await withConnector<CompanionConfig, CompanionSimulator>(
        companionModule,
        { config: { ...osc, variables: ['obs:streaming'] } },
        async ({ recorder, simulator }) => {
          await recorder.waitForState('online')

          // Choosing OSC for commands must not blind the dashboard to a
          // Companion that has gone away — that is the whole reason the read
          // path stayed on HTTP.
          simulator.failNextRequests(20)
          await recorder.waitForState('offline')
        },
      )
    })
  })
})
