import { describe, expect, it } from 'vitest'
import { packAllBreakpoints, packLayout } from './pack.js'
import type { LayoutItem } from './profile.js'

/**
 * Sorting a dashboard is a destructive-feeling button: one press moves and
 * resizes every widget on a board somebody spent a weekend arranging. So the
 * properties matter more than any single arrangement — nothing may overlap,
 * nothing may fall off the edge, every row must fill the width and have a flat
 * bottom, and pressing it twice must not keep shuffling things.
 */

const at = (i: string, x: number, y: number, w: number, h: number): LayoutItem => ({
  i,
  x,
  y,
  w,
  h,
})

/** Every cell each item covers, for overlap and bounds checks. */
const cells = (items: readonly LayoutItem[]): string[] => {
  const out: string[] = []
  for (const item of items) {
    for (let x = item.x; x < item.x + item.w; x++) {
      for (let y = item.y; y < item.y + item.h; y++) out.push(`${x},${y}`)
    }
  }
  return out
}

const bottom = (items: readonly LayoutItem[]): number =>
  items.reduce((low, item) => Math.max(low, item.y + item.h), 0)

describe('packLayout', () => {
  const board: LayoutItem[] = [
    at('a', 0, 0, 3, 2),
    at('b', 6, 0, 3, 2),
    at('c', 0, 5, 4, 2),
    at('d', 9, 9, 3, 3),
  ]

  it('never overlaps and never runs off the edge', () => {
    const packed = packLayout(board, 12)
    const covered = cells(packed)

    expect(new Set(covered).size).toBe(covered.length)
    for (const item of packed) {
      expect(item.x).toBeGreaterThanOrEqual(0)
      expect(item.x + item.w).toBeLessThanOrEqual(12)
      expect(item.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('leaves no empty cell anywhere in the board', () => {
    // The whole complaint about the first version: it packed tightly and left
    // 22% of a fifteen-widget grid empty, because widths never summed to
    // twelve and short widgets left holes underneath them.
    const packed = packLayout(board, 12)
    const tallest = bottom(packed)

    expect(cells(packed)).toHaveLength(12 * tallest)
  })

  it('fills the width on every row', () => {
    const packed = packLayout(board, 12)
    const rows = new Map<number, number>()
    for (const item of packed) rows.set(item.y, (rows.get(item.y) ?? 0) + item.w)

    for (const [y, width] of rows) expect(width, `row at y=${y}`).toBe(12)
  })

  it('lifts a short widget to the height of its row', () => {
    // The board above happens to have even heights within each row, so it
    // cannot tell a working flatten from a broken one. This one can: three
    // widgets of different heights sharing a row all come out at the tallest.
    const ragged = [at('short', 0, 0, 4, 2), at('tall', 4, 0, 4, 5), at('middling', 8, 0, 4, 3)]
    const packed = packLayout(ragged, 12)

    expect(packed.map((item) => item.h)).toEqual([5, 5, 5])
  })

  it('gives every row a flat bottom edge', () => {
    // A short widget beside a tall one is the gap that makes a board look
    // broken rather than sparse.
    const packed = packLayout(board, 12)
    const bottoms = new Map<number, Set<number>>()
    for (const item of packed) {
      const seen = bottoms.get(item.y) ?? new Set<number>()
      seen.add(item.y + item.h)
      bottoms.set(item.y, seen)
    }

    for (const [y, edges] of bottoms) expect(edges.size, `row at y=${y}`).toBe(1)
  })

  it('keeps every widget, and never shrinks one', () => {
    const packed = packLayout(board, 12)

    expect(packed.map((item) => item.i)).toEqual(['a', 'b', 'c', 'd'])
    for (const before of board) {
      const after = packed.find((item) => item.i === before.i)
      expect(after?.w).toBeGreaterThanOrEqual(before.w)
      expect(after?.h).toBeGreaterThanOrEqual(before.h)
    }
  })

  it('carries the minimums through untouched', () => {
    // These are what stop a widget being resized into uselessness; a tidy-up
    // that quietly dropped them would only show up much later, as a widget
    // that can suddenly be crushed.
    const withMins: LayoutItem[] = [{ ...at('a', 4, 4, 3, 2), minW: 2, minH: 2 }]
    expect(packLayout(withMins, 12)[0]).toMatchObject({ minW: 2, minH: 2 })
  })

  it('preserves reading order rather than packing as tightly as possible', () => {
    // A size-first packer would fit more in and would also move the thing the
    // operator reads first somewhere they do not expect.
    const packed = packLayout([at('first', 0, 0, 6, 4), at('second', 0, 8, 6, 1)], 12)

    expect(packed.find((item) => item.i === 'first')).toMatchObject({ x: 0, y: 0 })
    expect(packed.find((item) => item.i === 'second')).toMatchObject({ x: 6, y: 0 })
  })

  it('stretches a lone widget across the row rather than leaving it short', () => {
    expect(packLayout([at('only', 0, 0, 3, 2)], 12)[0]).toMatchObject({ x: 0, y: 0, w: 12 })
  })

  it('shares the spare columns out evenly, from the left', () => {
    // 3 + 3 + 3 of twelve leaves three going spare, one to each.
    const packed = packLayout([at('a', 0, 0, 3, 2), at('b', 3, 0, 3, 2), at('c', 6, 0, 3, 2)], 12)
    expect(packed.map((item) => item.w)).toEqual([4, 4, 4])
  })

  it('settles: packing a packed board changes nothing', () => {
    // Auto-arrange runs this after every add, remove and resize. If it were
    // not idempotent the board would creep on its own between saves.
    const once = packLayout(board, 12)
    expect(packLayout(once, 12)).toEqual(once)
  })

  it('is deterministic, so two devices agree', () => {
    expect(packLayout(board, 12)).toEqual(packLayout(board, 12))
  })

  it('trims a widget too wide for the breakpoint instead of hanging', () => {
    // Reachable by hand-editing a layout, and the alternative is a search for
    // a slot that can never exist.
    expect(packLayout([at('wide', 0, 0, 9, 2)], 4)[0]).toMatchObject({ x: 0, w: 4 })
  })

  it('copes with an empty board', () => {
    expect(packLayout([], 12)).toEqual([])
  })
})

/**
 * Adding widgets one at a time, which is the only way anybody adds them.
 *
 * Tidying writes stretched widths back into the layout, so a tidy that reads
 * those as the widget's own choice compounds: the first widget is stretched
 * across the whole grid alone, and nothing can ever share a row with it again.
 * Two widgets came out as two full-width strips, and the idempotence test
 * above could not see it because it only ever fed one board through twice.
 */
describe('packLayout, told what each widget actually asks for', () => {
  const natural = (sizes: Record<string, number>) => (id: string) =>
    sizes[id] ? { w: sizes[id] as number, h: 3 } : undefined

  it('lets two narrow widgets share a row, however they were stretched before', () => {
    // Both arrive twelve wide, because a previous tidy stretched them.
    const stretched = [at('clock', 0, 0, 12, 3), at('weather', 0, 3, 12, 5)]
    const packed = packLayout(stretched, 12, natural({ clock: 3, weather: 3 }))

    expect(packed.map((item) => `${item.i} x${item.x} y${item.y} w${item.w}`)).toEqual([
      'clock x0 y0 w6',
      'weather x6 y0 w6',
    ])
  })

  it('settles: adding one at a time gives the board you would get all at once', () => {
    const sizes = natural({ a: 4, b: 3, c: 4, d: 3 })
    // Dropped in at the bottom, exactly as the dashboard adds one, so a new
    // widget joins the end of the reading order rather than the front.
    const arriving = ['a', 'b', 'c', 'd'].map((id) => at(id, 0, Number.MAX_SAFE_INTEGER, 3, 2))

    let board: ReturnType<typeof packLayout> = []
    for (const item of arriving) board = packLayout([...board, item], 12, sizes)

    const together = packLayout(arriving, 12, sizes)
    expect(board.map((i) => `${i.i} x${i.x} y${i.y} ${i.w}x${i.h}`)).toEqual(
      together.map((i) => `${i.i} x${i.x} y${i.y} ${i.w}x${i.h}`),
    )
  })
})

describe('packAllBreakpoints', () => {
  it('packs each breakpoint against its own column count', () => {
    const item = at('a', 3, 6, 4, 2)
    const packed = packAllBreakpoints({ lg: [item], md: [item], sm: [item] })

    // Alone on its row, so it fills whatever that breakpoint's width is.
    expect(packed.lg[0]).toMatchObject({ x: 0, y: 0, w: 12 })
    expect(packed.md[0]).toMatchObject({ x: 0, y: 0, w: 8 })
    expect(packed.sm[0]).toMatchObject({ x: 0, y: 0, w: 4 })
  })
})
