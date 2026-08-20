import { describe, expect, it } from 'vitest'
import { companionConfigSchema, companionModule } from './index.js'
import {
  baseUrl,
  coerceVariableValue,
  isVariableRef,
  parseVariableRef,
  variableValuePath,
} from './protocol.js'

describe('parseVariableRef', () => {
  it('reads a module variable as connection label and name', () => {
    expect(parseVariableRef('obs:streaming')).toEqual({
      key: 'obs:streaming',
      kind: 'module',
      connection: 'obs',
      name: 'streaming',
    })
  })

  it('reads a custom variable', () => {
    expect(parseVariableRef('custom:show_name')).toEqual({
      key: 'custom:show_name',
      kind: 'custom',
      connection: null,
      name: 'show_name',
    })
  })

  it('keeps the entry as written so it can be used as the published key', () => {
    // A widget binds to the text the operator typed; rewriting it here would
    // silently break every binding on the wall.
    expect(parseVariableRef('ATEM 1:pgm_input')?.key).toBe('ATEM 1:pgm_input')
  })

  it('rejects entries that are not a label/name pair', () => {
    expect(parseVariableRef('streaming')).toBeNull()
    expect(parseVariableRef(':streaming')).toBeNull()
    expect(parseVariableRef('obs:')).toBeNull()
    expect(parseVariableRef('obs:scene:name')).toBeNull()
  })

  it('exposes the same check the config form uses', () => {
    expect(isVariableRef('custom:cue')).toBe(true)
    expect(isVariableRef('cue')).toBe(false)
  })
})

describe('variableValuePath', () => {
  it('addresses a module variable through the connection label', () => {
    expect(variableValuePath(parseVariableRef('obs:streaming')!)).toBe(
      '/api/variable/obs/streaming/value',
    )
  })

  it('addresses a custom variable through its own route', () => {
    expect(variableValuePath(parseVariableRef('custom:show_name')!)).toBe(
      '/api/custom-variable/show_name/value',
    )
  })

  it('encodes labels, which operators name with spaces and slashes', () => {
    expect(variableValuePath(parseVariableRef('Stage L/R:level')!)).toBe(
      '/api/variable/Stage%20L%2FR/level/value',
    )
  })
})

describe('coerceVariableValue', () => {
  it('publishes a numeric value as a number so gauges can bind to it', () => {
    expect(coerceVariableValue('42')).toBe(42)
    expect(coerceVariableValue('-3.5')).toBe(-3.5)
    expect(coerceVariableValue(' 7 ')).toBe(7)
  })

  it('leaves anything that would not round-trip as the string Companion sent', () => {
    // "007" and "1.50" are values an operator recognises on the Companion
    // button; reformatting them to 7 and 1.5 makes the dashboard disagree
    // with the surface next to it.
    expect(coerceVariableValue('007')).toBe('007')
    expect(coerceVariableValue('1.50')).toBe('1.50')
  })

  it('leaves text and empty values alone', () => {
    expect(coerceVariableValue('LIVE')).toBe('LIVE')
    expect(coerceVariableValue('')).toBe('')
    expect(coerceVariableValue('  ')).toBe('  ')
  })

  it('does not turn Infinity or NaN into numbers', () => {
    expect(coerceVariableValue('Infinity')).toBe('Infinity')
    expect(coerceVariableValue('NaN')).toBe('NaN')
  })
})

describe('baseUrl', () => {
  it('builds an ordinary origin', () => {
    expect(baseUrl('10.0.1.20', 8000)).toBe('http://10.0.1.20:8000')
  })

  it('brackets an IPv6 literal, which show networks hand out more than expected', () => {
    expect(baseUrl('fe80::1', 8000)).toBe('http://[fe80::1]:8000')
  })
})

describe('companion config schema', () => {
  it('defaults to a Companion on the same machine with nothing subscribed', () => {
    expect(companionConfigSchema.parse({})).toEqual({
      host: '127.0.0.1',
      port: 8000,
      // Both directions default to HTTP: it is the transport that answers,
      // and OSC has to be asked for.
      commandTransport: 'http',
      oscPort: 12321,
      variables: [],
      pollIntervalMs: 1_000,
    })
  })

  it('rejects a variable entry that is not in the documented form', () => {
    // Caught at save time in the admin form, where the operator can still see
    // what they typed — not at 8pm as a silent null on the wall.
    const result = companionConfigSchema.safeParse({ variables: ['streaming'] })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('connectionLabel:variableName')
  })

  it('accepts both variable forms together', () => {
    expect(
      companionConfigSchema.parse({ variables: ['obs:streaming', 'custom:cue'] }).variables,
    ).toEqual(['obs:streaming', 'custom:cue'])
  })

  it('refuses a poll interval that would hammer the Companion machine', () => {
    expect(companionConfigSchema.safeParse({ pollIntervalMs: 50 }).success).toBe(false)
  })

  it('describes the variables field so the admin form can explain the format', () => {
    const described = companionConfigSchema.shape.variables.description
    expect(described).toContain('connectionLabel:variableName')
    expect(described).toContain('custom:name')
  })
})

describe('companion module declaration', () => {
  it('publishes variables and connection health as separate streams', () => {
    expect(companionModule.meta.streams.map((stream) => stream.id)).toEqual([
      'variables',
      'connection',
    ])
  })

  it('warns that Companion cannot report button state over HTTP', () => {
    // Crew will ask for button feedback on the wall; the honest answer belongs
    // in the admin UI, not in a support conversation.
    expect(companionModule.meta.vendorNotes).toContain('button state')
    expect(companionModule.meta.vendorNotes).toContain('3.4')
  })
})
