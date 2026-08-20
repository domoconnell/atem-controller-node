import type { Placement } from './widget-view'

export type Display = '16:9' | 'ultrawide' | '9:16'
export interface DisplayDef { id: Display; label: string; aspect: number; cols: number }
export const DISPLAYS: DisplayDef[] = [
  { id: '16:9', label: '16:9', aspect: 16 / 9, cols: 12 },
  { id: 'ultrawide', label: '2560 × 720', aspect: 2560 / 720, cols: 26 },
  { id: '9:16', label: '9:16 portrait', aspect: 9 / 16, cols: 6 },
]
export const displayDef = (d: Display) => DISPLAYS.find((x) => x.id === d) ?? DISPLAYS[0]
/** cols x rows for a display — rows derived so cells stay roughly square. */
export function gridDims(d: Display) { const def = displayDef(d); return { cols: def.cols, rows: Math.max(1, Math.round(def.cols / def.aspect)) } }

export type Layout = { i: string; x: number; y: number; w: number; h: number }
export interface Region { enabled: boolean; widgets: Placement[] }
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export interface Surface {
  id: string
  name: string
  display: Display
  header: Region
  footer: Region
  pullouts: Record<Edge, Region>
  main: { widgets: Placement[]; layout: Layout[] }
}
export const emptyRegion = (): Region => ({ enabled: false, widgets: [] })
export const emptySurface = (): Surface => ({
  id: '', name: 'New surface', display: '16:9',
  header: emptyRegion(), footer: emptyRegion(),
  pullouts: { left: emptyRegion(), right: emptyRegion(), top: emptyRegion(), bottom: emptyRegion() },
  main: { widgets: [], layout: [] },
})
/** Fill in any missing structure from an older/partial saved surface. */
export function normaliseSurface(raw: Partial<Surface> & { id?: string }): Surface {
  const base = emptySurface()
  return {
    ...base, ...raw, id: raw.id ?? '',
    header: { ...base.header, ...raw.header },
    footer: { ...base.footer, ...raw.footer },
    pullouts: { left: { ...base.pullouts.left, ...raw.pullouts?.left }, right: { ...base.pullouts.right, ...raw.pullouts?.right }, top: { ...base.pullouts.top, ...raw.pullouts?.top }, bottom: { ...base.pullouts.bottom, ...raw.pullouts?.bottom } },
    main: { widgets: raw.main?.widgets ?? (raw as { widgets?: Placement[] }).widgets ?? [], layout: raw.main?.layout ?? (raw as { layout?: Layout[] }).layout ?? [] },
  }
}
