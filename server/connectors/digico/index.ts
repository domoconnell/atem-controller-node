import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { type CommandResult, commandFail, commandOk } from '@stageit/shared'
import { z } from 'zod'
import type { Connector, ConnectorContext, ConnectorModule } from '../core/types.js'
import { digicoConditions } from './conditions.js'
import {
  type AuxSendState,
  auxSendLevelMessage,
  auxSendOnMessage,
  type ChannelState,
  commandSetProfile,
  decodeOsc,
  encodeOsc,
  faderMessage,
  fireMacroMessage,
  interpret,
  type MacroState,
  meterClearMessage,
  meterRequestMessage,
  meterTapPath,
  meterToDb,
  meterValuesMessage,
  parseMeterRequest,
  muteChannelMessage,
  queryMessages,
  snapshotFireMessage,
  snapshotNextMessage,
  snapshotPrevMessage,
} from './protocol.js'
import { DigicoSimulator } from './simulator.js'

/** Raw meter reading the console uses for "no signal"; meterToDb(126) = -∞. */
const METER_FLOOR = 126

export const digicoConfigSchema = z.object({
  host: z.string().min(1).default('192.168.1.10')
    .describe('The console’s IP address (Setup → External Control on the desk).'),
  sendPort: z.number().int().min(1).max(65535).default(8000)
    .describe('The port the CONSOLE listens on — its “Receive” port in External Control. We send commands here.'),
  receivePort: z.number().int().min(0).max(65535).default(9000)
    .describe('The port WE listen on for the console’s feedback — point the desk’s “Send to” at this machine on this port. 0 = OS-assigned.'),
  commandSet: z.enum(['ipad', 'osc']).default('ipad')
    .describe('Must MATCH the console’s enabled External Control device, or commands are ignored. “iPad” = the DiGiCo Pad device (no address prefix, fader/send levels in dB) — the set consoles run with iPads connected, and Companion’s default. “OSC” = the “Other OSC” device (/sd addresses, 0..1 taper faders). (S-series is a separate scheme, not yet supported.)'),
  channelCount: z.number().int().min(0).max(128).default(32)
    .describe('How many input channels WE query at startup to pre-load names/mutes/faders. Not a console setting — just how much state we hydrate up front (the desk auto-sends changes after that).'),
  auxCount: z.number().int().min(0).max(64).default(16)
    .describe('How many aux OUTPUTS to scan for names/faders. Over-scanning is harmless — the desk just ignores ones it doesn’t have.'),
  matrixCount: z.number().int().min(0).max(64).default(16)
    .describe('How many matrix OUTPUTS to scan.'),
  groupCount: z.number().int().min(0).max(64).default(24)
    .describe('How many control GROUPS to scan.'),
  pollIntervalSeconds: z.number().int().min(5).max(600).default(30)
    .describe('Keep-alive: how often we re-query a value to keep the link warm and resync after a console reboot. Our setting, not the desk’s.'),
  timeoutSeconds: z.number().int().min(10).max(300).default(45)
    .describe('Health watchdog: if the console sends us nothing for this long, we flag the connection offline. Our setting, not the desk’s.'),
  messagesFromMacros: z.boolean().default(true)
    .describe('Turn labelled macro presses on the desk into a message feed (console text chat can’t be read over the network, so labelled macros are the substitute).'),
  allowMacroFire: z.boolean().default(false)
    .describe('Allow firing macros back at the console. Off until an admin opts in.'),
  /**
   * OSC pass-through relay. A DiGiCo accepts only ONE OSC connection at a time,
   * so we hold it and let other tools (Companion especially) talk to the console
   * *through us*: they point their OSC at this relay port, we forward each packet
   * to the console and fan the console's replies back to every relay client. The
   * client thinks it is talking straight to the desk.
   */
  relayEnabled: z.boolean().default(false)
    .describe('Let other OSC tools (Companion, DiGiCo iPad apps) reach this console through us. They aim their OSC at this machine on the relay port and we pass everything both ways — so many controllers can share the desk’s single OSC connection.'),
  relayReceivePort: z.number().int().min(1).max(65535).default(8001)
    .describe('The port WE listen on for downstream clients — set this as the iPad app’s (or Companion’s) SEND port.'),
  relaySendPort: z.number().int().min(0).max(65535).default(8002)
    .describe('The port WE send replies to on each client — set this as the iPad app’s (or Companion’s) RECEIVE port. 0 = reply to whatever source port the client sent from (single-socket tools).'),
  relayClientTimeoutSeconds: z.number().int().min(10).max(3600).default(300)
    .describe('Forget a relay client we’ve heard nothing from for this long.'),
})

