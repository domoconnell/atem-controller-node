'use client'
import { useEffect, useState } from 'react'
import type { LayoutElement, TimerInfo } from '@/lib/designer-types'
import { PART_OPTIONS, ANIM_OPTIONS } from '@/lib/designer-types'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Copy, Trash2, ArrowUp, ArrowDown } from 'lucide-react'

function L({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1">{children}</div>
}
function Sel({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-input bg-muted/40 px-2 text-[12.5px]">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
const opt = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }))

// Canvas-based font detection (same technique as the /r/ builder).
const FONT_CANDIDATES = ['SF Pro Display','Helvetica','Helvetica Neue','Arial','Arial Black','Arial Narrow','Avenir','Avenir Next','Avenir Next Condensed','Futura','Gill Sans','Optima','Baskerville','Didot','Georgia','Palatino','Times New Roman','American Typewriter','Courier New','Menlo','Monaco','Impact','Trebuchet MS','Verdana','Tahoma','Copperplate','Chalkboard SE','Marker Felt','Bradley Hand','Brush Script MT','Noteworthy','Zapfino','Snell Roundhand','Papyrus','Herculanum','Luminari','Phosphate','Rockwell','Charter','Seravek','Iowan Old Style','Hoefler Text','Big Caslon','Bodoni 72','Cochin','Garamond','Athelas','PT Serif','PT Sans','Lucida Grande','Geneva','Segoe UI','Calibri','Cambria','Consolas','Century Gothic','Book Antiqua','Montserrat','Oswald','Bebas Neue','Roboto','Roboto Condensed','Open Sans','Lato','Raleway','Poppins','Inter','Nunito','Playfair Display','Merriweather','Anton','Barlow','Barlow Condensed','Archivo Black','League Gothic','Josefin Sans','Quicksand','Rubik','Work Sans','DM Sans','Space Grotesk','Space Mono','IBM Plex Sans','JetBrains Mono','Abril Fatface','Lobster','Pacifico','Caveat','Dancing Script','Great Vibes','Permanent Marker','Amatic SC']
let detected: string[] | null = null
function detectFonts(): string[] {
  if (detected) return detected
  const ctx = document.createElement('canvas').getContext('2d')!
  const SAMPLE = 'mmmMMMwwWWlli017.:'
  const base: Record<string, number> = {}
  for (const g of ['monospace', 'sans-serif', 'serif']) {
    ctx.font = '72px ' + g
    base[g] = ctx.measureText(SAMPLE).width
  }
  detected = FONT_CANDIDATES.filter((f) => {
    for (const g of ['monospace', 'sans-serif', 'serif']) {
      ctx.font = `72px "${f}", ${g}`
      if (Math.abs(ctx.measureText(SAMPLE).width - base[g]) > 0.5) return true
    }
    return false
  }).sort((a, b) => a.localeCompare(b))
  return detected
}

