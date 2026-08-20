import { z } from 'zod'
import type { ConditionDecl } from '../core/types.js'

export const companionConditions: readonly ConditionDecl[] = [
  {
    id: 'variables.failing',
    label: 'Variables unreadable',
    // Companion answered, but some of the variables this instance was pointed
    // at came back empty — usually a renamed connection or a module that has
    // dropped its own device.
    description: 'Companion is reachable but some configured variables could not be read.',
    streamId: 'connection',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'warning',
    evaluate: (payload) => {
      const { failedCount } = payload as { failedCount?: number }
      if (typeof failedCount !== 'number') return []
      return [
        {
          active: failedCount > 0,
          value: failedCount,
          detail: `${failedCount} variable(s) could not be read`,
        },
      ]
    },
  },
  {
    id: 'variable.matches',
    label: 'Variable matches',
    /**
     * The general-purpose escape hatch. Companion is the venue's glue layer and
     * already knows about hundreds of devices, so watching one of its variables
     * for a value is often the shortest path to an alert about something this
     * dashboard has no dedicated connector for.
     */
    description:
      'A named Companion variable matches a pattern — a catch-all for gear with no ' +
      'connector of its own.',
    streamId: 'variables',
    paramsSchema: z.object({
      variable: z.string().min(1),
      pattern: z.string().min(1),
    }),
    defaultParams: { variable: '', pattern: '' },
    defaultSeverity: 'warning',
    /*
     * The variables this Companion is configured to read, exactly as they were
     * typed into the module — which is the string the rule has to match. There
     * is nothing to fall back on when it is offline: unlike a metric, a
     * Companion variable is never recorded as a series.
     */
    paramOptions: (source) => {
      const values = (source.payload as { values?: Record<string, unknown> } | null)?.values
      return {
        variable: Object.keys(values ?? {})
          .sort()
          .map((value) => ({ value })),
      }
    },
    evaluate: (payload, params) => {
      const { variable, pattern } = params as { variable: string; pattern: string }
      if (!variable || !pattern) return []

      const values = (payload as { values?: Record<string, string | null> }).values ?? {}
      const value = values[variable]
      if (value === undefined || value === null) return []

      let matches: boolean
      try {
        matches = new RegExp(pattern, 'i').test(value)
      } catch {
        // A malformed pattern is the admin's typo, not a device fault: fall
        // back to a literal comparison rather than alarming about nothing.
        matches = value.toLowerCase().includes(pattern.toLowerCase())
      }

      return [
        {
          itemKey: variable,
          itemLabel: variable,
          active: matches,
          value,
          detail: `${variable} = ${value}`,
        },
      ]
    },
  },
]
