import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { config, projectRoot } from './config.js'

/**
 * Status web UI: express serves public/, a WebSocket pushes the full status
 * snapshot (throttled), and POST /api/command reuses the OSC command router
 * so the UI buttons behave identically to Companion presses.
 */
export class WebServer {
  constructor({ atem, animator, looks, sequencer, hyperdeck, oscServer, engine }) {
    this.atem = atem
    this.animator = animator
    this.looks = looks
    this.sequencer = sequencer
    this.hyperdeck = hyperdeck
    this.oscServer = oscServer
    this.engine = engine

    const app = express()
    app.use(express.json())
    app.use(express.static(path.join(projectRoot, 'public')))

    app.get('/api/status', (_req, res) => res.json(this.snapshot()))
    // Dry-run: what would the engine do to reach this look from live state?
    app.get('/api/plan/:look', (req, res) => {
      try {
        const look = this.looks.mustGet(req.params.look)
        res.json({ ok: true, ...this.engine.plan(look) })
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message })
      }
    })
    app.post('/api/command', async (req, res) => {
      const { address, args } = req.body ?? {}
      try {
        await this.oscServer.handle(address, args ?? [])
        res.json({ ok: true })
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message })
      }
    })

    this.server = http.createServer(app)
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify(this.snapshot()))
    })

    // Broadcast on any interesting change, throttled to ~10Hz so SuperSource
    // animations don't flood clients.
    this._dirty = false
    this._throttle = null
    const markDirty = () => this.scheduleBroadcast()
    atem.on('stateChanged', markDirty)
    atem.on('connected', markDirty)
    atem.on('disconnected', markDirty)
    hyperdeck.on('connected', markDirty)
    hyperdeck.on('disconnected', markDirty)
    hyperdeck.on('transport', markDirty)
    looks.on('changed', markDirty)
    looks.on('current', markDirty)
    sequencer.on('busy', markDirty)
    sequencer.on('idle', markDirty)
    sequencer.on('step', markDirty)
    animator.on('start', markDirty)
    animator.on('done', markDirty)
    animator.on('cancelled', markDirty)
  }

  start() {
    this.server.listen(config.web.port, () =>
      console.log(`[web] status UI on http://0.0.0.0:${config.web.port}`)
    )
  }

  scheduleBroadcast() {
    if (this._throttle) {
      this._dirty = true
      return
    }
    this.broadcast()
    this._throttle = setTimeout(() => {
      this._throttle = null
      if (this._dirty) {
        this._dirty = false
        this.scheduleBroadcast()
      }
    }, 100)
  }

  broadcast() {
    const payload = JSON.stringify(this.snapshot())
    for (const client of this.wss.clients) {
      if (client.readyState === 1) client.send(payload)
    }
  }

  snapshot() {
    return {
      atem: this.atem.snapshot(),
      hyperdeck: this.hyperdeck.snapshot(),
      currentLook: this.looks.currentLook,
      looks: this.looks.list(),
      macros: this.sequencer.list().map((m) => ({ name: m.name, from: m.from, to: m.to })),
      busy: this.sequencer.current,
      animating: this.animator.running,
      mainMe: this.atem.me,
    }
  }
}
