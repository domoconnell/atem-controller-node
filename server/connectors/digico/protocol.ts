/**
 * DiGiCo SD-series OSC, as spoken by the "DiGiCo Pad" external-control device.
 *
 * There is no published address dictionary. Everything here is either
 * documented in DiGiCo's technical notes or proven by the two open
 * implementations that talk to real consoles (the Bitfocus Companion module
 * and OSCWebMixer). Anything not on that list is not guessed at.
 *
 * Firmware quirk worth knowing: some builds expect the `/sd/` prefix and some
 * reject it, so the prefix is configurable and both forms are accepted on the
 * way in.
 */

export interface OscMessage {
  address: string
  args: (number | string)[]
}

/** Minimal OSC 1.0 encoder — enough for the small vocabulary we send. */
export function encodeOsc(message: OscMessage): Buffer {
  const parts: Buffer[] = [padded(message.address)]

  let tags = ','
  const values: Buffer[] = []
  for (const arg of message.args) {
    if (typeof arg === 'string') {
      tags += 's'
      values.push(padded(arg))
    } else if (Number.isInteger(arg)) {
      tags += 'i'
      const buffer = Buffer.alloc(4)
      buffer.writeInt32BE(arg)
      values.push(buffer)
    } else {
      tags += 'f'
      const buffer = Buffer.alloc(4)
      buffer.writeFloatBE(arg)
      values.push(buffer)
    }
  }

  parts.push(padded(tags), ...values)
  return Buffer.concat(parts)
}

export function decodeOsc(buffer: Buffer): OscMessage | null {
  try {
    // Bundles arrive from some firmware; take the messages inside.
    if (buffer.subarray(0, 7).toString() === '#bundle') {
      const inner = readBundle(buffer)
      return inner[0] ?? null
    }

    let offset = 0
    const address = readString(buffer, offset)
    if (!address) return null
    offset = address.next
    if (!address.value.startsWith('/')) return null

    const tags = readString(buffer, offset)
    if (!tags) return { address: address.value, args: [] }
    offset = tags.next

    const args: (number | string)[] = []
    for (const tag of tags.value.slice(1)) {
      if (tag === 'i') {
        args.push(buffer.readInt32BE(offset))
        offset += 4
      } else if (tag === 'f') {
        args.push(buffer.readFloatBE(offset))
        offset += 4
      } else if (tag === 's') {
        const value = readString(buffer, offset)
        if (!value) break
        args.push(value.value)
        offset = value.next
      }
      // Unknown tags end parsing: a partial message is better than a wrong one.
      else break
    }

    return { address: address.value, args }
  } catch {
    // Malformed datagram on a show network: drop it, keep the connection.
    return null
  }
}

function readBundle(buffer: Buffer): OscMessage[] {
  const messages: OscMessage[] = []
  let offset = 16 // '#bundle\0' plus the timetag

  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32BE(offset)
    offset += 4
    if (size <= 0 || offset + size > buffer.length) break
    const message = decodeOsc(buffer.subarray(offset, offset + size))
    if (message) messages.push(message)
    offset += size
  }
  return messages
}

function readString(buffer: Buffer, offset: number): { value: string; next: number } | null {
  const end = buffer.indexOf(0, offset)
  if (end < 0) return null
  return { value: buffer.subarray(offset, end).toString(), next: pad4(end + 1) }
}

function padded(value: string): Buffer {
  const raw = Buffer.from(`${value}\0`)
  const size = pad4(raw.length)
  const out = Buffer.alloc(size)
  raw.copy(out)
  return out
}

function pad4(value: number): number {
  return value + ((4 - (value % 4)) % 4)
}

// ------------------------------------------------------------------ addresses

/** Strips an optional `/sd` prefix so both firmware dialects parse the same. */
export function normaliseAddress(address: string): string {
  return address.startsWith('/sd/') ? address.slice(3) : address
}

export interface ChannelState {
  channel: number
  name: string | null
  muted: boolean | null
  faderDb: number | null
}

export interface MacroState {
  index: number
  name: string
  on: boolean
  at: number
}

export interface DigicoUpdate {
  channel?: ChannelState
  macro?: MacroState
  snapshotNumber?: number
}

/**
 * Interprets one message from the console.
 *
 * `/Macros/Buttons/state` carries `[index, status, name]` — the macro's own
 * name is the reason the message bridge works at all: a console operator can
 * label a macro "Mic 3 down" and the dashboard sees that text.
 */
export function interpret(message: OscMessage): DigicoUpdate | null {
  const address = normaliseAddress(message.address)

  const macro = /^\/Macros\/Buttons\/state$/.exec(address)
  if (macro) {
    const [index, status, name] = message.args
    if (typeof index !== 'number') return null
    return {
      macro: {
        index,
        name: typeof name === 'string' ? name : `Macro ${index}`,
        on: Number(status) > 0,
        at: Date.now(),
      },
    }
  }

  const channel = /^\/Input_Channels\/(\d+)\/(.+)$/.exec(address)
  if (channel) {
    const number = Number(channel[1])
    const leaf = channel[2] ?? ''
    const value = message.args[0]

    if (leaf === 'Channel_Input/name') {
      return { channel: { channel: number, name: String(value ?? ''), muted: null, faderDb: null } }
    }
    if (leaf === 'mute') {
      return { channel: { channel: number, name: null, muted: Number(value) > 0, faderDb: null } }
    }
    if (leaf === 'fader') {
      return {
        channel: {
          channel: number,
          name: null,
          muted: null,
          faderDb: typeof value === 'number' ? Math.round(value * 10) / 10 : null,
        },
      }
    }
    return null
  }

  if (/^\/Snapshots\/Fire_Snapshot_number$/.test(address)) {
    const value = message.args[0]
    return typeof value === 'number' ? { snapshotNumber: value } : null
  }

  return null
}

/** Query messages the console answers with current values. */
export function queryMessages(prefix: string, channelCount: number): OscMessage[] {
  const messages: OscMessage[] = [{ address: `${prefix}/Macros/Buttons/?`, args: [] }]

  for (let channel = 1; channel <= channelCount; channel++) {
    messages.push({ address: `${prefix}/Input_Channels/${channel}/Channel_Input/name/?`, args: [] })
    messages.push({ address: `${prefix}/Input_Channels/${channel}/mute/?`, args: [] })
  }
  return messages
}

export function fireMacroMessage(prefix: string, index: number): OscMessage {
  return { address: `${prefix}/Macros/Buttons/press`, args: [index] }
}

/** Set an input channel's mute. Same address the console reports mute on, which
 *  is bidirectional on the Pad OSC command set (1 = muted, 0 = open). */
export function muteChannelMessage(prefix: string, channel: number, muted: boolean): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/mute`, args: [muted ? 1 : 0] }
}
