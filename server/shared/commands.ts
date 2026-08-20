import { z } from 'zod'

/**
 * Command (push) envelopes. Commands are the only way this dashboard writes to
 * show equipment, so every one is explicitly declared by its connector, gated
 * per instance by an admin, and audited.
 */

export const COMMAND_ERROR_CODES = [
  'NOT_FOUND', // no such instance or command
  'NOT_ALLOWED', // role or per-instance allow_control says no
  'NOT_CONNECTED', // connector isn't online/degraded right now
  'INVALID_INPUT', // failed the command's Zod schema
  'TIMEOUT', // connector didn't answer in time
  'DEVICE_ERROR', // the device itself refused or errored
  'INTERNAL', // bug on our side
] as const
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

export const commandErrorSchema = z.object({
  code: z.enum(COMMAND_ERROR_CODES),
  message: z.string(),
})
export type CommandError = z.infer<typeof commandErrorSchema>

export const commandRequestSchema = z.object({
  instanceId: z.string(),
  command: z.string(),
  input: z.unknown().optional(),
})
export type CommandRequest = z.infer<typeof commandRequestSchema>

export const commandResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: commandErrorSchema }),
])
export type CommandResult = z.infer<typeof commandResultSchema>

export const commandOk = (data?: unknown): CommandResult => ({ ok: true, data })

export const commandFail = (code: CommandErrorCode, message: string): CommandResult => ({
  ok: false,
  error: { code, message },
})

/** How long a connector gets to answer before we give up on it. */
export const COMMAND_TIMEOUT_MS = 10_000
