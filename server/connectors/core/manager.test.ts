import { SYS_STATUS } from '@stageit/shared'
import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { Recorder } from '../../../test/connector-harness.js'
import { createFakeModule, FakeConnector } from '../../../test/fake-connector.js'
import { ConnectorManager } from './manager.js'
import { ConnectorRegistry } from './registry.js'
import type { InstanceDefinition } from './types.js'

const logger = pino({ level: 'silent' })

function setup(initial: InstanceDefinition[] = []) {
  const definitions = new Map(initial.map((d) => [d.id, d]))
  const module = createFakeModule()
  const registry = new ConnectorRegistry([module as never])
  const recorder = new Recorder()

  const manager = new ConnectorManager({
    registry,
    sink: recorder,
    logger,
    loadDefinition: (id) => definitions.get(id) ?? null,
    loadAllDefinitions: () => [...definitions.values()],
    backoff: { baseMs: 5, capMs: 10, random: () => 1 },
  })

  return { manager, recorder, definitions, module }
}

const def = (overrides: Partial<InstanceDefinition> = {}): InstanceDefinition => ({
  id: 'i1',
  typeId: 'fake',
  name: 'FOH Rig',
  config: { host: '10.0.0.5', port: 1234 },
  enabled: true,
  allowControl: false,
  simulate: false,
  ...overrides,
})

