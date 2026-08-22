'use client'
import { createContext, useContext, useEffect, useRef } from 'react'

/** A widget calls this to flash its frame. Provided by WidgetView. */
export const PulseContext = createContext<() => void>(() => {})
export function usePulse() { return useContext(PulseContext) }

/**
 * Flash the surrounding widget whenever `value` changes to a new value — the
 * semantic "something happened" signal (a new message, an advance, a status
 * change). Never fires on first mount. Pass a primitive or a small stable key
 * (e.g. a message id, an index, a joined status string).
 */
export function usePulseOn(value: unknown) {
  const pulse = usePulse()
  const prev = useRef<unknown>(value)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; prev.current = value; return }
    if (prev.current !== value) { prev.current = value; pulse() }
  }, [value, pulse])
}