export type DigicoConfig = z.infer<typeof digicoConfigSchema>

const fireMacroInput = z.object({ index: z.number().int().min(1).max(500) })
const muteChannelInput = z.object({ channel: z.number().int().min(1).max(128), muted: z.boolean() })
const faderInput = z.object({ channel: z.number().int().min(1).max(128), db: z.number().min(-150).max(10) })
const auxSendInput = z.object({ channel: z.number().int().min(1).max(128), aux: z.number().int().min(1).max(64), db: z.number().min(-150).max(10).optional(), on: z.boolean().optional() })
const snapshotInput = z.object({ number: z.number().int().min(1).max(9999) })
const noInput = z.object({})

/** Keeps the message feed to something a widget can render. */
const MESSAGE_LIMIT = 50

/**
 * DiGiCo SD-series consoles over the Pad OSC command set.
 *
 * Read the vendorNotes before trusting this on a show: there is no published
 * address dictionary, and firmware differs in whether it wants the `/sd`
 * prefix.
 */
class DigicoConnector implements Connector<DigicoConfig> {
  private ctx: ConnectorContext<DigicoConfig> | null = null
  private socket: Socket | null = null
  private cancelRefresh: (() => void) | null = null
  private cancelWatchdog: (() => void) | null = null
  private lastMessageAt = 0
  private channels = new Map<string, ChannelState>() // key `${type}:${number}`
  private auxSends = new Map<string, AuxSendState>() // key `${ch}:${aux}`
  // We are the console's sole meter client: WE subscribe every in-use channel to
  // a console meter slot (appSlots: our slot → channel+leg), receive its values,
  // and hold each channel's raw L/R level+peak (meterLevels). Downstream clients'
  // own /Meters/request are intercepted (not forwarded) — we answer them from
  // our data in their slot numbering (ipadSlots: per client, their slot → ch+leg).
  private appSlots = new Map<number, { channel: number; leg: 'l' | 'r' }>()
  private meterLevels = new Map<number, { lLevel: number; lPeak: number; rLevel: number; rPeak: number; at: number }>()
  private ipadSlots = new Map<string, Map<number, { channel: number; leg: 'l' | 'r' }>>()
  private meterSubReady = false
  private cancelMeterSub: (() => void) | null = null
  private metersDirty = false
  private cancelMeterPublish: (() => void) | null = null
  private macros = new Map<number, MacroState>()
  private messages: { id: string; text: string; at: number }[] = []
  private messageSeq = 0
  // ---- OSC pass-through relay ----
  private relaySocket: Socket | null = null
  private relayClients = new Map<string, { address: string; port: number; lastSeen: number; toConsole: number; fromConsole: number }>()
  private relayToConsole = 0
  private relayFromConsole = 0
  private cancelRelayHousekeeping: (() => void) | null = null
  private relayDirty = false

