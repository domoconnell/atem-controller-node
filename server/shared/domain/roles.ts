/**
 * Authorisation matrix. Defined once here so the server's route guards and the
 * web UI's affordances can never disagree about who may do what.
 */
export const ROLES = ['viewer', 'operator', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export const ACTIONS = [
  'dashboard:view', // read dashboards, subscribe to topics
  'profile:read', // read own + shared profiles
  'profile:write-own', // create/edit/delete own profiles
  'profile:write-shared', // create/edit shared and default profiles
  'command:execute', // run a command on an instance that allows control
  'instance:manage', // create/edit/delete module instances
  'user:manage', // create/edit/delete users, revoke sessions
  'settings:manage', // global settings, retention, backups
  'history:read', // event log + metric export
  'alert:manage', // create/edit alert rules and their notification routing
  'schedule:manage', // edit the running order
  'runningOrder:advance', // mark where the show has got to
  'micCue:set', // flag a microphone as about to go on, or on
  'mode:set', // switch the platform between config, prep and show
  'event:manage', // create, duplicate, back up and delete events
] as const
export type Action = (typeof ACTIONS)[number]

const VIEWER: Action[] = ['dashboard:view', 'profile:read', 'history:read']
// `mode:set` is operational, not administrative: calling doors at 18:45
// must not require finding an admin. Configuring what each mode *does*
// stays under `settings:manage`.
//
// `runningOrder:advance` is here for exactly the same reason and is worth
// separating from `schedule:manage`: pressing Next is the show caller's job all
// evening, and *editing* the running order mid-show is the thing you would want
// them not to do by accident. An operator cannot reach the admin area at all,
// which is why the controls live on the board rather than on a page.
//
// `micCue:set` completes that set. Cueing a microphone is the stage manager's
// job and clearing one is FOH's, and neither should need an admin; *defining*
// the microphones stays under `schedule:manage` with the rest of the roster.
const OPERATOR: Action[] = [
  ...VIEWER,
  'profile:write-own',
  'command:execute',
  'mode:set',
  'runningOrder:advance',
  'micCue:set',
]
const ADMIN: Action[] = [
  ...OPERATOR,
  'profile:write-shared',
  'instance:manage',
  'user:manage',
  'settings:manage',
  'alert:manage',
  'schedule:manage',
  'event:manage',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set(VIEWER),
  operator: new Set(OPERATOR),
  admin: new Set(ADMIN),
}

export function can(role: Role, action: Action): boolean {
  return ROLE_PERMISSIONS[role].has(action)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** True when `role` is at least as privileged as `minimum`. */
export function hasRank(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}
