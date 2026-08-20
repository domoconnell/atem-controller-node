import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { reaperConditions } from './conditions.js'
import { baseUrl, parseReaperResponse } from './protocol.js'
import { ReaperSimulator } from './simulator.js'

export const reaperConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  pollIntervalMs: z.number().int().min(250).max(60_000).default(1_000),
  trackLimit: z
    .number()
    .int()
    .min(1)
    .max(512)
    .default(64)
    .describe(
      'How many tracks to report. A 128-track festival session on a wall panel is unreadable, ' +
        'and the count and armed count are always reported for the whole project regardless.',
    ),
})

export type ReaperConfig = z.infer<typeof reaperConfigSchema>

/** The transport commands carry their meaning in the REAPER action id, not in arguments. */
const noInput = z.object({}).default({})

/** REAPER action ids. These have been stable since forever and are safe to hard-code. */
const ACTION_RECORD = 1013
const ACTION_STOP = 1016
const ACTION_PLAY = 1007

/** Where the bundled ReaScript parks the free-space figure. */
const EXT_SECTION = 'StageItLive'
const EXT_KEY = 'disk_free_mb'

/**
 * One request carries the whole poll. REAPER accepts a semicolon-separated
 * command list and answers with one record per line, so the transport, the
 * track list and the disk figure cost a single round trip.
 */
const POLL_PATH = `/_/TRANSPORT;NTRACK;TRACK;GET_EXTSTATE/${EXT_SECTION}/${EXT_KEY}`

const REQUEST_TIMEOUT_MS = 4_000

interface HttpReply {
  status: number
  ok: boolean
  body: string
}

/**
 * Reads the REAPER multitrack rig over its built-in web remote.
 *
 * The question this answers is the one crew actually ask over comms — "are we
 * recording, and how much disk is left?" — so the transport state and the free
 * space are first-class streams rather than something buried in a track list.
 */
class ReaperConnector implements Connector<ReaperConfig> {
  private ctx: ConnectorContext<ReaperConfig> | null = null
  private cancelPoll: (() => void) | null = null
  private polling = false
  /**
   * True once we have seen a record only REAPER produces. Until then, a 200
   * full of something else means we are pointed at the wrong service and
   * should say so, rather than sitting online publishing nothing.
   */
  private established = false

  async start(ctx: ConnectorContext<ReaperConfig>): Promise<void> {
    this.ctx = ctx
    this.cancelPoll = ctx.setInterval(() => void this.poll(), ctx.config.pollIntervalMs)
    // Awaited so a wrong port reports offline immediately instead of sitting
    // in `connecting` until the first interval fires.
    await this.poll()
  }

  stop(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
    this.ctx = null
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not connected')

    const action = ACTIONS[commandId]
    if (action === undefined) return commandFail('NOT_FOUND', `Unknown command ${commandId}`)

    const parsed = noInput.safeParse(input)
    if (!parsed.success)
      return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')

    try {
      const reply = await this.request(ctx, `/_/${action}`)
      if (!reply.ok) return commandFail('DEVICE_ERROR', `REAPER returned ${reply.status}`)
      return commandOk()
    } catch (error) {
      return commandFail('NOT_CONNECTED', error instanceof Error ? error.message : String(error))
    }
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || ctx.signal.aborted) return

    // A REAPER busy writing a render must not accumulate a tick per second
    // until the event loop is nothing but stale requests.
    if (this.polling) return
    this.polling = true

