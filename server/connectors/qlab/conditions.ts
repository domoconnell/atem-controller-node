import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

interface RunningCue {
  id: string
  name: string
  elapsed: number
  remaining: number
  percent: number
}

export const qlabConditions: readonly ConditionDecl[] = [
  {
    id: 'cue.overrun',
    label: 'Cue running long',
    // A cue that has outstayed its expected length is usually a stuck video or
    // a loop nobody meant to leave armed.
    description: 'A running cue has been going for longer than expected.',
    streamId: 'running',
    paramsSchema: z.object({ seconds: z.number().int().min(1) }),
    defaultParams: { seconds: 600 },
    defaultSeverity: 'info',
    evaluate: (payload, params) => {
      const { seconds } = params as { seconds: number }
      const cues = (payload as { cues?: RunningCue[] }).cues ?? []

      return cues.map((cue) => ({
        itemKey: cue.id,
        itemLabel: cue.name || cue.id,
        active: cue.elapsed > seconds,
        value: Math.round(cue.elapsed),
        detail: `${cue.name || cue.id} running ${Math.round(cue.elapsed)}s`,
      }))
    },
  },
  {
    id: 'cue.ending',
    label: 'Cue about to end',
    description: 'A running cue is within the warning window of finishing.',
    streamId: 'running',
    paramsSchema: z.object({ seconds: z.number().int().min(1) }),
    defaultParams: { seconds: 10 },
    defaultSeverity: 'info',
    evaluate: (payload, params) => {
      const { seconds } = params as { seconds: number }
      const cues = (payload as { cues?: RunningCue[] }).cues ?? []

      return cues.map((cue) => ({
        itemKey: cue.id,
        itemLabel: cue.name || cue.id,
        // A cue with no measurable duration reports remaining 0 forever, which
        // would otherwise sit permanently "about to end".
        active: cue.remaining > 0 && cue.remaining <= seconds,
        value: Math.round(cue.remaining),
        detail: `${cue.name || cue.id}: ${Math.round(cue.remaining)}s left`,
      }))
    },
  },
]
