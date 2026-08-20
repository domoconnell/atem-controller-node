import { z } from 'zod'
import { overThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'

/**
 * The reference implementation.
 *
 * The demo connector is what the tests, the E2E suite and demo mode all drive,
 * so its conditions double as the worked example for anyone writing a new
 * connector: one whole-instance condition and one per-item condition.
 */
export const demoConditions: readonly ConditionDecl[] = [
  {
    id: 'meter.over',
    label: 'Level over threshold',
    description: 'The simulated level has gone above the threshold.',
    streamId: 'meter',
    paramsSchema: z.object({ value: z.number() }),
    /*
     * Above where the simulated room sits, so the demo is quiet until
     * something actually happens.
     *
     * It was 80, and the simulated level drifts around 92 — so the reference
     * connector shipped permanently in alarm, and back when the level swung
     * eighteen decibels every three seconds it crossed this line twice a
     * cycle and made the problems board flicker. A demo whose board is always
     * shouting teaches the wrong thing about the board.
     */
    defaultParams: { value: 100 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const level = (payload as { value?: number }).value
      const { value } = params as { value: number }
      if (typeof level !== 'number') return []
      return [
        {
          active: overThreshold(level, value, wasActive?.() ?? false),
          value: Math.round(level * 10) / 10,
          detail: `Level ${level.toFixed(1)} (threshold ${value})`,
        },
      ]
    },
  },
  {
    id: 'state.is',
    label: 'Device in state',
    description: 'The simulated device is in a particular state.',
    streamId: 'state',
    paramsSchema: z.object({ state: z.string().min(1) }),
    defaultParams: { state: 'fault' },
    defaultSeverity: 'critical',
    evaluate: (payload, params) => {
      const current = (payload as { state?: string }).state
      const { state } = params as { state: string }
      if (typeof current !== 'string') return []
      return [
        {
          active: current === state,
          value: current,
          detail: `Device is ${current}`,
        },
      ]
    },
  },
]
