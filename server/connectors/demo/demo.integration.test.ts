import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { type DemoConfig, demoModule } from './index.js'
import type { DemoSimulator } from './simulator.js'

/**
 * The reference integration suite. A real connector runs against a real
 * socket, and the scenarios are the ones that actually happen at a festival:
 * gear disappears, gear comes back, gear emits nonsense, someone presses a
 * button. Every vendor connector gets a suite shaped like this one.
 */
describe('demo connector against its simulator', () => {
  it('connects, reports online, and streams data', async () => {
    await withConnector<DemoConfig, DemoSimulator>(demoModule, {}, async ({ recorder }) => {
      await recorder.waitForState('online')
      await recorder.waitForFrame('meter', (p: { value: number }) => typeof p.value === 'number')
      await recorder.waitForFrame('device')

      const meters = recorder.payloads<{ value: number }>('meter')
      expect(meters.length).toBeGreaterThan(0)
      expect(meters[0]?.value).toBeGreaterThan(0)
    })
  })

  it('publishes the device state on connect', async () => {
    await withConnector<DemoConfig, DemoSimulator>(demoModule, {}, async ({ recorder }) => {
      await recorder.waitForFrame('state')
      expect(recorder.payloads<{ state: string }>('state')[0]?.state).toBe('idle')
    })
  })

  it('reconnects by itself after the device disappears', async () => {
    await withConnector<DemoConfig, DemoSimulator>(
      demoModule,
      { backoff: { baseMs: 10, capMs: 20, random: () => 1 } },
      async ({ recorder, simulator }) => {
        await recorder.waitForState('online')
        // The client sees 'connect' before the server necessarily finishes
        // accepting; the hello-derived frame proves both ends are established,
        // so dropConnections() has something to drop.
        await recorder.waitForFrame('device')

        // Someone unplugs the switch mid-show.
        const backOnline = recorder.waitForNextState('online')
        simulator.dropConnections()
        await recorder.waitForState('offline')

        // ...and it comes back without anyone touching the dashboard.
        await backOnline

        recorder.clear()
        await recorder.waitForFrame('meter')
      },
    )
  })

  it('survives malformed frames without dropping the connection', async () => {
    await withConnector<DemoConfig, DemoSimulator>(
      demoModule,
      {},
      async ({ recorder, simulator, supervisor }) => {
        await recorder.waitForState('online')
        recorder.clear()

        simulator.sendGarbage()

        // Still online, still streaming: a firmware quirk is not an outage.
        await recorder.waitForFrame('meter')
        expect(supervisor.status.state).toBe('online')
        expect(recorder.states).not.toContain('offline')
      },
    )
  })

  it('executes a command and reflects the result in the stream', async () => {
    await withConnector<DemoConfig, DemoSimulator>(demoModule, {}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')

      const result = await exec('setState', { state: 'recording' })
      expect(result.ok).toBe(true)

      await recorder.waitForFrame('state', (p: { state: string }) => p.state === 'recording')
    })
  })

  it('rejects a command whose input fails validation', async () => {
    await withConnector<DemoConfig, DemoSimulator>(demoModule, {}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      const result = await exec('setState', { state: '' })
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    })
  })

  it('rejects an unknown command', async () => {
    await withConnector<DemoConfig, DemoSimulator>(demoModule, {}, async ({ recorder, exec }) => {
      await recorder.waitForState('online')
      const result = await exec('selfDestruct', {})
      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    })
  })

  it('reports a device-side rejection as a device error', async () => {
    await withConnector<DemoConfig, DemoSimulator>(
      demoModule,
      {},
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        // The simulator refuses a state change it considers invalid.
        const result = await supervisor.exec('setState', { state: 'x'.repeat(41) })
        expect(result.ok).toBe(false)
      },
    )
  })

  it('stops cleanly and goes quiet', async () => {
    const module = demoModule
    const simulator = module.createSimulator() as DemoSimulator

    await withConnector<DemoConfig, DemoSimulator>(
      module,
      { simulator },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        await supervisor.stop()
        expect(supervisor.status.state).toBe('stopped')

        // No frames may arrive after stop, or a removed widget would keep
        // updating from a connector nobody is supervising any more.
        recorder.clear()
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(recorder.frames).toHaveLength(0)
      },
    )
  })

  it('drops the simulator connection when the supervisor stops', async () => {
    const simulator = demoModule.createSimulator() as DemoSimulator
    await withConnector<DemoConfig, DemoSimulator>(
      demoModule,
      { simulator },
      async ({ recorder, supervisor }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('device')
        expect(simulator.connectionCount).toBe(1)

        await supervisor.stop()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(simulator.connectionCount).toBe(0)
      },
    )
  })
})
