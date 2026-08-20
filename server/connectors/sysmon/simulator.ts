import { generateKeyPairSync } from 'node:crypto'
import type { Connection, ServerChannel, Server as SshServer } from 'ssh2'
// CommonJS: see the note in index.ts.
import ssh2 from 'ssh2'
import type { SimulatorHandle } from '../core/types.js'
import { SECTION } from './protocol.js'

const { Server } = ssh2

/**
 * A real SSH server with canned answers.
 *
 * Not a stub: it speaks the actual SSH wire protocol, so the connector's
 * handshake, auth, keepalive and channel handling are all exercised. The host
 * key is generated at runtime, so there is no key material in the repository.
 */
export class SysmonSimulator implements SimulatorHandle {
  private server: SshServer | null = null
  private channels = new Set<ServerChannel>()
  private clients = new Set<Connection>()

  /** Scripted values, so conditions have something to fire on. */
  cpuIdlePct = 88
  memPage = { anonymous: 500_000, purgeable: 20_000, wired: 200_000, compressed: 50_000 }
  diskAvailableKb = 400_000_000
  batteryPct = 96
  onBattery = false
  freeMemoryPct = 60

  private garbage = false
  private refuseAuth = false

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })

    this.server = new Server({ hostKeys: [privateKey] }, (client) => {
      this.clients.add(client)
      client.on('close', () => this.clients.delete(client))
      client
        .on('authentication', (ctx) => {
          if (this.refuseAuth) return ctx.reject()
          // Password auth only: it is the lowest-friction setup on a show Mac
          // and the one the deploy guide recommends.
          if (ctx.method === 'password') ctx.accept()
          else ctx.reject(['password'])
        })
        .on('ready', () => {
          client.on('session', (accept) => {
            const session = accept()
            session.on('exec', (acceptExec, _reject, info) => {
              const channel = acceptExec()
              this.channels.add(channel)
              channel.write(this.respond(info.command))
              channel.exit(0)
              channel.end()
              this.channels.delete(channel)
            })
          })
        })
        .on('error', () => {
          // A client vanishing mid-handshake is normal during reconnect tests.
        })
    })

    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve))
    const address = this.server?.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    return { host, port: address.port }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Ends the SSH sessions themselves — closing a channel is not a disconnect. */
  dropConnections(): void {
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    for (const client of this.clients) client.end()
    this.clients.clear()
  }

  sendGarbage(): void {
    this.garbage = true
  }

  setRefuseAuth(refuse: boolean): void {
    this.refuseAuth = refuse
  }

  private respond(command: string): string {
    if (command.includes('sw_vers')) {
      return ['ProductName:\tmacOS', 'ProductVersion:\t26.4.1', SECTION, 'foh-mac'].join('\n')
    }
    if (this.garbage) {
      this.garbage = false
      return 'not remotely what a Mac would say\n'
    }

    const bootSeconds = Math.floor(Date.now() / 1000) - 86_400

    return [
      // Two samples, as the real command produces: the first is the
      // since-boot figure a naive parser would wrongly report.
      'CPU usage: 40.00% user, 20.00% sys, 40.00% idle',
      'Load Avg: 2.15, 2.40, 2.60',
      `CPU usage: ${(100 - this.cpuIdlePct - 2).toFixed(2)}% user, 2.00% sys, ${this.cpuIdlePct.toFixed(2)}% idle`,
      SECTION,
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      `Anonymous pages:                        ${this.memPage.anonymous}.`,
      `Pages purgeable:                        ${this.memPage.purgeable}.`,
      `Pages wired down:                       ${this.memPage.wired}.`,
      `Pages occupied by compressor:           ${this.memPage.compressed}.`,
      SECTION,
      '68719476736',
      SECTION,
      'Filesystem 1024-blocks      Used Available Capacity Mounted on',
      `/dev/disk3s5 1953595632 200000000 ${this.diskAvailableKb}      35% /System/Volumes/Data`,
      SECTION,
      `{ sec = ${bootSeconds}, usec = 0 } ${new Date().toString()}`,
      SECTION,
      `System-wide memory free percentage: ${this.freeMemoryPct}%`,
      SECTION,
      `Now drawing from '${this.onBattery ? 'Battery Power' : 'AC Power'}'`,
      ` -InternalBattery-0 (id=1234)\t${this.batteryPct}%; ${this.onBattery ? 'discharging' : 'charged'}; 0:00 remaining present: true`,
    ].join('\n')
  }
}
