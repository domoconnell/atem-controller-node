import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { config } from './config.js'
import { wire, short } from './wire.js'

/**
 * Sennheiser wireless rig monitor - talks to the receivers/transmitters
 * directly, no WSM. Two protocols (see scratch/SENNHEISER-NOTES.md):
 *
 *  - EW-DX ('ewdx'): SSC - CRLF-terminated JSON over UDP 45. Statics are
 *    polled; live meters (rssi/rsqi/divi/af) are subscribe-only, so we
 *    renew a subscription and merge the stream.
 *  - ew G3/G4 ('g3' receivers, 'iemg4' IEM transmitters): ASCII over UDP
 *    53212. Devices only answer when OUR source port is 53212 too, so one
 *    shared socket serves every G3/G4 unit, demuxed by peer address.
 *    'Push <s> <ms> 1' subscribes to the live RF/AF/battery stream.
 *
 * Scales (calibrate against the real rig with transmitters ON):
 *  - ewdx rssi: dBm, ~-107 floor .. ~-40 hot   -> pct via RSSI_RANGE
 *  - ewdx af:   dB,  ~-138 floor .. 0          -> pct via AF_RANGE
 *  - g3 rf/af, iem af: raw units observed 0..~100 -> pct via G3_MAX
 *
 * Emits: 'update' (any data changed), 'presence' (a device went on/offline).
 */
export const RSSI_RANGE = [-110, -55] // dBm -> 0..1
export const AF_RANGE = [-60, 0] // dB -> 0..1
export const G3_MAX = 100 // raw G3/G4 meter full-scale (assumed; calibrate)

const pct = (v, [lo, hi]) => v == null ? null : Math.max(0, Math.min(1, (v - lo) / (hi - lo)))

/**
 * ICMP presence check - the only signal some old-firmware units expose (e.g.
 * an ew G3 on fw < 1.7, which answers ping but not the 53212 telemetry
 * protocol). Uses the system `ping` (Apple-signed, so LAN-exempt on this Mac;
 * unprivileged on the Pi). Resolves {ok, ms}.
 */
export function pingHost(ip) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', ip], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, ms: null })
      const m = /time[=<]\s*([\d.]+)/.exec(stdout || '')
      resolve({ ok: true, ms: m ? Number(m[1]) : null })
    })
  })
}

/** One G3/G4 ASCII line -> patch onto the device's single channel. */
export function parseG34Line(line, ch) {
  const [key, ...rest] = line.trim().split(/\s+/)
  const nums = rest.map(Number)
  switch (key) {
    case 'Name': ch.name = line.slice(5).trim(); return true
    case 'FirmwareRevision': ch.firmware = rest[0]; return true
    case 'Frequency': ch.frequency = nums[0]; return true // kHz
    case 'Squelch': ch.squelch = nums[0]; return true
    case 'AfOut': ch.afOut = nums[0]; return true
    case 'Sensitivity': ch.sensitivity = nums[0]; return true
    case 'Mode': ch.stereo = nums[0] === 1; return true
    case 'Mute': ch.mute = nums[0] === 1; return true
    case 'RF1': ch.rf1 = nums[0]; ch.ant = nums[2] ? 1 : ch.ant; return true
    case 'RF2': ch.rf2 = nums[0]; if (nums[2]) ch.ant = 2; return true
    case 'RF': ch.rf = nums[0]; return true
    case 'AF': // receiver: level peak ?; IEM: L R peakL peakR
      ch.afRaw = nums
      ch.af = pct(Math.max(...nums.slice(0, 2)), [0, G3_MAX])
      return true
    case 'Bat': ch.battery = /^\d+$/.test(rest[0] ?? '') ? nums[0] : null; return true
    case 'States': ch.states = nums; return true
    case 'Msg': ch.msg = rest.join(' '); return true
    default: return false
  }
}

