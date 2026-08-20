import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { unifiModule } from './index.js'
import type { UnifiDevice } from './protocol.js'
import { UnifiSimulator } from './simulator.js'

const FAST = { pollIntervalSeconds: 5 } as never

describe('unifi connector', () => {
  it('reports every device with its load', async () => {
    await withConnector<never, UnifiSimulator>(
      unifiModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('devices')

        const frame = recorder.frames.find((entry) => entry.streamId === 'devices')
        if (!frame) throw new Error('no devices frame was published')
        const { devices } = frame.payload as { devices: UnifiDevice[] }

        expect(devices).toHaveLength(3)
        expect(devices[0]).toMatchObject({
          name: 'Stage AP',
          online: true,
          cpuPct: 12,
          clientCount: 18,
        })
        // The offline switch keeps null load rather than a made-up zero.
        expect(devices[2]).toMatchObject({ name: 'Stage switch', online: false, cpuPct: null })
      },
    )
  })

  it('summarises the site for a wall panel', async () => {
    await withConnector<never, UnifiSimulator>(
      unifiModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForFrame('summary')

        const summary = recorder.frames.find((frame) => frame.streamId === 'summary')?.payload as {
          deviceCount: number
          onlineCount: number
          clientCount: number
          wirelessClientCount: number
        }

        expect(summary).toMatchObject({ deviceCount: 3, onlineCount: 2, clientCount: 25 })
        expect(summary.wirelessClientCount).toBeLessThan(summary.clientCount)
      },
    )
  })

  it('says plainly that the key was rejected', async () => {
    // A wrong key never fixes itself; retrying silently for an hour helps
    // nobody find the actual problem.
    const simulator = new UnifiSimulator()
    simulator.rejectKey = true

    await withConnector<never, UnifiSimulator>(
      unifiModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('degraded')
        const status = recorder.statuses.find((entry) => entry.state === 'degraded')
        expect(status?.detail).toContain('API key')
      },
    )
  })

  it('goes offline when the controller stops answering', async () => {
    const simulator = new UnifiSimulator()

    await withConnector<never, UnifiSimulator>(
      unifiModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        await simulator.close()
        await recorder.waitForNextState('offline', 20_000)
      },
    )
  })

  it('survives a truncated response', async () => {
    const simulator = new UnifiSimulator()

    await withConnector<never, UnifiSimulator>(
      unifiModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        simulator.sendGarbage()

        await recorder.waitForFrame('devices', undefined, 15_000)
        expect(recorder.states).not.toContain('error')
      },
    )
  })

  it('flags the access point that dropped off', () => {
    const condition = unifiModule.meta.conditions?.find((c) => c.id === 'device.down')
    const results = condition?.evaluate(
      {
        devices: [
          { id: 'ap1', name: 'Stage AP', online: true, state: 'ONLINE' },
          { id: 'sw1', name: 'Stage switch', online: false, state: 'OFFLINE' },
        ],
      },
      {},
    )

    expect(results?.filter((result) => result.active).map((result) => result.itemKey)).toEqual([
      'sw1',
    ])
  })
})
