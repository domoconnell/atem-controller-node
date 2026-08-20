import dgram from 'node:dgram'

/**
 * Simulated Sennheiser fleet: real UDP servers on 127.0.0.1 speaking the
 * same two protocols as the hardware (SSC JSON / G3-G4 ASCII), with
 * animated RF/AF/battery so the Mics UI can be built and demoed anywhere.
 * Mirrors the real rig: 3x EW-DX EM2 (2ch), 4x ew300 G3 RX, 6x IEM G4.
 */
const FLEET = [
  { type: 'ewdx', name: 'EWDXEM2', chans: [['MC1', 650425], ['MC2', 658275]] },
  { type: 'ewdx', name: 'EWDXEM2', chans: [['MC3', 660450], ['MC4', 668300]] },
  { type: 'ewdx', name: 'EWDXEM2', chans: [['VOX 1', 651950], ['VOX 2', 668750]] },
  { type: 'g3', name: 'VOX 4', freq: 639100 },
  { type: 'g3', name: 'VOX 5', freq: 638025 },
  { type: 'g3', name: 'VOX 6', freq: 643175 },
  { type: 'g3', name: 'SPARE', freq: 606000, dead: true }, // tx off: no RF/battery
  { type: 'g3legacy', name: 'RX .73 (old fw)', freq: 606000 }, // pre-1.7 binary 8133 protocol
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ type: 'iemg4', name: `VOX ${n}`, freq: 614325 + n * 700 })),
]

let t0 = Date.now()
const wob = (period, phase = 0) => (Math.sin(((Date.now() - t0) / period + phase * 0.618) * 2 * Math.PI) + 1) / 2 // golden-ratio phase spread so units never sync
// A vaguely speech-like AF envelope: bursts with pauses.
const speech = (phase) => {
  const talking = wob(9000 + phase * 137, phase) > 0.35
  return talking ? 0.25 + 0.7 * wob(700, phase * 7.3) * wob(311, phase * 3.1) : 0.02 * wob(500, phase)
}

class SscSim {
  constructor(profile, idx) {
    this.p = profile
    this.idx = idx
    this.subs = [] // {addr, port, until}
    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (msg, rinfo) => this._onMsg(msg, rinfo))
  }
  start() {
    return new Promise((res) => this.sock.bind(0, '127.0.0.1', () => {
      this._timer = setInterval(() => this._tick(), 300)
      res(this.sock.address().port)
    }))
  }
  stop() { clearInterval(this._timer); try { this.sock.close() } catch {} }

  _bat(rx) { return this.p.chans[rx] ? Math.round(20 + 75 * wob(600000, this.idx + rx)) : null }

  _onMsg(msg, rinfo) {
    let req
    try { req = JSON.parse(msg.toString()) } catch { return }
    const reply = {}
    if (req.device) {
      reply.device = { name: this.p.name }
      if (req.device.identity) reply.device.identity = { product: 'EWDX2CH', version: `3.0.${this.idx}` }
    }
    this.p.chans.forEach(([name, freq], i) => {
      const rx = `rx${i + 1}`
      if (req[rx]) reply[rx] = { name, frequency: freq, mute: false, gain: 21 }
    })
    if (req.mates) {
      reply.mates = {}
      this.p.chans.forEach((_, i) => { reply.mates[`tx${i + 1}`] = { battery: { gauge: this._bat(i) } } })
    }
    if (req.osc?.state?.subscribe) {
      this.subs = this.subs.filter((s) => !(s.addr === rinfo.address && s.port === rinfo.port))
      this.subs.push({ addr: rinfo.address, port: rinfo.port, until: Date.now() + 15000 })
    }
    if (Object.keys(reply).length) this.sock.send(JSON.stringify(reply) + '\r\n', rinfo.port, rinfo.address)
  }

  _tick() {
    this.subs = this.subs.filter((s) => s.until > Date.now())
    for (const s of this.subs) {
      const m = {}
      this.p.chans.forEach((_, i) => {
        const rx = `rx${i + 1}`, ph = this.idx * 2 + i
        m[rx] = {
          rssi: Math.round(-90 + 30 * wob(5000, ph)),
          rsqi: Math.round(55 + 45 * wob(7000, ph)),
          divi: wob(3000, ph) > 0.5 ? 1 : 0,
          af: Math.round(-60 + 58 * speech(ph)),
        }
      })
      this.sock.send(JSON.stringify({ m }) + '\r\n', s.port, s.addr)
    }
  }
}

