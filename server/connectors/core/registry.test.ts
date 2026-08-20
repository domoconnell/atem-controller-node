import { describe, expect, it } from 'vitest'
import { createFakeModule } from '../../../test/fake-connector.js'
import { demoModule } from '../demo/index.js'
import { smaartModule } from '../smaart/index.js'
import { ConnectorRegistry } from './registry.js'

describe('ConnectorRegistry', () => {
  it('exposes the built-in demo connector by default', () => {
    const registry = new ConnectorRegistry()
    expect(registry.has('demo')).toBe(true)
    expect(registry.get('demo')?.meta.displayName).toBe('Demo Device')
    expect(registry.get('nope')).toBeUndefined()
  })

  it('rejects duplicate type ids at construction', () => {
    expect(() => new ConnectorRegistry([demoModule as never, demoModule as never])).toThrow(
      /Duplicate connector typeId/,
    )
  })

  it('keeps an unproven module out of the shop window, and running for anyone who has one', () => {
    /*
     * DiGiCo has never met a console. Offering it in the add-module form
     * invites somebody to build a wall around a module whose OSC address
     * prefix is still an open question — and a module that connects and then
     * reports nothing is the failure a show blames the dashboard for.
     *
     * Hidden, not removed. An instance that already exists, or one that
     * arrives in a restored backup, keeps running and keeps its history and
     * must still be able to carry an alert rule. So it is absent from `list`
     * and present in `all`, and `get` still resolves it.
     */
    const registry = new ConnectorRegistry()

    expect(registry.list().map((module) => module.meta.typeId)).not.toContain('digico')
    expect(registry.catalogue().map((entry) => entry.typeId)).not.toContain('digico')

    expect(registry.all().map((module) => module.meta.typeId)).toContain('digico')
    expect(registry.get('digico')).toBeDefined()
    expect(registry.has('digico')).toBe(true)
  })

  it('offers every module nobody has flagged as unproven', () => {
    // The guard against the flag spreading by accident: hiding a working
    // module is as much a defect as offering a broken one, and quieter.
    const offered = new ConnectorRegistry().list().map((module) => module.meta.typeId)
    expect(offered).toEqual(
      expect.arrayContaining(['smaart', 'prodcom', 'companion', 'sennheiser', 'qlab']),
    )
    expect(offered).toHaveLength(13)
  })

  it('says a module can be asked its options only when it can', () => {
    /*
     * Derived from the implementation rather than declared in `meta`, so it
     * cannot be announced by a module that has no way to answer — the cost of
     * that landing on somebody pressing a button in the admin form and getting
     * a 404 from a module that said it could.
     */
    const catalogue = new ConnectorRegistry([
      demoModule as never,
      smaartModule as never,
    ]).catalogue()
    const byType = Object.fromEntries(catalogue.map((entry) => [entry.typeId, entry]))

    expect(byType.smaart?.capabilities.discovery).toBe(true)
    expect(byType.demo?.capabilities.discovery).toBe(false)
  })

  it('builds a catalogue the admin form can render', () => {
    const registry = new ConnectorRegistry([demoModule as never])
    const [entry] = registry.catalogue()

    expect(entry).toMatchObject({ typeId: 'demo', tier: 'official' })
    expect(entry?.capabilities).toEqual({ control: true, discovery: false })

    // The config form is generated from the Zod schema, so host/port must
    // appear as properties rather than being hand-maintained in the UI.
    const configSchema = entry?.configJsonSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(configSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['host', 'port']),
    )

    const command = entry?.commands[0]
    expect(command).toMatchObject({ id: 'setState', dangerous: false })
    expect(command?.inputJsonSchema).toBeTruthy()
  })

  it('declares stream history intent so the recorder knows what to keep', () => {
    const registry = new ConnectorRegistry([demoModule as never])
    const streams = registry.catalogue()[0]?.streams ?? []
    expect(streams.find((s) => s.id === 'meter')).toMatchObject({
      rateClass: 'fast',
      history: 'metric',
    })
    expect(streams.find((s) => s.id === 'state')).toMatchObject({ history: 'events' })
  })

  it('carries declared fields through to the browser', () => {
    // The Add widget dialogue picks a new widget's stream and field from this
    // payload, so a field that stops at the server is a widget that opens
    // pointed at nothing. `catalogue()` copies stream keys one at a time,
    // which is exactly how `fields` was dropped the first time: declared on
    // every connector, checked against every simulator, and still absent here.
    const registry = new ConnectorRegistry([demoModule as never])
    const streams = registry.catalogue()[0]?.streams ?? []

    expect(streams.find((s) => s.id === 'meter')?.fields).toEqual([
      { id: 'value', kind: 'number', label: 'Level', unit: null },
      { id: 'peak', kind: 'number', label: 'Peak', unit: null },
    ])
    // The state stream leads with its number and then the word, which is what
    // lets a level meter and a state light seed themselves from the same list.
    expect(streams.find((s) => s.id === 'state')?.fields.map((f) => f.kind)).toEqual([
      'number',
      'string',
    ])
  })

  it('lists every registered module', () => {
    const registry = new ConnectorRegistry([demoModule as never, createFakeModule() as never])
    expect(
      registry
        .list()
        .map((m) => m.meta.typeId)
        .sort(),
    ).toEqual(['demo', 'fake'])
  })
})
