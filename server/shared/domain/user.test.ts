import { describe, expect, it } from 'vitest'
import { contactDetailsSchema, sessionUserSchema } from './user.js'

describe('contactDetailsSchema', () => {
  it('accepts a patch that changes only one detail', () => {
    // Absent is not the same as empty: one leaves the number alone, the other
    // takes it off the record, and the server needs to be able to tell.
    const parsed = contactDetailsSchema.parse({ email: 'foh@example.com' })
    expect(parsed).toEqual({ email: 'foh@example.com' })
    expect('phone' in parsed).toBe(false)
  })

  it('accepts an empty string as clearing the field', () => {
    expect(contactDetailsSchema.parse({ phone: '', email: '' })).toEqual({ phone: '', email: '' })
  })

  it.each(['  ', '\t'])('accepts %o as clearing it too', (blank) => {
    // Selecting the address and hitting space is how people clear a field.
    // The first version checked the union branch against the untrimmed string
    // and refused this as a malformed address.
    expect(contactDetailsSchema.parse({ email: blank })).toEqual({ email: '' })
  })

  it('rejects something that is not an address', () => {
    const result = contactDetailsSchema.safeParse({ email: 'foh at example' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('email address')
  })

  it('refuses a number long enough to be an attack rather than a typo', () => {
    expect(contactDetailsSchema.safeParse({ phone: '0'.repeat(33) }).success).toBe(false)
  })
})

describe('sessionUserSchema', () => {
  it('defaults the contact details, so an older frame still parses', () => {
    // The web build and the server build are not always the same age — a
    // dashboard left open across an update reads frames from before these
    // fields existed, and must not fall over on the hello.
    expect(
      sessionUserSchema.parse({
        id: 'u1',
        username: 'foh',
        displayName: null,
        role: 'operator',
      }),
    ).toMatchObject({ phone: null, email: null })
  })
})
