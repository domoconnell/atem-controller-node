'use client'
import { useEffect, useRef, useState } from 'react'
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el); return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}