/**
 * Legacy ew G3 binary protocol (firmware < ~1.7), reverse-engineered from a
 * WSM packet capture. UDP port 8133. WSM sends an 18-byte subscribe carrying
 * its own IP; the receiver then streams 40-byte frames to <requesterIP>:8133
 * (~12/s). Frame layout: [0-2 type][3]=0xca magic [4]=00 [5-10]=device MAC
 * [11]=01 then state bytes. Frame types (distinguished by magic byte[0] +
 * length): identity beacon (ASCII "Model="), ~41-byte meter frame (magic 0x29,
 * RF/AF/antenna/battery), and a ~135-byte config block (magic 0xc8) carrying
 * name / frequency / AF-out / squelch. All offsets decoded from WSM captures
 * (scratch/SENNHEISER-NOTES.md), so a legacy .73 now presents like a full G3.
 */
const LEGACY_PORT = 8133
const LEGACY_TOKEN = Buffer.from('4f1ff1ca', 'hex') // observed WSM subscribe opcode
// Meter-frame byte offsets (magic 29f8f7ca), mapped from mic-on captures:
// byte[19] RF, bytes[24]/[22] AF level, byte[17] AF peak-hold (all /255),
// byte[16] antenna A/B. byte[12] = battery: 0 = tx off / no signal, else 1..4
// where 4 = full; the receiver's 3-bar gauge is (byte-1) - confirmed live at
// 4→3 bars (full) and 3→2 bars. (byte[18] was an earlier wrong guess - it sits
// at 3 in both the 3-bar and 2-bar states, so it isn't the battery.)
const LEG = { rf: 19, af: 24, af2: 22, afPeak: 17, ant: 16, battery: 12 }
// Config-block offsets (~135-byte frame, magic c8fcf7ca), decoded by changing
// each value in WSM and diffing the capture (scratch/SENNHEISER-NOTES.md):
const LEG_CFG = { name: [12, 20], freq: 20, afOut: 26, squelch: 29 }

export function buildLegacySubscribe(ip) {
  const oct = Buffer.from(ip.split('.').map(Number))
  // Trailing 01 00 01 01 01 01 is the "full config" variant: the device answers
  // with the c8fcf7ca config block (name/freq/AF/squelch) as well as telemetry.
  return Buffer.concat([LEGACY_TOKEN, oct, oct, Buffer.from([0x01, 0x00, 0x01, 0x01, 0x01, 0x01])])
}

/**
 * The full WSM init handshake (captured from a fresh WSM connection): a
 * variant-A subscribe, two session-setup commands, then the variant-B (config)
 * subscribe. This establishes the session the c8fcf7ca config block flows
 * within - the plain periodic subscribe alone only yields telemetry.
 */
export function buildLegacyHandshake(ip) {
  const oct = Buffer.from(ip.split('.').map(Number))          // e.g. 0a0a0aa2
  const rev = Buffer.from([...oct].reverse())                 // a20a0a0a (as WSM sends it)
  return [
    Buffer.concat([LEGACY_TOKEN, oct, oct, Buffer.from([0x00, 0x00, 0x01, 0x01, 0x01, 0x01])]), // subscribe variant A
    Buffer.concat([Buffer.from('a4fdf7ca', 'hex'), oct, Buffer.from([0x01, 0x01, 0x01])]),
    Buffer.concat([Buffer.from('4c37cace', 'hex'), rev, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01, 0x01])]),
    buildLegacySubscribe(ip), // subscribe variant B (full config)
  ]
}

