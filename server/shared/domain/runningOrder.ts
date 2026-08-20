import { z } from 'zod'

/**
 * The running order: what happens when, on the day.
 *
 * Two levels. A **session** is a block of the day with a start and an end —
 * doors, the evening celebration, curfew. An **item** is one thing inside it: a
 * song, a talk, a video, a changeover.
 *
 * This replaced a flat list of timed entries, and the reasoning for the flat
 * list is worth keeping because it was sound for what it was built for: the day
 * is derivable from `startsAt`, so a grouping table was "a second thing to keep
 * correct for no query anyone runs". That held while an entry was doors, a set
 * or curfew. It stopped holding once each line needed to carry the detail
 * somebody uses to do their job — the key a song is in, who is leading it,
 * which microphone a speaker is on. A service running order is a sequence of
 * those inside a block, and flattening it lost the block.
 *
 * Sessions keep absolute epoch milliseconds, like every other timestamp here.
 * Items keep a **duration** instead, and their place on the clock is computed —
 * so adding a two-minute notice at the top re-times everything after it rather
 * than needing every row edited.
 */
export const SESSION_KINDS = ['doors', 'set', 'changeover', 'curfew', 'other'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

export const runningSessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(SESSION_KINDS),
  startsAt: z.number(),
  endsAt: z.number().nullable(),
  notes: z.string(),
  /**
   * Marks the session that starts the show. Explicit rather than inferred: the
   * platform should never guess which line of a running order means "doors".
   */
  armsShowMode: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type RunningSession = z.infer<typeof runningSessionSchema>

export const runningItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Seconds. Zero is legitimate — a marker with no length of its own. */
  durationSeconds: z.number(),
  /** Which template's fields `details` is keyed by. Null once it is deleted. */
  typeId: z.string().nullable(),
  /** Flat by design. See the note on `details_json` in the table definition. */
  details: z.record(z.string(), z.unknown()),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type RunningItem = z.infer<typeof runningItemSchema>

export const sessionWithItemsSchema = runningSessionSchema.extend({
  items: z.array(runningItemSchema),
})
export type SessionWithItems = z.infer<typeof sessionWithItemsSchema>

// ── Item types ──────────────────────────────────────────────────────────────

/**
 * What an item type's fields can be.
 *
 * The whole set is declared here, not only the set the editor offers today, so
 * that adding one later is a UI change rather than a data migration on every
 * event database in the field.
 *
 * `longtext` is declared and not offered, because `SchemaForm` has no
 * textarea: offering "Long text" and rendering the same one-line box as "Text"
 * is a promise the form does not keep. Everything else is offered.
 */
export const FIELD_KINDS = [
  'text',
  'longtext',
  'number',
  'boolean',
  'choice',
  'person',
  'people',
  'kit',
  'kitMany',
] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

/** The kinds an admin can actually pick. See the note above. */
export const OFFERED_FIELD_KINDS = [
  'text',
  'number',
  'boolean',
  'choice',
  'person',
  'people',
  'kit',
  'kitMany',
] as const

/** The kinds that hold several values, so a caller knows to expect an array. */
export const MULTI_FIELD_KINDS: readonly FieldKind[] = ['people', 'kitMany']

export const itemFieldSchema = z.object({
  /**
   * Stable, and never shown. `details` is keyed by this, so renaming a field's
   * label has to leave what people typed against it where it was.
   */
  id: z.string().min(1).max(60),
  label: z.string().trim().min(1).max(60),
  kind: z.enum(FIELD_KINDS),
  /** Only meaningful for `choice`; ignored, not rejected, on other kinds. */
  choices: z.array(z.string().trim().min(1).max(80)).max(60),
  required: z.boolean(),
})
export type ItemField = z.infer<typeof itemFieldSchema>

export const itemTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.array(itemFieldSchema),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ItemType = z.infer<typeof itemTypeSchema>

// ── The roster ──────────────────────────────────────────────────────────────

/**
 * Somebody who appears on the running order.
 *
 * Defined once per event and referenced by id, so a talk says *who* is
 * speaking rather than carrying a name typed into it. That buys two things a
 * typed-in name cannot: a correction reaches every item at once, and the
 * roster page can count how many items point at somebody before anybody
 * deletes them. It is also what P5 needs — following a microphone to its
 * receiver channel is not something a string can do.
 */
export const personSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Free text: "Worship leader", "Speaker", "BSL interpreter". */
  role: z.string(),
  notes: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Person = z.infer<typeof personSchema>

/**
 * What a person is given: a microphone, an in-ear pack, a comms belt pack.
 *
 * The kinds are the ones that matter to a production office, which is really
 * the question "does this thing have a battery and an RF link". `other` is the
 * escape hatch for a lectern mic on a cable.
 */
export const KIT_KINDS = ['mic', 'iem', 'comms', 'other'] as const
export type KitKind = (typeof KIT_KINDS)[number]

export const kitSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(KIT_KINDS),
  notes: z.string(),
  /**
   * The join to a real receiver, filled in by P5: point a roster mic at a
   * Sennheiser module and the channel it lives on, and the board can say the
   * next item needs Vocal 3 and Vocal 3 is on 15%. Null until then, and null
   * for everything on a cable.
   */
  instanceId: z.string().nullable(),
  channelKey: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Kit = z.infer<typeof kitSchema>

/** Both halves of the roster, as everything that resolves a reference wants them. */
export interface Roster {
  people: readonly Person[]
  kit: readonly Kit[]
}

/**
 * The roster with the notes taken out.
 *
 * `notes` is free text an admin writes *about a person* — "arrives after the
 * first set", "prefers a handheld", and whatever else somebody decides to put
 * there. The running order itself goes to every authenticated user unfiltered,
 * which is deliberate and right: everyone working the show sees the same
 * evening. A private note about somebody is a different thing, and the rule is
 * already written down in `access/filters.ts` — "anything group-scoped must
 * stay out of them", which is why the event payload carries no notes either.
 *
 * So notes reach the roster page, which is admin-only, and nothing else. The
 * board has never had a use for them.
 */
export function withoutNotes(roster: Roster): Roster {
  return {
    people: roster.people.map((person) => ({ ...person, notes: '' })),
    kit: roster.kit.map((piece) => ({ ...piece, notes: '' })),
  }
}

/**
 * Live feed: the whole running order, small enough to send whole.
 *
 * The types and the roster travel with it so a widget can resolve an item's
 * fields to labels and its references to names without a second fetch — a
 * board on a wall has no session to fetch with, and the alternative was every
 * widget holding a stale copy of both.
 */
export const sysScheduleSchema = z.object({
  sessions: z.array(sessionWithItemsSchema),
  itemTypes: z.array(itemTypeSchema),
  people: z.array(personSchema),
  kit: z.array(kitSchema),
})
export type SysSchedule = z.infer<typeof sysScheduleSchema>

// ── Writes ──────────────────────────────────────────────────────────────────

const sessionFields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(SESSION_KINDS),
  startsAt: z.number().int(),
  endsAt: z.number().int().nullable(),
  notes: z.string().trim().max(500),
  armsShowMode: z.boolean(),
}