    try {
      const reply = await this.request(ctx, POLL_PATH)
      if (ctx.signal.aborted) return

      if (!reply.ok) {
        // Unlike a missing variable on another device, this is instance-level:
        // the web remote either serves /_/ or it was never switched on.
        ctx.fail(
          new Error(`web remote returned ${reply.status}`),
          'REAPER web interface not answering',
        )
        return
      }

      const poll = parseReaperResponse(reply.body)

      if (poll.transport === null) {
        if (!this.established) {
          ctx.fail(
            new Error('no TRANSPORT record in the reply'),
            'Not a REAPER web interface — check the port and that a "Web browser interface" is enabled',
          )
          return
        }
        // Established connections get the benefit of the doubt: a proxy
        // hiccup or a mid-render stall is not an outage, and the next tick is
        // a second away.
        ctx.logger.debug({ body: reply.body.slice(0, 120) }, 'ignoring unparseable reaper reply')
        return
      }

      this.established = true
      ctx.setStatus('online')

      const armedCount = poll.tracks.filter((track) => track.recordArmed).length

      // Published every tick on purpose: the position is the number FOH stares
      // at, and a per-second trail of "recording at 01:12:33" through a set is
      // precisely the production log this stream exists to leave behind.
      //
      // The armed count rides along because "armed but not rolling" is the
      // quiet disaster this connector exists to catch, and a condition only
      // ever sees one stream's payload.
      ctx.publish('transport', { ...poll.transport, armedCount })

      ctx.publish('tracks', {
        // NTRACK is the project's own answer; the array is only what fits on a
        // panel, so the two must not be derived from each other.
        count: poll.trackCount ?? poll.tracks.length,
        armedCount,
        tracks: poll.tracks.slice(0, ctx.config.trackLimit),
      })

      const freeMb = Number(poll.extState.get(`${EXT_SECTION}/${EXT_KEY}`))
      if (Number.isFinite(freeMb)) {
        ctx.publish('disk', { freeMb })
      }
      // No extstate means the ReaScript is not running. That is a supported
      // setup — the script is optional — so the stream simply stays silent
      // rather than publishing a zero somebody might mistake for a full disk.
    } catch (error) {
      ctx.fail(error, 'poll failed')
    } finally {
      this.polling = false
    }
  }

  /**
   * One request/response exchange under a single deadline, body included, so a
   * REAPER that accepts the connection and then stalls mid-body cannot hold
   * the poll loop shut.
   */
  private async request(ctx: ConnectorContext<ReaperConfig>, path: string): Promise<HttpReply> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(
      () => controller.abort(new Error(`request to ${path} timed out`)),
      REQUEST_TIMEOUT_MS,
    )

    try {
      const response = await fetch(`${baseUrl(ctx.config.host, ctx.config.port)}${path}`, {
        method: 'GET',
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
}

const ACTIONS: Record<string, number> = {
  record: ACTION_RECORD,
  stop: ACTION_STOP,
  play: ACTION_PLAY,
}

export const reaperModule: ConnectorModule<ReaperConfig> = {
  meta: {
    typeId: 'reaper',
    displayName: 'REAPER',
    description:
      'Reads the multitrack recording rig over REAPER’s built-in web remote: transport state, ' +
      'the track list with record-arm and meters, and free space at the record path. Answers ' +
      'the question crew ask over comms — are we recording, and how much disk is left?',
    configSchema: reaperConfigSchema,
    streams: [
      {
        id: 'transport',
        label: 'Transport',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'positionSeconds', kind: 'number', label: 'Position', unit: 's' },
          { id: 'armedCount', kind: 'number', label: 'Armed tracks' },
          { id: 'state', kind: 'string', label: 'Transport' },
          { id: 'positionString', kind: 'string', label: 'Position (timecode)' },
          { id: 'isRepeatOn', kind: 'boolean', label: 'Repeat' },
        ],
      },
      {
        id: 'tracks',
        label: 'Tracks',
        rateClass: 'normal',
        fields: [
          { id: 'count', kind: 'number', label: 'Tracks' },
          { id: 'armedCount', kind: 'number', label: 'Armed tracks' },
        ],
      },
      {
        id: 'disk',
        label: 'Free disk space',
        rateClass: 'slow',
        history: 'metric',
        metricFields: ['freeMb'],
        fields: [{ id: 'freeMb', kind: 'number', label: 'Free space', unit: 'MB' }],
      },
    ],
    commands: [
      {
        id: 'record',
        label: 'Record',
        description: 'Starts recording (REAPER action 1013).',
        inputSchema: noInput,
        dangerous: true,
      },
      {
        id: 'stop',
        label: 'Stop',
        description: 'Stops the transport and closes the recording (REAPER action 1016).',
        inputSchema: noInput,
        dangerous: true,
      },
      {
        id: 'play',
        label: 'Play',
        description: 'Starts playback (REAPER action 1007).',
        inputSchema: noInput,
      },
    ],
    conditions: reaperConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'Enable the web remote in REAPER under Preferences → Control/OSC/web → Add → "Web browser ' +
      'interface", and set its port to match this instance (8080 by default). Bind it to the ' +
      'show network, not just localhost, if the dashboard runs on another machine. Free-disk ' +
      'reporting needs the bundled StageItLive_DiskSpace.lua ReaScript running in REAPER — ' +
      'REAPER’s web API cannot report disk space on its own. Without it the disk stream stays ' +
      'silent and everything else works normally.',
  },
  create: () => new ReaperConnector(),
  createSimulator: () => new ReaperSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
