import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import type { ConnectorModule, StreamDecl } from '../core/types.js'
import { type ProdComConfig, prodcomModule } from './index.js'
import { ProdComSimulator } from './simulator.js'

/**
 * What gets kept, and what notices when it stops.
 *
 * These two are together because they are the same kind of mistake: a
 * declaration in one file that only bites somewhere else, weeks later. A
 * stream declared with the wrong `history` floods the show record; one declared
 * with the wrong `rateClass` leaves a condition that can never fire. Neither
 * shows up in a widget, and neither fails loudly.
 */

const streams = prodcomModule.meta.streams
const decl = (id: string): StreamDecl => {
  const found = streams.find((stream) => stream.id === id)
  if (!found) throw new Error(`no ${id} stream`)
  return found
}

describe('what ProdCom keeps', () => {
  it('does not put the rolling feed in the show record', () => {
    /*
     * `HistoryRecorder.recordChange` JSON-stringifies the whole payload into
     * the activity table every time an `events` stream changes. The feed
     * carries up to sixty lines, so declaring it `events` would write sixty
     * lines to the record for every single new one — an evening of comms would
     * be a few hundred megabytes of the same sentences over and over.
     */
    expect(decl('feed').history ?? 'none').toBe('none')
  })

  it('keeps the flagged lines, one at a time', () => {
    // This is the history. "Somebody said your name at 21:04, on Stage Left,
    // and here is the line" is exactly what a post-show record wants.
    expect(decl('mention').history).toBe('events')
  })

  it('does not record the clock stream at all', () => {
    // Its payload carries a seconds counter that changes every tick, so the
    // recorder's dedupe would never match and it would write a row per
    // instance per tick, for ever.
    expect(decl('watch').history ?? 'none').toBe('none')
  })

  it('gives the conditions a stream that actually ticks', () => {
    /*
     * The constraint behind the whole design: `HealthEngine.sweep()` never
     * re-runs `evaluate` — only a publish does. A `change`-class stream that
     * goes quiet therefore freezes its conditions at whatever they last said,
     * so "this channel has gone silent" could never become true and a mention
     * raised at nine in the evening would still be active at three.
     */
    expect(decl('watch').rateClass).toBe('slow')

    const readers = (prodcomModule.meta.conditions ?? []).map((condition) => condition.streamId)
    expect(readers.length).toBeGreaterThan(0)
    expect(new Set(readers)).toEqual(new Set(['watch']))
  })
})

describe('telling a dead connection from a quiet room', () => {
  const idle = (over: Partial<ProdComConfig> = {}) =>
    ({
      reconnectOnIdleMs: 5_000,
      reconcileSeconds: 300,
      ...over,
    }) as Partial<ProdComConfig> as never

  it('stays online through a long silence on comms', async () => {
    const simulator = new ProdComSimulator()

    await withConnector<never, ProdComSimulator>(
      prodcomModule as unknown as ConnectorModule<never>,
      { config: idle(), simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenConnected()

        /*
         * This is the one that matters. Nobody is talking, but the rig is
         * perfectly healthy and its keep-alive is still arriving.
         *
         * The first version failed the module here, reasoning that a dead
         * recogniser also goes quiet. It does — and it is indistinguishable
         * from a band playing a song, so what that actually bought was a module
         * that dropped offline every ninety seconds all night, taking `$stale`
         * and the offline alerts with it. Silence is `comms.silent`'s job, in
         * minutes, per channel.
         */
        simulator.stopEmitting()
        await new Promise((resolve) => setTimeout(resolve, 8_000))

        expect(recorder.states).not.toContain('offline')
        expect(recorder.states.at(-1)).toBe('online')
      },
    )
  }, 25_000)

  it('goes offline only when ProdCom itself stops answering', async () => {
    const simulator = new ProdComSimulator()

    await withConnector<never, ProdComSimulator>(
      prodcomModule as unknown as ConnectorModule<never>,
      { config: idle({ reconcileSeconds: 5 }), simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenStreaming()

        /*
         * The only thing that should ever take this module offline.
         *
         * An earlier version failed it when the live connection went quiet,
         * which conflated "nobody is talking" with "the machine has gone" —
         * and on ProdCom 2.3.2 the live *socket* is quiet by design, so that
         * would have been a red badge on every healthy rig. What actually
         * means something is the machine no longer answering at all.
         */
        simulator.setFailing(true)

        await recorder.waitForNextState('offline', 20_000)
      },
    )
  }, 30_000)
})
