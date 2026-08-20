import type { ConfigOptions } from '@stageit/shared'
import { z } from 'zod'
import { overThreshold, underThreshold } from '../core/hysteresis.js'
import { type ConditionDecl, type ConditionOptionSource, fieldsFromSeries } from '../core/types.js'
import { DEFAULT_METRIC_NAMES, slugForMetric } from './protocol.js'

/** The default headline: A-weighted, slow. What a licence is usually written on. */
export const DEFAULT_METRIC_FIELD = slugForMetric('SPL A Slow')

/** Slug back to the name a person would recognise, for the windows we know of. */
const KNOWN_BY_SLUG = new Map(DEFAULT_METRIC_NAMES.map((name) => [slugForMetric(name), name]))

/**
 * Numbers in the SPL frame that are not sound levels.
 *
 * Nothing in the payload matches these today — `violations` is an array of
 * names and the rest are strings — so this is insurance rather than a fix. It
 * is cheap insurance: the frame is a spread of whatever the connector chose to
 * publish, and the day a timestamp or a count joins it, the rule editor would
 * quietly offer somebody an SPL alarm that fires on the clock.
 */
const NOT_A_READING = new Set(['at', 'ts', 'violations', 'device', 'channel'])

/**
 * SPL conditions.
 *
 * Thresholds default to nothing in particular on purpose — every venue has its
 * own licence limit, and a number baked in here would be wrong everywhere. The
 * admin sets them per instance when they write the alert rule.
 *
 * `metric` is a plain string rather than an enum, and that is still
 * deliberate. The Leq windows a Smaart offers are configured inside Smaart, so
 * no list written here could ever be complete — and a dropdown that looked
 * authoritative while quietly omitting the very window somebody's licence is
 * written around would be worse than a text box.
 *
 * What it now has is `paramOptions`: the field stays free text and gains a
 * list of what **this** Smaart is actually reporting. Nobody knows `splASlow`
 * by heart, and a rule written from memory saves cleanly and never fires.
 * Suggested, not enforced — both halves of that matter.
 */
/**
 * The metrics this Smaart is reporting, for the rule editor to offer.
 *
 * **The live frame wins when there is one**, because it is the only
 * authoritative answer to "what will a rule written now actually match". The
 * recorded series are the fallback for a module that is switched off — which
 * is most of the week before load-in, and exactly when the rules get written.
 *
 * They are not merged, deliberately. A season of recordings accumulates names
 * the rig has stopped using — this very dev database holds both `splASlow` and
 * a `SPLASlow` from an older naming — and offering those beside the live ones
 * would invite somebody to pick a metric that can never fire again. Stale
 * names are worth having only when there is nothing better.
 */
function metricOptions(source: ConditionOptionSource): ConfigOptions {
  const payload = source.payload as Record<string, unknown> | null
  const live = payload
    ? Object.entries(payload)
        .filter(([field, value]) => typeof value === 'number' && !NOT_A_READING.has(field))
        .map(([field]) => field)
    : []

  const names = live.length > 0 ? live : fieldsFromSeries(source.recordedSeries, 'spl')

  /*
   * Recognised windows first, then the rest, each alphabetically.
   *
   * A datalist is shown in the order it is given, and the fallback list can
   * carry names the rig has retired — this project's own dev database holds
   * two slug schemes side by side. Recognising a name is decent evidence it is
   * current, so those go to the top.
   *
   * Ordering, not filtering, and the difference is the whole point: a window
   * configured inside Smaart that nothing here has heard of is exactly the one
   * somebody's licence may be written around, so it stays on the list.
   */
  const known = (value: string) => (KNOWN_BY_SLUG.has(value) ? 0 : 1)
  const options = [...names]
    .sort((a, b) => known(a) - known(b) || a.localeCompare(b))
    .map((value) => {
      // `splASlow` is what the rule stores and what the payload is keyed by, so
      // the value has to be the slug. The human name is offered alongside where
      // it is one of the windows every Smaart has — a custom window configured
      // inside Smaart has no name here to give, and shows as itself.
      const name = KNOWN_BY_SLUG.get(value)
      return name ? { value, label: `${value} — ${name}` } : { value }
    })
  // Both SPL conditions take the same parameter and read the same stream.
  return { metric: options }
}

export const smaartConditions: readonly ConditionDecl[] = [
  {
    id: 'spl.over',
    label: 'SPL over limit',
    description: 'The chosen sound level metric has gone above the venue limit.',
    streamId: 'spl',
    paramsSchema: z.object({
      metric: z.string().min(1).default(DEFAULT_METRIC_FIELD),
      db: z.number().min(0).max(200),
    }),
    defaultParams: { metric: DEFAULT_METRIC_FIELD, db: 100 },
    defaultSeverity: 'warning',
    paramOptions: metricOptions,
    evaluate: (payload, params, wasActive) => {
      const { metric, db } = params as { metric: string; db: number }
      const value = (payload as Record<string, unknown>)[metric]
      // No reading, no opinion. A rule pointed at a window this Smaart is not
      // producing says nothing rather than saying everything is fine.
      if (typeof value !== 'number') return []
      return [
        {
          active: overThreshold(value, db, wasActive?.() ?? false),
          value: Math.round(value * 10) / 10,
          detail: `${metric} ${value.toFixed(1)} dB (limit ${db})`,
        },
      ]
    },
  },
  {
    id: 'spl.silent',
    label: 'No sound',
    // Worth having: an SPL feed reading near-silence during a set usually
    // means the measurement mic has been knocked or unplugged, not that the
    // band stopped.
    description: 'Sound level has dropped near silence — often a knocked or unplugged mic.',
    streamId: 'spl',
    paramsSchema: z.object({
      metric: z.string().min(1).default(DEFAULT_METRIC_FIELD),
      db: z.number().min(0).max(200),
    }),
    defaultParams: { metric: DEFAULT_METRIC_FIELD, db: 40 },
    defaultSeverity: 'info',
    paramOptions: metricOptions,
    evaluate: (payload, params, wasActive) => {
      const { metric, db } = params as { metric: string; db: number }
      const value = (payload as Record<string, unknown>)[metric]
      if (typeof value !== 'number') return []
      return [
        {
          active: underThreshold(value, db, wasActive?.() ?? false),
          value: Math.round(value * 10) / 10,
          detail: `${metric} ${value.toFixed(1)} dB`,
        },
      ]
    },
  },
  {
    id: 'spl.violation',
    label: 'Smaart alarm breached',
    /*
     * Smaart's own alarm, not ours.
     *
     * An operator who has configured an alarm inside Smaart has already stated
     * the limit that matters to them, on the instrument that measures it. That
     * is worth surfacing on its own rather than making them state it twice —
     * and unlike our threshold, it is the figure a Smaart log will show.
     */
    description: 'A metric has passed an alarm level configured inside Smaart itself.',
    streamId: 'spl',
    paramsSchema: z.object({}).default({}),
    defaultParams: {},
    defaultSeverity: 'warning',
    evaluate: (payload) => {
      const violations = (payload as { violations?: unknown }).violations
      if (!Array.isArray(violations)) return []
      // Whole-instance rather than per-metric: one module follows one
      // measurement position, and the position is already in the alert text.
      return [
        {
          active: violations.length > 0,
          detail:
            violations.length > 0
              ? `Smaart alarm on ${violations.join(', ')}`
              : 'No Smaart alarms breached',
        },
      ]
    },
  },
]
