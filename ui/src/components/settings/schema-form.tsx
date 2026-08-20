'use client'
import { cn } from '@/lib/utils'

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonProp>
}
interface JsonProp {
  type?: string
  default?: unknown
  description?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
}

/** Auto-generates a config form from a connector's JSON Schema — one input per
 *  property, typed by the schema. No hand-written form per connector. */
export function SchemaForm({ schema, value, onChange }: {
  schema: JsonSchema | null | undefined
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const props = schema?.properties ?? {}
  const keys = Object.keys(props)
  if (keys.length === 0) return <p className="text-[12px] text-muted-foreground/60">No configurable options.</p>
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v })
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      {keys.map((k) => {
        const p = props[k]
        const cur = value[k] ?? p.default
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
        return (
          <label key={k} className={cn('flex flex-col gap-1', p.type === 'boolean' && 'sm:col-span-2 flex-row items-center gap-2')}>
            {p.type === 'boolean' ? (
              <>
                <input type="checkbox" checked={!!cur} onChange={(e) => set(k, e.target.checked)}
                  className="size-4 accent-[var(--live)]" />
                <span className="text-[12px] text-foreground/90">{label}</span>
                {p.description && <span className="text-[11px] text-muted-foreground/60">— {p.description}</span>}
              </>
            ) : Array.isArray(p.enum) ? (
              <>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
                <select value={String(cur ?? '')} onChange={(e) => set(k, e.target.value)}
                  className="bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-border">
                  {p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                </select>
              </>
            ) : (
              <>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
                <input
                  type={p.type === 'integer' || p.type === 'number' ? 'number' : 'text'}
                  value={cur === undefined || cur === null ? '' : String(cur)}
                  min={p.minimum} max={p.maximum}
                  onChange={(e) => set(k, p.type === 'integer' || p.type === 'number'
                    ? (e.target.value === '' ? undefined : Number(e.target.value))
                    : e.target.value)}
                  className="bg-input/40 border border-border rounded-md px-2 py-1.5 text-[13px] font-mono outline-none focus:border-border" />
                {p.description && <span className="text-[10.5px] text-muted-foreground/50 leading-snug">{p.description}</span>}
              </>
            )}
          </label>
        )
      })}
    </div>
  )
}