  async start(ctx: ConnectorContext<DigicoConfig>): Promise<void> {
    this.ctx = ctx
    this.lastMessageAt = Date.now()

    const socket = createSocket('udp4')
    this.socket = socket
    socket.on('message', (buffer) => this.onDatagram(buffer))
    socket.on('error', (error) => ctx.fail(error, 'UDP socket error'))

    await new Promise<void>((resolve, reject) => {
      socket.bind(ctx.config.receivePort, () => resolve())
      socket.once('error', reject)
    })

    this.query()
    this.cancelRefresh = ctx.setInterval(() => this.query(), ctx.config.pollIntervalSeconds * 1_000)
    this.cancelWatchdog = ctx.setInterval(() => this.checkAlive(), 5_000)

    // We drive the console's metering ourselves: (re)assert our full-channel
    // meter subscription every few seconds (idempotent; also covers channels the
    // scan only just learned, and re-establishes it after a console restart).
    this.subscribeConsoleMeters()
    this.cancelMeterSub = ctx.setInterval(() => this.subscribeConsoleMeters(), 5_000)

    // The console sends meter values ON CHANGE — a steady level is sent once,
    // then not again — so we HOLD each channel's last value (like the iPad does)
    // rather than ageing it out, or a constant tone would fall back to the floor.
    // A signal that stops is reported by the console as its decay down to 126
    // (off); the 5s re-subscribe also re-dumps current values as a safety net.
    // Publish at ~25/s (40ms) when anything changed; serve clients every tick.
    this.cancelMeterPublish = ctx.setInterval(() => {
      const now = Date.now()
      if (this.metersDirty) {
        this.metersDirty = false
        const meters = [...this.meterLevels.entries()].map(([channel, m]) => ({
          channel,
          l: meterToDb(m.lLevel), r: meterToDb(m.rLevel),
          lp: meterToDb(m.lPeak), rp: meterToDb(m.rPeak),
        }))
        ctx.publish('meters', { meters, at: now })
      }
      this.serveClientMeters()
    }, 40)

    if (ctx.config.relayEnabled) await this.startRelay(ctx)
    // Publish relay status ~2x/sec when it changed, and prune idle clients.
    this.cancelRelayHousekeeping = ctx.setInterval(() => {
      this.pruneRelayClients()
      if (this.relayDirty) { this.relayDirty = false; this.publishRelay() }
    }, 500)
    this.publishRelay()
  }

  /** Bind the downstream OSC port that Companion (and friends) connect to. */
  private async startRelay(ctx: ConnectorContext<DigicoConfig>): Promise<void> {
    const relay = createSocket('udp4')
    this.relaySocket = relay
    relay.on('message', (buffer, rinfo) => this.onRelayDatagram(buffer, rinfo))
    relay.on('error', (error) => ctx.logger.debug({ err: error }, 'relay socket error'))
    await new Promise<void>((resolve, reject) => {
      relay.bind(ctx.config.relayReceivePort, () => resolve())
      relay.once('error', reject)
    })
    ctx.logger.info({ receivePort: ctx.config.relayReceivePort, sendPort: ctx.config.relaySendPort }, 'DiGiCo OSC relay listening')
  }

  stop(): void {
    this.cancelRefresh?.()
    this.cancelWatchdog?.()
    this.cancelMeterPublish?.()
    this.cancelMeterPublish = null
    this.cancelMeterSub?.()
    this.cancelMeterSub = null
    this.meterSubReady = false
    this.appSlots.clear()
    this.meterLevels.clear()
    this.ipadSlots.clear()
    this.cancelRelayHousekeeping?.()
    this.cancelRefresh = null
    this.cancelWatchdog = null
    this.cancelRelayHousekeeping = null
    this.socket?.close()
    this.socket = null
    this.relaySocket?.close()
    this.relaySocket = null
    this.relayClients.clear()
    this.relayToConsole = 0
    this.relayFromConsole = 0
    this.ctx = null
    this.channels.clear()
    this.auxSends.clear()
    this.macros.clear()
    this.messages = []
  }

  /** A downstream client (Companion) sent OSC meant for the console. Remember it
   *  so we can route replies back, then forward the packet on to the desk. */
  private onRelayDatagram(buffer: Buffer, rinfo: RemoteInfo): void {
    const ctx = this.ctx
    if (!ctx || !this.socket) return
    const key = `${rinfo.address}:${rinfo.port}`
    const client = this.relayClients.get(key) ?? { address: rinfo.address, port: rinfo.port, lastSeen: 0, toConsole: 0, fromConsole: 0 }
    client.lastSeen = Date.now()
    client.toConsole += 1
    this.relayClients.set(key, client)
    this.relayToConsole += 1
    this.relayDirty = true
    // Intercept this client's meter subscription — do NOT forward it to the
    // console (we own the console's single meter slot table; a client's requests
    // would clobber it). `/Meters/request/<slot> "<tap>"` records what THIS
    // client wants in ITS slot numbering; `/Meters/clear` drops its map. We serve
    // it from our own data (serveClientMeters). Cheap prefix check first.
    if (buffer.length > 8 && buffer[0] === 0x2f && buffer.toString('latin1', 1, 8) === 'Meters/') {
      // Swallow ALL client /Meters/ traffic — none of it may reach the console,
      // or it would clobber our slot table. We answer from our own data instead.
      const msg = decodeOsc(buffer)
      const req = msg && parseMeterRequest(msg)
      if (req === 'clear') { this.ipadSlots.delete(key); return }
      if (req) {
        let map = this.ipadSlots.get(key)
        if (!map) { map = new Map(); this.ipadSlots.set(key, map) }
        map.set(req.slot, { channel: req.channel, leg: req.leg })
      }
      // Requests for taps we don't meter (e.g. aux outputs) are dropped for now.
      return
    }
    // Forward verbatim to the console (its single OSC connection is ours).
    this.socket.send(buffer, ctx.config.sendPort, ctx.config.host, (error) => {
      if (error) ctx.logger.debug({ err: error }, 'relay → console send failed')
    })
  }

