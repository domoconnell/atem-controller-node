import { z } from 'zod'
import { ROLES } from './roles.js'

export const roleSchema = z.enum(ROLES)

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, underscores or hyphens')

/**
 * Deliberately modest: this guards a dashboard on a closed show LAN, and crew
 * type it on a phone in the dark. Length over character-class gymnastics.
 */
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200)

export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  /** E.164, normalised on the way in. Null when nobody has given one. */
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: roleSchema,
  disabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type User = z.infer<typeof userSchema>

/** The subset attached to a live session and sent in the WS `hello` frame. */
export const sessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  /**
   * Their own contact details, so the account page needs no second request.
   *
   * This frame goes to one session — the person's own — so it carries no more
   * about them than they already know. It does not travel to anybody else.
   */
  phone: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  role: roleSchema,
})
export type SessionUser = z.infer<typeof sessionUserSchema>

export const sessionSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  username: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

/**
 * How to reach somebody.
 *
 * Kept on the person rather than beside their notification switches, which is
 * where the number used to live. A phone number is not a preference: it is
 * how the box reaches a human, and the same digits are wanted for a text at
 * 23:40, a password reset, and one day a second factor. A copy per feature is
 * a copy that goes stale in three places at once.
 */
export const contactDetailsSchema = z.object({
  /**
   * Typed however people say it — "07700 900123", "+44 7700 900123" — and
   * normalised server-side. Blank means "remove it".
   */
  phone: z.string().trim().max(32).nullable().optional(),
  /**
   * Blank means "remove it" here too — checked after trimming, not before.
   *
   * The first version was `.email().or(z.literal(''))`, and the union looked
   * at the raw string while `.email()` looked at the trimmed one. So selecting
   * the address and hitting space — the ordinary way to clear a field — was
   * rejected with "that does not look like an email address", which is both
   * wrong and unhelpful about what to do next.
   */
  email: z
    .string()
    .trim()
    .max(254)
    .refine((value) => value === '' || z.email().safeParse(value).success, {
      message: 'That does not look like an email address',
    })
    .nullable()
    .optional(),
})
export type ContactDetails = z.infer<typeof contactDetailsSchema>
