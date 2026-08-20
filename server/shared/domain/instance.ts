import { z } from 'zod'
import { RATE_CLASSES } from '../realtime/rates.js'

/**
 * Connection health of one module instance.
 *
 * `degraded` means connected but not fully healthy (e.g. a device answered but
 * reported an error, or only some of its streams are flowing) — the dashboard
 * shows amber rather than pretending everything is fine.
 * `error` is terminal until reconfigured: the config itself is wrong, so
 * retrying on a timer would just log the same failure forever.
 */
export const CONNECTOR_STATES = [
  'configuring',
  'connecting',
  'online',
  'degraded',
  'offline',
  'error',
  'stopped',
] as const
export type ConnectorState = (typeof CONNECTOR_STATES)[number]

export const connectorStateSchema = z.enum(CONNECTOR_STATES)

export const instanceStatusSchema = z.object({
  instanceId: z.string(),
  state: connectorStateSchema,
  detail: z.string().nullable(),
  since: z.number(),
  attempt: z.number(),
  lastError: z.string().nullable(),
  /**
   * How often this instance polls, in milliseconds, or null if it does not.
   *
   * The rhythm is the connector's own — sysmon every ten seconds, weather
   * every ten minutes, both configurable per instance — and only it knows.
   * Readers use it to decide when silence has gone on longer than expected;
   * without it, the first frame after a restart is followed by a fixed
   * per-class threshold that most polled connectors are slower than, and every
   * one of them is reported as broken until its second poll arrives.
   *
   * Recorded from the timers the connector registers rather than declared, so
   * it cannot drift from what the connector actually does.
   */
  pollIntervalMs: z.number().nullable().default(null),
})
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

/**
 * One readable value inside a stream's payload.
 *
 * Only scalars are declared. A stream whose payload is `{ channels: [...] }`
 * declares nothing, because there is no single value a widget could bind to —
 * those streams are read by widgets written for them.
 *
 * This exists because the alternative was guessing. A widget that shows one
 * value has to be told which one when it is added, and until now the Add
 * widget dialogue seeded a stream and left the field at whatever the widget
 * author had defaulted it to — `value` for the level meter, which exists on
 * the Demo Device and on nothing else. Point one at a Smaart rig and it opened
 * complaining that "value" is not in spl. Fields could not be read off the
 * live frame either: nothing has arrived at the moment the widget is created,
 * and a module that is offline never will.
 */
export const fieldDeclSchema = z.object({
  id: z.string(),
  kind: z.enum(['number', 'string', 'boolean']),
  /** Defaults to the id, which is usually readable enough. */
  label: z.string().nullable().default(null),
  unit: z.string().nullable().default(null),
})
export type FieldDecl = z.infer<typeof fieldDeclSchema>

/** What a connector type declares it can emit. */
export const streamDeclSchema = z.object({
  id: z.string(),
  label: z.string(),
  rateClass: z.enum(RATE_CLASSES),
  history: z.enum(['none', 'events', 'metric']).default('none'),
  /**
   * Declared in the order a reader would want them: the first number is the
   * headline reading, the first string is the one that says what the thing is
   * doing. Seeding relies on that order, so it is part of the contract rather
   * than a tidy-up anyone should re-sort.
   */
  fields: z.array(fieldDeclSchema).default([]),
})
export type StreamDecl = z.infer<typeof streamDeclSchema>

/** The first declared field of a kind — what a new widget should bind to. */
export function firstFieldOfKind(
  stream: StreamDecl,
  kind: FieldDecl['kind'],
): FieldDecl | undefined {
  return stream.fields.find((field) => field.kind === kind)
}

/** What a connector type declares it can be told to do. */
export const commandDeclSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable().default(null),
  dangerous: z.boolean().default(false),
  /** JSON Schema derived from the command's Zod input schema, for form rendering. */
  inputJsonSchema: z.unknown().nullable().default(null),
})
export type CommandDecl = z.infer<typeof commandDeclSchema>

/** One entry in the catalogue of connector types the server was built with. */
export const typeCatalogueEntrySchema = z.object({
  typeId: z.string(),
  displayName: z.string(),
  description: z.string(),
  /** JSON Schema of the instance config, used to render the admin form. */
  configJsonSchema: z.unknown(),
  streams: z.array(streamDeclSchema),
  commands: z.array(commandDeclSchema),
  capabilities: z.object({
    control: z.boolean(),
    discovery: z.boolean().default(false),
  }),
  /** Honest labelling for the UI: how solid is this integration? */
  tier: z.enum(['official', 'stable-unofficial', 'caveated', 'workaround']).default('official'),
  vendorNotes: z.string().nullable().default(null),
})
export type TypeCatalogueEntry = z.infer<typeof typeCatalogueEntrySchema>

export const instanceSchema = z.object({
  id: z.string(),
  typeId: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  allowControl: z.boolean(),
  simulate: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Instance = z.infer<typeof instanceSchema>

export const instanceNameSchema = z.string().trim().min(1).max(80)

/** Instance plus its live status, as served by the admin list endpoint. */
export const instanceWithStatusSchema = instanceSchema.extend({
  status: instanceStatusSchema.nullable(),
})
export type InstanceWithStatus = z.infer<typeof instanceWithStatusSchema>