export const createSessionSchema = z
  .object({
    ...sessionFields,
    kind: sessionFields.kind.default('other'),
    endsAt: sessionFields.endsAt.default(null),
    notes: sessionFields.notes.default(''),
    armsShowMode: sessionFields.armsShowMode.default(false),
  })
  /*
   * `>=`, not `>`, and the message was already saying so.
   *
   * The check forbade an end equal to the start while its own words only
   * forbade one *before* it — so a zero-length session was rejected by a rule
   * that did not claim to reject it. Nothing measures a rate over a session's
   * length, so the shape costs nothing arithmetically, and the form now
   * defaults a stale end forward onto the start when somebody moves the start
   * past it. Refusing the value the form had just filled in would have been a
   * strange way to help.
   */
  .refine((session) => session.endsAt === null || session.endsAt >= session.startsAt, {
    message: 'A session cannot end before it starts',
    path: ['endsAt'],
  })
export type CreateSession = z.infer<typeof createSessionSchema>

export const updateSessionSchema = z.object(sessionFields).partial()
export type UpdateSession = z.infer<typeof updateSessionSchema>

const itemFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  /** Capped at twelve hours: anything longer is a typo, not a set. */
  durationSeconds: z
    .number()
    .int()
    .min(0)
    .max(12 * 60 * 60),
  typeId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
}

