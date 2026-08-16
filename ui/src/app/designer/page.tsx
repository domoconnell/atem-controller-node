'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LayoutElement, TimerLayout, TimerInfo } from '@/lib/designer-types'
import { newElement, slug, type ElementType } from '@/lib/designer-types'
import { fetchLayouts, saveLayout, deleteLayout, fetchTimers } from '@/lib/api'
import { useAtemState } from '@/hooks/use-atem-state'
import { AppHeader } from '@/components/app-header'
import { ElementCanvas } from '@/components/designer/element-canvas'
import { ElementProps } from '@/components/designer/element-props'
import { LayersPanel } from '@/components/designer/layers-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Plus, Save, Trash2, Link2, Loader2, Clock, LayoutTemplate, Play, Type, Square, Circle as CircleIcon } from 'lucide-react'

export default function DesignerPage() {
  const [layouts, setLayouts] = useState<TimerLayout[]>([])
  const [current, setCurrent] = useState<TimerLayout | null>(null)
  const [saved, setSaved] = useState<string>('')          // JSON of last-saved state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [timers, setTimers] = useState<TimerInfo[]>([])
  const { state: liveState, connected: wsConnected, tick } = useAtemState()
  const ppConnected = liveState?.propresenter?.configured ? liveState.propresenter.connected : null
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    fetchLayouts().then((l) => {
      setLayouts(l)
      if (l.length && !current) load(l[0])
    })
    const timerPoll = () => fetchTimers().then((s) => {
      setTimers(s.timers as TimerInfo[])
    }).catch(() => {})
    timerPoll()
    const iv = setInterval(timerPoll, 5000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = (l: TimerLayout) => {
    setCurrent(structuredClone(l))
    setSaved(JSON.stringify(l))
    setSelectedId(null)
  }
  const dirty = current && JSON.stringify(current) !== saved

  const create = () => {
    const name = prompt('Layout name (this becomes its URL id):')
    if (!name?.trim()) return
    const l: TimerLayout = { id: slug(name), name: name.trim(), elements: [newElement()] }
    setCurrent(l)
    setSaved('')
    setSelectedId(l.elements[0].id)
  }

  const doSave = async () => {
    if (!current) return
    setSaving(true)
    try {
      await saveLayout(current)
      setSaved(JSON.stringify(current))
      setLayouts(await fetchLayouts())
    } catch (e) {
      alert((e as Error).message)
    }
    setSaving(false)
  }

  const doDelete = async () => {
    if (!current) return
    if (!confirm(`Delete layout '${current.name}'?`)) return
    await deleteLayout(current.id)
    const l = await fetchLayouts()
    setLayouts(l)
    setCurrent(null)
    if (l.length) load(l[0])
  }

  const layoutUrl = current ? `${typeof window !== 'undefined' ? window.location.origin : ''}/r/layout.html?id=${current.id}` : ''
  const copyUrl = () => {
    navigator.clipboard.writeText(layoutUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const patchElement = useCallback((id: string, patch: Partial<LayoutElement>) => {
    setCurrent((c) => c && ({ ...c, elements: c.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
  }, [])
  const selected = useMemo(() => current?.elements.find((e) => e.id === selectedId) ?? null, [current, selectedId])
  const selectedIndex = current && selected ? current.elements.indexOf(selected) : -1

  const deleteSelected = useCallback(() => {
    setCurrent((c) => c && selectedId ? { ...c, elements: c.elements.filter((e) => e.id !== selectedId) } : c)
    setSelectedId(null)
    setConfirmDelete(false)
  }, [selectedId])

  // Keyboard: Delete/Backspace removes (confirm dialog, Enter confirms);
  // Cmd/Ctrl+C copies the selected element, Cmd/Ctrl+V pastes it (works
  // across layouts — clipboard persists in localStorage). All ignored
  // while typing in a field.
  const pasteCount = useRef(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return

      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'c') {
        const sel = current?.elements.find((el) => el.id === selectedId)
        if (!sel) return
        e.preventDefault()
        localStorage.setItem('designer-clipboard', JSON.stringify(sel))
        pasteCount.current = 0
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        const raw = localStorage.getItem('designer-clipboard')
        if (!raw || !current) return
        e.preventDefault()
        try {
          const src = JSON.parse(raw) as LayoutElement
          pasteCount.current += 1
          const off = 3 * pasteCount.current
          const el: LayoutElement = {
            ...structuredClone(src),
            id: 'el-' + Math.random().toString(36).slice(2, 8),
            x: Math.min(90, src.x + off),
            y: Math.min(90, src.y + off),
          }
          setCurrent((c) => c && ({ ...c, elements: [...c.elements, el] }))
          setSelectedId(el.id)
        } catch { /* bad clipboard */ }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedId) return
        e.preventDefault()
        setConfirmDelete(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, current])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader app="timers" state={liveState} wsConnected={wsConnected} tick={tick}>
          <div className="ml-auto flex items-center gap-2">
            {current && (
              <>
                <Button size="sm" variant="ghost" className="h-8 text-[11px] font-mono text-muted-foreground" onClick={copyUrl} title="Copy the URL for the ProPresenter web object">
                  <Link2 className="size-3.5" /> {copied ? 'Copied!' : `/r/layout.html?id=${current.id}`}
                </Button>
                <Button size="sm" onClick={doSave} disabled={!dirty || saving} className="h-8 font-bold">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save{dirty ? '' : 'd'}
                </Button>
              </>
            )}
          </div>
        </AppHeader>

        <main className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)_300px] gap-4 p-4">
          {/* layouts rail */}
          <aside className="surface rounded-xl p-3 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Layouts</span>
              <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={create}><Plus className="size-3.5" /> New</Button>
            </div>
            <ScrollArea className="flex-1 min-h-0 -mr-2 pr-2">
              {layouts.map((l) => (
                <button key={l.id}
                  onClick={() => (dirty && !confirm('Discard unsaved changes?') ? null : load(l))}
                  className={cn(
                    'w-full text-left rounded-lg border px-2.5 py-2 mb-1.5 transition-colors',
                    current?.id === l.id ? 'border-primary bg-primary/10' : 'border-border bg-muted/30 hover:border-foreground/30'
                  )}>
                  <div className="text-[12.5px] font-semibold truncate">{l.name}</div>
                  <div className="text-[10.5px] text-muted-foreground">{l.elements.length} element{l.elements.length === 1 ? '' : 's'}{l.timer ? ` · ${l.timer}` : ''}</div>
                </button>
              ))}
              {layouts.length === 0 && (
                <div className="text-[11.5px] text-muted-foreground p-2">
                  <LayoutTemplate className="size-5 mb-1 opacity-50" />
                  No layouts yet. Create one, add elements, then paste its URL into a single ProPresenter web object.
                </div>
              )}
            </ScrollArea>
            {current && (
              <div className="pt-2 border-t border-border mt-2 space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1">Default timer</div>
                  <select value={current.timer ?? ''} onChange={(e) => setCurrent({ ...current, timer: e.target.value || undefined })}
                    className="h-8 w-full rounded-md border border-input bg-muted/40 px-2 text-[12px]">
                    <option value="">(first running)</option>
                    {timers.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                  </select>
                </div>
                <Button size="sm" variant="ghost" className="h-7 w-full text-[11px] text-destructive" onClick={doDelete}>
                  <Trash2 className="size-3.5" /> Delete layout
                </Button>
              </div>
            )}
          </aside>

          {/* canvas */}
          <section className="min-w-0 flex flex-col gap-3">
            {current ? (
              <>
                <div className="flex items-center gap-2">
                  <Input value={current.name}
                    onChange={(e) => setCurrent({ ...current, name: e.target.value })}
                    className="h-8 w-64 bg-muted/40 text-[13px] font-semibold" />
                  <span className="text-[11px] text-muted-foreground font-mono">id: {current.id}</span>
                  <Button size="sm" variant="ghost" className="h-8 ml-auto text-[11px]"
                    onClick={() => setReplayKey((k) => k + 1)} title="Replay entrance animations">
                    <Play className="size-3.5" /> Replay anims
                  </Button>
                  <div className="relative">
                    <Button size="sm" variant="secondary" className="h-8 text-[11px] font-bold" onClick={() => setAddOpen((o) => !o)}>
                      <Plus className="size-3.5" /> Add element
                    </Button>
                    {addOpen && (
                      <div className="absolute right-0 top-full mt-1 z-40 w-40 rounded-md border border-border bg-popover shadow-xl p-1"
                        onMouseLeave={() => setAddOpen(false)}>
                        {([['timer', 'Timer', Clock], ['text', 'Text', Type], ['rect', 'Rectangle', Square], ['ellipse', 'Ellipse', CircleIcon]] as const).map(([t, label, Icon]) => (
                          <button key={t}
                            onClick={() => {
                              const el = newElement(t as ElementType)
                              setCurrent({ ...current, elements: [...current.elements, el] })
                              setSelectedId(el.id)
                              setAddOpen(false)
                            }}
                            className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-accent">
                            <Icon className="size-3.5 text-muted-foreground" /> {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <ElementCanvas
                  elements={current.elements}
                  layoutTimer={current.timer}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChange={patchElement}
                  replayKey={replayKey}
                />
                <div className="text-[11px] text-muted-foreground px-1">
                  Drag to move · corner handle to resize · the checkerboard is transparent in ProPresenter.
                  Elements render live from {ppConnected ? 'ProPresenter' : 'the demo timer'}.
                </div>
              </>
            ) : (
              <div className="flex-1 surface rounded-xl grid place-items-center text-muted-foreground text-[13px]">
                Create or select a layout to start designing.
              </div>
            )}
          </section>

          {/* properties */}
          <aside className="surface rounded-xl p-3.5 min-h-0 overflow-y-auto space-y-4">
            {current && (
              <LayersPanel
                elements={current.elements}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onReorder={(from, to) => {
                  const els = [...current.elements]
                  const [moved] = els.splice(from, 1)
                  els.splice(to, 0, moved)
                  setCurrent({ ...current, elements: els })
                }}
              />
            )}
            {current && selected && <div className="h-px bg-border" />}
            {selected && current ? (
              <div key={selected.id} className="animate-in slide-in-from-right-4 fade-in duration-200">
              <ElementProps
                element={selected}
                timers={timers}
                index={selectedIndex}
                count={current.elements.length}
                onParam={(k, v) => patchElement(selected.id, { params: { ...selected.params, [k]: v || undefined } })}
                onGeom={(patch) => patchElement(selected.id, patch)}
                onDelete={() => setConfirmDelete(true)}
                onDuplicate={() => {
                  const copy = { ...structuredClone(selected), id: 'el-' + Math.random().toString(36).slice(2, 8), x: selected.x + 4, y: selected.y + 4 }
                  setCurrent({ ...current, elements: [...current.elements, copy] })
                  setSelectedId(copy.id)
                }}
                onReorder={(dir) => {
                  const els = [...current.elements]
                  const i = els.indexOf(selected)
                  const j = i + dir
                  if (j < 0 || j >= els.length) return
                  ;[els[i], els[j]] = [els[j], els[i]]
                  setCurrent({ ...current, elements: els })
                }}
              />
              </div>
            ) : (
              <div className="text-[12px] text-muted-foreground p-2">
                Select an element on the canvas or in Layers to edit it.
              </div>
            )}
          </aside>
        </main>

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent
            className="sm:max-w-[380px] bg-background border-border"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); deleteSelected() } }}
          >
            <DialogHeader>
              <DialogTitle>Delete element?</DialogTitle>
              <DialogDescription>
                {selected ? `Element ${selectedIndex + 1} (${selected.params.part ?? 'time'}) will be removed from the layout.` : ''}
                {' '}Enter confirms · Esc cancels.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="destructive" autoFocus onClick={deleteSelected}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
