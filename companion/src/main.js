const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')

/**
 * Stage It Live — Companion module.
 *
 * Talks to a running Stage It Live over its HTTP API:
 *   GET  /api/companion/state            — mics, surfaces, displays, runsheet
 *   POST /api/companion/runsheet/:action — next | back | stop
 *   POST /api/companion/miccue/:id/:action
 *   POST /api/companion/surface-drawer   — { browserId, surfaceId, edge, action }
 *
 * It declares all the variables (so they exist automatically), the actions
 * (with dropdowns populated live from Stage It), feedbacks (button colour from
 * mic cue / runsheet state) and drag-on presets.
 */
class StageItInstance extends InstanceBase {
  constructor(internal) {
    super(internal)
  }

  async init(config) {
    this.config = config
    this.data = { mics: [], surfaces: [], displays: [], looks: [], activeLook: null, runsheet: {} }
    this._sig = '' // signature of the option-affecting data, to know when to rebuild defs
    this.updateStatus(InstanceStatus.Connecting)
    this.rebuild()
    this.startPolling()
  }

  async configUpdated(config) {
    this.config = config
    this.startPolling()
  }

  async destroy() {
    if (this.poll) clearInterval(this.poll)
  }

  getConfigFields() {
    return [
      { type: 'static-text', id: 'info', label: 'Stage It Live', width: 12, value: 'The IP and web port of the Stage It Live server (Settings → Web UI).' },
      { type: 'textinput', id: 'host', label: 'IP address', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Web port', width: 6, default: 3000, min: 1, max: 65535 },
    ]
  }

  base() {
    return `http://${this.config?.host || '127.0.0.1'}:${this.config?.port || 3000}`
  }

  startPolling() {
    if (this.poll) clearInterval(this.poll)
    const tick = () => this.fetchState()
    tick()
    this.poll = setInterval(tick, 1000)
  }

  async fetchState() {
    try {
      const r = await fetch(`${this.base()}/api/companion/state`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const s = await r.json()
      this.data = { mics: s.mics ?? [], surfaces: s.surfaces ?? [], displays: s.displays ?? [], looks: s.looks ?? [], activeLook: s.activeLook ?? null, runsheet: s.runsheet ?? {} }
      this.updateStatus(InstanceStatus.Ok)
      // Rebuild dropdown-bearing definitions only when the option lists change.
      const sig = JSON.stringify([this.data.mics.map((m) => m.id), this.data.surfaces.map((x) => x.id), this.data.displays.map((d) => d.browserId), this.data.looks.map((l) => l.name)])
      if (sig !== this._sig) { this._sig = sig; this.rebuild() }
      this.pushValues()
      this.checkFeedbacks('mic_cue_is', 'mic_muted', 'runsheet_running', 'look_is_active', 'drawer_is_open')
    } catch (e) {
      this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
    }
  }

  rebuild() {
    this.initVariables()
    this.initActions()
    this.initFeedbacks()
    this.initPresets()
  }

  post(path, body) {
    return fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  }

  // ------------------------------------------------------------- variables
  initVariables() {
    const defs = [
      { variableId: 'runsheet_service', name: 'Runsheet: service' },
      { variableId: 'runsheet_now', name: 'Runsheet: current segment' },
      { variableId: 'runsheet_next', name: 'Runsheet: next segment' },
      { variableId: 'runsheet_now_time', name: 'Runsheet: current segment time' },
      { variableId: 'runsheet_running', name: 'Runsheet: running (true/false)' },
      { variableId: 'active_look', name: 'ATEM: active look' },
    ]
    for (const m of this.data.mics) {
      defs.push({ variableId: `${m.id}_cue`, name: `Mic cue — ${m.label}` })
      defs.push({ variableId: `${m.id}_name`, name: `Mic name — ${m.label}` })
      defs.push({ variableId: `${m.id}_muted`, name: `Mic muted — ${m.label}` })
    }
    this.setVariableDefinitions(defs)
  }

  pushValues() {
    const rs = this.data.runsheet ?? {}
    const vals = {
      runsheet_service: rs.service ?? '',
      runsheet_now: rs.now ?? '',
      runsheet_next: rs.next ?? '',
      runsheet_now_time: rs.nowTime ?? '',
      runsheet_running: rs.running ? 'true' : 'false',
      active_look: this.data.activeLook ?? '',
    }
    for (const m of this.data.mics) { vals[`${m.id}_cue`] = m.cue; vals[`${m.id}_name`] = m.label; vals[`${m.id}_muted`] = m.muted ? 'true' : 'false' }
    this.setVariableValues(vals)
  }

  // --------------------------------------------------------------- actions
  initActions() {
    const mics = this.data.mics.map((m) => ({ id: m.id, label: m.label }))
    // Browser sessions (the physical displays) and ALL defined surfaces are
    // offered as SEPARATE dropdowns, so a button can target "this display, when
    // it's showing that surface" — it fires the moment the session lands there.
    const browsers = this.data.displays.map((d) => ({ id: d.browserId, label: `${d.surfaceName ?? d.surfaceId ?? '—'} · ${d.browserId}` }))
    const surfaces = this.data.surfaces.map((s) => ({ id: s.id, label: s.name }))
    const looks = this.data.looks.map((l) => ({ id: l.name, label: l.name }))
    const cueChoices = [{ id: 'toggle', label: 'Toggle' }, { id: 'live', label: 'Live' }, { id: 'standby', label: 'Standby' }, { id: 'off', label: 'Off' }]
    const edgeChoices = ['left', 'right', 'top', 'bottom'].map((e) => ({ id: e, label: e }))
    this.setActionDefinitions({
      runsheet_next: { name: 'Runsheet: Next', options: [], callback: () => this.post('/api/companion/runsheet/next') },
      runsheet_back: { name: 'Runsheet: Back', options: [], callback: () => this.post('/api/companion/runsheet/back') },
      runsheet_stop: { name: 'Runsheet: Stop', options: [], callback: () => this.post('/api/companion/runsheet/stop') },
      mic_cue: {
        name: 'Mic cue: set',
        options: [
          { type: 'dropdown', id: 'mic', label: 'Mic', choices: mics, default: mics[0]?.id ?? '' },
          { type: 'dropdown', id: 'action', label: 'Cue', choices: cueChoices, default: 'toggle' },
        ],
        callback: (a) => this.post(`/api/companion/miccue/${a.options.mic}/${a.options.action}`),
      },
      look_goto: {
        name: 'ATEM: go to look',
        options: [
          { type: 'dropdown', id: 'look', label: 'Look', choices: looks, default: looks[0]?.id ?? '' },
        ],
        callback: (a) => this.post(`/api/companion/look/${encodeURIComponent(a.options.look)}`),
      },
      surface_drawer: {
        name: 'Surface: drawer',
        options: [
          { type: 'dropdown', id: 'browser', label: 'Browser session', choices: browsers, default: browsers[0]?.id ?? '' },
          { type: 'dropdown', id: 'surface', label: 'Surface (when shown)', choices: surfaces, default: surfaces[0]?.id ?? '', tooltip: 'Only acts while this session is showing this surface' },
          { type: 'dropdown', id: 'edge', label: 'Drawer', choices: edgeChoices, default: 'left' },
          { type: 'dropdown', id: 'action', label: 'Action', choices: ['open', 'close', 'toggle'].map((x) => ({ id: x, label: x })), default: 'toggle' },
        ],
        callback: (a) => this.post('/api/companion/surface-drawer', { browserId: a.options.browser, surfaceId: a.options.surface, edge: a.options.edge, action: a.options.action }),
      },
    })
  }

  // ------------------------------------------------------------- feedbacks
  initFeedbacks() {
    const mics = this.data.mics.map((m) => ({ id: m.id, label: m.label }))
    const looks = this.data.looks.map((l) => ({ id: l.name, label: l.name }))
    const browsers = this.data.displays.map((d) => ({ id: d.browserId, label: `${d.surfaceName ?? d.surfaceId ?? '—'} · ${d.browserId}` }))
    this.setFeedbackDefinitions({
      mic_cue_is: {
        type: 'boolean',
        name: 'Mic cue is…',
        description: 'Colour a button when a mic is at a given cue state.',
        defaultStyle: { bgcolor: combineRgb(30, 150, 60), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'dropdown', id: 'mic', label: 'Mic', choices: mics, default: mics[0]?.id ?? '' },
          { type: 'dropdown', id: 'cue', label: 'Cue', choices: [{ id: 'live', label: 'Live' }, { id: 'standby', label: 'Standby' }, { id: 'off', label: 'Off' }], default: 'live' },
        ],
        callback: (fb) => {
          const m = this.data.mics.find((x) => x.id === fb.options.mic)
          return !!m && m.cue === fb.options.cue
        },
      },
      mic_muted: {
        type: 'boolean',
        name: 'Mic is muted',
        description: 'Colour a button red when a mic is muted at the console/tx.',
        defaultStyle: { bgcolor: combineRgb(200, 30, 30), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'dropdown', id: 'mic', label: 'Mic', choices: mics, default: mics[0]?.id ?? '' },
        ],
        callback: (fb) => {
          const m = this.data.mics.find((x) => x.id === fb.options.mic)
          return !!m && !!m.muted
        },
      },
      runsheet_running: {
        type: 'boolean',
        name: 'Runsheet is running',
        defaultStyle: { bgcolor: combineRgb(30, 120, 30) },
        options: [],
        callback: () => !!this.data.runsheet?.running,
      },
      look_is_active: {
        type: 'boolean',
        name: 'Look is active',
        description: 'Colour a button when a look is the current ATEM look.',
        defaultStyle: { bgcolor: combineRgb(30, 150, 60), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'dropdown', id: 'look', label: 'Look', choices: looks, default: looks[0]?.id ?? '' },
        ],
        callback: (fb) => !!this.data.activeLook && this.data.activeLook === fb.options.look,
      },
      drawer_is_open: {
        type: 'boolean',
        name: 'Drawer is open',
        description: 'Colour a button when a session has that drawer open.',
        defaultStyle: { bgcolor: combineRgb(40, 90, 200), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'dropdown', id: 'browser', label: 'Browser session', choices: browsers, default: browsers[0]?.id ?? '' },
          { type: 'dropdown', id: 'edge', label: 'Drawer', choices: ['left', 'right', 'top', 'bottom'].map((e) => ({ id: e, label: e })), default: 'left' },
        ],
        callback: (fb) => {
          const d = this.data.displays.find((x) => x.browserId === fb.options.browser)
          return !!d && d.openEdge === fb.options.edge
        },
      },
    })
  }

  // --------------------------------------------------------------- presets
  initPresets() {
    const presets = {}
    const white = combineRgb(255, 255, 255)
    const dark = combineRgb(28, 28, 30)
    presets['rs_next'] = { type: 'button', category: 'Runsheet', name: 'Next', style: { text: 'NEXT\\n$(stageit:runsheet_next)', size: '14', color: white, bgcolor: dark }, steps: [{ down: [{ actionId: 'runsheet_next', options: {} }], up: [] }], feedbacks: [] }
    presets['rs_back'] = { type: 'button', category: 'Runsheet', name: 'Back', style: { text: '← BACK', size: '18', color: white, bgcolor: dark }, steps: [{ down: [{ actionId: 'runsheet_back', options: {} }], up: [] }], feedbacks: [] }
    presets['rs_now'] = { type: 'button', category: 'Runsheet', name: 'Now (display)', style: { text: 'NOW\\n$(stageit:runsheet_now)', size: '14', color: white, bgcolor: combineRgb(20, 20, 22) }, steps: [{ down: [], up: [] }], feedbacks: [{ feedbackId: 'runsheet_running', options: {}, style: { bgcolor: combineRgb(30, 90, 30) } }] }
    for (const m of this.data.mics) {
      presets[`mic_${m.id}`] = {
        type: 'button',
        category: 'Mic cues',
        name: `${m.label} — cue`,
        style: { text: `${m.label}\\n$(stageit:${m.id}_cue)`, size: '14', color: white, bgcolor: dark },
        steps: [{ down: [{ actionId: 'mic_cue', options: { mic: m.id, action: 'toggle' } }], up: [] }],
        feedbacks: [
          { feedbackId: 'mic_cue_is', options: { mic: m.id, cue: 'standby' }, style: { bgcolor: combineRgb(200, 140, 0), color: combineRgb(0, 0, 0) } },
          { feedbackId: 'mic_cue_is', options: { mic: m.id, cue: 'live' }, style: { bgcolor: combineRgb(30, 150, 60), color: white } },
          { feedbackId: 'mic_muted', options: { mic: m.id }, style: { bgcolor: combineRgb(200, 30, 30), color: white } },
        ],
      }
    }
    // One button per look — recall it, and light green while it's the live look.
    for (const l of this.data.looks) {
      presets[`look_${l.name}`] = {
        type: 'button',
        category: 'Looks',
        name: l.name,
        style: { text: l.name, size: '14', color: white, bgcolor: dark },
        steps: [{ down: [{ actionId: 'look_goto', options: { look: l.name } }], up: [] }],
        feedbacks: [{ feedbackId: 'look_is_active', options: { look: l.name }, style: { bgcolor: combineRgb(30, 150, 60), color: white } }],
      }
    }
    // One drawer-toggle button per live browser session — defaults to the left
    // drawer of the surface it's currently showing; edit the surface/edge on the
    // button to retarget. Lights blue while that drawer is open.
    for (const d of this.data.displays) {
      presets[`drawer_${d.browserId}`] = {
        type: 'button',
        category: 'Surface drawers',
        name: `${d.surfaceName ?? d.surfaceId ?? 'Surface'} — left drawer`,
        style: { text: `${d.surfaceName ?? 'Drawer'}\\n◧ LEFT`, size: '14', color: white, bgcolor: dark },
        steps: [{ down: [{ actionId: 'surface_drawer', options: { browser: d.browserId, surface: d.surfaceId ?? '', edge: 'left', action: 'toggle' } }], up: [] }],
        feedbacks: [{ feedbackId: 'drawer_is_open', options: { browser: d.browserId, edge: 'left' }, style: { bgcolor: combineRgb(40, 90, 200), color: white } }],
      }
    }
    this.setPresetDefinitions(presets)
  }
}

runEntrypoint(StageItInstance, [])
