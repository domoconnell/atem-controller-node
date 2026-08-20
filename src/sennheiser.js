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
 * [11]=01 ... [15] status ... [27-39] RF/AF state bytes. Two frame types seen:
 * byte[2]=0xf7 telemetry, 0xf1 control/identity. The meter byte mapping needs
 * a transmitter-on capture to finish (see scratch/SENNHEISER-NOTES.md); for now
 * we decode presence + MAC, which already turns a dead unit into a live one.
 */
const LEGACY_PORT = 8133
const LEGACY_TOKEN = Buffer.from('4f1ff1ca', 'hex') // observed WSM subscribe opcode
// Telemetry byte offsets, mapped from a mic-on capture (scratch/captures/
// g3legacy-micon-calibration.json): byte[19] RF (never zero while TX on),
// bytes[24]/[22] AF level (zero in silence), byte[17] AF peak-hold. Scaled /255.
const LEG = { rf: 19, af: 24, af2: 22, afPeak: 17, ant: 16 }

export function buildLegacySubscribe(ip) {
  const oct = Buffer.from(ip.split('.').map(Number))
  return Buffer.concat([LEGACY_TOKEN, oct, oct, Buffer.from([0x01, 0x00, 0x01, 0x01, 0x01, 0x01])])
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
  // 40-byte binary telemetry/control frame: [3]=0xca magic, [5-10]=MAC
  if (buf.length < 40 || buf[3] !== 0xca) return null
  const mac = [...buf.subarray(5, 11)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  if (buf[2] !== 0xf7) return { mac, kind: 'control', raw: buf.toString('hex') }
  return {
    mac, kind: 'telemetry', raw: buf.toString('hex'),
    rf: buf[LEG.rf] / 255,
    af: Math.max(buf[LEG.af], buf[LEG.af2]) / 255,
    afPeak: buf[LEG.afPeak] / 255,
    ant: buf[LEG.ant] === 2 ? 2 : buf[LEG.ant] === 1 ? 1 : undefined,
  }
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
      if (!this._legacyIp) console.warn('[senn] no LAN IP found for legacy subscribe - old G3 will fall back to ping presence')
      else console.log(`[senn] legacy G3 subscribe as ${this._legacyIp} (port 8133) for ${legacy.length} unit(s)`)
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
    wire('tx', 'senn', `legacy ${d.ip}`, `subscribe as ${this._legacyIp}:8133`)
    this._legacy?.send(buildLegacySubscribe(this._legacyIp), d.port ?? LEGACY_PORT, d.ip)
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
    } else if (f.kind === 'telemetry') {
      ch.legacy = true; ch.legacyRaw = f.raw
      ch.rf = f.rf; ch.af = f.af; ch.afPeak = f.afPeak
      ch.rf1 = Math.round(f.rf * 100); ch.rf2 = 0 // so the card's RF read-out renders like the other G3s
      if (f.ant) ch.ant = f.ant
      ch.batteryPending = true // battery byte not yet identified (see todo.md)
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
