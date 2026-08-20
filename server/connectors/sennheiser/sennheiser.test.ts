import { describe, expect, it } from 'vitest'
import { identifyMessage, muteMessage, parseSscMessage, subscribeMessage } from './protocol.js'

describe('SSC parsing', () => {
  it('reads a full receiver snapshot', () => {
    const update = parseSscMessage(
      JSON.stringify({
        device: { name: 'Rack 1', identity: { product: 'EW-DX EM 2' }, warnings: [] },
        rx1: {
          rsqi: 5,
          name: 'Vocal 1',
          mute: false,
          rf: { level: -52, frequency: 606_250 },
          audio: { level: -18 },
        },
        mates: { tx1: { battery: { gauge: 84, lifetime: 240 } } },
      }),
    )

    const channel = update?.channels.get('1')
    expect(channel).toMatchObject({
      rsqi: 5,
      name: 'Vocal 1',
      muted: false,
      rfLevelDbm: -52,
      afLevelDb: -18,
      batteryPct: 84,
      batteryRuntimeMin: 240,
      linked: true,
    })
    // kHz on the wire, MHz on the wall.
    expect(channel?.frequencyMhz).toBe(606.3)
    expect(update?.device).toMatchObject({ model: 'EW-DX EM 2' })
  })

  it('returns only the branches a push actually carried', () => {
    // Receivers send just what changed, so the connector merges partials onto
    // the last known state rather than blanking the rest.
    const update = parseSscMessage(JSON.stringify({ rx2: { rsqi: 2 } }))

    expect(update?.channels.get('2')).toEqual({ channel: '2', rsqi: 2 })
    expect(update?.channels.has('1')).toBe(false)
    expect(update?.device).toBeNull()
  })

  it('treats a plain numeric battery as a percentage', () => {
    const update = parseSscMessage(JSON.stringify({ mates: { tx1: { battery: 40 } } }))
    expect(update?.channels.get('1')).toMatchObject({ batteryPct: 40, linked: true })
  })

  it('marks a channel with no battery reading as unlinked', () => {
    // No transmitter is a different situation from a flat one, and a widget
    // must not show a dead pack where there simply is not one.
    const update = parseSscMessage(JSON.stringify({ mates: { tx2: { battery: null } } }))
    expect(update?.channels.get('2')).toMatchObject({ linked: false, batteryPct: null })
  })

  it('recognises the expiry error as a prompt to re-subscribe', () => {
    // Error 310 is how a receiver says the subscription lapsed. Missing it
    // means silent monitoring, which is the worst failure mode here.
    const update = parseSscMessage(
      JSON.stringify({
        osc: { error: [{ osc: { state: { subscribe: [310, { desc: 'terminates' }] } } }] },
      }),
    )
    expect(update?.subscriptionExpired).toBe(true)
  })

  it('shrugs off a malformed datagram', () => {
    expect(parseSscMessage('{not json')).toBeNull()
    expect(parseSscMessage('null')).toBeNull()
  })
})

describe('SSC requests', () => {
  it('asks for the fields the dashboard shows, with a lifetime', () => {
    const message = JSON.parse(subscribeMessage(90)) as {
      osc: { state: { subscribe: Record<string, unknown>[] } }
    }
    const body = message.osc.state.subscribe[0] as Record<string, unknown>

    expect((body['#'] as { lifetime: number }).lifetime).toBe(90)
    expect(body).toHaveProperty('rx1')
    expect(body).toHaveProperty('mates')
  })
})

/**
 * The channel key, which is now a foreign key.
 *
 * A roster microphone stores `channelKey` and the board looks a live reading up
 * by it. That only works if the key means the same thing in three places: the
 * datagram it was parsed from, the condition that reports a problem against it,
 * and the command that acts on it. Getting it wrong is not a blank cell — it is
 * the wrong microphone's battery beside somebody's name, which is worse than
 * showing nothing at all.
 *
 * Checked against the protocol and the simulator. Not against a receiver: see
 * the roadmap, P5. The stability argument is that the key is the receiver's own
 * SSC address rather than a position in a list, and the round trip below is
 * what makes that concrete.
 */
describe('the channel key, as a thing to store', () => {
  it('is the receiver’s own address, not where the channel happened to appear', () => {
    // Only rx2 is present. A key derived from position would call this "1".
    const update = parseSscMessage(JSON.stringify({ rx2: { rsqi: 4, name: 'Handheld 4' } }))
    expect([...(update?.channels.keys() ?? [])]).toEqual(['2'])
    expect(update?.channels.get('2')?.name).toBe('Handheld 4')
  })

  it('round-trips: the key it is read under is the key that commands it', () => {
    const update = parseSscMessage(JSON.stringify({ rx2: { rsqi: 4 } }))
    const key = [...(update?.channels.keys() ?? [])][0] as string

    // The same string, straight back onto the wire. If these two ever drifted,
    // muting "the channel showing 15%" would mute a different one.
    expect(identifyMessage(key)).toBe(JSON.stringify({ rx2: { identify: true } }))
    expect(muteMessage(key, true)).toBe(JSON.stringify({ rx2: { mute: true } }))
  })

  it('carries the transmitter’s battery onto the same key as its receiver half', () => {
    // rx2 and tx2 are different halves of the wire format and have to land on
    // one row, or a mic pointed at channel 2 shows RF with no battery.
    const update = parseSscMessage(
      JSON.stringify({ rx2: { rsqi: 4 }, mates: { tx2: { battery: { gauge: 15 } } } }),
    )
    expect(update?.channels.get('2')).toMatchObject({ rsqi: 4, batteryPct: 15, linked: true })
  })

  it('reads only the two channels the protocol knows about', () => {
    /*
     * Recorded rather than fixed: an EW-DX EM 4 reports rx3 and rx4 and this
     * connector ignores them silently, so a mic pointed at channel 3 would
     * never resolve. Two-channel receivers — EM 2 and EM 6000 — are what the
     * vendor notes claim support for. See the roadmap.
     */
    const update = parseSscMessage(JSON.stringify({ rx3: { rsqi: 5, name: 'Lapel 3' } }))
    expect(update?.channels.size).toBe(0)
  })
})
