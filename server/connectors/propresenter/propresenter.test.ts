import { describe, expect, it } from 'vitest'
import {
  formatTimecode,
  parseSlide,
  parseStageMessage,
  parseSystemTime,
  parseTimecode,
  parseTimers,
} from './protocol.js'

describe('parseTimecode', () => {
  it('reads HH:MM:SS', () => {
    expect(parseTimecode('00:04:32')).toBe(272)
    expect(parseTimecode('01:02:03')).toBe(3723)
  })

  it('reads MM:SS, which older builds send', () => {
    expect(parseTimecode('04:32')).toBe(272)
  })

  it('reads an overrunning countdown as negative seconds', () => {
    // Past zero ProPresenter keeps counting and prefixes a minus; the stage
    // display turns red on the sign, so it has to survive the parse.
    expect(parseTimecode('-00:00:07')).toBe(-7)
    expect(parseTimecode('-00:01:30')).toBe(-90)
  })

  it('never returns -0, which would compare unequal to 0', () => {
    expect(Object.is(parseTimecode('-00:00:00'), 0)).toBe(true)
  })

  it('keeps sub-second precision when a build sends it', () => {
    expect(parseTimecode('00:00:01.5')).toBe(1.5)
  })

  it('returns null for anything it cannot read', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('soon')).toBeNull()
    expect(parseTimecode('12')).toBeNull()
    expect(parseTimecode('1:2:3:4')).toBeNull()
    expect(parseTimecode('00:0a:32')).toBeNull()
    expect(parseTimecode(272)).toBeNull()
    expect(parseTimecode(null)).toBeNull()
  })
})

describe('formatTimecode', () => {
  it('round-trips through parseTimecode', () => {
    for (const seconds of [0, 7, 272, 3723, -7, -3723]) {
      expect(parseTimecode(formatTimecode(seconds))).toBe(seconds)
    }
  })

  it('zero-pads every field', () => {
    expect(formatTimecode(9)).toBe('00:00:09')
    expect(formatTimecode(-9)).toBe('-00:00:09')
  })
})

describe('parseTimers', () => {
  it('flattens the nested id object the API returns', () => {
    const timers = parseTimers([
      { id: { uuid: 'u1', name: 'Main Set', index: 0 }, time: '00:04:32', state: 'running' },
    ])
    expect(timers).toEqual([{ uuid: 'u1', name: 'Main Set', seconds: 272, state: 'running' }])
  })

  it('skips a timer whose clock it cannot read', () => {
    // A blank slot on the wall is recoverable; a wrong countdown is not.
    const timers = parseTimers([
      { id: { uuid: 'u1' }, time: 'nonsense', state: 'running' },
      { id: { uuid: 'u2', name: 'Encore' }, time: '00:00:30', state: 'stopped' },
    ])
    expect(timers.map((t) => t.uuid)).toEqual(['u2'])
  })

  it('skips a timer with no uuid, since no command could ever address it', () => {
    expect(parseTimers([{ id: {}, time: '00:00:30' }])).toEqual([])
  })

  it('falls back to the uuid when the timer has no name', () => {
    expect(parseTimers([{ id: { uuid: 'u1' }, time: '00:00:05' }])[0]?.name).toBe('u1')
  })

  it('defaults an unreported state to stopped', () => {
    expect(parseTimers([{ id: { uuid: 'u1' }, time: '00:00:05' }])[0]?.state).toBe('stopped')
  })

  it('returns an empty list rather than throwing on a non-array body', () => {
    expect(parseTimers({ error: 'nope' })).toEqual([])
    expect(parseTimers(null)).toEqual([])
  })
})

describe('parseSystemTime', () => {
  it('reads the time field', () => {
    expect(parseSystemTime({ time: '14:32:05' })).toBe('14:32:05')
  })

  it('returns null when the field is missing or empty', () => {
    expect(parseSystemTime({})).toBeNull()
    expect(parseSystemTime({ time: '' })).toBeNull()
    expect(parseSystemTime(null)).toBeNull()
  })
})

describe('parseSlide', () => {
  it('takes the text of the current and next slides', () => {
    expect(
      parseSlide({
        current: { uuid: 'a', text: 'Welcome', notes: 'wave' },
        next: { uuid: 'b', text: 'House rules', notes: '' },
      }),
    ).toEqual({ current: 'Welcome', next: 'House rules' })
  })

  it('reports nulls at the end of a playlist', () => {
    expect(parseSlide({ current: { uuid: 'a', text: 'Last' }, next: null })).toEqual({
      current: 'Last',
      next: null,
    })
  })

  it('keeps a deliberately blank slide distinct from no slide', () => {
    expect(parseSlide({ current: { text: '' } }).current).toBe('')
  })

  it('survives a body of the wrong shape entirely', () => {
    expect(parseSlide('nope')).toEqual({ current: null, next: null })
  })
})

describe('parseStageMessage', () => {
  it('reads the bare JSON string the endpoint returns', () => {
    expect(parseStageMessage('Wrap up — 5 minutes')).toBe('Wrap up — 5 minutes')
  })

  it('treats an absent message as empty', () => {
    expect(parseStageMessage(null)).toBe('')
    expect(parseStageMessage(undefined)).toBe('')
  })

  it('also accepts the object form some builds send', () => {
    expect(parseStageMessage({ message: 'Curfew in 10' })).toBe('Curfew in 10')
  })
})