  /** (Re)assert OUR meter subscription on the console: one slot per in-use
   *  channel leg (mono → left only; stereo → left+right). Idempotent — the
   *  console just re-binds each slot — so we can call it periodically to cover
   *  channels the scan only just learned and to survive a console restart. */
  private subscribeConsoleMeters(): void {
    // Input channels only for now — output busses (aux/matrix/group) are scanned
    // and shown, but their post-fader meter tap isn't confirmed yet, so they're
    // not requested. (DG_TYPES.meterTap is null for them.)
    const inUse = [...this.channels.values()]
      .filter((c) => c.type === 'input' && ((c.inputType != null && c.inputType !== 0) || (c.name != null && !/^Ch \d+$/.test(c.name))))
      .sort((a, b) => a.channel - b.channel)
    if (inUse.length === 0) return
    const next = new Map<number, { channel: number; leg: 'l' | 'r' }>()
    let slot = 0
    for (const c of inUse) {
      next.set(slot++, { channel: c.channel, leg: 'l' })
      if (c.stereo) next.set(slot++, { channel: c.channel, leg: 'r' })
    }
    this.appSlots = next
    // Clear once, the first time, so stale slots from before don't linger.
    if (!this.meterSubReady) { this.send(meterClearMessage); this.meterSubReady = true }
    for (const [s, bind] of next) this.send(meterRequestMessage(s, meterTapPath(bind.channel, bind.leg)))
  }

  /** Serve every relay client the meters it asked for, in ITS slot numbering,
   *  from our own per-channel data. Called each meter tick. */
  private serveClientMeters(): void {
    if (this.ipadSlots.size === 0 || !this.relaySocket) return
    const ctx = this.ctx
    if (!ctx) return
    const fixed = ctx.config.relaySendPort ?? 0
    const sentTo = fixed > 0 ? new Set<string>() : null
    for (const [key, map] of this.ipadSlots) {
      const client = this.relayClients.get(key)
      if (!client || map.size === 0) continue
      const port = fixed > 0 ? fixed : client.port
      if (sentTo) { if (sentTo.has(client.address)) continue; sentTo.add(client.address) }
      const rows: Array<{ slot: number; level: number; peak: number }> = []
      for (const [s, bind] of map) {
        const m = this.meterLevels.get(bind.channel)
        if (!m) continue
        rows.push(bind.leg === 'l'
          ? { slot: s, level: m.lLevel, peak: m.lPeak }
          : { slot: s, level: m.rLevel, peak: m.rPeak })
      }
      if (rows.length === 0) continue
      this.relaySocket.send(encodeOsc(meterValuesMessage(rows)), port, client.address, (error) => {
        if (error) ctx.logger.debug({ err: error }, 'meter serve → client failed')
      })
    }
  }

  /** Fan a console packet out to every relay client (called from onDatagram).
   *  Replies go to the client's configured RECEIVE port (relaySendPort) — the
   *  iPad app expects an asymmetric port pair — or to its source port when
   *  relaySendPort is 0 (single-socket tools). */
  private relayToClients(buffer: Buffer): void {
    if (!this.relaySocket || this.relayClients.size === 0) return
    const fixed = this.ctx?.config.relaySendPort ?? 0
    // With a fixed receive port, every client at one IP receives on the SAME
    // address:port, so a client that has reconnected from new source ports would
    // otherwise get N duplicate copies. Dedupe the fan-out by destination.
    const sentTo = fixed > 0 ? new Set<string>() : null
    for (const client of this.relayClients.values()) {
      const port = fixed > 0 ? fixed : client.port
      if (sentTo) { if (sentTo.has(client.address)) continue; sentTo.add(client.address) }
      this.relaySocket.send(buffer, port, client.address, (error) => {
        if (error) this.ctx?.logger.debug({ err: error }, 'relay → client send failed')
      })
      client.fromConsole += 1
      this.relayFromConsole += 1
    }
    this.relayDirty = true
  }

