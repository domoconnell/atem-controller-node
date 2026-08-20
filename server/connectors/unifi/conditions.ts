import { z } from 'zod'
import { overThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'
import type { UnifiDevice } from './protocol.js'

/**
 * The other module Dave named for problems-only viewing: a network with forty
 * access points, where the operator wants the one that dropped off.
 */
export const unifiConditions: readonly ConditionDecl[] = [
  {
    id: 'device.down',
    label: 'Network device offline',
    description: 'An access point or switch is not reporting to the controller.',
    streamId: 'devices',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'critical',
    evaluate: (payload) => {
      const devices = (payload as { devices?: UnifiDevice[] }).devices ?? []
      return devices.map((device) => ({
        itemKey: device.id,
        itemLabel: device.name,
        active: !device.online,
        value: device.state,
        detail: device.online ? undefined : `${device.name} is ${device.state.toLowerCase()}`,
      }))
    },
  },
  {
    id: 'cpu.over',
    label: 'Device CPU high',
    // A saturated AP drops clients long before it goes offline, so this is
    // usually the first sign of a network that is about to embarrass everyone.
    description: 'A network device is running hot on CPU.',
    streamId: 'devices',
    paramsSchema: z.object({ pct: z.number().min(1).max(100) }),
    defaultParams: { pct: 80 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const devices = (payload as { devices?: UnifiDevice[] }).devices ?? []
      const { pct } = params as { pct: number }

      return devices
        .filter((device) => device.cpuPct !== null)
        .map((device) => ({
          itemKey: device.id,
          itemLabel: device.name,
          active:
            device.online &&
            overThreshold(device.cpuPct ?? 0, pct, wasActive?.(device.id) ?? false),
          value: device.cpuPct ?? 0,
          detail: `${device.cpuPct}% CPU`,
        }))
    },
  },
  {
    id: 'clients.over',
    label: 'Access point crowded',
    description: 'One access point is carrying more clients than it should.',
    streamId: 'devices',
    paramsSchema: z.object({ count: z.number().int().min(1).max(500) }),
    defaultParams: { count: 60 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const devices = (payload as { devices?: UnifiDevice[] }).devices ?? []
      const { count } = params as { count: number }

      return devices
        .filter((device) => device.clientCount !== null)
        .map((device) => ({
          itemKey: device.id,
          itemLabel: device.name,
          active: overThreshold(device.clientCount ?? 0, count, wasActive?.(device.id) ?? false),
          value: device.clientCount ?? 0,
          detail: `${device.clientCount} clients`,
        }))
    },
  },
]
