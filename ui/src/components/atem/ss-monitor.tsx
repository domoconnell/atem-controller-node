'use client'
import { useEffect, useRef, useState } from 'react'
import type { Box } from '@/lib/types'
import { cn } from '@/lib/utils'

const BOX_COLORS = ['#6aa7ff', '#4fd487', '#f2b84b', '#d77df0']

export interface SsMonitorProps {
  boxes: (Box | null)[] | undefined
  inputName?: (id: number) => string
  /** 'pgm' | 'pvw' | 'plain' — tints the bezel + tally strip */
  tally?: 'pgm' | 'pvw' | 'plain'
  label?: string
  sublabel?: string
  className?: string
  showGrid?: boolean
  showLabels?: boolean
  /** Ghost boxes drawn faintly under the main ones (e.g. current vs target) */
  ghost?: (Box | null)[] | null
}

/**
 * ATEM SuperSource coordinates: x/y are hundredths of DVE units on a
 * 32×18 unit frame; size 1000 = full frame; crops are thousandths of a
 * unit (left/right 0–32000, top/bottom 0–18000).
 */
export function boxRect(b: Box, W: number, H: number) {
  const scale = b.size / 1000
  const bw = scale * W
  const bh = scale * H
  const cx = W / 2 + (b.x / 100 / 32) * W
  const cy = H / 2 - (b.y / 100 / 18) * H
  let x = cx - bw / 2, y = cy - bh / 2, w = bw, h = bh
  if (b.cropped) {
    const cl = (b.cropLeft / 32000) * bw
    const cr = (b.cropRight / 32000) * bw
    const ct = (b.cropTop / 18000) * bh
    const cb = (b.cropBottom / 18000) * bh
    x += cl; w = Math.max(0, w - cl - cr); y += ct; h = Math.max(0, h - ct - cb)
  }
  return { x, y, w, h }
}

export function SsMonitor({
  boxes, inputName, tally = 'plain', label, sublabel, className,
  showGrid = true, showLabels = true, ghost,
}: SsMonitorProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [, force] = useState(0)

  // Redraw whenever the canvas gets laid out / resized (tiles mount at 0px
  // width before layout, so a plain effect would draw into a 1px canvas).
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ro = new ResizeObserver(() => force((n) => n + 1))
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = c.getBoundingClientRect()
    const W = Math.max(1, Math.round(rect.width * dpr))
    const H = Math.round(W * 9 / 16)
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
    const ctx = c.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, W, H)
    const bg = ctx.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, '#0b0c10'); bg.addColorStop(1, '#06070a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    if (showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)'
      ctx.lineWidth = 1
      for (let i = 1; i < 4; i++) {
        const gx = (W / 4) * i, gy = (H / 4) * i
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke()
      }
      // centre cross
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.beginPath(); ctx.moveTo(W / 2 - 10 * dpr, H / 2); ctx.lineTo(W / 2 + 10 * dpr, H / 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(W / 2, H / 2 - 10 * dpr); ctx.lineTo(W / 2, H / 2 + 10 * dpr); ctx.stroke()
      // action-safe
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.setLineDash([4 * dpr, 4 * dpr])
      ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9)
      ctx.setLineDash([])
    }

    const draw = (list: (Box | null)[] | null | undefined, alpha: number, labels: boolean) => {
      ;(list || []).forEach((b, i) => {
        if (!b || !b.enabled) return
        const { x, y, w, h } = boxRect(b, W, H)
        if (w <= 0 || h <= 0) return
        const col = BOX_COLORS[i]
        ctx.globalAlpha = alpha
        const g = ctx.createLinearGradient(x, y, x, y + h)
        g.addColorStop(0, col + '3a'); g.addColorStop(1, col + '14')
        ctx.fillStyle = g
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = col
        ctx.lineWidth = 1.5 * dpr
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
        // corner ticks
        const t = Math.min(14 * dpr, w / 3, h / 3)
        ctx.lineWidth = 3 * dpr
        ctx.beginPath()
        ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y)
        ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t)
        ctx.moveTo(x + w, y + h - t); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - t, y + h)
        ctx.moveTo(x + t, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - t)
        ctx.stroke()
        if (labels && showLabels && w > 60 * dpr && h > 28 * dpr) {
          const name = inputName ? inputName(b.source) : (b.sourceName ?? String(b.source))
          const fs = Math.max(10 * dpr, Math.min(13 * dpr, w / 14))
          ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`
          const text = `${i + 1}  ${name}`
          const tw = ctx.measureText(text).width + 12 * dpr
          const th = fs + 8 * dpr
          // Label sits at the box's bottom-left, so it never collides with
          // the monitor header strip along the top edge.
          const lx = x + 6 * dpr
          const ly = y + h - th - 6 * dpr
          ctx.fillStyle = 'rgba(0,0,0,0.6)'
          ctx.fillRect(lx, ly, tw, th)
          ctx.fillStyle = col
          ctx.fillText(text, lx + 6 * dpr, ly + fs + 1 * dpr)
        }
        ctx.globalAlpha = 1
      })
    }
    if (ghost) draw(ghost, 0.28, false)
    draw(boxes, 1, true)
  })

  const tallyCls =
    tally === 'pgm' ? 'bg-pgm text-black' :
    tally === 'pvw' ? 'bg-pvw text-black' :
    'bg-muted text-muted-foreground'

  return (
    <div className={cn('relative rounded-xl monitor-bezel p-2', className)}>
      {(label || sublabel) && (
        <div className="absolute left-4 top-4 z-10 flex items-center gap-2 pointer-events-none rounded-md bg-black/55 backdrop-blur-sm pr-2 py-0.5 pl-0.5">
          {label && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]', tallyCls)}>
              {label}
            </span>
          )}
          {sublabel && <span className="text-[11px] text-white/70 font-medium drop-shadow">{sublabel}</span>}
        </div>
      )}
      <div className="relative overflow-hidden rounded-lg scanlines">
        <canvas ref={ref} className="block w-full aspect-video" />
      </div>
    </div>
  )
}
