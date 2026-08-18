import type { Look, Snapshot } from './types'
import type { Scene } from '@/components/atem/ss-monitor'

/** Scene as recorded in a look. */
export function lookScene(look: Look, ssInput = 6000): Scene {
  return {
    program: look.me?.programInput ?? ssInput,
    boxes: look.boxes ?? [],
    artFill: look.ssProperties?.artFillSource ?? null,
    keyers: (look.me?.usk ?? []).map((k) => k ? ({
      onAir: !!k.onAir, fillSource: k.fillSource, keyType: k.keyType,
      pattern: k.pattern ? { style: k.pattern.style, size: k.pattern.size, symmetry: k.pattern.symmetry, positionX: k.pattern.positionX, positionY: k.pattern.positionY, invert: k.pattern.invert } : null,
    }) : null),
  }
}

/**
 * Live program scene + the in-flight mix (if any). During a background
 * transition the incoming scene is preview's feed (or SS with the current
 * boxes); during a keys-only transition the incoming scene has toggled keys.
 */
export function liveScene(state: Snapshot, ssInput = 6000): { scene: Scene; mixTo: { scene: Scene; t: number; keysOnly?: boolean } | null } {
  const me = state.atem.mixEffects[state.mainMe]
  const boxes = state.atem.boxes
  if (!me) return { scene: { program: ssInput, boxes }, mixTo: null }
  const keyers = me.keyers ?? []
  const scene: Scene = { program: me.programInput, boxes, artFill: me.art?.artFillSource ?? null, keyers }
  if (!me.inTransition) return { scene, mixTo: null }
  const t = Math.min(1, Math.max(0, (me.handlePosition ?? 0) / 10000))
  const sel = me.transitionSelectionNames ?? me.nextSelectionNames ?? ['background']
  const bg = sel.includes('background')
  const toggled = keyers.map((k, i) => (k && sel.includes(`key${i + 1}`) ? { ...k, onAir: !k.onAir } : k))
  const incoming: Scene = {
    program: bg ? me.previewInput : me.programInput,
    boxes,
    artFill: me.art?.artFillSource ?? null,
    keyers: toggled,
  }
  return { scene, mixTo: { scene: incoming, t, keysOnly: !bg } }
}
