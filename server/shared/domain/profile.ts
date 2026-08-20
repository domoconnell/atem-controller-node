import { z } from 'zod'

/**
 * Layout breakpoints. Named for the device they serve at a festival:
 * lg = FOH/production-office screens, md = tablets, sm = phones in a pocket.
 */
export const BREAKPOINTS = ['lg', 'md', 'sm'] as const
export type Breakpoint = (typeof BREAKPOINTS)[number]

export const BREAKPOINT_WIDTH: Record<Breakpoint, number> = { lg: 1200, md: 768, sm: 0 }
export const BREAKPOINT_COLS: Record<Breakpoint, number> = { lg: 12, md: 8, sm: 4 }
export const GRID_ROW_HEIGHT = 40

/**
 * The widest grid there is, and the tallest widget worth drawing.
 *
 * Geometry had floors but no ceilings, which is fine right up until something
 * saves nonsense: a widget 200 million rows tall is a layout the browser will
 * sit and think about, and a shared dashboard is a layout somebody else opens.
 * The client can never produce either — react-grid-layout clamps a width to
 * the column count, and `MAX_AUTO_GROW_ROWS` caps growth — so these bounds
 * only ever reject a hand-rolled PUT or a client with a bug in it.
 *
 * 200 rows is 8 metres of screen at `GRID_ROW_HEIGHT`, which is comfortably
 * past any real display and nowhere near a resize handle.
 */
export const MAX_LAYOUT_COLS = BREAKPOINT_COLS.lg
export const MAX_LAYOUT_ROWS = 200

/** One widget's geometry within a breakpoint (mirrors react-grid-layout's item shape). */
export const layoutItemSchema = z.object({
  i: z.string(),
  x: z.number().int().min(0).lt(MAX_LAYOUT_COLS),
  /*
   * Deliberately not bounded. A newly added widget is dropped in at
   * `Number.MAX_SAFE_INTEGER` so it lands below everything already there, and
   * react-grid-layout compacts it to a real row on the next render — but if
   * the page is closed in that gap, the pagehide flush saves the sentinel.
   * Rejecting it would lose the widget the user just added.
   */
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(MAX_LAYOUT_COLS),
  h: z.number().int().min(1).max(MAX_LAYOUT_ROWS),
  minW: z.number().int().min(1).max(MAX_LAYOUT_COLS).optional(),
  minH: z.number().int().min(1).max(MAX_LAYOUT_ROWS).optional(),
})
export type LayoutItem = z.infer<typeof layoutItemSchema>

/**
 * How far a widget's contents may be zoomed, and by how much a step moves.
 *
 * Bounded rather than open-ended because both ends stop being useful: below
 * 0.6 the 11px labels several widgets use stop being readable across a room,
 * and above 1.8 no amount of dropping a block will make a three-row widget fit
 * its own hero number, so it would grow for ever.
 */
export const WIDGET_SCALE_MIN = 0.6
export const WIDGET_SCALE_MAX = 1.8
export const WIDGET_SCALE_STEP = 0.1

/** One widget's identity and settings, shared across all breakpoints. */
export const widgetPlacementSchema = z.object({
  i: z.string(),
  widgetType: z.string(),
  instanceId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * Content zoom, applied by the widget shell.
   *
   * Lives here beside `title` rather than in `config` on purpose: the config
   * dialogue validates `config` against each widget's own schema and saves the
   * parsed result, so a key no widget declares is stripped the first time
   * anybody opens and saves that dialogue.
   */
  scale: z.number().min(WIDGET_SCALE_MIN).max(WIDGET_SCALE_MAX).default(1),
  /**
   * Three states, not two. `null` means "whatever the dashboard says", which
   * is what lets one switch hide every title while a widget whose name is not
   * obvious from its contents keeps its own.
   */
  titleHidden: z.boolean().nullable().default(null),
})
export type WidgetPlacement = z.infer<typeof widgetPlacementSchema>

/** Whether this widget shows its header, given the dashboard-wide setting. */
export function titleIsHidden(
  placement: Pick<WidgetPlacement, 'titleHidden'>,
  hideTitles: boolean,
): boolean {
  return placement.titleHidden ?? hideTitles
}

