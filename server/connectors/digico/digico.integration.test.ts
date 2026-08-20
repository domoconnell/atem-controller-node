import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { digicoModule } from './index.js'
import { DigicoSimulator } from './simulator.js'

interface MessagesPayload {
  messages: { id: string; text: string; at: number }[]
}

const FAST = { pollIntervalSeconds: 5, timeoutSeconds: 10 } as never

describe('digico connector', () => {
  it('reads channel names and mutes from the console', async () => {
    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame(
          'channels',
          (payload) =>
            (payload as { channels: { name: string | null }[] }).channels.some(
              (channel) => channel.name === 'Kick',
            ),
          8_000,
        )
      },
    )
  })

  /**
   * The substitute for console chat, which is unreachable over the network.
   * An operator labels a macro with what they need to say and presses it.
   */
  it('turns a labelled macro press into a message', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        simulator.pressMacro(2)

        await recorder.waitForFrame(
          'messages',
          (payload) => (payload as MessagesPayload).messages[0]?.text === 'Mic 3 down',
          8_000,
        )
      },
    )
  })

  it('keeps the newest message first', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        simulator.pressMacro(1)
        await recorder.waitForFrame(
          'messages',
          (payload) => (payload as MessagesPayload).messages.length >= 1,
          8_000,
        )
        simulator.pressMacro(3)

        await recorder.waitForFrame(
          'messages',
          (payload) => (payload as MessagesPayload).messages[0]?.text === 'All OK',
          8_000,
        )
      },
    )
  })

  it('records a snapshot fire', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        simulator.fireSnapshot(14)

        await recorder.waitForFrame(
          'snapshots',
          (payload) => (payload as { current: number }).current === 14,
          8_000,
        )
      },
    )
  })

  it('refuses to fire a macro unless an admin allowed it', async () => {
    // Firing a macro on a live console is a real action on real audio.
    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('macro.fire', { index: 1 })
        expect(result.ok).toBe(false)
      },
    )
  })

  it('fires a macro when allowed, and hears the console confirm it', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: { ...(FAST as object), allowMacroFire: true } as never, simulator },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('macro.fire', { index: 3 })
        expect(result.ok).toBe(true)

        await recorder.waitForFrame(
          'macros',
          (payload) =>
            (payload as { macros: { index: number; on: boolean }[] }).macros.some(
              (macro) => macro.index === 3 && macro.on,
            ),
          8_000,
        )
      },
    )
  })

  it('survives a datagram that is not OSC', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        simulator.sendGarbage()
        simulator.pressMacro(1)

        await recorder.waitForFrame('messages', undefined, 10_000)
        expect(recorder.states).not.toContain('error')
      },
    )
  })

  it('goes offline when the console stops sending', async () => {
    const simulator = new DigicoSimulator()

    await withConnector<never, DigicoSimulator>(
      digicoModule as never,
      { config: { pollIntervalSeconds: 5, timeoutSeconds: 10 } as never, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        // External Control switched off, or the wrong port pair: both look
        // exactly like this, and both need a human.
        await simulator.close()
        await recorder.waitForNextState('offline', 25_000)
      },
    )
  })

  it('alerts on a keyword in a console message', () => {
    const condition = digicoModule.meta.conditions?.find((c) => c.id === 'message.matches')

    const quiet = condition?.evaluate(
      { messages: [{ id: 'm1', text: 'All OK', at: Date.now() }] },
      { keywords: 'down, help', holdSeconds: 60 },
    )
    expect(quiet?.[0]?.active).toBe(false)

    const urgent = condition?.evaluate(
      { messages: [{ id: 'm2', text: 'Mic 3 down', at: Date.now() }] },
      { keywords: 'down, help', holdSeconds: 60 },
    )
    expect(urgent?.[0]).toMatchObject({ active: true, detail: 'Mic 3 down' })
  })

  it('lets an old message go quiet again', () => {
    // Otherwise one press would alert for the rest of the festival.
    const condition = digicoModule.meta.conditions?.find((c) => c.id === 'message.matches')
    const stale = condition?.evaluate(
      { messages: [{ id: 'm3', text: 'Mic down', at: Date.now() - 600_000 }] },
      { keywords: 'down', holdSeconds: 60 },
    )
    expect(stale?.[0]?.active).toBe(false)
  })
})
