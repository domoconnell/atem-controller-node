import { z } from 'zod'
import { commandErrorSchema } from '../commands.js'
import { sessionUserSchema } from '../domain/user.js'

/**
 * The WebSocket wire protocol.
 *
 * Design notes that matter downstream:
 *  - Every frame carries `t`, so both ends parse with one discriminated union.
 *  - `snap` (snapshot) always precedes `data` for a topic. A client that
 *    reconnects re-subscribes and gets fresh snapshots, so no state is carried
 *    across a disconnect and no delta stream can desynchronise.
 *  - Payloads are whole values, never diffs. Streams here are small (a meter
 *    reading, a transport state) and merge bugs are expensive at 2am.
 */
export const PROTOCOL_VERSION = 1

/** Hard ceiling on one `sub` frame, so a buggy client can't ask for everything. */
export const MAX_TOPICS_PER_MESSAGE = 200

// ---------------------------------------------------------------- client → server

export const subMessageSchema = z.object({
  t: z.literal('sub'),
  topics: z.array(z.string()).min(1).max(MAX_TOPICS_PER_MESSAGE),
})

export const unsubMessageSchema = z.object({
  t: z.literal('unsub'),
  topics: z.array(z.string()).min(1).max(MAX_TOPICS_PER_MESSAGE),
})

export const cmdMessageSchema = z.object({
  t: z.literal('cmd'),
  /** Client-generated correlation id, echoed back on the `ack`. */
  id: z.string().min(1).max(64),
  instanceId: z.string().min(1),
  command: z.string().min(1),
  input: z.unknown().optional(),
})

export const pingMessageSchema = z.object({
  t: z.literal('ping'),
  ts: z.number(),
})

export const clientMessageSchema = z.discriminatedUnion('t', [
  subMessageSchema,
  unsubMessageSchema,
  cmdMessageSchema,
  pingMessageSchema,
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

// ---------------------------------------------------------------- server → client

export const helloMessageSchema = z.object({
  t: z.literal('hello'),
  protocolVersion: z.number(),
  /** Server clock, so clients can render countdowns without trusting their own. */
  serverTime: z.number(),
  user: sessionUserSchema,
})

export const snapMessageSchema = z.object({
  t: z.literal('snap'),
  topic: z.string(),
  seq: z.number(),
  /** null when the topic has never produced a value — widget shows "waiting". */
  ts: z.number().nullable(),
  data: z.unknown(),
})

export const dataMessageSchema = z.object({
  t: z.literal('data'),
  topic: z.string(),
  seq: z.number(),
  ts: z.number(),
  data: z.unknown(),
})

export const ackMessageSchema = z.object({
  t: z.literal('ack'),
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: commandErrorSchema.optional(),
})

export const errMessageSchema = z.object({
  t: z.literal('err'),
  code: z.string(),
  msg: z.string(),
  topic: z.string().optional(),
})

export const pongMessageSchema = z.object({
  t: z.literal('pong'),
  ts: z.number(),
  serverTime: z.number(),
})

export const byeMessageSchema = z.object({
  t: z.literal('bye'),
  reason: z.string(),
})

export const serverMessageSchema = z.discriminatedUnion('t', [
  helloMessageSchema,
  snapMessageSchema,
  dataMessageSchema,
  ackMessageSchema,
  errMessageSchema,
  pongMessageSchema,
  byeMessageSchema,
])
export type ServerMessage = z.infer<typeof serverMessageSchema>

export type SubMessage = z.infer<typeof subMessageSchema>
export type UnsubMessage = z.infer<typeof unsubMessageSchema>
export type CmdMessage = z.infer<typeof cmdMessageSchema>
export type HelloMessage = z.infer<typeof helloMessageSchema>
export type SnapMessage = z.infer<typeof snapMessageSchema>
export type DataMessage = z.infer<typeof dataMessageSchema>
export type AckMessage = z.infer<typeof ackMessageSchema>

/** WS close codes we originate. 1013 = "try again later" (slow consumer). */
export const WS_CLOSE = {
  UNAUTHORIZED: 4401,
  SLOW_CONSUMER: 1013,
  SERVER_SHUTDOWN: 1001,
  PROTOCOL_ERROR: 1002,
} as const

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = clientMessageSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = serverMessageSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
