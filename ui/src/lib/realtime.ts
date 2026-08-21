'use client'
import { wsUrl } from './api'

type Listener = (data: unknown) => void

/**
 * One shared WebSocket to the connector-engine hub. Ref-counted topic
 * subscriptions so many widgets share one socket; re-subscribes the whole set
 * on reconnect (the server replies with fresh snapshots).
 */
class Realtime {
  private ws: WebSocket | null = null
  private open = false
  private readonly refs = new Map<string, number>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly latest = new Map<string, unknown>()
  private retry: ReturnType<typeof setTimeout> | null = null

  private ensure() {
    if (this.ws || typeof window === 'undefined') return
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    ws.onopen = () => {
      this.open = true
      const topics = [...this.refs.keys()]
      if (topics.length) ws.send(JSON.stringify({ t: 'sub', topics }))
      if (this.reg) ws.send(JSON.stringify({ t: 'register', data: this.reg }))
    }
    ws.onmessage = (ev) => {
      let m: { t?: string; topic?: string; data?: unknown }
      try { m = JSON.parse(ev.data) } catch { return }
      if ((m.t === 'snap' || m.t === 'data') && m.topic) {
        this.latest.set(m.topic, m.data)
        this.listeners.get(m.topic)?.forEach((fn) => fn(m.data))
      }
    }
    ws.onclose = () => {
      this.open = false; this.ws = null
      if (!this.retry) this.retry = setTimeout(() => { this.retry = null; this.ensure() }, 1500)
    }
    ws.onerror = () => ws.close()
  }

  subscribe(topic: string, fn: Listener): () => void {
    this.ensure()
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set())
    this.listeners.get(topic)!.add(fn)
    const n = (this.refs.get(topic) ?? 0) + 1
    this.refs.set(topic, n)
    if (n === 1 && this.open) this.ws?.send(JSON.stringify({ t: 'sub', topics: [topic] }))
    if (this.latest.has(topic)) fn(this.latest.get(topic))
    return () => {
      this.listeners.get(topic)?.delete(fn)
      const left = (this.refs.get(topic) ?? 1) - 1
      if (left <= 0) {
        this.refs.delete(topic)
        if (this.open) this.ws?.send(JSON.stringify({ t: 'unsub', topics: [topic] }))
      } else this.refs.set(topic, left)
    }
  }

  command(instanceId: string, command: string, input?: unknown) {
    this.ensure()
    this.ws?.send(JSON.stringify({ t: 'cmd', id: `c${Date.now()}`, instanceId, command, input }))
  }

  /** Register this browser as a surface display so it can be targeted by OSC
   *  (and listed in Settings). Re-sent on reconnect. */
  private reg: Record<string, unknown> | null = null
  register(data: Record<string, unknown>) {
    this.reg = data
    this.ensure()
    if (this.open) this.ws?.send(JSON.stringify({ t: 'register', data }))
  }
}

export const realtime = typeof window !== 'undefined' ? new Realtime() : (null as unknown as Realtime)
