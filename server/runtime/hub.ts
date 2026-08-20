/**
 * Minimal realtime hub: keeps the latest whole-value snapshot per topic and
 * fans changes out to WebSocket subscribers. Snapshot-on-subscribe makes
 * reconnects cheap; payloads are whole values, never diffs.
 */
export interface HubSubscriber { topics: Set<string>; send: (msg: unknown) => void }
interface Snap { seq: number; ts: number | null; data: unknown }

export class Hub {
  private snaps = new Map<string, Snap>()
  private subs = new Set<HubSubscriber>()

  publish(topic: string, data: unknown, ts: number = Date.now()): void {
    const prev = this.snaps.get(topic)
    const seq = (prev?.seq ?? 0) + 1
    this.snaps.set(topic, { seq, ts, data })
    const frame = JSON.stringify({ t: 'data', topic, seq, ts, data })
    for (const s of this.subs) if (s.topics.has(topic)) s.send(frame)
  }
  snapshot(topic: string): Snap | null { return this.snaps.get(topic) ?? null }

  addSubscriber(sub: HubSubscriber): void { this.subs.add(sub) }
  removeSubscriber(sub: HubSubscriber): void { this.subs.delete(sub) }
  /** Subscribe a client to topics and immediately send current snapshots. */
  subscribe(sub: HubSubscriber, topics: string[]): void {
    for (const topic of topics) {
      sub.topics.add(topic)
      const s = this.snaps.get(topic)
      sub.send(JSON.stringify({ t: 'snap', topic, seq: s?.seq ?? 0, ts: s?.ts ?? null, data: s?.data ?? null }))
    }
  }
  unsubscribe(sub: HubSubscriber, topics: string[]): void { for (const t of topics) sub.topics.delete(t) }

  /** Drop an instance's topics (widgets blank rather than freeze). */
  retire(instanceId: string): void {
    const prefix = `mi:${instanceId}:`
    for (const topic of [...this.snaps.keys()]) if (topic.startsWith(prefix)) this.publish(topic, null)
  }
}
