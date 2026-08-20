import { z } from 'zod'
import { groupNameSchema, groupSchema } from '../domain/group.js'
import { severitySchema } from '../domain/health.js'
import {
  instanceNameSchema,
  instanceWithStatusSchema,
  typeCatalogueEntrySchema,
} from '../domain/instance.js'
import { OPERATING_MODES, operatingModeSchema } from '../domain/mode.js'
import { profileLayoutSchema, profileNameSchema, profileSchema } from '../domain/profile.js'
import {
  contactDetailsSchema,
  passwordSchema,
  roleSchema,
  sessionUserSchema,
  usernameSchema,
  userSchema,
} from '../domain/user.js'

// ------------------------------------------------------------------ auth

export const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const loginResponseSchema = z.object({ user: sessionUserSchema })

export const meResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
  /** True before any user exists: the SPA routes to the setup wizard. */
  setupRequired: z.boolean(),
})

export const setupBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional(),
  siteName: z.string().trim().max(80).optional(),
  seedDemoInstances: z.boolean().default(false),
})

// ------------------------------------------------------------------ users

/**
 * "Who would this actually text?", asked from the rule editor.
 *
 * Groups arrive comma-separated because this is a GET and the answer changes
 * with every chip somebody toggles — a body would mean a POST for a read.
 */
export const reachQuerySchema = z.object({
  groups: z
    .string()
    .default('')
    .transform((value) => value.split(',').filter(Boolean)),
  /** Absent for a rule scoped to a connector type: no one module to check. */
  instanceId: z.string().optional(),
  severity: severitySchema.default('warning'),
})
export type ReachQuery = z.input<typeof reachQuerySchema>

export const createUserBodySchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(80).nullable().default(null),
    role: roleSchema,
  })
  .merge(contactDetailsSchema)

export const updateUserBodySchema = z
  .object({
    password: passwordSchema.optional(),
    displayName: z.string().trim().max(80).nullable().optional(),
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .merge(contactDetailsSchema)

export const usersResponseSchema = z.object({ users: z.array(userSchema) })

// ------------------------------------------------------------------ groups

export const createGroupBodySchema = z.object({
  name: groupNameSchema,
  description: z.string().trim().max(200).nullable().default(null),
})

export const updateGroupBodySchema = z.object({
  name: groupNameSchema.optional(),
  description: z.string().trim().max(200).nullable().optional(),
})

/** Replace-set semantics: simpler to reason about than add/remove deltas. */
export const setGroupMembersBodySchema = z.object({
  userIds: z.array(z.string()).max(500),
})

export const groupsResponseSchema = z.object({
  groups: z.array(groupSchema),
})

// ------------------------------------------------------------------ alerts

export const createAlertRuleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    targetKind: z.enum(['instance', 'type']),
    instanceId: z.string().nullable().default(null),
    typeId: z.string().nullable().default(null),
    conditionId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    severity: severitySchema,
    /** Must hold this long before anyone is told. */
    forMs: z.number().int().min(0).max(3_600_000).default(0),
    /** Must stay clear this long before the incident closes. */
    clearAfterMs: z.number().int().min(0).max(3_600_000).default(0),
    /** Re-activation inside this window reopens the incident silently. */
    cooldownMs: z.number().int().min(0).max(86_400_000).default(0),
    notifyGroupIds: z.array(z.string()).default([]),
    /** Defaults to every mode: a rule that says nothing is always live. */
    modes: z
      .array(operatingModeSchema)
      .min(1)
      .default([...OPERATING_MODES]),
  })
  .refine((rule) => (rule.targetKind === 'instance' ? rule.instanceId : rule.typeId), {
    message: 'Choose the module or module type this rule applies to',
  })

export const updateAlertRuleBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  targetKind: z.enum(['instance', 'type']).optional(),
  instanceId: z.string().nullable().optional(),
  typeId: z.string().nullable().optional(),
  conditionId: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  severity: severitySchema.optional(),
  forMs: z.number().int().min(0).max(3_600_000).optional(),
  clearAfterMs: z.number().int().min(0).max(3_600_000).optional(),
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  notifyGroupIds: z.array(z.string()).optional(),
  modes: z.array(operatingModeSchema).min(1).optional(),
})

export const eventQueryAlertSchema = z.object({
  instanceId: z.string().optional(),
  ruleId: z.string().optional(),
  severity: severitySchema.optional(),
  status: z.enum(['active', 'resolved']).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})

/** Omitting ids marks the whole inbox read. */
export const markReadBodySchema = z.object({
  ids: z.array(z.number().int()).optional(),
})

// ------------------------------------------------------------------ instances

export const createInstanceBodySchema = z.object({
  typeId: z.string().min(1),
  name: instanceNameSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  allowControl: z.boolean().default(false),
  simulate: z.boolean().default(false),
  /** Groups that may see / operate this instance. Empty view = admin-only. */
  viewGroupIds: z.array(z.string()).default([]),
  controlGroupIds: z.array(z.string()).default([]),
})

export const updateInstanceBodySchema = z.object({
  name: instanceNameSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  allowControl: z.boolean().optional(),
  simulate: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  viewGroupIds: z.array(z.string()).optional(),
  controlGroupIds: z.array(z.string()).optional(),
})

export const instancesResponseSchema = z.object({
  instances: z.array(instanceWithStatusSchema),
})

export const typeCatalogueResponseSchema = z.object({
  types: z.array(typeCatalogueEntrySchema),
})

// ------------------------------------------------------------------ profiles

