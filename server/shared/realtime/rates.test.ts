import { describe, expect, it } from 'vitest'
import {
  expectedGapMs,
  GAP_SAMPLES,
  isRateClass,
  isStale,
  MIN_PUBLISH_INTERVAL_MS,
  OFFLINE_GRACE_MS,
  offlineLongEnough,
  RATE_CLASSES,
  STALENESS_MS,
  staleAfterMs,
  trackGap,
} from './rates.js'

describe('rate classes', () => {
  it('defines an interval and a staleness rule for every class', () => {
    for (const rc of RATE_CLASSES) {
      expect(MIN_PUBLISH_INTERVAL_MS[rc]).toBeGreaterThan(0)
      expect(rc in STALENESS_MS).toBe(true)
    }
  })

  it('guards against unknown values', () => {
    expect(isRateClass('fast')).toBe(true)
    expect(isRateClass('turbo')).toBe(false)
    expect(isRateClass(undefined)).toBe(false)
  })

  it('staleness thresholds are never tighter than the publish interval', () => {
    // Otherwise a perfectly healthy stream would flicker as stale between frames.
    for (const rc of RATE_CLASSES) {
      const threshold = STALENESS_MS[rc]
      if (threshold !== null) expect(threshold).toBeGreaterThan(MIN_PUBLISH_INTERVAL_MS[rc])
    }
  })
})

describe('isStale', () => {
  it('treats a never-published topic as stale', () => {
    expect(isStale('fast', null, 1_000)).toBe(true)
  })

  it('goes stale once past the class threshold', () => {
    expect(isStale('fast', 10_000, 12_000)).toBe(false)
    expect(isStale('fast', 10_000, 13_500)).toBe(true)
    expect(isStale('normal', 10_000, 14_000)).toBe(false)
    expect(isStale('normal', 10_000, 16_000)).toBe(true)
  })

  it('never ages out change-driven topics on silence alone', () => {
    // A HyperDeck sitting in "stopped" for an hour is reporting correctly,
    // not failing — its freshness comes from the instance status instead.
    expect(isStale('change', 0, 3_600_000)).toBe(false)
  })

  it('still reports a change topic as stale when it has no value at all', () => {
    expect(isStale('change', null, 0)).toBe(true)
  })
})

describe('what counts as late', () => {
  it('lets a stream be as slow as it has shown itself to be', () => {
    /*
     * The bug this exists for. Most polled connectors declared a rate class
     * whose fixed threshold is shorter than their own poll interval, so they
     * were stale between their own polls: sysmon every 10s against 5s, weather
     * every 600s against 15s. Both raised a problem for ever.
     */
    const sysmon = trackGap(trackGap([], 10_000), 10_000)
    expect(isStale('normal', 0, 10_500, expectedGapMs(sysmon))).toBe(false)
    expect(isStale('normal', 0, 26_000, expectedGapMs(sysmon))).toBe(true)

    const weather = trackGap([], 600_000)
    expect(isStale('slow', 0, 610_000, expectedGapMs(weather))).toBe(false)
  })

  it('keeps the rate class as a floor, never a ceiling', () => {
    // A 200ms probe stays fresh for the class's five seconds rather than half
    // a second, so a quick stream is not held to an absurd standard.
    expect(staleAfterMs('normal', 200)).toBe(STALENESS_MS.normal)
    expect(staleAfterMs('normal', 10_000)).toBe(25_000)
  })

  it('falls back to the class while a rhythm is unknown', () => {
    // One frame says nothing about intent, and guessing would be worse.
    expect(expectedGapMs([])).toBeNull()
    expect(staleAfterMs('fast', null)).toBe(STALENESS_MS.fast)
  })

  it('still never ages out a change-driven stream', () => {
    // A transport that has not moved publishes nothing, and saying that has
    // stopped would be a lie.
    expect(staleAfterMs('change', 10_000)).toBeNull()
    expect(isStale('change', 0, 10_000_000, 10_000)).toBe(false)
  })

  it('follows a cadence up and down, keeping only the recent gaps', () => {
    let history = trackGap(trackGap(trackGap([], 1_000), 1_000), 1_000)
    expect(expectedGapMs(history)).toBe(1_000)

    for (const gap of [30_000, 30_000, 30_000]) history = trackGap(history, gap)
    expect(history).toHaveLength(GAP_SAMPLES)
    expect(expectedGapMs(history)).toBe(30_000)
  })

  it('ignores a gap of nothing, so two frames on one timestamp teach nothing', () => {
    expect(trackGap([5_000], 0)).toEqual([5_000])
    expect(trackGap([5_000], -1)).toEqual([5_000])
  })
})

describe('offlineLongEnough', () => {
  it('waits before calling a blip an outage', () => {
    // Reconnection starts at a one-second backoff, so a dropped packet is
    // usually over before anybody could read the warning.
    expect(offlineLongEnough(1_000, 3_000)).toBe(false)
    expect(offlineLongEnough(1_000, 1_000 + OFFLINE_GRACE_MS)).toBe(true)
  })

  it('says so immediately for something that was already down', () => {
    // A screen that has just loaded and finds a module offline for an hour
    // has no reason to wait another eight seconds.
    expect(offlineLongEnough(0, 3_600_000)).toBe(true)
  })

  it('treats an unknown start as long enough, rather than hiding it', () => {
    expect(offlineLongEnough(null, 1_000)).toBe(true)
  })
})
