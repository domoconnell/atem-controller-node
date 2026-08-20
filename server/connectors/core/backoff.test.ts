import { describe, expect, it } from 'vitest'
import { Backoff } from './backoff.js'

describe('Backoff', () => {
  it('grows exponentially up to the cap', () => {
    // random() = 1 makes the jittered value equal its ceiling, so the growth
    // curve itself is what's under test; crash-loop damping is disabled here
    // and covered separately.
    const backoff = new Backoff({
      baseMs: 1_000,
      capMs: 60_000,
      crashLoopThreshold: Number.POSITIVE_INFINITY,
      random: () => 1,
    })
    const delays = Array.from({ length: 8 }, () => backoff.nextDelay(0))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  })

  it('spreads retries across the whole window', () => {
    // Thirty devices dropping together must not all reconnect in the same
    // instant; full jitter means any point in [0, ceiling) is possible.
    const low = new Backoff({ baseMs: 1_000, random: () => 0 })
    const high = new Backoff({ baseMs: 1_000, random: () => 0.999 })
    low.nextDelay(0)
    high.nextDelay(0)
    expect(low.nextDelay(0)).toBe(0)
    expect(high.nextDelay(0)).toBe(1_998)
  })

  it('widens the cap for a flapping connector but never gives up', () => {
    const backoff = new Backoff({
      baseMs: 1_000,
      capMs: 60_000,
      crashLoopCapMs: 300_000,
      crashLoopThreshold: 3,
      crashLoopWindowMs: 60_000,
      random: () => 1,
    })

    let delay = 0
    for (let i = 0; i < 10; i++) delay = backoff.nextDelay(i * 100)

    expect(delay).toBe(300_000)
    expect(delay).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('forgets old failures outside the flap window', () => {
    const backoff = new Backoff({
      baseMs: 1_000,
      capMs: 5_000,
      crashLoopCapMs: 300_000,
      crashLoopThreshold: 2,
      crashLoopWindowMs: 1_000,
      random: () => 1,
    })

    backoff.nextDelay(0)
    backoff.nextDelay(100)
    backoff.nextDelay(200)
    // Hours later, a single failure is not a crash loop.
    expect(backoff.nextDelay(3_600_000)).toBe(5_000)
  })

  it('resets only after the connection has proven stable', () => {
    const backoff = new Backoff({ baseMs: 1_000, stableAfterMs: 60_000, random: () => 1 })
    backoff.nextDelay(0)
    backoff.nextDelay(0)
    expect(backoff.attempts).toBe(2)

    // Up for 5 seconds then gone again — that's still flapping.
    backoff.onConnected(5_000, 0)
    expect(backoff.attempts).toBe(2)

    backoff.onConnected(120_000, 0)
    expect(backoff.attempts).toBe(0)
  })

  it('does not reset when it was never connected', () => {
    const backoff = new Backoff({ random: () => 1 })
    backoff.nextDelay(0)
    backoff.onConnected(999_999, null)
    expect(backoff.attempts).toBe(1)
  })
})
