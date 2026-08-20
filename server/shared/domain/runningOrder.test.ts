import { describe, expect, it } from 'vitest'
import {
  behindLabel,
  createItemSchema,
  createSessionSchema,
  FIELD_KINDS,
  fieldChoices,
  fieldsToJsonSchema,
  type ItemField,
  type ItemType,
  itemDetails,
  itemKit,
  type Kit,
  NO_POSITION,
  nextSession,
  OFFERED_FIELD_KINDS,
  plannedEnd,
  plannedStarts,
  type Roster,
  type RunningItem,
  type RunningSession,
  type SessionWithItems,
  timeline,
} from './runningOrder.js'

const at = (hour: number, minute = 0) => new Date(2026, 7, 8, hour, minute).getTime()

const session = (over: Partial<SessionWithItems> = {}): SessionWithItems => ({
  id: 's1',
  name: 'Evening Celebration',
  kind: 'set',
  startsAt: at(19, 30),
  endsAt: at(21),
  notes: '',
  armsShowMode: false,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  items: [],
  ...over,
})

const item = (name: string, minutes: number, over: Partial<RunningItem> = {}): RunningItem => ({
  id: `i-${name}`,
  sessionId: 's1',
  name,
  description: '',
  durationSeconds: minutes * 60,
  typeId: null,
  details: {},
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('when each item is due', () => {
  it('stacks durations from the session start', () => {
    const starts = plannedStarts(
      session({ items: [item('Welcome', 5), item('Worship', 25), item('Notices', 5)] }),
    )
    expect(starts).toEqual([at(19, 30), at(19, 35), at(20, 0)])
  })

  it('lets a zero-length item sit at the same minute as the next', () => {
    // A marker with no length of its own is legitimate — "band in position"
    // happens at a moment, and giving it a minute it does not need would push
    // everything after it out by one.
    const starts = plannedStarts(session({ items: [item('In position', 0), item('Song', 4)] }))
    expect(starts).toEqual([at(19, 30), at(19, 30)])
  })

  it('runs an over-long session past its stated end rather than truncating', () => {
    // The stated end is what somebody typed; the durations are what they then
    // filled it with. Silently clipping the last item would hide the overrun,
    // which is the one thing a running order must not do.
    const over = session({ items: [item('Talk', 120)] })
    expect(plannedEnd(over)).toBe(at(21, 30))
    expect(plannedEnd(over)).toBeGreaterThan(over.endsAt ?? 0)
  })

  it('treats an empty session as its stated end, or an instant', () => {
    expect(plannedEnd(session({ items: [] }))).toBe(at(21))
    // Doors and curfew are instants. "On now until midnight" is worse than
    // nothing — the same reasoning the old flat list settled on.
    expect(plannedEnd(session({ items: [], endsAt: null }))).toBe(at(19, 30))
  })
})

describe('the next session', () => {
  // Deliberately typed as the bare session rather than one with items: the
  // countdown is handed whatever the topic carries, and it must not start
  // depending on a field it has no use for.
  const plain = (id: string, startsAt: number): RunningSession => session({ id, startsAt })

  it('finds the soonest one still to come', () => {
    const sessions = [plain('a', at(21)), plain('b', at(19)), plain('c', at(20))]
    expect(nextSession(sessions, at(18))?.id).toBe('b')
    expect(nextSession(sessions, at(19, 30))?.id).toBe('c')
  })

  it('treats one starting exactly now as started', () => {
    expect(nextSession([plain('a', at(19))], at(19))).toBeNull()
  })

  it('runs out rather than wrapping round', () => {
    expect(nextSession([plain('a', at(19))], at(23))).toBeNull()
  })
})

describe('what a write will accept', () => {
  it('fills in the parts nobody typed', () => {
    const parsed = createSessionSchema.parse({ name: 'Doors', startsAt: at(18) })
    expect(parsed).toMatchObject({ kind: 'other', endsAt: null, notes: '', armsShowMode: false })
  })

  it('refuses a session that ends before it starts', () => {
    const bad = createSessionSchema.safeParse({ name: 'Set', startsAt: at(21), endsAt: at(20) })
    expect(bad.success).toBe(false)
  })

  it('refuses a duration that is obviously a typo', () => {
    // Twelve hours is the cap. Somebody meaning 4 minutes and typing 4 hours is
    // recoverable; 400 hours quietly re-times the rest of the festival.
    expect(createItemSchema.safeParse({ name: 'Song', durationSeconds: 400 * 3_600 }).success).toBe(
      false,
    )
    expect(createItemSchema.safeParse({ name: 'Song', durationSeconds: 240 }).success).toBe(true)
  })

  it('gives an item empty details rather than none', () => {
    // The form writes into this object, so it has to exist before a type is
    // ever picked.
    expect(createItemSchema.parse({ name: 'Song' }).details).toEqual({})
  })
})

/**
 * Turning a template somebody typed into a form.
 *
 * The fields are data, not code, so this conversion is the whole reason a
 * "Song" type can exist without anybody writing a Song form. It runs on every
 * open of the item dialogue, and getting it wrong shows up as a field that is
 * missing rather than as an error.
 */
describe('a template as a form', () => {
  const roster = {
    people: [
      {
        id: 'p1',
        name: 'Kate Nkemelu',
        role: 'Worship leader',
        notes: '',
        createdAt: 0,
        updatedAt: 0,
      },
      { id: 'p2', name: 'Ada Okafor', role: '', notes: '', createdAt: 0, updatedAt: 0 },
    ],
    kit: [
      {
        id: 'k1',
        name: 'Handheld 4',
        kind: 'mic' as const,
        notes: '',
        instanceId: null,
        channelKey: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  }

  const field = (over: Partial<ItemField> = {}): ItemField => ({
    id: 'f1',
    label: 'Key',
    kind: 'text',
    choices: [],
    required: false,
    ...over,
  })

  it('keys the schema by id and titles it by label', () => {
    // The two are deliberately different: `details` is stored against the id,
    // so relabelling a field must not move where its values live.
    const schema = fieldsToJsonSchema([field({ id: 'f-key', label: 'Key' })])
    expect(schema.properties['f-key']).toEqual({ type: 'string', title: 'Key' })
  })

  it('maps each kind to something SchemaForm can render', () => {
    const schema = fieldsToJsonSchema([
      field({ id: 'a', kind: 'text' }),
      field({ id: 'b', kind: 'number' }),
      field({ id: 'c', kind: 'boolean' }),
      field({ id: 'd', kind: 'choice', choices: ['G', 'Am'] }),
    ])
    expect(schema.properties.a?.type).toBe('string')
    expect(schema.properties.b?.type).toBe('number')
    expect(schema.properties.c?.type).toBe('boolean')
    // A choice is a string in the schema and a picker through `choices`, so
    // the options render as typed rather than title-cased by the form.
    expect(schema.properties.d?.type).toBe('string')
  })

  it('gives the many-valued kinds an array of strings', () => {
    const schema = fieldsToJsonSchema([field({ id: 'p', kind: 'people' })])
    expect(schema.properties.p).toEqual({
      type: 'array',
      title: 'Key',
      items: { type: 'string' },
    })
  })

  it('carries required through, because the form marks it', () => {
    const schema = fieldsToJsonSchema([
      field({ id: 'a', required: true }),
      field({ id: 'b', required: false }),
    ])
    expect(schema.required).toEqual(['a'])
  })

  it('offers a choice field its options, and nothing else one', () => {
    const choices = fieldChoices([
      field({ id: 'key', kind: 'choice', choices: ['G', 'Am'] }),
      field({ id: 'lead', kind: 'text' }),
      // An empty list is not a picker with nothing in it — that would be a
      // field an admin could not fill in at all.
      field({ id: 'empty', kind: 'choice', choices: [] }),
    ])
    expect(choices.key).toEqual([
      { value: 'G', label: 'G' },
      { value: 'Am', label: 'Am' },
    ])
    expect(choices.lead).toBeUndefined()
    expect(choices.empty).toBeUndefined()
  })

  it('offers a person field the roster rather than a typed-in list', () => {
    // Ids as values, names as labels. That is what makes correcting somebody's
    // name reach every item that mentions them at once.
    const choices = fieldChoices([field({ id: 'who', kind: 'person' })], roster)
    expect(choices.who).toEqual([
      { value: 'p1', label: 'Kate Nkemelu — Worship leader' },
      { value: 'p2', label: 'Ada Okafor' },
    ])
  })

  it('offers kit to both the one-of and the several-of kinds', () => {
    const choices = fieldChoices(
      [field({ id: 'a', kind: 'kit' }), field({ id: 'b', kind: 'kitMany' })],
      roster,
    )
    expect(choices.a).toEqual([{ value: 'k1', label: 'Handheld 4' }])
    expect(choices.b).toEqual(choices.a)
  })

  it('offers nothing at all when the roster is empty', () => {
    // Not a picker with no options in it — that is a field an admin cannot
    // fill in and cannot tell why.
    expect(fieldChoices([field({ id: 'who', kind: 'person' })])).toEqual({})
  })

  it('only offers the kinds that have a control behind them', () => {
    // The contract declares every kind so adding one later is a UI change, not
    // a migration. The editor must not get ahead of the form.
    for (const kind of OFFERED_FIELD_KINDS) {
      expect(FIELD_KINDS).toContain(kind)
    }
    // `longtext` is the one still held back: SchemaForm has no textarea, and a
    // "Long text" that renders the same one-line box as "Text" is a promise
    // the form does not keep.
    expect(OFFERED_FIELD_KINDS).not.toContain('longtext')
    expect(OFFERED_FIELD_KINDS).toContain('person')
  })
})

describe('what an item’s details say', () => {
  const roster = {
    people: [
      {
        id: 'p1',
        name: 'Kate Nkemelu',
        role: 'Worship leader',
        notes: '',
        createdAt: 0,
        updatedAt: 0,
      },
      { id: 'p2', name: 'Ada Okafor', role: '', notes: '', createdAt: 0, updatedAt: 0 },
    ],
    kit: [
      {
        id: 'k1',
        name: 'Handheld 4',
        kind: 'mic' as const,
        notes: '',
        instanceId: null,
        channelKey: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  }

  const type = (fields: ItemField[]): ItemType => ({
    id: 't1',
    name: 'Song',
    fields,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  })

  const field = (id: string, label: string, kind: ItemField['kind'] = 'text'): ItemField => ({
    id,
    label,
    kind,
    choices: [],
    required: false,
  })

  const detailed = (details: Record<string, unknown>) => ({ typeId: 't1', details })

  it('reads in the order the template lists them, not the order they were typed', () => {
    const types = [type([field('key', 'Key'), field('lead', 'Lead')])]
    // Written lead-first on purpose.
    const shown = itemDetails(detailed({ lead: 'Kate', key: 'G' }), types)
    expect(shown).toEqual([
      { label: 'Key', value: 'G' },
      { label: 'Lead', value: 'Kate' },
    ])
  })

  it('leaves out what nobody filled in', () => {
    // "Key —, Lead —, Capo —" against every song is three columns of nothing.
    const types = [type([field('key', 'Key'), field('capo', 'Capo')])]
    expect(itemDetails(detailed({ key: 'G', capo: '  ' }), types)).toEqual([
      { label: 'Key', value: 'G' },
    ])
  })

  it('shows a ticked box and stays quiet about an unticked one', () => {
    const types = [type([field('click', 'Click track', 'boolean')])]
    expect(itemDetails(detailed({ click: true }), types)).toEqual([
      { label: 'Click track', value: 'yes' },
    ])
    expect(itemDetails(detailed({ click: false }), types)).toEqual([])
  })

  it('keeps a value the template no longer has a field for, and does not show it', () => {
    // Renaming a field by removing it and adding another must not be a way to
    // lose what people typed. It stays in `details`; it just stops appearing.
    const types = [type([field('key', 'Key')])]
    expect(itemDetails(detailed({ key: 'G', oldLead: 'Kate' }), types)).toEqual([
      { label: 'Key', value: 'G' },
    ])
  })

  it('reads a person reference back as a name, not as an id', () => {
    // Stored by id so a correction reaches every item at once; shown as a
    // name because nobody on a headset can read a sixteen-character key.
    const types = [type([field('who', 'Speaking', 'person')])]
    expect(itemDetails(detailed({ who: 'p2' }), types, roster)).toEqual([
      { label: 'Speaking', value: 'Ada Okafor' },
    ])
  })

  it('joins several people, in the order they were picked', () => {
    const types = [type([field('who', 'Speaking', 'people')])]
    expect(itemDetails(detailed({ who: ['p2', 'p1'] }), types, roster)).toEqual([
      { label: 'Speaking', value: 'Ada Okafor, Kate Nkemelu' },
    ])
  })

  it('says a reference is gone rather than printing the key or hiding it', () => {
    /*
     * Somebody removed from the roster mid-build. Printing the id teaches a
     * stage manager nothing; dropping the row quietly turns a talk with a
     * speaker into a talk with nobody, which is the worse of the two.
     */
    const types = [type([field('who', 'Speaking', 'person')])]
    expect(itemDetails(detailed({ who: 'p-gone' }), types, roster)).toEqual([
      { label: 'Speaking', value: '(removed)' },
    ])
  })

  it('does not go looking in the roster for a field that is just words', () => {
    // A `text` field holding the string "p1" is the word p1, not a person.
    const types = [type([field('note', 'Note', 'text')])]
    expect(itemDetails(detailed({ note: 'p1' }), types, roster)).toEqual([
      { label: 'Note', value: 'p1' },
    ])
  })

  it('says nothing at all for an item whose type has been deleted', () => {
    // `type_id` goes null on delete and the details outlive it. Without a
    // template there is nothing to label them with.
    expect(itemDetails({ typeId: null, details: { key: 'G' } }, [])).toEqual([])
  })
})

/**
 * Where the show has actually got to.
 *
 * The one piece of arithmetic in the product that a crew watches all evening,
 * and the one nobody can check by reading: a board saying "on time" while the
 * talk has been going twenty minutes over is worse than a board saying nothing.
 */
describe('the running order, re-timed', () => {
  const start = at(19, 30)

  const withItems = (...minutes: number[]): SessionWithItems =>
    session({
      startsAt: start,
      items: minutes.map((length, index) => item(`i${index}`, length, { id: `i${index}` })),
    })

  it('is just the plan until somebody marks a position', () => {
    const { rows, behindMs } = timeline([withItems(10, 20)], NO_POSITION, at(20))
    expect(behindMs).toBe(0)
    expect(rows.map((row) => row.expectedAt)).toEqual([start, at(19, 40)])
    expect(rows.every((row) => row.expectedAt === row.plannedAt)).toBe(true)
  })

  it('names the first item as next before anything has started', () => {
    const { rows } = timeline([withItems(10, 20)], NO_POSITION, at(19))
    expect(rows.map((row) => row.state)).toEqual(['next', 'later'])
  })

  it('shifts everything after a late start, and nothing before it', () => {
    // The second item was due at 19:40 and was marked on at 19:45.
    const { rows, behindMs } = timeline(
      [withItems(10, 20, 15)],
      { itemId: 'i1', startedAt: at(19, 45) },
      at(19, 46),
    )
    expect(behindMs).toBe(5 * 60_000)
    // What already happened happened, whatever the plan said.
    expect(rows[0]?.expectedAt).toBe(rows[0]?.plannedAt)
    // The current item sits where it actually started.
    expect(rows[1]?.expectedAt).toBe(at(19, 45))
    expect(rows[2]?.expectedAt).toBe(at(20, 5))
  })

  it('counts an overrun as behind, not only a late start', () => {
    /*
     * The failure a board that only compares start times cannot see: a talk
     * that began exactly on time and has been running fifty minutes against a
     * thirty-minute slot. On-time start, twenty minutes behind.
     */
    const { behindMs, rows } = timeline(
      [withItems(30, 15)],
      { itemId: 'i0', startedAt: start },
      at(20, 20),
    )
    expect(behindMs).toBe(20 * 60_000)
    expect(rows[1]?.expectedAt).toBe(at(20, 20))
  })

  it('does not call a session ahead of itself while an item is still inside its slot', () => {
    // Twelve minutes into a thirty-minute item that started on time: not
    // behind, not ahead, and certainly not finished.
    const { behindMs } = timeline([withItems(30)], { itemId: 'i0', startedAt: start }, at(19, 42))
    expect(behindMs).toBe(0)
  })

  it('reports ahead when something was marked on early', () => {
    const { behindMs } = timeline(
      [withItems(10, 20)],
      { itemId: 'i1', startedAt: at(19, 35) },
      at(19, 36),
    )
    expect(behindMs).toBe(-5 * 60_000)
  })

  it('marks what is done, what is on and what is next', () => {
    const { rows } = timeline(
      [withItems(10, 20, 15, 5)],
      { itemId: 'i1', startedAt: at(19, 40) },
      at(19, 45),
    )
    expect(rows.map((row) => row.state)).toEqual(['done', 'now', 'next', 'later'])
  })

  it('falls back to the plan when the marked item is not on the running order', () => {
    // Somebody deleted the item that was marked, or the flag survived from
    // another event. A shift computed from nothing would be a made-up number
    // on a board somebody is trusting.
    const { rows, behindMs } = timeline(
      [withItems(10, 20)],
      { itemId: 'gone', startedAt: at(19, 45) },
      at(19, 46),
    )
    expect(behindMs).toBe(0)
    expect(rows.every((row) => row.expectedAt === row.plannedAt)).toBe(true)
  })

  it('carries the shift across a session boundary', () => {
    // The evening runs late, so the thing after it starts late too — which is
    // the whole reason anybody looks at this number.
    const later = session({
      id: 's2',
      startsAt: at(21),
      items: [item('Curfew call', 5, { id: 'j0', sessionId: 's2' })],
    })
    const { rows } = timeline(
      [withItems(10, 20), later],
      { itemId: 'i1', startedAt: at(19, 50) },
      at(19, 51),
    )
    expect(rows[2]?.expectedAt).toBe(at(21, 10))
  })
})

describe('saying how far behind', () => {
  it('says on time rather than nought minutes', () => {
    expect(behindLabel(0)).toBe('on time')
    // Under half a minute either way is on time, not "0m behind".
    expect(behindLabel(20_000)).toBe('on time')
  })

  it('says which way it is going', () => {
    expect(behindLabel(4 * 60_000)).toBe('4m behind')
    expect(behindLabel(-4 * 60_000)).toBe('4m ahead')
  })

  it('switches to hours once minutes stop being readable', () => {
    expect(behindLabel(95 * 60_000)).toBe('1h 35m behind')
  })
})

/**
 * Which microphones an item needs.
 *
 * The lookup P5 hangs off: a board asks this, then asks the receiver those
 * channels are on how they are doing. Resolving to roster rows rather than to
 * ids is deliberate — the name and the channel come from one place, so the
 * label on the board and the reading beside it cannot end up describing
 * different microphones.
 */
describe('the kit an item needs', () => {
  const mic = (id: string, name: string, channelKey: string | null = null): Kit => ({
    id,
    name,
    kind: 'mic',
    notes: '',
    instanceId: channelKey === null ? null : 'rack1',
    channelKey,
    createdAt: 0,
    updatedAt: 0,
  })

  const roster: Roster = {
    people: [],
    kit: [mic('k1', 'Handheld 4', '1'), mic('k2', 'Lapel 1', '2'), mic('k3', 'Lectern')],
  }

  const field = (id: string, kind: ItemField['kind']): ItemField => ({
    id,
    label: id,
    kind,
    choices: [],
    required: false,
  })

  const type = (id: string, fields: ItemField[]): ItemType => ({
    id,
    name: id,
    fields,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  })

  it('resolves one and several alike, in roster order', () => {
    const talk = type('talk', [field('mic', 'kit'), field('spares', 'kitMany')])
    // Named k2-then-k1 on purpose: the answer is roster order, so two items
    // needing the same pair list them the same way round.
    const found = itemKit(
      { typeId: 'talk', details: { mic: 'k2', spares: ['k1'] } },
      [talk],
      roster,
    )
    expect(found.map((each) => each.name)).toEqual(['Handheld 4', 'Lapel 1'])
  })

  it('carries the receiver channel through, which is the whole point', () => {
    const talk = type('talk', [field('mic', 'kit')])
    const found = itemKit({ typeId: 'talk', details: { mic: 'k1' } }, [talk], roster)
    expect(found[0]).toMatchObject({ instanceId: 'rack1', channelKey: '1' })
  })

  it('includes kit that is not on a receiver, because it is still kit', () => {
    // A lectern mic on a cable belongs on the board; it just has no battery.
    const talk = type('talk', [field('mic', 'kit')])
    const found = itemKit({ typeId: 'talk', details: { mic: 'k3' } }, [talk], roster)
    expect(found).toEqual([roster.kit[2]])
  })

  it('ignores a person field, and a word that looks like an id', () => {
    const talk = type('talk', [field('who', 'person'), field('note', 'text')])
    expect(itemKit({ typeId: 'talk', details: { who: 'k1', note: 'k2' } }, [talk], roster)).toEqual(
      [],
    )
  })

  it('finds nothing for an item whose type has been deleted', () => {
    expect(itemKit({ typeId: null, details: { mic: 'k1' } }, [], roster)).toEqual([])
  })
})
