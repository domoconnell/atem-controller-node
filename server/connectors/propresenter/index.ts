import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { propresenterConditions } from './conditions.js'
import { parseSlide, parseStageMessage, parseSystemTime, parseTimers } from './protocol.js'
import { ProPresenterSimulator } from './simulator.js'

export const propresenterConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(50_000),
  /** Only needed if the operator ticked "Network Password" in ProPresenter. */
  password: z.string().optional(),
  /**
   * ProPresenter has no push API, so all of this is polling. 1 Hz is what a
   * countdown on a stage display needs; anything faster mostly costs the show
   * Mac CPU it would rather spend on video playback.
   */
  pollIntervalMs: z.number().int().min(250).max(60_000).default(1_000),
})

export type ProPresenterConfig = z.infer<typeof propresenterConfigSchema>

const timerInput = z.object({
  uuid: z.string().min(1),
})

const TIMERS_PATH = '/v1/timers/current'
const SYSTEM_TIME_PATH = '/v1/timer/system_time'
const SLIDE_PATH = '/v1/status/slide'
const STAGE_MESSAGE_PATH = '/v1/stage/message'

/** ProPresenter models these as reads, hence GET for what are plainly writes. */
const TIMER_ACTIONS: Record<string, string | undefined> = {
  'timer.start': 'start',
  'timer.stop': 'stop',
  'timer.reset': 'reset',
}

/**
 * The outcome of one HTTP read, separated from "did it work" because the three
 * unhappy answers need three different reactions: a version that has never
 * heard of an endpoint, a body we could not read, and a device we could not
 * reach are very different problems for the crew staring at the dashboard.
 */
type Outcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'error'; error: Error }

/**
 * ProPresenter 7 over its documented REST API. It is the source of the show
 * timers a stage manager runs the day from, so the guiding rule here is that
 * one sulking endpoint must never cost us the timers: only `/v1/timers/current`
 * can take the instance offline.
 */
class ProPresenterConnector implements Connector<ProPresenterConfig> {
  private ctx: ConnectorContext<ProPresenterConfig> | null = null
  private cancelPoll: (() => void) | null = null
  private polling = false
  private online = false

  /** Last published values, so `change`-class streams only publish on change. */
  private lastSlide: string | null = null
  private lastStageMessage: string | null = null

  start(ctx: ConnectorContext<ProPresenterConfig>): void {
    this.ctx = ctx

    // Poll once immediately: an admin who just saved the form deserves to know
    // within a second whether the address was right, not after a full interval.
    void this.poll()
    this.cancelPoll = ctx.setInterval(() => void this.poll(), ctx.config.pollIntervalMs)
  }

  stop(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
    this.ctx = null
  }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    if (!this.ctx) return commandFail('NOT_CONNECTED', 'Not connected')

    const action = TIMER_ACTIONS[commandId]
    if (!action) return commandFail('NOT_FOUND', `Unknown command ${commandId}`)

