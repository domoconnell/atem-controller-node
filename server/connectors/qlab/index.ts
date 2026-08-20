import { Socket } from 'node:net'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import {
  decodeOscMessage,
  encodeOscMessage,
  type OscArg,
  SlipDecoder,
  slipEncode,
} from '../../lib/osc.js'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { qlabConditions } from './conditions.js'
import {
  asNumber,
  flattenCues,
  parseCueListIds,
  parseReplyBody,
  parseRunningCueStubs,
  parseWorkspaces,
  QLAB_BAD_PASSCODE_STATUSES,
  type QLabReply,
  ReplyCorrelator,
} from './protocol.js'
import { QLabSimulator } from './simulator.js'

export const qlabConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(53000),
  /** View-level is enough to watch; firing cues needs a control-level passcode. */
  passcode: z.string().optional(),
  /** Blank means "whichever workspace QLab has open", which is the usual case. */
  workspaceId: z.string().optional(),
  pollIntervalMs: z.number().int().min(200).max(60_000).default(500),
})

export type QLabConfig = z.infer<typeof qlabConfigSchema>

/** go/stop/pause/resume/panic take no arguments; the workspace is the target. */
const noInput = z.object({})

const CONNECT_TIMEOUT_MS = 5_000
const QUERY_TIMEOUT_MS = 3_000
/** A workspace with thousands of cues takes its time serialising the tree. */
const CUE_QUERY_TIMEOUT_MS = 10_000
/**
 * QLab pushes when the cue list changes, but a designer editing during a
 * changeover is exactly when we least want a missed push to leave a stale list
 * on the wall — so re-read it occasionally. Far slower than `pollIntervalMs`
 * on purpose: this is the one query whose cost grows with the size of the show.
 */
const CUE_REFRESH_INTERVAL_MS = 30_000

const PLAYBACK_POSITION_UPDATE =
  /^\/update\/workspace\/([^/]+)\/cueList\/([^/]+)\/playbackPosition$/
const CUE_LISTS_UPDATE = /^\/update\/workspace\/([^/]+)\/cueLists$/

const WORKSPACE_COMMANDS: Record<string, string> = {
  go: 'go',
  stop: 'stop',
  pause: 'pause',
  resume: 'resume',
  panic: 'panic',
}

/**
 * QLab over its documented OSC API (TCP 53000, SLIP-framed).
 *
 * The shape of the integration is dictated by one number: a festival show file
 * can hold thousands of cues. So the cue list is read rarely, the playhead
 * rides on QLab's own pushed updates, and per-cue timing queries are only ever
 * issued for the handful of cues actually running.
 */
class QLabConnector implements Connector<QLabConfig> {
  private socket: Socket | null = null
  private ctx: ConnectorContext<QLabConfig> | null = null
  private readonly decoder = new SlipDecoder()
  private readonly replies = new ReplyCorrelator()

  private workspaceId: string | null = null
  private cueListIds: string[] = []
  /** Cue names by id, so playhead updates cost no extra round trip. */
  private cueNames = new Map<string, string>()
  private runningPollInFlight = false

  async start(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    this.ctx = ctx
    await this.openSocket(ctx)

    // openSocket resolves on failure too, having already reported it; there is
    // nothing to hand shake with and the supervisor is already reconnecting.
    if (!this.socket || this.socket.destroyed) return

    await this.handshake(ctx)
  }

  stop(): void {
    this.replies.rejectAll(new Error('Connector stopped'))

    const socket = this.socket
    this.socket = null
    // A socket can still emit an error while being torn down (a reset
    // arriving as we close). Node throws on an unhandled 'error' event, so a
    // swallowing listener goes back on before we destroy it.
    socket?.removeAllListeners()
    socket?.on('error', () => {})
    socket?.destroy()

    this.workspaceId = null
    this.cueListIds = []
    this.cueNames.clear()
    this.decoder.reset()
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const suffix = WORKSPACE_COMMANDS[commandId]
    if (!suffix) return commandFail('NOT_FOUND', `Unknown command ${commandId}`)

    const parsed = noInput.safeParse(input ?? {})
    if (!parsed.success) {
      return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')
    }

    const workspaceId = this.workspaceId
    if (!workspaceId || !this.socket || this.socket.destroyed) {
      return commandFail('NOT_CONNECTED', 'Not connected to a QLab workspace')
    }

    try {
      const reply = await this.query(`/workspace/${workspaceId}/${suffix}`)
      if (isBadPasscode(reply)) {
        return commandFail(
          'DEVICE_ERROR',
          'QLab refused the command: firing cues needs a control-level passcode',
        )
      }
      if (reply.status !== 'ok') {
        return commandFail('DEVICE_ERROR', `QLab answered "${reply.status}" to ${commandId}`)
      }
      return commandOk()
    } catch (error) {
      if (!this.socket || this.socket.destroyed) {
        return commandFail('NOT_CONNECTED', 'Connection to QLab was lost')
      }
      return commandFail('TIMEOUT', (error as Error).message)
    }
  }

