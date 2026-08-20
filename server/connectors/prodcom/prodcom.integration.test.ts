import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import type { ConnectorModule } from '../core/types.js'
import { type ProdComConfig, prodcomModule } from './index.js'
import type { FeedMessage } from './protocol.js'
import { ProdComSimulator } from './simulator.js'

/**
 * The connector against a fake ProdCom, over real HTTP and a real WebSocket.
 *
 * The behaviours worth testing here are the ones no unit test reaches: an
 * entry that mutates after it has been published, a socket that dies, and the
 * two things that must never happen — a sensitive keyword reaching the bus, and
 * a heartbeat convincing the watchdog that a dead recogniser is alive.
 */

interface FeedPayload {
  messages: FeedMessage[]
}

interface WatchPayload {
  channels: { id: string; name: string; quietSeconds: number | null }[]
  mentions: { id: string; text: string; keywords: string[] }[]
}

const config: Partial<ProdComConfig> = {
  watchWords: ['Dave'],
  reconcileSeconds: 5,
}

const run = (
  body: Parameters<typeof withConnector<never, ProdComSimulator>>[2],
  over: Partial<ProdComConfig> = {},
  simulator = new ProdComSimulator(),
) =>
  withConnector<never, ProdComSimulator>(
    prodcomModule as unknown as ConnectorModule<never>,
    { config: { ...config, ...over } as never, simulator },
    body,
  )

const latestFeed = (recorder: { payloads<T>(stream: string): T[] }): FeedMessage[] =>
  recorder.payloads<FeedPayload>('feed').at(-1)?.messages ?? []

