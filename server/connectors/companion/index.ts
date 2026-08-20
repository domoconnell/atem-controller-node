import { createSocket, type Socket } from 'node:dgram'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { companionConditions } from './conditions.js'
import {
  baseUrl,
  coerceVariableValue,
  isVariableRef,
  oscButtonPress,
  oscVariableSet,
  parseVariableRef,
  variableValuePath,
} from './protocol.js'
import { CompanionSimulator } from './simulator.js'

export const companionConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8000),
  variables: z
    .array(
      z.string().min(1).refine(isVariableRef, {
        message: 'must be "connectionLabel:variableName" (e.g. "obs:streaming") or "custom:name"',
      }),
    )
    .default([])
    .describe(
      'Companion variables to read, one per entry. Use "connectionLabel:variableName" for a ' +
        "module variable — the label is the one in Companion's Connections tab and the name is " +
        'what appears inside $(...) — or "custom:name" for a custom variable. Each entry is ' +
        'published under exactly the text you type here, so widgets keep working when the ' +
        'underlying value changes.',
    ),
  pollIntervalMs: z.number().int().min(250).max(60_000).default(1_000),
  /**
   * How commands leave here. Reading is always HTTP, whichever this says.
   *
   * **HTTP by default and worth staying on unless something forces the
   * change.** It answers: a press either worked or came back with a status
   * code. OSC is one datagram with no reply, so a Companion that is switched
   * off, on a stale address, or missing the variable is indistinguishable
   * from one that did as it was told.
   *
   * OSC earns its place where the show LAN already carries it — the routing,
   * the VLAN and the firewall holes are somebody else's solved problem — or
   * where a rig sends OSC to everything on principle and would rather not
   * make an exception. Companion accepts both at once, so this is a choice
   * about the wire and not about what the dashboard can do.
   */
  commandTransport: z
    .enum(['http', 'osc'])
    .default('http')
    .describe(
      'How button presses and variable writes are sent. HTTP reports whether each one worked; ' +
        'OSC is fire-and-forget with no reply at all. Variables are always read over HTTP, so ' +
        "Companion's HTTP API must stay enabled either way.",
    ),
  /**
   * Companion's OSC listen port, which is a separate setting from its HTTP
   * one and a separate tick-box: Settings → Protocols → OSC, off by default.
   */
  oscPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(12321)
    .describe(
      "Companion's OSC listen port, from its Settings → Protocols page. Only used when the " +
        'transport above is OSC, and OSC must be enabled there — it is off in a fresh install.',
    ),
})

export type CompanionConfig = z.infer<typeof companionConfigSchema>

const buttonPressInput = z.object({
  page: z.number().int().min(1).max(999),
  // Companion 3 grids grow in any direction, so the top-left of a surface is
  // not always 0,0 and a negative row or column is a perfectly normal button.
  row: z.number().int().min(-64).max(64),
  column: z.number().int().min(-64).max(64),
})

const variableSetInput = z.object({
  // The name goes straight into a URL path segment. Anything that could climb
  // out of it is refused here rather than encoded and hoped for.
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, underscore and hyphen only'),
  value: z.string().max(2_000),
})

/** One exchange's deadline. Longer than any healthy Companion, shorter than a show cue. */
const REQUEST_TIMEOUT_MS = 4_000

/**
 * A custom variable nobody will ever create. Companion has no health route,
 * and an instance with no variables configured still has to answer "is
 * Companion up?" — a 404 from this path proves the API is listening just as
 * well as a 200 would, and costs a few bytes.
 */
const REACHABILITY_PROBE_PATH = '/api/custom-variable/__stageit_probe__/value'

interface HttpReply {
  status: number
  ok: boolean
  body: string
}

/**
 * Reads Companion variables and presses Companion buttons over its HTTP API.
 *
 * Companion pushes variable changes to its own surfaces but not over HTTP, so
 * this polls. Every configured variable is fetched per tick and published as
 * one frame: a widget bound to a Companion value should update with all the
 * others, not arrive in a dribble of single-key updates.
 */
class CompanionConnector implements Connector<CompanionConfig> {
  private ctx: ConnectorContext<CompanionConfig> | null = null
  private cancelPoll: (() => void) | null = null
  private polling = false
  private lastConnectionSignature: string | null = null

  /** Opened on the first OSC command and kept, so a cue is one send. */
  private osc: Socket | null = null

