import { z } from 'zod'
import { MIC_CUE_LEVELS, type MicCueLevel, micRefSchema } from './micCue.js'

/**
 * Wiring a microphone to a key on a Streamdeck.
 *
 * Companion sits between the two: a key press runs an HTTP action against
 * this system, and the key's colour comes from a Companion custom variable
 * this system writes back. Both halves need to name the same microphone, and
 * neither can sensibly name it the way we do internally — `kit:01H8X4…` is not
 * something anybody should be pasting into a button.
 *
 * So a **slug**: a short name you choose, once, and use on both sides.
 *
 * The slug rather than the microphone's own name, and that is the point of the
 * whole mapping. Renaming "MC2" to "Compère" mid-festival is a normal thing to
 * do on the roster page, and if the wiring hung off the name it would take the
 * deck down silently — the key would keep lighting up and stop doing anything.
 */
export const micCueBindingSchema = z.object({
  ref: micRefSchema,
  /**
   * Lowercase, because Companion variable names are case-sensitive and
   * `MC2` versus `mc2` is a fault you find at the worst moment. Constrained to
   * what the connector's `variable.set` will accept once prefixed, so a slug
   * that saves here cannot fail to write later.
   */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'letters, digits, underscore and hyphen; starting with one'),
  /**
   * Which Companion shows this microphone's colour, and null is a real
   * answer rather than an unfinished one.
   *
   * The two directions need different things. A key **press** needs only the
   * slug — Companion posts it and we look it up — so a binding with no
   * Companion named still works, and that is the whole configuration for
   * somebody who wants the deck to cue and does not care about the colour.
   * Writing the colour **back** is what needs to know where to write.
   *
   * Per binding rather than one for the whole show, because two decks is a
   * plausible rig — front of house and monitors — and a singleton would have
   * to be unpicked the first time somebody wanted the second one.
   */
  instanceId: z.string().nullable(),
})
export type MicCueBinding = z.infer<typeof micCueBindingSchema>

/**
 * Rejects two keys claiming one slug, and one microphone on two keys.
 *
 * Duplicate slugs would make the lookup arbitrary; the same microphone twice
 * would give it two variables, one of which would go stale the first time
 * somebody cued it — a key showing the wrong colour is worse than a key that
 * does nothing, because it is believed.
 */
export const saveMicCueBindingsSchema = z
  .object({ bindings: z.array(micCueBindingSchema) })
  .refine(
    (body) =>
      new Set(body.bindings.map((each) => each.slug)).size === body.bindings.length &&
      new Set(body.bindings.map((each) => each.ref)).size === body.bindings.length,
    { message: 'Each microphone and each name may appear once' },
  )

/**
 * The Companion custom variable a slug owns. One name, derived, never typed twice.
 *
 * `sil_` is this system's namespace inside Companion's flat custom-variable
 * list, which is shared with every other thing an operator has wired up. The
 * microphone wired to `mc1` owns `sil_mc1`, and its value is the cue level
 * verbatim — `standby`, `live`, `off` — because a Companion feedback rule is
 * written by a human comparing a string.
 */
export const variableFor = (slug: string): string => `sil_${slug}`

/** The path a deck posts a press to. Named once so the page cannot drift from the route. */
export const DEVICE_CUE_PATH = '/api/device/mic-cues'

/**
 * The body to paste into a Companion action.
 *
 * Here rather than inline in the admin page because **this string is the
 * feature**: an operator copies it into another application, and a typo in it
 * fails as a key that does nothing, diagnosed at 17:00 by somebody who has no
 * reason to suspect our text rather than their Companion. Review 4s found it
 * built inline with nothing asserting it at all.
 *
 * Being here lets the server test parse it with the very schema that will
 * receive it, which is the only check worth having — that the page and the
 * route agree is not something either side can confirm alone.
 *
 * `next` is what makes one key enough: a key has no memory, so it asks for the
 * step rather than the state and the server works out which from the board.
 */
export const pressBody = (slug: string): string => JSON.stringify({ mic: slug, level: 'next' })

/**
 * What we write into that variable.
 *
 * Words rather than numbers, because a Companion feedback rule is written by a
 * human comparing a string, and `standby` reads as itself where `1` needs a
 * comment. `off` rather than an empty value: a variable that clears looks
 * identical to a variable that was never set, and the difference matters when
 * somebody is working out why a key is dark.
 */
