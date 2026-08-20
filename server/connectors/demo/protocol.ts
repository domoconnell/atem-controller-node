/**
 * A deliberately small newline-delimited JSON protocol over TCP.
 *
 * It exists so the platform has a connector that behaves like the real ones
 * (sockets, reconnects, partial frames, garbage input) without needing a
 * HyperDeck on the desk — it backs the integration tests, demo mode, and the
 * worked example in docs/connectors.md.
 */

export interface DemoMeterFrame {
  type: 'meter'
  /** Simulated SPL-style value in dB. */
  value: number
  peak: number
}

export interface DemoStateFrame {
  type: 'state'
  state: string
  /** Seconds since the simulated device entered this state. */
  elapsed: number
}

export interface DemoHelloFrame {
  type: 'hello'
  device: string
  version: string
}

export interface DemoAckFrame {
  type: 'ack'
  id: string
  ok: boolean
  error?: string
}

export type DemoServerFrame = DemoMeterFrame | DemoStateFrame | DemoHelloFrame | DemoAckFrame

export interface DemoCommandFrame {
  type: 'cmd'
  id: string
  cmd: string
  args?: Record<string, unknown>
}

/**
 * Splits a byte stream into lines, holding an incomplete tail until the rest
 * arrives. TCP delivers whatever it likes, whenever it likes — every real
 * connector in this codebase needs exactly this and gets it from here.
 */
export class LineSplitter {
  private buffer = ''

  constructor(private readonly maxLineLength = 64 * 1024) {}

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []

    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) lines.push(line)
      index = this.buffer.indexOf('\n')
    }

    // A peer that never sends a newline must not grow our heap without bound.
    if (this.buffer.length > this.maxLineLength) this.buffer = ''

    return lines
  }

  reset(): void {
    this.buffer = ''
  }
}
