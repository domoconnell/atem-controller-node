import { createSocket, type Socket } from 'node:dgram'
import type { SimulatorHandle } from '../core/types.js'
import { decodeOsc, encodeOsc, normaliseAddress, type OscMessage } from './protocol.js'

/**
 * A fake SD console speaking the Pad OSC subset we consume.
 *
 * Bi-directional UDP with a separate reply port, the way the real External
 * Control panel is configured: the console sends to a port you nominate, which
 * is the part most likely to be wrong on site.
 */
export class DigicoSimulator implements SimulatorHandle {
  private socket: Socket | null = null
  private replyTo: { port: number; address: string } | null = null
  private garbage = false

  /** Macros the console knows about; the labels drive the message bridge. */
  macros = [
    { index: 1, name: 'Need runner' },
    { index: 2, name: 'Mic 3 down' },
    { index: 3, name: 'All OK' },
  ]

  channels = [
    { channel: 1, name: 'Kick', muted: false },
    { channel: 2, name: 'Snare', muted: false },
  ]

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    const socket = createSocket('udp4')
    this.socket = socket

    socket.on('message', (buffer, remote) => {
      this.replyTo = { port: remote.port, address: remote.address }

      if (this.garbage) {
        this.garbage = false
        socket.send(Buffer.from('not osc at all'), remote.port, remote.address)
        return
      }

      const message = decodeOsc(buffer)
      if (!message) return
      const address = normaliseAddress(message.address)

      if (address === '/Macros/Buttons/?') {
        for (const macro of this.macros) this.sendMacroState(macro.index, false)
        return
      }
      if (address === '/Macros/Buttons/press') {
        const index = Number(message.args[0])
        // Real consoles report the press as a state change, which is exactly
        // the signal the dashboard turns into a message.
        this.sendMacroState(index, true)
        return
      }

      const named = /^\/Input_Channels\/(\d+)\/Channel_Input\/name\/\?$/.exec(address)
      if (named) {
        const channel = this.channels.find((entry) => entry.channel === Number(named[1]))
        if (channel) {
          this.reply({
            address: `/Input_Channels/${channel.channel}/Channel_Input/name`,
            args: [channel.name],
          })
        }
        return
      }

      const muted = /^\/Input_Channels\/(\d+)\/mute\/\?$/.exec(address)
      if (muted) {
        const channel = this.channels.find((entry) => entry.channel === Number(muted[1]))
        if (channel) {
          this.reply({
            address: `/Input_Channels/${channel.channel}/mute`,
            args: [channel.muted ? 1 : 0],
          })
        }
      }
    })

    await new Promise<void>((resolve) => socket.bind(port, host, resolve))
    return { host, port: socket.address().port }
  }

  async close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.replyTo = null
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()))
  }

  dropConnections(): void {
    this.replyTo = null
  }

  sendGarbage(): void {
    this.garbage = true
  }

  /** An operator pressing a labelled macro on the console surface. */
  pressMacro(index: number): void {
    this.sendMacroState(index, true)
  }

  setChannelMute(channel: number, muted: boolean): void {
    const target = this.channels.find((entry) => entry.channel === channel)
    if (target) target.muted = muted
    this.reply({ address: `/Input_Channels/${channel}/mute`, args: [muted ? 1 : 0] })
  }

  fireSnapshot(number: number): void {
    this.reply({ address: '/Snapshots/Fire_Snapshot_number', args: [number] })
  }

  private sendMacroState(index: number, on: boolean): void {
    const macro = this.macros.find((entry) => entry.index === index)
    this.reply({
      address: '/Macros/Buttons/state',
      args: [index, on ? 1 : 0, macro?.name ?? `Macro ${index}`],
    })
  }

  private reply(message: OscMessage): void {
    if (!this.socket || !this.replyTo) return
    this.socket.send(encodeOsc(message), this.replyTo.port, this.replyTo.address)
  }
}