describe('ConnectorManager', () => {
  beforeEach(() => {
    FakeConnector.instances = []
  })

  it('starts every enabled instance and skips disabled ones', async () => {
    const { manager, recorder } = setup([
      def({ id: 'i1' }),
      def({ id: 'i2', name: 'Monitors' }),
      def({ id: 'i3', name: 'Spare', enabled: false }),
    ])

    await manager.start()

    expect(Object.keys(manager.getAllStatuses()).sort()).toEqual(['i1', 'i2'])
    expect(manager.getStatus('i1')?.state).toBe('online')
    expect(manager.getStatus('i3')).toBeNull()
    expect(recorder.systemPublishes.at(-1)?.topic).toBe(SYS_STATUS)

    await manager.stopAll()
  })

  it('adds an instance while running, with no restart', async () => {
    const { manager, definitions } = setup([def({ id: 'i1' })])
    await manager.start()

    // 20:55, someone rolls in another HyperDeck.
    definitions.set('i2', def({ id: 'i2', name: 'Late Addition' }))
    await manager.apply('i2')

    expect(manager.getStatus('i2')?.state).toBe('online')
    expect(manager.getStatus('i1')?.state).toBe('online')
    await manager.stopAll()
  })

  it('restarts a connector when its configuration changes', async () => {
    const { manager, definitions } = setup([def({ id: 'i1' })])
    await manager.start()
    const first = FakeConnector.instances[0]!

    definitions.set('i1', def({ id: 'i1', config: { host: '10.0.0.9', port: 4321 } }))
    await manager.apply('i1')

    expect(first.stopped).toBe(true)
    const current = FakeConnector.instances.at(-1)!
    expect(current).not.toBe(first)
    expect(current.ctx?.config).toMatchObject({ host: '10.0.0.9', port: 4321 })
    await manager.stopAll()
  })

  it('stops and tombstones an instance that is disabled', async () => {
    const { manager, definitions, recorder } = setup([def({ id: 'i1' })])
    await manager.start()

    definitions.set('i1', def({ id: 'i1', enabled: false }))
    await manager.apply('i1')

    expect(manager.getStatus('i1')).toBeNull()
    // Clients need to hear about it, or a widget keeps showing the last value
    // it saw as though it were live.
    expect(recorder.statuses.at(-1)).toMatchObject({ instanceId: 'i1', state: 'stopped' })
    await manager.stopAll()
  })

  it('stops and tombstones an instance that is deleted', async () => {
    const { manager, definitions, recorder } = setup([def({ id: 'i1' })])
    await manager.start()

    definitions.delete('i1')
    await manager.apply('i1')

    expect(manager.getStatus('i1')).toBeNull()
    expect(recorder.statuses.at(-1)).toMatchObject({ state: 'stopped', detail: 'Removed' })
    await manager.stopAll()
  })

  it('serialises rapid changes to one instance', async () => {
    // An impatient admin toggling enabled must not leave two connectors
    // running against the same device.
    const { manager, definitions } = setup([def({ id: 'i1' })])
    await manager.start()

    definitions.set('i1', def({ id: 'i1', enabled: false }))
    const p1 = manager.apply('i1')
    definitions.set('i1', def({ id: 'i1', enabled: true }))
    const p2 = manager.apply('i1')
    definitions.set('i1', def({ id: 'i1', enabled: false }))
    const p3 = manager.apply('i1')
    await Promise.all([p1, p2, p3])

    expect(manager.getStatus('i1')).toBeNull()
    const live = FakeConnector.instances.filter((c) => c.started && !c.stopped)
    expect(live).toHaveLength(0)
    await manager.stopAll()
  })

  it('reports an unknown connector type as an error instead of crashing', async () => {
    const { manager, definitions, recorder } = setup()
    definitions.set('i9', def({ id: 'i9', typeId: 'not-installed' }))
    await manager.apply('i9')

    expect(recorder.statuses.at(-1)).toMatchObject({
      instanceId: 'i9',
      state: 'error',
    })
    await manager.stopAll()
  })

  it('routes commands to the right instance', async () => {
    const { manager } = setup([def({ id: 'i1' }), def({ id: 'i2' })])
    await manager.start()

    expect(await manager.exec('i1', 'noop', {})).toMatchObject({ ok: true })
    expect(await manager.exec('nope', 'noop', {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await manager.stopAll()
  })

  it('publishes an aggregate status map for the status board', async () => {
    const { manager, recorder } = setup([def({ id: 'i1' }), def({ id: 'i2' })])
    await manager.start()

    const latest = recorder.systemPublishes.filter((p) => p.topic === SYS_STATUS).at(-1)
    expect(Object.keys(latest?.payload as object).sort()).toEqual(['i1', 'i2'])
    await manager.stopAll()
  })

  it('hands a connector every part of the sink, not the parts it remembered', async () => {
    /*
     * This is a bug that shipped. The manager used to build its wrapper by
     * listing three methods by hand, so when `ConnectorSink` grew a fourth —
     * `recordHistory`, for devices that keep their own log — the manager
     * silently dropped it. Every test still passed: the connector harness
     * builds a Supervisor directly and never comes through here, so the
     * feature worked in the tests and recorded nothing in the product.
     *
     * Asserted against the interface rather than against one method, so the
     * fifth addition does not need anybody to remember this again.
     */
    const { manager, recorder } = setup([def()])
    await manager.start()

    const ctx = FakeConnector.instances.at(-1)?.ctx
    expect(ctx).toBeDefined()

    ctx?.recordHistory([{ metric: 'fake.level', ts: 1_000, value: 92.4 }])
    expect(recorder.history).toEqual([{ metric: 'fake.level', ts: 1_000, value: 92.4 }])

    // The live path too, so this covers the wrapper rather than one method.
    ctx?.publish('level', { value: 92.4 })
    expect(recorder.payloads('level')).toEqual([{ value: 92.4 }])

    await manager.stopAll()
  })

  it('stops everything on shutdown', async () => {
    const { manager } = setup([def({ id: 'i1' }), def({ id: 'i2' })])
    await manager.start()
    await manager.stopAll()

    expect(manager.getAllStatuses()).toEqual({})
    expect(FakeConnector.instances.every((c) => c.stopped)).toBe(true)
  })

  it('ignores changes applied after shutdown', async () => {
    const { manager, definitions } = setup([def({ id: 'i1' })])
    await manager.start()
    await manager.stopAll()

    definitions.set('i2', def({ id: 'i2' }))
    await manager.apply('i2')
    expect(manager.getStatus('i2')).toBeNull()
  })
})