export function parseLegacyFrame(buf) {
  // 85-byte ASCII identity beacon: "Model=EM300G3   ID=001B667A8EDB   IPA=..."
  const text = buf.toString('latin1')
  if (text.includes('Model=')) {
    const g = (k) => (new RegExp(k + '=([^\\s\\0]+)').exec(text) || [])[1]
    const id = g('ID')
    const mac = id && id.length === 12 ? id.toLowerCase().match(/../g).join(':') : undefined
    return { kind: 'identity', model: g('Model'), mac, ip: g('IPA') }
  }
  // binary frames: [3]=0xca magic, [5-10]=MAC
  if (buf.length < 40 || buf[3] !== 0xca) return null
  const mac = [...buf.subarray(5, 11)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  // 135-byte config block (magic c8fcf7ca): name / frequency / AF-out / squelch
  if (buf[0] === 0xc8 && buf.length >= 130 && buf.length <= 150) {
    return {
      mac, kind: 'config',
      name: buf.subarray(LEG_CFG.name[0], LEG_CFG.name[1]).toString('latin1').replace(/\0+/g, '').trim(),
      frequency: buf.readUInt32LE(LEG_CFG.freq),  // kHz
      afOut: (buf[LEG_CFG.afOut] - 8) * 3,         // dB
      squelch: 5 + 2 * buf[LEG_CFG.squelch],       // dB
    }
  }
  // ~41-byte meter frame (also magic byte[2]=0xf7); guard by length so the
  // larger RF-scan blocks (110/785/1297B) don't get read as meters.
  if (buf[2] === 0xf7 && buf.length <= 48) {
    return {
      mac, kind: 'telemetry', raw: buf.toString('hex'),
      rf: buf[LEG.rf] / 255,
      af: Math.max(buf[LEG.af], buf[LEG.af2]) / 255,
      afPeak: buf[LEG.afPeak] / 255,
      ant: buf[LEG.ant] === 2 ? 2 : buf[LEG.ant] === 1 ? 1 : undefined,
      batteryRaw: buf[LEG.battery], // 0 = tx off / no signal, 1..4 = level (4 = full)
    }
  }
  return { mac, kind: 'control', raw: buf.toString('hex') }
}

/** Best LAN IPv4 on the same /24 as `deviceIp` (what the device streams back to). */
export function localIpFor(deviceIp) {
  const prefix = deviceIp.split('.').slice(0, 3).join('.') + '.'
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return a.address
    }
  }
  // fallback: first non-internal IPv4
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

/** Deep-merge an SSC JSON reply into the device record. */
export function mergeSsc(dev, obj) {
  let changed = false
  const chFor = (id) => {
    let c = dev.channels.find((c) => c.id === id)
    if (!c) { c = { id }; dev.channels.push(c); dev.channels.sort((a, b) => a.id.localeCompare(b.id)) }
    return c
  }
  const set = (o, k, v) => { if (o[k] !== v) { o[k] = v; changed = true } }
  if (obj.device) {
    if (obj.device.name != null) set(dev, 'deviceName', obj.device.name)
    if (obj.device.identity?.product != null) set(dev, 'product', obj.device.identity.product)
    if (obj.device.identity?.version != null) set(dev, 'version', obj.device.identity.version)
  }
  for (const rx of ['rx1', 'rx2']) {
    if (obj[rx]) {
      const c = chFor(rx)
      if (obj[rx].name != null) set(c, 'name', obj[rx].name)
      if (obj[rx].frequency != null) set(c, 'frequency', obj[rx].frequency)
      if (obj[rx].mute != null) set(c, 'mute', obj[rx].mute)
      if (obj[rx].gain != null) set(c, 'gain', obj[rx].gain)
    }
    if (obj.m?.[rx]) {
      const c = chFor(rx), m = obj.m[rx]
      if (m.rssi != null) { set(c, 'rssi', m.rssi); set(c, 'rf', pct(m.rssi, RSSI_RANGE)) }
      if (m.rsqi != null) set(c, 'rsqi', m.rsqi)
      if (m.divi != null) set(c, 'ant', m.divi + 1)
      if (m.af != null) { set(c, 'afDb', m.af); set(c, 'af', pct(m.af, AF_RANGE)) }
    }
  }
  const mates = obj.mates ?? {}
  for (const [tx, rx] of [['tx1', 'rx1'], ['tx2', 'rx2']]) {
    const g = mates[tx]?.battery?.gauge
    if (g != null) set(chFor(rx), 'battery', g)
  }
  // SSC errors: 424 on mates/... means the transmitter is off -> battery unknown
  for (const err of obj.osc?.error ?? []) {
    for (const [tx, rx] of [['tx1', 'rx1'], ['tx2', 'rx2']]) {
      if (err.mates?.[tx]) set(chFor(rx), 'battery', null)
    }
  }
  return changed
}