  private pruneRelayClients(): void {
    const ctx = this.ctx
    if (!ctx || this.relayClients.size === 0) return
    const cutoff = Date.now() - ctx.config.relayClientTimeoutSeconds * 1_000
    for (const [key, client] of this.relayClients) {
      if (client.lastSeen < cutoff) { this.relayClients.delete(key); this.ipadSlots.delete(key); this.relayDirty = true }
    }
  }

  private publishRelay(): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.publish('relay', {
      enabled: ctx.config.relayEnabled,
      // Named from the CLIENT's point of view, for the setup instructions:
      //  clientSendPort  = the port the iPad/Companion sends TO (= our receive)
      //  clientReceivePort = the port it listens ON (= where we send; 0 = source)
      clientSendPort: ctx.config.relayReceivePort,
      clientReceivePort: ctx.config.relaySendPort,
      console: { host: ctx.config.host, sendPort: ctx.config.sendPort },
      toConsole: this.relayToConsole,
      fromConsole: this.relayFromConsole,
      clients: [...this.relayClients.values()].map((c) => ({ address: c.address, port: c.port, lastSeen: c.lastSeen, toConsole: c.toConsole, fromConsole: c.fromConsole })),
    })
  }

  /** Address prefix + level encoding for the configured command set. */
  private profile() { return commandSetProfile(this.ctx?.config.commandSet ?? 'ipad') }

  async exec(commandId: string, input: unknown): Promise<CommandResult> {
    const ctx = this.ctx
    if (!ctx) return commandFail('NOT_CONNECTED', 'Not connected')
    const set = this.profile()

    if (commandId === 'macro.fire') {
      if (!ctx.config.allowMacroFire) {
        return commandFail('NOT_ALLOWED', 'Firing macros is disabled for this console')
      }
      const parsed = fireMacroInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Pick a macro number')
      this.send(fireMacroMessage(set.prefix, parsed.data.index))
      return commandOk()
    }

    // Mute/unmute an input channel — drives runsheet mic-mute automation. The
    // console echoes the new mute back, so the UI catches up on its own.
    if (commandId === 'channel.mute') {
      const parsed = muteChannelInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Need { channel, muted }')
      this.send(muteChannelMessage(set.prefix, parsed.data.channel, parsed.data.muted))
      return commandOk()
    }

    // Set an input fader to a dB level (mapped onto the console's 0..1 taper).
    if (commandId === 'channel.fader') {
      const parsed = faderInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Need { channel, db }')
      this.send(faderMessage(set.prefix, parsed.data.channel, parsed.data.db, set.directDb))
      return commandOk()
    }

    // Set a channel→aux send: level (dB) and/or on. For IEM/monitor control.
    if (commandId === 'auxsend.set') {
      const parsed = auxSendInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Need { channel, aux, db?, on? }')
      const { channel, aux, db, on } = parsed.data
      if (db !== undefined) this.send(auxSendLevelMessage(set.prefix, channel, aux, db, set.directDb))
      if (on !== undefined) this.send(auxSendOnMessage(set.prefix, channel, aux, on))
      return commandOk()
    }

    // Snapshots — fire by number, or step next / previous.
    if (commandId === 'snapshot.fire') {
      const parsed = snapshotInput.safeParse(input)
      if (!parsed.success) return commandFail('INVALID_INPUT', 'Need { number }')
      this.send(snapshotFireMessage(set.prefix, parsed.data.number))
      return commandOk()
    }
    if (commandId === 'snapshot.next') { this.send(snapshotNextMessage(set.prefix)); return commandOk() }
    if (commandId === 'snapshot.prev') { this.send(snapshotPrevMessage(set.prefix)); return commandOk() }

    return commandFail('NOT_FOUND', `Unknown command ${commandId}`)
  }

  private onDatagram(buffer: Buffer): void {
    const ctx = this.ctx
    if (!ctx) return

    this.lastMessageAt = Date.now()
    // Relay the raw console packet to every downstream client first — even things
    // we do not parse (aux sends, EQ, …) must reach clients untouched. The one
    // exception is /Meters/values: those carry OUR slot numbering, meaningless to
    // a client, so we suppress them here and serve each client its own instead.
    const isMeterValues = buffer.length > 14 && buffer[0] === 0x2f && buffer[14] === 0 && buffer.toString('latin1', 1, 14) === 'Meters/values'
    if (!isMeterValues) this.relayToClients(buffer)

    const message = decodeOsc(buffer)
    if (!message) return // not OSC, or truncated; the console will send more

    const update = interpret(message, this.profile().directDb)
    if (!update) return

    ctx.setStatus('online')

    if (update.channel) {
      // Keyed by (type, number): each family numbers from 1 independently.
      const key = `${update.channel.type}:${update.channel.channel}`
      const existing = this.channels.get(key) ?? {
        type: update.channel.type, channel: update.channel.channel,
        name: null, muted: null, faderDb: null, stereo: null, inputType: null,
      }
      // Partial merge: the console sends one leaf at a time.
      this.channels.set(key, {
        type: update.channel.type,
        channel: update.channel.channel,
        name: update.channel.name ?? existing.name,
        muted: update.channel.muted ?? existing.muted,
        faderDb: update.channel.faderDb ?? existing.faderDb,
        stereo: update.channel.stereo ?? existing.stereo,
        inputType: update.channel.inputType ?? existing.inputType,
      })
      ctx.publish('channels', { channels: [...this.channels.values()] })
    }

    if (update.auxSend) {
      const key = `${update.auxSend.ch}:${update.auxSend.aux}`
      const prev = this.auxSends.get(key) ?? { ch: update.auxSend.ch, aux: update.auxSend.aux }
      this.auxSends.set(key, {
        ch: update.auxSend.ch,
        aux: update.auxSend.aux,
        level: update.auxSend.level ?? prev.level,
        on: update.auxSend.on ?? prev.on,
        pan: update.auxSend.pan ?? prev.pan,
      })
      ctx.publish('auxSends', { sends: [...this.auxSends.values()] })
    }

    if (update.meters) {
      // Map each console slot's raw reading onto its channel leg (our appSlots).
      const now = Date.now()
      for (const s of update.meters) {
        const bind = this.appSlots.get(s.slot)
        if (!bind) continue
        const cur = this.meterLevels.get(bind.channel)
          ?? { lLevel: METER_FLOOR, lPeak: METER_FLOOR, rLevel: METER_FLOOR, rPeak: METER_FLOOR, at: 0 }
        if (bind.leg === 'l') { cur.lLevel = s.level; cur.lPeak = s.peak }
        else { cur.rLevel = s.level; cur.rPeak = s.peak }
        cur.at = now
        this.meterLevels.set(bind.channel, cur)
      }
      this.metersDirty = true
    }

    if (update.macro) {
      this.macros.set(update.macro.index, update.macro)
      ctx.publish('macros', { macros: [...this.macros.values()] })

      // A macro going *on* is the press; its release is not a second message.
      if (ctx.config.messagesFromMacros && update.macro.on) {
        this.messageSeq += 1
        this.messages = [
          { id: `m${this.messageSeq}`, text: update.macro.name, at: update.macro.at },
          ...this.messages,
        ].slice(0, MESSAGE_LIMIT)
        ctx.publish('messages', { messages: this.messages })
      }
    }

    if (update.snapshotNumber !== undefined) {
      ctx.publish('snapshots', { current: update.snapshotNumber, at: Date.now() })
    }
  }

  private query(): void {
    const ctx = this.ctx
    if (!ctx) return
    const counts = {
      input: ctx.config.channelCount || 32,
      aux: ctx.config.auxCount ?? 16,
      matrix: ctx.config.matrixCount ?? 16,
      group: ctx.config.groupCount ?? 24,
    }
    for (const message of queryMessages(this.profile().prefix, counts)) {
      this.send(message)
    }
  }

  private checkAlive(): void {
    const ctx = this.ctx
    if (!ctx) return

    const silentMs = Date.now() - this.lastMessageAt
    if (silentMs > ctx.config.timeoutSeconds * 1_000) {
      // Nothing at all from the console: either External Control was switched
      // off, or the port pair does not match. Both need a human.
      ctx.fail(
        new Error(`no OSC from the console for ${Math.round(silentMs / 1000)}s`),
        'Console silent — check External Control and the port pair',
      )
    }
  }

  private send(message: { address: string; args: (number | string)[] }): void {
    const ctx = this.ctx
    if (!ctx || !this.socket) return
    this.socket.send(encodeOsc(message), ctx.config.sendPort, ctx.config.host, (error) => {
      if (error) ctx.logger.debug({ err: error }, 'OSC send failed')
    })
  }
}

