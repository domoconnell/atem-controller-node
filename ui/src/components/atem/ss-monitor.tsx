'use client'
import { useEffect, useRef, useState } from 'react'
import type { Box, MixEffectLive } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Broadcast-style monitor that renders a *scene*: what is on the output.
 *  - direct feed  -> full-frame plate in that source's colour, big label
 *  - SuperSource  -> art plate + boxes, each box in ITS SOURCE's colour
 *  - during a mix -> outgoing scene under incoming scene at handle alpha
 *  - USKs on air  -> translucent overlays (pattern keys drawn as shape)
 * Every source has a stable, distinct colour so ProMain always looks the
 * same wherever it appears (box, direct feed, key fill).
 */

export interface Scene {
  program: number
  boxes: (Box | null)[]
  artFill?: number | null
  keyers?: (MixEffectLive['keyers'][number])[]
}

export interface SsMonitorProps {
  /** Legacy: SS boxes only (treated as program=SS). Prefer `scene`. */
  boxes?: (Box | null)[] | undefined
  scene?: Scene
  /** Incoming scene + progress (0..1) to render a mix in flight. */
  mixTo?: { scene: Scene; t: number; keysOnly?: boolean } | null
  inputName?: (id: number) => string
  tally?: 'pgm' | 'pvw' | 'plain'
  label?: string
  sublabel?: string
  className?: string
  showGrid?: boolean
  showLabels?: boolean
  ghost?: (Box | null)[] | null
  ssInput?: number
  /** JPEG URL of the ProPresenter background media, painted where ProPresenter shows. */
  mediaThumbUrl?: string | null
  /** Zero-indexed SS box carrying the main display feed (config.supersource.displayBox);
   *  used as a fallback for where ProPresenter shows when `proInput` is unset. */
  displayBox?: number
  /** ATEM input number carrying ProPresenter. When set, the media paints into ANY box
   *  on this source and full-frame when it is the direct program — not tied to a box index. */
  proInput?: number | null
}

// ---- source colours: stable per input id -------------------------------
const NAMED: Record<number, string> = {
  0: '#3a3f4a',      // black
  6000: '#b48cff',   // SuperSource (only used as a fallback plate)
  14: '#4c9be8',     // HD 3 (art loop)
  15: '#f2b84b',     // ProMain
  9: '#f06292',      // Worship
  1: '#4fd487', 2: '#26c6da', 3: '#9ccc65', 4: '#ffb74d', 5: '#ba68c8',
  3010: '#8d99ae', 3020: '#a8b5c7', 3011: '#8d99ae', 3021: '#a8b5c7',
}
export function sourceColor(id: number): string {
  if (NAMED[id]) return NAMED[id]
  // hash -> pleasant hue
  let h = (id * 2654435761) % 360
  if (h < 0) h += 360
  return `hsl(${h} 62% 62%)`
}

// ATEM SuperSource coordinates: hundredths of DVE units on a 32×18 frame;
// size 1000 = full frame; crops in thousandths (l/r 0–32000, t/b 0–18000).
export function boxRect(b: Box, W: number, H: number) {
  const scale = b.size / 1000
  const bw = scale * W, bh = scale * H
  const cx = W / 2 + (b.x / 100 / 32) * W
  const cy = H / 2 - (b.y / 100 / 18) * H
  let x = cx - bw / 2, y = cy - bh / 2, w = bw, h = bh
  const full = { x, y, w, h }   // the whole source frame, before cropping
  if (b.cropped) {
    const cl = (b.cropLeft / 32000) * bw, cr = (b.cropRight / 32000) * bw
    const ct = (b.cropTop / 18000) * bh, cb = (b.cropBottom / 18000) * bh
    x += cl; w = Math.max(0, w - cl - cr); y += ct; h = Math.max(0, h - ct - cb)
  }
  return { x, y, w, h, full }
}

