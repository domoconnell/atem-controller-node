import { describe, expect, it } from 'vitest'
import {
  BREAKPOINT_COLS,
  BREAKPOINTS,
  emptyLayout,
  MAX_LAYOUT_COLS,
  MAX_LAYOUT_ROWS,
  profileLayoutSchema,
  RECENT_PROFILES_MAX,
  recalledProfile,
  recentProfilesSchema,
  rememberProfile,
  resolveDefaultProfile,
  resolveProfileForDevice,
  titleIsHidden,
} from './profile.js'

const profile = (
  id: string,
  ownerUserId: string | null,
  isDefault = false,
): { id: string; ownerUserId: string | null; isDefault: boolean } => ({
  id,
  ownerUserId,
  isDefault,
})

describe('profile layout schema', () => {
  it('fills in defaults for a bare layout', () => {
    const parsed = profileLayoutSchema.parse({})
    expect(parsed).toEqual(emptyLayout())
  })

  it('accepts a populated layout and defaults widget config', () => {
    const parsed = profileLayoutSchema.parse({
      widgets: [{ i: 'w1', widgetType: 'clock' }],
      layouts: { lg: [{ i: 'w1', x: 0, y: 0, w: 3, h: 4 }], md: [], sm: [] },
    })
    expect(parsed.widgets[0]).toMatchObject({ i: 'w1', instanceId: null, config: {} })
    expect(parsed.layouts.lg).toHaveLength(1)
  })

  it('reads a dashboard saved before any of this existed', () => {
    // The one that matters on upgrade: every board on every box predates
    // these fields, and the repo re-parses the stored JSON on every read —
    // a parse failure there does not error, it serves an empty dashboard.
    const parsed = profileLayoutSchema.parse({
      widgets: [{ i: 'w1', widgetType: 'clock', instanceId: null, title: null, config: {} }],
      layouts: { lg: [{ i: 'w1', x: 0, y: 0, w: 3, h: 3 }], md: [], sm: [] },
    })

    expect(parsed.hideTitles).toBe(false)
    expect(parsed.autoArrange).toBe(true)
    expect(parsed.widgets[0]).toMatchObject({ scale: 1, titleHidden: null })
  })

  it('refuses a scale nothing could render sensibly', () => {
    const result = profileLayoutSchema.safeParse({
      widgets: [{ i: 'w1', widgetType: 'clock', scale: 2.5 }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a zero-width widget', () => {
    const result = profileLayoutSchema.safeParse({
      widgets: [],
      layouts: { lg: [{ i: 'w1', x: 0, y: 0, w: 0, h: 4 }], md: [], sm: [] },
    })
    expect(result.success).toBe(false)
  })

  // Geometry has ceilings as well as floors, because a shared dashboard is a
  // layout somebody else's browser has to draw.
  it.each([
    ['wider than the grid', { x: 0, y: 0, w: MAX_LAYOUT_COLS + 1, h: 4 }],
    ['taller than any screen', { x: 0, y: 0, w: 4, h: MAX_LAYOUT_ROWS + 1 }],
    ['starting past the last column', { x: MAX_LAYOUT_COLS, y: 0, w: 1, h: 4 }],
  ])('rejects a widget %s', (_name, item) => {
    const result = profileLayoutSchema.safeParse({
      widgets: [],
      layouts: { lg: [{ i: 'w1', ...item }], md: [], sm: [] },
    })
    expect(result.success).toBe(false)
  })

  it('still accepts the sentinel row a freshly added widget is dropped at', () => {
    // addWidget uses MAX_SAFE_INTEGER so the widget lands below everything
    // else; a pagehide flush can save it before the grid compacts it away.
    const result = profileLayoutSchema.safeParse({
      widgets: [],
      layouts: { lg: [{ i: 'w1', x: 0, y: Number.MAX_SAFE_INTEGER, w: 4, h: 4 }], md: [], sm: [] },
    })
    expect(result.success).toBe(true)
  })

  it('defines a column count for every breakpoint', () => {
    for (const bp of BREAKPOINTS) expect(BREAKPOINT_COLS[bp]).toBeGreaterThan(0)
  })
})

describe('resolveDefaultProfile', () => {
  it("prefers the user's own default", () => {
    const profiles = [
      profile('shared', null, true),
      profile('mine', 'u1', true),
      profile('other', 'u1'),
    ]
    expect(resolveDefaultProfile(profiles, 'u1')?.id).toBe('mine')
  })

  it('falls back to a shared default', () => {
    const profiles = [profile('shared', null, true), profile('someone-else', 'u2', true)]
    expect(resolveDefaultProfile(profiles, 'u1')?.id).toBe('shared')
  })

  it('falls back to the first profile the user owns', () => {
    const profiles = [profile('mine', 'u1'), profile('shared', null)]
    expect(resolveDefaultProfile(profiles, 'u1')?.id).toBe('mine')
  })

  it('falls back to any shared profile for a brand new user', () => {
    expect(resolveDefaultProfile([profile('shared', null)], 'u1')?.id).toBe('shared')
  })

  it('returns null when there is nothing to show', () => {
    expect(resolveDefaultProfile([], 'u1')).toBeNull()
    expect(resolveDefaultProfile([profile('theirs', 'u2')], 'u1')).toBeNull()
  })
})

describe('resolveProfileForDevice', () => {
  const profiles = [profile('shared', null, true), profile('mine', 'u1'), profile('other', 'u1')]

  it('shows the screen what it had open last, not the default', () => {
    // The whole point: the wall above the stage and the laptop next to it are
    // the same account looking at different things.
    expect(resolveProfileForDevice(profiles, 'u1', 'other')?.id).toBe('other')
  })

  it('falls back to the default when the remembered dashboard is gone', () => {
    // Somebody deleted it from another screen while this one was asleep.
    expect(resolveProfileForDevice(profiles, 'u1', 'deleted')?.id).toBe('shared')
  })

  it('falls back when the id belongs to an event the box has left', () => {
    // Ids are per event, so one from last year simply is not in the list.
    expect(resolveProfileForDevice(profiles, 'u1', 'last-years-id')?.id).toBe('shared')
  })

  it('behaves like the plain default when the screen remembers nothing', () => {
    expect(resolveProfileForDevice(profiles, 'u1', null)?.id).toBe('shared')
  })

  it('still returns null when there is genuinely nothing to show', () => {
    expect(resolveProfileForDevice([], 'u1', 'anything')).toBeNull()
  })

  it('will not resurrect a dashboard belonging to somebody else', () => {
    // Remembering is a convenience, not a way round who may see what: the
    // list it checks against is the one the server was willing to send.
    const theirs = [profile('theirs', 'u2')]
    expect(resolveProfileForDevice(theirs, 'u1', 'theirs')?.id).toBe('theirs')
    expect(resolveProfileForDevice([], 'u1', 'theirs')).toBeNull()
  })
})

describe('remembering what a screen had open', () => {
  it('recalls per event, so switching shows and back returns each screen', () => {
    let recent = rememberProfile([], 'festival', 'main-stage')
    recent = rememberProfile(recent, 'conference', 'room-a')

    expect(recalledProfile(recent, 'festival')).toBe('main-stage')
    expect(recalledProfile(recent, 'conference')).toBe('room-a')
  })

  it('keeps one entry per event, the most recent', () => {
    let recent = rememberProfile([], 'festival', 'main-stage')
    recent = rememberProfile(recent, 'festival', 'monitors')

    expect(recent).toHaveLength(1)
    expect(recalledProfile(recent, 'festival')).toBe('monitors')
  })

  it('guesses the most recent when the box has not said which event is running', () => {
    // The socket carries the event and may not have arrived yet. The guess is
    // checked against the dashboards that exist before it is used.
    let recent = rememberProfile([], 'festival', 'main-stage')
    recent = rememberProfile(recent, 'conference', 'room-a')

    expect(recalledProfile(recent, null)).toBe('room-a')
  })

  it('recalls nothing for an event it has never shown', () => {
    expect(recalledProfile(rememberProfile([], 'festival', 'main-stage'), 'gig')).toBeNull()
    expect(recalledProfile([], null)).toBeNull()
  })

  it('forgets the oldest event rather than growing for ever', () => {
    let recent: ReturnType<typeof rememberProfile> = []
    for (let i = 0; i < RECENT_PROFILES_MAX + 3; i++) {
      recent = rememberProfile(recent, `event-${i}`, `profile-${i}`)
    }

    expect(recent).toHaveLength(RECENT_PROFILES_MAX)
    expect(recalledProfile(recent, 'event-0')).toBeNull()
    expect(recalledProfile(recent, `event-${RECENT_PROFILES_MAX + 2}`)).toBe(
      `profile-${RECENT_PROFILES_MAX + 2}`,
    )
  })

  it('shrugs at whatever else is in storage', () => {
    // Hand-edited, written by another version, or half-wiped by a kiosk.
    expect(recentProfilesSchema.parse('not json at all')).toEqual([])
    expect(recentProfilesSchema.parse([{ eventId: 'e1' }])).toEqual([])
    expect(recentProfilesSchema.parse(null)).toEqual([])
    expect(recentProfilesSchema.parse([{ eventId: 'e1', profileId: 'p1' }])).toEqual([
      { eventId: 'e1', profileId: 'p1' },
    ])
  })
})

describe('titleIsHidden', () => {
  it('lets a widget overrule the dashboard in both directions', () => {
    // The point of the third state: one switch hides every header, and a
    // widget whose contents do not say what it is keeps its own.
    expect(titleIsHidden({ titleHidden: false }, true)).toBe(false)
    expect(titleIsHidden({ titleHidden: true }, false)).toBe(true)
  })

  it('follows the dashboard when the widget has no opinion', () => {
    expect(titleIsHidden({ titleHidden: null }, true)).toBe(true)
    expect(titleIsHidden({ titleHidden: null }, false)).toBe(false)
  })
})
