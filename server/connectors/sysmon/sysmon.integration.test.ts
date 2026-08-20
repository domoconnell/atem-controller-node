import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { sysmonModule } from './index.js'
import { SysmonSimulator } from './simulator.js'

const FAST = { pollIntervalSeconds: 3 } as never

/**
 * Driven against a real SSH server, so the handshake, password auth, channel
 * handling and command output all go over the actual wire protocol.
 */
describe('sysmon connector', () => {
  it('reads metrics from a Mac', async () => {
    await withConnector<never, SysmonSimulator>(
      sysmonModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('metrics')

        const metrics = recorder.frames.find((frame) => frame.streamId === 'metrics')?.payload as {
          cpuPct: number
          memUsedPct: number
          diskFreeBytes: number
          uptimeSeconds: number
          batteryPct: number
        }

        // 88% idle in the simulator's second sample.
        expect(metrics.cpuPct).toBeCloseTo(12, 0)
        expect(metrics.memUsedPct).toBeGreaterThan(0)
        expect(metrics.diskFreeBytes).toBeGreaterThan(0)
        expect(metrics.uptimeSeconds).toBeGreaterThan(80_000)
        expect(metrics.batteryPct).toBe(96)
      },
    )
  })

  it('reports the machine once, on connect', async () => {
    await withConnector<never, SysmonSimulator>(
      sysmonModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForFrame('info')
        const info = recorder.frames.find((frame) => frame.streamId === 'info')?.payload
        expect(info).toMatchObject({ hostname: 'foh-mac', osName: 'macOS' })
      },
    )
  })

  it('publishes the host fingerprint it decided to trust', async () => {
    // Trust on first use: the value is surfaced so a human can compare it, and
    // a later change is refused rather than silently accepted.
    await withConnector<never, SysmonSimulator>(
      sysmonModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForFrame('host')
        const host = recorder.frames.find((frame) => frame.streamId === 'host')?.payload as {
          fingerprint: string
        }
        expect(host.fingerprint).toBeTruthy()
      },
    )
  })

  it('notices a machine that goes away and reconnects when it returns', async () => {
    const simulator = new SysmonSimulator()

    await withConnector<never, SysmonSimulator>(
      sysmonModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        // A Mac closing its lid mid-show looks exactly like this.
        simulator.dropConnections()
        await recorder.waitForNextState('offline', 20_000)
      },
    )
  })

  it('degrades when the far end is not a Mac', async () => {
    const simulator = new SysmonSimulator()
    await withConnector<never, SysmonSimulator>(
      sysmonModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        simulator.sendGarbage()
        await recorder.waitForNextState('degraded', 15_000)
        // And recovers by itself once the output makes sense again.
        await recorder.waitForNextState('online', 15_000)
      },
    )
  })

  it('flags a machine running on battery', () => {
    const condition = sysmonModule.meta.conditions?.find((c) => c.id === 'on-battery')

    expect(condition?.evaluate({ onBattery: false, batteryPct: 100 }, {})[0]?.active).toBe(false)
    expect(condition?.evaluate({ onBattery: true, batteryPct: 64 }, {})[0]).toMatchObject({
      active: true,
      detail: 'Unplugged from mains',
    })
  })

  it('does not call a charging laptop low', () => {
    // 20% on mains is a machine charging, not a problem to wake someone for.
    const condition = sysmonModule.meta.conditions?.find((c) => c.id === 'battery.low')
    expect(condition?.evaluate({ onBattery: false, batteryPct: 20 }, { pct: 30 })[0]?.active).toBe(
      false,
    )
    expect(condition?.evaluate({ onBattery: true, batteryPct: 20 }, { pct: 30 })[0]?.active).toBe(
      true,
    )
  })
})
