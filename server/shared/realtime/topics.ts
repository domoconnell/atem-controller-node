/**
 * Topic naming. Three shapes only — no wildcards:
 *   mi:<instanceId>:<streamId>   a stream from one configured module instance
 *   sys:<name>                   a platform-wide aggregate
 *   usr:<userId>:<channel>       something addressed to one person
 *
 * Keeping the sets closed means authorization is a lookup, never a pattern
 * match: every topic names exactly one resource whose owner can be checked.
 */

/** Reserved stream carrying a module instance's connection health. */
export const STATUS_STREAM = '$status'
/** Reserved stream carrying a module instance's active problems. */
export const HEALTH_STREAM = '$health'

export const SYS_STATUS = 'sys:status' // map of instanceId → status, for the status board
export const SYS_INSTANCES = 'sys:instances' // instance list/config changes, for live admin UI
export const SYS_HEALTH = 'sys:health' // map of instanceId → problem summary, for problem boards
export const SYS_ALERTS = 'sys:alerts' // active + recent alert events, for the event log
export const SYS_SCHEDULE = 'sys:schedule' // the running order, for countdowns and now/next
export const SYS_MODE = 'sys:mode' // config / prep / show, and what is armed next
export const SYS_EVENT = 'sys:event' // which event the box is running, and when it changed
// Where the show has actually got to. Its own topic rather than a field on
// sys:schedule because it changes on every Next — dozens of times on a busy
// evening — and the running order it would ride on is tens of kilobytes.
export const SYS_POSITION = 'sys:position'
// Which microphones are cued. Its own topic for the same reason as the
// position: a stage manager cues and clears dozens of times an evening, and
// this payload is a handful of entries where the running order is kilobytes.
export const SYS_MIC_CUES = 'sys:mic-cues'

/**
 * Adding a name here is not the whole job: `access/filters.ts` fails closed for
 * any system topic it has no case for, so a new entry without a matching filter
 * arrives at every non-admin client as null.
 */
export const SYSTEM_TOPICS = [
  SYS_STATUS,
  SYS_INSTANCES,
  SYS_HEALTH,
  SYS_ALERTS,
  SYS_SCHEDULE,
  SYS_MODE,
  SYS_EVENT,
  SYS_POSITION,
  SYS_MIC_CUES,
] as const
export type SystemTopic = (typeof SYSTEM_TOPICS)[number]

/** Closed set: a channel must be listed here to be addressable at all. */
export const USER_CHANNELS = ['inbox'] as const
export type UserChannel = (typeof USER_CHANNELS)[number]

export type ParsedTopic =
  | { kind: 'instance'; instanceId: string; streamId: string }
  | { kind: 'system'; name: string }
  | { kind: 'user'; userId: string; channel: UserChannel }

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]+$/
const STREAM_ID_RE = /^(\$status|\$health|[A-Za-z0-9_.-]+)$/

export function buildTopic(instanceId: string, streamId: string): string {
  return `mi:${instanceId}:${streamId}`
}

export function statusTopic(instanceId: string): string {
  return buildTopic(instanceId, STATUS_STREAM)
}

export function healthTopic(instanceId: string): string {
  return buildTopic(instanceId, HEALTH_STREAM)
}

export function userTopic(userId: string, channel: UserChannel): string {
  return `usr:${userId}:${channel}`
}

export function userInboxTopic(userId: string): string {
  return userTopic(userId, 'inbox')
}

/** Returns null for anything that isn't a well-formed topic — callers must reject those. */
export function parseTopic(topic: string): ParsedTopic | null {
  if (topic.startsWith('sys:')) {
    const name = topic.slice(4)
    return (SYSTEM_TOPICS as readonly string[]).includes(topic) ? { kind: 'system', name } : null
  }

  if (topic.startsWith('usr:')) {
    const rest = topic.slice(4)
    const sep = rest.indexOf(':')
    if (sep <= 0) return null

    const userId = rest.slice(0, sep)
    const channel = rest.slice(sep + 1)
    if (!INSTANCE_ID_RE.test(userId)) return null
    if (!(USER_CHANNELS as readonly string[]).includes(channel)) return null

    return { kind: 'user', userId, channel: channel as UserChannel }
  }

  if (!topic.startsWith('mi:')) return null

  const rest = topic.slice(3)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null

  const instanceId = rest.slice(0, sep)
  const streamId = rest.slice(sep + 1)
  if (!INSTANCE_ID_RE.test(instanceId)) return null
  if (!STREAM_ID_RE.test(streamId)) return null

  return { kind: 'instance', instanceId, streamId }
}

export function isValidTopic(topic: string): boolean {
  return parseTopic(topic) !== null
}

/** Every topic belonging to one instance, used when an instance is deleted. */
export function isTopicOfInstance(topic: string, instanceId: string): boolean {
  const parsed = parseTopic(topic)
  return parsed?.kind === 'instance' && parsed.instanceId === instanceId
}
