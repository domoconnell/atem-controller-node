import { createServer, type Server, type Socket } from 'node:net'
import {
  decodeOscMessage,
  encodeOscMessage,
  type OscMessage,
  SLIP_END,
  SlipDecoder,
  slipEncode,
} from '../../lib/osc.js'
import type { SimulatorHandle } from '../core/types.js'

export interface QLabSimulatorCue {
  id: string
  number?: string
  name?: string
  type?: string
  /** Seconds the cue runs for; drives elapsed and percent while it plays. */
  duration?: number
  /** Group cues have children, and the connector has to flatten them. */
  cues?: QLabSimulatorCue[]
}

export interface QLabSimulatorWorkspaceOptions {
  id: string
  displayName?: string
  version?: string
}

export interface QLabSimulatorOptions {
  /** More than one exercises workspace selection; the default is the usual case. */
  workspaces?: QLabSimulatorWorkspaceOptions[]
}

interface RunningCue {
  elapsed: number
  duration: number
  paused: boolean
}

interface WorkspaceState {
  id: string
  displayName: string
  version: string
  cueListId: string
  cues: QLabSimulatorCue[]
  playheadId: string | null
  running: Map<string, RunningCue>
}

interface ClientState {
  decoder: SlipDecoder
  authenticated: boolean
  updates: boolean
}

const DEFAULT_CUES: QLabSimulatorCue[] = [
  { id: 'cue-1', number: '1', name: 'House to half', type: 'Light', duration: 3 },
  {
    id: 'cue-2',
    number: '2',
    name: 'Walk-in music',
    type: 'Group',
    duration: 10,
    cues: [{ id: 'cue-2.1', number: '2.1', name: 'Bed loop', type: 'Audio', duration: 10 }],
  },
  { id: 'cue-3', number: '3', name: 'Band intro video', type: 'Video', duration: 30 },
]

/**
 * A fake QLab speaking real OSC over real SLIP on a real socket.
 *
 * Everything a show throws at the connector is scriptable from a test: a
 * passcode nobody told the operator about, a workspace that is not the first
 * one in the list, cues that run and elapse, and a laptop that vanishes when
 * someone trips over the network cable.
 */
export class QLabSimulator implements SimulatorHandle {
  private server: Server | null = null
  private readonly clients = new Map<Socket, ClientState>()
  private readonly workspaces: WorkspaceState[]
  private passcode: string | null = null
  private cueQueries = 0

