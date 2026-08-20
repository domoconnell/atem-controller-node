import { describe, expect, it } from 'vitest'
import {
  clientMessageSchema,
  MAX_TOPICS_PER_MESSAGE,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  serverMessageSchema,
} from './messages.js'

describe('client messages', () => {
  it('parses a subscribe frame', () => {
    const msg = parseClientMessage(JSON.stringify({ t: 'sub', topics: ['mi:a:meters'] }))
    expect(msg).toEqual({ t: 'sub', topics: ['mi:a:meters'] })
  })

  it('parses a command frame with arbitrary input', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        t: 'cmd',
        id: 'c1',
        instanceId: 'i1',
        command: 'transport.play',
        input: { speed: 1 },
      }),
    )
    expect(msg).toMatchObject({ t: 'cmd', id: 'c1', command: 'transport.play' })
  })

  it('rejects malformed JSON rather than throwing', () => {
    expect(parseClientMessage('{not json')).toBeNull()
  })

  it.each([
    ['unknown type', { t: 'nope' }],
    ['empty topic list', { t: 'sub', topics: [] }],
    ['missing correlation id', { t: 'cmd', instanceId: 'i1', command: 'x' }],
    ['non-numeric ping', { t: 'ping', ts: 'now' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseClientMessage(JSON.stringify(payload))).toBeNull()
  })

  it('caps how many topics one frame may request', () => {
    const topics = Array.from({ length: MAX_TOPICS_PER_MESSAGE + 1 }, (_, i) => `mi:a:s${i}`)
    expect(clientMessageSchema.safeParse({ t: 'sub', topics }).success).toBe(false)
  })
})

describe('server messages', () => {
  it('parses a hello frame', () => {
    const raw = JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 1234,
      user: { id: 'u1', username: 'dave', displayName: null, role: 'admin' },
    })
    expect(parseServerMessage(raw)).toMatchObject({ t: 'hello', protocolVersion: 1 })
  })

  it('allows a snapshot with no value yet', () => {
    const parsed = serverMessageSchema.safeParse({
      t: 'snap',
      topic: 'mi:a:meters',
      seq: 0,
      ts: null,
      data: null,
    })
    expect(parsed.success).toBe(true)
  })

  it('requires a timestamp on data frames', () => {
    const parsed = serverMessageSchema.safeParse({
      t: 'data',
      topic: 'mi:a:meters',
      seq: 1,
      ts: null,
      data: {},
    })
    expect(parsed.success).toBe(false)
  })

  it('carries a typed error on a failed ack', () => {
    const parsed = serverMessageSchema.safeParse({
      t: 'ack',
      id: 'c1',
      ok: false,
      error: { code: 'NOT_CONNECTED', message: 'offline' },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an ack whose error code is not one we defined', () => {
    const parsed = serverMessageSchema.safeParse({
      t: 'ack',
      id: 'c1',
      ok: false,
      error: { code: 'KABOOM', message: 'x' },
    })
    expect(parsed.success).toBe(false)
  })
})
