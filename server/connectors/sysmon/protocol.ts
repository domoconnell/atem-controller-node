/**
 * macOS system metrics, read over SSH.
 *
 * Every command here was chosen to work as a non-admin user, without a TTY,
 * on a current macOS, and to be cheap enough that a monitored show machine
 * does effectively no extra work. The parsing has two traps worth knowing
 * about, both handled below:
 *
 *   - `top -l 1` reports CPU since boot, not since a moment ago. Two samples
 *     are required and only the second is true.
 *   - `df /` shows the sealed system snapshot, which reads as a nearly-full
 *     16 GB volume on a half-empty 2 TB disk. The Data volume is the real one.
 */

export const SECTION = '@@@'

/**
 * One combined command per tick: one SSH channel, one round trip.
 *
 * Wrapped in `/bin/sh -c` because the login shell is often zsh, where an
 * unquoted separator containing `=` triggers filename expansion and the whole
 * thing dies with a baffling error.
 */
export const MAC_POLL_COMMAND = [
  '/bin/sh -c ',
  "'",
  'top -l 2 -n 0 -s 1 | grep -E "^(CPU|Load)"; ',
  `echo ${SECTION}; vm_stat; `,
  `echo ${SECTION}; sysctl -n hw.memsize; `,
  `echo ${SECTION}; df -kP /System/Volumes/Data; `,
  `echo ${SECTION}; sysctl -n kern.boottime; `,
  `echo ${SECTION}; memory_pressure -Q 2>/dev/null || true; `,
  `echo ${SECTION}; pmset -g batt`,
  "'",
].join('')

export const MAC_INFO_COMMAND = "/bin/sh -c 'sw_vers; echo @@@; hostname'"

export interface SysMetrics {
  cpuPct: number | null
  loadAvg1: number | null
  memUsedBytes: number | null
  memTotalBytes: number | null
  memUsedPct: number | null
  /** The kernel's own verdict, which beats any threshold we could invent. */
  memPressure: 'normal' | 'warn' | 'critical' | null
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  diskUsedPct: number | null
  uptimeSeconds: number | null
  batteryPct: number | null
  /** null on a desktop with no battery. */
  onBattery: boolean | null
  batteryState: string | null
}

export interface SysInfo {
  hostname: string | null
  osName: string | null
  osVersion: string | null
}

export function parseMacMetrics(output: string, now = Date.now()): SysMetrics {
  const [top = '', vmStat = '', memSize = '', df = '', boottime = '', pressure = '', battery = ''] =
    output.split(SECTION).map((section) => section.trim())

  const memTotalBytes = toNumber(memSize)
  const memUsedBytes = parseVmStat(vmStat)

  return {
    cpuPct: parseCpu(top),
    loadAvg1: parseLoad(top),
    memUsedBytes,
    memTotalBytes,
    memUsedPct:
      memUsedBytes !== null && memTotalBytes !== null && memTotalBytes > 0
        ? round((memUsedBytes / memTotalBytes) * 100)
        : null,
    memPressure: parsePressure(pressure),
    ...parseDf(df),
    uptimeSeconds: parseBootTime(boottime, now),
    ...parseBattery(battery),
  }
}

/**
 * CPU from the *last* `CPU usage:` line.
 *
 * The first sample of a `top -l 2` run covers everything since boot, which on
 * a machine that has been up for a week is a meaningless average.
 */
export function parseCpu(top: string): number | null {
  const lines = top.split('\n').filter((line) => line.startsWith('CPU usage:'))
  const last = lines.at(-1)
  if (!last) return null

  const idle = /([\d.]+)%\s+idle/.exec(last)
  if (!idle?.[1]) return null

  return round(100 - Number(idle[1]))
}

export function parseLoad(top: string): number | null {
  const line = top.split('\n').find((entry) => entry.startsWith('Load Avg:'))
  const match = line ? /Load Avg:\s*([\d.]+)/.exec(line) : null
  return match?.[1] ? Number(match[1]) : null
}

