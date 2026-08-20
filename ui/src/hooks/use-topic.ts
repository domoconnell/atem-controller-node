'use client'
import { useEffect, useState } from 'react'
import { realtime } from '@/lib/realtime'
import { buildTopic } from '@/lib/topics'

/** Subscribe to one hub topic for this component's lifetime. */
export function useTopic(topic: string | null): unknown {
  const [data, setData] = useState<unknown>(null)
  useEffect(() => {
    if (!topic || !realtime) return
    return realtime.subscribe(topic, setData)
  }, [topic])
  return data
}

/** Convenience: subscribe to one instance's stream. */
export function useStream(instanceId: string | null, streamId: string): unknown {
  return useTopic(instanceId ? buildTopic(instanceId, streamId) : null)
}
