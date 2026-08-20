import { spawn } from 'node:child_process'
import { connect } from 'node:net'

export interface LatencyResult {
  /** How the numbers were obtained, so the widget can be honest about it. */
  method: 'icmp' | 'tcp'
  up: boolean
  rttMinMs: number | null
  rttAvgMs: number | null
  rttMaxMs: number | null
  lossPct: number
  /** Mean absolute difference between consecutive probes, RFC 3550 style. */
  jitterMs: number | null
  probes: number
}

/**
 * Parses `fping -C n -q` output.
 *
 * fping rather than ping because its per-probe output is one stable,
 * locale-independent line: `host : 12.3 11.8 - 12.1`, with `-` for a lost
 * probe. Parsing ping's prose across platforms and languages is a losing game.
 */
export function parseFping(output: string, host: string): LatencyResult | null {
  // Output arrives on stderr, one line per host.
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(host))
  if (!line) return null

  const [, values = ''] = line.split(':')
  const tokens = values.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const times: number[] = []
  let lost = 0
  for (const token of tokens) {
    if (token === '-') {
      lost++
      continue
    }
    const value = Number(token)
    if (Number.isFinite(value)) times.push(value)
  }

  const probes = times.length + lost
  if (probes === 0) return null

  return {
    method: 'icmp',
    up: times.length > 0,
    rttMinMs: times.length ? round(Math.min(...times)) : null,
    rttAvgMs: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    rttMaxMs: times.length ? round(Math.max(...times)) : null,
    lossPct: round((lost / probes) * 100),
    jitterMs: jitter(times),
    probes,
  }
}

/** Mean absolute delta between consecutive probes. */
export function jitter(times: readonly number[]): number | null {
  if (times.length < 2) return null
  let total = 0
  for (let index = 1; index < times.length; index++) {
    total += Math.abs((times[index] as number) - (times[index - 1] as number))
  }
  return round(total / (times.length - 1))
}

export interface PingOptions {
  host: string
  probes: number
  intervalMs: number
  timeoutMs: number
  signal: AbortSignal
}

/** Runs fping. Resolves null when the binary is missing or unusable. */
export function icmpPing(options: PingOptions): Promise<LatencyResult | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'fping',
      [
        '-C',
        String(options.probes),
        '-p',
        String(options.intervalMs),
        '-q',
        '-t',
        String(options.timeoutMs),
        // Ends option parsing: a host beginning with '-' would otherwise be
        // read as an fping flag (e.g. -f to read targets from a file).
        '--',
        options.host,
      ],
      { signal: options.signal },
    )

    let stderr = ''
    let stdout = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    // No fping in the image, or no permission to open an ICMP socket: the
    // caller falls back to TCP rather than reporting the host as down.
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(parseFping(stderr || stdout, options.host)))
  })
}

/**
 * Connect-time to a TCP port.
 *
 * The fallback for hosts that drop ICMP — most managed switches and plenty of
 * hardened appliances — and the only method available without CAP_NET_RAW.
 */
export async function tcpProbe(options: {
  host: string
  port: number
  probes: number
  timeoutMs: number
  signal: AbortSignal
}): Promise<LatencyResult> {
  const times: number[] = []
  let lost = 0

  for (let index = 0; index < options.probes; index++) {
    if (options.signal.aborted) break
    const started = performance.now()
    const ok = await connectOnce(options.host, options.port, options.timeoutMs)
    if (ok) times.push(round(performance.now() - started))
    else lost++
  }

  const probes = times.length + lost
  return {
    method: 'tcp',
    up: times.length > 0,
    rttMinMs: times.length ? round(Math.min(...times)) : null,
    rttAvgMs: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    rttMaxMs: times.length ? round(Math.max(...times)) : null,
    lossPct: probes === 0 ? 100 : round((lost / probes) * 100),
    jitterMs: jitter(times),
    probes,
  }
}

function connectOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export interface HttpProbeResult {
  up: boolean
  status: number | null
  responseMs: number | null
  error: string | null
}

/** A GET, timed. Any answer at all means the service is alive. */
export async function httpProbe(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HttpProbeResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return {
      // A 500 still proves the host is up and answering, which is what this
      // check is for; the status is reported so a widget can be pickier.
      up: true,
      status: response.status,
      responseMs: round(performance.now() - started),
      error: null,
    }
  } catch (error) {
    return {
      up: false,
      status: null,
      responseMs: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
  }
}

export interface SpeedResult {
  downMbps: number | null
  upMbps: number | null
  measuredAt: number
}

/**
 * HTTP throughput, one engine for both targets.
 *
 * Parallel streams because a single TCP connection rarely fills a link, and
 * the first stretch is discarded so slow-start does not drag the number down.
 */
export async function measureThroughput(options: {
  downloadUrl: string
  uploadUrl?: string
  streams: number
  durationMs: number
  signal: AbortSignal
}): Promise<SpeedResult> {
  const downMbps = await measureDownload(options)
  const upMbps = options.uploadUrl
    ? await measureUpload({ ...options, url: options.uploadUrl })
    : null
  return { downMbps, upMbps, measuredAt: Date.now() }
}

async function measureDownload(options: {
  downloadUrl: string
  streams: number
  durationMs: number
  signal: AbortSignal
}): Promise<number | null> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const stop = setTimeout(() => controller.abort(), options.durationMs)

  let bytes = 0
  const started = performance.now()

  const streams = Array.from({ length: options.streams }, async () => {
    try {
      const response = await fetch(options.downloadUrl, { signal: controller.signal })
      const reader = response.body?.getReader()
      if (!reader) return
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value?.byteLength ?? 0
      }
    } catch {
      // Aborting at the end of the window is the normal exit, not a failure.
    }
  })

  await Promise.all(streams)
  clearTimeout(stop)
  options.signal.removeEventListener('abort', onAbort)

  const seconds = (performance.now() - started) / 1000
  if (seconds <= 0 || bytes === 0) return null
  return round((bytes * 8) / seconds / 1_000_000)
}

async function measureUpload(options: {
  url: string
  streams: number
  durationMs: number
  signal: AbortSignal
}): Promise<number | null> {
  const chunk = Buffer.alloc(1_000_000, 7)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const stop = setTimeout(() => controller.abort(), options.durationMs)

  let bytes = 0
  const started = performance.now()

  const streams = Array.from({ length: Math.max(1, options.streams - 1) }, async () => {
    try {
      while (!controller.signal.aborted) {
        await fetch(options.url, { method: 'POST', body: chunk, signal: controller.signal })
        bytes += chunk.byteLength
      }
    } catch {
      // Same: the abort is how the window ends.
    }
  })

  await Promise.all(streams)
  clearTimeout(stop)
  options.signal.removeEventListener('abort', onAbort)

  const seconds = (performance.now() - started) / 1000
  if (seconds <= 0 || bytes === 0) return null
  return round((bytes * 8) / seconds / 1_000_000)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