export const cueValue = (level: MicCueLevel | null): string => level ?? 'off'

export const bindingForSlug = (
  bindings: readonly MicCueBinding[],
  slug: string,
): MicCueBinding | undefined => bindings.find((each) => each.slug === slug.trim().toLowerCase())

/*
 * ── The same press, over OSC ────────────────────────────────────────────────
 *
 * Companion can send an OSC message as easily as an HTTP request, and a lot of
 * rigs would rather it did: an OSC send is one UDP datagram with no connection
 * to establish, and a show LAN that already carries OSC to consoles and media
 * servers has the routing for it. So a key may reach us either way, and the
 * two paths land on the same code the moment the level is resolved.
 *
 * **OSC has no headers, so the token is an argument.** That reads worse than
 * `Authorization: Bearer …` and is worth being plain about: it is the same
 * secret, in cleartext, on the same LAN, either way. Plain HTTP does not
 * encrypt a header. What OSC loses is not confidentiality — there was none —
 * but the reply: nothing comes back, so a wrong token, an unknown microphone
 * and a working press are indistinguishable from the sending end. That is why
 * the listener keeps a visible record of what it refused and why, and why the
 * setup page shows it.
 */

/**
 * Everything this system answers to on the OSC port lives under here.
 *
 * A namespace segment rather than a bare `/mc1/...`, so the addresses read as
 * this system's and not as a claim on two generic words. Companion isolates
 * its senders by address and port anyway, so this is legibility rather than
 * collision avoidance — an operator reading a packet capture at midnight can
 * see whose it is.
 */
export const OSC_CUE_PREFIX = '/sil'

/**
 * The address to paste into a Companion OSC action, one per key.
 *
 * `/sil/mc1/next` — the level is a trailing segment rather than an argument so
 * that one field differs between keys and the argument, the token, is
 * identical on every one of them. Companion's OSC action takes its arguments
 * as a single typed string, and asking somebody to keep `"tok" "next"` in the
 * right order across twenty keys is asking for the day one of them says
 * `"next" "tok"`.
 */
export const oscCueAddress = (slug: string, level: MicCueLevel | 'off' | 'next' = 'next'): string =>
  `${OSC_CUE_PREFIX}/${slug}/${level}`

export interface OscCueAddress {
  slug: string
  level: MicCueLevel | 'off' | 'next'
}

/**
 * Reads one back. Shared with the listener so the page cannot describe an
 * address the server does not answer to — the same argument as `pressBody`,
 * and the same test proves it.
 *
 * A bare `/sil/<slug>` means `next`, because that is what a key press means
 * and it is what somebody types from memory. The explicit levels are there for
 * a rig that would rather have three keys than one.
 */
export function parseOscCueAddress(address: string): OscCueAddress | null {
  if (!address.startsWith(`${OSC_CUE_PREFIX}/`)) return null

  const [slug, level = 'next', ...extra] = address.slice(OSC_CUE_PREFIX.length + 1).split('/')
  if (extra.length > 0) return null
  if (slug === undefined || slug === '') return null
  if (level !== 'off' && level !== 'next' && !MIC_CUE_LEVELS.includes(level as MicCueLevel)) {
    return null
  }

  return { slug: slug.trim().toLowerCase(), level: level as MicCueLevel | 'off' | 'next' }
}

/**
 * One datagram the listener saw, as the setup page shows it.
 *
 * Lives here rather than on the server because the page renders it and the
 * listener fills it in, and this is the only kind of feedback the OSC path
 * has. A field the two ends disagreed about would be a blank column on the
 * one screen that explains why a key is dark.
 */
export interface OscCueEvent {
  at: number
  from: string
  address: string
  accepted: boolean
  /** A sentence for a person reading the page, not a code for a machine. */
  detail: string
}

export interface OscCueListenerStatus {
  /** Configured at all. False means no `OSC_LISTEN_PORT`, which is the default. */
  enabled: boolean
  listening: boolean
  port: number
  host: string
  /** Why it is not listening when it should be — a port already taken, usually. */
  error: string | null
  accepted: number
  refused: number
  lastAt: number | null
  /** Newest first, and short: this is a diagnostic for the last few minutes. */
  recent: OscCueEvent[]
}
