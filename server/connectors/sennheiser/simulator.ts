import { createSocket, type Socket } from 'node:dgram'
import type { SimulatorHandle } from '../core/types.js'

interface FakeChannel {
  name: string
  rsqi: number
  rfLevel: number
  afLevel: number
  battery: number
  muted: boolean
}

/**
 * A fake EW-DX receiver speaking SSC over UDP.
 *
 * Push subscriptions are the interesting part: the real receiver sends
 * unsolicited updates on the same socket, and a connector that only polls
 * would look fine here while missing every change on real hardware.
 */
export class SennheiserSimulator implements SimulatorHandle {
  private socket: Socket | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private subscribers = new Set<string>()
  private garbage = false

  channels: Record<string, FakeChannel> = {
    '1': { name: 'Vocal 1', rsqi: 5, rfLevel: -52, afLevel: -18, battery: 84, muted: false },
    '2': { name: 'Vocal 2', rsqi: 4, rfLevel: -60, afLevel: -22, battery: 61, muted: false },
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    const socket = createSocket('udp4')
    this.socket = socket

    socket.on('message', (message, remote) => {
      const key = `${remote.address}:${remote.port}`
      let request: Record<string, unknown>
      try {
        request = JSON.parse(message.toString()) as Record<string, unknown>
      } catch {
        return
      }

      if (this.garbage) {
        this.garbage = false
        socket.send('{not json at all', remote.port, remote.address)
        return
      }

      const osc = request.osc as { state?: { subscribe?: unknown } } | undefined
      if (osc?.state?.subscribe) {
        this.subscribers.add(key)
        this.send(remote.port, remote.address, this.snapshot())
        return
      }

      // Control writes, echoed back the way a receiver acknowledges them.
      for (const channel of ['1', '2']) {
        const rx = request[`rx${channel}`] as Record<string, unknown> | undefined
        if (!rx) continue
        if (typeof rx.mute === 'boolean') {
          const target = this.channels[channel]
          if (target) target.muted = rx.mute
        }
      }

      this.send(remote.port, remote.address, this.snapshot())
    })

    await new Promise<void>((resolve) => socket.bind(port, host, resolve))

    // Unsolicited pushes, as a real receiver produces.
    this.pushTimer = setInterval(() => {
      for (const key of this.subscribers) {
        const [address, subscriberPort] = key.split(':')
        if (!address || !subscriberPort) continue
        this.send(Number(subscriberPort), address, this.snapshot())
      }
    }, 500)
    this.pushTimer.unref()

    const address = socket.address()
    return { host, port: address.port }
  }

  async close(): Promise<void> {
    if (this.pushTimer) clearInterval(this.pushTimer)
    this.pushTimer = null
    const socket = this.socket
    this.socket = null
    this.subscribers.clear()
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()))
  }

  dropConnections(): void {
    // UDP has no connection to drop; going silent is the equivalent failure,
    // and it is what a receiver switched off actually looks like.
    this.subscribers.clear()
  }

  sendGarbage(): void {
    this.garbage = true
  }

  /** Sends an expiry error, so the connector's re-subscribe path is exercised. */
  expireSubscriptions(): void {
    for (const key of this.subscribers) {
      const [address, port] = key.split(':')
      if (!address || !port) continue
      this.send(
        Number(port),
        address,
        JSON.stringify({
          osc: {
            error: [{ osc: { state: { subscribe: [310, { desc: 'subscription expired' }] } } }],
          },
        }),
      )
    }
    this.subscribers.clear()
  }

  private snapshot(): string {
    const rx = (channel: string) => {
      const state = this.channels[channel]
      if (!state) return {}
      return {
        rsqi: state.rsqi,
        name: state.name,
        mute: state.muted,
        rf: { level: state.rfLevel, frequency: 606_250 },
        audio: { level: state.afLevel },
      }
    }

    return JSON.stringify({
      device: { name: 'EM-DX-RACK-1', identity: { product: 'EW-DX EM 2' }, warnings: [] },
      rx1: rx('1'),
      rx2: rx('2'),
      mates: {
        tx1: { battery: { gauge: this.channels['1']?.battery ?? 0, lifetime: 240 } },
        tx2: { battery: { gauge: this.channels['2']?.battery ?? 0, lifetime: 180 } },
      },
    })
  }

  private send(port: number, address: string, payload: string): void {
    this.socket?.send(payload, port, address)
  }
}