describe('prodcom, against a simulated machine', () => {
  it('comes online with the transcript already backfilled', async () => {
    await run(async ({ recorder }) => {
      await recorder.waitForState('online')
      // The first frame is deliberately empty — "connected, nobody has spoken
      // yet" is a real state and worth publishing — so wait for content.
      await recorder.waitForFrame('feed', (payload) => (payload as FeedPayload).messages.length > 0)

      const messages = latestFeed(recorder)
      expect(messages.length).toBeGreaterThan(0)
      // Oldest first: the widget reads it in chat order and should not have to
      // reverse anything.
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i]?.at).toBeGreaterThanOrEqual(messages[i - 1]?.at ?? 0)
      }
    })
  })

  it('replaces a half-heard line rather than showing the sentence twice', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenConnected()

        const entry = simulator.say(0, 'Standby for the walk-up music', { live: true })
        expect(entry).not.toBeNull()
        const id = entry?.id ?? ''

        await recorder.waitForFrame('feed', (payload) =>
          (payload as FeedPayload).messages.some((m) => m.id === id && m.live),
        )

        /*
         * Completed by id, not said again.
         *
         * The first version of this called `say()` twice, and every call mints
         * a fresh id — so it compared two separate entries and would have
         * passed with the upsert removed entirely. What ProdCom actually does
         * is hand back the same entry with its text settled, and that is the
         * case worth testing.
         */
        simulator.complete(id)
        await recorder.waitForFrame('feed', (payload) =>
          (payload as FeedPayload).messages.some((m) => m.id === id && !m.live),
        )

        /*
         * Counted by id, not by text.
         *
         * Filtering on the words was still a tautology and the mutation sweep
         * said so: an in-progress line is truncated to half a sentence, so the
         * half-heard copy does not contain "walk-up music" and a text filter
         * finds one row whether or not the upsert works. One id, one row, is
         * the property that actually matters.
         */
        const sameEntry = latestFeed(recorder).filter((m) => m.id === id)
        expect(sameEntry).toHaveLength(1)
        expect(sameEntry[0]?.live).toBe(false)
        expect(sameEntry[0]?.text).toBe('Standby for the walk-up music')
      },
      {},
      simulator,
    )
  })

  it('never publishes a keyword ProdCom marked sensitive', async () => {
    await run(async ({ recorder }) => {
      await recorder.waitForState('online')
      // The scripted chatter says the door code out loud on a loop.
      await recorder.waitForFrame(
        'feed',
        (payload) => (payload as FeedPayload).messages.some((m) => m.redacted),
        12_000,
      )

      /*
       * Every frame on every stream, deliberately.
       *
       * This used to inspect `payloads('feed')` alone, and a review found the
       * keyword text going out on `channels` — the widget was being handed the
       * very words the feed had just blanked. A redaction assertion that only
       * looks at one stream is an assertion about that stream, not about
       * redaction.
       */
      const everything = JSON.stringify(recorder.frames)
      expect(everything).not.toContain('door code')
      expect(everything).toContain('*********')
    })
  })

  it('never hands the browser the keywords it just blanked', async () => {
    await run(async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('channels')

      const catalogue = JSON.stringify(recorder.payloads('channels'))
      // `redact` preserves length, so a client holding both the asterisked line
      // and the keyword list could match run length to keyword and recover
      // which secret was said.
      expect(catalogue).not.toContain('door code')
      // The ordinary ones are still there — this is not redaction by deletion.
      expect(catalogue).toContain('standby')
    })
  })

  it('records a flagged line on its own, not the whole feed', async () => {
    await run(async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('mention', undefined, 12_000)

      const mention = recorder
        .payloads<{ id: string; text: string; keywords: string[] }>('mention')
        .at(-1)
      expect(mention?.keywords.length).toBeGreaterThan(0)
      // Carrying the entry id matters: the history recorder de-duplicates on an
      // exact match of the previous payload, so without it the second time
      // somebody says the same thing would be silently dropped from the record.
      expect(mention?.id).toBeTruthy()
      expect(mention).not.toHaveProperty('messages')
    })
  })

  it('keeps the clock stream ticking so a condition has something to judge', async () => {
    await run(async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('watch')

      const watch = recorder.payloads<WatchPayload>('watch').at(-1)
      expect(watch?.channels.length).toBeGreaterThan(0)
      // Null rather than zero before anybody has spoken: a channel nobody has
      // used yet is not a channel that has just gone dead.
      expect(watch?.channels.every((c) => c.quietSeconds === null || c.quietSeconds >= 0)).toBe(
        true,
      )
    })
  })

  it('is not taken down by a frame it cannot read', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenConnected()
        simulator.sendGarbage()
        simulator.say(0, 'Still here after that')

        await recorder.waitForFrame('feed', (payload) =>
          (payload as FeedPayload).messages.some((m) => m.text === 'Still here after that'),
        )
        expect(recorder.states).not.toContain('error')
      },
      {},
      simulator,
    )
  })

  it('treats a dropped connection as a hiccup, not an outage', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenStreaming()
        await recorder.waitForFrame(
          'feed',
          (payload) => (payload as FeedPayload).messages.length > 0,
        )

        /*
         * The live path can die without anybody needing to know.
         *
         * This used to assert the opposite — that dropping the connection took
         * the module offline and brought it back. That was correct when the
         * socket was believed to be the data path. It is not: the transcript
         * arrives over SSE with a fully-specified REST poll underneath, so a
         * dropped stream costs latency and nothing else. Going offline for it
         * would put a red badge on a module that is still delivering.
         */
        simulator.dropConnections()
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        expect(recorder.states).not.toContain('offline')

        // And it comes back on its own, with no duplicates from the replay.
        await simulator.whenStreaming(10_000)
        await recorder.waitForFrame(
          'feed',
          (payload) => (payload as FeedPayload).messages.length > 0,
        )
        const ids = latestFeed(recorder).map((message) => message.id)
        expect(new Set(ids).size).toBe(ids.length)
      },
      {},
      simulator,
    )
  })

  it('keeps filling the feed when the live stream says nothing at all', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenStreaming()

        // Everything said from here on reaches us only because the REST poll
        // goes and asks. That is the floor the whole connector stands on, and
        // on ProdCom 2.3.2 it is doing more work than the vendor's own
        // WebSocket, which delivers nothing.
        simulator.dropConnections()
        simulator.say(0, 'Only the poll can see this one')

        await recorder.waitForFrame(
          'feed',
          (payload) =>
            (payload as FeedPayload).messages.some((m) => m.text.includes('Only the poll')),
          15_000,
        )
        expect(recorder.states).not.toContain('offline')
      },
      { reconcileSeconds: 5 },
      simulator,
    )
  })

  it('would read a transcript frame off the socket, if one ever arrived', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenConnected()

        // Nothing on 2.3.2 sends this. The reader is kept because the vendor
        // documents the socket as the live path and this is a 0.1.0 API still
        // being built — so the day a firmware starts using it, it works.
        simulator.sayOverSocket('Sent the way the document says')

        await recorder.waitForFrame('feed', (payload) =>
          (payload as FeedPayload).messages.some(
            (m) => m.text === 'Sent the way the document says',
          ),
        )
      },
      {},
      simulator,
    )
  })

  it('does not let a channel it has never heard of past the filter', async () => {
    const simulator = new ProdComSimulator()
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenConnected()

        // A channel that is not in the catalogue at all — added mid-show, a
        // group id, whatever this 0.1.0 API decides to put in the field. It
        // used to skip the filter entirely and land on a wall that had been
        // deliberately narrowed to one channel.
        simulator.sayUnknownChannel('Private word in your ear')
        await new Promise((resolve) => setTimeout(resolve, 1_000))

        const texts = latestFeed(recorder).map((message) => message.text)
        expect(texts).not.toContain('Private word in your ear')
      },
      { channels: ['FOH'] },
      simulator,
    )
  })

  it('asks for what it needs, and is let in with the right key', async () => {
    const simulator = new ProdComSimulator()
    simulator.setApiKey('the-real-key')
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await simulator.whenStreaming()

        // Only the wrong-key path was covered before, so a connector that
        // stopped sending credentials altogether would still have gone
        // degraded and still passed.
        expect(simulator.rejectedRequests).toBe(0)

        // Pagination is mandatory on this endpoint, and the window matters:
        // the transcript pages oldest-first, so a backfill without `since`
        // opens on the morning's get-in rather than the last few minutes.
        const first = simulator.transcriptQueries.at(0)
        expect(first?.limit).toBe('25')
        expect(first?.since).toBeTruthy()
      },
      { apiKey: 'the-real-key', feedLimit: 25 },
      simulator,
    )
  })

  it('goes amber, not offline, when the key is wrong', async () => {
    const simulator = new ProdComSimulator()
    simulator.setApiKey('the-real-key')
    await run(
      async ({ recorder }) => {
        // Reconnecting will not conjure a key, so a reconnect loop would be
        // both futile and impossible to diagnose from the module list.
        await recorder.waitForState('degraded')
        const status = recorder.statuses.at(-1)
        expect(status?.detail).toMatch(/API key/i)
      },
      { apiKey: 'wrong' },
      simulator,
    )
  })

  it('follows only the channels it was pointed at', async () => {
    await run(
      async ({ recorder }) => {
        await recorder.waitForState('online')
        // Waiting for the thing itself rather than sleeping long enough for it:
        // the simulator's three channels cycle every 700ms, so a fixed sleep
        // left about a tenth of a second of margin on a loaded machine.
        await recorder.waitForFrame(
          'feed',
          (payload) => (payload as FeedPayload).messages.some((m) => m.channel === 'FOH'),
          10_000,
        )

        const channels = new Set(latestFeed(recorder).map((message) => message.channel))
        expect([...channels]).toEqual(['FOH'])
      },
      { channels: ['FOH'] },
    )
  })
})