export const digicoModule: ConnectorModule<DigicoConfig> = {
  meta: {
    typeId: 'digico',
    displayName: 'DiGiCo SD console',
    description:
      'Channel names and mutes, macro states and snapshot fires from an SD-series console, ' +
      'plus a message feed built from labelled macro presses. Console text chat cannot be ' +
      'read over the network — see the notes — so labelled macros are the substitute.',
    configSchema: digicoConfigSchema,
    streams: [
      { id: 'channels', label: 'Channels', rateClass: 'slow' },
      { id: 'auxSends', label: 'Aux sends', rateClass: 'change' },
      { id: 'meters', label: 'Meters', rateClass: 'fast' },
      { id: 'macros', label: 'Macros', rateClass: 'change' },
      { id: 'messages', label: 'Messages', rateClass: 'change', history: 'events' },
      { id: 'snapshots', label: 'Snapshots', rateClass: 'change', history: 'events' },
      { id: 'relay', label: 'OSC relay', rateClass: 'change' },
    ],
    commands: [
      {
        id: 'macro.fire',
        label: 'Fire macro',
        description: 'Presses a macro on the console — for acknowledging a message.',
        inputSchema: fireMacroInput,
        dangerous: true,
      },
      {
        id: 'channel.mute',
        label: 'Mute / unmute channel',
        description: 'Sets an input channel’s mute — drives runsheet mic-mute automation.',
        inputSchema: muteChannelInput,
        dangerous: true,
      },
      {
        id: 'channel.fader',
        label: 'Set channel fader (dB)',
        description: 'Sets an input channel’s fader level in dB (mapped to the DiGiCo taper).',
        inputSchema: faderInput,
        dangerous: true,
      },
      {
        id: 'auxsend.set',
        label: 'Set aux send (level / on)',
        description: 'Sets a channel→aux send level (dB) and/or on-state — monitor/IEM control.',
        inputSchema: auxSendInput,
        dangerous: true,
      },
      {
        id: 'snapshot.fire',
        label: 'Fire snapshot (by number)',
        description: 'Recalls a session snapshot by its number.',
        inputSchema: snapshotInput,
        dangerous: true,
      },
      {
        id: 'snapshot.next',
        label: 'Fire next snapshot',
        description: 'Recalls the next snapshot in the session.',
        inputSchema: noInput,
        dangerous: true,
      },
      {
        id: 'snapshot.prev',
        label: 'Fire previous snapshot',
        description: 'Recalls the previous snapshot in the session.',
        inputSchema: noInput,
        dangerous: true,
      },
    ],
    conditions: digicoConditions,
    capabilities: { control: true },
    tier: 'caveated',
    // Never met a console. The `/sd` address-prefix question below is
    // unresolved for exactly that reason, and a module that connects and
    // reports nothing is the failure a show would blame the dashboard for.
    // Clear this when somebody has bench-tested it and written down what the
    // console said.
    unproven: true,
    vendorNotes:
      'Console text chat CANNOT be read over the network. It travels inside the audio ' +
      'transport — the last eight channels of a MADI port set to "Console", or the Optocore ' +
      'loop — and never touches the control LAN; no OSC address for it exists. Instead, label ' +
      'macros on the console with the things people need to say ("Need runner", "Mic 3 down") ' +
      'and this module turns each press into a timestamped message you can alert on. ' +
      'Setup: Setup → External Control → enable, add a "DiGiCo Pad" device pointed at this ' +
      'server, and give it a unique send/receive port pair. There is no published OSC ' +
      'dictionary: the addresses used here are proven against real consoles by the Bitfocus ' +
      'and OSCWebMixer projects, but firmware differs over whether addresses want a "/sd" ' +
      'prefix. Bench-test against your console before a show depends on it.',
  },
  create: () => new DigicoConnector(),
  createSimulator: () => new DigicoSimulator(),
  simulatedConfig: (address, base) => ({
    ...base,
    host: address.host,
    sendPort: address.port,
    // 0 lets the OS pick the bind port, so parallel tests do not collide.
    receivePort: 0,
    channelCount: 2,
  }),
}
