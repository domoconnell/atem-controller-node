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
  fillSource?: number
  keyType?: string
  pattern?: { style: number; size: number; symmetry: number; positionX: number; positionY: number; invert: boolean } | null
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
  nextSelectionNames?: string[]
  transitionSelectionNames?: string[]
  art?: { artFillSource: number; artCutSource: number; artOption: number } | null
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
  mediaPlayers?: ({ index: number; sourceType: 'still' | 'clip'; stillIndex: number; clipIndex: number; name: string } | null)[]
  hyperdeck?: {
    connected: boolean; status: string | null; clipId: number | null
    loop: boolean; singleClip: boolean; speed: number | null
  }
}

export interface Snapshot {
  sennheiser?: { enabled: boolean; simulated: boolean; online: number; total: number }
  atem: {
    connected: boolean
    simulated?: boolean
    boxes: (Box | null)[]
    mixEffects: (MixEffectLive | null)[]
    inputs: Record<string, string>
    mediaPlayers?: ({ index: number; sourceType: string; name: string } | null)[]
    options?: { superSourceCount: number; meCount: number; boxCount: number }
  }
  hyperdeck: { connected: boolean; transport: Record<string, string> }
  currentLook: string | null
  looks: Look[]
  macros: { name: string; from?: string; to?: string }[]
  busy: { name: string; stepIndex: number; totalSteps: number; from?: string | null; to?: string | null } | null
  animating: boolean
  mainMe: number
  propresenter?: { connected: boolean; configured: boolean }
  verify?: {
    results: VerifyResult[]
    lastGrade: unknown
  } | null
}

export interface VerifyResult {
  name: string; from: string | null; to: string | null
  ok: boolean; simGrade: string; simulated: boolean; at: string; durationMs: number
  diffs: { what: string; expected: unknown; actual: unknown }[]
}

export interface PlanStep { type: string; [k: string]: unknown }
export interface SimReport {
  grade: 'clean' | 'dip' | 'has-cuts'
  counts: { visibleCuts: number; dips?: number; fades: number; animations: number; steps: number }
  visibleCuts: { step: number; type: string; detail: string }[]
  events: { step: number; type: string; kind: 'cut' | 'fade' | 'animate'; detail: string }[]
  approxDurationMs: number
}
export interface Plan { ok: boolean; steps: PlanStep[]; notes: string[]; sim?: SimReport; error?: string }
export type PlanGrades = Record<string, { grade: string; counts?: SimReport['counts']; approxDurationMs?: number; notes?: string[]; error?: string }>

export const PATTERN_NAMES = [
  'L→R bar', 'T→B bar', 'H barn door', 'V barn door', 'Corners in', 'Rect iris',
  'Diamond iris', 'Circle iris', 'TL box', 'TR box', 'BR box', 'BL box',
  'Top box', 'Right box', 'Bottom box', 'Left box', 'TL diagonal', 'TR diagonal',
]

export interface WireLine {
  /** cluster size: how many identical sequential messages this line stands for */
  count?: number
  t: number
  dir: 'tx' | 'rx'
  proto: string
  summary?: string
  detail?: string
  repeat?: number   // suppressed-repeat marker: ×N of `kind`
  kind?: string
}

/** Sennheiser wireless monitor (the Mics app) */
export interface SennChannel {
  id: string
  name?: string
  frequency?: number // kHz
  mute?: boolean
  gain?: number
  battery?: number | null // % - null: transmitter off / not reporting
  rssi?: number // ewdx, dBm
  rsqi?: number // ewdx, 0-100
  rf?: number | null // normalized 0..1 (ewdx from rssi; g3 raw)
  ant?: number // active diversity antenna 1|2
  af?: number | null // normalized 0..1
  afDb?: number // ewdx, dB
  afPeak?: number // legacy G3 peak-hold 0..1
  afRaw?: number[] // g3: [level, peak, ?]; iem: [L, R, peakL, peakR]
  rf1?: number
  rf2?: number
  squelch?: number
  afOut?: number
  sensitivity?: number
  stereo?: boolean
  msg?: string
  legacy?: boolean
  legacyRaw?: string // undecoded 40-byte telemetry frame (hex)
  batteryPending?: boolean // reached via a protocol whose battery field isn't decoded yet
}
export interface SennDevice {
  ip: string
  type: 'ewdx' | 'g3' | 'iemg4' | 'g3legacy'
  label?: string
  online: boolean
  mac?: string
  legacy?: boolean // pre-1.7 G3 on the binary 8133 protocol
  reachable?: boolean | null // ICMP ping (for units that don't answer the protocol)
  pingMs?: number | null
  product?: string
  version?: string
  deviceName?: string
  channels: SennChannel[]
}
export interface SennSnapshot {
  enabled: boolean
  simulated: boolean
  online: number
  total: number
  devices: SennDevice[]
}

/** Connector engine — a configured device connection (multi-instance) */
export interface InstanceStatusLite { state: 'configuring'|'connecting'|'online'|'degraded'|'offline'|'error'|'stopped'; detail?: string | null }
export interface Instance {
  id: string
  typeId: string
  name: string
  config: Record<string, unknown>
  enabled: boolean
  allowControl: boolean
  simulate: boolean
  sortOrder: number
  engineRun?: boolean
  status?: InstanceStatusLite | null
}
export interface ConnectorType {
  typeId: string
  displayName: string
  description: string
  capabilities?: { control: boolean }
  tier?: string
}