/**
 * Memory actually in use, the way Activity Monitor counts it.
 *
 * `top`'s own "used" figure includes the file cache, which on a healthy Mac
 * makes a 64 GB machine look permanently 90% full. Anonymous pages, wired
 * memory and the compressor — minus what is purgeable — is the honest number.
 * The page size comes from vm_stat's own header: it is 16 KB on Apple silicon
 * and 4 KB on Intel, and hardcoding either is a silent 4x error.
 */
export function parseVmStat(vmStat: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(vmStat)
  if (!pageSize?.[1]) return null
  const bytesPerPage = Number(pageSize[1])

  const pages = (label: string): number => {
    const match = new RegExp(`${label}:\\s+(\\d+)`).exec(vmStat)
    return match?.[1] ? Number(match[1]) : 0
  }

  const anonymous = pages('Anonymous pages')
  const purgeable = pages('Pages purgeable')
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor')
  if (anonymous === 0 && wired === 0) return null

  return Math.max(0, (anonymous - purgeable + wired + compressed) * bytesPerPage)
}

export function parsePressure(output: string): 'normal' | 'warn' | 'critical' | null {
  const match = /free percentage:\s*(\d+)/i.exec(output)
  if (!match?.[1]) return null

  const free = Number(match[1])
  // The kernel's own thresholds, expressed the way it reports them.
  if (free < 10) return 'critical'
  if (free < 25) return 'warn'
  return 'normal'
}

export function parseDf(df: string): {
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  diskUsedPct: number | null
} {
  const line = df.split('\n').at(-1)
  const columns = line?.trim().split(/\s+/) ?? []
  if (columns.length < 4) return { diskFreeBytes: null, diskTotalBytes: null, diskUsedPct: null }

  // df -kP: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const totalKb = Number(columns[1])
  const availableKb = Number(columns[3])
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) {
    return { diskFreeBytes: null, diskTotalBytes: null, diskUsedPct: null }
  }

  const total = totalKb * 1024
  const free = availableKb * 1024
  return {
    diskFreeBytes: free,
    diskTotalBytes: total,
    diskUsedPct: total > 0 ? round(((total - free) / total) * 100) : null,
  }
}

/** `{ sec = 1780488106, usec = 123 } Thu ...` — more robust than parsing `uptime`. */
export function parseBootTime(output: string, now: number): number | null {
  const match = /sec\s*=\s*(\d+)/.exec(output)
  if (!match?.[1]) return null
  const seconds = Math.floor(now / 1000) - Number(match[1])
  return seconds >= 0 ? seconds : null
}

export function parseBattery(output: string): {
  batteryPct: number | null
  onBattery: boolean | null
  batteryState: string | null
} {
  if (!output.trim()) return { batteryPct: null, onBattery: null, batteryState: null }

  const source = /Now drawing from '([^']+)'/.exec(output)?.[1] ?? null
  const battery = /(\d+)%;\s*([\w\s]+?);/.exec(output)

  // A desktop reports a power source but no battery line.
  if (!battery) {
    return {
      batteryPct: null,
      onBattery: source ? source !== 'AC Power' : null,
      batteryState: source,
    }
  }

  return {
    batteryPct: Number(battery[1]),
    onBattery: source !== 'AC Power',
    batteryState: battery[2]?.trim() ?? null,
  }
}

export function parseMacInfo(output: string): SysInfo {
  const [versions = '', hostname = ''] = output.split(SECTION).map((part) => part.trim())

  return {
    hostname: hostname.split('\n')[0]?.trim() || null,
    osName: /ProductName:\s*(.+)/.exec(versions)?.[1]?.trim() ?? null,
    osVersion: /ProductVersion:\s*(.+)/.exec(versions)?.[1]?.trim() ?? null,
  }
}

function toNumber(value: string): number | null {
  const trimmed = value.trim()
  // Number('') is 0, which would render as a real reading of zero rather than
  // an honest 'unknown'.
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
