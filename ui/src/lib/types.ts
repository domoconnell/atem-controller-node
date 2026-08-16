// Mirrors the snapshot pushed by src/web.js over the WebSocket.

export interface Box {
  enabled: boolean
  source: number
  sourceName?: string
  x: number
  y: number
  size: number
  cropped: boolean
  cropTop: number
  cropBottom: number
  cropLeft: number
  cropRight: number
}

export interface KeyerLive {
  onAir: boolean
}

export interface MixEffectLive {
  programInput: number
  previewInput: number
  inTransition: boolean
  handlePosition: number
  nextStyle?: number
  nextSelection?: number[]
  mixRate?: number
  keyers: (KeyerLive | null)[]
}

export interface UskSettings {
  onAir: boolean
  keyType: 'luma' | 'chroma' | 'pattern' | 'dve' | string
  fillSource: number
  fillSourceName?: string
  cutSource: number
  cutSourceName?: string
  flyEnabled?: boolean
  mask?: { maskEnabled: boolean; maskTop: number; maskBottom: number; maskLeft: number; maskRight: number } | null
  luma?: { preMultiplied: boolean; clip: number; gain: number; invert: boolean } | null
  pattern?: {
    style: number; size: number; symmetry: number; softness: number
    positionX: number; positionY: number; invert: boolean
  } | null
  dve?: Record<string, number | boolean> | null
}

export interface Look {
  name: string
  capturedAt?: string
  boxes: (Box | null)[]
  ssProperties?: {
    artFillSource: number; artFillSourceName?: string
    artCutSource: number; artCutSourceName?: string
    artOption: number; artOptionName?: string
    artPreMultiplied: boolean; artClip: number; artGain: number; artInvertKey: boolean
  } | null
  me?: {
    index?: number
    programInput?: number; programInputName?: string
    previewInput?: number; previewInputName?: string
    nextTransition?: { style: string | number; selection: (string | number)[] } | null
    uskOnAir: boolean[]
    usk?: (UskSettings | null)[]
  }
  hyperdeck?: {
    connected: boolean; status: string | null; clipId: number | null
    loop: boolean; singleClip: boolean; speed: number | null
  }
}

export interface Snapshot {
  atem: {
    connected: boolean
    boxes: (Box | null)[]
    mixEffects: (MixEffectLive | null)[]
    inputs: Record<string, string>
  }
  hyperdeck: { connected: boolean; transport: Record<string, string> }
  currentLook: string | null
  looks: Look[]
  macros: { name: string; from?: string; to?: string }[]
  busy: { name: string; stepIndex: number; totalSteps: number; from?: string | null; to?: string | null } | null
  animating: boolean
  mainMe: number
  propresenter?: { connected: boolean; configured: boolean }
}

export interface PlanStep { type: string; [k: string]: unknown }
export interface Plan { ok: boolean; steps: PlanStep[]; notes: string[]; error?: string }

export const PATTERN_NAMES = [
  'L→R bar', 'T→B bar', 'H barn door', 'V barn door', 'Corners in', 'Rect iris',
  'Diamond iris', 'Circle iris', 'TL box', 'TR box', 'BR box', 'BL box',
  'Top box', 'Right box', 'Bottom box', 'Left box', 'TL diagonal', 'TR diagonal',
]
