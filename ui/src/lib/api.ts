// Command + query layer. Everything goes through the express server that
// also serves this UI, so relative URLs work in prod (Pi) and via the dev
// proxy.

import type { Plan } from './types'

export async function cmd(address: string, args: unknown[] = []): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, args }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: body.error || `HTTP ${r.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function fetchPlan(look: string): Promise<Plan> {
  const r = await fetch('/api/plan/' + encodeURIComponent(look))
  return r.json()
}

export function wsUrl(): string {
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
  // In `next dev` the page is on :3001 but the service is on :3000.
  const host = window.location.port === '3001' ? window.location.hostname + ':3000' : window.location.host
  return proto + host
}

// ---- timer layouts (designer) ----
import type { TimerLayout } from './designer-types'

export async function fetchLayouts(): Promise<TimerLayout[]> {
  const r = await fetch('/api/layouts')
  const b = await r.json()
  return b.layouts ?? []
}
export async function saveLayout(layout: TimerLayout): Promise<void> {
  const r = await fetch('/api/layouts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'save failed')
}
export async function deleteLayout(id: string): Promise<void> {
  await fetch('/api/layouts/' + encodeURIComponent(id), { method: 'DELETE' })
}
export async function fetchTimers(): Promise<{ configured: boolean; connected: boolean; timers: { name: string; state: string; duration: number | null }[] }> {
  const r = await fetch('/api/timers')
  return r.json()
}
