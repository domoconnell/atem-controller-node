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
    // Backstage "call" system: named browser sessions (positions) can call each
    // other. calls: [{ from, to, at }] where from/to are browserIds.
    this.calls = []
    this.sessionNames = (() => { try { return { ...(this.store?.allSettings()?.sessionNames ?? {}) } } catch { return {} } })()

    const app = express()
    app.use(express.json())
    app.use(express.static(path.join(projectRoot, 'public')))

    // Countdown renderer pages (and the ProPresenter transparency test).
    app.use('/r', express.static(path.join(projectRoot, 'renderer')))
    app.get('/transparency-test', (_req, res) =>
      res.sendFile(path.join(projectRoot, 'renderer', 'transparency-test.html'))
    )
    app.get('/acceptance', (_req, res) => res.redirect(301, '/atem/acceptance')) // moved under ATEM
    app.get('/atem/acceptance', (_req, res) => {
      res.sendFile(path.join(projectRoot, 'public', 'atem', 'acceptance.html'), (err) => {
        if (err) res.sendFile(path.join(projectRoot, 'public', 'atem', 'acceptance', 'index.html'))
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
    for (const route of ['atem', 'surfaces', 'settings', 'surface', 'runsheet']) {
      app.get(`/${route}`, (_req, res) => {
        res.sendFile(path.join(projectRoot, 'public', `${route}.html`), (err) => {
          if (err) res.sendFile(path.join(projectRoot, 'public', route, 'index.html'))
        })
      })
    }
    app.get('/api/mics', (_req, res) => res.json(this.sennheiser?.snapshot() ?? { enabled: false }))

    // ---- Connector engine (unified backend): instances + catalogue + commands ----
    app.get('/api/connector-types', (_req, res) => res.json({ ok: true, types: this.connectorEngine?.catalogue() ?? [] }))
    app.get('/api/settings', (_req, res) => res.json({ ok: true, settings: this.store?.allSettings() ?? {} }))
    app.get('/api/surfaces', (_req, res) => res.json({ ok: true, surfaces: this.store?.listSurfaces() ?? [] }))
    app.get('/api/surfaces/:id', (req, res) => {
      const one = (this.store?.listSurfaces() ?? []).find((x) => x.id === req.params.id)
      one ? res.json({ ok: true, surface: one }) : res.status(404).json({ ok: false, error: 'not found' })
    })
    app.post('/api/surfaces', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const b = req.body ?? {}
      const id = b.id || `surf_${Date.now().toString(36)}`
      const { name, id: _i, ...data } = b
      this.store.putSurface(id, name || 'Untitled surface', data, !!b.isDefault)
      res.json({ ok: true, id })
    })
    app.put('/api/surfaces/:id', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const b = req.body ?? {}
      const { name, id: _i, ...data } = b
      this.store.putSurface(req.params.id, name || 'Untitled surface', data, !!b.isDefault)
      res.json({ ok: true })
    })
    app.delete('/api/surfaces/:id', (req, res) => { this.store?.deleteSurface(req.params.id); res.json({ ok: true }) })

    // ---- Mics (composite objects: Sennheiser + DiGiCo + internal cue) ----
    app.get('/api/features/mics', (_req, res) => res.json({ ok: true, mics: this.store?.listMics() ?? [] }))
    app.post('/api/features/mics', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const b = req.body ?? {}
      const id = b.id || `mic_${Math.random().toString(36).slice(2, 10)}`
      const { id: _i, label = 'Mic', sortOrder = 0, ...data } = b
      this.store.putMic(id, label, data, sortOrder)
      this.publishMics()
      res.json({ ok: true, mics: this.store.listMics() })
    })
    app.patch('/api/features/mics/:id', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const cur = this.store.listMics().find((m) => m.id === req.params.id) ?? {}
      const { id: _i, label = cur.label ?? 'Mic', sortOrder = cur.sortOrder ?? 0, ...data } = { ...cur, ...(req.body ?? {}) }
      this.store.putMic(req.params.id, label, data, sortOrder)
      this.publishMics()
      res.json({ ok: true, mics: this.store.listMics() })
    })
    app.delete('/api/features/mics/:id', (req, res) => { this.store?.deleteMic(req.params.id); this.publishMics(); res.json({ ok: true, mics: this.store?.listMics() ?? [] }) })

    // ---- Recorders: connector instances tagged as record/playback devices ----
    app.get('/api/features/recorders', (_req, res) => res.json({ ok: true, recorders: this.store?.listRecorders() ?? [] }))
    app.post('/api/features/recorders', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const b = req.body ?? {}
      const id = b.id || `rec_${Math.random().toString(36).slice(2, 10)}`
      const { id: _i, label = 'Recorder', sortOrder = 0, ...data } = b
      this.store.putRecorder(id, label, data, sortOrder)
      this.publishRecorders()
      res.json({ ok: true, recorders: this.store.listRecorders() })
    })
    app.patch('/api/features/recorders/:id', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const cur = this.store.listRecorders().find((m) => m.id === req.params.id) ?? {}
      const { id: _i, label = cur.label ?? 'Recorder', sortOrder = cur.sortOrder ?? 0, ...data } = { ...cur, ...(req.body ?? {}) }
      this.store.putRecorder(req.params.id, label, data, sortOrder)
      this.publishRecorders()
      res.json({ ok: true, recorders: this.store.listRecorders() })
    })
    app.delete('/api/features/recorders/:id', (req, res) => { this.store?.deleteRecorder(req.params.id); this.publishRecorders(); res.json({ ok: true, recorders: this.store?.listRecorders() ?? [] }) })

    // Surface displays that have announced themselves (for OSC targeting + the
    // Companion reference in Settings).
    app.get('/api/surface-clients', (_req, res) => res.json({ ok: true, clients: [...(this.surfaceClients ?? new Map()).values()].map(({ _ws, ...c }) => c) }))

    // The packaged Companion module, for the "Import module package" screen.
    app.get('/companion/stageit.tgz', (_req, res) => {
      res.download(path.join(projectRoot, 'companion', 'stageit.tgz'), 'companion-module-stageit.tgz', (err) => { if (err && !res.headersSent) res.status(404).json({ ok: false, error: 'module package not built' }) })
    })

    // ---- Companion module API: one poll for state + REST command endpoints ----
    app.get('/api/companion/state', (_req, res) => {
      const svc = this._runningService()
      const segs = svc?.segments ?? []
      const idx = svc?.activeIndex ?? null
      const now = idx != null ? segs[idx] ?? null : null
      const nIdx = idx != null ? this._nextItemIndex(segs, idx) : this._nextItemIndex(segs, null)
      const next = nIdx != null ? segs[nIdx] ?? null : null
      res.json({
        ok: true,
        mics: (this.store?.listMics() ?? []).map((m) => ({ id: m.id, label: m.label, cue: m.cue ?? 'off', muted: this._micMuted(m) })),
        surfaces: (this.store?.listSurfaces() ?? []).map((s) => ({ id: s.id, name: s.name })),
        displays: [...(this.surfaceClients ?? new Map()).values()].map(({ _ws, ...c }) => c),
        calls: this.calls.map((c) => ({ from: c.from, fromName: this.sessionNames[c.from] ?? c.from, to: c.to, toName: this.sessionNames[c.to] ?? c.to, at: c.at })),
        looks: (this.looks?.list?.() ?? []).map((l) => ({ name: l.name })),
        activeLook: this.looks?.currentLook ?? null,
        runsheet: { service: svc?.name ?? null, running: idx != null, now: this._segTitle(now), next: this._segTitle(next), nowTime: now?.time ?? null },
      })
    })
    app.post('/api/companion/runsheet/:action', (req, res) => {
      const a = req.params.action
      if (a === 'next') this.advanceRunsheet(1)
      else if (a === 'back' || a === 'prev') this.advanceRunsheet(-1)
      else if (a === 'stop') { const s = this._runningService(); if (s) this.setActiveIndex(s.id, null) }
      else return res.status(400).json({ ok: false, error: `bad action ${a}` })
      res.json({ ok: true })
    })
    app.post('/api/companion/miccue/:id/:action', (req, res) => {
      try { this.setMicCue(req.params.id, req.params.action); res.json({ ok: true }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })
    app.post('/api/companion/surface-drawer', (req, res) => {
      const { browserId, surfaceId, edge = 'left', action } = req.body ?? {}
      if (!browserId || !action) return res.status(400).json({ ok: false, error: 'browserId and action required' })
      this.connectorEngine?.hub?.publish(`usr:surface:${browserId}`, { surfaceId: surfaceId ?? null, target: `${edge}_drawer`, action, at: Date.now() })
      res.json({ ok: true })
    })
    app.post('/api/companion/look/:name', async (req, res) => {
      try { await this.sequencer?.goto(req.params.name); res.json({ ok: true }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })
    // Tell a browser session to switch to a different surface (the surface page
    // swaps in place — no reload — and re-registers under the new surface).
    app.post('/api/companion/surface-show', (req, res) => {
      const { browserId, surfaceId } = req.body ?? {}
      if (!browserId || !surfaceId) return res.status(400).json({ ok: false, error: 'browserId and surfaceId required' })
      this.connectorEngine?.hub?.publish(`usr:surface:${browserId}`, { showSurface: surfaceId, at: Date.now() })
      res.json({ ok: true })
    })
    // ---- Backstage call system (from/to are browserIds = positions) ----
    app.post('/api/companion/call', (req, res) => {
      const { from, to } = req.body ?? {}
      if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' })
      this.addCall(from, to); res.json({ ok: true })
    })
    app.post('/api/companion/call/cancel', (req, res) => {
      const { from, to } = req.body ?? {}
      if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' })
      this.cancelCall(from, to); res.json({ ok: true })
    })
    app.post('/api/companion/call/clear', (req, res) => {
      const { to } = req.body ?? {}
      if (!to) return res.status(400).json({ ok: false, error: 'to required' })
      this.clearCalls(to); res.json({ ok: true })
    })
    // Name a browser session (position). Central management from the surfaces app.
    app.put('/api/session-name', (req, res) => {
      const { browserId, name } = req.body ?? {}
      if (!browserId) return res.status(400).json({ ok: false, error: 'browserId required' })
      this.setSessionName(browserId, name); res.json({ ok: true })
    })

    // ---- Runsheet services (timed segments with people + mics) ----
    app.get('/api/features/services', (_req, res) => res.json({ ok: true, services: this.store?.listServices() ?? [] }))
    app.post('/api/features/services', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const b = req.body ?? {}
      const id = b.id || `svc_${Math.random().toString(36).slice(2, 10)}`
      const { id: _i, name = 'Service', sortOrder = 0, ...data } = b
      this.store.putService(id, name, data, sortOrder)
      this.publishServices()
      res.json({ ok: true, services: this.store.listServices() })
    })
    app.patch('/api/features/services/:id', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const cur = this.store.listServices().find((s) => s.id === req.params.id) ?? {}
      const { id: _i, name = cur.name ?? 'Service', sortOrder = cur.sortOrder ?? 0, ...data } = { ...cur, ...(req.body ?? {}) }
      // Setting the active position (re)starts that segment's timer; clearing it
      // (stop) clears the clock. Only a request that actually moves the playhead
      // touches this, so editing people/times never resets a running timer.
      const moved = req.body && Object.prototype.hasOwnProperty.call(req.body, 'activeIndex')
      if (moved) data.activeStartedAt = req.body.activeIndex == null ? null : Date.now()
      this.store.putService(req.params.id, name, data, sortOrder)
      // Moving the playhead re-cues mics server-side (the single source of truth,
      // so OSC and every client behave identically).
      if (moved) this.applyCues({ segments: data.segments }, data.activeIndex)
      this.publishServices()
      res.json({ ok: true, services: this.store.listServices() })
    })
    app.delete('/api/features/services/:id', (req, res) => { this.store?.deleteService(req.params.id); this.publishServices(); res.json({ ok: true, services: this.store?.listServices() ?? [] }) })

    // ProPresenter playlists — for linking a service to a live playlist so its
    // segment list stays in sync with ProPresenter (see startRunsheetSync).
    app.get('/api/features/propresenter/playlists', async (_req, res) => {
      try { res.json({ ok: true, playlists: (await this.propresenter?.getPlaylists?.()) ?? [] }) }
      catch (e) { res.status(502).json({ ok: false, error: e.message, playlists: [] }) }
    })

    // ProPresenter audience looks + macros, for attaching to a Stage It look
    // (the Record dialog). `current` is the live audience look right now.
    app.get('/api/features/propresenter/looks', async (_req, res) => {
      try {
        const [looks, macros, mediaPlaylists] = await Promise.all([
          this.propresenter?.getLooks?.() ?? [],
          this.propresenter?.getMacros?.() ?? [],
          this.propresenter?.getMediaPlaylists?.() ?? [],
        ])
        res.json({
          ok: true, looks, macros, mediaPlaylists,
          current: this.propresenter?.currentLook ?? null,
          currentMedia: this.propresenter?.currentMedia ?? null,
        })
      } catch (e) { res.status(502).json({ ok: false, error: e.message, looks: [], macros: [], mediaPlaylists: [], current: null, currentMedia: null }) }
    })

    // Items in one PP media playlist (for the media picker in the Record dialog).
    app.get('/api/features/propresenter/media/:playlistId', async (req, res) => {
      try { res.json({ ok: true, items: (await this.propresenter?.getMediaItems?.(req.params.playlistId)) ?? [] }) }
      catch (e) { res.status(502).json({ ok: false, error: e.message, items: [] }) }
    })

    // Proxy a ProPresenter media thumbnail (JPEG) so surfaces on other machines
    // can show the background of the ProMain box. Thumbnails are static per
    // media uuid, so cache hard. `quality` doubles as a size knob (~px width).
    app.get('/api/features/propresenter/media/:id/thumbnail', async (req, res) => {
      const base = this.propresenter?.baseUrl
      if (!base) return res.status(503).end()
      const q = Math.min(1600, Math.max(80, Number(req.query.quality) || 300))
      try {
        const r = await fetch(`${base}/v1/media/${encodeURIComponent(req.params.id)}/thumbnail?quality=${q}`, { signal: AbortSignal.timeout(4000) })
        if (!r.ok) return res.status(r.status).end()
        res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg')
        res.set('Cache-Control', 'public, max-age=86400, immutable')
        res.send(Buffer.from(await r.arrayBuffer()))
      } catch { res.status(502).end() }
    })

    // Set/replace a look's ProPresenter block (audience look and/or macro).
    app.put('/api/looks/:name/pro', (req, res) => {
      try { res.json({ ok: true, look: this.looks.setPro(req.params.name, req.body ?? null) }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })

    // Assign a look to a folder (grouping in the looks grid).
    app.put('/api/looks/:name/folder', (req, res) => {
      try { res.json({ ok: true, look: this.looks.setFolder(req.params.name, req.body?.folder ?? '') }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })

    // Copy a look under a new name (create without a live switcher).
    app.post('/api/looks/duplicate', (req, res) => {
      const { from, to, enableBox } = req.body ?? {}
      if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' })
      try { res.json({ ok: true, look: this.looks.duplicate(from, to, { enableBox }) }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })
    // Force an immediate re-sync of one linked service (e.g. right after linking).
    app.post('/api/features/services/:id/sync', async (req, res) => {
      const svc = this.store?.listServices().find((s) => s.id === req.params.id)
      if (!svc) return res.status(404).json({ ok: false, error: 'no such service' })
      try { await this.syncService(svc) } catch (e) { return res.status(502).json({ ok: false, error: e.message }) }
      res.json({ ok: true, services: this.store.listServices() })
    })
    app.put('/api/settings', (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'store unavailable' })
      const body = req.body ?? {}
      for (const [k, v] of Object.entries(body)) this.store.setSetting(k, v)
      // Apply behavioural sections (supersource/animation/transition/companion…)
      // to the live config so they take effect immediately - no restart.
      try { applyConfigUpdate(body) } catch { /* non-config keys (e.g. atemTransitions selectors) - stored only */ }
      this.scheduleBroadcast()
      res.json({ ok: true, settings: this.store.allSettings() })
    })
    app.get('/api/instances', (_req, res) => res.json({ ok: true, instances: this.connectorEngine?.listInstances() ?? [] }))
    app.post('/api/instances', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      const b = req.body ?? {}
      if (!b.typeId || !b.name) return res.status(400).json({ ok: false, error: 'typeId and name required' })
      const inst = this.store.createInstance({ typeId: b.typeId, name: b.name, config: b.config ?? {}, enabled: b.enabled !== false, allowControl: !!b.allowControl, simulate: !!b.simulate })
      await this.connectorEngine?.reconcile(inst.id)
      this.publishInstances()
      res.json({ ok: true, instance: inst })
    })
    app.patch('/api/instances/:id', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      this.store.updateInstance(req.params.id, req.body ?? {})
      await this.connectorEngine?.reconcile(req.params.id)
      const inst = this.store.getInstance(req.params.id)
      // Legacy stacks (ATEM/HyperDeck/ProPresenter) aren't engine-run, so
      // reconcile() doesn't touch them - push the new config through and
      // reconnect, otherwise a Settings IP change would be silently ignored.
      const cfg = inst?.config ?? {}
      if (inst?.typeId === 'hyperdeck') this.hyperdeck?.reconfigure?.(cfg)
      else if (inst?.typeId === 'propresenter') this.propresenter?.reconfigure?.(cfg)
      else if (inst?.typeId === 'atem') this.atem?.reconfigure?.(cfg)
      this.publishInstances()
      res.json({ ok: true, instance: inst })
    })
    app.delete('/api/instances/:id', async (req, res) => {
      if (!this.store) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      this.store.deleteInstance(req.params.id)
      await this.connectorEngine?.reconcile(req.params.id)
      this.publishInstances()
      res.json({ ok: true })
    })
    app.post('/api/instances/:id/commands/:command', async (req, res) => {
      if (!this.connectorEngine) return res.status(503).json({ ok: false, error: 'engine unavailable' })
      const result = await this.connectorEngine.command(req.params.id, req.params.command, req.body?.input)
      res.status(result.ok ? 200 : 400).json(result)
    })

    app.get('/api/status', (_req, res) => res.json(this.snapshot()))

    // ---- Renderer presets (bookmarks for the /r/ builder) ---------------
    // DB-backed (the store is the source of truth); JSON file only as a
    // fallback when the store failed to initialise.
    const presetsFile = path.join(projectRoot, 'data', 'renderer-presets.json')
    const jsonPresets = () => { try { return JSON.parse(readFileSync(presetsFile, 'utf8')) } catch { return [] } }
    const loadPresets = () => (this.store ? this.store.listPresets() : jsonPresets()).sort((a, b) => a.name.localeCompare(b.name))
    app.get('/api/renderer-presets', (_req, res) => res.json({ ok: true, presets: loadPresets() }))
    app.post('/api/renderer-presets', (req, res) => {
      const { name, query } = req.body ?? {}
      if (!name || typeof query !== 'string') return res.status(400).json({ ok: false, error: 'name and query required' })
      const preset = { name: String(name).trim(), query, savedAt: new Date().toISOString() }
      if (this.store) this.store.putPreset(preset.name, preset)
      else { const list = jsonPresets().filter((p) => p.name !== preset.name); list.push(preset); mkdirSync(path.join(projectRoot, 'data'), { recursive: true }); writeFileSync(presetsFile, JSON.stringify(list, null, 2) + '\n') }
      res.json({ ok: true, presets: loadPresets() })
    })
    app.delete('/api/renderer-presets/:name', (req, res) => {
      if (this.store) this.store.deletePreset(req.params.name)
      else { mkdirSync(path.join(projectRoot, 'data'), { recursive: true }); writeFileSync(presetsFile, JSON.stringify(jsonPresets().filter((p) => p.name !== req.params.name), null, 2) + '\n') }
      res.json({ ok: true, presets: loadPresets() })
    })

    // ---- Timer layouts (full-frame designs for ProPresenter) -----------
    const layoutsFile = path.join(projectRoot, 'data', 'timer-layouts.json')
    const jsonLayouts = () => { try { return JSON.parse(readFileSync(layoutsFile, 'utf8')) } catch { return [] } }
    const loadLayouts = () => (this.store ? this.store.listTimerLayouts() : jsonLayouts()).sort((a, b) => a.name.localeCompare(b.name))
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
      const rec = { ...layout, updatedAt: new Date().toISOString() }
      if (this.store) this.store.putTimerLayout(rec.id, rec.name, rec)
      else { const list = jsonLayouts().filter((l) => l.id !== rec.id); list.push(rec); mkdirSync(path.join(projectRoot, 'data'), { recursive: true }); writeFileSync(layoutsFile, JSON.stringify(list, null, 2) + '\n') }
      res.json({ ok: true, layouts: loadLayouts() })
    })
    app.delete('/api/layouts/:id', (req, res) => {
      if (this.store) this.store.deleteTimerLayout(req.params.id)
      else { mkdirSync(path.join(projectRoot, 'data'), { recursive: true }); writeFileSync(layoutsFile, JSON.stringify(jsonLayouts().filter((l) => l.id !== req.params.id), null, 2) + '\n') }
      res.json({ ok: true })
    })

    // ---- Acceptance results (office test session notes) ----------------
    const acceptFile = path.join(projectRoot, 'data', 'acceptance.json')
    const jsonAccept = () => { try { return JSON.parse(readFileSync(acceptFile, 'utf8')) } catch { return {} } }
    const loadAccept = () => (this.store ? this.store.getAcceptance() : jsonAccept())
    app.get('/api/acceptance', (_req, res) => res.json({ ok: true, results: loadAccept() }))
    app.get('/api/verify', (_req, res) => res.json({ ok: true, ...(this.verifier?.snapshot() ?? { results: [] }) }))
    app.post('/api/acceptance', (req, res) => {
      const { from, to, verdict, note } = req.body ?? {}
      if (!from || !to || !['clean', 'issue', 'skip', 'clear'].includes(verdict)) {
        return res.status(400).json({ ok: false, error: 'from, to, verdict (clean|issue|skip|clear) required' })
      }
      const key = `${from}→${to}`
      const v = (this.verifier?.results ?? []).find((r) => r.to === to && (r.from === from || r.from == null))
      const record = verdict === 'clear' ? null : {
        from, to, verdict, note: note ?? '', at: new Date().toISOString(),
        verify: v ? { ok: v.ok, diffs: v.diffs, simGrade: v.simGrade, simulated: v.simulated } : null,
      }
      if (this.store) { if (record) this.store.putAcceptance(key, record); else this.store.deleteAcceptance(key) }
      else { const all = jsonAccept(); if (record) all[key] = record; else delete all[key]; mkdirSync(path.join(projectRoot, 'data'), { recursive: true }); writeFileSync(acceptFile, JSON.stringify(all, null, 2) + '\n') }
      res.json({ ok: true, results: loadAccept() })
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
          else if (msg.t === 'register' && msg.data && typeof msg.data.browserId === 'string') {
            // A surface display announcing itself, so OSC can target it and
            // Settings can list which browser is showing which surface.
            ;(this.surfaceClients ??= new Map()).set(msg.data.browserId, { browserId: msg.data.browserId, surfaceId: msg.data.surfaceId ?? null, surfaceName: msg.data.surfaceName ?? null, openEdge: msg.data.openEdge ?? null, name: this.sessionNames[msg.data.browserId] ?? null, since: Date.now(), _ws: ws })
            this.publishCalls(msg.data.browserId) // send this session its name + any pending calls
          }
        })
        ws.on('close', () => {
          this.connectorEngine.hub.removeSubscriber(sub)
          if (this.surfaceClients) for (const [k, v] of this.surfaceClients) if (v._ws === ws) this.surfaceClients.delete(k)
        })
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
    // Rebroadcast when the connection OR the live audience look / background
    // media changes, so the "what's live now" panel reflects what ProPresenter
    // is actually doing — even when the change was made in ProPresenter itself.
    let ppState = ''
    propresenter.on('update', (snap) => {
      const key = `${snap.connected}:${snap.configured}:${snap.currentLook?.name ?? ''}:${snap.currentMedia?.item?.uuid ?? ''}`
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
    this.startRunsheetSync()
    this.publishServices() // seed the hub snapshots so widgets have data on connect
    this.publishMics()
    this.publishRecorders()
    this.publishInstances()
  }

  /** Push the full services list onto the realtime hub so every runsheet widget
   *  updates at once over the shared WebSocket (no per-widget HTTP polling). */
  publishServices() {
    try { this.connectorEngine?.hub?.publish('feature:services', { services: this.store?.listServices() ?? [] }) }
    catch { /* hub optional (engine may be absent) */ }
    this.pushCompanionRunsheet()
  }

  /** Push the mic definitions (incl. their live cue) onto the hub, so a cue
   *  change from the runsheet reflects on every widget instantly rather than
   *  after the next poll. */
  publishMics() {
    try { this.connectorEngine?.hub?.publish('feature:mics', { mics: this.store?.listMics() ?? [] }) }
    catch { /* hub optional */ }
    this.pushCompanionMics()
  }

  /** Push the recorder list (which devices are tagged record/playback) so the
   *  record-status widget updates without polling. */
  publishRecorders() {
    try { this.connectorEngine?.hub?.publish('feature:recorders', { recorders: this.store?.listRecorders() ?? [] }) }
    catch { /* hub optional */ }
  }

  /** Push the connector instance list (id/typeId/name) onto the hub so the
   *  dashboard and other views never HTTP-poll /api/instances; it changes only
   *  when a connection is added, edited or removed. */
  publishInstances() {
    try { this.connectorEngine?.hub?.publish('sys:instances', { instances: this.connectorEngine?.listInstances() ?? [] }) }
    catch { /* hub optional */ }
  }

  // ---- Runsheet / mic-cue engine (server-authoritative, drives OSC + UI) ----
  _isHeader(s) { return s?.kind === 'header' }
  _nextItemIndex(segs, from) { let i = from == null ? -1 : from; do { i++ } while (i < segs.length && this._isHeader(segs[i])); return i < segs.length ? i : null }
  _prevItemIndex(segs, from) { let i = from == null ? segs.length : from; do { i-- } while (i >= 0 && this._isHeader(segs[i])); return i >= 0 ? i : null }
  _runningService() { const svcs = this.store?.listServices() ?? []; return svcs.find((s) => s.activeIndex != null) ?? svcs[0] }
  _segTitle(s) { return s ? (s.titleOverride?.trim() ? s.titleOverride : s.title) : '' }

  /** Live mute of a composite mic — DiGiCo console mute, else Sennheiser tx mute
   *  — read from the realtime hub's latest channel snapshot. */
  _micMuted(mic) {
    const read = (instId, streamId) => { try { return this.connectorEngine?.hub?.snapshot(`mi:${instId}:${streamId}`)?.data } catch { return null } }
    if (mic.digicoInstanceId && mic.digicoChannel != null) {
      const ch = (read(mic.digicoInstanceId, 'channels')?.channels ?? []).find((c) => c.channel === mic.digicoChannel)
      if (ch) return !!ch.muted
    }
    if (mic.sennheiserInstanceId) {
      const chans = read(mic.sennheiserInstanceId, 'channels')?.channels ?? []
      const ch = chans.find((c) => c.id === mic.sennheiserChannel) ?? chans[0]
      if (ch?.mute != null) return !!ch.mute
    }
    return false
  }

  /** Set each mapped mic's cue from the now (live) / next-item (standby) segments
   *  of a service — the single source of truth for cue automation. */
  applyCues(svc, idx) {
    if (!this.store) return
    const segs = svc?.segments ?? []
    const now = new Set(idx != null ? (segs[idx]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
    const nIdx = this._nextItemIndex(segs, idx)
    const next = new Set(idx != null && nIdx != null ? (segs[nIdx]?.people ?? []).map((p) => p.micId).filter(Boolean) : [])
    let changed = false
    for (const m of this.store.listMics()) {
      const want = now.has(m.id) ? 'live' : next.has(m.id) ? 'standby' : 'off'
      if ((m.cue ?? 'off') !== want) { const { id, label = 'Mic', sortOrder = 0, ...data } = m; this.store.putMic(id, label, { ...data, cue: want }, sortOrder); changed = true }
    }
    if (changed) this.publishMics()
  }

  /** Move a service's playhead, re-cue mics, stamp the timer and broadcast. */
  setActiveIndex(svcId, idx) {
    const svc = this.store?.listServices().find((s) => s.id === svcId)
    if (!svc) return
    const { id, name = 'Service', sortOrder = 0, ...data } = svc
    this.store.putService(id, name, { ...data, activeIndex: idx, activeStartedAt: idx == null ? null : Date.now() }, sortOrder)
    this.applyCues({ ...svc, activeIndex: idx }, idx)
    this.publishServices()
  }

  /** Step the running runsheet forward/back one item (headers skipped). */
  advanceRunsheet(dir) {
    const svc = this._runningService()
    if (!svc) return
    const segs = svc.segments ?? []
    const idx = svc.activeIndex ?? null
    const n = idx == null ? this._nextItemIndex(segs, null)
      : dir > 0 ? this._nextItemIndex(segs, idx) : this._prevItemIndex(segs, idx)
    if (n == null) return // already at an end
    this.setActiveIndex(svc.id, n)
  }

  /** Set one mic's cue directly; 'toggle' cycles off → standby → live → off. */
  setMicCue(micId, action) {
    const mic = this.store?.listMics().find((m) => m.id === micId)
    if (!mic) throw new Error(`no mic '${micId}'`)
    const cur = mic.cue ?? 'off'
    const cue = action === 'toggle' ? (cur === 'off' ? 'standby' : cur === 'standby' ? 'live' : 'off')
      : ['live', 'standby', 'off'].includes(action) ? action : null
    if (!cue) throw new Error(`bad mic cue action '${action}'`)
    const { id, label = 'Mic', sortOrder = 0, ...data } = mic
    this.store.putMic(id, label, { ...data, cue }, sortOrder)
    this.publishMics()
  }

  /** Handle a /sil/* OSC address (parts already split on '/'). */
  async handleOsc(parts, _args) {
    const [, section, ...rest] = parts // parts[0] === 'sil'
    if (section === 'runsheet') {
      if (rest[0] === 'next') return this.advanceRunsheet(1)
      if (rest[0] === 'back' || rest[0] === 'prev') return this.advanceRunsheet(-1)
      if (rest[0] === 'stop') { const s = this._runningService(); if (s) this.setActiveIndex(s.id, null); return }
      throw new Error(`unknown /sil/runsheet/${rest[0] ?? ''}`)
    }
    if (section === 'miccue') { this.setMicCue(rest[0], rest[1]); return }
    if (section === 'surfaces') {
      // /sil/surfaces/<browserId>/<surfaceId>/<edge>_drawer/<action>
      const [browserId, surfaceId, target, action] = rest
      if (!browserId || !target || !action) throw new Error('surface control needs browser id, target and action')
      this.connectorEngine?.hub?.publish(`usr:surface:${browserId}`, { surfaceId: surfaceId ?? null, target, action, at: Date.now() })
      return
    }
    if (section === 'surface-show') {
      // /sil/surface-show/<browserId>/<surfaceId>
      const [browserId, surfaceId] = rest
      if (!browserId || !surfaceId) throw new Error('surface-show needs a browser id and surface id')
      this.connectorEngine?.hub?.publish(`usr:surface:${browserId}`, { showSurface: surfaceId, at: Date.now() })
      return
    }
    if (section === 'call') { const [from, to] = rest; if (!from || !to) throw new Error('call needs from and to'); this.addCall(from, to); return }
    if (section === 'call-cancel') { const [from, to] = rest; if (!from || !to) throw new Error('call-cancel needs from and to'); this.cancelCall(from, to); return }
    if (section === 'call-clear') { const [to] = rest; if (!to) throw new Error('call-clear needs a target'); this.clearCalls(to); return }
    throw new Error(`unknown /sil/${section ?? ''}`)
  }

  /** Push runsheet + mic status to Companion as custom variables. */
  pushCompanionRunsheet() {
    const o = this.oscServer; if (!o?.sendCompanionVar) return
    const svc = this._runningService()
    const segs = svc?.segments ?? []
    const idx = svc?.activeIndex ?? null
    const now = idx != null ? segs[idx] ?? null : null
    const nIdx = idx != null ? this._nextItemIndex(segs, idx) : this._nextItemIndex(segs, null)
    const next = nIdx != null ? segs[nIdx] ?? null : null
    o.sendCompanionVar('runsheet_service', svc?.name ?? '')
    o.sendCompanionVar('runsheet_now', this._segTitle(now))
    o.sendCompanionVar('runsheet_next', this._segTitle(next))
    o.sendCompanionVar('runsheet_now_time', now?.time ?? '')
    o.sendCompanionVar('runsheet_running', idx != null ? 'true' : 'false')
  }
  // ---- Backstage call system ------------------------------------------
  _callsFor(browserId) {
    return this.calls.filter((c) => c.to === browserId).map((c) => ({ from: c.from, fromName: this.sessionNames[c.from] ?? c.from, at: c.at }))
  }
  /** Push a session its own name + its incoming calls (usr:calls:<browserId>). */
  publishCalls(browserId) {
    this.connectorEngine?.hub?.publish(`usr:calls:${browserId}`, { name: this.sessionNames[browserId] ?? null, calls: this._callsFor(browserId) })
  }
  addCall(from, to) {
    if (!from || !to || from === to) return
    if (!this.calls.some((c) => c.from === from && c.to === to)) this.calls.push({ from, to, at: Date.now() })
    this.publishCalls(to)
  }
  cancelCall(from, to) { this.calls = this.calls.filter((c) => !(c.from === from && c.to === to)); this.publishCalls(to) }
  clearCalls(to) { this.calls = this.calls.filter((c) => c.to !== to); this.publishCalls(to) }
  setSessionName(browserId, name) {
    const n = String(name ?? '').trim()
    if (n) this.sessionNames[browserId] = n; else delete this.sessionNames[browserId]
    try { this.store?.setSetting('sessionNames', this.sessionNames) } catch { /* names are best-effort persisted */ }
    const c = this.surfaceClients?.get(browserId); if (c) c.name = n || null
    this.publishCalls(browserId) // so the session learns its own name
    this.scheduleBroadcast?.()
  }

  pushCompanionMics() {
    const o = this.oscServer; if (!o?.sendCompanionVar) return
    for (const m of this.store?.listMics() ?? []) {
      // m.id already starts with "mic_", so don't double it.
      o.sendCompanionVar(`${m.id}_cue`, m.cue ?? 'off')
      o.sendCompanionVar(`${m.id}_name`, m.label ?? '')
      o.sendCompanionVar(`${m.id}_muted`, this._micMuted(m) ? 'true' : 'false')
    }
  }

  /** Live ProPresenter -> Services link. Every few seconds, each service with a
   *  proLink re-fetches its linked playlist and reconciles segments: ProPresenter
   *  is the source of truth for the item list (title + order), while locally
   *  added people, mics and times are preserved by matching the PP item uuid. */
  startRunsheetSync() {
    if (!this.store || !this.propresenter?.getPlaylistItems) return
    const tick = async () => {
      try {
        for (const svc of this.store.listServices()) {
          if (svc.proLink?.playlistId) await this.syncService(svc).catch(() => {})
        }
      } catch { /* store hiccup; retry next tick */ }
    }
    this._runsheetSync = setInterval(tick, 4000)
    tick()
  }

  /** Reconcile one linked service's segments against its ProPresenter playlist.
   *  Returns true if anything changed (and was saved). Leaves segments intact
   *  when PP is unreachable, so an outage never wipes the runsheet. */
  async syncService(svc) {
    const link = svc.proLink
    if (!link?.playlistId) return false
    const items = await this.propresenter.getPlaylistItems(link.playlistId)
    if (!items) return false // PP not configured — keep existing segments
    const old = svc.segments ?? []
    const byPro = new Map(old.filter((s) => s.proItemId).map((s) => [s.proItemId, s]))
    const manual = old.filter((s) => !s.proItemId) // local-only segments, kept & appended
    const synced = items.map((it) => {
      const prev = byPro.get(it.uuid)
      const id = prev?.id ?? `seg_${Math.random().toString(36).slice(2, 10)}`
      if (it.type === 'header') {
        // A section divider — PP owns title + colour; no people/time on a header.
        return { id, proItemId: it.uuid, kind: 'header', title: it.name, color: it.color }
      }
      return {
        id,
        proItemId: it.uuid,
        title: it.name,                      // PP owns the base title
        titleOverride: prev?.titleOverride,  // preserved local rename (wins in the UI)
        time: prev?.time,                    // preserved local augmentation
        people: prev?.people ?? [],          // preserved local augmentation
      }
    })
    const segments = [...synced, ...manual]
    let activeIndex = svc.activeIndex
    if (activeIndex != null && activeIndex >= segments.length) activeIndex = segments.length ? segments.length - 1 : null
    // Only write when something actually changed, to avoid a broadcast storm.
    if (JSON.stringify({ s: old, a: svc.activeIndex }) === JSON.stringify({ s: segments, a: activeIndex })) return false
    const { id, name = 'Service', sortOrder = 0, ...rest } = svc
    this.store.putService(id, name, { ...rest, segments, activeIndex, proLink: { ...link, lastSync: Date.now() } }, sortOrder)
    this.publishServices()
    return true
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
      displayBox: config.supersource?.displayBox ?? 3,
      propresenterInput: config.supersource?.propresenterInput ?? null,
      propresenter: {
        connected: this.propresenter.connected,
        configured: !!this.propresenter.baseUrl,
        currentLook: this.propresenter.currentLook ?? null,
        currentMedia: this.propresenter.currentMedia ?? null,
      },
      verify: this.verifier?.snapshot() ?? null,
    }
  }
}