  // ------------------------------------------------------------------ connection

  private openSocket(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    const { host, port } = ctx.config

    return new Promise<void>((resolve) => {
      const socket = new Socket()
      this.socket = socket
      socket.setNoDelay(true)

      // Without this, an unreachable host sits in SYN_SENT for ~75 seconds and
      // the dashboard shows "connecting" long after the truth is knowable.
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (socket.connecting) ctx.fail(new Error('connect timed out'))
      })

      socket.on('connect', () => {
        socket.setTimeout(0)
        this.decoder.reset()
        resolve()
      })

      socket.on('data', (chunk: Buffer) => {
        for (const packet of this.decoder.push(chunk)) this.handlePacket(packet)
      })

      socket.on('error', (error) => {
        this.replies.rejectAll(error)
        ctx.fail(error)
        resolve()
      })

      socket.on('close', () => {
        // In-flight queries have to fail now rather than sit on their timeout,
        // or a command issued as the network dies answers three seconds late.
        this.replies.rejectAll(new Error('connection closed by QLab'))
        ctx.fail(new Error('connection closed by QLab'))
        resolve()
      })

      ctx.signal.addEventListener('abort', () => socket.destroy(), { once: true })

      socket.connect(port, host)
    })
  }

  private async handshake(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    const workspaces = parseWorkspaces(assertOk(await this.query('/workspaces'), 'workspaces').data)
    if (workspaces.length === 0) throw new Error('QLab has no open workspace')

    const wanted = ctx.config.workspaceId?.trim()
    const workspace = wanted ? workspaces.find((w) => w.id === wanted) : workspaces[0]
    if (!workspace) {
      throw new Error(`QLab has no open workspace with id ${wanted}`)
    }
    this.workspaceId = workspace.id
    ctx.logger.info(
      { workspaceId: workspace.id, workspace: workspace.displayName, version: workspace.version },
      'selected QLab workspace',
    )

    const passcode = ctx.config.passcode?.trim()
    if (passcode) {
      const reply = await this.query(`/workspace/${workspace.id}/connect`, [
        { type: 's', value: passcode },
      ])
      // Some builds answer `{"status":"badpass"}`, others `{"status":"ok",
      // "data":"badpass"}`; both mean the same thing to the operator.
      assertOk(reply, 'workspace connect')
    }

    // Pushed updates are what keeps the playhead honest without polling a
    // show file that may hold thousands of cues.
    assertOk(
      await this.query(`/workspace/${workspace.id}/updates`, [{ type: 'i', value: 1 }]),
      'enable updates',
    )

    ctx.setStatus('online')

    await this.refreshCues(ctx)
    await this.publishPlayheadFromDevice(ctx)

    ctx.setInterval(() => void this.pollRunning(ctx), ctx.config.pollIntervalMs)
    ctx.setInterval(() => void this.refreshCues(ctx).catch(() => {}), CUE_REFRESH_INTERVAL_MS)
  }

  // ------------------------------------------------------------------ queries

  private query(
    address: string,
    args: OscArg[] = [],
    timeoutMs = QUERY_TIMEOUT_MS,
  ): Promise<QLabReply> {
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('not connected to QLab')

    // Registered before the write so a reply can never arrive unclaimed.
    const reply = this.replies.expect(`/reply${address}`, timeoutMs)
    socket.write(slipEncode(encodeOscMessage(address, args)))
    return reply
  }

  private async refreshCues(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return

    const reply = await this.query(
      `/workspace/${workspaceId}/cueLists/shallow`,
      [],
      CUE_QUERY_TIMEOUT_MS,
    )
    if (reply.status !== 'ok') {
      ctx.logger.debug({ status: reply.status }, 'QLab refused the cue list')
      return
    }

    const cues = flattenCues(reply.data)
    this.cueListIds = parseCueListIds(reply.data)
    this.cueNames = new Map(cues.map((cue) => [cue.id, cue.name]))
    ctx.publish('cues', { cues })
  }

  /** Reads the playhead of the primary cue list, for the picture on connect. */
  private async publishPlayheadFromDevice(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    const workspaceId = this.workspaceId
    const cueListId = this.cueListIds[0]
    if (!workspaceId || !cueListId) return

    try {
      const reply = await this.query(`/workspace/${workspaceId}/cueList/${cueListId}/playheadId`)
      await this.publishPlayhead(ctx, typeof reply.data === 'string' ? reply.data : null)
    } catch (error) {
      // A silent playhead is a missing widget, not a dead instance.
      ctx.logger.debug({ err: error }, 'could not read the QLab playhead')
    }
  }

  private async publishPlayhead(
    ctx: ConnectorContext<QLabConfig>,
    cueId: string | null,
  ): Promise<void> {
    if (!cueId) {
      ctx.publish('playhead', { cueId: null, name: null })
      return
    }

    let name = this.cueNames.get(cueId) ?? null
    if (name === null) {
      // The playhead reached a cue added since our last cue-list read.
      name = await this.queryCueName(cueId)
      if (name !== null) this.cueNames.set(cueId, name)
    }

    ctx.publish('playhead', { cueId, name })
  }

  private async queryCueName(cueId: string): Promise<string | null> {
    try {
      const reply = await this.query(`/cue_id/${cueId}/name`)
      return typeof reply.data === 'string' ? reply.data : null
    } catch {
      return null
    }
  }

  private async pollRunning(ctx: ConnectorContext<QLabConfig>): Promise<void> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return
    // A QLab busy loading a 4K video answers slowly; stacking polls on top of
    // that turns one slow reply into a queue that never drains.
    if (this.runningPollInFlight) return
    this.runningPollInFlight = true

    try {
      const reply = await this.query(`/workspace/${workspaceId}/runningOrPausedCues`)
      if (reply.status !== 'ok') return

      const stubs = parseRunningCueStubs(reply.data)
      const cues = await Promise.all(
        stubs.map(async (stub) => {
          const [elapsedReply, percentReply] = await Promise.all([
            this.query(`/cue_id/${stub.id}/actionElapsed`),
            this.query(`/cue_id/${stub.id}/percentActionElapsed`),
          ])

          const elapsed = Math.max(0, asNumber(elapsedReply.data) ?? 0)
          const percent = normalisePercent(asNumber(percentReply.data))
          return {
            id: stub.id,
            name: stub.name || this.cueNames.get(stub.id) || '',
            elapsed: round(elapsed, 1),
            // Duration is not asked for separately: with elapsed and percent
            // the remaining time is arithmetic, and that is one fewer query
            // per running cue per poll.
            remaining: percent > 0 ? round(elapsed / percent - elapsed, 1) : 0,
            percent: round(percent, 3),
          }
        }),
      )

      ctx.publish('running', { cues })
    } catch (error) {
      // The socket handlers own connection health. A poll that times out on a
      // busy QLab is a missed frame, not an outage.
      ctx.logger.debug({ err: error }, 'running-cue poll failed')
    } finally {
      this.runningPollInFlight = false
    }
  }

  // ------------------------------------------------------------------ inbound

  private handlePacket(packet: Buffer): void {
    const ctx = this.ctx
    if (!ctx) return

    const message = decodeOscMessage(packet)
    if (!message) {
      // Malformed input from a device is a fact of life, not an outage.
      ctx.logger.debug({ bytes: packet.length }, 'ignoring undecodable OSC packet')
      return
    }

    if (message.address.startsWith('/reply/')) {
      this.handleReply(ctx, message.address, message.args)
      return
    }
    if (message.address.startsWith('/update/')) {
      void this.handleUpdate(ctx, message.address, message.args)
      return
    }
    // Anything else is ignored on purpose: QLab gains addresses between point
    // releases and that must never take an instance offline.
  }

  private handleReply(
    ctx: ConnectorContext<QLabConfig>,
    address: string,
    args: readonly OscArg[],
  ): void {
    const json = firstString(args)
    if (json === null) return

    const body = parseReplyBody(json)
    if (!body) {
      ctx.logger.debug({ address }, 'ignoring QLab reply that was not JSON')
      return
    }

    if (this.replies.settle(address, body)) return
    // QLab echoes the address it acted on inside the body, without the
    // workspace prefix. Builds that reply on the short address are answered
    // here rather than left to time out.
    if (body.address && this.replies.settle(`/reply${body.address}`, body)) return

    ctx.logger.debug({ address }, 'unsolicited QLab reply')
  }

  private async handleUpdate(
    ctx: ConnectorContext<QLabConfig>,
    address: string,
    args: readonly OscArg[],
  ): Promise<void> {
    const playback = PLAYBACK_POSITION_UPDATE.exec(address)
    if (playback) {
      // A QLab with two workspaces open pushes for both; mixing them would put
      // another show's cue on this instance's playhead.
      if (playback[1] !== this.workspaceId) return

      const pushed = firstString(args)
      try {
        // QLab 5 sends the new position with the push. QLab 4 sends nothing
        // and expects a follow-up query, so fall back to asking.
        if (pushed !== null) await this.publishPlayhead(ctx, pushed || null)
        else await this.publishPlayheadFromDevice(ctx)
      } catch (error) {
        ctx.logger.debug({ err: error }, 'could not follow the QLab playhead')
      }
      return
    }

    const cueLists = CUE_LISTS_UPDATE.exec(address)
    if (cueLists && cueLists[1] === this.workspaceId) {
      // Someone edited the show file: re-read rather than wait for the timer.
      await this.refreshCues(ctx).catch((error: unknown) => {
        ctx.logger.debug({ err: error }, 'cue list refresh failed')
      })
    }
  }
}

