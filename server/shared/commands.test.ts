import { describe, expect, it } from 'vitest'
import { commandFail, commandOk, commandResultSchema } from './commands.js'

describe('command results', () => {
  it('builds a success result', () => {
    const result = commandOk({ state: 'playing' })
    expect(commandResultSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ ok: true })
  })

  it('builds a typed failure result', () => {
    const result = commandFail('NOT_CONNECTED', 'HyperDeck is offline')
    expect(commandResultSchema.safeParse(result).success).toBe(true)
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_CONNECTED', message: 'HyperDeck is offline' },
    })
  })

  it('rejects a failure that carries no error', () => {
    expect(commandResultSchema.safeParse({ ok: false }).success).toBe(false)
  })
})