const SSC_STATICS = '{"device":{"identity":{"product":null,"version":null},"name":null},"rx1":{"name":null,"frequency":null,"mute":null,"gain":null},"rx2":{"name":null,"frequency":null,"mute":null,"gain":null}}'
const SSC_BATTERY = '{"mates":{"tx1":{"battery":{"gauge":null}},"tx2":{"battery":{"gauge":null}}}}'
const SSC_SUBSCRIBE = '{"osc":{"state":{"subscribe":[{"#":{"lifetime":15},"m":{"rx1":{"rssi":null,"rsqi":null,"divi":null,"af":null},"rx2":{"rssi":null,"rsqi":null,"divi":null,"af":null}}}]}}}'
const G3_STATICS = ['Name', 'Frequency', 'Squelch', 'AfOut', 'Mute', 'FirmwareRevision']
const IEM_STATICS = ['Name', 'Frequency', 'Sensitivity', 'Mode', 'Mute', 'FirmwareRevision']
const G34_PUSH = 'Push 60 300 1'

const OFFLINE_MS = 12000
const STATICS_MS = 10000
const METERS_MS = 5000 // subscription/Push renewal

export class SennheiserMonitor extends EventEmitter {
  constructor() {
    super()
    const cfg = config.sennheiser ?? {}
    this.enabled = cfg.enabled !== false && (cfg.devices?.length || cfg.simulate)
    this.simulate = !!cfg.simulate
    this.devices = (cfg.devices ?? []).map((d) => ({
      ip: d.ip, port: d.port, type: d.type, label: d.label,
      cfgName: d.name, cfgFreq: d.frequency, // optional static overrides for protocols that don't report them
      online: false, reachable: null, pingMs: null, lastRx: 0, channels: [],
    }))
    this._sscSocks = new Map() // device -> socket (devices can share an IP in sim mode)
    this._timers = []
    this._dirty = false
  }

  async start() {
    if (!this.enabled) return
    if (this.simulate) {
      const { SennheiserSimFleet } = await import('./sennheiser-sim.js')
      this._fleet = new SennheiserSimFleet()
      this.devices = await this._fleet.start() // localhost devices
      console.log(`[senn] SIMULATOR fleet: ${this.devices.length} devices on 127.0.0.1`)
    }
    const g34 = this.devices.filter((d) => d.type === 'g3' || d.type === 'iemg4')
    const dx = this.devices.filter((d) => d.type === 'ewdx')
    const legacy = this.devices.filter((d) => d.type === 'g3legacy')

    if (g34.length) {
      this._g34 = dgram.createSocket('udp4')
      this._g34.on('error', (e) => console.error('[senn] g3/g4 socket:', e.message))
      this._g34.on('message', (msg, rinfo) => this._onG34(msg, rinfo))
      // Real G3/G4 gear only answers source port 53212. The sim doesn't care.
      await new Promise((res, rej) =>
        this._g34.bind(this.simulate ? undefined : { port: 53212 }, res).once('error', rej)
      ).catch((e) => console.error('[senn] cannot bind :53212 (is WSM running?):', e.message))
    }
    if (legacy.length) {
      this._legacyIp = localIpFor(legacy[0].ip)
      this._legacy = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this._legacy.on('error', (e) => console.error('[senn] legacy 8133 socket:', e.message))
      this._legacy.on('message', (msg, rinfo) => this._onLegacy(msg, rinfo))
      await new Promise((res) => this._legacy.bind(this.simulate ? 0 : LEGACY_PORT, res))
        .catch((e) => console.error('[senn] cannot bind :8133 (WSM running here?):', e.message))
      // Send the subscribe from a SEPARATE ephemeral socket, mirroring WSM (it
      // subscribes from an ephemeral source port, not 8133). The unit only
      // returns the c8fcf7ca config block (name/freq/squelch/AF) to an
      // ephemeral-sourced subscribe; telemetry still streams to reqIP:8133 (the
      // _legacy socket). The sender also listens, since the sim replies to the
      // sender's source rather than 8133.
      this._legacySender = dgram.createSocket('udp4')
      this._legacySender.on('error', () => {})
      this._legacySender.on('message', (msg, rinfo) => this._onLegacy(msg, rinfo))
      await new Promise((res) => this._legacySender.bind(0, res)).catch(() => {})
      if (!this._legacyIp) console.warn('[senn] no LAN IP found for legacy subscribe - old G3 will fall back to ping presence')
      else console.log(`[senn] legacy G3 subscribe as ${this._legacyIp} (recv :8133) for ${legacy.length} unit(s)`)
      // Establish the session so the config block flows, and refresh it in case
      // the unit ages the session out.
      if (this._legacyIp) {
        for (const d of legacy) this._legacyHandshake(d)
        this._timers.push(setInterval(() => { for (const d of legacy) this._legacyHandshake(d) }, 30000))
      }
    }
    for (const d of dx) {
      const s = dgram.createSocket('udp4')
      s.on('error', (e) => console.error(`[senn] ${d.ip}:`, e.message))
      s.on('message', (msg) => this._onSsc(d, msg))
      this._sscSocks.set(d, s)
    }

    const every = (ms, fn) => { fn(); this._timers.push(setInterval(fn, ms)) }
    every(STATICS_MS, () => {
      for (const d of dx) this._sscSend(d, SSC_STATICS, true)
      for (const d of g34) this._g34Send(d, d.type === 'g3' ? G3_STATICS : IEM_STATICS, true)
    })
    every(METERS_MS, () => {
      for (const d of dx) { this._sscSend(d, SSC_BATTERY); this._sscSend(d, SSC_SUBSCRIBE) }
      for (const d of g34) this._g34Send(d, [G34_PUSH])
      if (this._legacyIp) for (const d of legacy) this._legacySubscribe(d)
    })
    this._timers.push(setInterval(() => this._checkPresence(), 2000))
    if (!this.simulate) every(5000, () => this._pingAll())
    console.log(`[senn] monitoring ${this.devices.length} devices (${dx.length} EW-DX, ${g34.length} G3/G4)`)
  }

