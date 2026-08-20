import { z } from 'zod'

/**
 * Groups are how an admin says "the audio group", "video", "FOH audio".
 * Roles remain the capability ceiling (what a user may do); groups scope
 * which module instances those capabilities apply to. A user belongs to any
 * number of groups.
 */
export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number(),
  instanceCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Group = z.infer<typeof groupSchema>

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Group name is required')
  .max(60, 'Keep group names short')
