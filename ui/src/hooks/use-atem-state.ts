'use client'
import { useEffect, useRef, useState } from 'react'
import type { Snapshot, WireLine } from '@/lib/types'
import { wsUrl } from '@/lib/api'

const WIRE_MAX = 500

/**
 * Live snapshot from the service over WebSocket, with auto-reconnect and a
 * `tick` counter that bumps on every message (drives the heartbeat dot).
 */
export function useAtemState() {
  const [state, setState] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [tick, setTick] = useState(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Wire log lines live in a ref (they arrive in bursts); a throttled
  // version counter triggers re-renders at most ~4x/sec.
  const wireRef = useRef<WireLine[]>([])
  const [wireVersion, setWireVersion] = useState(0)
  const wireFlush = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushWire = (lines: WireLine[]) => {
    // Cluster: a run of identical requests (same proto/dir/summary) stays one
    // line - the counter increments and the timestamp advances. The server's
    // repeat-collapse flushes ("xN more <kind>") fold into the same cluster.
    const out = [...wireRef.current]
    for (const l of lines) {
      const last = out[out.length - 1]
      if (last && last.proto === l.proto && last.dir === l.dir) {
        if (l.repeat && !last.repeat && (last.summary ?? '').split(' ')[0] === l.kind) {
          out[out.length - 1] = { ...last, t: l.t, count: (last.count ?? 1) + l.repeat }
          continue
        }
        if (!l.repeat && !last.repeat && last.summary === l.summary) {
          out[out.length - 1] = { ...last, t: l.t, detail: l.detail, count: (last.count ?? 1) + 1 }
          continue
        }
      }
      if (!l.repeat) out.push({ ...l, count: 1 })
      // unmatched server repeat-flushes carry no new information - drop them
    }
    wireRef.current = out.slice(-WIRE_MAX)
    if (!wireFlush.current) {
      wireFlush.current = setTimeout(() => {
        wireFlush.current = null
        setWireVersion((v) => v + 1)
      }, 250)
    }
  }
  const clearWire = () => {
    wireRef.current = []
    setWireVersion((v) => v + 1)
  }

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    // Instant first paint from the REST snapshot; the socket takes over
    // as soon as it delivers (and keeps delivering).
    fetch('/api/status').then((r) => r.json()).then((s) => setState((cur) => cur ?? s)).catch(() => {})
    const connect = () => {
      ws = new WebSocket(wsUrl())
      ws.onopen = () => setConnected(true)
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data)
          if (data.wire) { pushWire([data.wire]); return }
          if (data.wireHistory) { pushWire(data.wireHistory); return }
          setState(data)
          setTick((t) => t + 1)
        } catch { /* ignore malformed */ }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry.current = setTimeout(connect, 1500)
      }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      closed = true
      if (retry.current) clearTimeout(retry.current)
      ws?.close()
    }
  }, [])

  return { state, connected, tick, wire: wireRef.current, wireVersion, clearWire }
}
