import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_STATES,
  commandDeclSchema,
  instanceStatusSchema,
  streamDeclSchema,
  typeCatalogueEntrySchema,
} from './instance.js'

describe('stream declarations', () => {
  it('defaults to keeping no history', () => {
    const decl = streamDeclSchema.parse({ id: 'meters', label: 'Meters', rateClass: 'fast' })
    expect(decl.history).toBe('none')
  })

  it('rejects a rate class the hub cannot schedule', () => {
    expect(streamDeclSchema.safeParse({ id: 'x', label: 'X', rateClass: 'instant' }).success).toBe(
      false,
    )
  })
})

describe('command declarations', () => {
  it('defaults to non-dangerous with no input form', () => {
    const decl = commandDeclSchema.parse({ id: 'play', label: 'Play' })
    expect(decl).toMatchObject({ dangerous: false, inputJsonSchema: null, description: null })
  })
})

describe('type catalogue entries', () => {
  it('defaults discovery off and tier to official', () => {
    const entry = typeCatalogueEntrySchema.parse({
      typeId: 'demo',
      displayName: 'Demo',
      description: 'Reference connector',
      configJsonSchema: {},
      streams: [],
      commands: [],
      capabilities: { control: true },
    })
    expect(entry.capabilities.discovery).toBe(false)
    expect(entry.tier).toBe('official')
    expect(entry.vendorNotes).toBeNull()
  })

  it('accepts the honest-labelling tiers used for caveated integrations', () => {
    const base = {
      typeId: 'dante',
      displayName: 'Dante',
      description: 'Read-only',
      configJsonSchema: {},
      streams: [],
      commands: [],
      capabilities: { control: false },
    }
    expect(typeCatalogueEntrySchema.parse({ ...base, tier: 'caveated' }).tier).toBe('caveated')
    expect(typeCatalogueEntrySchema.parse({ ...base, tier: 'workaround' }).tier).toBe('workaround')
    expect(typeCatalogueEntrySchema.safeParse({ ...base, tier: 'perfect' }).success).toBe(false)
  })
})

describe('instance status', () => {
  it('accepts every declared connector state', () => {
    for (const state of CONNECTOR_STATES) {
      const parsed = instanceStatusSchema.safeParse({
        instanceId: 'i1',
        state,
        detail: null,
        since: 0,
        attempt: 0,
        lastError: null,
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('rejects an unknown state so the UI never renders a mystery badge', () => {
    const parsed = instanceStatusSchema.safeParse({
      instanceId: 'i1',
      state: 'vibing',
      detail: null,
      since: 0,
      attempt: 0,
      lastError: null,
    })
    expect(parsed.success).toBe(false)
  })
})
