import { z } from 'zod'

/**
 * An event: the festival, conference or gig everything else belongs to.
 *
 * Modules, groups, dashboards, alert rules and the running order are all
 * configured *for* an event and travel with it. One is active at a time; the
 * rest sit on the box until someone switches to them or backs them up.
 *
 * Dates are days rather than instants — a festival runs "8–10 August", not
 * from a timestamp. Stored as the epoch millisecond of local midnight so they
 * sort, and deliberately distinct from the running order's absolute times.
 */
export const eventSchema = z.object({
  id: z.string(),
  name: z.string(),
  venue: z.string(),
  /** The postal address, as somebody would write it on a delivery note. */
  address: z.string(),
  /**
   * Where the venue actually is.
   *
   * Nullable together and in practice set together: a venue with a latitude
   * and no longitude is halfway round a line of the earth, so nothing should
   * be drawn from one without the other. Widgets read these — the weather at
   * the site, sunset over the field, how far the nearest hospital is — and
   * every one of them is wrong at the wrong moment if this is the office's
   * coordinates rather than the field's.
   */
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  startsOn: z.number().nullable(),
  endsOn: z.number().nullable(),
  notes: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Event = z.infer<typeof eventSchema>

/** An event plus what only the platform knows about it. */
export const eventSummarySchema = eventSchema.extend({
  active: z.boolean(),
  /** Bytes on disk. The measurements dominate, so this is mostly the SPL log. */
  sizeBytes: z.number(),
  /**
   * The schema this event's file is on; 0 if it cannot be read at all.
   *
   * Compared against the `schemaVersion` on the list response, which is what
   * this build knows. Higher means the event was written by a newer version
   * and this box cannot open it — worth saying on the row rather than letting
   * someone click and find out.
   */
  schemaVersion: z.number(),
})
export type EventSummary = z.infer<typeof eventSummarySchema>

/**
 * The `sys:event` payload: which event the box is running now.
 *
 * Deliberately thin, and deliberately not scoped to anyone: this goes to every
 * authenticated client so a switch can't leave a phone at front of house
 * quietly showing last year's rig. `switchedAt` is the signal, not the name —
 * a client compares the id it last saw and throws away everything it cached.
 */
export const activeEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  venue: z.string(),
  /**
   * Carried on the live topic so a widget can place itself without a fetch.
   *
   * Defaulted rather than required, unlike the REST shape above. This is a
   * wire format between two builds that need not match: a tab left open across
   * an update, or a cached PWA on a phone in somebody's pocket. A frame from a
   * server that predates these fields must still parse — losing the location
   * degrades a weather widget, where failing the whole frame would blank the
   * event name in the header and make every tab think the box had switched
   * events.
   */
  address: z.string().default(''),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  startsOn: z.number().nullable(),
  endsOn: z.number().nullable(),
  /** When the box last switched to it. Boot counts as a switch. */
  switchedAt: z.number(),
})
export type ActiveEvent = z.infer<typeof activeEventSchema>

const fields = {
  name: z.string().trim().min(1).max(120),
  venue: z.string().trim().max(120),
  address: z.string().trim().max(500),
  // Bounded because a typo here does not fail, it just points a widget at the
  // wrong part of the planet — the weather for somewhere nobody is standing.
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  startsOn: z.number().int().nullable(),
  endsOn: z.number().int().nullable(),
  notes: z.string().trim().max(2_000),
}

export const createEventSchema = z
  .object({
    ...fields,
    venue: fields.venue.default(''),
    address: fields.address.default(''),
    latitude: fields.latitude.default(null),
    longitude: fields.longitude.default(null),
    startsOn: fields.startsOn.default(null),
    endsOn: fields.endsOn.default(null),
    notes: fields.notes.default(''),
    /** Copy an existing event's configuration as a starting point. */
    duplicateOf: z.string().optional(),
  })
  .refine(
    (event) => event.endsOn === null || event.startsOn === null || event.endsOn >= event.startsOn,
    {
      message: 'An event cannot end before it starts',
      path: ['endsOn'],
    },
  )
  .refine((event) => (event.latitude === null) === (event.longitude === null), {
    message: 'A venue needs both a latitude and a longitude, or neither',
    path: ['longitude'],
  })
export type CreateEvent = z.infer<typeof createEventSchema>