function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [typing, setTyping] = useState(false)   // filter only after the user types
  const [fonts, setFonts] = useState<string[]>([])
  useEffect(() => { setFonts(detectFonts()) }, [])
  const filter = typing ? value.trim().toLowerCase() : ''
  const matches = open ? fonts.filter((f) => !filter || f.toLowerCase().includes(filter)) : []
  return (
    <div className="relative">
      <Input value={value} placeholder="Helvetica"
        onChange={(e) => { onChange(e.target.value); setTyping(true); setOpen(true) }}
        onFocus={() => { setTyping(false); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="h-8 bg-muted/40 text-[12.5px]" />
      {open && matches.length > 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto rounded-md border border-primary bg-popover shadow-xl">
          {matches.slice(0, 200).map((f) => (
            <button key={f} type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(f); setOpen(false); setTyping(false) }}
              className="w-full text-left px-2.5 py-1.5 text-[14px] hover:bg-accent flex justify-between items-baseline gap-2">
              <span style={{ fontFamily: `"${f}"` }} className="truncate">{f}</span>
              <span style={{ fontFamily: `"${f}"` }} className="text-[11px] text-muted-foreground shrink-0">12:34</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ElementProps({
  element, timers, onParam, onGeom, onDelete, onDuplicate, onReorder, index, count,
}: {
  element: LayoutElement
  timers: TimerInfo[]
  onParam: (key: string, value: string) => void
  onGeom: (patch: Partial<LayoutElement>) => void
  onDelete: () => void
  onDuplicate: () => void
  onReorder: (dir: -1 | 1) => void
  index: number
  count: number
}) {
  const p = element.params
  const P = (k: string, d = '') => p[k] ?? d
  const type = P('type', 'timer')
  const isTimer = type === 'timer'
  const isShape = type === 'rect' || type === 'ellipse'
  const isText = (isTimer && !['progress-bar', 'progress-ring'].includes(P('part', 'time'))) || type === 'text'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-bold">Element {index + 1}</span>
        <span className="text-[11px] text-muted-foreground">· {isTimer ? P('part', 'time') : type}</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={index === 0} onClick={() => onReorder(-1)} title="Back"><ArrowUp className="size-3.5" /></Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={index === count - 1} onClick={() => onReorder(1)} title="Front"><ArrowDown className="size-3.5" /></Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onDuplicate} title="Duplicate"><Copy className="size-3.5" /></Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={onDelete} title="Delete"><Trash2 className="size-3.5" /></Button>
        </div>
      </div>

      {isTimer && (
        <div className="grid grid-cols-2 gap-2.5">
          <div><L>Part</L><Sel value={P('part', 'time')} onChange={(v) => onParam('part', v)} options={PART_OPTIONS} /></div>
          <div><L>Timer override</L>
            <Sel value={P('timer')} onChange={(v) => onParam('timer', v)}
              options={[{ value: '', label: '(layout default)' }, ...timers.map((t) => ({ value: t.name, label: t.name }))]} /></div>
        </div>
      )}
      {type === 'text' && (
        <div><L>Text</L><Input value={P('text', 'YOUR TEXT')} onChange={(e) => onParam('text', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
      )}
      {isShape && (
        <div className="grid grid-cols-3 gap-2.5">
          <div><L>Fill</L><input type="color" value={P('color', '#ffffff')} onChange={(e) => onParam('color', e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-muted/40 p-0.5" /></div>
          {type === 'rect' && <div><L>Radius (%)</L><Input type="number" min={0} max={50} value={P('radius', '0')} onChange={(e) => onParam('radius', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>}
          <div><L>Opacity</L><Input type="number" min={0} max={1} step={0.05} value={P('opacity', '1')} onChange={(e) => onParam('opacity', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
        </div>
      )}
      {isShape && (
        <div className="grid grid-cols-2 gap-2.5">
          <div><L>Border width (%)</L><Input type="number" min={0} step={0.5} value={P('borderw', '0')} onChange={(e) => onParam('borderw', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
          <div><L>Border colour</L><input type="color" value={P('borderc', '#000000')} onChange={(e) => onParam('borderc', e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-muted/40 p-0.5" /></div>
        </div>
      )}

      {isText && (
        <>
          {isTimer && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <div><L>Format</L><Sel value={P('format', 'digits')} onChange={(v) => onParam('format', v)} options={opt([['digits', 'digits'], ['words', 'words']])} /></div>
                <div><L>Case</L><Sel value={P('case')} onChange={(v) => onParam('case', v)} options={opt([['', 'as-is'], ['upper', 'UPPER'], ['title', 'Title'], ['lower', 'lower']])} /></div>
              </div>
              <div>
                <L>Zero-pad</L>
                <div className="flex gap-4 h-8 items-center">
                  {([['padh', 'hrs', '0'], ['padm', 'min', '0'], ['pads', 'sec', '1']] as const).map(([k, label, dflt]) => (
                    <label key={k} className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                      <input type="checkbox" className="accent-primary"
                        checked={(p[k] ?? dflt) === '1'}
                        onChange={(e) => onParam(k, e.target.checked ? '1' : '0')} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          {type === 'text' && (
            <div><L>Case</L><Sel value={P('case')} onChange={(v) => onParam('case', v)} options={opt([['', 'as-is'], ['upper', 'UPPER'], ['title', 'Title'], ['lower', 'lower']])} /></div>
          )}
          {isTimer && P('format', 'digits') === 'digits' && (
            <div><L>Digit style</L>
              <Sel value={P('digitstyle')} onChange={(v) => onParam('digitstyle', v)}
                options={opt([['', 'plain'], ['roll', 'constant roll (odometer)'], ['rollstep', 'roll on change'], ['flip', 'flip clock']])} />
            </div>
          )}
          <div><L>Font</L><FontPicker value={P('font', 'Helvetica')} onChange={(v) => onParam('font', v)} /></div>
          <div className="grid grid-cols-3 gap-2.5">
            <div><L>Size</L><Input value={P('size', 'fit')} onChange={(e) => onParam('size', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" title="'fit' or vh number" /></div>
            <div><L>Fill %</L><Input type="number" value={Math.round(parseFloat(P('fitpad', '0.94')) * 100)} min={10} max={100}
              onChange={(e) => onParam('fitpad', String((parseFloat(e.target.value) || 94) / 100))} className="h-8 bg-muted/40 text-[12.5px]" /></div>
            <div><L>Weight</L><Input type="number" step={100} min={100} max={900} value={P('weight', '800')} onChange={(e) => onParam('weight', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
          </div>
        </>
      )}

      {!isShape && (
        <div className="grid grid-cols-3 gap-2.5">
          <div><L>Colour</L><input type="color" value={P('color', '#ffffff')} onChange={(e) => onParam('color', e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-muted/40 p-0.5" /></div>
          <div><L>Opacity</L><Input type="number" min={0} max={1} step={0.05} value={P('opacity', '1')} onChange={(e) => onParam('opacity', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
          {isText
            ? <div><L>Italic</L><Sel value={P('italic')} onChange={(v) => onParam('italic', v)} options={opt([['', 'no'], ['1', 'yes']])} /></div>
            : <div><L>{P('part') === 'progress-ring' ? 'Thickness' : 'Direction'}</L>
                {P('part') === 'progress-ring'
                  ? <Input type="number" value={P('thickness', '8')} onChange={(e) => onParam('thickness', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" />
                  : <Sel value={P('direction')} onChange={(v) => onParam('direction', v)} options={opt([['', 'shrink ltr'], ['rtl', 'grow rtl']])} />}
              </div>}
        </div>
      )}

      {isTimer && !isText && (
        <div>
          <L>Total override (s)</L>
          <Input type="number" min={0} value={P('duration')} placeholder="auto (API or inferred)"
            onChange={(e) => onParam('duration', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" />
          <div className="text-[10px] text-muted-foreground mt-1">
            Countdown-to-time timers report no duration — set the intended window (e.g. 1800 for 30 min) for an exact ring/bar.
          </div>
        </div>
      )}

      {isText && (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div><L>Shadow</L><Sel value={P('shadow')} onChange={(v) => onParam('shadow', v)} options={opt([['', 'none'], ['1', 'soft']])} /></div>
            <div><L>Stroke (px,colour)</L><Input value={P('stroke')} placeholder="3,#000000" onChange={(e) => onParam('stroke', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <div><L>BG colour</L><input type="color" value={P('bg', '#000000')} onChange={(e) => onParam('bg', e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-muted/40 p-0.5" /></div>
            <div><L>BG opacity</L><Input type="number" min={0} max={1} step={0.05} value={P('bgopacity', '0')} onChange={(e) => onParam('bgopacity', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
            <div><L>Radius (em)</L><Input type="number" step={0.05} value={P('radius')} placeholder="0.2" onChange={(e) => onParam('radius', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div><L>H align</L><Sel value={P('align')} onChange={(v) => onParam('align', v)} options={opt([['', 'center'], ['left', 'left'], ['right', 'right']])} /></div>
            <div><L>V align</L><Sel value={P('valign')} onChange={(v) => onParam('valign', v)} options={opt([['', 'middle'], ['top', 'top'], ['bottom', 'bottom']])} /></div>
          </div>
          {isTimer && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <div><L>When stopped</L><Sel value={P('stopped')} onChange={(v) => onParam('stopped', v)} options={opt([['', 'hold'], ['hide', 'hide'], ['dash', 'dash']])} /></div>
                <div><L>Overrun</L><Sel value={P('overrun')} onChange={(v) => onParam('overrun', v)} options={opt([['', '+count up'], ['zero', 'hold zero'], ['hide', 'hide']])} /></div>
              </div>
              <div><L>At zero, show</L><Input value={P('zero')} placeholder="e.g. HERE WE GO" onChange={(e) => onParam('zero', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" /></div>
            </>
          )}
        </>
      )}

      <div>
        <L>Entrance animation</L>
        <div className="grid grid-cols-3 gap-2.5">
          <div className="col-span-1"><Sel value={P('anim')} onChange={(v) => onParam('anim', v)} options={ANIM_OPTIONS} /></div>
          <div><Input type="number" min={0.1} step={0.1} value={P('animdur', '0.8')} onChange={(e) => onParam('animdur', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" title="duration (s)" /></div>
          <div><Input type="number" min={0} step={0.1} value={P('animdelay', '0')} onChange={(e) => onParam('animdelay', e.target.value)} className="h-8 bg-muted/40 text-[12.5px]" title="delay (s)" /></div>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">style · duration s · delay s — plays when the slide fires</div>
      </div>

      <div>
        <L>Rotation (°)</L>
        <div className="flex items-center gap-2">
          <input type="range" min={-180} max={180} step={1} value={element.r ?? 0}
            onChange={(e) => onGeom({ r: parseFloat(e.target.value) })}
            className="flex-1 accent-primary" />
          <Input type="number" step={1} value={element.r ?? 0}
            onChange={(e) => onGeom({ r: parseFloat(e.target.value) || 0 })}
            className="h-8 w-20 bg-muted/40 text-[12px] font-mono" />
        </div>
      </div>

      <div>
        <L>Position / size (%)</L>
        <div className="grid grid-cols-4 gap-2">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label key={k} className="block">
              <span className="text-[9px] uppercase text-muted-foreground">{k}</span>
              <Input type="number" step={0.25} value={element[k]}
                onChange={(e) => onGeom({ [k]: parseFloat(e.target.value) || 0 })}
                className="h-8 bg-muted/40 text-[12px] font-mono" />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