export const profileLayoutSchema = z.object({
  widgets: z.array(widgetPlacementSchema).default([]),
  layouts: z
    .object({
      lg: z.array(layoutItemSchema).default([]),
      md: z.array(layoutItemSchema).default([]),
      sm: z.array(layoutItemSchema).default([]),
    })
    .default({ lg: [], md: [], sm: [] }),
  /**
   * Dashboard-wide default for widget headers. A widget's own `titleHidden`
   * overrules it either way.
   */
  hideTitles: z.boolean().default(false),
  /**
   * Whether widgets close ranks when one is added, removed or resized.
   *
   * `true` is what the grid has always done — react-grid-layout compacts
   * vertically by default — so existing dashboards keep behaving as they did.
   * Turning it off lets someone place widgets deliberately, with gaps, and
   * have them stay where they were put.
   *
   * These two live inside the layout blob rather than as columns on the
   * profile: it is a free-form JSON column, so there is no migration, and the
   * PUT the dashboard already sends (including the keepalive one on pagehide)
   * carries them with no route change.
   */
  autoArrange: z.boolean().default(true),
})
export type ProfileLayout = z.infer<typeof profileLayoutSchema>

export const emptyLayout = (): ProfileLayout => ({
  widgets: [],
  layouts: { lg: [], md: [], sm: [] },
  hideTitles: false,
  autoArrange: true,
})

export const profileSchema = z.object({
  id: z.string(),
  ownerUserId: z.string().nullable(),
  ownerUsername: z.string().nullable(),
  name: z.string(),
  isShared: z.boolean(),
  isDefault: z.boolean(),
  layout: profileLayoutSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Profile = z.infer<typeof profileSchema>

export const profileNameSchema = z.string().trim().min(1).max(80)

/**
 * Which dashboard a user lands on: their own default, else a shared default,
 * else their first profile, else any shared profile.
 */
export function resolveDefaultProfile<
  T extends { id: string; isDefault: boolean; ownerUserId: string | null },
>(profiles: readonly T[], userId: string): T | null {
  const own = profiles.filter((p) => p.ownerUserId === userId)
  return (
    own.find((p) => p.isDefault) ??
    profiles.find((p) => p.isDefault && p.ownerUserId === null) ??
    own[0] ??
    profiles.find((p) => p.ownerUserId === null) ??
    null
  )
}

/**
 * What one screen last had open, remembered per event.
 *
 * A festival runs on more screens than people: a wall above the stage, a
 * laptop at front of house, a tablet on the monitor desk, three phones. Each
 * wants a different dashboard, and each wants the same one back after the
 * battery dies. That is a property of the screen, not of the account — the
 * same user is looking at all of them — so it is stored per device, next to
 * the theme and focus mode.
 *
 * Keyed by event because a dashboard belongs to one: profile ids from last
 * year's festival mean nothing in this year's database, and the box may be
 * switched between events during setup. Keeping one entry per event means
 * switching to the conference and back to the festival returns each screen to
 * where it was, rather than to whichever was touched last.
 */
export const recentProfileSchema = z.object({
  eventId: z.string(),
  profileId: z.string(),
})
export type RecentProfile = z.infer<typeof recentProfileSchema>

/** Enough events for a box that works all summer; small enough to never think about. */
export const RECENT_PROFILES_MAX = 8

/**
 * Whatever is in storage, or nothing.
 *
 * `.catch` rather than a thrown error on purpose: this is a convenience read
 * from a place the user can edit, another version of the app may have written,
 * and a kiosk may have wiped. Forgetting which dashboard was open is a shrug;
 * failing to open the app is not.
 */
export const recentProfilesSchema = z.array(recentProfileSchema).catch([])

/** Moves an event's screen memory to the front, keeping one entry per event. */
export function rememberProfile(
  recent: readonly RecentProfile[],
  eventId: string,
  profileId: string,
): RecentProfile[] {
  const rest = recent.filter((entry) => entry.eventId !== eventId)
  return [{ eventId, profileId }, ...rest].slice(0, RECENT_PROFILES_MAX)
}

/**
 * The dashboard this screen last had open, if it is still knowable.
 *
 * A null event is a screen that has not heard from the box yet — the socket
 * carries which event is running, and it may not have arrived. The most
 * recent entry is the best guess available, and it costs nothing to be wrong:
 * the id is checked against the dashboards that actually exist before anything
 * is shown, and ids from another event are not among them.
 */
export function recalledProfile(
  recent: readonly RecentProfile[],
  eventId: string | null,
): string | null {
  const match = eventId === null ? recent[0] : recent.find((entry) => entry.eventId === eventId)
  return match?.profileId ?? null
}

/**
 * Which dashboard this screen should show.
 *
 * The one it had open last, if that one still exists — a deleted dashboard, or
 * an id belonging to an event the box has since switched away from, falls
 * through to the ordinary default rather than leaving the screen empty. A wall
 * display that has been showing the stage all weekend must come back showing
 * something.
 */
export function resolveProfileForDevice<
  T extends { id: string; isDefault: boolean; ownerUserId: string | null },
>(profiles: readonly T[], userId: string, rememberedId: string | null): T | null {
  const remembered = rememberedId
    ? profiles.find((profile) => profile.id === rememberedId)
    : undefined
  return remembered ?? resolveDefaultProfile(profiles, userId)
}