  /**
   * Custom variables this Companion has been confirmed to actually have.
   *
   * Only consulted on the OSC path, and it is the difference between OSC
   * being usable and being a trap. Writing a variable nobody created fails
   * silently at the Companion end — its OSC handler discards the very error
   * the HTTP handler turns into a 404 — so the name is checked once over
   * HTTP and remembered. One GET per variable per connection, against a
   * failure mode whose symptom is a key that never lights and no message
   * anywhere on either machine.
   */
  private readonly confirmedVariables = new Set<string>()

  async start(ctx: ConnectorContext<CompanionConfig>): Promise<void> {
    this.ctx = ctx
    this.cancelPoll = ctx.setInterval(() => void this.poll(), ctx.config.pollIntervalMs)
    // Awaited so a typo'd host reports offline immediately instead of sitting
    // in `connecting` until the first interval fires.
    await this.poll()
  }

  stop(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
    this.ctx = null
    this.confirmedVariables.clear()
    // Closing throws if the socket never bound; there is nothing to salvage
    // either way and a connector's stop must not be the thing that fails.
    try {
      this.osc?.close()
    } catch {
      /* already closed */
    }
    this.osc = null
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not connected')

    switch (commandId) {
      case 'button.press': {
        const parsed = buttonPressInput.safeParse(input)
        if (!parsed.success)
          return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')

        const { page, row, column } = parsed.data
        if (ctx.config.commandTransport === 'osc') {
          return this.sendOsc(ctx, oscButtonPress(page, row, column))
        }
        return this.post(ctx, `/api/location/${page}/${row}/${column}/press`)
      }
      case 'variable.set': {
        const parsed = variableSetInput.safeParse(input)
        if (!parsed.success)
          return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')

        const { name, value } = parsed.data
        if (ctx.config.commandTransport === 'osc') {
          const known = await this.confirmVariable(ctx, name)
          if (!known.ok) return known.result
          return this.sendOsc(ctx, oscVariableSet(name, value))
        }
        const path = `/api/custom-variable/${encodeURIComponent(name)}/value?value=${encodeURIComponent(value)}`
        return this.post(ctx, path)
      }
      default:
        return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
    }
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted) return

    // A Companion gone slow must not accumulate a tick per second until the
    // event loop is nothing but stale requests.
    if (this.polling) return
    this.polling = true

