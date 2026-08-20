import { z } from 'zod'

/**
 * How loudly a problem should shout.
 *
 * Three levels, deliberately: crew triage under pressure, and a scale with
 * more gradations than that gets used inconsistently and then ignored.
 */
export const severitySchema = z.enum(['info', 'warning', 'critical'])
export type Severity = z.infer<typeof severitySchema>

export const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 }

export function worstSeverity(severities: readonly Severity[]): Severity | null {
  let worst: Severity | null = null
  for (const severity of severities) {
    if (!worst || SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity
  }
  return worst
}

export const healthLevelSchema = z.enum(['ok', 'info', 'warning', 'critical'])
export type HealthLevel = z.infer<typeof healthLevelSchema>

/**
 * One active problem on one instance.
 *
 * `itemKey` is what makes "show only the receivers with low batteries" work:
 * conditions report per item (a channel, a track, a disk), not just per
 * instance, so a widget can filter its rows down to the ones in trouble.
 */
export const healthProblemSchema = z.object({
  conditionId: z.string(),
  label: z.string(),
  itemKey: z.string().nullable(),
  itemLabel: z.string().nullable(),
  severity: severitySchema,
  /** When the problem started — drives "for the last 6 minutes" in the UI. */
  since: z.number(),
  value: z.union([z.number(), z.string()]).nullable(),
  detail: z.string().nullable(),
  /** The alert rule that set the thresholds, if a rule rather than defaults. */
  ruleId: z.string().nullable(),
})
export type HealthProblem = z.infer<typeof healthProblemSchema>

export const instanceHealthSchema = z.object({
  instanceId: z.string(),
  level: healthLevelSchema,
  problems: z.array(healthProblemSchema),
  updatedAt: z.number(),
})
export type InstanceHealth = z.infer<typeof instanceHealthSchema>

/** One line per instance for boards that summarise the whole rig. */
export const healthSummarySchema = z.object({
  level: healthLevelSchema,
  problemCount: z.number(),
  worst: z
    .object({
      conditionId: z.string(),
      label: z.string(),
      itemLabel: z.string().nullable(),
      severity: severitySchema,
    })
    .nullable(),
})
export type HealthSummary = z.infer<typeof healthSummarySchema>

export const sysHealthSchema = z.record(z.string(), healthSummarySchema)
export type SysHealth = z.infer<typeof sysHealthSchema>

export function levelFromProblems(problems: readonly { severity: Severity }[]): HealthLevel {
  return worstSeverity(problems.map((problem) => problem.severity)) ?? 'ok'
}

/** Safe parse for widget code: bad or absent payloads render as "no data". */
export function parseInstanceHealth(data: unknown): InstanceHealth | null {
  const parsed = instanceHealthSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}
