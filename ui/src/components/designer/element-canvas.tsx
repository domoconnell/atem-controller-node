'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutElement } from '@/lib/designer-types'
import { elementQuery, elementLabel } from '@/lib/designer-types'
import { cn } from '@/lib/utils'

// Snap grid: 10px in 1920x1080 design space, expressed in percent.
const SNAP_X = (10 / 1920) * 100
const SNAP_Y = (10 / 1080) * 100
// How close (in %) an element's centre must be to a guide to snap to it.
const GUIDE_THRESHOLD = 0.9

const snapX = (v: number) => Math.round(v / SNAP_X) * SNAP_X
const snapY = (v: number) => Math.round(v / SNAP_Y) * SNAP_Y
const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * The 16:9 design surface. Elements are percent-positioned boxes with a
 * live transparent iframe preview inside; drag to move (10px grid snap +
 * centre guides), corner handle to resize.
 */
export function ElementCanvas({
  elements, layoutTimer, selectedId, onSelect, onChange, replayKey = 0,
}: {
  elements: LayoutElement[]
  layoutTimer?: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<LayoutElement>) => void
  replayKey?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  // One SSE stream for the whole canvas; snapshots are forwarded into every
  // preview iframe (feed=parent) so N elements never hold N connections.
  const latestSnap = useRef<unknown>(null)
  useEffect(() => {
    const broadcast = () => {
      if (!latestSnap.current || !ref.current) return
      for (const f of ref.current.querySelectorAll('iframe')) {
        f.contentWindow?.postMessage({ type: 'tfr-timers', snap: latestSnap.current }, '*')
      }
    }
    const es = new EventSource('/api/timers/stream')
    es.onmessage = (ev) => { latestSnap.current = JSON.parse(ev.data); broadcast() }
    // periodic rebroadcast catches iframes that mounted after the last event
    const iv = setInterval(broadcast, 800)
    return () => { es.close(); clearInterval(iv) }
  }, [])
  const [guideV, setGuideV] = useState(false)
  const [guideH, setGuideH] = useState(false)

  const startDrag = useCallback((e: React.PointerEvent, el: LayoutElement, mode: 'move' | 'resize') => {
    e.preventDefault()
    e.stopPropagation()
    onSelect(el.id)
    const rect = ref.current!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, ex: el.x, ey: el.y, ew: el.w, eh: el.h }
    setDragging(true)

    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - start.x) / rect.width) * 100
      const dy = ((ev.clientY - start.y) / rect.height) * 100
      if (mode === 'move') {
        let x = snapX(start.ex + dx)
        let y = snapY(start.ey + dy)
        // Centre guides win over the grid.
        const vHit = Math.abs(x + start.ew / 2 - 50) < GUIDE_THRESHOLD
        const hHit = Math.abs(y + start.eh / 2 - 50) < GUIDE_THRESHOLD
        if (vHit) x = 50 - start.ew / 2
        if (hHit) y = 50 - start.eh / 2
        setGuideV(vHit)
        setGuideH(hHit)
        onChange(el.id, {
          x: r2(Math.max(-50, Math.min(95, x))),
          y: r2(Math.max(-50, Math.min(95, y))),
        })
      } else {
        const w = snapX(start.ew + dx)
        const h = snapY(start.eh + dy)
        onChange(el.id, {
          w: r2(Math.max(2, Math.min(150, w))),
          h: r2(Math.max(2, Math.min(150, h))),
        })
      }
    }
    const up = () => {
      setDragging(false)
      setGuideV(false)
      setGuideH(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [onChange, onSelect])

  return (
    <div
      ref={ref}
      onPointerDown={() => onSelect(null)}
      className="relative w-full aspect-video rounded-xl overflow-hidden border border-border select-none"
      style={{ background: 'repeating-conic-gradient(#22252c 0% 25%, #2c3039 0% 50%) 0 0 / 28px 28px' }}
    >
      {/* centre guides - visible while dragging, hot when snapped */}
      {dragging && (
        <>
          <div className={cn(
            'absolute top-0 bottom-0 left-1/2 -translate-x-px w-px z-30 pointer-events-none transition-colors',
            guideV ? 'bg-primary shadow-[0_0_8px_var(--primary)]' : 'bg-white/15'
          )} />
          <div className={cn(
            'absolute left-0 right-0 top-1/2 -translate-y-px h-px z-30 pointer-events-none transition-colors',
            guideH ? 'bg-primary shadow-[0_0_8px_var(--primary)]' : 'bg-white/15'
          )} />
        </>
      )}

      {elements.map((el, i) => (
        <div
          key={el.id}
          onPointerDown={(e) => startDrag(e, el, 'move')}
          className={cn(
            'absolute group cursor-grab active:cursor-grabbing',
            selectedId === el.id
              ? 'outline-2 outline-primary z-20'
              : 'outline-1 outline-white/15 hover:outline-white/40 z-10'
          )}
          style={{
            left: el.x + '%', top: el.y + '%', width: el.w + '%', height: el.h + '%',
            outlineStyle: 'solid', transform: el.r ? `rotate(${el.r}deg)` : undefined,
          }}
        >
          <iframe
            key={replayKey}
            src={'/r/timer.html?feed=parent&' + elementQuery(el, layoutTimer)}
            className="absolute inset-0 w-full h-full pointer-events-none border-0"
            tabIndex={-1}
          />
          <span className={cn(
            'absolute -top-5 left-0 text-[9px] font-bold uppercase tracking-wider px-1 rounded-sm',
            selectedId === el.id ? 'bg-primary text-primary-foreground' : 'bg-black/60 text-white/70 opacity-0 group-hover:opacity-100'
          )}>
            {i + 1} · {elementLabel(el)}
          </span>
          <div
            onPointerDown={(e) => startDrag(e, el, 'resize')}
            className={cn(
              'absolute -right-1.5 -bottom-1.5 size-3.5 rounded-sm border cursor-nwse-resize',
              selectedId === el.id ? 'bg-primary border-primary' : 'bg-white/30 border-white/50 opacity-0 group-hover:opacity-100'
            )}
          />
        </div>
      ))}
      {elements.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground text-[13px] pointer-events-none">
          No elements yet — hit “Add element”
        </div>
      )}
    </div>
  )
}
