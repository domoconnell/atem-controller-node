// Timer layout designer domain types (mirrors data/timer-layouts.json).

export interface ElementParams {
  timer?: string
  part?: string
  format?: string
  padh?: string
  padm?: string
  pads?: string
  case?: string
  font?: string
  size?: string
  fitpad?: string
  weight?: string
  italic?: string
  color?: string
  opacity?: string
  spacing?: string
  shadow?: string
  stroke?: string
  bg?: string
  bgopacity?: string
  radius?: string
  align?: string
  valign?: string
  stopped?: string
  zero?: string
  overrun?: string
  direction?: string
  thickness?: string
  [k: string]: string | undefined
}

export interface LayoutElement {
  id: string
  x: number   // percent of canvas
  y: number
  w: number
  h: number
  r?: number  // rotation, degrees
  params: ElementParams
}

export interface TimerLayout {
  id: string
  name: string
  timer?: string          // default timer for all elements
  elements: LayoutElement[]
  updatedAt?: string
}

export interface TimerInfo {
  name: string
  state: string
  remaining: number
  duration: number | null
}

export const PART_OPTIONS = [
  { value: 'time', label: 'time (mm:ss)' },
  { value: 'minutes', label: 'minutes' },
  { value: 'seconds', label: 'seconds' },
  { value: 'hours', label: 'hours' },
  { value: 'total-seconds', label: 'total seconds' },
  { value: 'total-minutes', label: 'total minutes' },
  { value: 'progress-bar', label: 'progress bar' },
  { value: 'progress-ring', label: 'progress ring' },
]

export function elementQuery(el: LayoutElement, layoutTimer?: string): string {
  const p = new URLSearchParams()
  const params = { ...el.params }
  if (!params.timer && layoutTimer) params.timer = layoutTimer
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') p.set(k, v)
  }
  return p.toString()
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export type ElementType = 'timer' | 'text' | 'rect' | 'ellipse'

export function newElement(type: ElementType = 'timer'): LayoutElement {
  const base = {
    id: 'el-' + Math.random().toString(36).slice(2, 8),
    x: 25, y: 35, w: 50, h: 30,
  }
  switch (type) {
    case 'text': return { ...base, params: { type, text: 'YOUR TEXT', color: '#ffffff' } }
    case 'rect': return { ...base, params: { type, color: '#ffffff', radius: '8' } }
    case 'ellipse': return { ...base, w: 26, h: 46, params: { type, color: '#ffffff' } }
    default: return { ...base, params: { part: 'time', color: '#ffffff' } }
  }
}

export const ANIM_OPTIONS = [
  { value: '', label: 'none' },
  { value: 'fade', label: 'fade in' },
  { value: 'slide-up', label: 'slide up' },
  { value: 'slide-down', label: 'slide down' },
  { value: 'slide-left', label: 'slide left' },
  { value: 'slide-right', label: 'slide right' },
  { value: 'zoom', label: 'zoom in' },
  { value: 'pop', label: 'pop' },
  { value: 'wibble', label: 'wibble in' },
  { value: 'bounce', label: 'bounce in' },
  { value: 'spin', label: 'spin in' },
  { value: 'blur', label: 'blur in' },
  { value: 'flip', label: 'flip in' },
  { value: 'roll', label: 'roll in' },
]

export function elementLabel(el: LayoutElement): string {
  const t = el.params.type ?? 'timer'
  if (t === 'timer') return el.params.part ?? 'time'
  if (t === 'text') return `“${(el.params.text ?? 'text').slice(0, 14)}”`
  return t
}
