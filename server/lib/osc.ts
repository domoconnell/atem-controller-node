/**
 * Open Sound Control 1.0 messages, plus the SLIP framing that OSC-over-TCP
 * needs (RFC 1055).
 *
 * Hand-written rather than taken from npm: the wire format is four data types
 * and a padding rule, every OSC package on npm still leaves us to implement
 * SLIP ourselves for the TCP transport QLab uses, and a process that has to
 * survive a whole festival should not grow a dependency tree for this.
 */

/**
 * One OSC argument. `T`, `F` and `N` carry their entire value in the type tag,
 * which is why `value` only exists on the other four.
 */
export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; value: Buffer }
  | { type: 'T' }
  | { type: 'F' }
  | { type: 'N' }

export interface OscMessage {
  address: string
  args: OscArg[]
}

/** Rounds up to the next 4-byte boundary; OSC aligns everything to one. */
const pad4 = (size: number): number => (size + 3) & ~3

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647

export function encodeOscMessage(address: string, args: readonly OscArg[] = []): Buffer {
  // Encoding failures are our own bug rather than untrusted input, so they
  // throw loudly here while decoding stays silent — see decodeOscMessage.
  if (!address.startsWith('/')) throw new Error(`OSC address must start with "/": ${address}`)

  let tags = ','
  const payload: Buffer[] = []

  for (const arg of args) {
    tags += arg.type
    switch (arg.type) {
      case 'i': {
        if (!Number.isInteger(arg.value) || arg.value < INT32_MIN || arg.value > INT32_MAX) {
          throw new Error(`OSC int32 out of range: ${arg.value}`)
        }
        const buffer = Buffer.alloc(4)
        buffer.writeInt32BE(arg.value, 0)
        payload.push(buffer)
        break
      }
      case 'f': {
        const buffer = Buffer.alloc(4)
        buffer.writeFloatBE(arg.value, 0)
        payload.push(buffer)
        break
      }
      case 's':
        payload.push(encodeOscString(arg.value))
        break
      case 'b':
        payload.push(encodeOscBlob(arg.value))
        break
      default:
        break
    }
  }

  return Buffer.concat([encodeOscString(address), encodeOscString(tags), ...payload])
}

/**
 * Returns null for anything malformed instead of throwing.
 *
 * Everything handed to this function came off a socket, and one bad packet
 * from a device must never be able to take an instance offline mid-show: the
 * caller logs it and waits for the next one.
 */
export function decodeOscMessage(buffer: Buffer): OscMessage | null {
  // A whole OSC packet is 4-byte aligned; anything else is a truncated read.
  if (buffer.length === 0 || buffer.length % 4 !== 0) return null

  const address = readOscString(buffer, 0)
  if (address === null || !address.value.startsWith('/')) return null

  let offset = address.next
  // Pre-1.0 senders omit the type tag string entirely for argument-less
  // messages, and QLab's `/update/...` pushes sometimes do the same.
  if (offset === buffer.length) return { address: address.value, args: [] }

  const tags = readOscString(buffer, offset)
  if (tags === null || !tags.value.startsWith(',')) return null
  offset = tags.next

  const args: OscArg[] = []
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i': {
        if (offset + 4 > buffer.length) return null
        args.push({ type: 'i', value: buffer.readInt32BE(offset) })
        offset += 4
        break
      }
      case 'f': {
        if (offset + 4 > buffer.length) return null
        args.push({ type: 'f', value: buffer.readFloatBE(offset) })
        offset += 4
        break
      }
      case 's': {
        const value = readOscString(buffer, offset)
        if (value === null) return null
        args.push({ type: 's', value: value.value })
        offset = value.next
        break
      }
      case 'b': {
        if (offset + 4 > buffer.length) return null
        const size = buffer.readInt32BE(offset)
        const start = offset + 4
        if (size < 0 || start + size > buffer.length) return null
        args.push({ type: 'b', value: Buffer.from(buffer.subarray(start, start + size)) })
        offset = start + pad4(size)
        break
      }
      case 'T':
        args.push({ type: 'T' })
        break
      case 'F':
        args.push({ type: 'F' })
        break
      case 'N':
        args.push({ type: 'N' })
        break
      default:
        // An unknown tag has an unknown payload width, so every argument after
        // it would be read from the wrong offset. Dropping the packet is
        // honest; inventing values is not.
        return null
    }
  }

  return { address: address.value, args }
}

/**
 * OSC strings are null-terminated and then padded to a 4-byte boundary, so a
 * string whose byte length is already a multiple of four gains four nulls
 * rather than none. Getting this backwards is the classic OSC bug.
 */
function encodeOscString(value: string): Buffer {
  const bytes = Buffer.byteLength(value, 'utf8')
  const out = Buffer.alloc(pad4(bytes + 1))
  out.write(value, 0, 'utf8')
  return out
}

/** Blobs are length-prefixed, and unlike strings need no terminator. */
function encodeOscBlob(value: Buffer): Buffer {
  const out = Buffer.alloc(4 + pad4(value.length))
  out.writeInt32BE(value.length, 0)
  value.copy(out, 4)
  return out
}