  stop() {
    for (const t of this._timers.splice(0)) clearInterval(t)
    for (const s of this._sscSocks.values()) { try { s.close() } catch {} }
    try { this._g34?.close() } catch {}
    try { this._legacy?.close() } catch {}
    try { this._legacySender?.close() } catch {}
    this._fleet?.stop()
  }

  _sscSend(d, json, log = false) {
    if (log) wire('tx', 'senn', `ssc ${d.ip}`, short(json, 60))
    this._sscSocks.get(d)?.send(json + '\r\n', d.port ?? 45, d.ip)
  }

  _g34Send(d, cmds, log = false) {
    if (log) wire('tx', 'senn', `g34 ${d.ip}`, cmds.join(' '))
    for (const c of cmds) this._g34?.send(c + '\r', d.port ?? 53212, d.ip)
  }

  _legacySubscribe(d) {
    wire('tx', 'senn', `legacy ${d.ip}`, `subscribe as ${this._legacyIp} (recv :8133)`)
    // Send from the ephemeral sender (like WSM), fall back to the recv socket.
    ;(this._legacySender ?? this._legacy)?.send(buildLegacySubscribe(this._legacyIp), d.port ?? LEGACY_PORT, d.ip)
  }

  /** WSM's session-setup handshake — makes the unit start sending the config
   *  block (name/freq/squelch/AF), not just telemetry. */
  _legacyHandshake(d) {
    const sock = this._legacySender ?? this._legacy
    wire('tx', 'senn', `legacy ${d.ip}`, `handshake as ${this._legacyIp}`)
    for (const buf of buildLegacyHandshake(this._legacyIp)) sock?.send(buf, d.port ?? LEGACY_PORT, d.ip)
  }