export const createItemSchema = z.object({
  ...itemFields,
  description: itemFields.description.default(''),
  durationSeconds: itemFields.durationSeconds.default(0),
  typeId: itemFields.typeId.default(null),
  details: itemFields.details.default({}),
})
export type CreateItem = z.infer<typeof createItemSchema>

export const updateItemSchema = z.object(itemFields).partial()
export type UpdateItem = z.infer<typeof updateItemSchema>

/** A reorder is the whole list, not a position per row. See the repo. */
export const reorderSchema = z.object({ ids: z.array(z.string()) })
export type Reorder = z.infer<typeof reorderSchema>

/**
 * A field on the way in.
 *
 * The id is optional because a field the editor has just added has not got one
 * yet: the server assigns it, the same way it assigns every other id here.
 * Sending one back is how an existing field says which field it is, and is the
 * only thing that stops a relabelled field losing what people typed into it.
 */
export const itemFieldInputSchema = z.object({
  id: z.string().trim().max(60).optional(),
  label: itemFieldSchema.shape.label,
  kind: itemFieldSchema.shape.kind,
  choices: itemFieldSchema.shape.choices.default([]),
  required: z.boolean().default(false),
})
export type ItemFieldInput = z.infer<typeof itemFieldInputSchema>

const itemTypeFields = {
  name: z.string().trim().min(1).max(60),
  /**
   * Capped. A template is a handful of things somebody needs at a glance on a
   * running order, and forty of them is a spreadsheet that has been pasted in
   * by mistake — which would render as a form nobody can scroll.
   */
  fields: z
    .array(itemFieldInputSchema)
    .max(24)
    // Two fields claiming the same id would share a value: typing into one
    // would silently change the other, and only one of them would survive the
    // round trip. Refused rather than de-duplicated, because a client sending
    // this has a bug and quietly dropping half its payload hides it.
    .refine(
      (fields) => {
        const ids = fields.map((field) => field.id).filter(Boolean)
        return new Set(ids).size === ids.length
      },
      { message: 'Two fields cannot share an id' },
    ),
}

export const createItemTypeSchema = z.object({
  ...itemTypeFields,
  fields: itemTypeFields.fields.default([]),
})
export type CreateItemType = z.infer<typeof createItemTypeSchema>

export const updateItemTypeSchema = z.object(itemTypeFields).partial()
export type UpdateItemType = z.infer<typeof updateItemTypeSchema>

const personFields = {
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80),
  notes: z.string().trim().max(500),
}

export const createPersonSchema = z.object({
  ...personFields,
  role: personFields.role.default(''),
  notes: personFields.notes.default(''),
})
export type CreatePerson = z.infer<typeof createPersonSchema>

export const updatePersonSchema = z.object(personFields).partial()
export type UpdatePerson = z.infer<typeof updatePersonSchema>

const kitFields = {
  name: z.string().trim().min(1).max(80),
  kind: z.enum(KIT_KINDS),
  notes: z.string().trim().max(500),
  instanceId: z.string().nullable(),
  channelKey: z.string().trim().max(120).nullable(),
}

export const createKitSchema = z.object({
  ...kitFields,
  kind: kitFields.kind.default('mic'),
  notes: kitFields.notes.default(''),
  instanceId: kitFields.instanceId.default(null),
  channelKey: kitFields.channelKey.default(null),
})
export type CreateKit = z.infer<typeof createKitSchema>

export const updateKitSchema = z.object(kitFields).partial()
export type UpdateKit = z.infer<typeof updateKitSchema>

// ── Turning a template into a form ──────────────────────────────────────────

/**
 * A type's fields as a JSON Schema `SchemaForm` can render.
 *
 * Built at run time rather than declared, because these fields are data an
 * admin typed rather than code anybody wrote. The precedent is the alert-rule
 * page, which picks a condition from a plain select and then hands
 * `SchemaForm` that condition's own `paramsJsonSchema` — no new form
 * machinery, and the one level of properties `SchemaForm` walks is exactly
 * what a flat `details` needs.
 *
 * Keyed by field **id**, titled by label: the label is what an admin reads and
 * may retype at any time, and the id is what `details` is stored against.
 */
