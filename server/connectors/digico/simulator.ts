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

  // fader is the raw 0..1 taper float the console speaks (0.75 = unity/0 dB).
  channels = [
    { channel: 1, name: 'Kick', muted: false, fader: 0.75 },
    { channel: 2, name: 'Snare', muted: false, fader: 0.75 },
  ]
  private auxSends = new Map<string, { level: number; on: boolean }>() // key `${ch}:${aux}`
  private currentSnapshot = 1

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

      const muted = /^\/Input_Channels\/(\d+)\/mute(\/\?)?$/.exec(address)
      if (muted) {
        const channel = this.channels.find((entry) => entry.channel === Number(muted[1]))
        if (channel) {
          // A bare address with an arg is a SET; the "/?" form is a query. Both
          // echo the resulting value, like a real desk.
          if (!muted[2] && message.args.length) channel.muted = Number(message.args[0]) > 0
          this.reply({ address: `/Input_Channels/${channel.channel}/mute`, args: [channel.muted ? 1 : 0] })
        }
        return
      }

      const fader = /^\/Input_Channels\/(\d+)\/fader(\/\?)?$/.exec(address)
      if (fader) {
        const channel = this.channels.find((entry) => entry.channel === Number(fader[1]))
        if (channel) {
          if (!fader[2] && message.args.length) channel.fader = Number(message.args[0])
          this.reply({ address: `/Input_Channels/${channel.channel}/fader`, args: [channel.fader] })
        }
        return
      }

      const send = /^\/Input_Channels\/(\d+)\/Aux_Send\/(\d+)\/(send_level|send_on)(\/\?)?$/.exec(address)
      if (send) {
        const key = `${send[1]}:${send[2]}`, leaf = send[3], isQuery = !!send[4]
        const cur = this.auxSends.get(key) ?? { level: 0, on: false }
        if (!isQuery && message.args.length) {
          if (leaf === 'send_level') cur.level = Number(message.args[0])
          else cur.on = Number(message.args[0]) > 0
          this.auxSends.set(key, cur)
        }
        this.reply({ address: `/Input_Channels/${send[1]}/Aux_Send/${send[2]}/${leaf}`, args: [leaf === 'send_level' ? cur.level : cur.on ? 1 : 0] })
        return
      }

      if (address === '/Snapshots/Fire_Next_Snapshot') { this.currentSnapshot += 1; this.reply({ address: '/Snapshots/Fire_Snapshot_number', args: [this.currentSnapshot] }); return }
      if (address === '/Snapshots/Fire_Prev_Snapshot') { this.currentSnapshot = Math.max(1, this.currentSnapshot - 1); this.reply({ address: '/Snapshots/Fire_Snapshot_number', args: [this.currentSnapshot] }); return }
      if (address === '/Snapshots/Fire_Snapshot_number') { this.currentSnapshot = Number(message.args[0]) || this.currentSnapshot; this.reply({ address: '/Snapshots/Fire_Snapshot_number', args: [this.currentSnapshot] }); return }
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
