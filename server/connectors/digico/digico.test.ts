import { describe, expect, it } from 'vitest'
import { decodeOsc, encodeOsc, interpret, normaliseAddress, queryMessages } from './protocol.js'

describe('OSC encoding', () => {
  it('round-trips a message with mixed argument types', () => {
    const message = { address: '/Macros/Buttons/state', args: [3, 1, 'Mic 3 down'] }
    const decoded = decodeOsc(encodeOsc(message))
    expect(decoded).toEqual(message)
  })

  it('round-trips a float', () => {
    const decoded = decodeOsc(encodeOsc({ address: '/Input_Channels/1/fader', args: [-6.5] }))
    expect(decoded?.args[0]).toBeCloseTo(-6.5, 3)
  })

  it('rejects a datagram that is not OSC', () => {
    // Something else on the same port must not take the connector down.
    expect(decodeOsc(Buffer.from('hello there'))).toBeNull()
  })

  it('survives a truncated message', () => {
    const full = encodeOsc({ address: '/Macros/Buttons/state', args: [1, 1, 'x'] })
    expect(() => decodeOsc(full.subarray(0, 6))).not.toThrow()
  })
})

describe('address dialects', () => {
  it('accepts both prefixed and unprefixed forms', () => {
    // Firmware differs on this, and getting it wrong means a console that
    // looks connected and reports nothing.
    expect(normaliseAddress('/sd/Input_Channels/1/mute')).toBe('/Input_Channels/1/mute')
    expect(normaliseAddress('/Input_Channels/1/mute')).toBe('/Input_Channels/1/mute')
  })

  it('builds queries with whichever prefix the console wants', () => {
    expect(queryMessages('/sd', 1)[0]?.address).toBe('/sd/Macros/Buttons/?')
    expect(queryMessages('', 1)[0]?.address).toBe('/Macros/Buttons/?')
  })
})

describe('interpreting console messages', () => {
  it('reads a macro state with its label', () => {
    // The label is the whole point: it is the text an operator wanted to send.
    const update = interpret({
      address: '/Macros/Buttons/state',
      args: [2, 1, 'Mic 3 down'],
    })
    expect(update?.macro).toMatchObject({ index: 2, name: 'Mic 3 down', on: true })
  })

  it('names an unlabelled macro by its number', () => {
    const update = interpret({ address: '/Macros/Buttons/state', args: [7, 0] })
    expect(update?.macro).toMatchObject({ index: 7, name: 'Macro 7', on: false })
  })

  it('reads channel names, mutes and faders separately', () => {
    expect(
      interpret({ address: '/Input_Channels/3/Channel_Input/name', args: ['Lead Vox'] })?.channel,
    ).toMatchObject({ channel: 3, name: 'Lead Vox' })

    expect(interpret({ address: '/sd/Input_Channels/3/mute', args: [1] })?.channel).toMatchObject({
      channel: 3,
      muted: true,
    })

    // One decimal place is plenty for a fader on a wall panel. -3.25 lands on
    // -3.2 because JS rounds a half toward positive infinity; either is fine
    // for display, so the test pins the actual behaviour.
    expect(interpret({ address: '/Input_Channels/3/fader', args: [-3.25] })?.channel).toMatchObject(
      { channel: 3, faderDb: -3.2 },
    )
  })

  it('reads a snapshot fire', () => {
    expect(interpret({ address: '/Snapshots/Fire_Snapshot_number', args: [12] })).toEqual({
      snapshotNumber: 12,
    })
  })

  it('ignores addresses it does not claim to understand', () => {
    // There is no published dictionary; guessing at unknown addresses is how
    // you end up displaying a confident wrong number.
    expect(interpret({ address: '/Some/Unknown/Thing', args: [1] })).toBeNull()
  })
})
