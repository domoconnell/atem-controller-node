import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Recorder } from '../../../test/connector-harness.js'
import { createFakeModule, type FakeConfig, FakeConnector } from '../../../test/fake-connector.js'
import { Supervisor } from './supervisor.js'
import type { ConnectorModule, InstanceDefinition } from './types.js'

const logger = pino({ level: 'silent' })

function definition(overrides: Partial<InstanceDefinition> = {}): InstanceDefinition {
  return {
    id: 'i1',
    typeId: 'fake',
    name: 'Fake #1',
    config: { host: '10.0.0.5', port: 1234 },
    enabled: true,
    allowControl: true,
    simulate: false,
    ...overrides,
  }
}

function build(
  module: ConnectorModule<FakeConfig>,
  overrides: Partial<InstanceDefinition> = {},
  backoff = { baseMs: 5, capMs: 10, random: () => 1 },
): { supervisor: Supervisor; recorder: Recorder } {
  const recorder = new Recorder()
  const supervisor = new Supervisor({
    definition: definition(overrides),
    module: module as ConnectorModule<unknown>,
    sink: recorder,
    logger,
    backoff,
  })
  return { supervisor, recorder }
}

describe('Supervisor lifecycle', () => {
  beforeEach(() => {
    FakeConnector.instances = []
  })

  afterEach(() => {
    FakeConnector.instances = []
  })

  it('walks configuring → connecting → online', async () => {
    const { supervisor, recorder } = build(createFakeModule())
    expect(supervisor.status.state).toBe('configuring')

    await supervisor.start()

    // 'configuring' is the state it was already in, so no redundant frame is
    // emitted for it — subscribers get the current value on subscribe anyway.
    expect(recorder.states).toEqual(['connecting', 'online'])
    expect(supervisor.status.state).toBe('online')
    await supervisor.stop()
  })

  it('treats a bad config as terminal instead of retrying forever', async () => {
    // Retrying a config error on a timer only fills the log with the same
    // message; a human has to change a setting before anything can improve.
    const module = createFakeModule()
    const { supervisor, recorder } = build(module, { config: { port: 'not-a-number' } })
    await supervisor.start()

    expect(supervisor.status.state).toBe('error')
    expect(supervisor.status.detail).toMatch(/Invalid configuration/)
    expect(FakeConnector.instances).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(recorder.states.filter((s) => s === 'connecting')).toHaveLength(0)
    await supervisor.stop()
  })

  it('reconnects after the connector reports a failure', async () => {
    const module = createFakeModule()
    const { supervisor, recorder } = build(module)
    await supervisor.start()

    const connector = FakeConnector.instances[0]!
    const backOnline = recorder.waitForNextState('online')
    connector.simulateDrop()

    expect(supervisor.status.state).toBe('offline')
    await backOnline
    expect(FakeConnector.instances.length).toBeGreaterThan(1)
    await supervisor.stop()
  })

  it('reconnects when start() throws', async () => {
    const module = createFakeModule({ throwOnStart: new Error('ECONNREFUSED') })
    const { supervisor } = build(module)
    await supervisor.start()

    expect(supervisor.status.state).toBe('offline')
    expect(supervisor.status.lastError).toBe('ECONNREFUSED')

    // It keeps trying rather than giving up on gear that isn't powered yet.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(FakeConnector.instances.length).toBeGreaterThan(1)
    await supervisor.stop()
  })

  it('ignores publishes from a connector that has already been replaced', async () => {
    const module = createFakeModule()
    const { supervisor, recorder } = build(module)
    await supervisor.start()

    const first = FakeConnector.instances[0]!
    const backOnline = recorder.waitForNextState('online')
    first.simulateDrop()
    await backOnline

    recorder.clear()
    // The old connector's socket callback fires late, after teardown.
    first.emit('ticks', { stale: true })
    expect(recorder.frames).toHaveLength(0)

    // ...while the current one is heard normally.
    FakeConnector.instances.at(-1)!.emit('ticks', { fresh: true })
    expect(recorder.payloads('ticks')).toEqual([{ fresh: true }])
    await supervisor.stop()
  })

  it('refuses to let a connector publish the reserved status stream', async () => {
    const { supervisor, recorder } = build(createFakeModule())
    await supervisor.start()
    recorder.clear()

    FakeConnector.instances[0]!.emit('$status', { state: 'online' })
    expect(recorder.frames).toHaveLength(0)
    await supervisor.stop()
  })

  it('reports degraded without clearing the failure history', async () => {
    const { supervisor } = build(createFakeModule({ startDegraded: true }))
    await supervisor.start()
    expect(supervisor.status.state).toBe('degraded')
    await supervisor.stop()
  })

  it('stops even when the connector hangs in stop()', async () => {
    const { supervisor } = build(
      createFakeModule({ hangOnStop: true }),
      {},
      {
        baseMs: 5,
        capMs: 10,
        random: () => 1,
      },
    )
    const withShortTimeout = new Supervisor({
      definition: definition(),
      module: createFakeModule({ hangOnStop: true }) as ConnectorModule<unknown>,
      sink: new Recorder(),
      logger,
      stopTimeoutMs: 50,
    })

    await withShortTimeout.start()
    const startedAt = Date.now()
    await withShortTimeout.stop()

    // Force-disposed rather than blocking shutdown past the compose grace period.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(withShortTimeout.status.state).toBe('stopped')
    await supervisor.stop()
  })

  it('silences timers after stop', async () => {
    const module = createFakeModule({ silentStart: true })
    const recorder = new Recorder()
    const supervisor = new Supervisor({
      definition: definition(),
      module: module as ConnectorModule<unknown>,
      sink: recorder,
      logger,
    })
    await supervisor.start()

    const ctx = FakeConnector.instances[0]!.ctx!
    ctx.setInterval(() => ctx.publish('ticks', { t: Date.now() }), 5)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(recorder.payloads('ticks').length).toBeGreaterThan(0)

    await supervisor.stop()
    recorder.clear()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(recorder.frames).toHaveLength(0)
  })

  it('keeps running when a timer callback throws', async () => {
    // A throwing poll tick is a bug in one connector, not a reason to drop a
    // connection or take down the process.
    const module = createFakeModule({ silentStart: true })
    const recorder = new Recorder()
    const supervisor = new Supervisor({
      definition: definition(),
      module: module as ConnectorModule<unknown>,
      sink: recorder,
      logger,
    })
    await supervisor.start()

    const ctx = FakeConnector.instances[0]!.ctx!
    let ticks = 0
    ctx.setInterval(() => {
      ticks += 1
      throw new Error('boom')
    }, 5)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(ticks).toBeGreaterThan(2)
    expect(supervisor.status.state).not.toBe('error')
    await supervisor.stop()
  })

  it('runs against a simulator when the instance is flagged simulate', async () => {
    const module = createFakeModule()
    const { supervisor } = build(module, { simulate: true })
    await supervisor.start()

    expect(module.simulators).toHaveLength(1)
    expect(module.simulators[0]!.listening).toBe(true)
    expect(supervisor.status.state).toBe('online')

    await supervisor.stop()
    expect(module.simulators[0]!.listening).toBe(false)
  })
})

