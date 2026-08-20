import { z } from 'zod'
import { overThreshold, underThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'

interface LatencyPayload {
  up: boolean
  rttAvgMs: number | null
  lossPct: number
}

export const netcheckConditions: readonly ConditionDecl[] = [
  {
    id: 'host.down',
    label: 'Host unreachable',
    description: 'Every probe in the last round failed.',
    streamId: 'latency',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'critical',
    evaluate: (payload): { active: boolean; value: string; detail?: string }[] => {
      const { up } = payload as LatencyPayload
      if (typeof up !== 'boolean') return []
      return [{ active: !up, value: up ? 'up' : 'down', detail: up ? undefined : 'No reply' }]
    },
  },
  {
    id: 'latency.over',
    label: 'Latency high',
    description: 'Average round-trip time is above the threshold.',
    streamId: 'latency',
    paramsSchema: z.object({ ms: z.number().min(1).max(10_000) }),
    defaultParams: { ms: 100 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const { rttAvgMs } = payload as LatencyPayload
      const { ms } = params as { ms: number }
      if (typeof rttAvgMs !== 'number') return []
      return [
        {
          active: overThreshold(rttAvgMs, ms, wasActive?.() ?? false),
          value: rttAvgMs,
          detail: `${rttAvgMs.toFixed(1)} ms average`,
        },
      ]
    },
  },
  {
    id: 'loss.over',
    label: 'Packet loss',
    // Loss matters more than latency on a show network: intermittent loss is
    // what makes a control protocol feel haunted rather than slow.
    description: 'Packet loss is above the threshold.',
    streamId: 'latency',
    paramsSchema: z.object({ pct: z.number().min(0).max(100) }),
    defaultParams: { pct: 5 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const { lossPct } = payload as LatencyPayload
      const { pct } = params as { pct: number }
      if (typeof lossPct !== 'number') return []
      return [
        {
          active: overThreshold(lossPct, pct, wasActive?.() ?? false),
          value: lossPct,
          detail: `${lossPct}% loss`,
        },
      ]
    },
  },
  {
    id: 'speed.under',
    label: 'Throughput low',
    description: 'The last speed test came in below the expected rate.',
    streamId: 'speed',
    paramsSchema: z.object({ downMbps: z.number().min(0).max(10_000) }),
    defaultParams: { downMbps: 10 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const down = (payload as { downMbps: number | null }).downMbps
      const { downMbps } = params as { downMbps: number }
      if (typeof down !== 'number') return []
      return [
        {
          active: underThreshold(down, downMbps, wasActive?.() ?? false),
          value: down,
          detail: `${down.toFixed(1)} Mbps down`,
        },
      ]
    },
  },
]
