import { describe, expect, it } from 'vitest'
import {
  parseBattery,
  parseBootTime,
  parseCpu,
  parseDf,
  parseMacInfo,
  parseMacMetrics,
  parsePressure,
  parseVmStat,
  SECTION,
} from './protocol.js'

describe('CPU parsing', () => {
  it('uses the second sample, not the since-boot first one', () => {
    // `top -l 1` reports an average since boot, which on a machine up for a
    // week is meaningless. Getting this wrong looks plausible and is wrong.
    const output = [
      'CPU usage: 40.00% user, 20.00% sys, 40.00% idle',
      'Load Avg: 2.15, 2.40, 2.60',
      'CPU usage: 8.00% user, 2.00% sys, 90.00% idle',
    ].join('\n')

    expect(parseCpu(output)).toBe(10)
  })

  it('returns null when top said nothing useful', () => {
    expect(parseCpu('')).toBeNull()
    expect(parseCpu('Load Avg: 1.0, 1.0, 1.0')).toBeNull()
  })
})

describe('memory parsing', () => {
  const vmStat = (pageSize: number) =>
    [
      `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
      'Anonymous pages:                        100000.',
      'Pages purgeable:                        10000.',
      'Pages wired down:                       50000.',
      'Pages occupied by compressor:           20000.',
    ].join('\n')

  it('reads the page size from the header rather than assuming', () => {
    // 16 KB on Apple silicon, 4 KB on Intel. Hardcoding either is a silent
    // fourfold error in the headline number.
    const appleSilicon = parseVmStat(vmStat(16_384))
    const intel = parseVmStat(vmStat(4_096))

    expect(appleSilicon).toBe((100_000 - 10_000 + 50_000 + 20_000) * 16_384)
    expect(intel).toBe((100_000 - 10_000 + 50_000 + 20_000) * 4_096)
  })

  it('excludes the file cache the way Activity Monitor does', () => {
    // Counting cached pages as "used" makes every healthy Mac look full.
    const used = parseVmStat(vmStat(16_384)) ?? 0
    const total = 68_719_476_736
    expect(used / total).toBeLessThan(0.5)
  })

  it('returns null for output that is not vm_stat', () => {
    expect(parseVmStat('command not found')).toBeNull()
  })

  it('maps the kernel pressure figure onto levels', () => {
    expect(parsePressure('System-wide memory free percentage: 60%')).toBe('normal')
    expect(parsePressure('System-wide memory free percentage: 20%')).toBe('warn')
    expect(parsePressure('System-wide memory free percentage: 5%')).toBe('critical')
    expect(parsePressure('')).toBeNull()
  })
})

describe('disk parsing', () => {
  it('reads the data volume figures', () => {
    const df = [
      'Filesystem 1024-blocks      Used Available Capacity Mounted on',
      '/dev/disk3s5 1953595632 200000000 1700000000      11% /System/Volumes/Data',
    ].join('\n')

    const result = parseDf(df)
    expect(result.diskTotalBytes).toBe(1_953_595_632 * 1024)
    expect(result.diskFreeBytes).toBe(1_700_000_000 * 1024)
    expect(result.diskUsedPct).toBeCloseTo(13, 0)
  })

  it('survives unexpected output', () => {
    expect(parseDf('nonsense').diskFreeBytes).toBeNull()
  })
})

describe('uptime parsing', () => {
  it('derives uptime from kern.boottime', () => {
    const now = 1_800_000_000_000
    const bootSeconds = Math.floor(now / 1000) - 3_600
    expect(parseBootTime(`{ sec = ${bootSeconds}, usec = 0 } Thu Aug`, now)).toBe(3_600)
  })

  it('returns null rather than a negative uptime from a skewed clock', () => {
    const now = 1_800_000_000_000
    expect(parseBootTime(`{ sec = ${Math.floor(now / 1000) + 500}, usec = 0 }`, now)).toBeNull()
  })
})

describe('battery parsing', () => {
  it('reads charge and power source on a laptop', () => {
    const output = [
      "Now drawing from 'Battery Power'",
      ' -InternalBattery-0 (id=1234)\t42%; discharging; 2:15 remaining present: true',
    ].join('\n')

    expect(parseBattery(output)).toEqual({
      batteryPct: 42,
      onBattery: true,
      batteryState: 'discharging',
    })
  })

  it('knows a machine on mains is not on battery', () => {
    const output = [
      "Now drawing from 'AC Power'",
      ' -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true',
    ].join('\n')

    expect(parseBattery(output)).toMatchObject({ batteryPct: 100, onBattery: false })
  })

  it('handles a desktop with no battery', () => {
    expect(parseBattery("Now drawing from 'AC Power'")).toMatchObject({
      batteryPct: null,
      onBattery: false,
    })
  })
})

describe('whole-tick parsing', () => {
  it('assembles every section into one reading', () => {
    const output = [
      'CPU usage: 5.00% user, 3.00% sys, 92.00% idle\nLoad Avg: 1.20, 1.30, 1.40',
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 100000.\nPages purgeable: 0.\nPages wired down: 50000.\nPages occupied by compressor: 0.',
      '68719476736',
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1953595632 200000000 1700000000 11% /System/Volumes/Data',
      `{ sec = ${Math.floor(Date.now() / 1000) - 7_200}, usec = 0 }`,
      'System-wide memory free percentage: 55%',
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t88%; charged; 0:00 remaining present: true",
    ].join(`\n${SECTION}\n`)

    const metrics = parseMacMetrics(output)

    expect(metrics.cpuPct).toBe(8)
    expect(metrics.loadAvg1).toBe(1.2)
    expect(metrics.memPressure).toBe('normal')
    expect(metrics.uptimeSeconds).toBeGreaterThanOrEqual(7_199)
    expect(metrics.batteryPct).toBe(88)
    expect(metrics.onBattery).toBe(false)
    expect(metrics.memUsedPct).toBeGreaterThan(0)
  })

  it('returns nulls rather than throwing on unrecognisable output', () => {
    const metrics = parseMacMetrics('some other machine entirely')
    expect(metrics.cpuPct).toBeNull()
    expect(metrics.memTotalBytes).toBeNull()
  })
})

describe('machine info', () => {
  it('reads the OS and hostname', () => {
    const output = `ProductName:\tmacOS\nProductVersion:\t26.4.1\n${SECTION}\nfoh-mac`
    expect(parseMacInfo(output)).toEqual({
      hostname: 'foh-mac',
      osName: 'macOS',
      osVersion: '26.4.1',
    })
  })
})
