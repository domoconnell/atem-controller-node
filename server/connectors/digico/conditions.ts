import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

interface MessagePayload {
  messages?: { id: string; text: string; at: number }[]
}

export const digicoConditions: readonly ConditionDecl[] = [
  {
    id: 'message.matches',
    label: 'Console message matches',
    /**
     * The reason the macro bridge exists. Console text chat is unreachable
     * from the network — it travels inside the audio transport — so operators
     * label macros with the things they need to say, and this turns the ones
     * that matter into alerts.
     */
    description:
      'A message from the console matches a word or phrase — e.g. alert the crew chief when ' +
      '"Mic down" is pressed.',
    streamId: 'messages',
    paramsSchema: z.object({
      keywords: z.string().min(1),
      /** How long a matching message stays "active" for alerting purposes. */
      holdSeconds: z.number().int().min(5).max(600).default(60),
    }),
    defaultParams: { keywords: 'down, help, urgent', holdSeconds: 60 },
    defaultSeverity: 'warning',
    evaluate: (payload, params) => {
      const { keywords, holdSeconds } = params as { keywords: string; holdSeconds: number }
      const messages = (payload as MessagePayload).messages ?? []

      const wanted = keywords
        .split(',')
        .map((word) => word.trim().toLowerCase())
        .filter(Boolean)
      if (wanted.length === 0) return []

      const cutoff = Date.now() - holdSeconds * 1_000
      const recent = messages.filter(
        (message) =>
          message.at >= cutoff && wanted.some((word) => message.text.toLowerCase().includes(word)),
      )

      // One item, not one per message: the question is "has something been
      // said that needs attention", and a burst is still one situation.
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
    id: 'channel.muted',
    label: 'Channel muted',
    description: 'A watched input channel is muted.',
    streamId: 'channels',
    paramsSchema: z.object({
      /** Blank watches every channel the console reports. */
      channels: z.string().default(''),
    }),
    defaultParams: { channels: '' },
    defaultSeverity: 'info',
    evaluate: (payload, params) => {
      const { channels: wanted } = params as { channels: string }
      const list =
        (
          payload as {
            channels?: { channel: number; name: string | null; muted: boolean | null }[]
          }
        ).channels ?? []

      const only = wanted
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isFinite(entry))

      return list
        .filter((channel) => only.length === 0 || only.includes(channel.channel))
        .map((channel) => ({
          itemKey: String(channel.channel),
          itemLabel: channel.name ?? `Ch ${channel.channel}`,
          active: channel.muted === true,
          value: channel.muted ? 'muted' : 'live',
        }))
    },
  },
]
