import { describe, expect, it } from 'vitest'
import {
  asNumber,
  flattenCues,
  parseCueListIds,
  parseReplyBody,
  parseRunningCueStubs,
  parseWorkspaces,
  ReplyCorrelator,
} from './protocol.js'

const CUE_LISTS = [
  {
    uniqueID: 'list-1',
    number: '',
    listName: 'Main Cue List',
    type: 'Cue List',
    cues: [
      { uniqueID: 'c1', number: '1', listName: 'House to half', type: 'Light' },
      {
        uniqueID: 'c2',
        number: '2',
        listName: 'Walk-in',
        type: 'Group',
        cues: [{ uniqueID: 'c2.1', number: '2.1', listName: 'Bed loop', type: 'Audio' }],
      },
    ],
  },
]

describe('QLab reply bodies', () => {
  it('reads status, data and the echoed address', () => {
    expect(parseReplyBody('{"status":"ok","address":"/go","data":[1,2]}')).toEqual({
      status: 'ok',
      address: '/go',
      data: [1, 2],
      workspace_id: undefined,
    })
  })

  it('returns null for a body that is not JSON', () => {
    expect(parseReplyBody('{not json')).toBeNull()
    expect(parseReplyBody('"a string"')).toBeNull()
    expect(parseReplyBody('null')).toBeNull()
  })

  it('reads the workspace list QLab answers /workspaces with', () => {
    expect(
      parseWorkspaces([
        { uniqueID: 'ws-1', displayName: 'Main Show', version: '5.4.4' },
        { uniqueID: 'ws-2', displayName: 'Second Stage', version: '5.4.4' },
      ]),
    ).toEqual([
      { id: 'ws-1', displayName: 'Main Show', version: '5.4.4' },
      { id: 'ws-2', displayName: 'Second Stage', version: '5.4.4' },
    ])
  })

  it('skips workspace entries with no id instead of inventing one', () => {
    expect(parseWorkspaces([{ displayName: 'Nameless' }, 'nonsense', null])).toEqual([])
  })
})

describe('cue list flattening', () => {
  it('flattens groups and leaves the cue list container out', () => {
    // Nobody fires a cue list, so listing it between two lighting cues would
    // only cost the operator a line.
    expect(flattenCues(CUE_LISTS)).toEqual([
      { id: 'c1', number: '1', name: 'House to half', type: 'Light' },
      { id: 'c2', number: '2', name: 'Walk-in', type: 'Group' },
      { id: 'c2.1', number: '2.1', name: 'Bed loop', type: 'Audio' },
    ])
  })

  it('keeps the cue list ids, which playhead queries are addressed by', () => {
    expect(parseCueListIds(CUE_LISTS)).toEqual(['list-1'])
  })

  it('survives a tree of the wrong shape', () => {
    expect(flattenCues(null)).toEqual([])
    expect(flattenCues([{ cues: 'not an array' }])).toEqual([])
    expect(flattenCues([{ uniqueID: 'list', cues: [{ number: 5 }] }])).toEqual([])
  })

  it('reads running cue stubs and tolerates missing names', () => {
    expect(
      parseRunningCueStubs([{ uniqueID: 'c1' }, { uniqueID: 'c2', listName: 'Bed loop' }]),
    ).toEqual([
      { id: 'c1', name: '' },
      { id: 'c2', name: 'Bed loop' },
    ])
  })

  it('accepts numbers QLab sends as strings', () => {
    expect(asNumber('12.5')).toBe(12.5)
    expect(asNumber(3)).toBe(3)
    expect(asNumber('')).toBeNull()
    expect(asNumber('nope')).toBeNull()
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('ReplyCorrelator', () => {
  it('resolves the waiter for a reply address', async () => {
    const correlator = new ReplyCorrelator()
    const pending = correlator.expect('/reply/workspaces', 1_000)

    expect(correlator.settle('/reply/workspaces', { status: 'ok', data: 1 })).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'ok', data: 1 })
    expect(correlator.pendingCount).toBe(0)
  })

  it('answers two queries to the same address in order', async () => {
    // Two running cues both asking for their elapsed time is the normal case,
    // and the protocol has no request id to tell the replies apart.
    const correlator = new ReplyCorrelator()
    const first = correlator.expect('/reply/cue_id/a/actionElapsed', 1_000)
    const second = correlator.expect('/reply/cue_id/a/actionElapsed', 1_000)

    correlator.settle('/reply/cue_id/a/actionElapsed', { status: 'ok', data: 1 })
    correlator.settle('/reply/cue_id/a/actionElapsed', { status: 'ok', data: 2 })

    await expect(first).resolves.toMatchObject({ data: 1 })
    await expect(second).resolves.toMatchObject({ data: 2 })
  })

  it('reports a reply nobody was waiting for', () => {
    const correlator = new ReplyCorrelator()
    expect(correlator.settle('/reply/whatever', { status: 'ok' })).toBe(false)
  })

  it('rejects a query the device never answers', async () => {
    const correlator = new ReplyCorrelator()
    const pending = correlator.expect('/reply/workspaces', 5)
    await expect(pending).rejects.toThrow(/did not answer/)
    expect(correlator.pendingCount).toBe(0)
  })

  it('fails everything in flight when the socket dies', async () => {
    const correlator = new ReplyCorrelator()
    const pending = correlator.expect('/reply/workspaces', 1_000)
    correlator.rejectAll(new Error('connection closed by QLab'))

    await expect(pending).rejects.toThrow(/connection closed/)
    expect(correlator.pendingCount).toBe(0)
    // A late reply must not resolve a waiter that has already been failed.
    expect(correlator.settle('/reply/workspaces', { status: 'ok' })).toBe(false)
  })
})
