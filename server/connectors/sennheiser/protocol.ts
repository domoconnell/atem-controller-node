/**
 * Sennheiser Sound Control Protocol (SSC).
 *
 * JSON over UDP, one message per datagram, straight to the receiver — no
 * Wireless Systems Manager in the middle. A query sends the path with a null
 * leaf; a subscription asks the receiver to push changes as they happen, which
 * is what keeps RF and battery current without polling a rack of receivers
 * several times a second.
 */

/** The documented default port for SSC v1. */
export const SSC_PORT = 45

export interface ChannelReading {
  /** '1' or '2' on an EM 2; the key a widget filters problems by. */
  channel: string
  name: string | null
  /** Sennheiser's own 1–5 quality figure, which beats a raw dBm reading. */
  rsqi: number | null
  rfLevelDbm: number | null
  afLevelDb: number | null
  batteryPct: number | null
  /** Minutes remaining, when the transmitter reports it. */
  batteryRuntimeMin: number | null
  muted: boolean | null
  frequencyMhz: number | null
  /** True when a transmitter is actually linked to this receiver channel. */
  linked: boolean
}

export interface DeviceReading {
  name: string | null
  model: string | null
  /** Anything the receiver is complaining about, verbatim. */
  warnings: string[]
}

/** Subscription request. The receiver then pushes changes on the same socket. */
export function subscribeMessage(lifetimeSeconds = 120): string {
  return JSON.stringify({
    osc: {
      state: {
        subscribe: [
          {
            '#': { lifetime: lifetimeSeconds },
            rx1: { rsqi: null, rf: { level: null }, audio: { level: null }, mute: null },
            rx2: { rsqi: null, rf: { level: null }, audio: { level: null }, mute: null },
            mates: { tx1: { battery: null }, tx2: { battery: null } },
          },
        ],
      },
    },
  })
}

/** Full read, used on connect and to refresh names and frequencies. */
export function queryMessage(): string {
  return JSON.stringify({
    device: { name: null, identity: { product: null }, warnings: null },
    rx1: { rsqi: null, rf: { level: null }, audio: { level: null }, mute: null, name: null },
    rx2: { rsqi: null, rf: { level: null }, audio: { level: null }, mute: null, name: null },
    mates: {
      tx1: { battery: null, capsule: null },
      tx2: { battery: null, capsule: null },
    },
  })
}

export function identifyMessage(channel: string): string {
  return JSON.stringify({ [`rx${channel}`]: { identify: true } })
}

export function muteMessage(channel: string, muted: boolean): string {
  return JSON.stringify({ [`rx${channel}`]: { mute: muted } })
}

export interface SscUpdate {
  channels: Map<string, Partial<ChannelReading>>
  device: Partial<DeviceReading> | null
  /** SSC reports subscription expiry as an error; the caller must re-subscribe. */
  subscriptionExpired: boolean
}

/**
 * Folds one datagram into whatever it happened to carry.
 *
 * Receivers answer with only the branches that changed, so this deliberately
 * returns partials rather than a whole reading — the connector merges them
 * onto the last known state.
 */
export function parseSscMessage(raw: string): SscUpdate | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // A malformed datagram on a busy RF network is not worth dropping the
    // connection over.
    return null
  }
  if (typeof body !== 'object' || body === null) return null

  const root = body as Record<string, unknown>
  const update: SscUpdate = { channels: new Map(), device: null, subscriptionExpired: false }

  // Error 310 is how a receiver says "your subscription just ran out".
  if (JSON.stringify(root.osc ?? {}).includes('310')) update.subscriptionExpired = true

  for (const channel of ['1', '2']) {
    const rx = asRecord(root[`rx${channel}`])
    if (Object.keys(rx).length === 0) continue

    const reading: Partial<ChannelReading> = { channel }
    if ('rsqi' in rx) reading.rsqi = num(rx.rsqi)
    if ('name' in rx) reading.name = str(rx.name)
    if ('mute' in rx) reading.muted = bool(rx.mute)

    const rf = asRecord(rx.rf)
    if ('level' in rf) reading.rfLevelDbm = num(rf.level)
    if ('frequency' in rf) {
      const khz = num(rf.frequency)
      reading.frequencyMhz = khz === null ? null : Math.round(khz / 100) / 10
    }

    const audio = asRecord(rx.audio)
    if ('level' in audio) reading.afLevelDb = num(audio.level)

    update.channels.set(channel, reading)
  }

  const mates = asRecord(root.mates)
  for (const channel of ['1', '2']) {
    const tx = asRecord(mates[`tx${channel}`])
    if (Object.keys(tx).length === 0) continue

    const existing = update.channels.get(channel) ?? { channel }
    if ('battery' in tx) {
      const battery = tx.battery
      if (typeof battery === 'number') {
        existing.batteryPct = battery
      } else {
        const record = asRecord(battery)
        existing.batteryPct = num(record.gauge) ?? num(record.percent)
        existing.batteryRuntimeMin = num(record.lifetime)
      }
      // A gauge reading at all means a transmitter is talking to us.
      existing.linked = existing.batteryPct !== null
    }
    update.channels.set(channel, existing)
  }

  const device = asRecord(root.device)
  if (Object.keys(device).length > 0) {
    update.device = {
      name: 'name' in device ? str(device.name) : undefined,
      model: str(asRecord(device.identity).product) ?? undefined,
      warnings: Array.isArray(device.warnings)
        ? device.warnings.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
    }
  }

  return update
}

/** RSQI is 1–5; below 3 a receiver is audibly at risk. */
export function rsqiIsPoor(rsqi: number | null, threshold: number): boolean {
  return rsqi !== null && rsqi < threshold
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}
