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

// ------------------------------------------------------------------ fader taper

/**
 * DiGiCo faders and send levels are a 0..1 float on a piecewise-linear taper,
 * NOT linear dB. Breakpoints confirmed from the DiGiCo dealer "Other OSC" docs
 * (also used by bitfocus/companion-module-digico-osc and the mix-my-ears spike):
 *   0.75 = 0 dB (unity), 1.0 = +10, 0.625 = −6, 0.5 = −10, 0.375 = −20,
 *   0.25 = −30, 0.125 = −50, 0.0 = OFF (−∞).
 */
const TAPER: Array<[fader: number, db: number]> = [
  [0, -90], [0.125, -50], [0.25, -30], [0.375, -20], [0.5, -10], [0.625, -6], [0.75, 0], [1, 10],
]
/** 0..1 fader float → dB. Exactly 0 is OFF (−Infinity). */
export function faderToDb(fader: number): number {
  if (fader <= 0) return -Infinity
  const f = Math.min(1, fader)
  for (let i = 1; i < TAPER.length; i++) {
    const [f0, d0] = TAPER[i - 1], [f1, d1] = TAPER[i]
    if (f <= f1) return Math.round((d0 + ((f - f0) / (f1 - f0)) * (d1 - d0)) * 10) / 10
  }
  return 10
}
/** dB → 0..1 fader float. −Infinity / ≤ −90 dB is OFF (0). */
export function dbToFader(db: number): number {
  if (db === -Infinity || db <= -90) return 0
  const d = Math.min(10, db)
  for (let i = 1; i < TAPER.length; i++) {
    const [f0, d0] = TAPER[i - 1], [f1, d1] = TAPER[i]
    if (d <= d1) return Math.round((f0 + ((d - d0) / (d1 - d0)) * (f1 - f0)) * 1000) / 1000
  }
  return 1
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

/** One channel→aux send leaf (level in dB / on / pan −1..+1). */
export interface AuxSendState {
  ch: number
  aux: number
  level?: number
  on?: boolean
  pan?: number
}

export interface DigicoUpdate {
  channel?: ChannelState
  auxSend?: AuxSendState
  macro?: MacroState
  snapshotNumber?: number
}

/** Parse an aux-send address ".../Input_Channels/{ch}/Aux_Send/{aux}/{leaf}". */
export function parseAuxSend(address: string): { ch: number; aux: number; leaf: string } | null {
  const m = /\/Input_Channels\/(\d+)\/Aux_Send\/(\d+)\/([a-z_]+)(?:\/\?)?$/i.exec(address)
  return m ? { ch: Number(m[1]), aux: Number(m[2]), leaf: m[3] } : null
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
      // The console reports the raw 0..1 taper float; convert to dB properly.
      const db = typeof value === 'number' ? faderToDb(value) : null
      return { channel: { channel: number, name: null, muted: null, faderDb: db == null || db === -Infinity ? db : Math.round(db * 10) / 10 } }
    }
    // Aux sends (ch → aux): level / on / pan — the IEM-mixing surface.
    const aux = parseAuxSend(address)
    if (aux) {
      const v = value
      return {
        auxSend: {
          ch: aux.ch, aux: aux.aux,
          level: aux.leaf === 'send_level' && typeof v === 'number' ? faderToDb(v) : undefined,
          on: aux.leaf === 'send_on' ? Number(v) > 0 : undefined,
          pan: aux.leaf === 'send_pan' && typeof v === 'number' ? v : undefined,
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
    messages.push({ address: `${prefix}/Input_Channels/${channel}/fader/?`, args: [] })
  }
  return messages
}

/** Press a macro. NOTE: the dealer "Other OSC" list documents this arg as
 *  0-based (macroIndex − 1); our simulator uses the 1-based index it reports in
 *  `/Macros/Buttons/state`. Confirm the convention on real hardware before a show
 *  relies on it (the module is `unproven`). */
export function fireMacroMessage(prefix: string, index: number): OscMessage {
  return { address: `${prefix}/Macros/Buttons/press`, args: [index] }
}

/** Set an input channel's mute. Same address the console reports mute on, which
 *  is bidirectional on the Pad OSC command set (1 = muted, 0 = open). */
export function muteChannelMessage(prefix: string, channel: number, muted: boolean): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/mute`, args: [muted ? 1 : 0] }
}

/** Set an input channel's fader to a dB level (converted onto the 0..1 taper). */
export function faderMessage(prefix: string, channel: number, db: number): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/fader`, args: [dbToFader(db)] }
}

/** Set a channel→aux send level (dB → 0..1 taper). */
export function auxSendLevelMessage(prefix: string, channel: number, aux: number, db: number): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/Aux_Send/${aux}/send_level`, args: [dbToFader(db)] }
}
/** Turn a channel→aux send on/off. */
export function auxSendOnMessage(prefix: string, channel: number, aux: number, on: boolean): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/Aux_Send/${aux}/send_on`, args: [on ? 1 : 0] }
}

/** Fire a snapshot by absolute number. */
export function snapshotFireMessage(prefix: string, number: number): OscMessage {
  return { address: `${prefix}/Snapshots/Fire_Snapshot_number`, args: [number] }
}
/** Fire the next / previous snapshot in the session. */
export function snapshotNextMessage(prefix: string): OscMessage {
  return { address: `${prefix}/Snapshots/Fire_Next_Snapshot`, args: [0] }
}
export function snapshotPrevMessage(prefix: string): OscMessage {
  return { address: `${prefix}/Snapshots/Fire_Prev_Snapshot`, args: [0] }
}
