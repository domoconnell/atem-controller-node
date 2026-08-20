import { z } from 'zod'
import { overThreshold, underThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'

interface CurrentPayload {
  temperatureC: number | null
  windMs: number | null
  gustMs: number | null
  precipitationMm: number | null
}

/**
 * Weather conditions worth waking someone for.
 *
 * Wind is first because it is the one that stops a show: temporary structures,
 * PA wings and video walls all have a wind limit, and the site manager needs
 * warning before it is reached rather than after.
 */
export const weatherConditions: readonly ConditionDecl[] = [
  {
    id: 'wind.over',
    label: 'Wind above limit',
    description: 'Sustained wind speed has passed the site limit.',
    streamId: 'current',
    paramsSchema: z.object({ ms: z.number().min(0).max(60) }),
    // ~11 m/s is around 25 mph: the point at which most temporary structure
    // plans want a decision, not the point at which anything fails.
    defaultParams: { ms: 11 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const wind = (payload as CurrentPayload).windMs
      const { ms } = params as { ms: number }
      if (wind === null || wind === undefined) return []
      return [
        {
          active: overThreshold(wind, ms, wasActive?.() ?? false),
          value: Math.round(wind * 10) / 10,
          detail: `${wind.toFixed(1)} m/s sustained (limit ${ms})`,
        },
      ]
    },
  },
  {
    id: 'gust.over',
    label: 'Gusts above limit',
    description: 'Gust speed has passed the site limit.',
    streamId: 'current',
    paramsSchema: z.object({ ms: z.number().min(0).max(80) }),
    defaultParams: { ms: 17 },
    defaultSeverity: 'critical',
    evaluate: (payload, params, wasActive) => {
      const gust = (payload as CurrentPayload).gustMs
      const { ms } = params as { ms: number }
      if (gust === null || gust === undefined) return []
      return [
        {
          active: overThreshold(gust, ms, wasActive?.() ?? false),
          value: Math.round(gust * 10) / 10,
          detail: `${gust.toFixed(1)} m/s gusting (limit ${ms})`,
        },
      ]
    },
  },
  {
    id: 'rain.now',
    label: 'Raining',
    description: 'Measurable rainfall in the current hour.',
    streamId: 'current',
    paramsSchema: z.object({ mm: z.number().min(0).max(50) }),
    defaultParams: { mm: 0.2 },
    defaultSeverity: 'info',
    evaluate: (payload, params) => {
      const rain = (payload as CurrentPayload).precipitationMm
      const { mm } = params as { mm: number }
      if (rain === null || rain === undefined) return []
      return [{ active: rain >= mm, value: rain, detail: `${rain.toFixed(1)} mm this hour` }]
    },
  },
  {
    id: 'temp.under',
    label: 'Cold',
    // Below a few degrees, crew welfare and instrument tuning both become
    // real production problems.
    description: 'Temperature has dropped below the threshold.',
    streamId: 'current',
    paramsSchema: z.object({ celsius: z.number().min(-40).max(40) }),
    defaultParams: { celsius: 3 },
    defaultSeverity: 'info',
    evaluate: (payload, params, wasActive) => {
      const temperature = (payload as CurrentPayload).temperatureC
      const { celsius } = params as { celsius: number }
      if (temperature === null || temperature === undefined) return []
      return [
        {
          active: underThreshold(temperature, celsius, wasActive?.() ?? false),
          value: Math.round(temperature * 10) / 10,
          detail: `${temperature.toFixed(1)}°C`,
        },
      ]
    },
  },
]