    try {
      const entries = ctx.config.variables
      if (entries.length === 0) {
        await this.pollWithoutVariables(ctx)
        return
      }

      const settled = await Promise.allSettled(
        entries.map((entry) => this.readVariable(ctx, entry)),
      )
      if (ctx.signal.aborted) return

      // Only a transport failure on *every* request means the machine is gone.
      // One request failing while others answer is a variable problem, and
      // variable problems never take an instance offline.
      if (settled.every((result) => result.status === 'rejected')) {
        const reason = settled[0]?.status === 'rejected' ? settled[0].reason : 'unreachable'
        this.publishConnection(ctx, false, entries.length, entries.length)
        ctx.fail(reason, 'Companion is not answering')
        return
      }

      const values: Record<string, string | number | null> = {}
      let failedCount = 0

      settled.forEach((result, index) => {
        const key = entries[index] as string
        const value = result.status === 'fulfilled' ? result.value : null
        // A key that reads back null is a variable Companion does not have —
        // usually a renamed connection. Dropping the key instead would leave
        // the widget showing its last good value indefinitely, and an operator
        // cannot tell a stale number from a live one.
        values[key] = value
        if (value === null) failedCount += 1
      })

      ctx.setStatus('online')
      ctx.publish('variables', { values })
      this.publishConnection(ctx, true, entries.length, failedCount)
    } catch (error) {
      ctx.fail(error, 'poll failed')
    } finally {
      this.polling = false
    }
  }

  private async pollWithoutVariables(ctx: ConnectorContext<CompanionConfig>): Promise<void> {
    try {
      await this.request(ctx, 'GET', REACHABILITY_PROBE_PATH)
      if (ctx.signal.aborted) return

      ctx.setStatus('online')
      ctx.publish('variables', { values: {} })
      this.publishConnection(ctx, true, 0, 0)
    } catch (error) {
      this.publishConnection(ctx, false, 0, 0)
      ctx.fail(error, 'Companion is not answering')
    }
  }

  /** Resolves to null when the variable could not be read; rejects when Companion could not. */
  private async readVariable(
    ctx: ConnectorContext<CompanionConfig>,
    entry: string,
  ): Promise<string | number | null> {
    const ref = parseVariableRef(entry)
    // The config schema rejects unparseable entries, but a config written
    // before that check existed must still not take the instance down.
    if (!ref) return null

    const reply = await this.request(ctx, 'GET', variableValuePath(ref))
    if (!reply.ok) {
      // The everyday case is a 404: someone renamed a connection in Companion
      // and the dashboard is still asking for the old label.
      ctx.logger.debug({ entry, status: reply.status }, 'companion variable read failed')
      return null
    }
    return coerceVariableValue(reply.body)
  }

  /**
   * Refuses to send an OSC write for a variable Companion does not have.
   *
   * The check is a plain HTTP read of the same variable: 404 means nobody
   * created it, and the operator needs telling now rather than at 19:45 when
   * a key stays dark. Cached on success — a custom variable does not stop
   * existing while a connection is up, and paying a round trip per cue would
   * undo the reason for choosing OSC in the first place.
   *
   * A failure to *reach* Companion is reported as itself rather than as a
   * missing variable: the bridge treats `NOT_CONNECTED` as worth retrying
   * when the instance comes back, and would drop a wrong answer for good.
   */
  private async confirmVariable(
    ctx: ConnectorContext<CompanionConfig>,
    name: string,
  ): Promise<{ ok: true } | { ok: false; result: CommandResult }> {
    if (this.confirmedVariables.has(name)) return { ok: true }

    let reply: HttpReply
    try {
      reply = await this.request(
        ctx,
        'GET',
        `/api/custom-variable/${encodeURIComponent(name)}/value`,
      )
    } catch (error) {
      return {
        ok: false,
        result: commandFail(
          'NOT_CONNECTED',
          error instanceof Error ? error.message : String(error),
        ),
      }
    }

    if (!reply.ok) {
      return {
        ok: false,
        result: commandFail(
          'DEVICE_ERROR',
          `Companion has no custom variable "${name}" — create it under Variables → Custom ` +
            'Variables. Over OSC it would have accepted the write and done nothing.',
        ),
      }
    }

    this.confirmedVariables.add(name)
    return { ok: true }
  }

  /**
   * One datagram, and the honest limit of what that can promise.
   *
   * `commandOk()` here means the packet left this machine. It does not mean
   * Companion is running, listening on that port, has OSC enabled, or did
   * anything with it — UDP has no acknowledgement and Companion sends no
   * reply. The connector's own poll is what notices a Companion that has
   * gone, and the mic cue bridge rewrites everything when it comes back;
   * between the two, a lost datagram costs one stale key colour for as long
   * as the instance is offline, which is the trade OSC asks you to make.
   *
   * The send callback still catches the local failures worth catching: an
   * unresolvable host, a socket that could not be created, a datagram too
   * large for the path.
   */
  private sendOsc(
    ctx: ConnectorContext<CompanionConfig>,
    datagram: Buffer,
  ): Promise<CommandResult> {
    let socket: Socket
    try {
      socket = this.oscSocket(ctx)
    } catch (error) {
      return Promise.resolve(
        commandFail('NOT_CONNECTED', error instanceof Error ? error.message : String(error)),
      )
    }

    return new Promise((resolve) => {
      socket.send(datagram, ctx.config.oscPort, ctx.config.host, (error) => {
        if (error) {
          ctx.logger.debug({ err: error }, 'OSC send failed')
          resolve(commandFail('NOT_CONNECTED', error.message))
          return
        }
        resolve(commandOk())
      })
    })
  }

  /** Bound lazily and reused; an unbound socket binds itself on first send. */
  private oscSocket(ctx: ConnectorContext<CompanionConfig>): Socket {
    if (this.osc) return this.osc
    const socket = createSocket(ctx.config.host.includes(':') ? 'udp6' : 'udp4')
    // Nothing is ever received on this socket, and an error arriving on it —
    // an ICMP port-unreachable from a Companion with OSC switched off — must
    // not become an unhandled 'error' event and take the process down.
    socket.on('error', (error) => ctx.logger.debug({ err: error }, 'OSC socket error'))
    socket.unref()
    this.osc = socket
    return socket
  }

  private async post(ctx: ConnectorContext<CompanionConfig>, path: string): Promise<CommandResult> {
    try {
      const reply = await this.request(ctx, 'POST', path)
      if (!reply.ok) {
        return commandFail('DEVICE_ERROR', `Companion returned ${reply.status}`)
      }
      return commandOk()
    } catch (error) {
      // Reaching Companion *is* the command; if the socket died there is
      // nothing to report but the disconnection.
      return commandFail('NOT_CONNECTED', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * One request/response exchange under a single deadline, body included, so a
   * Companion that accepts the connection and then stalls mid-body cannot hold
   * the poll loop shut.
   */
  private async request(
    ctx: ConnectorContext<CompanionConfig>,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<HttpReply> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(
      () => controller.abort(new Error(`request to ${path} timed out`)),
      REQUEST_TIMEOUT_MS,
    )

    try {
      const response = await fetch(`${baseUrl(ctx.config.host, ctx.config.port)}${path}`, {
        method,
        signal: controller.signal,
        headers: { accept: 'text/plain' },
      })
      // Always drained: an unread body keeps the keep-alive socket busy and the
      // next tick would open another one.
      const body = await response.text()
      return { status: response.status, ok: response.ok, body }
    } finally {
      clearTimeout(deadline)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * `connection` is a change-class stream, and repeating the same three
   * numbers every second is noise on the wire and in the timeline. It only
   * goes out when the picture actually changes — which is exactly the moment
   * an operator needs to see it, e.g. failedCount jumping from 0 to 4 because
   * someone renamed a connection.
   */
  private publishConnection(
    ctx: ConnectorContext<CompanionConfig>,
    ok: boolean,
    variableCount: number,
    failedCount: number,
  ): void {
    const signature = `${ok}:${variableCount}:${failedCount}`
    if (signature === this.lastConnectionSignature) return
    this.lastConnectionSignature = signature
    ctx.publish('connection', { ok, variableCount, failedCount })
  }
}

export const companionModule: ConnectorModule<CompanionConfig> = {
  meta: {
    typeId: 'companion',
    displayName: 'Bitfocus Companion',
    description:
      'Reads variables from a Bitfocus Companion instance and presses its buttons over the ' +
      'official HTTP API. Companion is already wired to most of the rig at a typical venue, so ' +
      'its variables give the dashboard reach far beyond the devices we integrate directly.',
    configSchema: companionConfigSchema,
    streams: [
      { id: 'variables', label: 'Variables', rateClass: 'normal', history: 'none' },
      {
        id: 'connection',
        label: 'Connection health',
        rateClass: 'change',
        fields: [
          { id: 'variableCount', kind: 'number', label: 'Variables' },
          { id: 'failedCount', kind: 'number', label: 'Failed reads' },
          { id: 'ok', kind: 'boolean', label: 'Reachable' },
        ],
      },
    ],
    commands: [
      {
        id: 'button.press',
        label: 'Press button',
        description: 'Presses a button by its page/row/column location, as a surface would.',
        inputSchema: buttonPressInput,
      },
      {
        id: 'variable.set',
        label: 'Set custom variable',
        description: 'Writes a Companion custom variable, for buttons and triggers to react to.',
        inputSchema: variableSetInput,
      },
    ],
    conditions: companionConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'Requires Companion 3.4 or newer for the /api paths (2.x used a different, incompatible ' +
      'HTTP interface). Verified against a real Companion 5.0.3 on 2026-08-16. Companion does ' +
      'not expose button state over HTTP — only variables are readable — so this connector ' +
      'reads variables and presses buttons. If you need a button feedback on the dashboard, ' +
      'have the Companion button write it to a custom variable. The HTTP API must be enabled ' +
      'in Companion under Settings → HTTP; the separate legacy API is not used. ' +
      'IMPORTANT: `variable.set` cannot create a custom variable — the name must already exist ' +
      'under Variables → Custom Variables, or the write is refused with 404 and nothing at the ' +
      'Companion end shows why. ' +
      'Commands can go over OSC instead (Settings → Protocols → OSC, off in a fresh install, ' +
      'port 12321 by default). Verified against the same real Companion 5.0.3 on 2026-08-19: ' +
      'its log reads "Got OSC control press 1/0/0 - bank:…" for a real location and ' +
      '"9/7/7 - null" for an empty one, and a variable set over OSC reads back over HTTP. ' +
      'Variables are still read over HTTP whichever transport is chosen, because OSC here is ' +
      'one-way: Companion never replies, so a press or a write that vanished is ' +
      'indistinguishable from one that worked. On the OSC path this connector ' +
      "checks a custom variable exists over HTTP before writing it, because Companion's OSC " +
      'handler discards the "Unknown name" error its HTTP handler returns as a 404 — the write ' +
      'would otherwise be swallowed in silence. Confirmed by experiment rather than only from ' +
      'its source: an OSC write to an undeclared name leaves it still 404 with nothing logged ' +
      'at any level, while the same datagram lands on a declared one.',
  },
  create: () => new CompanionConnector(),
  createSimulator: () => new CompanionSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    host: address.host,
    port: address.port,
    // The simulator binds UDP on its own ephemeral port, as a real Companion
    // uses a different port for OSC than for HTTP. Falling back to the
    // configured default keeps a simulator that has no OSC side working.
    oscPort: address.ports?.osc ?? base.oscPort,
  }),
}