function readOscString(buffer: Buffer, offset: number): { value: string; next: number } | null {
  if (offset >= buffer.length) return null
  const end = buffer.indexOf(0, offset)
  if (end === -1) return null
  const next = offset + pad4(end - offset + 1)
  if (next > buffer.length) return null
  return { value: buffer.toString('utf8', offset, end), next }
}

/**
 * A whole datagram, which may be a bundle.
 *
 * `decodeOscMessage` deliberately handles one message, because that is all
 * QLab over TCP ever sends and a decoder that quietly unpacked bundles would
 * make a framing bug look like a working connection. A UDP port open to
 * whatever is on the show LAN is the other case: TouchOSC, QLab's own OSC
 * output and several consoles wrap even a single message in a `#bundle`, and
 * a listener that ignored those would refuse perfectly ordinary traffic and
 * have nothing useful to say about why.
 *
 * Returns every message in the bundle, in order, and an empty array for
 * anything unparseable. Nested bundles are legal OSC and are flattened; the
 * timetag is read past and ignored, because scheduling a cue for later is not
 * something this system offers and pretending otherwise would be worse than
 * acting now.
 */
export function decodeOscPacket(buffer: Buffer): OscMessage[] {
  if (buffer.subarray(0, 8).toString('ascii') === '#bundle\0') {
    const messages: OscMessage[] = []
    // 8 bytes of '#bundle\0' plus an 8-byte timetag.
    let offset = 16
    while (offset + 4 <= buffer.length) {
      const size = buffer.readInt32BE(offset)
      offset += 4
      if (size <= 0 || offset + size > buffer.length) break
      messages.push(...decodeOscPacket(buffer.subarray(offset, offset + size)))
      offset += size
    }
    return messages
  }

  const message = decodeOscMessage(buffer)
  return message ? [message] : []
}

export const SLIP_END = 0xc0
export const SLIP_ESC = 0xdb
export const SLIP_ESC_END = 0xdc
export const SLIP_ESC_ESC = 0xdd

/** Frames one packet: escape the two reserved bytes, then terminate with END. */
export function slipEncode(packet: Buffer): Buffer {
  // Worst case every byte needs escaping, plus the trailing END.
  const out = Buffer.alloc(packet.length * 2 + 1)
  let length = 0

  for (const byte of packet) {
    if (byte === SLIP_END) {
      out[length++] = SLIP_ESC
      out[length++] = SLIP_ESC_END
    } else if (byte === SLIP_ESC) {
      out[length++] = SLIP_ESC
      out[length++] = SLIP_ESC_ESC
    } else {
      out[length++] = byte
    }
  }

  out[length++] = SLIP_END
  return out.subarray(0, length)
}

/**
 * The receiving half. TCP hands us whatever it likes — half a packet, three
 * packets, or a chunk that ends between an ESC and the byte it escapes — so
 * the escape state has to live across calls.
 */
export class SlipDecoder {
  private buffer = Buffer.alloc(1024)
  private length = 0
  private escaped = false
  private overflowed = false

  /**
   * `maxPacketBytes` defaults high because a QLab workspace with thousands of
   * cues answers `/cueLists/shallow` with a genuinely large JSON blob; the cap
   * only exists so a peer that never sends END cannot exhaust memory.
   */
  constructor(private readonly maxPacketBytes = 4 * 1024 * 1024) {}

  push(chunk: Buffer): Buffer[] {
    const packets: Buffer[] = []

    for (const byte of chunk) {
      if (this.escaped) {
        this.escaped = false
        // RFC 1055 leaves an ESC followed by anything else undefined; taking
        // the byte literally keeps us in sync with the rest of the stream.
        if (byte === SLIP_ESC_END) this.append(SLIP_END)
        else if (byte === SLIP_ESC_ESC) this.append(SLIP_ESC)
        else this.append(byte)
        continue
      }

      if (byte === SLIP_END) {
        // Senders may lead with END to flush line noise, which produces an
        // empty packet the spec says to ignore.
        if (this.length > 0 && !this.overflowed) {
          packets.push(Buffer.from(this.buffer.subarray(0, this.length)))
        }
        this.length = 0
        this.overflowed = false
        continue
      }

      if (byte === SLIP_ESC) {
        this.escaped = true
        continue
      }

      this.append(byte)
    }

    return packets
  }

  reset(): void {
    this.length = 0
    this.escaped = false
    this.overflowed = false
  }

  private append(byte: number): void {
    if (this.length >= this.maxPacketBytes) {
      // Keep consuming so the next END still resynchronises the stream; the
      // oversized packet itself is dropped.
      this.overflowed = true
      return
    }
    if (this.length === this.buffer.length) {
      const grown = Buffer.alloc(this.buffer.length * 2)
      this.buffer.copy(grown)
      this.buffer = grown
    }
    this.buffer[this.length++] = byte
  }
}
