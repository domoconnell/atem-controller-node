import { describe, expect, it } from 'vitest'
import {
  buildTopic,
  healthTopic,
  isTopicOfInstance,
  isValidTopic,
  parseTopic,
  STATUS_STREAM,
  SYS_ALERTS,
  SYS_EVENT,
  SYS_HEALTH,
  SYS_SCHEDULE,
  SYS_STATUS,
  statusTopic,
  userInboxTopic,
} from './topics.js'

describe('buildTopic / parseTopic', () => {
  it('round-trips an instance topic', () => {
    const topic = buildTopic('abc123', 'meters')
    expect(topic).toBe('mi:abc123:meters')
    expect(parseTopic(topic)).toEqual({
      kind: 'instance',
      instanceId: 'abc123',
      streamId: 'meters',
    })
  })

  it('round-trips the reserved status stream', () => {
    const topic = statusTopic('abc123')
    expect(topic).toBe(`mi:abc123:${STATUS_STREAM}`)
    expect(parseTopic(topic)).toEqual({
      kind: 'instance',
      instanceId: 'abc123',
      streamId: STATUS_STREAM,
    })
  })

  it('accepts dotted stream ids used by multi-channel connectors', () => {
    expect(parseTopic('mi:amp1:channel.a.level')).toEqual({
      kind: 'instance',
      instanceId: 'amp1',
      streamId: 'channel.a.level',
    })
  })

  it('recognises the known system topics', () => {
    expect(parseTopic(SYS_STATUS)).toEqual({ kind: 'system', name: 'status' })
    expect(parseTopic(SYS_HEALTH)).toEqual({ kind: 'system', name: 'health' })
  })

  it.each([
    ['unknown system topic', 'sys:nope'],
    ['no prefix', 'meters'],
    ['unknown prefix', 'xx:a:b'],
    ['missing stream', 'mi:abc123'],
    ['empty instance id', 'mi::meters'],
    ['illegal characters in instance id', 'mi:ab/cd:meters'],
    ['illegal characters in stream id', 'mi:abc:met ers'],
    ['empty string', ''],
  ])('rejects %s', (_label, topic) => {
    expect(parseTopic(topic)).toBeNull()
    expect(isValidTopic(topic)).toBe(false)
  })

  it('does not let a nested colon smuggle a second stream segment past validation', () => {
    // Everything after the first separator is the stream id, and colons are not
    // in the stream charset — so this must be rejected rather than silently split.
    expect(parseTopic('mi:abc:meters:extra')).toBeNull()
  })

  it('matches topics belonging to an instance', () => {
    expect(isTopicOfInstance('mi:abc:meters', 'abc')).toBe(true)
    expect(isTopicOfInstance('mi:abc:meters', 'xyz')).toBe(false)
    expect(isTopicOfInstance(SYS_STATUS, 'abc')).toBe(false)
  })
})

describe('user topics', () => {
  it('builds and parses an inbox topic', () => {
    expect(userInboxTopic('u123')).toBe('usr:u123:inbox')
    expect(parseTopic('usr:u123:inbox')).toEqual({
      kind: 'user',
      userId: 'u123',
      channel: 'inbox',
    })
  })

  it.each([
    ['an unlisted channel', 'usr:u123:secrets'],
    ['a missing channel', 'usr:u123'],
    ['a missing user', 'usr::inbox'],
    ['illegal characters in the user id', 'usr:u 1:inbox'],
    // The channel set is closed for the same reason the system set is: topic
    // authorization is a lookup, and a pattern would eventually match too much.
    ['a wildcard', 'usr:*:inbox'],
  ])('rejects %s', (_label, topic) => {
    expect(parseTopic(topic)).toBeNull()
    expect(isValidTopic(topic)).toBe(false)
  })
})

describe('health stream', () => {
  it('is a reserved stream alongside status', () => {
    expect(healthTopic('abc')).toBe('mi:abc:$health')
    expect(parseTopic('mi:abc:$health')).toEqual({
      kind: 'instance',
      instanceId: 'abc',
      streamId: '$health',
    })
  })

  it('still rejects an unknown dollar-prefixed stream', () => {
    // Reserved names are enumerated, not pattern-matched, so a typo fails loudly.
    expect(parseTopic('mi:abc:$secret')).toBeNull()
  })

  it('accepts only the system topics on the list', () => {
    // The guard on the closed set. Anything added here needs a deliberate
    // decision about who may see it, and a matching filter case — an unlisted
    // name must stay unaddressable rather than defaulting to allowed.
    expect(parseTopic(SYS_ALERTS)).toEqual({ kind: 'system', name: 'alerts' })
    expect(parseTopic(SYS_SCHEDULE)).toEqual({ kind: 'system', name: 'schedule' })
    expect(parseTopic(SYS_EVENT)).toEqual({ kind: 'system', name: 'event' })
    expect(parseTopic('sys:anything')).toBeNull()
  })
})
