import { z } from 'zod'

/**
 * A credential for a thing rather than a person.
 *
 * A Streamdeck at side of stage sends HTTP and cannot hold a cookie, sign in,
 * or be a user. It needs a secret it can carry in a header, and that secret
 * must be able to do far less than a person can — a token taped inside a
 * flight case should not be able to delete the running order.
 *
 * **This is not a session and must never become one.** It resolves to a set of
 * scopes, never to a `SessionUser`: the moment a token can answer "who am I"
 * with a person, every route that trusts `request.user` starts trusting a
 * lanyard. The audit rows a device writes say the device's label, which is the
 * honest answer to who pressed the key.
 *
 * **It is only as private as the network.** The show LAN is plain HTTP, so
 * anybody already on it can read this token off the wire and replay it. That
 * is tolerable only because of the scope list below: everything it grants is
 * something the same person could already do from any tablet on the same LAN.
 * Adding a scope means re-making that argument, not just adding a string.
 */
export const DEVICE_SCOPES = ['micCue'] as const
export type DeviceScope = (typeof DEVICE_SCOPES)[number]

/** What each scope lets a device do, for the admin page to render honestly. */
export const DEVICE_SCOPE_LABELS: Record<DeviceScope, string> = {
  micCue: 'Cue and clear microphones',
}

/**
 * What the admin page may see. Note the absence: the token itself.
 *
 * It is shown once, at the moment it is issued, and never again — the server
 * keeps only a hash, so there is nothing to show later even if the page asked.
 */
export const deviceTokenSummarySchema = z.object({
  label: z.string(),
  scopes: z.array(z.enum(DEVICE_SCOPES)),
  createdAt: z.number(),
  createdByName: z.string().nullable(),
  /** Throttled, so this is "seen within the last few minutes", not exact. */
  lastUsedAt: z.number().nullable(),
})
export type DeviceTokenSummary = z.infer<typeof deviceTokenSummarySchema>

export const issueDeviceTokenSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe('Which box this is, so a revoke later is not a guess — "Stage left deck".'),
})
export type IssueDeviceToken = z.infer<typeof issueDeviceTokenSchema>
