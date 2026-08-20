import { describe, expect, it } from 'vitest'
import { jitter, parseFping } from './protocol.js'

describe('fping parsing', () => {
  it('reads per-probe times into min, average and max', () => {
    const result = parseFping('10.0.0.5 : 12.3 11.8 13.1 12.0', '10.0.0.5')

    expect(result).toMatchObject({
      method: 'icmp',
      up: true,
      rttMinMs: 11.8,
      rttMaxMs: 13.1,
      lossPct: 0,
      probes: 4,
    })
    expect(result?.rttAvgMs).toBeCloseTo(12.3, 1)
  })

  it('counts a dash as a lost probe', () => {
    // Intermittent loss is the thing that makes a control protocol feel
    // haunted, so it has to be visible rather than averaged away.
    const result = parseFping('10.0.0.5 : 12.0 - 14.0 -', '10.0.0.5')

    expect(result).toMatchObject({ up: true, lossPct: 50, probes: 4 })
    expect(result?.rttAvgMs).toBe(13)
  })

  it('reports a host that answered nothing as down', () => {
    const result = parseFping('10.0.0.5 : - - - -', '10.0.0.5')
    expect(result).toMatchObject({ up: false, lossPct: 100, rttAvgMs: null })
  })

  it('ignores lines for other hosts', () => {
    const output = '10.0.0.4 : 1.0 1.0\n10.0.0.5 : 20.0 20.0'
    expect(parseFping(output, '10.0.0.5')?.rttAvgMs).toBe(20)
  })

  it('returns null for output it does not recognise', () => {
    // A missing binary or an unexpected build should fall back to TCP, not
    // report a phantom outage.
    expect(parseFping('fping: command not found', '10.0.0.5')).toBeNull()
    expect(parseFping('', '10.0.0.5')).toBeNull()
  })
})

describe('jitter', () => {
  it('is the mean absolute change between consecutive probes', () => {
    expect(jitter([10, 12, 11, 13])).toBeCloseTo(1.67, 1)
  })

  it('is steady at zero for an even link', () => {
    expect(jitter([10, 10, 10])).toBe(0)
  })

  it('is unknown from a single probe', () => {
    expect(jitter([10])).toBeNull()
  })
})
