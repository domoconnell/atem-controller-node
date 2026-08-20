import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { config, projectRoot, configPath, applyConfigUpdate } from './config.js'
import { Simulator } from './simulator.js'
import { wireBus, wireHistory } from './wire.js'

/**
 * Status web UI: express serves public/, a WebSocket pushes the full status
 * snapshot (throttled), and POST /api/command reuses the OSC command router
 * so the UI buttons behave identically to Companion presses.
 */
export class WebServer {
  constructor({ atem, animator, looks, sequencer, hyperdeck, oscServer, engine, propresenter, verifier, sennheiser, connectorEngine, store }) {
    this.atem = atem
    this.animator = animator
    this.looks = looks
    this.sequencer = sequencer
    this.hyperdeck = hyperdeck
    this.oscServer = oscServer
    this.engine = engine
    this.propresenter = propresenter
    this.verifier = verifier
    this.sennheiser = sennheiser
    this.connectorEngine = connectorEngine
    this.store = store

    const app = express()
    app.use(express.json())
    app.use(express.static(path.join(projectRoot, 'public')))

    // Countdown renderer pages (and the ProPresenter transparency test).
    app.use('/r', express.static(path.join(projectRoot, 'renderer')))
    app.get('/transparency-test', (_req, res) =>
      res.sendFile(path.join(projectRoot, 'renderer', 'transparency-test.html'))
    )
    app.get('/acceptance', (_req, res) => {
      res.sendFile(path.join(projectRoot, 'public', 'acceptance.html'), (err) => {
        if (err) res.sendFile(path.join(projectRoot, 'public', 'acceptance', 'index.html'))
      })
    })
    app.get('/designer', (_req, res) => {
      res.sendFile(path.join(projectRoot, 'public', 'designer.html'), (err) => {
        if (err) res.sendFile(path.join(projectRoot, 'public', 'designer', 'index.html'))
      })
    })
    app.get('/mics', (_req, res) => {
      res.sendFile(path.join(projectRoot, 'public', 'mics.html'), (err) => {
        if (err) res.sendFile(path.join(projectRoot, 'public', 'mics', 'index.html'))
      })
    })
    for (const route of ['atem', 'surfaces', 'settings']) {
      app.get(`/${route}`, (_req, res) => {
        res.sendFile(path.join(projectRoot, 'public', `${route}.html`), (err) => {
          if (err) res.sendFile(path.join(projectRoot, 'public', route, 'index.html'))
        })
      })
    }
    app.get('/api/mics', (_req, res) => res.json(this.sennheiser?.snapshot() ?? { enabled: false }))

    // ---- Connector engine (unified backend): instances + catalogue + commands ----
    app.get('/api/connector-types', (_req, res) => res.json({ ok: true, types: this.connectorEngine?.catalogue() ?? [] }))
    app.get('/api/instances', (_req, res) => res.json({ ok: true, instances: this.connectorEngine?.listInstances() ?? [] }))
    app.post('/api/instances', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      const b = req.body ?? {}
      if (!b.typeId || !b.name) return res.status(400).json({ ok: false, error: 'typeId and name required' })
      const inst = this.store.createInstance({ typeId: b.typeId, name: b.name, config: b.config ?? {}, enabled: b.enabled !== false, allowControl: !!b.allowControl, simulate: !!b.simulate })
      await this.connectorEngine?.reconcile(inst.id)
      res.json({ ok: true, instance: inst })
    })
    app.patch('/api/instances/:id', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      this.store.updateInstance(req.params.id, req.body ?? {})
      await this.connectorEngine?.reconcile(req.params.id)
      res.json({ ok: true, instance: this.store.getInstance(req.params.id) })
    })
    app.delete('/api/instances/:id', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      this.store.deleteInstance(req.params.id)
      await this.connectorEngine?.reconcile(req.params.id)
      res.json({ ok: true })
    })
    app.post('/api/instances/:id/commands/:command', async (req, res) => {
      if (!this.connectorEngine) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      const result = await this.connectorEngine.command(req.params.id, req.params.command, req.body?.input)
      res.status(result.ok ? 200 : 400).json(result)
    })

    app.get('/api/status', (_req, res) => res.json(this.snapshot()))

    // ---- Renderer presets (bookmarks for the /r/ builder) ---------------
    const presetsFile = path.join(projectRoot, 'data', 'renderer-presets.json')
    const loadPresets = () => {
      try { return JSON.parse(readFileSync(presetsFile, 'utf8')) } catch { return [] }
    }
    const savePresets = (list) => {
      mkdirSync(path.join(projectRoot, 'data'), { recursive: true })
      writeFileSync(presetsFile, JSON.stringify(list, null, 2) + '\n')
    }
    app.get('/api/renderer-presets', (_req, res) => res.json({ ok: true, presets: loadPresets() }))
    app.post('/api/renderer-presets', (req, res) => {
      const { name, query } = req.body ?? {}
      if (!name || typeof query !== 'string') return res.status(400).json({ ok: false, error: 'name and query required' })
      const list = loadPresets().filter((p) => p.name !== name)
      list.push({ name: String(name).trim(), query, savedAt: new Date().toISOString() })
      list.sort((a, b) => a.name.localeCompare(b.name))
      savePresets(list)
      res.json({ ok: true, presets: list })
    })
    app.delete('/api/renderer-presets/:name', (req, res) => {
      const list = loadPresets().filter((p) => p.name !== req.params.name)
      savePresets(list)
      res.json({ ok: true, presets: list })
    })

    // ---- Timer layouts (full-frame designs for ProPresenter) -----------
    const layoutsFile = path.join(projectRoot, 'data', 'timer-layouts.json')
    const loadLayouts = () => {
      try { return JSON.parse(readFileSync(layoutsFile, 'utf8')) } catch { return [] }
    }
    const saveLayouts = (list) => {
      mkdirSync(path.join(projectRoot, 'data'), { recursive: true })
      writeFileSync(layoutsFile, JSON.stringify(list, null, 2) + '\n')
    }
    app.get('/api/layouts', (_req, res) => res.json({ ok: true, layouts: loadLayouts() }))
    app.get('/api/layouts/:id', (req, res) => {
      const layout = loadLayouts().find((l) => l.id === req.params.id)
      if (!layout) return res.status(404).json({ ok: false, error: `No layout '${req.params.id}'` })
      res.json({ ok: true, layout })
    })
    app.post('/api/layouts', (req, res) => {
      const layout = req.body
      if (!layout?.id || !layout?.name || !Array.isArray(layout.elements)) {
        return res.status(400).json({ ok: false, error: 'id, name and elements[] required' })
      }
      const list = loadLayouts().filter((l) => l.id !== layout.id)
      list.push({ ...layout, updatedAt: new Date().toISOString() })
      list.sort((a, b) => a.name.localeCompare(b.name))
      saveLayouts(list)
      res.json({ ok: true, layouts: list })
    })
    app.delete('/api/layouts/:id', (req, res) => {
      saveLayouts(loadLayouts().filter((l) => l.id !== req.params.id))
      res.json({ ok: true })
    })

    // ---- Acceptance results (office test session notes) ----------------
    const acceptFile = path.join(projectRoot, 'data', 'acceptance.json')
    const loadAccept = () => { try { return JSON.parse(readFileSync(acceptFile, 'utf8')) } catch { return {} } }
    app.get('/api/acceptance', (_req, res) => res.json({ ok: true, results: loadAccept() }))
    app.get('/api/verify', (_req, res) => res.json({ ok: true, ...(this.verifier?.snapshot() ?? { results: [] }) }))
    app.post('/api/acceptance', (req, res) => {
      const { from, to, verdict, note } = req.body ?? {}
      if (!from || !to || !['clean', 'issue', 'skip', 'clear'].includes(verdict)) {
        return res.status(400).json({ ok: false, error: 'from, to, verdict (clean|issue|skip|clear) required' })
      }
      const all = loadAccept()
      const key = `${from}→${to}`
      // attach the most recent hardware verification for this pair, if any
      const v = (this.verifier?.results ?? []).find((r) => r.to === to && (r.from === from || r.from == null))
      if (verdict === 'clear') delete all[key]
      else all[key] = {
        from, to, verdict, note: note ?? '', at: new Date().toISOString(),
        verify: v ? { ok: v.ok, diffs: v.diffs, simGrade: v.simGrade, simulated: v.simulated } : null,
      }
      mkdirSync(path.join(projectRoot, 'data'), { recursive: true })
      writeFileSync(acceptFile, JSON.stringify(all, null, 2) + '\n')
      res.json({ ok: true, results: all })
    })

    // ---- ProPresenter timers: snapshot + SSE stream --------------------
    app.get('/api/timers', (_req, res) => res.json(this.propresenter.snapshot()))
    app.get('/api/timers/stream', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`)
      send(this.propresenter.snapshot())
      const onUpdate = (snap) => send(snap)
      this.propresenter.on('update', onUpdate)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        this.propresenter.off('update', onUpdate)
        clearInterval(heartbeat)
      })
    })

    // ---- Config: read + write config.json ------------------------------
    // Safe-to-hot-apply keys are applied live; anything else needs a
    // restart, which the response reports so the UI can say so.
    app.get('/api/config', (_req, res) => {
      res.json({ ok: true, config, path: configPath })
    })
    app.put('/api/config', (req, res) => {
      try {
        const incoming = req.body
        if (!incoming || typeof incoming !== 'object') throw new Error('Body must be a config object')
        const { merged, restartRequired } = applyConfigUpdate(incoming)
        writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n')
        console.log('[config] saved', restartRequired.length ? `(restart needed for: ${restartRequired.join(', ')})` : '(applied live)')
        res.json({ ok: true, config: merged, restartRequired })
        this.scheduleBroadcast()
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message })
      }
    })
    app.post('/api/restart', (_req, res) => {
      // systemd (Restart=always) or the operator brings it back up.
      res.json({ ok: true })
      console.log('[config] restart requested from UI - exiting')
      setTimeout(() => process.exit(0), 300)
    })
    // Dry-run: what would the engine do to reach this look from live state?
    // Includes the simulator's grade of the plan (visible cuts, fades, ...).
    app.get('/api/plan/:look', (req, res) => {
      try {
        const look = this.looks.mustGet(req.params.look)
        const plan = this.engine.plan(look)
        res.json({ ok: true, ...plan, sim: this.simulate(plan.steps) })
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message })
      }
    })
    // Grade every look from the live state in one call (for the tile badges).
    app.get('/api/plan-all', (_req, res) => {
      const out = {}
      for (const look of this.looks.list()) {
        try {
          const plan = this.engine.plan(look)
          const sim = this.simulate(plan.steps)
          out[look.name] = { grade: sim.grade, counts: sim.counts, approxDurationMs: sim.approxDurationMs, notes: plan.notes }
        } catch (e) {
          out[look.name] = { grade: 'error', error: e.message }
        }
      }
      res.json({ ok: true, plans: out })
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
      ws.send(JSON.stringify({ wireHistory: wireHistory() }))
      if (this.sennheiser?.enabled) ws.send(JSON.stringify({ senn: this.sennheiser.snapshot() }))
      // Connector-engine topic channel: sub/unsub to mi:/sys:/usr: topics + commands.
      if (this.connectorEngine) {
        const sub = { topics: new Set(), send: (m) => { if (ws.readyState === 1) ws.send(m) } }
        this.connectorEngine.hub.addSubscriber(sub)
        ws.on('message', (raw) => {
          let msg
          try { msg = JSON.parse(raw.toString()) } catch { return }
          if (msg.t === 'sub' && Array.isArray(msg.topics)) this.connectorEngine.hub.subscribe(sub, msg.topics)
          else if (msg.t === 'unsub' && Array.isArray(msg.topics)) this.connectorEngine.hub.unsubscribe(sub, msg.topics)
          else if (msg.t === 'cmd') this.connectorEngine.command(msg.instanceId, msg.command, msg.input).then((r) => ws.send(JSON.stringify({ t: 'ack', id: msg.id, ...r }))).catch(() => {})
        })
        ws.on('close', () => this.connectorEngine.hub.removeSubscriber(sub))
      }
    })
    // Mic meters are a high-rate side-channel like the wire log - pushed on
    // their own so SuperSource snapshots and RF/AF levels don't gate each other.
    sennheiser?.on('update', () => {
      const payload = JSON.stringify({ senn: sennheiser.snapshot() })
      for (const client of this.wss.clients) {
        if (client.readyState === 1) client.send(payload)
      }
    })
    // Live wire-log side-channel (tiny messages, not throttled with snapshots).
    wireBus.on('line', (entry) => {
      const payload = JSON.stringify({ wire: entry })
      for (const client of this.wss.clients) {
        if (client.readyState === 1) client.send(payload)
      }
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
    verifier?.on('verified', markDirty)
    sennheiser?.on('presence', markDirty) // header LED state rides the main snapshot
    // Timer values tick every poll; only rebroadcast the main snapshot when
    // the ProPresenter *connection* state changes.
    let ppState = ''
    propresenter.on('update', (snap) => {
      const key = `${snap.connected}:${snap.configured}`
      if (key !== ppState) { ppState = key; markDirty() }
    })
  }

  /** Run a plan through the virtual switcher seeded from live ATEM state. */
  simulate(steps) {
    const me = this.atem.getMixEffect()
    const sim = new Simulator({
      programInput: me?.programInput,
      previewInput: me?.previewInput,
      boxes: this.atem.getBoxes().map((b) => (b ? { ...b } : null)),
      usk: this.atem.getUskSettings(),
      art: this.atem.getSsProperties(),
      mediaPlayers: this.atem.getMediaPlayers(),
      ssInput: this.engine.ssInput,
      dipInput: this.engine._dipSource(),
    })
    return sim.run(steps)
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
      sennheiser: this.sennheiser ? { enabled: !!this.sennheiser.enabled, simulated: this.sennheiser.simulate, online: this.sennheiser.devices.filter((d) => d.online).length, total: this.sennheiser.devices.length } : { enabled: false },
      currentLook: this.looks.currentLook,
      looks: this.looks.list(),
      macros: this.sequencer.list().map((m) => ({ name: m.name, from: m.from, to: m.to })),
      busy: this.sequencer.current,
      animating: this.animator.running,
      mainMe: this.atem.me,
      propresenter: {
        connected: this.propresenter.connected,
        configured: !!this.propresenter.baseUrl,
      },
      verify: this.verifier?.snapshot() ?? null,
    }
  }
}
