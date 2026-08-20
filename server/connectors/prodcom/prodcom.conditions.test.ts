import { describe, expect, it } from 'vitest'
import type { ConditionDecl, ConditionItemResult } from '../core/types.js'
import { prodcomConditions } from './conditions.js'

/**
 * The two questions this module can answer about a show.
 *
 * Worth testing directly rather than through the connector: these are pure
 * functions, and both of them are one boolean away from being either useless
 * (a mention that never clears) or intolerable (every channel raising a
 * warning the moment a rig is patched and before anybody has keyed a mic).
 */

const find = (id: string): ConditionDecl => {
  const decl = prodcomConditions.find((condition) => condition.id === id)
  if (!decl) throw new Error(`no ${id} condition`)
  return decl
}

const mention = find('comms.mention')
const silent = find('comms.silent')

const run = (
  decl: ConditionDecl,
  payload: unknown,
  params?: unknown,
  wasActive?: (itemKey?: string) => boolean,
): ConditionItemResult[] =>
  decl.evaluate(payload, params ?? decl.defaultParams, wasActive) as ConditionItemResult[]

const said = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  at: Date.now(),
  text: 'Dave to stage left',
  channel: 'Stage Left TB',
  channelId: 'c1',
  keywords: ['Dave'],
  sources: ['watch'],
  ...over,
})

describe('comms.mention', () => {
  it('fires when a watched word was said', () => {
    const [result] = run(mention, { mentions: [said()] })
    expect(result?.active).toBe(true)
    expect(result?.detail).toBe('Dave to stage left')
  })

  it('clears once the hold window has passed', () => {
    // The whole reason this reads the clocked stream. On an event stream it
    // would never be asked again, and a nine o'clock mention would still be
    // active at three in the morning.
    const old = said({ at: Date.now() - 120_000 })
    expect(
      run(mention, { mentions: [old] }, { words: '', scope: 'any', holdSeconds: 60 })[0]?.active,
    ).toBe(false)
    expect(
      run(mention, { mentions: [old] }, { words: '', scope: 'any', holdSeconds: 300 })[0]?.active,
    ).toBe(true)
  })

  it('takes an empty word list to mean whatever the module is watching for', () => {
    expect(run(mention, { mentions: [said()] }, mention.defaultParams)[0]?.active).toBe(true)
  })

  it('narrows to named words when given them', () => {
    const params = { words: 'medical', scope: 'any', holdSeconds: 60 }
    expect(run(mention, { mentions: [said()] }, params)[0]?.active).toBe(false)
    expect(run(mention, { mentions: [said({ keywords: ['medical'] })] }, params)[0]?.active).toBe(
      true,
    )
  })

  it('can be limited to our own watch list or to ProdCom’s keywords', () => {
    const fromProdCom = said({ sources: ['prodcom'], keywords: ['standby'] })
    const asWatch = { words: '', scope: 'watch', holdSeconds: 60 }
    const asProdCom = { words: '', scope: 'prodcom', holdSeconds: 60 }
    expect(run(mention, { mentions: [fromProdCom] }, asWatch)[0]?.active).toBe(false)
    expect(run(mention, { mentions: [fromProdCom] }, asProdCom)[0]?.active).toBe(true)
  })

  it('counts a flurry as one situation, not one problem per line', () => {
    const results = run(mention, { mentions: [said(), said({ id: 'm2' }), said({ id: 'm3' })] })
    expect(results).toHaveLength(1)
    expect(results[0]?.value).toBe(3)
  })

  it('says nothing at all when the stream has nothing to say', () => {
    expect(run(mention, {})[0]?.active).toBe(false)
    expect(run(mention, null)[0]?.active).toBe(false)
  })
})

describe('comms.silent', () => {
  const channel = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    name: 'Stage Left TB',
    lastHeardAt: Date.now(),
    quietSeconds: 0,
    ...over,
  })

  it('reports one result per channel, so a board lights the dead one', () => {
    const results = run(silent, {
      channels: [channel(), channel({ id: 'c2', name: 'FOH', quietSeconds: 3_600 })],
    })
    expect(results.map((r) => r.itemKey)).toEqual(['c1', 'c2'])
    expect(results[0]?.active).toBe(false)
    expect(results[1]?.active).toBe(true)
    expect(results[1]?.itemLabel).toBe('FOH')
  })

  it('ignores a channel nobody has spoken on yet', () => {
    /*
     * Not the same as a channel that has just gone dead. Without this, every
     * quiet channel raises a warning the moment a rig is patched and before
     * anybody has keyed a mic — which is every get-in, on every show.
     */
    const results = run(silent, { channels: [channel({ lastHeardAt: null, quietSeconds: null })] })
    expect(results).toEqual([])
  })

  it('reports minutes, because the rule is written in minutes', () => {
    const [result] = run(silent, { channels: [channel({ quietSeconds: 900 })] })
    expect(result?.value).toBe(15)
    expect(result?.detail).toBe('last heard 15 min ago')
  })

  it('does not say "0 min" about something said thirty seconds ago', () => {
    const [result] = run(silent, { channels: [channel({ quietSeconds: 30 })] })
    expect(result?.detail).toBe('last heard 30s ago')
  })

  it('holds on once it has fired, rather than flickering on the threshold', () => {
    // 15 minutes exactly, against a 15-minute rule. Hysteresis keeps it up.
    const payload = { channels: [channel({ quietSeconds: 15 * 60 })] }
    expect(run(silent, payload, silent.defaultParams, () => false)[0]?.active).toBe(false)
    expect(run(silent, payload, silent.defaultParams, () => true)[0]?.active).toBe(true)
  })

  it('watches only the channels it was pointed at', () => {
    const payload = {
      channels: [
        channel({ quietSeconds: 3_600 }),
        channel({ id: 'c2', name: 'FOH', quietSeconds: 3_600 }),
      ],
    }
    const results = run(silent, payload, { minutes: 15, channels: 'FOH' })
    expect(results.map((r) => r.itemLabel)).toEqual(['FOH'])
  })
})
