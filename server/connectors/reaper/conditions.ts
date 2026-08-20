import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

/**
 * The failure modes of a multitrack recording rig, in the order they ruin a
 * show: the disk filled up, or the thing everyone assumes is recording isn't.
 */
export const reaperConditions: readonly ConditionDecl[] = [
  {
    id: 'disk.low',
    label: 'Recording disk low',
    description: 'Free space on the record drive has dropped below the threshold.',
    streamId: 'disk',
    paramsSchema: z.object({ freeMb: z.number().min(0) }),
    defaultParams: { freeMb: 10_240 }, // ~10 GB: minutes, not hours, at 32ch/24bit
    defaultSeverity: 'critical',
    evaluate: (payload, params) => {
      const free = (payload as { freeMb?: number }).freeMb
      const { freeMb } = params as { freeMb: number }
      if (typeof free !== 'number') return []
      return [
        {
          active: free < freeMb,
          value: Math.round(free),
          detail: `${(free / 1024).toFixed(1)} GB free`,
        },
      ]
    },
  },
  {
    id: 'not-recording',
    label: 'Armed but not recording',
    // The quiet disaster: tracks are armed, everyone assumes the show is being
    // captured, and the transport was never rolled. Requiring at least one
    // armed track keeps this quiet during soundcheck and changeovers, when
    // nobody expects a recording.
    description:
      'Tracks are record-armed but the transport is not recording — the usual sign that ' +
      'nobody pressed record.',
    streamId: 'transport',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'warning',
    evaluate: (payload) => {
      const { state, armedCount } = payload as { state?: string; armedCount?: number }
      if (typeof state !== 'string' || typeof armedCount !== 'number') return []
      return [
        {
          active: armedCount > 0 && state !== 'recording',
          value: state,
          detail: `${armedCount} track(s) armed, transport is ${state}`,
        },
      ]
    },
  },
]
