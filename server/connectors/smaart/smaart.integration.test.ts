import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { smaartModule } from './index.js'
import { SmaartSimulator } from './simulator.js'

/**
 * The connector against a Smaart, faked from the vendor specification.
 *
 * Ordered roughly by what each failure would cost: the first three are the ways
 * a board can show a confident green badge over numbers that stopped arriving,
 * which is the one outcome a noise log must never produce.
 */
describe('smaart connector against its simulator', () => {
  it('reports online only once a real reading has arrived', async () => {
    await withConnector(smaartModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      // Not on socket open, and not on any parseable JSON — the handshake and
      // the input list both arrive first, and neither is a measurement.
      const firstOnline = recorder.states.indexOf('online')
      expect(firstOnline).toBeGreaterThanOrEqual(0)
      expect(recorder.payloads('spl').length).toBeGreaterThan(0)
    })
  })

  it('does not treat a frame with no readable values as proof of life', async () => {
    // A Smaart running with nothing to measure. The connector this replaces
    // refreshed its watchdog before noticing, so this showed green for ever.
    const simulator = new SmaartSimulator()
    simulator.setMetrics([])

    await withConnector(
      smaartModule,
      { simulator, config: { reconnectOnIdleMs: 400, targetFps: 8 } },
      async ({ recorder }) => {
        await recorder.waitForState('offline')
        expect(recorder.payloads('spl')).toHaveLength(0)
      },
    )
  })

  it('notices the numbers stopping, and comes back when they resume', async () => {
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { reconnectOnIdleMs: 500, targetFps: 8 } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        simulator.stopEmitting()
        await recorder.waitForState('offline')

        simulator.resumeEmitting()
        await recorder.waitForState('online')
      },
    )
  })

  it('counts the metric stream only, however chatty the control socket is', async () => {
    /*
     * The two-socket trap, and the reason this test is slower than its
     * neighbour. The control socket polls the input list every three seconds
     * whatever the stream is doing, so a watchdog fed by *any* traffic sits
     * green while the numbers stop — which is the precise failure it exists
     * to catch. Only an idle deadline longer than the poll interval can tell
     * the two apart: at 500ms the gaps between polls trip it either way.
     */
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { reconnectOnIdleMs: 5_000, targetFps: 8 } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        simulator.stopEmitting()
        // Two polls will land inside this wait. Neither must count.
        await recorder.waitForState('offline', 12_000)
      },
    )
  }, 20_000)

  it('publishes every metric it declares, under its own slug', async () => {
    await withConnector(smaartModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
      for (const field of ['splASlow', 'splAFast', 'splCFast', 'laeq1', 'peakC', 'fsPeak']) {
        expect(typeof frame[field], field).toBe('number')
      }
      expect(frame.channel).toBe('Front Left')
    })
  })

  it('carries the windows a rig is configured for, declared or not', async () => {
    /*
     * The bench machine had `LAeq 5` and `LAeq 15` where the specification's
     * example has a ten-minute trio, plus two exposure metrics that appear in
     * no document at all. None of them can be declared in advance; all of them
     * must arrive, or a licence written round five minutes is unreadable.
     */
    await withConnector(smaartModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
      for (const field of ['laeq5', 'laeq15', 'exposureO', 'exposureN']) {
        expect(typeof frame[field], field).toBe('number')
      }
    })
  })

  it('carries a Leq window Smaart was configured for but we never declared', async () => {
    // The user Leq is configurable in Smaart, so a licence written round LAeq 5
    // works without a code change: it rides along under its own slug.
    const simulator = new SmaartSimulator()
    simulator.setMetrics(['SPL A Fast', 'LAeq 5'])

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
      expect(typeof frame.laeq5).toBe('number')
    })
  })

  it('leaves a window Smaart is not producing absent, rather than zero', async () => {
    const simulator = new SmaartSimulator()
    simulator.setMetrics(['SPL A Fast'])

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
      // A gap is defensible at a licensing hearing; an invented 0 dB is not.
      expect(frame).not.toHaveProperty('laeq10')
      expect(typeof frame.splAFast).toBe('number')
    })
  })

  it("passes on Smaart's own alarm breaches", async () => {
    const simulator = new SmaartSimulator()
    simulator.setViolation('SPL A Slow', true)

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame(
        'spl',
        (payload: { violations: string[] }) => payload.violations.length > 0,
      )
      const frame = recorder
        .payloads<{ violations: string[] }>('spl')
        .find((payload) => payload.violations.length > 0) as { violations: string[] }
      expect(frame.violations).toContain('splASlow')
    })
  })

  it('follows the input it was pointed at, not the first one', async () => {
    await withConnector(
      smaartModule,
      { config: { deviceName: 'OCTA-CAPTURE', channelName: 'Mic 1' } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
        expect(frame.channel).toBe('Mic 1')
        // Channel index 3 sits 15 dB above the first, which is how we know the
        // right stream endpoint was opened rather than the right name echoed.
        expect(frame.splASlow as number).toBeGreaterThan(100)
      },
    )
  })

  it('matches an input name typed in whatever case somebody read it in', async () => {
    await withConnector(
      smaartModule,
      { config: { channelName: 'mic 1' } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
        expect(frame.channel).toBe('Mic 1')
      },
    )
  })

  it('goes amber for a missing input, and recovers when it is plugged in', async () => {
    /*
     * Degraded rather than failed: Smaart is talking to us, it is just not
     * reporting the input this module follows. Reconnecting would not help —
     * which is precisely why the connector re-asks, or there would be no way
     * back once somebody fixed it.
     */
    const simulator = new SmaartSimulator()
    simulator.setChannels([
      { deviceName: 'Smaart I-O', channelName: 'Front Left', channelIndex: 0 },
    ])

    await withConnector(
      smaartModule,
      { simulator, config: { channelName: 'Delay Tower' } },
      async ({ recorder }) => {
        await recorder.waitForState('degraded')
        expect(recorder.states).not.toContain('offline')
        expect(recorder.payloads('spl')).toHaveLength(0)

        simulator.setChannels([
          { deviceName: 'Smaart I-O', channelName: 'Front Left', channelIndex: 0 },
          { deviceName: 'Smaart I-O', channelName: 'Delay Tower', channelIndex: 2 },
        ])
        await recorder.waitForState('online')
        await recorder.waitForFrame('spl')
        const frame = recorder.payloads<Record<string, unknown>>('spl').at(-1) ?? {}
        expect(frame.channel).toBe('Delay Tower')
      },
    )
  })

  it('says so when Smaart has no calibrated inputs at all', async () => {
    const simulator = new SmaartSimulator()
    simulator.setChannels([])

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForState('degraded')
      expect(recorder.payloads('spl')).toHaveLength(0)
    })
  })

  it('names the problem when pointed at an edition that cannot log', async () => {
    // RT and LE have no calibrated inputs. Gated on the documented error, not
    // on matching a product name string.
    const simulator = new SmaartSimulator()
    simulator.setProduct('Smaart RT')

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForState('degraded')
      expect(recorder.payloads('spl')).toHaveLength(0)
    })
  })

  it('authenticates before asking for anything', async () => {
    const simulator = new SmaartSimulator()
    simulator.setPassword('backstage')

    await withConnector(
      smaartModule,
      { simulator, config: { password: 'backstage' } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        expect(simulator.authenticated).toEqual(['backstage'])
      },
    )
  })

  it('never claims to be online with the wrong password', async () => {
    const simulator = new SmaartSimulator()
    simulator.setPassword('backstage')

    await withConnector(
      smaartModule,
      { simulator, config: { password: 'guess' } },
      async ({ recorder }) => {
        await recorder.waitForState('degraded')
        expect(recorder.states).not.toContain('online')
        expect(recorder.payloads('spl')).toHaveLength(0)
      },
    )
  })

  it('says so when Smaart wants a password and none is set', async () => {
    const simulator = new SmaartSimulator()
    simulator.setPassword('backstage')

    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForState('degraded')
      expect(recorder.states).not.toContain('online')
    })
  })

  it('asks the stream to slow down, and expects no answer for it', async () => {
    // The specification is explicit that stream-altering commands get no
    // reply, so a connector that waited for one would work here and hang on
    // the real thing.
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { targetFps: 2 } },
      async ({ recorder }) => {
        await recorder.waitForFrame('spl')
        expect(simulator.fpsRequests).toContain(2)
      },
    )
  })

  it('publishes the inputs once, and again only when they change', async () => {
    const simulator = new SmaartSimulator()
    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('channels')
      await recorder.waitForFrame('spl')
      // The metric stream runs at several frames a second; the input list must
      // not follow it, or every dashboard redraws a static list all evening.
      expect(recorder.payloads('channels')).toHaveLength(1)
    })
  })

  it('pairs each metric name with the field it becomes', async () => {
    await withConnector(smaartModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('channels')
      const frame = recorder
        .payloads<{ metrics: Record<string, unknown>[] }>('channels')
        .at(-1) as { metrics: Record<string, unknown>[] }
      // Smaart's own display colours, paired with the metric they belong to.
      // The array comes back positional against the metric list, which is only
      // knowable at the point the two are read together.
      expect(frame.metrics).toContainEqual(
        expect.objectContaining({
          name: 'SPL A Fast',
          field: 'splAFast',
          smaartColours: { greenAboveLevel: 80, yellowAboveLevel: 100, redAboveLevel: 103 },
        }),
      )
      // The exposure pair carry different figures, which is how we know the
      // pairing is real rather than every metric getting the same three.
      expect(frame.metrics).toContainEqual(
        expect.objectContaining({
          name: 'Exposure O',
          field: 'exposureO',
          smaartColours: { greenAboveLevel: 0, yellowAboveLevel: 80, redAboveLevel: 100 },
        }),
      )
    })
  })

  it("carries Smaart's own alarms for information", async () => {
    await withConnector(smaartModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('channels')
      const frame = recorder
        .payloads<{ channels: { channelName: string; alarms: unknown[] }[] }>('channels')
        .at(-1) as { channels: { channelName: string; alarms: unknown[] }[] }
      expect(frame.channels.find((c) => c.channelName === 'Mic 1')?.alarms).toEqual([
        { metric: 'SPL A Slow', level: 110 },
      ])
    })
  })

  it('reconnects by itself after the measurement laptop disappears', async () => {
    const simulator = new SmaartSimulator()
    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      recorder.clear()

      simulator.dropConnections()
      await recorder.waitForState('offline')
      await recorder.waitForState('online')
      await recorder.waitForFrame('spl')
    })
  })

  it('survives garbage on either socket without dropping the link', async () => {
    const simulator = new SmaartSimulator()
    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      recorder.clear()
      simulator.sendGarbage()

      await recorder.waitForFrame('spl')
      expect(recorder.states).not.toContain('offline')
    })
  })

  it("mirrors Smaart's own log, with Smaart's timestamps", async () => {
    /*
     * The point of using the log endpoint rather than resampling the live feed.
     * These points are dated by the instrument that measured them, so the
     * history is what Smaart says happened rather than what our socket
     * happened to see.
     */
    const simulator = new SmaartSimulator()
    const measuredAt = Date.UTC(2026, 7, 28, 20, 30, 0)
    simulator.setBacklog([
      { ts: measuredAt, value: 91.2 },
      { ts: measuredAt + 1000, value: 93.4 },
    ])

    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['LAeq 15'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.laeq15')
        const points = recorder.history.filter((point) => point.metric === 'spl.laeq15')
        expect(points.slice(0, 2)).toEqual([
          { metric: 'spl.laeq15', ts: measuredAt, value: 91.2 },
          { metric: 'spl.laeq15', ts: measuredAt + 1000, value: 93.4 },
        ])
      },
    )
  })

  it('keeps history only for the metrics it was asked to', async () => {
    const simulator = new SmaartSimulator()
    simulator.setBacklog([{ ts: Date.UTC(2026, 7, 28, 20, 30, 0), value: 90 }])

    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['LAeq 15'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.laeq15')
        expect(recorder.history.some((point) => point.metric === 'spl.splAFast')).toBe(false)
      },
    )
  })

  it('replays the whole log on reconnect, and the table absorbs it', {
    timeout: 30_000,
  }, async () => {
    /*
     * Smaart hands over everything it has logged the moment you connect, which
     * is how a hole left by a dropped link fills itself. It also means the same
     * points arrive again on every reconnect — safe only because the metrics
     * table is keyed on instance, series and timestamp. This asserts the
     * duplicates really are identical, so that key does its job.
     */
    const simulator = new SmaartSimulator()
    const measuredAt = Date.UTC(2026, 7, 28, 20, 30, 0)
    simulator.setBacklog([{ ts: measuredAt, value: 91.2 }])

    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['LAeq 15'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.laeq15')
        simulator.dropConnections()
        await recorder.waitForState('offline')
        await recorder.waitForState('online')

        // Waiting for *another* copy of the same point, not merely for any
        // point: the recorder still holds the first one, so "has history" was
        // already true the moment the link came back.
        const replays = () =>
          recorder.history.filter(
            (point) => point.metric === 'spl.laeq15' && point.ts === measuredAt,
          )
        await recorder.waitUntil('the backlog point arrives twice', () => replays().length >= 2)

        expect(replays().length).toBeGreaterThan(1)
        expect(new Set(replays().map((point) => point.value)).size).toBe(1)
      },
    )
  })

  it('gives up on a metric Smaart does not log, rather than retrying all night', async () => {
    /*
     * A real machine logs fourteen of its fifteen metrics and hangs the socket
     * up on `FS Peak` — a digital full-scale peak is not a sound level. The
     * input poll reopens anything missing every three seconds, so without
     * remembering the refusal this would be a socket storm against the show
     * machine for the length of the event.
     */
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['FS Peak', 'SPL A Slow'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.splASlow')

        /*
         * Two input polls, each of which would reopen a log the connector had
         * given up on — waited for rather than slept through.
         *
         * This used to sleep seven seconds, "long enough for two polls", and
         * that is the wrong shape for an assertion about something *not*
         * happening. On a machine slow enough that only one poll fitted, the
         * test passed by giving the bug no opportunity — weaker under exactly
         * the load that should stress it hardest. Review 4s.
         */
        const before = simulator.inputPolls
        await recorder.waitUntil(
          'the connector has polled the input list twice more',
          () => simulator.inputPolls >= before + 2,
          15_000,
        )

        expect(simulator.refusedLogAttempts).toEqual(['FS Peak'])
      },
    )
  }, 20_000)

  it('opens the logs one at a time, because Smaart cannot take them at once', async () => {
    /*
     * Measured, not guessed. Opening log sockets in a loop against a real
     * 9.6.4 took the live reading from four frames a second to one every two
     * seconds, and from the fifth onwards the sockets connected and then
     * delivered nothing — a history that looks configured and is empty.
     */
    const simulator = new SmaartSimulator()
    simulator.setBacklog([{ ts: Date.UTC(2026, 7, 28, 20, 30, 0), value: 90 }])

    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['SPL A Slow', 'LAeq 1', 'LCeq 1', 'LAeq 5'] } },
      async ({ recorder }) => {
        for (const metric of ['spl.splASlow', 'spl.laeq1', 'spl.lceq1', 'spl.laeq5']) {
          await recorder.waitForHistory(metric, 15_000)
        }
        expect(simulator.logsRefusedWhileBusy).toEqual([])
      },
    )
  }, 30_000)

  it('still keeps a history for a metric Smaart does not log', async () => {
    // Refused by the log, so it falls to the live sampler — which is the whole
    // point of having both: every reading is recorded exactly once, from
    // whichever source can actually supply it.
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['FS Peak'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.fsPeak')
        expect(recorder.history.some((point) => point.metric === 'spl.fsPeak')).toBe(true)
      },
    )
  })

  it('records a metric once, never from both sources', async () => {
    /*
     * A reading that arrived twice under two clocks is a worse record than one,
     * not a better one — an export would show the same second twice, a
     * millisecond apart, and nobody could say which was the measurement.
     */
    const simulator = new SmaartSimulator()
    const measuredAt = Date.UTC(2026, 7, 28, 20, 30, 0)
    simulator.setBacklog([{ ts: measuredAt, value: 91.2 }])

    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['SPL A Slow'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.splASlow')
        await recorder.waitForHistory('spl.splAFast')

        /*
         * Stop the engine, then wait for what is already on the wire.
         *
         * The counts below are compared for equality, and the simulator sends
         * a logged point every 100ms for as long as it is running — so there
         * is no moment while it runs at which "sent" and "recorded" are
         * reliably the same number. Sampling it after a fixed sleep worked on
         * an idle laptop and went red once under a full `pnpm check`, one
         * point short, which is how review 4s found it.
         *
         * Quiet is the only honest signal that nothing more is coming, and it
         * scales with the machine rather than against it.
         */
        simulator.stopEmitting()
        await recorder.waitUntilSettled(
          'the mirrored log',
          () => recorder.history.filter((p) => p.metric === 'spl.splASlow').length,
        )

        // The mirrored one carries the backfill, which only the log can
        // supply — a sampler cannot know what happened before it connected.
        const mirrored = recorder.history.filter((p) => p.metric === 'spl.splASlow')
        expect(mirrored.some((p) => p.ts === measuredAt)).toBe(true)
        // And *exactly* what the log sent: one more would mean the sampler had
        // written the same reading again under its own clock.
        expect(mirrored).toHaveLength(simulator.loggedPointsSent.get('SPL A Slow') ?? 0)
        // The sampled one has no backfill and is capped at a reading a
        // second, however fast the stream runs.
        const sampled = recorder.history.filter((p) => p.metric === 'spl.splAFast')
        expect(sampled.some((p) => p.ts === measuredAt)).toBe(false)
        expect(new Set(sampled.map((p) => Math.floor(p.ts / 1000))).size).toBe(sampled.length)
      },
    )
  })

  it("says which readings come from Smaart's own log", async () => {
    // "Which record is this?" is not a question to answer after a licensing
    // officer has asked it.
    const simulator = new SmaartSimulator()
    await withConnector(
      smaartModule,
      { simulator, config: { logMetrics: ['SPL A Slow'] } },
      async ({ recorder }) => {
        await recorder.waitForHistory('spl.splASlow')
        await recorder.waitForFrame(
          'channels',
          (payload: { metrics: { field: string; fromSmaartLog: boolean }[] }) =>
            payload.metrics.some((metric) => metric.field === 'splASlow' && metric.fromSmaartLog),
        )
        const frame = recorder
          .payloads<{ metrics: { field: string; fromSmaartLog: boolean }[] }>('channels')
          .at(-1) as { metrics: { field: string; fromSmaartLog: boolean }[] }
        expect(frame.metrics.find((m) => m.field === 'splASlow')?.fromSmaartLog).toBe(true)
        // Sampled from the live feed instead, which is a history but not the
        // instrument's own.
        expect(frame.metrics.find((m) => m.field === 'splAFast')?.fromSmaartLog).toBe(false)
      },
    )
  })

  it('declares no history on the live stream, because Smaart keeps the log', async () => {
    const spl = smaartModule.meta.streams.find((stream) => stream.id === 'spl')
    expect(spl?.history ?? 'none').toBe('none')
    expect(spl?.rateClass).toBe('fast')
    // `change`, not `slow`: a list that sits still would otherwise be marked
    // stale fifteen seconds after every connect and never clear.
    expect(smaartModule.meta.streams.find((s) => s.id === 'channels')?.rateClass).toBe('change')
  })

  it('is read-only: the API has no way to reset an SPL accumulator', async () => {
    expect(smaartModule.meta.capabilities.control).toBe(false)
    expect(smaartModule.meta.commands).toEqual([])
  })

  it('stops cleanly, closing both sockets', async () => {
    const simulator = new SmaartSimulator()
    await withConnector(smaartModule, { simulator }, async ({ recorder }) => {
      await recorder.waitForFrame('spl')
      expect(simulator.streamCount).toBe(1)
    })
    expect(simulator.connectionCount).toBe(0)
  })
})