function firstString(args: readonly OscArg[]): string | null {
  for (const arg of args) if (arg.type === 's') return arg.value
  return null
}

function isBadPasscode(reply: QLabReply): boolean {
  const statuses: readonly string[] = QLAB_BAD_PASSCODE_STATUSES
  return (
    statuses.includes(reply.status) ||
    (typeof reply.data === 'string' && statuses.includes(reply.data))
  )
}

/**
 * A rejected passcode is a configuration mistake, not a network fault, so it
 * has to read as one. The supervisor still reconnects on a widening backoff —
 * a connector cannot mark itself permanently failed — but the message names
 * the cause so nobody spends the interval before doors looking at switches.
 */
function assertOk(reply: QLabReply, what: string): QLabReply {
  if (isBadPasscode(reply)) {
    throw new Error(
      `QLab rejected the passcode (${what}). Monitoring needs the view-level passcode; ` +
        'sending cues needs the control-level one.',
    )
  }
  if (reply.status !== 'ok') {
    throw new Error(`QLab answered "${reply.status}" to ${what}`)
  }
  return reply
}

/**
 * QLab 5 reports 0–1. Values above 1 can only be a build reporting 0–100, and
 * a progress bar that reads 4700% is worse than one that is slightly wrong.
 */
function normalisePercent(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0
  const fraction = value > 1 ? value / 100 : value
  return Math.min(1, fraction)
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export const qlabModule: ConnectorModule<QLabConfig> = {
  meta: {
    typeId: 'qlab',
    displayName: 'QLab',
    description:
      'Figure 53 QLab show playback over its OSC API. Reports the cue list, the playhead and ' +
      'every running cue with elapsed and remaining time, and can drive transport from the ' +
      'dashboard.',
    configSchema: qlabConfigSchema,
    streams: [
      { id: 'cues', label: 'Cue list', rateClass: 'slow', history: 'none' },
      {
        id: 'playhead',
        label: 'Playhead',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'name', kind: 'string', label: 'Cue name' },
          { id: 'cueId', kind: 'string', label: 'Cue id' },
        ],
      },
      { id: 'running', label: 'Running cues', rateClass: 'normal' },
    ],
    commands: [
      {
        id: 'go',
        label: 'Go',
        description: 'Fires the cue at the playhead.',
        inputSchema: noInput,
      },
      { id: 'stop', label: 'Stop', description: 'Stops everything running.', inputSchema: noInput },
      { id: 'pause', label: 'Pause', description: 'Pauses running cues.', inputSchema: noInput },
      {
        id: 'resume',
        label: 'Resume',
        description: 'Resumes paused cues.',
        inputSchema: noInput,
      },
      {
        id: 'panic',
        label: 'Panic',
        description: 'Fades everything out and stops it. Ends the show, audibly.',
        inputSchema: noInput,
        dangerous: true,
      },
    ],
    conditions: qlabConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'QLab 5, over the OSC API Figure 53 document and support. OSC control is available on ' +
      'every licence tier, including the free one — no Pro licence is needed to read cues or ' +
      'fire them. If the workspace has passcodes set, a view-level passcode is enough for ' +
      'monitoring; the go/stop/panic commands need a control-level passcode.',
  },
  create: () => new QLabConnector(),
  createSimulator: () => new QLabSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
