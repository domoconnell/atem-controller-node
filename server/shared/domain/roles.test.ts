import { describe, expect, it } from 'vitest'
import { ACTIONS, can, hasRank, isRole, ROLES } from './roles.js'

describe('role matrix', () => {
  it('lets every role view dashboards — the whole point of a wall display', () => {
    for (const role of ROLES) expect(can(role, 'dashboard:view')).toBe(true)
  })

  it('keeps viewers read-only', () => {
    expect(can('viewer', 'command:execute')).toBe(false)
    expect(can('viewer', 'profile:write-own')).toBe(false)
    expect(can('viewer', 'instance:manage')).toBe(false)
    expect(can('viewer', 'user:manage')).toBe(false)
  })

  it('lets operators run commands and own their layouts, but not administer', () => {
    expect(can('operator', 'command:execute')).toBe(true)
    expect(can('operator', 'profile:write-own')).toBe(true)
    expect(can('operator', 'profile:write-shared')).toBe(false)
    expect(can('operator', 'instance:manage')).toBe(false)
    expect(can('operator', 'settings:manage')).toBe(false)
  })

  it('lets operators call the show without letting them rewrite it', () => {
    // The three operational permissions, and the two editing ones they are
    // deliberately separate from: calling doors, advancing the running order
    // and cueing a mic all happen every evening; changing what a mic or a
    // running order *is* does not.
    expect(can('operator', 'mode:set')).toBe(true)
    expect(can('operator', 'runningOrder:advance')).toBe(true)
    expect(can('operator', 'micCue:set')).toBe(true)
    expect(can('operator', 'schedule:manage')).toBe(false)
    expect(can('viewer', 'micCue:set')).toBe(false)
  })

  it('gives admins every action', () => {
    for (const action of ACTIONS) expect(can('admin', action)).toBe(true)
  })

  it('is strictly cumulative up the ranks', () => {
    // Anything an operator may do, an admin may do; same for viewer → operator.
    for (const action of ACTIONS) {
      if (can('viewer', action)) expect(can('operator', action)).toBe(true)
      if (can('operator', action)) expect(can('admin', action)).toBe(true)
    }
  })

  it('compares ranks', () => {
    expect(hasRank('admin', 'operator')).toBe(true)
    expect(hasRank('operator', 'operator')).toBe(true)
    expect(hasRank('viewer', 'operator')).toBe(false)
  })

  it('guards role parsing', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('superuser')).toBe(false)
    expect(isRole(null)).toBe(false)
  })
})
