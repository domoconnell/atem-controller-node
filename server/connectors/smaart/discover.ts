import type { ConfigOptions } from '@stageit/shared'
import { WebSocket } from 'ws'
import type { SmaartConfig } from './index.js'
import {
  API_ERRORS,
  API_PATH,
  type CalibratedChannel,
  classifyControlFrame,
  isBadPassword,
  parseCalibratedInputs,
  parseRootProperties,
} from './protocol.js'

/** One question, one answer. Long enough for a busy machine, short enough for a form. */
const REPLY_TIMEOUT_MS = 5_000
/** The whole exchange: connect, handshake, ask, close. */
const TOTAL_TIMEOUT_MS = 8_000

/**
 * Ask a Smaart what it has plugged in, without becoming a module.
 *
 * The connector learns the same thing on its `activeCalibratedInputs` poll,
 * but that is no use to the person filling in the add-module form: there is no
 * instance yet, so there is nothing polling, and the two fields that most want
 * a list — the device and the channel — are the two nobody can guess.
 *
 * **The control socket only.** No stream, no log subscription. Smaart's log
 * subsystem serves about four subscriptions before quietly delivering nothing,
 * so a form that took one every time somebody opened it would spend a rig's
 * budget on curiosity. This asks one question of a machine that may be
 * mid-show and hangs up.
 *
 * Deliberately its own path rather than a method on the connector: everything
 * there reports through `ctx` — degraded states, reconnects, published frames —
 * and a question asked from a form has no instance to report against. What it
 * shares is the part worth sharing, the protocol parsing.
 */
export async function discoverSmaartInputs(
  config: SmaartConfig,
  signal: AbortSignal,
): Promise<ConfigOptions> {
  /*
   * Checked before the socket exists, not only listened for.
   *
   * `addEventListener('abort')` on a signal that has *already* aborted never
   * fires, so a caller handing over a spent signal would have had a connection
   * opened on its behalf and held for the full timeout. Nothing does that
   * today — the route makes a fresh controller — but the contract says this
   * signal stops the work, and a contract that only holds for punctual callers
   * is not one.
   */
  if (signal.aborted) throw new DiscoveryError('Asked to stop before it started')

  const socket = new WebSocket(`ws://${config.host}:${config.port}${API_PATH}`)
  const pending = new Map<number, (frame: ReturnType<typeof classifyControlFrame>) => void>()
  let sequence = 0

  const close = () => {
    socket.removeAllListeners()
    socket.on('error', () => {})
    socket.terminate()
  }
  const abort = () => close()
  signal.addEventListener('abort', abort, { once: true })

  const overall = setTimeout(close, TOTAL_TIMEOUT_MS)
  overall.unref()

  try {
    socket.on('message', (raw: Buffer) => {
      let value: unknown
      try {
        value = JSON.parse(raw.toString())
      } catch {
        return
      }
      const frame = classifyControlFrame(value)
      if (frame.kind === 'unknown' || frame.sequenceNumber === null) return
      const resolve = pending.get(frame.sequenceNumber)
      if (!resolve) return
      pending.delete(frame.sequenceNumber)
      resolve(frame)
    })

    await opened(socket)

    const ask = (body: Record<string, unknown>) =>
      new Promise<ReturnType<typeof classifyControlFrame> | null>((resolve) => {
        if (socket.readyState !== WebSocket.OPEN) return resolve(null)
        const sequenceNumber = ++sequence
        const timer = setTimeout(() => {
          pending.delete(sequenceNumber)
          resolve(null)
        }, REPLY_TIMEOUT_MS)
        timer.unref()
        pending.set(sequenceNumber, (frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
        socket.send(JSON.stringify({ ...body, sequenceNumber }))
      })

    const root = await ask({ action: 'get' })
    if (!root || root.kind !== 'reply') {
      throw new DiscoveryError(
        root?.kind === 'error'
          ? `Smaart refused the connection: ${root.message}`
          : 'Smaart did not answer',
      )
    }
    const properties = parseRootProperties(root.response)
    if (!properties)
      throw new DiscoveryError('That is answering, but it is not a Smaart API v4 server')

    if (properties.authenticationRequired) {
      const password = config.password?.trim() ?? ''
      if (password.length === 0) throw new DiscoveryError('Smaart is asking for a password')
      const authenticated = await ask({ action: 'set', properties: [{ password }] })
      if (!authenticated || authenticated.kind !== 'reply') {
        // Smaart 9.6.4 answers "incorect password"; relaying a vendor's typo
        // to somebody standing at a laptop helps nobody.
        throw new DiscoveryError(
          authenticated?.kind === 'error' && isBadPassword(authenticated.message)
            ? 'Smaart did not accept this password'
            : 'Smaart refused the password',
        )
      }
    }

    const reply = await ask({ action: 'get', target: 'activeCalibratedInputs' })
    if (!reply || reply.kind !== 'reply') {
      throw new DiscoveryError(
        reply?.kind === 'error' && reply.message === API_ERRORS.unknownTarget
          ? 'This edition of Smaart has no calibrated inputs — Suite or SPL is needed'
          : 'Smaart would not list its inputs',
      )
    }

    return toOptions(parseCalibratedInputs(reply.response).channels)
  } finally {
    clearTimeout(overall)
    signal.removeEventListener('abort', abort)
    close()
  }
}

/** A reason somebody at a laptop can act on, rather than a stack trace. */
export class DiscoveryError extends Error {}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', (error: Error) =>
      reject(new DiscoveryError(`Could not reach Smaart — ${error.message}`)),
    )
    socket.once('close', () => reject(new DiscoveryError('Smaart closed the connection')))
  })
}

/**
 * Channels into two lists the form can offer.
 *
 * Devices carry no dependency; channels hang off the device they belong to, so
 * choosing one narrows the other. The device is folded into a channel's label
 * only when there is more than one device to confuse it with — on the ordinary
 * rig with a single interface, "FOH Left — Scarlett 18i20" is noise.
 */
function toOptions(channels: readonly CalibratedChannel[]): ConfigOptions {
  const devices = [...new Set(channels.map((channel) => channel.deviceName))]

  return {
    deviceName: devices.map((value) => ({ value })),
    channelName: channels.map((channel) => ({
      value: channel.channelName,
      ...(devices.length > 1 ? { label: `${channel.channelName} — ${channel.deviceName}` } : {}),
      when: { field: 'deviceName', equals: channel.deviceName },
    })),
  }
}
