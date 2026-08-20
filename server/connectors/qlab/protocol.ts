/**
 * QLab's OSC dialect: the shapes that come back inside a reply, and the
 * bookkeeping that turns a fire-and-forget OSC socket into request/response.
 *
 * QLab answers a query with an OSC message to `/reply` + the address you sent,
 * carrying a single JSON string. There is no request id in the protocol, so
 * correlation is by reply address, in order — which is exactly what
 * `ReplyCorrelator` does.
 */

/** The JSON body QLab puts in the single string argument of every reply. */
export interface QLabReply {
  status: string
  data?: unknown
  /** Present on real replies; QLab echoes the address without the workspace. */
  address?: string
  workspace_id?: string
}

export interface QLabWorkspace {
  id: string
  displayName: string
  version: string
}

export interface QLabCue {
  id: string
  number: string
  name: string
  type: string
}

export interface QLabRunningCue {
  id: string
  name: string
  elapsed: number
  remaining: number
  percent: number
}

/** QLab statuses we treat as "the passcode you sent is not good enough". */
export const QLAB_BAD_PASSCODE_STATUSES = ['badpass', 'denied', 'error:badpass'] as const

export function parseReplyBody(json: string): QLabReply | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  const status = typeof record.status === 'string' ? record.status : ''
  return {
    status,
    data: record.data,
    address: typeof record.address === 'string' ? record.address : undefined,
    workspace_id: typeof record.workspace_id === 'string' ? record.workspace_id : undefined,
  }
}

export function parseWorkspaces(data: unknown): QLabWorkspace[] {
  if (!Array.isArray(data)) return []
  const workspaces: QLabWorkspace[] = []

  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = asString(record.uniqueID)
    if (id === null) continue
    workspaces.push({
      id,
      displayName: asString(record.displayName) ?? 'Workspace',
      version: asString(record.version) ?? '',
    })
  }

  return workspaces
}

/**
 * Flattens the cue-list tree `/cueLists/shallow` returns.
 *
 * The cue list containers themselves are left out: nobody fires a cue list,
 * and a dashboard listing "Main Cue List" between two lighting cues just
 * costs the operator a line of screen space. Group cues are kept — they are
 * firable, and crew refer to them by number like any other cue.
 */
export function flattenCues(data: unknown): QLabCue[] {
  const cues: QLabCue[] = []
  if (!Array.isArray(data)) return cues

  for (const list of data) {
    collectCues(readCueChildren(list), cues)
  }

  return cues
}

/**
 * The ids of the cue lists themselves, which is what playhead queries and
 * `/update/.../playbackPosition` pushes are addressed by.
 */
export function parseCueListIds(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  const ids: string[] = []

  for (const list of data) {
    if (typeof list !== 'object' || list === null) continue
    const id = asString((list as Record<string, unknown>).uniqueID)
    if (id !== null) ids.push(id)
  }

  return ids
}

function collectCues(nodes: unknown[], out: QLabCue[]): void {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const record = node as Record<string, unknown>
    const id = asString(record.uniqueID)
    if (id === null) continue

    out.push({
      id,
      number: asString(record.number) ?? '',
      name: asString(record.listName) ?? asString(record.name) ?? '',
      type: asString(record.type) ?? '',
    })

    collectCues(readCueChildren(node), out)
  }
}

function readCueChildren(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const cues = (node as Record<string, unknown>).cues
  return Array.isArray(cues) ? cues : []
}

/** The id/name pairs `/runningOrPausedCues` returns, before timings are added. */
export function parseRunningCueStubs(data: unknown): { id: string; name: string }[] {
  if (!Array.isArray(data)) return []
  const stubs: { id: string; name: string }[] = []

  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = asString(record.uniqueID)
    if (id === null) continue
    stubs.push({ id, name: asString(record.listName) ?? asString(record.name) ?? '' })
  }

  return stubs
}

/** QLab answers numeric queries with a number, or a string holding one. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

interface PendingReply {
  resolve: (reply: QLabReply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One promise per outgoing query, keyed by the reply address QLab will use.
 *
 * Two queries to the same address (two running cues asking for their elapsed
 * time is the common case) are answered in the order they were sent, so the
 * waiters are a FIFO queue rather than a single slot.
 */
export class ReplyCorrelator {
  private readonly waiters = new Map<string, PendingReply[]>()

  get pendingCount(): number {
    let total = 0
    for (const queue of this.waiters.values()) total += queue.length
    return total
  }

  expect(replyAddress: string, timeoutMs: number): Promise<QLabReply> {
    return new Promise<QLabReply>((resolve, reject) => {
      const entry: PendingReply = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remove(replyAddress, entry)
          reject(new Error(`QLab did not answer ${replyAddress} within ${timeoutMs}ms`))
        }, timeoutMs),
      }

      const queue = this.waiters.get(replyAddress)
      if (queue) queue.push(entry)
      else this.waiters.set(replyAddress, [entry])
    })
  }

  /** Returns false when nothing was waiting — an unsolicited or late reply. */
  settle(replyAddress: string, reply: QLabReply): boolean {
    const queue = this.waiters.get(replyAddress)
    const entry = queue?.shift()
    if (!entry) return false
    if (queue?.length === 0) this.waiters.delete(replyAddress)

    clearTimeout(entry.timer)
    entry.resolve(reply)
    return true
  }

  /** Fails everything in flight; called when the socket goes away. */
  rejectAll(error: Error): void {
    for (const queue of this.waiters.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
    }
    this.waiters.clear()
  }

  private remove(replyAddress: string, entry: PendingReply): void {
    const queue = this.waiters.get(replyAddress)
    if (!queue) return
    const index = queue.indexOf(entry)
    if (index !== -1) queue.splice(index, 1)
    if (queue.length === 0) this.waiters.delete(replyAddress)
  }
}
