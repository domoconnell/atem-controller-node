import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { netcheckModule } from './index.js'
import { NetcheckSimulator } from './simulator.js'

const FAST = { pollIntervalSeconds: 5, probes: 3, probeIntervalMs: 50 } as never

describe('netcheck connector', () => {
  it('measures a reachable host', async () => {
    await withConnector<never, NetcheckSimulator>(
      netcheckModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('latency')

        const latency = recorder.frames.find((frame) => frame.streamId === 'latency')?.payload as {
          up: boolean
          probes: number
          rttAvgMs: number
          method: string
        }
        expect(latency.up).toBe(true)
        expect(latency.probes).toBe(3)
        expect(latency.rttAvgMs).toBeGreaterThanOrEqual(0)
        // The stream says how it measured, so nobody mistakes a TCP connect
        // time for an ICMP round trip.
        expect(latency.method).toBe('tcp')
      },
    )
  })

  it('reports an unreachable host without going offline itself', async () => {
    // The module is working perfectly; the target is not. Conflating those
    // would hide the very fault the check exists to find.
    const simulator = new NetcheckSimulator()

    await withConnector<never, NetcheckSimulator>(
      netcheckModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        await simulator.close()
        await recorder.waitForNextState('degraded', 15_000)

        const down = [...recorder.frames].reverse().find((frame) => frame.streamId === 'latency')
          ?.payload as { up: boolean; lossPct: number }
        expect(down.up).toBe(false)
        expect(down.lossPct).toBe(100)
      },
    )
  })

  it('runs a throughput test on demand', async () => {
    await withConnector<never, NetcheckSimulator>(
      netcheckModule as never,
      { config: FAST },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('speedtest.run', {})
        expect(result.ok).toBe(true)

        await recorder.waitForFrame('speed')
        const speed = recorder.frames.find((frame) => frame.streamId === 'speed')?.payload as {
          downMbps: number
        }
        expect(speed.downMbps).toBeGreaterThan(0)
      },
    )
  })

  it('refuses an unknown command', async () => {
    await withConnector<never, NetcheckSimulator>(
      netcheckModule as never,
      { config: FAST },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('reboot.everything', {})
        expect(result.ok).toBe(false)
      },
    )
  })
})
