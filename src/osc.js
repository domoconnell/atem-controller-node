import osc from 'osc'
import { config } from './config.js'
import { slug } from './looks.js'

/**
 * OSC control surface for Companion (or anything else).
 *
 * Control addresses (send to this box on config.osc.listenPort):
 *   /goto <look> [durationMs]        - transition to a look via macros
 *   /look/apply <name>               - snap SuperSource to a look
 *   /look/animate <name> [ms] [ease] - tween SuperSource to a look
 *   /look/capture <name>             - save the live layout as a look
 *   /macro/run <name>                - run a macro by name
 *   /stop                            - stop the running macro/animation
 *   /usk <keyer 1-4> <0|1|toggle>    - set USK on-air on the main M/E
 *   /transition/next <sel> [style]   - e.g. "background,key3" "mix"
 *   /transition/auto                 - auto transition on the main M/E
 *   /hyperdeck/play [loop 0|1]
 *   /hyperdeck/stop
 *   /hyperdeck/clip <id>
 *   /reload                          - re-read looks/ and macros/ from disk
 *
 * Feedback (pushed to every config.osc.feedback target on change):
 *   /status/currentLook <name>
 *   /status/busy <0|1> <macroName>
 *   /status/animating <0|1>
 *   /status/atem <0|1>
 *   /status/hyperdeck <0|1>
 *   /status/usk/<keyer 1-4> <0|1>
 *   /status/error <message>
 */
