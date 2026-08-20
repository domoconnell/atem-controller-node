export interface BackoffOptions {
  baseMs?: number
  capMs?: number
  /** Cap applied once a connector is clearly flapping. */
  crashLoopCapMs?: number
  /** More than this many restarts inside `crashLoopWindowMs` counts as flapping. */
  crashLoopThreshold?: number
  crashLoopWindowMs?: number
  /** Time online before the attempt counter resets. */
  stableAfterMs?: number
  random?: () => number
}

const DEFAULTS = {
  baseMs: 1_000,
  capMs: 60_000,
  crashLoopCapMs: 300_000,
  crashLoopThreshold: 5,
  crashLoopWindowMs: 60_000,
  stableAfterMs: 60_000,
  random: Math.random,
} satisfies Required<BackoffOptions>

/**
 * Full-jitter exponential backoff.
 *
 * Jitter matters more than usual here: when a switch reboots, thirty devices
 * drop at once, and a fixed schedule would have all thirty reconnect in the
 * same instant, repeatedly. Picking uniformly from [0, delay) spreads them.
 *
 * We never stop retrying. Gear gets powered on mid-set, and an amp that comes
 * back at 23:40 must reappear on the dashboard without anyone restarting a
 * service — so flapping only widens the interval, it never gives up.
 */
export class Backoff {
  private readonly opts: Required<BackoffOptions>
  private attempt = 0
  private recentFailures: number[] = []

  constructor(options: BackoffOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  get attempts(): number {
    return this.attempt
  }

  /** Records a failure and returns how long to wait before the next attempt. */
  nextDelay(now: number): number {
    this.attempt += 1
    this.recentFailures.push(now)
    this.recentFailures = this.recentFailures.filter(
      (ts) => now - ts <= this.opts.crashLoopWindowMs,
    )

    const flapping = this.recentFailures.length > this.opts.crashLoopThreshold
    const cap = flapping ? this.opts.crashLoopCapMs : this.opts.capMs
    const ceiling = Math.min(cap, this.opts.baseMs * 2 ** (this.attempt - 1))

    return Math.floor(this.opts.random() * ceiling)
  }

  /**
   * Called on a healthy status report; resets only once genuinely stable.
   *
   * `connectedSince === null` means we are reporting health without ever
   * having reached "online" — a connector that comes up degraded, say. That is
   * not evidence of stability, so the attempt counter has to survive it, or a
   * device flapping between degraded and offline would retry every second
   * forever.
   */
  onConnected(now: number, connectedSince: number | null): void {
    if (connectedSince === null) return
    if (now - connectedSince < this.opts.stableAfterMs) return
    this.reset()
  }

  reset(): void {
    this.attempt = 0
    this.recentFailures = []
  }

  get stableAfterMs(): number {
    return this.opts.stableAfterMs
  }
}