  _onLegacy(msg, rinfo) {
    const d = this.devices.find((x) => x.ip === rinfo.address && x.type === 'g3legacy')
    if (!d) return
    const f = parseLegacyFrame(msg)
    if (!f) return
    this._sawDevice(d)
    if (!d.channels.length) d.channels.push({ id: 'ch', name: d.cfgName ?? d.label, frequency: d.cfgFreq })
    const ch = d.channels[0]
    let changed = false
    if (f.mac && d.mac !== f.mac) { d.mac = f.mac; changed = true }
    if (f.kind === 'identity') {
      if (f.model && d.product !== f.model) { d.product = f.model; changed = true }
      ch.legacy = true
    } else if (f.kind === 'config') {
      ch.legacy = true
      // The device's stored name (e.g. "ew300 G3"); a config.json `name` wins.
      if (f.name && !d.cfgName && ch.name !== f.name) { ch.name = f.name; changed = true }
      if (f.frequency && ch.frequency !== f.frequency) { ch.frequency = f.frequency; changed = true }
      if (ch.squelch !== f.squelch) { ch.squelch = f.squelch; changed = true }
      if (ch.afOut !== f.afOut) { ch.afOut = f.afOut; changed = true }
    } else if (f.kind === 'telemetry') {
      ch.legacy = true; ch.legacyRaw = f.raw
      ch.rf = f.rf; ch.af = f.af; ch.afPeak = f.afPeak
      ch.rf1 = Math.round(f.rf * 100); ch.rf2 = 0 // so the card's RF read-out renders like the other G3s
      if (f.ant) ch.ant = f.ant
      // byte[12]: 0 = tx off / no signal; 1..4 = level, 4 = full. The receiver's
      // 3-bar gauge is (raw-1), so map that onto a %. Only clear on a genuine 0.
      if (f.batteryRaw > 0) {
        const bars = Math.min(3, f.batteryRaw - 1)
        ch.batteryBars = bars
        ch.battery = Math.round((bars / 3) * 100)
        ch.batteryPending = false
      } else {
        ch.batteryBars = null; ch.battery = null
      }
      changed = true
    }
    if (changed) this._markDirty()
  }

  _onSsc(d, msg) {
    this._sawDevice(d)
    let obj
    try { obj = JSON.parse(msg.toString('utf8')) } catch { return }
    if (obj.osc?.state) return // subscription confirmations
    if (mergeSsc(d, obj)) this._markDirty()
  }

  _onG34(msg, rinfo) {
    const d = this.devices.find((x) => x.ip === rinfo.address && (x.port ?? 53212) === (this.simulate ? rinfo.port : 53212))
      ?? this.devices.find((x) => x.ip === rinfo.address)
    if (!d) return
    this._sawDevice(d)
    if (!d.channels.length) d.channels.push({ id: 'ch' })
    const ch = d.channels[0]
    let changed = false
    for (const line of msg.toString('utf8').split('\r')) {
      if (line.trim() && parseG34Line(line, ch)) changed = true
    }
    if (ch.firmware && d.version !== ch.firmware) { d.version = ch.firmware; changed = true }
    if (changed) this._markDirty()
  }

  _sawDevice(d) {
    d.lastRx = Date.now()
    if (!d.online) {
      d.online = true
      wire('rx', 'senn', `${d.ip} online`, d.type)
      this.emit('presence')
      this._markDirty()
    }
  }

  async _pingAll() {
    await Promise.all(this.devices.map(async (d) => {
      const { ok, ms } = await pingHost(d.ip)
      if (d.reachable !== ok || d.pingMs !== ms) {
        const wasReachable = d.reachable
        d.reachable = ok
        d.pingMs = ms
        // A unit that pings but never answers the protocol is present-but-mute
        // (old firmware). Surface that transition on the wire + as a presence
        // event so the header/UI update.
        if (wasReachable !== ok && !d.online) {
          wire('rx', 'senn', `${d.ip} ${ok ? 'reachable (ping)' : 'unreachable'}`, ok ? `${ms ?? '?'}ms - no telemetry` : d.type)
          this.emit('presence')
        }
        this._markDirty()
      }
    }))
  }

  _checkPresence() {
    const now = Date.now()
    for (const d of this.devices) {
      if (d.online && now - d.lastRx > OFFLINE_MS) {
        d.online = false
        wire('rx', 'senn', `${d.ip} offline`, d.type)
        this.emit('presence')
        this._markDirty()
      }
    }
  }

  _markDirty() {
    if (this._dirty) return
    this._dirty = true
    setTimeout(() => { this._dirty = false; this.emit('update') }, 120)
  }

  snapshot() {
    return {
      enabled: !!this.enabled,
      simulated: this.simulate,
      online: this.devices.filter((d) => d.online).length,
      total: this.devices.length,
      devices: this.devices.map((d) => ({
        ip: d.ip, type: d.type, label: d.label, online: d.online,
        reachable: d.reachable, pingMs: d.pingMs,
        product: d.product, version: d.version, deviceName: d.deviceName, mac: d.mac, legacy: d.type === 'g3legacy',
        channels: d.channels,
      })),
    }
  }
}
