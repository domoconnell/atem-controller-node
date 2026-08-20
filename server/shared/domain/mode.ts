import { z } from 'zod'
import { severitySchema } from './health.js'

/**
 * How the platform behaves right now.
 *
 * One site-wide mode rather than one per person: everybody working the show
 * has to agree what state it is in, or an alert quietened for one of them
 * pages another. It is a property of the event, not of a viewer.
 */
export const OPERATING_MODES = ['config', 'prep', 'show'] as const
export type OperatingMode = (typeof OPERATING_MODES)[number]

export const operatingModeSchema = z.enum(OPERATING_MODES)

/**
 * What editing a dashboard does in a given mode.
 *
 * An enum rather than a boolean so `locked` can be turned on later without a
 * migration. Nothing is seeded as `locked` today — show mode warns.
 */
export const LAYOUT_POLICIES = ['open', 'warn', 'locked'] as const
export type LayoutPolicy = (typeof LAYOUT_POLICIES)[number]

export const modeConfigSchema = z.object({
  mode: operatingModeSchema,
  layoutPolicy: z.enum(LAYOUT_POLICIES),
  /** Alerts below this are recorded but not pushed at anyone. */
  minNotifySeverity: severitySchema,
  updatedAt: z.number(),
})
export type ModeConfig = z.infer<typeof modeConfigSchema>

export const updateModeConfigSchema = modeConfigSchema
  .pick({ layoutPolicy: true, minNotifySeverity: true })
  .partial()
export type UpdateModeConfig = z.infer<typeof updateModeConfigSchema>

/**
 * The live feed, deliberately thin.
 *
 * `sys:` payloads reach every authenticated user, so nothing here may be
 * scoped to a subset of them — which rules a mode has quietened is recorded in
 * the audit log instead, behind `history:read`.
 */
export const sysModeSchema = z.object({
  mode: operatingModeSchema,
  since: z.number(),
  /** True when the schedule armed it rather than a person. */
  automatic: z.boolean(),
  /**
   * Older than a show is worth questioning: restart the appliance the morning
   * after a gig and it would otherwise come back in show mode during load-in.
   */
  stale: z.boolean(),
  /** The next scheduled arming, so the UI can warn before it happens. */
  armedFor: z.object({ label: z.string(), startsAt: z.number(), atMs: z.number() }).nullable(),
})
export type SysMode = z.infer<typeof sysModeSchema>

/** A mode set this long ago probably belongs to yesterday's show. */
export const STALE_MODE_MS = 8 * 60 * 60_000
