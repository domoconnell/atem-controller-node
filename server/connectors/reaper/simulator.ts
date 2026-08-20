import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { SimulatorHandle } from '../core/types.js'
import { TRACK_FLAGS } from './protocol.js'

export interface SimulatedTrack {
  name: string
  recordArmed?: boolean
  muted?: boolean
  soloed?: boolean
  hasFx?: boolean
  folder?: boolean
  /** Last meter peak in dB; the wire carries it multiplied by ten. */
  peakDb?: number
}

/**
 * A fake REAPER speaking the real web remote. Tests drive it to reproduce the
 * things that actually happen at a festival: the record machine's transport
 * changes under someone else's hands, the laptop drops off the show network
 * mid-set, and a captive portal answers on port 8080 instead of REAPER.
 */
export class ReaperSimulator implements SimulatorHandle {
  /** Every action id the connector fired, in order, for tests to assert on. */
  readonly recordedActions: number[] = []

  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  private playState = 0
  private positionSeconds = 0
  private repeatOn = false
  private tracks: SimulatedTrack[] = [
    { name: 'Kick', recordArmed: true, peakDb: -12 },
    { name: 'Snare', recordArmed: true, peakDb: -9.5 },
    { name: 'Stereo Mix', recordArmed: true, peakDb: -6.2 },
  ]
  private extState = new Map<string, string>([['StageItLive/disk_free_mb', '512000']])

  private pendingFailures = 0
  private pendingGarbage = 0

  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      this.server = server

      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })

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
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Simulates the switch being rebooted: sockets die, the service stays up. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Simulates something that is not REAPER answering on REAPER's port. */
  sendGarbage(): void {
    this.pendingGarbage += 3
  }

  /**
   * The next `count` requests die without a reply, the way they do when the
   * record laptop leaves the show network. This is a transport failure, not an
   * HTTP error — it is what should take the instance offline.
   */
  failNextRequests(count: number): void {
    this.pendingFailures += count
  }

  /** REAPER's raw playstate code: 0 stopped, 1 playing, 2 paused, 5 recording, 6 record-paused. */
  setPlayState(state: number): void {
    this.playState = state
  }

  setPosition(seconds: number): void {
    this.positionSeconds = seconds
  }

  setRepeat(on: boolean): void {
    this.repeatOn = on
  }

  setTracks(tracks: SimulatedTrack[]): void {
    this.tracks = tracks
  }

  setDiskFreeMb(mb: number): void {
    this.extState.set('StageItLive/disk_free_mb', String(mb))
  }

  /** Simulates the bundled ReaScript not being loaded — a supported setup. */
  clearExtState(): void {
    this.extState.clear()
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.pendingFailures > 0) {
      this.pendingFailures -= 1
      req.socket.destroy()
      return
    }

    if (this.pendingGarbage > 0) {
      this.pendingGarbage -= 1
      this.send(res, 200, '<html><body>Guest network sign-in</body></html>\nTRANSPORT\tbanana\t?\n')
      return
    }

    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    if (!path.startsWith('/_/')) {
      this.send(res, 404, 'Not found')
      return
    }

    // REAPER takes a whole command list in one request; each is answered with
    // its own record, and commands it does not know are silently skipped.
    const commands = path.slice('/_/'.length).split(';').filter(Boolean)
    const lines: string[] = []

    for (const command of commands) {
      if (command === 'TRANSPORT') {
        lines.push(this.transportRecord())
        continue
      }
      if (command === 'NTRACK') {
        lines.push(`NTRACK\t${this.tracks.length}`)
        continue
      }
      if (command === 'TRACK') {
        lines.push(...this.tracks.map((track, index) => this.trackRecord(track, index + 1)))
        continue
      }
      if (command.startsWith('GET_EXTSTATE/')) {
        const [, section, key] = command.split('/')
        if (!section || !key) continue
        const value = this.extState.get(`${section}/${key}`)
        if (value !== undefined) lines.push(`EXTSTATE\t${section}\t${key}\t${value}`)
        continue
      }
      const action = Number(command)
      if (Number.isInteger(action)) this.runAction(action)
    }

    this.send(res, 200, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  }

  private runAction(action: number): void {
    this.recordedActions.push(action)
    if (action === 1013) this.playState = 5
    else if (action === 1016) this.playState = 0
    else if (action === 1007) this.playState = 1
  }

  private transportRecord(): string {
    return [
      'TRANSPORT',
      this.playState,
      this.positionSeconds.toFixed(6),
      this.repeatOn ? 1 : 0,
      formatPosition(this.positionSeconds),
      '1.1.00',
    ].join('\t')
  }

  private trackRecord(track: SimulatedTrack, number: number): string {
    let flags = 0
    if (track.folder) flags |= TRACK_FLAGS.folder
    if (track.hasFx) flags |= TRACK_FLAGS.hasFx
    if (track.muted) flags |= TRACK_FLAGS.muted
    if (track.soloed) flags |= TRACK_FLAGS.soloed
    if (track.recordArmed) flags |= TRACK_FLAGS.recordArmed

    // The wire carries meters as dB × 10, and REAPER pads every TRACK record
    // with fields we do not read — keeping them here proves the parser copes.
    const peak = Math.round((track.peakDb ?? -150) * 10)

    return ['TRACK', number, track.name, flags, '1.000000', '0.000000', peak, -1, '0', '0'].join(
      '\t',
    )
  }

  private send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  }
}

/** REAPER's `position_string`, e.g. `1:23.456`. */
function formatPosition(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}
