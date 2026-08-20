import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { sennheiserModule } from './index.js'
import { SennheiserSimulator } from './simulator.js'

interface ChannelsPayload {
  channels: {
    channel: string
    name: string | null
    rsqi: number | null
    batteryPct: number | null
    muted: boolean | null
    linked: boolean
  }[]
}

const FAST = { pollIntervalSeconds: 5, timeoutSeconds: 5 } as never

describe('sennheiser connector', () => {
  it('reports every channel on the receiver', async () => {
    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: FAST },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        await recorder.waitForFrame('channels')

        const payload = recorder.frames.find((frame) => frame.streamId === 'channels')
          ?.payload as ChannelsPayload
        expect(payload.channels).toHaveLength(2)
        expect(payload.channels[0]).toMatchObject({
          channel: '1',
          name: 'Vocal 1',
          rsqi: 5,
          batteryPct: 84,
          linked: true,
        })
      },
    )
  })

  it('keeps receiving without polling, from the receiver’s own pushes', async () => {
    const simulator = new SennheiserSimulator()

    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      // Refresh far enough out that anything arriving must be a push.
      { config: { pollIntervalSeconds: 300, timeoutSeconds: 20 } as never, simulator },
      async ({ recorder }) => {
        await recorder.waitForFrame('channels')
        const before = recorder.frames.filter((frame) => frame.streamId === 'channels').length

        const channel = simulator.channels['1']
        if (channel) channel.battery = 9

        await recorder.waitForFrame(
          'channels',
          (payload) => (payload as ChannelsPayload).channels[0]?.batteryPct === 9,
          8_000,
        )
        expect(
          recorder.frames.filter((frame) => frame.streamId === 'channels').length,
        ).toBeGreaterThan(before)
      },
    )
  })

  it('renews a lapsed subscription rather than going quiet', async () => {
    // A lapsed subscription looks exactly like a healthy silent rig, which is
    // the most dangerous failure this module could have.
    const simulator = new SennheiserSimulator()

    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: { pollIntervalSeconds: 300, timeoutSeconds: 20 } as never, simulator },
      async ({ recorder }) => {
        await recorder.waitForFrame('channels')
        simulator.expireSubscriptions()

        const channel = simulator.channels['2']
        if (channel) channel.rsqi = 1

        await recorder.waitForFrame(
          'channels',
          (payload) => (payload as ChannelsPayload).channels[1]?.rsqi === 1,
          10_000,
        )
      },
    )
  })

  it('goes offline when the receiver stops answering', async () => {
    const simulator = new SennheiserSimulator()

    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')

        // A receiver switched off simply stops sending: there is no
        // connection to close over UDP.
        await simulator.close()
        await recorder.waitForNextState('offline', 20_000)
      },
    )
  })

  it('survives a malformed datagram', async () => {
    const simulator = new SennheiserSimulator()

    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: FAST, simulator },
      async ({ recorder }) => {
        await recorder.waitForState('online')
        simulator.sendGarbage()

        await recorder.waitForFrame('channels', undefined, 10_000)
        expect(recorder.states).not.toContain('error')
      },
    )
  })

  it('mutes a channel when muting is allowed', async () => {
    const simulator = new SennheiserSimulator()

    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: { ...(FAST as object), allowMute: true } as never, simulator },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')

        const result = await exec('mute', { channel: '1', muted: true })
        expect(result.ok).toBe(true)

        await recorder.waitForFrame(
          'channels',
          (payload) => (payload as ChannelsPayload).channels[0]?.muted === true,
          8_000,
        )
      },
    )
  })

  it('refuses to mute when the admin has not allowed it', async () => {
    // Muting a live vocal mic from a dashboard should take a deliberate act.
    await withConnector<never, SennheiserSimulator>(
      sennheiserModule as never,
      { config: FAST },
      async ({ recorder, exec }) => {
        await recorder.waitForState('online')
        const result = await exec('mute', { channel: '1', muted: true })
        expect(result.ok).toBe(false)
      },
    )
  })

  it('flags only the channels in trouble', () => {
    const condition = sennheiserModule.meta.conditions?.find((c) => c.id === 'battery.low')
    const results = condition?.evaluate(
      {
        channels: [
          { channel: '1', name: 'Vocal 1', batteryPct: 8, linked: true, batteryRuntimeMin: 12 },
          { channel: '2', name: 'Vocal 2', batteryPct: 90, linked: true, batteryRuntimeMin: 300 },
          { channel: '3', name: 'Spare', batteryPct: null, linked: false, batteryRuntimeMin: null },
        ],
      },
      { pct: 25 },
    )

    expect(results?.filter((result) => result.active).map((result) => result.itemKey)).toEqual([
      '1',
    ])
  })
})
