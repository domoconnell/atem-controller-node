import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

export const hyperdeckConditions: readonly ConditionDecl[] = [
  {
    id: 'recordingTime.low',
    label: 'Recording time low',
    // The number that decides whether a card gets swapped between bands.
    description: 'The media has less recording time left than the threshold.',
    streamId: 'slots',
    paramsSchema: z.object({ minutes: z.number().min(1) }),
    defaultParams: { minutes: 15 },
    defaultSeverity: 'warning',
    evaluate: (payload, params) => {
      const slot = payload as { slotId?: number | null; recordingTimeSeconds?: number | null }
      const { minutes } = params as { minutes: number }
      if (typeof slot.recordingTimeSeconds !== 'number') return []

      const remaining = Math.round(slot.recordingTimeSeconds / 60)
      return [
        {
          itemKey: `slot${slot.slotId ?? '?'}`,
          itemLabel: `Slot ${slot.slotId ?? '?'}`,
          active: remaining < minutes,
          value: remaining,
          detail: `${remaining} min left`,
        },
      ]
    },
  },
  {
    id: 'slot.unavailable',
    label: 'No usable media',
    description: 'The slot has no mounted, writable media.',
    streamId: 'slots',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'warning',
    evaluate: (payload) => {
      const slot = payload as { slotId?: number | null; status?: string }
      if (typeof slot.status !== 'string') return []
      return [
        {
          itemKey: `slot${slot.slotId ?? '?'}`,
          itemLabel: `Slot ${slot.slotId ?? '?'}`,
          // 'mounted' is the only state a deck can actually record onto.
          active: slot.status !== 'mounted',
          value: slot.status,
          detail: `Slot is ${slot.status}`,
        },
      ]
    },
  },
]