export function fieldsToJsonSchema(fields: readonly ItemField[]): {
  type: 'object'
  properties: Record<string, { type: string; title: string; items?: { type: string } }>
  required: string[]
} {
  const properties: Record<string, { type: string; title: string; items?: { type: string } }> = {}
  const required: string[] = []

  for (const field of fields) {
    properties[field.id] = MULTI_FIELD_KINDS.includes(field.kind)
      ? { type: 'array', title: field.label, items: { type: 'string' } }
      : { type: scalarType(field.kind), title: field.label }
    if (field.required) required.push(field.id)
  }

  return { type: 'object', properties, required }
}

function scalarType(kind: FieldKind): string {
  if (kind === 'number') return 'number'
  if (kind === 'boolean') return 'boolean'
  return 'string'
}

/**
 * The options `SchemaForm` cannot know, by field id.
 *
 * A `choice` field's options are typed into the template, so they reach the
 * form the same way a widget's stream list does — through the `choices` prop
 * rather than through an `enum` in the schema. That matters for two reasons a
 * JSON Schema enum would get wrong: the labels render verbatim rather than
 * being title-cased into something the admin did not type, and a value that is
 * no longer on the list is kept and marked rather than silently dropped, which
 * is what happens every time somebody edits a template mid-build.
 *
 * The roster kinds go through the same mechanism, looked up in `roster`
 * instead of in the template. A person field's options are ids and their
 * labels are names, which is what makes a correction to somebody's name reach
 * every item that mentions them at once.
 */
export function fieldChoices(
  fields: readonly ItemField[],
  roster: Roster = EMPTY_ROSTER,
): Record<string, { value: string; label: string }[]> {
  const result: Record<string, { value: string; label: string }[]> = {}

  // Built once even when no field needs them: two maps over a roster of
  // twenty is cheaper than deciding whether to build them.
  const people = roster.people.map((person) => ({
    value: person.id,
    // The role is the disambiguator on a crew list with two Kates on it.
    label: person.role ? `${person.name} — ${person.role}` : person.name,
  }))
  const kit = roster.kit.map((piece) => ({ value: piece.id, label: piece.name }))

  for (const field of fields) {
    if (field.kind === 'choice') {
      if (field.choices.length > 0) {
        result[field.id] = field.choices.map((choice) => ({ value: choice, label: choice }))
      }
      continue
    }
    if (field.kind === 'person' || field.kind === 'people') {
      if (people.length > 0) result[field.id] = people
      continue
    }
    if (field.kind === 'kit' || field.kind === 'kitMany') {
      if (kit.length > 0) result[field.id] = kit
    }
  }

  return result
}

const EMPTY_ROSTER: Roster = { people: [], kit: [] }

/**
 * What an item's details say, in the order the template lists them.
 *
 * Only fields the type still declares, and only ones with something in them —
 * a board showing "Key —, Lead —, Capo —" against every song has spent three
 * columns saying nothing. Values for fields a template has since dropped stay
 * in `details` untouched and simply do not appear here; deleting them would
 * make renaming a field by remove-then-add a data loss.
 *
 * Roster references are stored as ids and read back as names. An id nothing
 * matches is shown as "(removed)" rather than as itself: a stage manager
 * seeing a sixteen-character key on the board would learn nothing, and hiding
 * it would quietly turn a talk with a speaker into a talk with nobody.
 */
export function itemDetails(
  item: Pick<RunningItem, 'typeId' | 'details'>,
  types: readonly ItemType[],
  roster: Roster = EMPTY_ROSTER,
): { label: string; value: string }[] {
  const type = types.find((each) => each.id === item.typeId)
  if (!type) return []

  const names = new Map<string, string>()
  for (const person of roster.people) names.set(person.id, person.name)
  for (const piece of roster.kit) names.set(piece.id, piece.name)

  const out: { label: string; value: string }[] = []
  for (const field of type.fields) {
    const raw = item.details[field.id]
    const value = ROSTER_FIELD_KINDS.includes(field.kind)
      ? formatDetail(resolve(raw, names))
      : formatDetail(raw)
    if (value !== '') out.push({ label: field.label, value })
  }
  return out
}

