import { z } from 'zod'
import { overThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'

/**
 * What can be wrong with a comms feed.
 *
 * Both of these read the `watch` stream rather than the feed or the mention
 * stream, and that is not an accident. `HealthEngine` re-evaluates a condition
 * only when that condition's own stream publishes — a sweep never re-runs one
 * against the payload it saw last time. So a condition attached to something
 * that publishes only when a word is said would go active at nine in the
 * evening and still be active at three in the morning, because nothing has
 * asked it again. `watch` ticks on a timer, which is what lets `holdSeconds`
 * genuinely expire and what lets silence be noticed at all.
 */

/**
 * A condition is handed whatever the stream last published, which on a bad
 * frame or before the first tick can be null. The engine catches a throw, but
 * "return nothing when the data is not there" is the documented contract and it
 * is also the honest answer — an absent reading is not a problem.
 */
const watchPayload = (payload: unknown): WatchPayload =>
  typeof payload === 'object' && payload !== null ? (payload as WatchPayload) : {}

interface WatchPayload {
  at?: number
  channels?: { id: string; name: string; lastHeardAt: number | null; quietSeconds: number | null }[]
  mentions?: {
    id: string
    at: number
    text: string
    channel: string
    keywords: string[]
    sources: string[]
  }[]
}

export const prodcomConditions: readonly ConditionDecl[] = [
  {
    id: 'comms.mention',
    label: 'Flagged word heard on comms',
    description:
      'Somebody said a word this module is watching for — a name, a role, "medical". The list ' +
      'here **narrows** that to a few of them; it does not add any. A word the module is not ' +
      'watching never becomes a mention, so a rule naming one can never fire. Leave it blank ' +
      'for every word the module already flags.',
    streamId: 'watch',
    paramsSchema: z.object({
      /** Blank means "whatever the module is already watching for". */
      words: z.string().default(''),
      scope: z.enum(['any', 'watch', 'prodcom']).default('any'),
      /** How long a line stays worth alerting about after it was said. */
      holdSeconds: z.number().int().min(5).max(600).default(60),
    }),
    defaultParams: { words: '', scope: 'any', holdSeconds: 60 },
    defaultSeverity: 'warning',
    evaluate: (payload, params) => {
      const { words, scope, holdSeconds } = params as {
        words: string
        scope: 'any' | 'watch' | 'prodcom'
        holdSeconds: number
      }
      const mentions = watchPayload(payload).mentions ?? []

      const only = words
        .split(',')
        .map((word) => word.trim().toLowerCase())
        .filter(Boolean)

      const cutoff = Date.now() - holdSeconds * 1_000
      const recent = mentions.filter((mention) => {
        if (mention.at < cutoff) return false
        if (scope !== 'any' && !mention.sources.includes(scope)) return false
        if (only.length === 0) return true
        return mention.keywords.some((keyword) => only.includes(keyword.toLowerCase()))
      })

      // One item rather than one per line: the question is "has something been
      // said that somebody needs to act on", and a flurry is one situation.
      return [
        {
          active: recent.length > 0,
          value: recent.length,
          detail: recent.at(-1)?.text,
        },
      ]
    },
  },
  {
    id: 'comms.silent',
    label: 'Comms channel gone quiet',
    description:
      'Nothing has been heard on a channel for a while — a dead radio, an unplugged headset, or ' +
      'a belt pack somebody switched off at the interval.',
    streamId: 'watch',
    paramsSchema: z.object({
      minutes: z.number().min(1).max(240).default(15),
      /** Blank watches every channel this module follows. */
      channels: z.string().default(''),
    }),
    defaultParams: { minutes: 15, channels: '' },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const { minutes, channels: wanted } = params as { minutes: number; channels: string }
      const channels = watchPayload(payload).channels ?? []

      const only = wanted
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)

      const threshold = minutes * 60

      return (
        channels
          .filter(
            (channel) =>
              only.length === 0 ||
              only.includes(channel.name.toLowerCase()) ||
              only.includes(channel.id.toLowerCase()),
          )
          // A channel nobody has spoken on since the module started is not the
          // same as one that has just gone dead. Reporting the first as a fault
          // would mean every quiet channel lights up the moment a show is patched
          // and before anybody has keyed a mic.
          .filter((channel) => channel.quietSeconds !== null)
          .map((channel) => {
            const quiet = channel.quietSeconds ?? 0
            // Reported in the unit the rule was written in. Seconds against a
            // minutes threshold reads as a bug on the board, and rounding to
            // minutes made everything under half a minute say "quiet for 0 min".
            return {
              itemKey: channel.id,
              itemLabel: channel.name,
              active: overThreshold(quiet, threshold, wasActive?.(channel.id) ?? false),
              value: Math.round((quiet / 60) * 10) / 10,
              detail:
                quiet < 60
                  ? `last heard ${Math.round(quiet)}s ago`
                  : `last heard ${Math.round(quiet / 60)} min ago`,
            }
          })
      )
    },
  },
]