export const updateEventSchema = z
  .object(fields)
  .partial()
  .refine(
    (patch) =>
      patch.latitude === undefined ||
      patch.longitude === undefined ||
      (patch.latitude === null) === (patch.longitude === null),
    { message: 'A venue needs both a latitude and a longitude, or neither', path: ['longitude'] },
  )
export type UpdateEvent = z.infer<typeof updateEventSchema>

/**
 * Where the venue is, or null.
 *
 * The only way anything should read these. Both or neither is enforced on the
 * way in, but a record written by an older build — or by hand, or by a restore
 * from a backup taken before this existed — can hold one without the other,
 * and half a coordinate is not a place. Returning null makes a widget fall
 * back to whatever it does without a location, which is always better than
 * confidently drawing the weather for the Gulf of Guinea.
 */
export function venueCoords(
  event: Pick<Event, 'latitude' | 'longitude'>,
): { latitude: number; longitude: number } | null {
  const { latitude, longitude } = event
  if (latitude === null || longitude === null) return null
  return { latitude, longitude }
}

/**
 * One backup file sitting on the box.
 *
 * `eventName` is null once the event it came from has been deleted, which is
 * frequently the reason someone is looking at this list.
 */
export const storedBackupSchema = z.object({
  file: z.string(),
  /**
   * Written by the nightly job rather than by hand.
   *
   * It is a copy of whichever event was active at 05:00, which makes it a
   * perfectly good thing to restore — but it is named after the job, so there
   * is no event id in it and it must not be shown as an orphan.
   */
  nightly: z.boolean(),
  eventId: z.string().nullable(),
  eventName: z.string().nullable(),
  takenAt: z.number(),
  sizeBytes: z.number(),
  /** Compared against the list response's `schemaVersion`, as for events. */
  schemaVersion: z.number(),
})
export type StoredBackup = z.infer<typeof storedBackupSchema>

/**
 * Bringing a backup back.
 *
 * Always as a new event, so this takes a name rather than a target: there is
 * nothing to overwrite and nothing to undo.
 */
export const restoreEventSchema = z.object({
  /** Basename of a file in the backups directory, from `GET /api/backups`. */
  file: z.string().regex(/^[A-Za-z0-9_-]+\.db$/, 'Not a backup file on this box'),
  name: fields.name,
})
export type RestoreEvent = z.infer<typeof restoreEventSchema>

/**
 * What a duplicate carries across.
 *
 * Configuration only. Last year's SPL log, alerts and audit trail stay with
 * last year — copying them would make every duplicate look like it had already
 * run, and the measurements are the bulk of the file.
 *
 * **This list documents; it does not decide.** `EventStore.duplicate` copies the
 * whole file with `VACUUM INTO` and then empties `HISTORY_TABLES`, so a new
 * table is carried across whether or not it is named here. Keep it accurate
 * anyway: it is the only written statement of what a duplicate is *for*, and a
 * reader who trusts it should not be misled.
 */
export const DUPLICATED_TABLES = [
  'module_instances',
  'profiles',
  'groups',
  'user_groups',
  'instance_groups',
  'profile_groups',
  'alert_rules',
  'alert_rule_notify_groups',
  'running_sessions',
  'running_items',
  'item_types',
  'people',
  'kit',
  'operating_modes',
  'settings',
] as const

/**
 * How far to move a duplicated event's running order, in whole days.
 *
 * A duplicate carries the running order across, and until this existed it
 * carried last year's absolute times with it — doors on a Friday in August
 * 2026, in an event running in August 2027. Sessions made that worse rather
 * than better, because a session start is now the anchor every item beneath it
 * is timed from, so one wrong session start is a whole block wrong.
 *
 * Whole days, and calendar days rather than 86,400,000 ms each: the thing to
 * preserve is "doors at 18:00", not "doors 8,760 hours later". A shift across
 * a clock change would otherwise land an hour out, silently, on the one part
 * of the system where being an hour out is the whole problem.
 *
 * Zero when either event has no start date. Last year's times are at least
 * honestly last year's; a guess would not be.
 */
export function dayShift(from: number | null, to: number | null): number {
  if (from === null || to === null) return 0
  return Math.round((midnight(to) - midnight(from)) / 86_400_000)
}

function midnight(ms: number): number {
  const at = new Date(ms)
  at.setHours(0, 0, 0, 0)
  return at.getTime()
}

/** What it deliberately leaves behind. */
export const HISTORY_TABLES = [
  'metrics',
  'alert_events',
  'activity',
  'notifications',
  'sms_outbox',
] as const
