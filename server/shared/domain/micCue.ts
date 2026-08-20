import { z } from 'zod'
import type { Kit } from './runningOrder.js'

/**
 * Cueing a microphone: "MC2 is about to go on".
 *
 * The stage manager taps a microphone and it flashes on every screen, so the
 * FOH engineer opens the channel. Either can tap it again to clear, and
 * that is deliberate — FOH clearing a cue is how they say they have done it.
 *
 * Two levels, always, whatever a given board's tap cycle offers. `standby` is
 * the request and `live` is the acknowledgement, and the state is show-wide:
 * a board configured for the simple cycle still has to *render* a mic another
 * board promoted, and still has to be able to clear it. That is the whole
 * reason the level lives here and the cycle lives in a widget's config.
 */
export const MIC_CUE_LEVELS = ['standby', 'live'] as const
export type MicCueLevel = (typeof MIC_CUE_LEVELS)[number]

/**
 * How a cue names the microphone it is about.
 *
 * Two shapes, because a mic reaches the board two ways:
 *
 *   kit:<kitId>                 somebody typed it into the roster
 *   rx:<instanceId>:<channelKey> a receiver reported it and nobody claimed it
 *
 * A roster mic keys by its kit id **even when it is linked to a receiver**.
 * Keying it by the receiver channel instead would look tidier and would lose
 * the cue the moment an admin re-pointed the mic at a different channel —
 * mid-show, which is exactly when somebody re-patches.
 *
 * The parse splits at the *first* colon after the prefix rather than the last,
 * because an instance id cannot contain a colon (`INSTANCE_ID_RE`) but a
 * channel key is whatever the receiver calls it. Same trick as `parseTopic`.
 */
export type MicRef = string

export const kitRef = (kitId: string): MicRef => `kit:${kitId}`
export const rxRef = (instanceId: string, channelKey: string): MicRef =>
  `rx:${instanceId}:${channelKey}`

export type ParsedMicRef =
  | { kind: 'kit'; kitId: string }
  | { kind: 'rx'; instanceId: string; channelKey: string }

export function parseMicRef(ref: string): ParsedMicRef | null {
  if (ref.startsWith('kit:')) {
    const kitId = ref.slice(4)
    return kitId === '' ? null : { kind: 'kit', kitId }
  }
  if (ref.startsWith('rx:')) {
    const rest = ref.slice(3)
    const split = rest.indexOf(':')
    if (split <= 0 || split === rest.length - 1) return null
    return { kind: 'rx', instanceId: rest.slice(0, split), channelKey: rest.slice(split + 1) }
  }
  return null
}

export const micRefSchema = z.string().refine((ref) => parseMicRef(ref) !== null, {
  message: 'Not a microphone reference',
})

/**
 * One cue on the wire.
 *
 * `name` is denormalised here rather than resolved by each board, and that is
 * a decision with a reason: `sys:mic-cues` goes to every authenticated user
 * unfiltered, but the receiver a cue points at may be in a group the viewer
 * cannot see, so their board could not turn `rx:rack1:2` into anything a human
 * could act on. You cannot ask somebody to open a microphone you will not
 * name. See the case in `access/filters.ts`.
 *
 * `byName` is who cued it, as a display name and never an id — useful when two
 * people are calling and one of them is wrong.
 */
export const micCueSchema = z.object({
  level: z.enum(MIC_CUE_LEVELS),
  at: z.number(),
  name: z.string(),
  byName: z.string().optional(),
})
export type MicCue = z.infer<typeof micCueSchema>

export const sysMicCuesSchema = z.object({
  cues: z.record(z.string(), micCueSchema),
})
export type SysMicCues = z.infer<typeof sysMicCuesSchema>
export type MicCues = SysMicCues['cues']

/** Nothing cued. A fresh event, and what a malformed flag falls back to. */
export const NO_MIC_CUES: SysMicCues = { cues: {} }

/**
 * Setting a cue, declaratively — the level you want, not "toggle it".
 *
 * Two people tapping the same microphone at the same moment both send
 * "standby", and both land on standby. A toggle would have the second press undo the first,
 * so a mic would flash and vanish with nobody able to say why. Interleaved
 * *different* intents are last-write-wins, which is the honest answer for a
 * state the whole show shares, and the same call the live position makes.
 */
export const setMicCueSchema = z.object({
  ref: micRefSchema,
  level: z.enum(MIC_CUE_LEVELS).nullable(),
})
export type SetMicCue = z.infer<typeof setMicCueSchema>

/** How many taps a board offers before a cue clears. Per board, not per show. */
export const TAP_CYCLES = ['simple', 'two-stage'] as const
export type TapCycle = (typeof TAP_CYCLES)[number]

/**
 * What the next tap means.
 *
 * `simple` sends a mic straight back to nothing from either level, and the
 * `live` case is the one worth stating: the cue state is show-wide, so a board
 * on the simple cycle will meet mics that a two-stage board promoted. Refusing
 * to clear those would leave a microphone flashing at somebody with no way to
 * stop it.
 */
export function nextCueLevel(current: MicCueLevel | null, cycle: TapCycle): MicCueLevel | null {
  if (cycle === 'simple') return current === null ? 'standby' : null
  if (current === null) return 'standby'
  return current === 'standby' ? 'live' : null
}

/** A live receiver channel, as much of one as this module needs. */
export interface DiscoveredChannel {
  instanceId: string
  /** What the receiver is called, for naming a channel that has none yet. */
  instanceName: string
  channelKey: string
  /** The channel's own name. Null until the first full poll returns one. */
  name: string | null
}

