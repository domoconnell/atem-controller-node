import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

interface TimerReading {
  uuid: string
  name: string
  seconds: number
  state: string
}

/**
 * The timers this ProPresenter has, by name.
 *
 * Blank still means "every timer", so this is an aid rather than a
 * requirement — and no empty option is offered, because a datalist cannot say
 * "leave this alone" more clearly than an empty box already does.
 */
const timerOptions: NonNullable<ConditionDecl['paramOptions']> = (source) => {
  const timers = (source.payload as { timers?: { name?: string }[] } | null)?.timers ?? []
  const names = [...new Set(timers.map((timer) => timer.name).filter(Boolean))] as string[]
  return { timerName: names.sort().map((value) => ({ value })) }
}

export const propresenterConditions: readonly ConditionDecl[] = [
  {
    id: 'timer.overrun',
    label: 'Timer overrun',
    // ProPresenter counts a countdown past zero into negative seconds, which
    // is exactly the moment a stage manager wants to know about.
    description: 'A running countdown has passed zero.',
    streamId: 'timers',
    paramsSchema: z.object({
      /** Blank watches every timer; a name watches one. */
      timerName: z.string().optional(),
    }),
    defaultParams: {},
    defaultSeverity: 'warning',
    paramOptions: timerOptions,
    evaluate: (payload, params) => {
      const { timerName } = params as { timerName?: string }
      const timers = (payload as { timers?: TimerReading[] }).timers ?? []

      return timers
        .filter((timer) => !timerName || timer.name === timerName)
        .map((timer) => ({
          itemKey: timer.uuid,
          itemLabel: timer.name,
          active: timer.state === 'running' && timer.seconds < 0,
          value: timer.seconds,
          detail: `${timer.name} is ${Math.abs(timer.seconds)}s over`,
        }))
    },
  },
  {
    id: 'timer.low',
    label: 'Timer nearly up',
    description: 'A running countdown is within the warning window of zero.',
    streamId: 'timers',
    paramsSchema: z.object({
      seconds: z.number().int().min(1),
      timerName: z.string().optional(),
    }),
    defaultParams: { seconds: 120 },
    defaultSeverity: 'info',
    paramOptions: timerOptions,
    evaluate: (payload, params) => {
      const { seconds, timerName } = params as { seconds: number; timerName?: string }
      const timers = (payload as { timers?: TimerReading[] }).timers ?? []

      return timers
        .filter((timer) => !timerName || timer.name === timerName)
        .map((timer) => ({
          itemKey: timer.uuid,
          itemLabel: timer.name,
          active: timer.state === 'running' && timer.seconds >= 0 && timer.seconds <= seconds,
          value: timer.seconds,
          detail: `${timer.name}: ${timer.seconds}s remaining`,
        }))
    },
  },
]