/** Thumbnail-sized source label: "Camera 1" -> "C1", "ProMain" -> "Pro", "Media Player 1" -> "MP1". */
function shortName(n: string): string {
  const m = /^(Camera|Cam)\s*(\d+)/i.exec(n); if (m) return 'C' + m[2]
  const mp = /^Media Player\s*(\d+)/i.exec(n); if (mp) return 'MP' + mp[1]
  if (/^SuperSource/i.test(n)) return 'SS'
  const w = n.split(/\s+/)
  if (w.length > 1) return w.map((x) => x[0]).join('').toUpperCase().slice(0, 3)
  // single word: CamelCase initials ("ProMain" -> "PM"), else first 4 chars
  const caps = n.match(/[A-Z]/g)
  if (caps && caps.length >= 2) return caps.join('').slice(0, 3)
  return n.slice(0, 4)
}

function hexA(hex: string, a: number) {
  if (hex.startsWith('hsl')) return hex.replace(')', ` / ${a})`).replace('hsl(', 'hsl(')
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export function SsMonitor({
  boxes, scene, mixTo, inputName, tally = 'plain', label, sublabel, className,
  showGrid = true, showLabels = true, ghost, ssInput = 6000, mediaThumbUrl = null, displayBox, proInput = null,
}: SsMonitorProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [, force] = useState(0)
  // Load the ProPresenter background thumbnail once per URL; redraw on load.
  const mediaImg = useRef<{ url: string; img: HTMLImageElement; ready: boolean } | null>(null)
  useEffect(() => {
    if (!mediaThumbUrl) { mediaImg.current = null; force((n) => n + 1); return }
    if (mediaImg.current?.url === mediaThumbUrl) return
    const img = new Image()
    const rec = { url: mediaThumbUrl, img, ready: false }
    mediaImg.current = rec
    img.onload = () => { if (mediaImg.current === rec) { rec.ready = true; force((n) => n + 1) } }
    img.onerror = () => { if (mediaImg.current === rec) mediaImg.current = null }
    img.src = mediaThumbUrl
  }, [mediaThumbUrl])
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ro = new ResizeObserver(() => force((n) => n + 1))
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  const sc: Scene = scene ?? { program: ssInput, boxes: boxes ?? [] }

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
    const name = (id: number) => (inputName ? inputName(id) : String(id))
    const big = W > 400 * dpr

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#07080b'
    ctx.fillRect(0, 0, W, H)

    // ---- draw one scene (background layer + boxes) ----
    const drawScene = (s: Scene, alpha: number, labels: boolean, drawMedia = false) => {
      ctx.save()
      ctx.globalAlpha = alpha
      if (s.program === ssInput) {
        // art plate
        if (s.artFill != null) {
          const col = sourceColor(s.artFill)
          const g = ctx.createLinearGradient(0, 0, 0, H)
          g.addColorStop(0, hexA(col, 0.22)); g.addColorStop(1, hexA(col, 0.10))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)
          if (labels && showLabels && big) {
            ctx.fillStyle = hexA(col, 0.55)
            ctx.font = `600 ${11 * dpr}px ui-sans-serif, system-ui, sans-serif`
            ctx.textAlign = 'right'
            ctx.fillText(`art · ${name(s.artFill)}`, W - 10 * dpr, H - 10 * dpr)
            ctx.textAlign = 'left'
          }
        }
        ;(s.boxes || []).forEach((b, i) => {
          if (!b || !b.enabled || b.size <= 0) return
          const { x, y, w, h, full } = boxRect(b, W, H)
          if (w <= 0 || h <= 0) return
          const col = sourceColor(b.source)
          const isCropped = full.w - w > 1 || full.h - h > 1

          // -- source delineator: the whole source frame, dashed and dim,
          //    so you can see which slice the crop lets through --
          if (isCropped && labels) {
            ctx.save()
            ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip()
            ctx.fillStyle = hexA(col, 0.07)
            ctx.fillRect(full.x, full.y, full.w, full.h)
            ctx.strokeStyle = hexA(col, 0.55)
            ctx.lineWidth = 1 * dpr
            ctx.setLineDash([5 * dpr, 4 * dpr])
            ctx.strokeRect(full.x + 0.5, full.y + 0.5, full.w - 1, full.h - 1)
            ctx.setLineDash([])
            // hatch the cropped-away area (inside full frame, outside visible)
            ctx.beginPath()
            ctx.rect(full.x, full.y, full.w, full.h)
            ctx.rect(x, y, w, h)
            ctx.clip('evenodd')
            ctx.strokeStyle = hexA(col, 0.16)
            ctx.lineWidth = 1 * dpr
            const step = 9 * dpr
            for (let d = -H; d < W + H; d += step) {
              ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.stroke()
            }
            ctx.restore()
          }

          // -- visible region (what actually comes through the box) --
          const g = ctx.createLinearGradient(x, y, x, y + h)
          g.addColorStop(0, hexA(col, 0.42)); g.addColorStop(1, hexA(col, 0.22))
          ctx.fillStyle = g
          ctx.fillRect(x, y, w, h)
          // -- ProPresenter background media: paint the real thumbnail into the
          //    ProMain box, scaled to COVER the full source frame and clipped to
          //    the visible (cropped) region, so a crop shows the right slice --
          // The box shows ProPresenter when it's on the configured PP input;
          // if that isn't set, fall back to the display-box index.
          const isProBox = proInput != null ? b.source === proInput : i === displayBox
          let hasMedia = false
          if (drawMedia && isProBox && mediaImg.current?.ready) {
            const im = mediaImg.current.img
            const ar = im.width / im.height, far = full.w / full.h
            let dw, dh, dx, dy
            if (ar > far) { dh = full.h; dw = dh * ar; dx = full.x - (dw - full.w) / 2; dy = full.y }
            else { dw = full.w; dh = dw / ar; dx = full.x; dy = full.y - (dh - full.h) / 2 }
            ctx.save()
            ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
            ctx.globalAlpha = alpha
            try { ctx.drawImage(im, dx, dy, dw, dh) } catch { /* decode not ready */ }
            ctx.restore()
            hasMedia = true
          }
          // faint "picture" cue of the FULL source (diagonals + centre ring),
          // clipped to the visible region, so a top-half crop reads as "the
          // top half of the picture" rather than "a smaller picture"
          if (labels && !hasMedia && (big || w > 40 * dpr)) {
            ctx.save()
            ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
            ctx.strokeStyle = hexA(col, 0.22)
            ctx.lineWidth = 1 * dpr
            ctx.beginPath()
            ctx.moveTo(full.x, full.y); ctx.lineTo(full.x + full.w, full.y + full.h)
            ctx.moveTo(full.x + full.w, full.y); ctx.lineTo(full.x, full.y + full.h)
            ctx.stroke()
            const fcx = full.x + full.w / 2, fcy = full.y + full.h / 2, r = Math.min(full.w, full.h) * 0.06
            ctx.beginPath(); ctx.arc(fcx, fcy, r, 0, Math.PI * 2); ctx.stroke()
            ctx.restore()
          }
          ctx.strokeStyle = col
          ctx.lineWidth = 1.5 * dpr
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
          const t = Math.min(14 * dpr, w / 3, h / 3)
          ctx.lineWidth = 3 * dpr
          ctx.beginPath()
          ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y)
          ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t)
          ctx.moveTo(x + w, y + h - t); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - t, y + h)
          ctx.moveTo(x + t, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - t)
          ctx.stroke()
          if (labels && showLabels && big && h > 22 * dpr) {
            // Label sits inside the VISIBLE region, clamped on-canvas. Wide
            // slice: full text; narrow slice: just the box number.
            const fs = Math.max(10 * dpr, Math.min(13 * dpr, Math.max(w, 60 * dpr) / 14))
            ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`
            const cropTxt = isCropped ? `  · ${Math.round((w / full.w) * 100)}×${Math.round((h / full.h) * 100)}%` : ''
            const fullText = `${i + 1}  ${name(b.source)}${cropTxt}`
            const fits = ctx.measureText(fullText).width + 12 * dpr < w - 8 * dpr
            const text = fits ? fullText : String(i + 1)
            const tw = ctx.measureText(text).width + 12 * dpr
            const th = fs + 8 * dpr
            const vx0 = Math.max(0, x), vx1 = Math.min(W, x + w)
            const vy0 = Math.max(0, y), vy1 = Math.min(H, y + h)
            if (vx1 - vx0 > tw + 4 * dpr && vy1 - vy0 > th + 4 * dpr) {
              const lx = vx0 + 6 * dpr, ly = vy1 - th - 6 * dpr
              ctx.fillStyle = 'rgba(0,0,0,0.6)'
              ctx.fillRect(lx, ly, tw, th)
              ctx.fillStyle = col
              ctx.fillText(text, lx + 6 * dpr, ly + fs + 1 * dpr)
            }
          } else if (labels && showLabels && !big && w > 18 * dpr && h > 12 * dpr) {
            // thumbnails: just the source initial
            ctx.fillStyle = col
            ctx.font = `700 ${Math.max(9 * dpr, Math.min(12 * dpr, h / 3))}px ui-sans-serif, system-ui, sans-serif`
            ctx.fillText(shortName(name(b.source)), x + 4 * dpr, y + h - 5 * dpr)
          }
        })
      } else {
        // direct feed: full-frame plate — or, when this direct feed IS the
        // ProMain input (the source the displayBox carries), the ProPresenter
        // background media full-frame, since the whole output is ProPresenter.
        const col = sourceColor(s.program)
        // The direct feed IS ProPresenter when it's the configured PP input;
        // fall back to whatever source the display box carries.
        const proSrc = proInput != null ? proInput : (displayBox != null ? s.boxes?.[displayBox]?.source : undefined)
        const im = drawMedia && mediaImg.current?.ready && proSrc != null && s.program === proSrc ? mediaImg.current.img : null
        if (im) {
          const ar = im.width / im.height, far = W / H
          let dw, dh, dx, dy
          if (ar > far) { dh = H; dw = dh * ar; dx = -(dw - W) / 2; dy = 0 }
          else { dw = W; dh = dw / ar; dx = 0; dy = -(dh - H) / 2 }
          ctx.save(); ctx.globalAlpha = alpha
          try { ctx.drawImage(im, dx, dy, dw, dh) } catch { /* decode not ready */ }
          ctx.restore()
        } else {
          const g = ctx.createLinearGradient(0, 0, W, H)
          g.addColorStop(0, hexA(col, 0.40)); g.addColorStop(1, hexA(col, 0.18))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)
        }
        ctx.strokeStyle = hexA(col, 0.7)
        ctx.lineWidth = 2 * dpr
        ctx.strokeRect(1, 1, W - 2, H - 2)
        if (labels && showLabels) {
          const fs = big ? 22 * dpr : Math.max(9 * dpr, H / 6)
          if (im) {
            // media is showing — a small corner label, not a big centred plate name
            if (big) {
              ctx.font = `700 ${11 * dpr}px ui-sans-serif, system-ui, sans-serif`
              ctx.fillStyle = 'rgba(255,255,255,0.8)'
              ctx.textAlign = 'left'
              ctx.fillText(`${name(s.program)} · ProPresenter`, 10 * dpr, H - 10 * dpr)
            }
          } else {
            ctx.font = `800 ${fs}px ui-sans-serif, system-ui, sans-serif`
            ctx.fillStyle = hexA(col, 0.95)
            ctx.textAlign = 'center'
            ctx.fillText(name(s.program), W / 2, H / 2 + fs / 3)
            if (big) {
              ctx.font = `600 ${11 * dpr}px ui-sans-serif, system-ui, sans-serif`
              ctx.fillStyle = 'rgba(255,255,255,0.45)'
              ctx.fillText('direct feed', W / 2, H / 2 + fs / 3 + 16 * dpr)
            }
          }
          ctx.textAlign = 'left'
        }
      }
      ctx.restore()
    }

    // ---- USK overlays for a scene ----
    const drawKeys = (s: Scene, alpha: number) => {
      ;(s.keyers ?? []).forEach((k, i) => {
        if (!k || !k.onAir) return
        ctx.save()
        ctx.globalAlpha = alpha
        const fill = k.fillSource ?? 0
        const col = sourceColor(fill)
        if (k.keyType === 'pattern' && k.pattern) {
          // barn-door / box style: draw the pattern's shape as a soft region
          const p = k.pattern
          const size = Math.min(1, Math.max(0, p.size / 10000))
          const cx = (p.positionX / 10000) * W, cy = (p.positionY / 10000) * H
          const inv = !!p.invert
          ctx.fillStyle = hexA(col, 0.28)
          if (p.style === 2 || p.style === 3) {
            // barn doors: horizontal (2) opens from centre out; inverted = edges
            const half = size / 2
            if (p.style === 2) {
              const y0 = cy - half * H, y1 = cy + half * H
              if (inv) { ctx.fillRect(0, 0, W, Math.max(0, y0)); ctx.fillRect(0, y1, W, H - y1) }
              else ctx.fillRect(0, y0, W, y1 - y0)
            } else {
              const x0 = cx - half * W, x1 = cx + half * W
              if (inv) { ctx.fillRect(0, 0, Math.max(0, x0), H); ctx.fillRect(x1, 0, W - x1, H) }
              else ctx.fillRect(x0, 0, x1 - x0, H)
            }
          } else if (p.style === 7 || p.style === 6 || p.style === 5) {
            const r = size * Math.max(W, H) * 0.5
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
            if (inv) { ctx.rect(W, 0, -W, H) }
            ctx.fill('evenodd')
          } else {
            const w = size * W, h = size * H
            ctx.fillRect(cx - w / 2, cy - h / 2, w, h)
          }
        } else {
          // luma/other: dashed border (a full-frame key like a border graphic)
          if (big) { ctx.fillStyle = hexA(col, 0.06); ctx.fillRect(0, 0, W, H) }
          ctx.strokeStyle = hexA(col, 0.9)
          ctx.lineWidth = 3 * dpr
          ctx.setLineDash([6 * dpr, 4 * dpr])
          ctx.strokeRect(4 * dpr, 4 * dpr, W - 8 * dpr, H - 8 * dpr)
          ctx.setLineDash([])
        }
        if (showLabels && big) {
          const fs = 10 * dpr
          ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`
          const text = `USK${i + 1} · ${name(fill)}`
          const tw = ctx.measureText(text).width + 10 * dpr
          const lx = W - tw - 8 * dpr, ly = 8 * dpr + i * (fs + 12 * dpr)
          ctx.fillStyle = 'rgba(0,0,0,0.6)'
          ctx.fillRect(lx, ly, tw, fs + 8 * dpr)
          ctx.fillStyle = col
          ctx.fillText(text, lx + 5 * dpr, ly + fs + 1 * dpr)
        }
        ctx.restore()
      })
    }

    // ---- compose ----
    if (ghost) drawScene({ program: ssInput, boxes: ghost }, 0.28, false)
    if (mixTo && mixTo.t > 0 && mixTo.t < 1) {
      if (mixTo.keysOnly) {
        drawScene(sc, 1, true, true)
        // keys crossfade: outgoing keys fade out, incoming fade in
        drawKeys(sc, 1 - mixTo.t)
        drawKeys(mixTo.scene, mixTo.t)
      } else {
        drawScene(sc, 1, true, true)
        drawScene(mixTo.scene, mixTo.t, true)
        drawKeys(sc, 1 - mixTo.t)
        drawKeys(mixTo.scene, mixTo.t)
        // mix indicator
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        ctx.fillRect(0, H - 4 * dpr, W, 4 * dpr)
        ctx.fillStyle = '#f2b84b'
        ctx.fillRect(0, H - 4 * dpr, W * mixTo.t, 4 * dpr)
      }
    } else {
      drawScene(sc, 1, true, true)
      drawKeys(sc, 1)
    }

    if (showGrid && big) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)'
      ctx.lineWidth = 1
      for (let i = 1; i < 4; i++) {
        const gx = (W / 4) * i, gy = (H / 4) * i
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.setLineDash([4 * dpr, 4 * dpr])
      ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9)
      ctx.setLineDash([])
    }
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