/** One microphone on the board: a roster mic, a discovered
 * channel, or the ghost of a cue whose microphone has gone. */
export interface Mic {
  /** The `kit:` ref for a roster mic, the `rx:` ref for a discovered one. */
  ref: MicRef
  name: string
  /** Set on a roster mic that points at a receiver, and on every discovered
   * mic — so it knows both of its possible cue keys. */
  rx: MicRef | null
  /** True when this exists only because something is cued on it. */
  missing: boolean
}

/**
 * Every microphone worth showing, from both directions, once each.
 *
 * The roster is the manual method and comes first, in its own order: somebody
 * typed those names and chose that order, and a mic on a cable has no other
 * way onto the board. Then any receiver channel no roster mic has claimed, so
 * a rack plugged in an hour before doors appears by itself rather than waiting
 * for somebody to type it twice.
 *
 * Last come **orphans**: refs that are cued but match no microphone. Without them a
 * cue on a receiver that has since been unplugged, or on a kit somebody
 * changed from a microphone to a comms pack, would carry on existing where
 * nobody could see it or cancel it. A row saying the microphone has gone is
 * worse than nothing only to somebody who has never had to clear one.
 *
 * Pure, and shared with the config dialogue's picker on purpose: a board that
 * offered a different set of mics from the one it renders would be a bug
 * nobody would think to look for.
 */
export function mergeMics(
  kit: readonly Kit[],
  discovered: readonly DiscoveredChannel[],
  cues: MicCues = {},
): Mic[] {
  const mics: Mic[] = []
  const claimed = new Set<string>()

  for (const piece of kit) {
    if (piece.kind !== 'mic') continue
    const rx =
      piece.instanceId !== null && piece.channelKey !== null
        ? rxRef(piece.instanceId, piece.channelKey)
        : null
    if (rx !== null) claimed.add(rx)
    mics.push({ ref: kitRef(piece.id), name: piece.name, rx, missing: false })
  }

  /*
   * A discovered channel says which receiver it is on when its name is
   * already taken.
   *
   * A rack channel and the roster entry for the microphone plugged into it are
   * routinely given the same name — that is somebody being consistent, not
   * careless — and the dedupe above only fires when the two have been
   * explicitly linked on the roster page. The commonest real setup is a rack
   * that discovered itself plus a roster typed by hand, and review 4s found it
   * producing three boxes labelled "Vocal 1" with identical accessible names
   * and nothing to choose between them. In a dark wing that is a cue on the
   * wrong microphone.
   *
   * Only the discovered side is qualified: the plain name belongs to whoever
   * typed it on purpose. Two roster microphones sharing a name is the roster's
   * problem and the roster page is where somebody can see and fix it.
   */
  const taken = new Set(mics.map((mic) => mic.name))

  for (const channel of discovered) {
    const ref = rxRef(channel.instanceId, channel.channelKey)
    if (claimed.has(ref)) continue
    claimed.add(ref)
    // "1" is a number; "Vocal 1" is the thing on the singer's stand. The
    // receiver's own name is the fallback, never the bare channel key.
    const own = channel.name ?? `${channel.instanceName} ch ${channel.channelKey}`
    const name = taken.has(own) ? `${own} · ${channel.instanceName}` : own
    taken.add(name)
    mics.push({ ref, name, rx: ref, missing: false })
  }

  // Both names of everything on the board, so a cue placed under either one
  // counts as shown and does not sprout a second, ghostly entry.
  const shown = new Set(mics.flatMap((mic) => (mic.rx ? [mic.ref, mic.rx] : [mic.ref])))
  for (const [ref, cue] of Object.entries(cues)) {
    if (shown.has(ref)) continue
    mics.push({ ref, name: cue.name, rx: null, missing: true })
  }

  return mics
}

/**
 * The cue on a microphone, under either of its names.
 *
 * A roster mic linked to a receiver can be cued as `kit:` from this board and
 * as `rx:` from one that met the channel before anybody added it to the
 * roster. The roster ref wins when both exist, because it is the one a tap
 * here will write.
 */
export function cueFor(mic: Mic, cues: MicCues): MicCue | null {
  return cues[mic.ref] ?? (mic.rx ? (cues[mic.rx] ?? null) : null)
}

/**
 * `cueFor`, for callers holding a reference rather than a microphone.
 *
 * The server has three of them — the Streamdeck endpoint working out what
 * `next` means, the bridge working out what colour to write, and the tests
 * that keep those two honest — and none of them has built the merged board.
 * All of them have to agree with `cueFor`, because a microphone cued under
 * one of its two references and read under the other is a key that stays dark
 * while the wall flashes.
 *
 * Resolves in both directions: a `kit:` ref finds the cue on the receiver
 * channel it points at, and an `rx:` ref finds the cue on the roster
 * microphone that claims it.
 */
export function cueLevelForRef(
  ref: MicRef,
  cues: MicCues,
  kit: readonly Kit[],
): MicCueLevel | null {
  const direct = cues[ref]
  if (direct) return direct.level

  const target = parseMicRef(ref)
  if (!target) return null

  if (target.kind === 'kit') {
    const piece = kit.find((each) => each.id === target.kitId)
    if (!piece?.instanceId || !piece.channelKey) return null
    return cues[rxRef(piece.instanceId, piece.channelKey)]?.level ?? null
  }

  const claimant = kit.find(
    (each) => each.instanceId === target.instanceId && each.channelKey === target.channelKey,
  )
  return claimant ? (cues[kitRef(claimant.id)]?.level ?? null) : null
}
