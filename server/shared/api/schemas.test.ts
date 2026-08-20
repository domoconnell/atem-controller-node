import { describe, expect, it } from 'vitest'
import {
  activityQuerySchema,
  createInstanceBodySchema,
  createProfileBodySchema,
  createUserBodySchema,
  loginBodySchema,
  settingsSchema,
  setupBodySchema,
  updateInstanceBodySchema,
  updateSettingsBodySchema,
} from './schemas.js'

describe('settings', () => {
  it('supplies sane festival defaults', () => {
    const settings = settingsSchema.parse({})
    // Exact equality on purpose: a setting added without a considered default
    // should fail here rather than quietly ship one.
    expect(settings).toEqual({
      siteName: 'Stage It Live',
      metricsRetentionHours: 72,
      eventsRetentionDays: 30,
      alertEventsRetentionDays: 90,
      notificationsRetentionDays: 30,
      smsHourlyCap: 10,
      splWarnDb: 97,
      splAlarmDb: 102,
      showModeLeadMinutes: 15,
    })
  })

  it('touches only the keys a partial update actually sends', () => {
    // Regression guard: a schema built with .partial() over defaulted fields
    // would fill in every other key here and quietly reset stored settings.
    expect(updateSettingsBodySchema.parse({ splAlarmDb: 105 })).toEqual({ splAlarmDb: 105 })
    expect(updateSettingsBodySchema.parse({})).toEqual({})
  })

  it('still validates the fields a partial update does send', () => {
    expect(updateSettingsBodySchema.safeParse({ splAlarmDb: 500 }).success).toBe(false)
    expect(updateSettingsBodySchema.safeParse({ siteName: '' }).success).toBe(false)
  })

  it('rejects a retention window outside the supported range', () => {
    expect(settingsSchema.safeParse({ metricsRetentionHours: 0 }).success).toBe(false)
    expect(settingsSchema.safeParse({ eventsRetentionDays: 400 }).success).toBe(false)
  })
})

describe('instance bodies', () => {
  it('defaults a new instance to enabled, real, and without control', () => {
    const body = createInstanceBodySchema.parse({ typeId: 'demo', name: 'FOH Demo' })
    // Control off by default is the safety property: an admin has to opt in
    // before this dashboard can write anything to show equipment.
    expect(body).toMatchObject({ enabled: true, allowControl: false, simulate: false, config: {} })
  })

  it('trims instance names and rejects blank ones', () => {
    expect(createInstanceBodySchema.parse({ typeId: 'demo', name: '  FOH  ' }).name).toBe('FOH')
    expect(createInstanceBodySchema.safeParse({ typeId: 'demo', name: '   ' }).success).toBe(false)
  })

  it('allows an empty update body', () => {
    expect(updateInstanceBodySchema.safeParse({}).success).toBe(true)
  })
})

describe('auth bodies', () => {
  it('enforces a minimum password length on setup', () => {
    expect(setupBodySchema.safeParse({ username: 'admin', password: 'short' }).success).toBe(false)
    expect(
      setupBodySchema.parse({ username: 'admin', password: 'longenough' }).seedDemoInstances,
    ).toBe(false)
  })

  it('rejects usernames with characters that would complicate URLs and logs', () => {
    expect(
      createUserBodySchema.safeParse({ username: 'a b', password: 'password1', role: 'viewer' })
        .success,
    ).toBe(false)
    expect(
      createUserBodySchema.safeParse({
        username: 'foh.tech',
        password: 'password1',
        role: 'viewer',
      }).success,
    ).toBe(true)
  })

  it('does not constrain the login password — only the stored one has rules', () => {
    expect(loginBodySchema.safeParse({ username: 'admin', password: 'x' }).success).toBe(true)
  })
})

describe('query coercion', () => {
  it('coerces querystring numbers and applies a default limit', () => {
    const query = activityQuerySchema.parse({ since: '1700000000000' })
    expect(query.since).toBe(1_700_000_000_000)
    expect(query.limit).toBe(200)
  })

  it('caps the limit so one request cannot pull the whole event log', () => {
    expect(activityQuerySchema.safeParse({ limit: '5000' }).success).toBe(false)
  })
})

describe('profile bodies', () => {
  it('defaults a new profile to private and non-default', () => {
    const body = createProfileBodySchema.parse({ name: 'Monitors' })
    expect(body).toMatchObject({ isShared: false, isDefault: false })
  })
})