/** The kinds whose stored value is an id into the roster rather than a word. */
export const ROSTER_FIELD_KINDS: readonly FieldKind[] = ['person', 'people', 'kit', 'kitMany']

/** The kinds that point at kit specifically, as opposed to at a person. */
const KIT_FIELD_KINDS: readonly FieldKind[] = ['kit', 'kitMany']

/**
 * The kit an item needs, resolved.
 *
 * Only through fields whose kind says they hold kit — a `text` field containing
 * a piece of kit's id is the word, not a reference, the same distinction the
 * roster page counts by.
 *
 * Returned as the roster rows rather than as ids, because every caller wants
 * the name and the receiver channel, and doing that lookup twice is how the
 * two of them end up disagreeing.
 */
export function itemKit(
  item: Pick<RunningItem, 'typeId' | 'details'>,
  types: readonly ItemType[],
  roster: Roster,
): Kit[] {
  const type = types.find((each) => each.id === item.typeId)
  if (!type) return []

  const wanted = new Set<string>()
  for (const field of type.fields) {
    if (!KIT_FIELD_KINDS.includes(field.kind)) continue
    const value = item.details[field.id]
    for (const each of Array.isArray(value) ? value : [value]) {
      if (typeof each === 'string' && each !== '') wanted.add(each)
    }
  }

  // In roster order rather than in the order the fields mention them, so two
  // items needing the same three mics list them the same way round.
  return roster.kit.filter((piece) => wanted.has(piece.id))
}

function resolve(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((each) => resolve(each, names))
  if (typeof value !== 'string' || value === '') return value
  return names.get(value) ?? '(removed)'
}

function formatDetail(value: unknown): string {
  if (value === null || value === undefined) return ''
  // A false boolean is a real answer, but "Click track: no" on every line that
  // does not use one is noise. Only a ticked box is worth the space.
  if (typeof value === 'boolean') return value ? 'yes' : ''
  if (Array.isArray(value)) return value.filter((each) => each !== '' && each != null).join(', ')
  return String(value).trim()
}

// ── Where the show has actually got to ──────────────────────────────────────

/**
 * The item somebody has marked as on, and when they marked it.
 *
 * Its own tiny topic rather than a field on the running order: this changes on
 * every Next — dozens of times on a busy evening — and the running order it
 * would ride on is tens of kilobytes of sessions, items, templates and roster.
 *
 * Stored as a `$`-prefixed settings flag rather than a table, for the same
 * reasons the operating mode is: it is a singleton, and the `$` namespace is
 * wiped when an event is duplicated — which is exactly right, because a copy
 * of last year's festival must not open halfway through last year's show.
 */
export const livePositionSchema = z.object({
  itemId: z.string().nullable(),
  /** When it was marked, not when it was planned. Null with no position. */
  startedAt: z.number().nullable(),
})
export type LivePosition = z.infer<typeof livePositionSchema>

export const NO_POSITION: LivePosition = { itemId: null, startedAt: null }

/** Mark an item as on now, or clear the position with null. */
export const setPositionSchema = z.object({ itemId: z.string().nullable() })
export type SetPosition = z.infer<typeof setPositionSchema>

/**
 * One step forward or back.
 *
 * Only ±1: a caller wanting to jump names the item. Accepting an arbitrary
 * offset would let a stale page — and a page pressing Next is often minutes
 * stale — land somewhere neither it nor the server meant.
 */
export const stepPositionSchema = z.object({ by: z.union([z.literal(1), z.literal(-1)]) })
export type StepPosition = z.infer<typeof stepPositionSchema>

/** How a row on the board relates to where the show has got to. */
export type ItemState = 'done' | 'now' | 'next' | 'later'

export interface TimelineRow {
  item: RunningItem
  sessionId: string
  /** Where the plan said it would start. */
  plannedAt: number
  /** Where it is now expected, given where the show has actually got to. */
  expectedAt: number
  state: ItemState
}

