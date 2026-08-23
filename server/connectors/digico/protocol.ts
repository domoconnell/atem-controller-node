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

// ------------------------------------------------------------------ metering

/**
 * DiGiCo meter values, calibrated live against a real SD console (channel 2
 * mic, tone at known console-meter dB). Each `/Meters/values` message carries
 * [channelIndex, packed] where `packed` holds two 16-bit meter values (the two
 * legs of a stereo channel, or peak/level): A = high 16 bits, B = low 16 bits.
 * The value is ~ the number of dB below 0 — near 1:1 at the top, expanding
 * toward the floor. Calibration points (A → dB): 0→0, 6→−6, 12→−12, 21→−20,
 * 48→−40; a value near 126 means no signal (off). B decodes the same way.
 */
const METER_CAL: Array<[a: number, db: number]> = [
  [0, 0], [6, -6], [12, -12], [21, -20], [48, -40],
]
/** One 0..~126 DiGiCo meter reading → dB (−Infinity when off / below floor). */
export function meterToDb(a: number): number {
  if (a <= 0) return 0
  for (let i = 1; i < METER_CAL.length; i++) {
    const [a0, d0] = METER_CAL[i - 1], [a1, d1] = METER_CAL[i]
    if (a <= a1) return Math.round((d0 + ((a - a0) / (a1 - a0)) * (d1 - d0)) * 10) / 10
  }
  // Below the lowest calibrated point: extrapolate the last segment, floor to off.
  const [a0, d0] = METER_CAL[METER_CAL.length - 2], [a1, d1] = METER_CAL[METER_CAL.length - 1]
  const db = d1 + ((a - a1) / (a1 - a0)) * (d1 - d0)
  return db <= -90 ? -Infinity : Math.round(db * 10) / 10
}

// ------------------------------------------------------------------ command sets

/**
 * The DiGiCo command set, as the Bitfocus companion-module-digico-osc splits it
 * (its `series` config). Confirmed from that open-source module:
 *   - iPad ("DiGiCo Pad" device): addresses have NO prefix, and fader/send
 *     LEVELS are direct dB (−150 = OFF … +10). This is Companion's default and
 *     the set a console runs when iPads are connected.
 *   - OSC ("Other OSC" device):  addresses are `/sd/…`, and fader/send levels
 *     are the 0..1 taper.
 * The set must MATCH the console's enabled External Control device, or commands
 * are ignored. (S-series is a third, different scheme — not handled yet.)
 */
export type CommandSet = 'ipad' | 'osc'
export interface CommandSetProfile { prefix: string; directDb: boolean }
export function commandSetProfile(set: CommandSet | string): CommandSetProfile {
  return set === 'osc' ? { prefix: '/sd', directDb: false } : { prefix: '', directDb: true }
}
/** Encode a dB level for the chosen set: direct dB (iPad) or 0..1 taper (OSC). */
export const encodeLevel = (db: number, directDb: boolean): number => (directDb ? db : dbToFader(db))
/** Decode a level value from the console into dB, per set. */
export const decodeLevel = (v: number, directDb: boolean): number => (directDb ? v : faderToDb(v))

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
  stereo: boolean | null // Channel_Input/stereo_mode: 1 = mono, 2 = stereo
  inputType: number | null // Channel_Input/input_type: 0 = unpatched, 2 = mic/analogue
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

/** One slot's reading from `/Meters/values`. The console packs the level in the
 *  high 16 bits (a) and a second reading (peak/RMS) in the low 16 (b). The slot
 *  number is bound to a channel+leg by a prior `/Meters/request/<slot>`. */
export interface MeterSlot {
  slot: number
  a: number // dB, high 16 bits (level); -Infinity = off / below floor
  b: number // dB, low 16 bits  (peak/RMS of the same tap)
}

export interface DigicoUpdate {
  channel?: ChannelState
  auxSend?: AuxSendState
  macro?: MacroState
  snapshotNumber?: number
  meters?: MeterSlot[]
}