export class OscServer {
  constructor({ atem, animator, looks, sequencer, hyperdeck }) {
    this.atem = atem
    this.animator = animator
    this.looks = looks
    this.sequencer = sequencer
    this.hyperdeck = hyperdeck

    this.port = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: config.osc.listenPort,
      metadata: false,
    })
    this.port.on('ready', () => {
      console.log(`[osc] listening on udp/${config.osc.listenPort}`)
      this.sendCompanionVar('active_look', this.looks.currentLook ?? '')
      this.sendCompanionVar('transitioning', 'false')
      this.sendCompanionVar('going_to', '')
      this.sendCompanionVar('coming_from', '')
    })
    this.port.on('message', (msg) => {
      this.handle(msg.address, msg.args ?? []).catch((e) => {
        console.error(`[osc] ${msg.address} failed:`, e.message)
        this.sendFeedback('/status/error', [e.message])
      })
    })
    // Unreachable feedback targets raise async send errors on every push -
    // log at most one per 30s so a down Companion box can't flood the log.
    this._lastSendErrLog = 0
    this.port.on('error', (e) => {
      const transient = /EHOSTDOWN|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/.test(e.message)
      if (transient) {
        const now = Date.now()
        if (now - this._lastSendErrLog > 30000) {
          this._lastSendErrLog = now
          console.error('[osc] feedback target unreachable (throttled):', e.message)
        }
      } else {
        console.error('[osc] error:', e.message)
      }
    })

    this.wireFeedback()
  }

  open() {
    this.port.open()
  }

  wireFeedback() {
    this.looks.on('current', (name) => {
      this.sendFeedback('/status/currentLook', [name ?? ''])
      this.sendCompanionVar('active_look', name ?? '')
    })
    this.sequencer.on('busy', (info) => {
      this.sendFeedback('/status/busy', [1, info.name])
      this.sendCompanionVar('transitioning', 'true')
      this.sendCompanionVar('going_to', info.to ?? '')
      this.sendCompanionVar('coming_from', info.from ?? '')
    })
    this.sequencer.on('idle', () => {
      this.sendFeedback('/status/busy', [0, ''])
      this.sendCompanionVar('transitioning', 'false')
      this.sendCompanionVar('going_to', '')
      this.sendCompanionVar('coming_from', '')
    })
    this.animator.on('start', () => this.sendFeedback('/status/animating', [1]))
    this.animator.on('done', () => this.sendFeedback('/status/animating', [0]))
    this.animator.on('cancelled', () => this.sendFeedback('/status/animating', [0]))
    this.sequencer.on('error', ({ macro, error }) => {
      this.sendFeedback('/status/error', [`${macro}: ${error}`])
      this.sendCompanionVar('last_error', `${macro}: ${error}`)
    })
    // Richer state: what's on program, which MPs are loaded, connections.
    let lastRich = ''
    const pushRich = () => {
      const me = this.atem.getMixEffect()
      const mps = this.atem.getMediaPlayers?.() ?? []
      const rich = {
        program: this.atem.getInputName(me?.programInput ?? -1),
        preview: this.atem.getInputName(me?.previewInput ?? -1),
        mp1: mps[0]?.name ?? '', mp2: mps[1]?.name ?? '',
        usk_on: (me?.upstreamKeyers ?? []).map((k, i) => (k?.onAir ? i + 1 : null)).filter(Boolean).join(','),
        atem: this.atem.connected ? 'true' : 'false',
        hyperdeck: this.hyperdeck.connected ? 'true' : 'false',
      }
      const key = JSON.stringify(rich)
      if (key === lastRich) return
      lastRich = key
      for (const [k, v] of Object.entries(rich)) this.sendCompanionVar(k, v)
    }
    this.atem.on('stateChanged', pushRich)
    this.atem.on('connected', pushRich)
    this.atem.on('disconnected', pushRich)
    this.hyperdeck.on('connected', pushRich)
    this.hyperdeck.on('disconnected', pushRich)
    this.atem.on('connected', () => this.sendFeedback('/status/atem', [1]))
    this.atem.on('disconnected', () => this.sendFeedback('/status/atem', [0]))
    this.hyperdeck.on('connected', () => this.sendFeedback('/status/hyperdeck', [1]))
    this.hyperdeck.on('disconnected', () => this.sendFeedback('/status/hyperdeck', [0]))

    // USK on-air feedback, keyed by 1-based keyer number on the main M/E.
    let lastUsk = []
    this.atem.on('stateChanged', () => {
      const me = this.atem.getMixEffect()
      const keyers = (me?.upstreamKeyers ?? []).map((k) => k?.onAir ?? false)
      keyers.forEach((onAir, i) => {
        if (lastUsk[i] !== onAir) {
          this.sendFeedback(`/status/usk/${i + 1}`, [onAir ? 1 : 0])
        }
      })
      lastUsk = keyers
    })
  }

  sendFeedback(address, args) {
    for (const target of config.osc.feedback ?? []) {
      try {
        this.port.send({ address, args }, target.host, target.port)
      } catch (e) {
        // Feedback is best-effort; never let it break control handling.
      }
    }
  }

  /** Push a value into a Companion custom variable via its OSC API. */
  sendCompanionVar(name, value) {
    const c = config.companion
    if (!c?.host) return
    const varName = (c.varPrefix ?? 'atemcn_') + name
    try {
      this._loggedVars ??= new Set()
      if (!this._loggedVars.has(varName)) {
        this._loggedVars.add(varName)
        console.log(`[companion] pushing ${varName} -> ${c.host}:${c.port ?? 12321} (further updates not logged)`)
      }
      this.port.send(
        { address: `/custom-variable/${varName}/value`, args: [String(value)] },
        c.host,
        c.port ?? 12321
      )
    } catch (e) {
      console.error('[companion] send failed:', e.message)
    }
  }

  async handle(address, args) {
    console.log('[osc] rx', address, args)
    const parts = address.split('/').filter(Boolean)

    switch (parts[0]) {
      case 'goto': {
        // Companion-friendly path form: /goto/<look>[/<seconds>]
        // Classic arg form still works: /goto <look> [durationMs]
        let look, duration
        if (parts.length > 1) {
          look = slug(parts[1])
          const secs = parseFloat(String(parts[2] ?? '').replace(/[^\d.]/g, ''))
          duration = Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined
        } else {
          look = slug(String(args[0]))
          duration = numOrUndef(args[1])
        }
        await this.sequencer.goto(look, { duration })
        return
      }

      case 'look':
        switch (parts[1]) {
          case 'apply':
            await this.looks.apply(String(args[0]))
            return
          case 'animate': {
            const look = this.looks.mustGet(String(args[0]))
            await this.animator.animateTo(look.boxes, {
              durationMs: numOrUndef(args[1]),
              easing: args[2] ? String(args[2]) : undefined,
            })
            this.looks.setCurrent(look.name)
            return
          }
          case 'capture':
            this.looks.capture(String(args[0]))
            return
          case 'delete':
            this.looks.delete(String(args[0]))
            return
        }
        break

      case 'macro':
        if (parts[1] === 'run') {
          await this.sequencer.run(String(args[0]))
          return
        }
        break

      case 'stop':
        this.sequencer.stop()
        return

      case 'usk': {
        const keyer = Number(args[0]) - 1
        const want = args[1]
        if (Number.isNaN(keyer) || keyer < 0) throw new Error('usk: keyer number (1-4) required')
        if (want === 'toggle' || want === undefined) {
          await this.atem.setUskOnAir(keyer, !this.atem.getUskOnAir(keyer))
        } else {
          await this.atem.setUskOnAir(keyer, !!Number(want))
        }
        return
      }

      case 'transition':
        if (parts[1] === 'next') {
          const selection = String(args[0]).split(',').map((s) => s.trim())
          await this.atem.setNextTransition(selection, args[1] ? String(args[1]) : undefined)
          return
        }
        if (parts[1] === 'auto') {
          await this.atem.autoTransition()
          return
        }
        if (parts[1] === 'rate') {
          await this.atem.setMixRate(Number(args[0]))
          return
        }
        break

      case 'hyperdeck':
        switch (parts[1]) {
          case 'play':
            await this.hyperdeck.command({
              command: 'play',
              loop: args[0] !== undefined ? !!Number(args[0]) : undefined,
            })
            return
          case 'stop':
            await this.hyperdeck.command({ command: 'stop' })
            return
          case 'clip':
            await this.hyperdeck.command({ command: 'gotoClip', clip: Number(args[0]) })
            return
        }
        break

      case 'companion':
        if (parts[1] === 'test') {
          this.sendCompanionVar('active_look', 'test-look')
          this.sendCompanionVar('transitioning', 'true')
          this.sendCompanionVar('going_to', 'test-target')
          this.sendCompanionVar('coming_from', 'test-source')
          return
        }
        break

      case 'reload':
        this.looks.loadAll()
        this.sequencer.loadAll()
        return
    }

    throw new Error(`Unknown OSC address '${address}'`)
  }
}

function numOrUndef(v) {
  const n = Number(v)
  return v === undefined || Number.isNaN(n) ? undefined : n
}
