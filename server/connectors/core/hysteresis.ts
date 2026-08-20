/**
 * Thresholds that do not chatter.
 *
 * A reading sitting on its limit crosses it constantly — a level at 102.0 dB
 * against a 102 dB alarm goes over and under several times a minute, and a
 * board that adds and removes a row each time is one people stop reading. The
 * answer is as old as thermostats: once something is over, it stays over until
 * it comes back by a margin.
 *
 * Deliberately asymmetric, and only in this direction. Raising is instant,
 * because the first moment a level goes over is the moment somebody wants to
 * know. Only the *clearing* waits, and it waits on the reading rather than on
 * a clock — a delay in time would mean showing a problem when there is none,
 * which is the opposite of what a board is for.
 *
 * A margin relative to the threshold rather than twenty hand-picked numbers:
 * 3% is 3 dB on a 102 dB alarm, 2.4 points on an 80% CPU limit, and 1.5 m/s on
 * a 50 m/s wind gust — the right order of magnitude in every case, and one
 * number to reason about instead of one per condition.
 */
export const CLEAR_MARGIN = 0.03

const margin = (threshold: number) => Math.abs(threshold) * CLEAR_MARGIN

/**
 * Is this reading above its limit?
 *
 * `wasActive` is what makes it hysteresis rather than a comparison: while the
 * problem is up, the bar to *stay* up is a little lower than the bar to raise
 * it in the first place.
 */
export function overThreshold(value: number, threshold: number, wasActive: boolean): boolean {
  return value > (wasActive ? threshold - margin(threshold) : threshold)
}

/** The same, for the readings where small is the bad direction. */
export function underThreshold(value: number, threshold: number, wasActive: boolean): boolean {
  return value < (wasActive ? threshold + margin(threshold) : threshold)
}