  constructor(options: QLabSimulatorOptions = {}) {
    const declared = options.workspaces ?? [{ id: 'ws-1', displayName: 'Main Show' }]
    this.workspaces = declared.map((workspace) => ({
      id: workspace.id,
      displayName: workspace.displayName ?? 'Workspace',
      version: workspace.version ?? '5.4.4',
      cueListId: `${workspace.id}-list`,
      cues: DEFAULT_CUES,
      playheadId: DEFAULT_CUES[0]?.id ?? null,
      running: new Map(),
    }))
  }

  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      this.server = server

      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('simulator failed to bind'))
          return
        }
        resolve({ host: address.address, port: address.port })
      })
    })
  }

  async close(): Promise<void> {
    for (const socket of this.clients.keys()) socket.destroy()
    this.clients.clear()

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Simulates the show laptop dropping off the network mid-set. */
  dropConnections(): void {
    for (const socket of this.clients.keys()) socket.destroy()
    this.clients.clear()
  }

  /** Everything a parser must survive: junk, valid OSC with a broken body. */
  sendGarbage(): void {
    for (const socket of this.clients.keys()) {
      if (socket.destroyed) continue
      socket.write(Buffer.concat([Buffer.from('this is not an OSC packet'), Buffer.of(SLIP_END)]))
      socket.write(
        slipEncode(encodeOscMessage('/reply/workspaces', [{ type: 's', value: '{not json' }])),
      )
      socket.write(
        slipEncode(
          encodeOscMessage('/update/workspace/ghost/cueList/ghost/playbackPosition', [
            { type: 's', value: 'cue-from-another-show' },
          ]),
        ),
      )
      // Three bytes cannot be a 4-byte-aligned OSC packet.
      socket.write(slipEncode(Buffer.from([0x2f, 0x01, 0x02])))
    }
  }

  setCues(cues: QLabSimulatorCue[], workspaceId?: string): void {
    const workspace = this.workspace(workspaceId)
    workspace.cues = cues
    workspace.playheadId = flatten(cues)[0]?.id ?? null
  }

  /** Starts a cue running and moves the playhead onto it, as a Go would. */
  startCue(id: string, workspaceId?: string): void {
    const workspace = this.workspace(workspaceId)
    const cue = flatten(workspace.cues).find((entry) => entry.id === id)
    if (!cue) throw new Error(`simulator has no cue ${id}`)

    workspace.running.set(cue.id, { elapsed: 0, duration: cue.duration ?? 10, paused: false })
    this.movePlayhead(workspace, cue.id)
  }

  /** Moves show time forward deterministically, so tests never sleep. */
  advance(seconds: number, workspaceId?: string): void {
    const workspace = this.workspace(workspaceId)
    for (const running of workspace.running.values()) {
      if (running.paused) continue
      running.elapsed = Math.min(running.duration, running.elapsed + seconds)
    }
  }

  /** null clears it; anything else makes every workspace command need it. */
  setPasscodeRequired(passcode: string | null): void {
    this.passcode = passcode
    for (const state of this.clients.values()) state.authenticated = passcode === null
  }

  get connectionCount(): number {
    return this.clients.size
  }

  /**
   * How many per-cue queries the connector has issued. A show file can hold
   * thousands of cues, so a test can prove the connector only ever asks about
   * the ones that are running.
   */
  get cueQueryCount(): number {
    return this.cueQueries
  }

  // ------------------------------------------------------------------ internals

  private handleConnection(socket: Socket): void {
    const state: ClientState = {
      decoder: new SlipDecoder(),
      authenticated: this.passcode === null,
      updates: false,
    }
    this.clients.set(socket, state)
    socket.setNoDelay(true)

    socket.on('close', () => this.clients.delete(socket))
    socket.on('error', () => this.clients.delete(socket))
    socket.on('data', (chunk: Buffer) => {
      for (const packet of state.decoder.push(chunk)) {
        const message = decodeOscMessage(packet)
        if (message) this.handleMessage(socket, state, message)
      }
    })
  }

  private handleMessage(socket: Socket, state: ClientState, message: OscMessage): void {
    const { address } = message

    if (address === '/workspaces') {
      this.reply(socket, address, 'ok', {
        data: this.workspaces.map((workspace) => ({
          uniqueID: workspace.id,
          displayName: workspace.displayName,
          version: workspace.version,
        })),
      })
      return
    }

    const cueQuery = /^\/cue_id\/([^/]+)\/(actionElapsed|percentActionElapsed|name)$/.exec(address)
    if (cueQuery) {
      this.handleCueQuery(socket, state, address, cueQuery[1] ?? '', cueQuery[2] ?? '')
      return
    }

    const workspaceMatch = /^\/workspace\/([^/]+)\/(.+)$/.exec(address)
    if (!workspaceMatch) {
      this.reply(socket, address, 'error')
      return
    }

    const workspace = this.workspaces.find((entry) => entry.id === workspaceMatch[1])
    if (!workspace) {
      this.reply(socket, address, 'error')
      return
    }
    const rest = workspaceMatch[2] ?? ''

    if (rest.startsWith('connect')) {
      const supplied = message.args.find((arg) => arg.type === 's')
      const ok =
        this.passcode === null || (supplied?.type === 's' && supplied.value === this.passcode)
      state.authenticated = ok
      this.reply(socket, address, ok ? 'ok' : 'badpass', ok ? { data: 'ok' } : {})
      return
    }

    // Real QLab answers every workspace-scoped message with badpass until the
    // client has connected with a good passcode.
    if (!state.authenticated) {
      this.reply(socket, address, 'badpass')
      return
    }

    if (rest.startsWith('updates')) {
      state.updates = message.args.some((arg) => arg.type === 'i' && arg.value === 1)
      this.reply(socket, address, 'ok')
      return
    }

    if (rest === 'cueLists/shallow') {
      this.reply(socket, address, 'ok', {
        data: [
          {
            uniqueID: workspace.cueListId,
            number: '',
            name: `${workspace.displayName} Cue List`,
            type: 'Cue List',
            cues: workspace.cues.map(serialiseCue),
          },
        ],
      })
      return
    }

    const playhead = /^cueList\/([^/]+)\/playheadId$/.exec(rest)
    if (playhead) {
      this.reply(socket, address, 'ok', { data: workspace.playheadId ?? '' })
      return
    }

    if (rest === 'runningOrPausedCues') {
      const flat = flatten(workspace.cues)
      this.reply(socket, address, 'ok', {
        data: [...workspace.running.keys()].map((id) => ({
          uniqueID: id,
          number: flat.find((cue) => cue.id === id)?.number ?? '',
          listName: flat.find((cue) => cue.id === id)?.name ?? '',
        })),
      })
      return
    }

    if (
      rest === 'go' ||
      rest === 'stop' ||
      rest === 'pause' ||
      rest === 'resume' ||
      rest === 'panic'
    ) {
      this.applyTransport(workspace, rest)
      this.reply(socket, address, 'ok')
      return
    }

    this.reply(socket, address, 'error')
  }

  private handleCueQuery(
    socket: Socket,
    state: ClientState,
    address: string,
    cueId: string,
    field: string,
  ): void {
    this.cueQueries += 1

    if (!state.authenticated) {
      this.reply(socket, address, 'badpass')
      return
    }

    const workspace =
      this.workspaces.find((entry) => entry.running.has(cueId)) ??
      this.workspaces.find((entry) => flatten(entry.cues).some((cue) => cue.id === cueId)) ??
      this.workspaces[0]
    if (!workspace) {
      this.reply(socket, address, 'error')
      return
    }

    if (field === 'name') {
      const cue = flatten(workspace.cues).find((entry) => entry.id === cueId)
      this.reply(socket, address, cue ? 'ok' : 'error', cue ? { data: cue.name } : {})
      return
    }

    const running = workspace.running.get(cueId)
    if (!running) {
      this.reply(socket, address, 'ok', { data: 0 })
      return
    }

    const value =
      field === 'actionElapsed'
        ? running.elapsed
        : running.duration > 0
          ? running.elapsed / running.duration
          : 0
    this.reply(socket, address, 'ok', { data: value })
  }

  private applyTransport(workspace: WorkspaceState, command: string): void {
    const flat = flatten(workspace.cues)

    switch (command) {
      case 'go': {
        const index = flat.findIndex((cue) => cue.id === workspace.playheadId)
        const cue = index === -1 ? flat[0] : flat[index]
        if (!cue) return
        workspace.running.set(cue.id, {
          elapsed: 0,
          duration: cue.duration ?? 10,
          paused: false,
        })
        // Go leaves the playhead on the next cue, which is what a real
        // operator sees on the QLab window after pressing the space bar.
        this.movePlayhead(workspace, flat[index + 1]?.id ?? cue.id)
        break
      }
      case 'stop':
      case 'panic':
        workspace.running.clear()
        break
      case 'pause':
        for (const running of workspace.running.values()) running.paused = true
        break
      case 'resume':
        for (const running of workspace.running.values()) running.paused = false
        break
      default:
        break
    }
  }

  private movePlayhead(workspace: WorkspaceState, cueId: string | null): void {
    workspace.playheadId = cueId
    const message = encodeOscMessage(
      `/update/workspace/${workspace.id}/cueList/${workspace.cueListId}/playbackPosition`,
      [{ type: 's', value: cueId ?? '' }],
    )

    for (const [socket, state] of this.clients) {
      if (!state.updates || socket.destroyed) continue
      socket.write(slipEncode(message))
    }
  }

  private reply(
    socket: Socket,
    address: string,
    status: string,
    extra: { data?: unknown } = {},
  ): void {
    if (socket.destroyed) return

    const body: Record<string, unknown> = {
      status,
      // Real QLab echoes the address with the workspace prefix stripped.
      address: address.replace(/^\/workspace\/[^/]+/, ''),
    }
    if ('data' in extra) body.data = extra.data

    socket.write(
      slipEncode(
        encodeOscMessage(`/reply${address}`, [{ type: 's', value: JSON.stringify(body) }]),
      ),
    )
  }

  private workspace(workspaceId?: string): WorkspaceState {
    const workspace = workspaceId
      ? this.workspaces.find((entry) => entry.id === workspaceId)
      : this.workspaces[0]
    if (!workspace) throw new Error(`simulator has no workspace ${workspaceId}`)
    return workspace
  }
}

function serialiseCue(cue: QLabSimulatorCue): Record<string, unknown> {
  return {
    uniqueID: cue.id,
    number: cue.number ?? '',
    listName: cue.name ?? '',
    type: cue.type ?? 'Memo',
    ...(cue.cues ? { cues: cue.cues.map(serialiseCue) } : {}),
  }
}

function flatten(cues: QLabSimulatorCue[]): QLabSimulatorCue[] {
  const out: QLabSimulatorCue[] = []
  for (const cue of cues) {
    out.push(cue)
    if (cue.cues) out.push(...flatten(cue.cues))
  }
  return out
}