    const parsed = timerInput.safeParse(input)
    if (!parsed.success)
      return commandFail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'bad input')

    const outcome = await this.get(`/v1/timer/${encodeURIComponent(parsed.data.uuid)}/${action}`)
    switch (outcome.kind) {
      case 'ok':
      case 'unreadable':
        // The acknowledgement is the 2xx; ProPresenter sends no useful body.
        return commandOk()
      case 'absent':
        return commandFail('DEVICE_ERROR', `No timer with uuid ${parsed.data.uuid}`)
      case 'error':
        return commandFail('DEVICE_ERROR', outcome.error.message)
    }
  }

  private async poll(): Promise<void> {
    // ProPresenter is a single-threaded macOS app also driving video output, so
    // the endpoints go one at a time and a slow answer skips the next tick
    // rather than stacking a second round of requests behind it.
    if (!this.ctx || this.polling) return
    this.polling = true
    try {
      if (!(await this.pollTimers())) return
      await this.pollSystemTime()
      await this.pollSlide()
      await this.pollStageMessage()
    } finally {
      this.polling = false
    }
  }

  /** Returns false when the instance is on its way offline. */
  private async pollTimers(): Promise<boolean> {
    const ctx = this.ctx
    if (!ctx) return false

    const outcome = await this.get(TIMERS_PATH)
    switch (outcome.kind) {
      case 'error':
        ctx.fail(outcome.error)
        return false
      case 'absent':
        // Not a missing feature: every supported version serves this. A 404
        // here means we are pointed at something that is not ProPresenter.
        ctx.fail(new Error(`${TIMERS_PATH} not found — is this ProPresenter's network port?`))
        return false
      case 'unreadable':
        ctx.logger.debug({ path: TIMERS_PATH }, 'ignoring unparsable body')
        break
      case 'ok':
        ctx.publish('timers', { timers: parseTimers(outcome.body) })
        break
    }

    if (!this.online) {
      this.online = true
      ctx.setStatus('online')
    }
    return true
  }

  private async pollSystemTime(): Promise<void> {
    const result = await this.pollOptional(SYSTEM_TIME_PATH)
    if (result === null) return

    const time = parseSystemTime(result.body)
    if (time === null) return
    this.ctx?.publish('systemTime', { time })
  }

  private async pollSlide(): Promise<void> {
    const result = await this.pollOptional(SLIDE_PATH)
    if (result === null) return

    const slide = parseSlide(result.body)
    // This stream is recorded as events. Republishing an unchanged slide once
    // a second would bury the timeline a show report gets written from.
    const key = JSON.stringify(slide)
    if (key === this.lastSlide) return
    this.lastSlide = key
    this.ctx?.publish('slide', slide)
  }

  private async pollStageMessage(): Promise<void> {
    const result = await this.pollOptional(STAGE_MESSAGE_PATH)
    if (result === null) return

    const message = parseStageMessage(result.body)
    if (message === this.lastStageMessage) return
    this.lastStageMessage = message
    this.ctx?.publish('stageMessage', { message })
  }

  /**
   * Reads an endpoint whose troubles must not reach the crew. Stage displays
   * are licence- and version-dependent, and losing a stage message is no
   * reason to hide the timers someone is running the stage by.
   */
  private async pollOptional(path: string): Promise<{ body: unknown } | null> {
    const ctx = this.ctx
    if (!ctx) return null

    const outcome = await this.get(path)
    switch (outcome.kind) {
      case 'ok':
        return { body: outcome.body }
      case 'absent':
        ctx.logger.debug({ path }, 'endpoint not served by this ProPresenter')
        return null
      case 'unreadable':
        ctx.logger.debug({ path }, 'ignoring unparsable body')
        return null
      case 'error':
        ctx.logger.debug({ path, err: outcome.error.message }, 'optional endpoint failed')
        return null
    }
  }

  private async get(path: string): Promise<Outcome> {
    const ctx = this.ctx
    if (!ctx) return { kind: 'error', error: new Error('connector stopped') }

    const { host, port, password, pollIntervalMs } = ctx.config
    // A request must not outlive its tick by much, or a wedged show Mac leaves
    // us reporting "online" over numbers that stopped being true minutes ago.
    const timeoutMs = Math.max(2_000, pollIntervalMs)

    try {
      const response = await fetch(`http://${host}:${port}${path}`, {
        headers: password ? { Authorization: password } : undefined,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      })

      if (response.status === 404) return { kind: 'absent' }
      if (!response.ok) {
        return { kind: 'error', error: new Error(`${path} returned HTTP ${response.status}`) }
      }

      const text = await response.text()
      // Several endpoints answer 200 with nothing at all when there is nothing
      // to report, which is not the same as answering with `null`.
      if (text.trim().length === 0) return { kind: 'ok', body: null }

      try {
        return { kind: 'ok', body: JSON.parse(text) as unknown }
      } catch {
        return { kind: 'unreadable' }
      }
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }
    }
  }
}

export const propresenterModule: ConnectorModule<ProPresenterConfig> = {
  meta: {
    typeId: 'propresenter',
    displayName: 'ProPresenter',
    description:
      'ProPresenter 7 over its documented REST API. Publishes the show timers a stage manager ' +
      'runs the day from, the clock those timers are counted against, the current and next ' +
      'slide, and the stage message — and lets an operator start, stop or reset a timer from ' +
      'the dashboard without walking to the presentation position.',
    configSchema: propresenterConfigSchema,
    streams: [
      { id: 'timers', label: 'Show timers', rateClass: 'normal', history: 'none' },
      {
        id: 'systemTime',
        label: 'System time',
        rateClass: 'normal',
        fields: [{ id: 'time', kind: 'string', label: 'System time' }],
      },
      {
        id: 'slide',
        label: 'Current slide',
        rateClass: 'change',
        history: 'events',
        fields: [
          { id: 'current', kind: 'string', label: 'Current slide' },
          { id: 'next', kind: 'string', label: 'Next slide' },
        ],
      },
      {
        id: 'stageMessage',
        label: 'Stage message',
        rateClass: 'change',
        fields: [{ id: 'message', kind: 'string', label: 'Stage message' }],
      },
    ],
    commands: [
      {
        id: 'timer.start',
        label: 'Start timer',
        description: 'Starts a timer by its uuid, as published on the timers stream.',
        inputSchema: timerInput,
      },
      {
        id: 'timer.stop',
        label: 'Stop timer',
        description: 'Stops a timer by its uuid, as published on the timers stream.',
        inputSchema: timerInput,
      },
      {
        id: 'timer.reset',
        label: 'Reset timer',
        description: 'Returns a timer to its configured duration and stops it.',
        inputSchema: timerInput,
      },
    ],
    conditions: propresenterConditions,
    capabilities: { control: true },
    tier: 'official',
    vendorNotes:
      'In ProPresenter open Settings → Network, tick the network option, and note the port it ' +
      'shows (50000 by default) — the API answers nothing until that box is ticked, and the ' +
      'port is per-machine. If a network password is set there, put the same value in the ' +
      'password field here. The stage-display endpoints are absent on some versions and ' +
      'licences; when that happens those streams stay silent and the timers keep working.',
  },
  create: () => new ProPresenterConnector(),
  createSimulator: () => new ProPresenterSimulator(),
  simulatedConfig: (address, base) => ({ ...base, host: address.host, port: address.port }),
}
