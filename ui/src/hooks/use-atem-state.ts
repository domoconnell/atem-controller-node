'use client'
import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '@/lib/types'
import { wsUrl } from '@/lib/api'

/**
 * Live snapshot from the service over WebSocket, with auto-reconnect and a
 * `tick` counter that bumps on every message (drives the heartbeat dot).
 */
export function useAtemState() {
  const [state, setState] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [tick, setTick] = useState(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

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
          setState(JSON.parse(ev.data))
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

  return { state, connected, tick }
}
