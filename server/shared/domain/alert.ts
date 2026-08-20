import { z } from 'zod'
import { severitySchema } from './health.js'
import { OPERATING_MODES, type OperatingMode, operatingModeSchema } from './mode.js'

/**
 * An alert rule: a condition, thresholds, and how patient to be about it.
 *
 * The three timings exist because a raw threshold crossing is not an incident.
 * `forMs` waits for the problem to persist, `clearAfterMs` waits for the fix to
 * hold, and `cooldownMs` folds a flapping value into one incident rather than
 * forty pages at 2am.
 */
export const alertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** One instance, or every instance of a module type. */
  targetKind: z.enum(['instance', 'type']),
  instanceId: z.string().nullable(),
  typeId: z.string().nullable(),
  conditionId: z.string(),
  params: z.record(z.string(), z.unknown()),
  severity: severitySchema,
  forMs: z.number(),
  clearAfterMs: z.number(),
  cooldownMs: z.number(),
  /** Groups whose members get notified. Empty = nobody, events only. */
  notifyGroupIds: z.array(z.string()),
  /**
   * Which operating modes this rule is live in. Every mode by default, so a
   * rule written before modes existed behaves exactly as it always did.
   */
  modes: z.array(operatingModeSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AlertRule = z.infer<typeof alertRuleSchema>

/**
 * Whether a rule is doing anything at all right now.
 *
 * The single predicate. `rule.enabled` used to be tested in five places — two
 * of them outside the rule engine — and the whole point of routing every one
 * through here is that going out-of-mode behaves *identically* to being
 * switched off. That equivalence is what lets the existing semantics (an open
 * incident resolves, a restart does not re-page) carry over for free.
 */
export function isRuleLive(rule: AlertRule, mode: OperatingMode): boolean {
  return rule.enabled && rule.modes.includes(mode)
}

/** Why a rule is not live, in words fit for an alert's resolution reason. */
export function notLiveReason(rule: AlertRule | undefined, mode: OperatingMode): string {
  if (!rule) return 'rule removed'
  if (!rule.enabled) return 'rule disabled'
  return `not live in ${mode} mode`
}

/** All modes: the default for a rule that has not said otherwise. */
export const ALL_MODES: OperatingMode[] = [...OPERATING_MODES]

export const alertEventSchema = z.object({
  id: z.number(),
  ruleId: z.string(),
  ruleName: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  conditionId: z.string(),
  itemKey: z.string().nullable(),
  itemLabel: z.string().nullable(),
  severity: severitySchema,
  status: z.enum(['active', 'resolved']),
  triggeredAt: z.number(),
  resolvedAt: z.number().nullable(),
  /** How many times it came back inside the cooldown window. */
  retriggerCount: z.number(),
  value: z.string().nullable(),
  /** What went wrong, in the condition's words. Never overwritten. */
  detail: z.string().nullable(),
  /** Why it closed — recovered, rule removed, quietened by a mode. */
  resolvedReason: z.string().nullable(),
})
export type AlertEvent = z.infer<typeof alertEventSchema>

/** Live feed for the event-log widget: what is wrong now, and what just was. */
export const sysAlertsSchema = z.object({
  active: z.array(alertEventSchema),
  recent: z.array(alertEventSchema),
})
export type SysAlerts = z.infer<typeof sysAlertsSchema>

export const notificationSchema = z.object({
  id: z.number(),
  /** The alert this came from. Not a festival — see the glossary. */
  alertEventId: z.number().nullable(),
  instanceId: z.string().nullable(),
  severity: severitySchema,
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
})
export type Notification = z.infer<typeof notificationSchema>

export const inboxSchema = z.object({
  unread: z.number(),
  items: z.array(notificationSchema),
})
export type Inbox = z.infer<typeof inboxSchema>

export const notifyPrefsSchema = z.object({
  // The number lives on the user, not here: see `contactDetailsSchema`. It sat
  // beside these switches until it turned out three features wanted it.
  smsEnabled: z.boolean(),
  /** Below this, an alert stays in the app rather than waking someone up. */
  smsMinSeverity: severitySchema,
})
export type NotifyPrefs = z.infer<typeof notifyPrefsSchema>

/**
 * Why a text would not arrive.
 *
 * Ordered by who can fix it: the first two are the admin's to chase, the third
 * is the person's own setting, and the fourth is the rule being quieter than
 * their threshold — which is working as intended, not a fault.
 */
export const REACH_BLOCKERS = ['no-number', 'texts-off', 'below-threshold'] as const
export const reachBlockerSchema = z.enum(REACH_BLOCKERS)
export type ReachBlocker = z.infer<typeof reachBlockerSchema>

export const REACH_BLOCKER_LABEL: Record<ReachBlocker, string> = {
  'no-number': 'no number on file',
  'texts-off': 'texts switched off',
  'below-threshold': 'their threshold is higher',
}

export const reachMemberSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  /** Null when a text would reach them. */
  blockedBy: reachBlockerSchema.nullable(),
})
export type ReachMember = z.infer<typeof reachMemberSchema>

/**
 * Who a rule would actually text.
 *
 * Answered by the same code that decides it at three in the morning, not by a
 * second implementation of the same question — a rule that says "9 people" in
 * the editor and reaches four on the night is worse than saying nothing.
 */
export const reachSchema = z.object({
  members: z.array(reachMemberSchema),
  /** How many of them a text would get to. */
  textable: z.number(),
})
export type Reach = z.infer<typeof reachSchema>

/** What an admin may pick from when writing a rule. */
export const conditionCatalogueEntrySchema = z.object({
  conditionId: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  /** Null for the platform built-ins, which apply to every module type. */
  typeId: z.string().nullable(),
  typeLabel: z.string().nullable(),
  streamId: z.string().nullable(),
  defaultSeverity: severitySchema,
  paramsJsonSchema: z.unknown(),
  defaultParams: z.record(z.string(), z.unknown()),
})
export type ConditionCatalogueEntry = z.infer<typeof conditionCatalogueEntrySchema>
