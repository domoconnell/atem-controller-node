import { BREAKPOINT_COLS, type Breakpoint, type LayoutItem } from './profile.js'

/**
 * Tidies a dashboard into rows.
 *
 * react-grid-layout compacts vertically as you drag, which pulls widgets up
 * but never sideways — so a board built over a weekend ends up a tall ragged
 * column with holes beside it. This is the "tidy up" that fixes it in one
 * press.
 *
 * Written here rather than reaching into react-grid-layout's `build/utils.js`:
 * `compact()` and `correctBounds()` are real and do part of this, but they are
 * untyped build artefacts outside the package's entry point, and this needs to
 * run over three breakpoints of plain data with no grid mounted.
 */

interface Pending {
  item: LayoutItem
  index: number
  w: number
}

/**
 * A widget's size before anybody stretched it.
 *
 * Tidying writes the stretched width back into the layout, so without this the
 * next tidy reads it as what the widget wanted all along. Two widgets added
 * one at a time compounded into two full-width strips: the first was stretched
 * to twelve columns alone, and the second could then never share a row with
 * it. Since widgets are added one at a time, that was every board.
 */
export type NaturalSize = (id: string) => { w: number; h: number } | undefined

/**
 * Rows that fill the width, with a flat bottom edge.
 *
 * The first version of this packed widgets into the lowest gap that would take
 * them — correct, tight, and a mosaic. Fifteen widgets left 22% of the grid
 * empty, widths summed to eleven of twelve columns so the right-hand edge was
 * always ragged, and ten different top edges meant nothing lined up with
 * anything. Tighter is not tidier.
 *
 * So: greedy rows in reading order, the spare columns shared out until each
 * row exactly fills the grid, and every widget in a row given the height of
 * the tallest. That last part is what removes the holes — a short widget in a
 * tall row leaves a gap underneath it, and a gap under a widget is the thing
 * that makes a board look broken rather than sparse.
 *
 * Reading order is preserved throughout. A packer that sorted by size would
 * fit more in and would also move the SPL meter to the bottom for being short,
 * and the order widgets are met in is the order somebody arranged them.
 */
export function packLayout(
  items: readonly LayoutItem[],
  cols: number,
  natural?: NaturalSize,
): LayoutItem[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index)

  const placed = new Array<LayoutItem>(items.length)
  let row: Pending[] = []
  let used = 0
  let top = 0

  const settle = () => {
    if (row.length === 0) return

    // Share the leftover columns out one at a time from the left, so the
    // result is the same every time rather than depending on iteration luck.
    let spare = cols - used
    for (let i = 0; spare > 0; i = (i + 1) % row.length) {
      const entry = row[i]
      if (entry) entry.w += 1
      spare--
    }

    const height = Math.max(...row.map((entry) => entry.item.h))
    let x = 0
    for (const entry of row) {
      placed[entry.index] = { ...entry.item, x, y: top, w: entry.w, h: height }
      x += entry.w
    }

    top += height
    row = []
    used = 0
  }

  for (const { item, index } of order) {
    const size = natural?.(item.i)
    // Back to the size the widget asks for before working out who it shares a
    // row with, so tidying is idempotent: the same board in, the same board
    // out, however many times it is pressed. Clamped because a widget wider
    // than the breakpoint could otherwise never be placed at all.
    const w = Math.min(Math.max(size?.w ?? item.w, 1), cols)
    if (used + w > cols) settle()
    row.push({ item: size ? { ...item, h: Math.max(size.h, 1) } : item, index, w })
    used += w
  }
  settle()

  return placed
}

/** The same tidy-up across every breakpoint, each with its own column count. */
export function packAllBreakpoints<T extends Record<Breakpoint, LayoutItem[]>>(
  layouts: T,
  natural?: NaturalSize,
): T {
  return {
    ...layouts,
    lg: packLayout(layouts.lg, BREAKPOINT_COLS.lg, natural),
    md: packLayout(layouts.md, BREAKPOINT_COLS.md, natural),
    sm: packLayout(layouts.sm, BREAKPOINT_COLS.sm, natural),
  }
}
