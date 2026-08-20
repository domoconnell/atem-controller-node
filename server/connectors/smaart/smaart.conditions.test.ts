import { describe, expect, it } from 'vitest'
import { smaartConditions } from './conditions.js'

const paramOptions = (id: string) => {
  const condition = smaartConditions.find((each) => each.id === id)
  if (!condition?.paramOptions) throw new Error(`${id} offers no parameter options`)
  return condition.paramOptions.bind(condition)
}

const RECORDED = [
  'spl.splASlow',
  'spl.laeq5',
  // Two naming eras, which is not hypothetical: this project's own development
  // database holds both, months apart.
  'spl.SPLASlow',
  'spl.LAeq5',
  // Another stream's series, which must not appear in a sound level list.
  'channels.battery',
]

describe('what the rule editor is offered for an SPL metric', () => {
  it('offers what the module is publishing right now', () => {
    const options = paramOptions('spl.over')({
      payload: { splASlow: 92.4, laeq5: 88.1, at: 1_700_000_000_000 },
      recordedSeries: [],
    })

    expect(options.metric?.map((option) => option.value)).toEqual(['splASlow', 'laeq5'])
  })

  it('ignores anything in the frame that is not a reading', () => {
    // A timestamp is a number too. Offering `at` as a sound level metric would
    // produce a rule that fires on the clock.
    const options = paramOptions('spl.over')({
      payload: { splASlow: 92.4, source: 'Smaart', ok: true },
      recordedSeries: [],
    })

    expect(options.metric?.map((option) => option.value)).toEqual(['splASlow'])
  })

  it('names the recognised windows, and leaves the others alone', () => {
    const options = paramOptions('spl.over')({
      payload: { splASlow: 92.4, someCustomWindow: 70 },
      recordedSeries: [],
    })

    const bySlug = new Map(options.metric?.map((option) => [option.value, option.label]))
    expect(bySlug.get('splASlow')).toBe('splASlow — SPL A Slow')
    // A window configured inside Smaart has no name here to give, and is
    // offered as itself rather than dropped.
    expect(bySlug.get('someCustomWindow')).toBeUndefined()
    expect(bySlug.has('someCustomWindow')).toBe(true)
  })

  it('puts recognised windows first, so the list opens on something familiar', () => {
    const options = paramOptions('spl.over')({
      payload: { aaaCustom: 70, splASlow: 92.4 },
      recordedSeries: [],
    })

    // Alphabetically `aaaCustom` would lead. Ordering, never filtering: the
    // custom window is still there, because it may be the one somebody's
    // licence is written around.
    expect(options.metric?.map((option) => option.value)).toEqual(['splASlow', 'aaaCustom'])
  })

  it('falls back to what was recorded when the module is switched off', () => {
    // The week before load-in, with nothing plugged in, is exactly when the
    // alert rules get written.
    const options = paramOptions('spl.over')({ payload: null, recordedSeries: RECORDED })

    const values = options.metric?.map((option) => option.value) ?? []
    expect(values).toContain('splASlow')
    // Only this stream's series: a battery reading is not a sound level.
    expect(values).not.toContain('battery')
  })

  it('does not mix a season of recordings into a live answer', () => {
    /*
     * The trap this guards. A rig accumulates names it has stopped using, and
     * merging them into the live list invites a rule written on a series that
     * can never arrive again — saved without complaint, and silent for ever.
     */
    const options = paramOptions('spl.over')({
      payload: { splASlow: 92.4 },
      recordedSeries: RECORDED,
    })

    expect(options.metric?.map((option) => option.value)).toEqual(['splASlow'])
  })

  it('offers the same list to the went-quiet condition', () => {
    // Both metric-taking conditions read the same stream, and a list that
    // appeared on one and not the other would be a puzzle.
    const options = paramOptions('spl.silent')({ payload: { splASlow: 40 }, recordedSeries: [] })
    expect(options.metric?.map((option) => option.value)).toEqual(['splASlow'])
  })
})
