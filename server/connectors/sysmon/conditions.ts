import { z } from 'zod'
import { overThreshold, underThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'
import type { SysMetrics } from './protocol.js'

export const sysmonConditions: readonly ConditionDecl[] = [
  {
    id: 'cpu.over',
    label: 'CPU high',
    description: 'Processor load has been above the threshold.',
    streamId: 'metrics',
    paramsSchema: z.object({ pct: z.number().min(1).max(100) }),
    defaultParams: { pct: 85 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const { cpuPct } = payload as SysMetrics
      const { pct } = params as { pct: number }
      if (typeof cpuPct !== 'number') return []
      return [
        {
          active: overThreshold(cpuPct, pct, wasActive?.() ?? false),
          value: cpuPct,
          detail: `${cpuPct.toFixed(0)}% CPU`,
        },
      ]
    },
  },
  {
    id: 'mem.pressure',
    label: 'Memory pressure',
    // The kernel's own verdict beats any percentage we could pick: macOS
    // compresses and caches aggressively, so "memory used" means little.
    description: 'macOS reports the machine is under memory pressure.',
    streamId: 'metrics',
    paramsSchema: z.object({ level: z.enum(['warn', 'critical']) }),
    defaultParams: { level: 'warn' as const },
    defaultSeverity: 'warning',
    evaluate: (payload, params) => {
      const { memPressure } = payload as SysMetrics
      const { level } = params as { level: 'warn' | 'critical' }
      if (!memPressure) return []

      const rank = { normal: 0, warn: 1, critical: 2 }
      return [
        {
          active: rank[memPressure] >= rank[level],
          value: memPressure,
          detail: `Memory pressure: ${memPressure}`,
        },
      ]
    },
  },
  {
    id: 'disk.low',
    label: 'Disk nearly full',
    description: 'Free space on the data volume is below the threshold.',
    streamId: 'metrics',
    paramsSchema: z.object({ gb: z.number().min(1).max(10_000) }),
    defaultParams: { gb: 20 },
    defaultSeverity: 'critical',
    evaluate: (payload, params) => {
      const { diskFreeBytes } = payload as SysMetrics
      const { gb } = params as { gb: number }
      if (typeof diskFreeBytes !== 'number') return []

      const freeGb = diskFreeBytes / 1_000_000_000
      return [
        { active: freeGb < gb, value: Math.round(freeGb), detail: `${freeGb.toFixed(1)} GB free` },
      ]
    },
  },
  {
    id: 'battery.low',
    label: 'Battery low',
    description: 'A laptop is running low on charge.',
    streamId: 'metrics',
    paramsSchema: z.object({ pct: z.number().min(1).max(100) }),
    defaultParams: { pct: 30 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const { batteryPct, onBattery } = payload as SysMetrics
      const { pct } = params as { pct: number }
      if (typeof batteryPct !== 'number') return []
      return [
        {
          // On mains at 20% is charging, not a problem.
          active: onBattery === true && underThreshold(batteryPct, pct, wasActive?.() ?? false),
          value: batteryPct,
          detail: `${batteryPct}% remaining`,
        },
      ]
    },
  },
  {
    id: 'on-battery',
    label: 'Running on battery',
    /**
     * The 2am problem: a show Mac quietly unplugged during changeover, running
     * fine until it isn't. Worth knowing the moment it happens, whatever the
     * charge level.
     */
    description: 'The machine is on battery rather than mains.',
    streamId: 'metrics',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'warning',
    evaluate: (payload) => {
      const { onBattery, batteryPct } = payload as SysMetrics
      if (onBattery === null || onBattery === undefined) return []
      return [
        {
          active: onBattery,
          value: batteryPct ?? 'unknown',
          detail: onBattery ? 'Unplugged from mains' : undefined,
        },
      ]
    },
  },
]