export const createProfileBodySchema = z.object({
  name: profileNameSchema,
  layout: profileLayoutSchema.optional(),
  isShared: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  /** Copy an existing profile's widgets as a starting point. */
  copyFromId: z.string().optional(),
  /** Shared profiles only: groups this dashboard is for. Empty = everyone. */
  groupIds: z.array(z.string()).default([]),
})

export const updateProfileBodySchema = z.object({
  name: profileNameSchema.optional(),
  layout: profileLayoutSchema.optional(),
  isShared: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  groupIds: z.array(z.string()).optional(),
})

export const profilesResponseSchema = z.object({ profiles: z.array(profileSchema) })

// ------------------------------------------------------------------ settings & history

export const SETTINGS_DEFAULTS = {
  siteName: 'Stage It Live',
  metricsRetentionHours: 72,
  eventsRetentionDays: 30,
  /** Alert history outlives the event log: it is what a post-show review reads. */
  alertEventsRetentionDays: 90,
  notificationsRetentionDays: 30,
  /** Per person, per hour. Beyond this, texts pause and the app says so. */
  smsHourlyCap: 10,
  /** SPL thresholds used as widget defaults, in dB. */
  splWarnDb: 97,
  splAlarmDb: 102,
  /** How far ahead of a scheduled entry show mode arms itself. */
  showModeLeadMinutes: 15,
} as const

/**
 * Field rules without defaults. Kept separate because `.partial()` does not
 * strip `.default()` — a PATCH built from a defaulted schema would silently
 * reset every field the caller didn't mention.
 */
const settingsFields = {
  siteName: z.string().trim().min(1).max(80),
  metricsRetentionHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90),
  eventsRetentionDays: z.number().int().min(1).max(365),
  alertEventsRetentionDays: z.number().int().min(1).max(730),
  notificationsRetentionDays: z.number().int().min(1).max(365),
  smsHourlyCap: z.number().int().min(1).max(100),
  splWarnDb: z.number().min(0).max(200),
  splAlarmDb: z.number().min(0).max(200),
  showModeLeadMinutes: z.number().int().min(0).max(240),
}

/** Reading stored settings: missing keys fall back to defaults. */
export const settingsSchema = z.object({
  siteName: settingsFields.siteName.default(SETTINGS_DEFAULTS.siteName),
  metricsRetentionHours: settingsFields.metricsRetentionHours.default(
    SETTINGS_DEFAULTS.metricsRetentionHours,
  ),
  eventsRetentionDays: settingsFields.eventsRetentionDays.default(
    SETTINGS_DEFAULTS.eventsRetentionDays,
  ),
  alertEventsRetentionDays: settingsFields.alertEventsRetentionDays.default(
    SETTINGS_DEFAULTS.alertEventsRetentionDays,
  ),
  notificationsRetentionDays: settingsFields.notificationsRetentionDays.default(
    SETTINGS_DEFAULTS.notificationsRetentionDays,
  ),
  smsHourlyCap: settingsFields.smsHourlyCap.default(SETTINGS_DEFAULTS.smsHourlyCap),
  splWarnDb: settingsFields.splWarnDb.default(SETTINGS_DEFAULTS.splWarnDb),
  splAlarmDb: settingsFields.splAlarmDb.default(SETTINGS_DEFAULTS.splAlarmDb),
  showModeLeadMinutes: settingsFields.showModeLeadMinutes.default(
    SETTINGS_DEFAULTS.showModeLeadMinutes,
  ),
})
export type Settings = z.infer<typeof settingsSchema>

/** Writing settings: only the keys actually sent are touched. */
export const updateSettingsBodySchema = z.object(settingsFields).partial()

/**
 * The activity log: who did what, and what the platform did back.
 *
 * Named activity rather than events because an event is now a festival —
 * see docs/plans/events.md. The UI has always called this Activity.
 */
export const activityQuerySchema = z.object({
  instanceId: z.string().optional(),
  kind: z.enum(['status', 'command', 'auth', 'system']).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})

export const activitySchema = z.object({
  id: z.number(),
  ts: z.number(),
  kind: z.enum(['status', 'command', 'auth', 'system']),
  instanceId: z.string().nullable(),
  instanceName: z.string().nullable(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
  data: z.unknown(),
})
export type ActivityRecord = z.infer<typeof activitySchema>

export const activityResponseSchema = z.object({ activity: z.array(activitySchema) })

export const metricsQuerySchema = z.object({
  instanceId: z.string(),
  metric: z.string().optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
})

export const metricPointSchema = z.object({
  metric: z.string(),
  ts: z.number(),
  value: z.number(),
})

export const metricsResponseSchema = z.object({ points: z.array(metricPointSchema) })

// ------------------------------------------------------------------ health

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number(),
  version: z.string(),
  /** Applied schema per database, and the highest this build carries. */
  schema: z.object({
    platform: z.number(),
    event: z.number(),
    latestPlatform: z.number(),
    latestEvent: z.number(),
  }),
  eventLoopLagMs: z.number(),
  wsClients: z.number(),
  dbSizeBytes: z.number(),
  instances: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      typeId: z.string(),
      state: z.string(),
      detail: z.string().nullable(),
    }),
  ),
})
export type HealthResponse = z.infer<typeof healthResponseSchema>

export const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type LoginBody = z.infer<typeof loginBodySchema>
export type SetupBody = z.infer<typeof setupBodySchema>
export type CreateInstanceBody = z.infer<typeof createInstanceBodySchema>
export type UpdateInstanceBody = z.infer<typeof updateInstanceBodySchema>
export type CreateProfileBody = z.infer<typeof createProfileBodySchema>
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>
export type CreateUserBody = z.infer<typeof createUserBodySchema>
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>
export type ActivityQuery = z.infer<typeof activityQuerySchema>