describe('Supervisor commands', () => {
  beforeEach(() => {
    FakeConnector.instances = []
  })

  it('executes a command when online', async () => {
    const { supervisor } = build(createFakeModule())
    await supervisor.start()
    expect(await supervisor.exec('noop', {})).toMatchObject({ ok: true })
    await supervisor.stop()
  })

  it('refuses commands while offline', async () => {
    const { supervisor } = build(createFakeModule({ throwOnStart: new Error('down') }))
    await supervisor.start()
    expect(await supervisor.exec('noop', {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_CONNECTED' },
    })
    await supervisor.stop()
  })

  it('reports a missing command implementation', async () => {
    const module = createFakeModule()
    const noExec: typeof module = {
      ...module,
      create: () => {
        const connector = new FakeConnector()
        // Some connectors are read-only; asking them to act is a NOT_FOUND.
        ;(connector as { exec?: unknown }).exec = undefined
        return connector
      },
    }
    const { supervisor } = build(noExec)
    await supervisor.start()
    expect(await supervisor.exec('noop', {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await supervisor.stop()
  })
})

describe('the rhythm a connector publishes', () => {
  /*
   * This is the source of the whole staleness seed, and it was the one part of
   * it with no test: both readers — the health engine and the browser — were
   * checked against hand-fed numbers, and nothing checked that the number they
   * would really be given is the one the connector asked for.
   *
   * Driven through the context the supervisor hands the connector, rather than
   * a hook on the shared fake, because `ctx.setInterval` *is* the thing under
   * test. A first attempt invented a hook the fake does not have, registered
   * no timers at all, and reported null — correctly, which is the sort of
   * green-looking failure that teaches you nothing.
   */
  const runningConnector = () => {
    const connector = FakeConnector.instances.at(-1)
    if (!connector?.ctx) throw new Error('the fake connector never started')
    return connector.ctx
  }

  it('reports the interval a connector registered', async () => {
    const { supervisor } = build(createFakeModule({}))
    await supervisor.start()
    runningConnector().setInterval(() => {}, 10_000)

    expect(supervisor.status.pollIntervalMs).toBe(10_000)
    await supervisor.stop()
  })

  it('reports the longest, which is the one silence is judged against', async () => {
    // netcheck probes every 200ms and polls every 30s. A stream quicker than
    // the slow timer corrects the estimate itself once it has two frames.
    const { supervisor } = build(createFakeModule({}))
    await supervisor.start()
    const ctx = runningConnector()
    for (const ms of [200, 30_000, 5_000]) ctx.setInterval(() => {}, ms)

    expect(supervisor.status.pollIntervalMs).toBe(30_000)
    await supervisor.stop()
  })

  it('says nothing for a connector that does not poll at all', async () => {
    // An event-driven connector has no rhythm to promise, and inventing one
    // would make every reader wrong about it in the same way.
    const { supervisor } = build(createFakeModule({}))
    await supervisor.start()

    expect(supervisor.status.pollIntervalMs).toBeNull()
    await supervisor.stop()
  })

  it('forgets the old timers when it stops', async () => {
    // Otherwise an admin who shortens a poll interval leaves the box judging
    // that stream against the interval it used to have.
    const { supervisor } = build(createFakeModule({}))
    await supervisor.start()
    runningConnector().setInterval(() => {}, 30_000)
    expect(supervisor.status.pollIntervalMs).toBe(30_000)

    await supervisor.stop()
    expect(supervisor.status.pollIntervalMs).toBeNull()
  })
})