class G34Sim {
  constructor(profile, idx) {
    this.p = profile
    this.idx = idx
    this.push = null // {addr, port, until, timer}
    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (msg, rinfo) => this._onMsg(msg, rinfo))
  }
  start() {
    return new Promise((res) => this.sock.bind(0, '127.0.0.1', () => res(this.sock.address().port)))
  }
  stop() { clearInterval(this.push?.timer); try { this.sock.close() } catch {} }

  _send(rinfo, s) { this.sock.send(s + '\r', rinfo.port, rinfo.address) }

  _onMsg(msg, rinfo) {
    const cmd = msg.toString().replace(/\r|\n/g, '').trim()
    const p = this.p
    if (cmd === 'Name') return this._send(rinfo, `Name ${p.name.padEnd(8)}`)
    if (cmd === 'Frequency') return this._send(rinfo, `Frequency ${p.freq} 21 1`)
    if (cmd === 'Squelch') return this._send(rinfo, 'Squelch 17')
    if (cmd === 'AfOut') return this._send(rinfo, 'AfOut 15')
    if (cmd === 'Sensitivity') return this._send(rinfo, 'Sensitivity -24')
    if (cmd === 'Mode') return this._send(rinfo, 'Mode 1')
    if (cmd === 'Mute') return this._send(rinfo, 'Mute 0')
    if (cmd === 'FirmwareRevision') return this._send(rinfo, `FirmwareRevision ${p.type === 'g3' ? '1.8.0' : '1.2.0'}`)
    if (cmd.startsWith('Push')) {
      clearInterval(this.push?.timer)
      const timer = setInterval(() => this._pushTick(rinfo), 300)
      this.push = { timer, until: Date.now() + 60000 }
      return
    }
    this._send(rinfo, `1000: Invalid command [ ${cmd} ]`)
  }

  _pushTick(rinfo) {
    if (Date.now() > this.push.until) { clearInterval(this.push.timer); this.push = null; return }
    const ph = this.idx * 3
    if (this.p.type === 'g3') {
      if (this.p.dead) {
        this._send(rinfo, 'RF1 0 0 1'); this._send(rinfo, 'RF2 0 0 1')
        this._send(rinfo, 'RF 0 2 0'); this._send(rinfo, 'AF 4 4 5')
        this._send(rinfo, 'Bat ?'); this._send(rinfo, 'Msg RF_Mute')
      } else {
        const a = wob(4000, ph) > 0.5
        const rf = Math.round(40 + 55 * wob(3500, ph))
        const af = Math.round(100 * speech(ph))
        this._send(rinfo, `RF1 ${a ? rf : Math.round(rf * 0.4)} 0 ${a ? 1 : 0}`)
        this._send(rinfo, `RF2 ${a ? Math.round(rf * 0.4) : rf} 0 ${a ? 0 : 1}`)
        this._send(rinfo, `RF ${rf} 2 0`)
        this._send(rinfo, `AF ${af} ${af} ${Math.min(100, af + 5)}`)
        this._send(rinfo, `Bat ${Math.round(20 + 75 * wob(500000, ph))}`)
        this._send(rinfo, 'Msg OK')
      }
    } else {
      const af = Math.round(100 * speech(ph))
      const af2 = Math.round(100 * speech(ph + 0.1))
      this._send(rinfo, `AF ${af} ${af2} ${Math.min(100, af + 4)} ${Math.min(100, af2 + 4)}`)
      this._send(rinfo, 'States 0 0')
      this._send(rinfo, 'Msg OK')
    }
    this._send(rinfo, 'Config 10')
  }
}

class LegacySim {
  // Speaks the pre-1.7 G3 binary protocol on UDP 8133: on any subscribe,
  // stream the real captured 40-byte telemetry frame back to the sender.
  constructor(profile, idx) { this.p = profile; this.idx = idx; this.streams = new Map() }
  start() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.sock.on('message', (_m, rinfo) => this._subscribe(rinfo))
    return new Promise((res) => this.sock.bind(0, '127.0.0.1', () => res(this.sock.address().port)))
  }
  stop() { for (const t of this.streams.values()) clearInterval(t); try { this.sock.close() } catch {} }
  _subscribe(rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`
    clearInterval(this.streams.get(key))
    // stream back to the sender's port (the monitor's 8133 socket)
    const base = Buffer.from('29f8f7ca00001b667a8edb0100000003000000000000000000000001010100000101010101010100', 'hex')
    const ident = Buffer.from('002512064d6f64656c3d454d333030473320202049443d3030314236363741384544422020204950413d31302e31302e31302e3733000000000000000000000000000000', 'hex')
    let n = 0, peak = 0
    const t = setInterval(() => {
      const frame = Buffer.from(base)
      const ph = this.idx * 3
      const af = Math.round(255 * speech(ph))
      peak = Math.max(af, peak * 0.9)
      frame[19] = Math.round(150 + 90 * wob(4000, ph)) // RF: present while TX on
      frame[24] = af                                   // AF level
      frame[22] = Math.round(af * 0.85)
      frame[17] = Math.round(peak)                     // AF peak-hold
      this.sock.send(frame, rinfo.port, rinfo.address)
      if (n++ % 40 === 0) this.sock.send(ident, rinfo.port, rinfo.address) // periodic identity beacon
    }, 80)
    this.streams.set(key, t)
    setTimeout(() => { clearInterval(t); this.streams.delete(key) }, 20000)
  }
}

export class SennheiserSimFleet {
  constructor() { this.sims = [] }
  /** Boot every sim server; returns monitor-ready device entries. */
  async start() {
    t0 = Date.now()
    const devices = []
    for (const [i, p] of FLEET.entries()) {
      const sim = p.type === 'ewdx' ? new SscSim(p, i) : p.type === 'g3legacy' ? new LegacySim(p, i) : new G34Sim(p, i)
      this.sims.push(sim)
      const port = await sim.start()
      devices.push({
        ip: '127.0.0.1', port, type: p.type, label: p.name,
        online: false, lastRx: 0, channels: [],
      })
    }
    return devices
  }
  stop() { for (const s of this.sims) s.stop() }
}