export interface Timeline {
  rows: TimelineRow[]
  /**
   * Positive when the show is behind, negative when it is ahead, zero when
   * nobody has marked a position. This is the number a board renders as
   * "running four minutes behind".
   */
  behindMs: number
}

/**
 * The running order, re-timed against where the show has actually got to.
 *
 * With nothing marked this is just the plan: `expectedAt === plannedAt` and
 * `behindMs` is zero. Marking an item shifts everything from that item onward
 * by how late it started, and — once it has run past its own duration —
 * by the overrun as well. Nothing before it moves: what has already happened
 * happened, whatever the plan said.
 *
 * Overrun matters more than lateness. A talk that started on time and has been
 * going for fifty minutes against a thirty-minute slot is twenty minutes
 * behind, and a board that only compared start times would still be claiming
 * the evening was on schedule.
 */
export function timeline(
  sessions: readonly SessionWithItems[],
  position: LivePosition,
  now: number,
): Timeline {
  const rows: TimelineRow[] = []
  const ordered = [...sessions].sort((a, b) => a.startsAt - b.startsAt || a.sortOrder - b.sortOrder)

  for (const session of ordered) {
    const starts = plannedStarts(session)
    session.items.forEach((item, index) => {
      rows.push({
        item,
        sessionId: session.id,
        plannedAt: starts[index] ?? session.startsAt,
        expectedAt: starts[index] ?? session.startsAt,
        state: 'later',
      })
    })
  }

  const at =
    position.itemId === null ? -1 : rows.findIndex((row) => row.item.id === position.itemId)
  // A marked item that has since been deleted, or a position from another
  // event: the plan is the honest answer, not a shift computed from nothing.
  if (at < 0 || position.startedAt === null) {
    if (rows[0]) rows[0].state = 'next'
    return { rows, behindMs: 0 }
  }

  const current = rows[at] as TimelineRow
  const ranFor = Math.max(0, now - position.startedAt)
  const overran = Math.max(0, ranFor - current.item.durationSeconds * 1_000)
  const behindMs = position.startedAt - current.plannedAt + overran

  for (const [index, row] of rows.entries()) {
    if (index < at) {
      row.state = 'done'
      continue
    }
    row.state = index === at ? 'now' : index === at + 1 ? 'next' : 'later'
    // The current item's own start is where it actually started, not where the
    // plan plus an overrun would put it.
    row.expectedAt = index === at ? position.startedAt : row.plannedAt + behindMs
  }

  return { rows, behindMs }
}

/** How far behind, said the way a production office says it. */
export function behindLabel(behindMs: number): string {
  const minutes = Math.round(Math.abs(behindMs) / 60_000)
  if (minutes === 0) return 'on time'
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return behindMs > 0 ? `${span} behind` : `${span} ahead`
}

// ── Reading the clock ───────────────────────────────────────────────────────

/**
 * When each item in a session is due to start.
 *
 * Returned as a list parallel to `items`, so a caller can zip it without
 * having to trust that both were sorted the same way. Purely the plan: a
 * session's start plus every duration before this one.
 */
export function plannedStarts(session: SessionWithItems): number[] {
  const starts: number[] = []
  let at = session.startsAt
  for (const item of session.items) {
    starts.push(at)
    at += item.durationSeconds * 1_000
  }
  return starts
}

/** When a session's items run out, which may be past its stated end. */
export function plannedEnd(session: SessionWithItems): number {
  const total = session.items.reduce((sum, item) => sum + item.durationSeconds * 1_000, 0)
  // An empty session is its stated end, or its start if it has none — doors is
  // an instant, and "on now until midnight" is worse than nothing.
  if (total === 0) return session.endsAt ?? session.startsAt
  return session.startsAt + total
}

/**
 * The next session due after `now`, or null once the running order has run out.
 *
 * Shared so the countdown widget and the server agree on what "next" means —
 * two definitions of that would show a crew two different numbers.
 */
export function nextSession(
  sessions: readonly RunningSession[],
  now: number,
): RunningSession | null {
  let soonest: RunningSession | null = null
  for (const session of sessions) {
    if (session.startsAt <= now) continue
    if (!soonest || session.startsAt < soonest.startsAt) soonest = session
  }
  return soonest
}
