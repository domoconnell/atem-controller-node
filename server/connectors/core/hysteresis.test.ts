import { describe, expect, it } from 'vitest'
import { CLEAR_MARGIN, overThreshold, underThreshold } from './hysteresis.js'

/**
 * A level sitting on its limit is the case this exists for.
 *
 * Front of house runs at the limit deliberately — that is the job — so an SPL
 * alarm at 102 dB spends the night being crossed. Without a margin the board
 * gains and loses a row every few seconds, and the row nobody can keep track
 * of is the row nobody reads.
 */
describe('overThreshold', () => {
  it('raises the moment the reading goes over', () => {
    // No delay on the way in: the first moment a level is over is the moment
    // somebody wants to know.
    expect(overThreshold(102.1, 102, false)).toBe(true)
    expect(overThreshold(102, 102, false)).toBe(false)
  })

  it('holds on until the reading comes back by a margin', () => {
    // 3% of 102 is about 3 dB, so 101 is still "over" once it is over.
    expect(overThreshold(101, 102, true)).toBe(true)
    expect(overThreshold(99.5, 102, true)).toBe(true)
    expect(overThreshold(98, 102, true)).toBe(false)
  })

  it('does not chatter across a reading that hovers', () => {
    // The demo meter used to do exactly this, once a cycle.
    const readings = [101.9, 102.1, 101.8, 102.2, 101.95, 102.05]
    let active = false
    let flips = 0
    for (const reading of readings) {
      const next = overThreshold(reading, 102, active)
      if (next !== active) flips++
      active = next
    }
    // One transition — up — rather than one per crossing.
    expect(flips).toBe(1)
    expect(active).toBe(true)
  })
})

describe('underThreshold', () => {
  it('raises the moment the reading drops below', () => {
    expect(underThreshold(19, 20, false)).toBe(true)
    expect(underThreshold(20, 20, false)).toBe(false)
  })

  it('holds on until the reading recovers by a margin', () => {
    expect(underThreshold(20.2, 20, true)).toBe(true)
    expect(underThreshold(21, 20, true)).toBe(false)
  })

  it('does not chatter either', () => {
    const readings = [20.1, 19.9, 20.05, 19.95, 20.02]
    let active = false
    let flips = 0
    for (const reading of readings) {
      const next = underThreshold(reading, 20, active)
      if (next !== active) flips++
      active = next
    }
    expect(flips).toBe(1)
  })
})

describe('the margin itself', () => {
  it('scales with the threshold rather than being one hand-picked number', () => {
    // 3% is 3 dB on a 102 dB alarm and 2.4 points on an 80% CPU limit — the
    // right order of magnitude for both, with one number to reason about.
    expect(overThreshold(102 - 102 * CLEAR_MARGIN * 0.9, 102, true)).toBe(true)
    expect(overThreshold(80 - 80 * CLEAR_MARGIN * 1.1, 80, true)).toBe(false)
  })

  it('copes with a threshold of zero without dividing by anything', () => {
    expect(overThreshold(0.1, 0, false)).toBe(true)
    expect(overThreshold(-0.1, 0, true)).toBe(false)
  })

  it('uses the size of a negative threshold, not its sign', () => {
    // Temperature under -5°C: the margin has to widen the band upward.
    expect(underThreshold(-4.9, -5, true)).toBe(true)
    expect(underThreshold(-4.9, -5, false)).toBe(false)
  })
})
