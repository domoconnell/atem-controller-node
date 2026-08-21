import { EventEmitter } from 'node:events'
import net from 'node:net'
import { config } from './config.js'
import { wire, short } from './wire.js'

/**
 * Minimal client for the Blackmagic HyperDeck Ethernet protocol (TCP 9993).
 * Text-based: commands end with \n; responses are "<code> <text>" optionally
 * followed by "key: value" lines and a blank line. 5xx codes are async
 * notifications (we subscribe to transport updates).
 *
 * Emits: 'connected', 'disconnected', 'transport' (parsed transport info)
 */
export class HyperDeck extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.connected = false
    this.transport = {} // last known transport info: status, clip id, speed...
    this._buffer = ''
    this._queue = [] // pending {resolve, reject} for commands in flight
    this._reconnectTimer = null
    // Runtime config: seeded from config.json, overridable from the Settings UI
    // via reconfigure() (the SQLite instance is the live source of truth).
    this.cfg = { ...config.hyperdeck }
  }

  /** Apply new connection settings (e.g. an IP change in Settings) and reconnect
   *  to the new target immediately, dropping the old connection. */
  reconfigure(patch = {}) {
    this.cfg = { ...this.cfg, ...patch }
    this._clearReconnect()
    const was = this.connected
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null }
    this.connected = false
    this.transport = {}
    if (was) this.emit('disconnected')
    this.connect()
  }

  connect() {
    this._clearReconnect()
    const { ip, port } = this.cfg
    this.socket = net.createConnection({ host: ip, port: port ?? 9993 })
    this.socket.setNoDelay(true)

    this.socket.on('connect', () => {
      this.connected = true
      console.log('[hyperdeck] connected to', ip)
      this.emit('connected')
      // Ask for transport notifications and an initial status.
      this.send('notify: transport: true').catch(() => {})
      this.send('transport info').catch(() => {})
    })
    this.socket.on('data', (d) => this._onData(d.toString('utf8')))
    this.socket.on('error', (e) => console.error('[hyperdeck] error:', e.message))
    this.socket.on('close', () => {
      if (this.connected) console.log('[hyperdeck] disconnected')
      this.connected = false
      this.emit('disconnected')
      for (const p of this._queue.splice(0)) p.reject(new Error('HyperDeck disconnected'))
      this._reconnectTimer = setTimeout(() => this.connect(), 3000)
    })
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _onData(chunk) {
    this._buffer += chunk
    // Responses with a name ending in ':' are multi-line, terminated by a
    // blank line. Single-line responses end at the newline.
    while (true) {
      const nl = this._buffer.indexOf('\n')
      if (nl === -1) return
      const firstLine = this._buffer.slice(0, nl).replace(/\r$/, '')
      const isMultiline = firstLine.endsWith(':')
      let raw, rest
      if (isMultiline) {
        const end = this._buffer.indexOf('\n\n')
        const endCrlf = this._buffer.indexOf('\r\n\r\n')
        const idx = endCrlf !== -1 && (end === -1 || endCrlf < end) ? endCrlf : end
        if (idx === -1) return // wait for the full block
        raw = this._buffer.slice(0, idx)
        rest = this._buffer.slice(idx + (idx === endCrlf ? 4 : 2))
      } else {
        raw = firstLine
        rest = this._buffer.slice(nl + 1)
      }
      this._buffer = rest
      this._handleMessage(raw)
    }
  }

  _handleMessage(raw) {
    const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''))
    const m = lines[0].match(/^(\d{3}) (.*)$/)
    if (!m) return
    const code = Number(m[1])
    const name = m[2].replace(/:$/, '')
    wire('rx', 'hyperdeck', `${code} ${name}`)
    const params = {}
    for (const line of lines.slice(1)) {
      const i = line.indexOf(': ')
      if (i !== -1) params[line.slice(0, i)] = line.slice(i + 2)
    }

    if (code >= 500) {
      // Async notification (or the connection banner).
      if (name === 'transport info') {
        this.transport = { ...this.transport, ...params }
        this.emit('transport', this.transport)
      }
      return
    }

    const pending = this._queue.shift()
    if (!pending) return
    if (code >= 200 && code < 300) {
      if (name === 'transport info') {
        this.transport = { ...this.transport, ...params }
        this.emit('transport', this.transport)
      }
      pending.resolve({ code, name, params })
    } else {
      pending.reject(new Error(`HyperDeck: ${code} ${name}`))
    }
  }

  send(command) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('HyperDeck not connected'))
      }
      this._queue.push({ resolve, reject })
      wire('tx', 'hyperdeck', command)
      this.socket.write(command + '\n')
    })
  }

  /** Step interface used by the sequencer and OSC layer. */
  async command(step) {
    switch (step.command) {
      case 'play': {
        let cmd = 'play'
        const opts = []
        if (step.loop !== undefined) opts.push(`loop: ${step.loop}`)
        if (step.singleClip !== undefined) opts.push(`single clip: ${step.singleClip}`)
        if (step.speed !== undefined) opts.push(`speed: ${step.speed}`)
        if (opts.length) cmd += ': ' + opts.join(' ')
        await this.send(cmd)
        break
      }
      case 'stop':
        await this.send('stop')
        break
      case 'gotoClip':
        await this.send(`goto: clip id: ${step.clip}`)
        break
      case 'nextClip':
        await this.send('goto: clip id: +1')
        break
      case 'prevClip':
        await this.send('goto: clip id: -1')
        break
      case 'raw':
        await this.send(step.raw)
        break
      default:
        throw new Error(`Unknown hyperdeck command '${step.command}'`)
    }
  }

  snapshot() {
    return { connected: this.connected, transport: this.transport }
  }
}