/** A downstream client's meter subscription. `/Meters/request/<slot>` binds a
 *  meter slot to a channel leg (its arg is a tap path like
 *  `/Input_Channels/13/Channel_Input/post_meter/left`); `/Meters/clear` resets
 *  every slot. We learn the slot→channel map by watching these on the relay. */
export function parseMeterRequest(
  message: OscMessage,
): { slot: number; channel: number; leg: 'l' | 'r' } | 'clear' | null {
  const address = normaliseAddress(message.address)
  if (address === '/Meters/clear') return 'clear'
  const m = /^\/Meters\/request\/(\d+)$/.exec(address)
  if (!m) return null
  const path = message.args[0]
  if (typeof path !== 'string') return null
  const pm = /\/Input_Channels\/(\d+)\/Channel_Input\/post_meter\/(left|right)/i.exec(path)
  if (!pm) return null
  return { slot: Number(m[1]), channel: Number(pm[1]), leg: pm[2].toLowerCase() === 'right' ? 'r' : 'l' }
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
export function interpret(message: OscMessage, directDb = false): DigicoUpdate | null {
  const address = normaliseAddress(message.address)

  // High-rate meter stream: a variable-length list of (slot, packed) int pairs,
  // packed = level(high16) << 16 | peak(low16). Only slots with signal appear.
  if (address === '/Meters/values') {
    const out: MeterSlot[] = []
    for (let i = 0; i + 1 < message.args.length; i += 2) {
      const slot = message.args[i], packed = message.args[i + 1]
      if (typeof slot !== 'number' || typeof packed !== 'number') continue
      const v = packed >>> 0
      out.push({ slot, a: meterToDb((v >>> 16) & 0xffff), b: meterToDb(v & 0xffff) })
    }
    return out.length ? { meters: out } : null
  }

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

    const blank = { name: null, muted: null, faderDb: null, stereo: null, inputType: null }
    if (leaf === 'Channel_Input/name') {
      return { channel: { channel: number, ...blank, name: String(value ?? '') } }
    }
    if (leaf === 'mute') {
      return { channel: { channel: number, ...blank, muted: Number(value) > 0 } }
    }
    if (leaf === 'fader') {
      // iPad set reports dB directly; OSC set reports the 0..1 taper float.
      const db = typeof value === 'number' ? decodeLevel(value, directDb) : null
      return { channel: { channel: number, ...blank, faderDb: db == null || db === -Infinity ? db : Math.round(db * 10) / 10 } }
    }
    // Channel format — 1 = mono, 2 = stereo. Names/format are how we build the
    // channel list the meters map onto.
    if (leaf === 'Channel_Input/stereo_mode') {
      return { channel: { channel: number, ...blank, stereo: Number(value) >= 2 } }
    }
    if (leaf === 'Channel_Input/input_type') {
      return { channel: { channel: number, ...blank, inputType: typeof value === 'number' ? Math.round(value) : null } }
    }
    // Aux sends (ch → aux): level / on / pan — the IEM-mixing surface.
    const aux = parseAuxSend(address)
    if (aux) {
      const v = value
      return {
        auxSend: {
          ch: aux.ch, aux: aux.aux,
          level: aux.leaf === 'send_level' && typeof v === 'number' ? decodeLevel(v, directDb) : undefined,
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
    messages.push({ address: `${prefix}/Input_Channels/${channel}/Channel_Input/stereo_mode/?`, args: [] })
    messages.push({ address: `${prefix}/Input_Channels/${channel}/Channel_Input/input_type/?`, args: [] })
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

/** Set an input channel's fader to a dB level (encoded for the active set). */
export function faderMessage(prefix: string, channel: number, db: number, directDb = false): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/fader`, args: [encodeLevel(db, directDb)] }
}

/** Set a channel→aux send level in dB (encoded for the active set). */
export function auxSendLevelMessage(prefix: string, channel: number, aux: number, db: number, directDb = false): OscMessage {
  return { address: `${prefix}/Input_Channels/${channel}/Aux_Send/${aux}/send_level`, args: [encodeLevel(db, directDb)] }
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
