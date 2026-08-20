import { describe, expect, it } from 'vitest'
import {
  cueFor,
  type DiscoveredChannel,
  kitRef,
  type MicCues,
  mergeMics,
  nextCueLevel,
  parseMicRef,
  rxRef,
  setMicCueSchema,
} from './micCue.js'
import type { Kit } from './runningOrder.js'

const mic = (over: Partial<Kit> & { id: string; name: string }): Kit => ({
  kind: 'mic',
  notes: '',
  instanceId: null,
  channelKey: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const channel = (over: Partial<DiscoveredChannel> & { channelKey: string }): DiscoveredChannel => ({
  instanceId: 'rack1',
  instanceName: 'Rack 1',
  name: null,
  ...over,
})

const cued = (ref: string, name: string): MicCues => ({
  [ref]: { level: 'standby', at: 1_000, name },
})

describe('microphone references', () => {
  it('round trips both shapes', () => {
    expect(parseMicRef(kitRef('k1'))).toEqual({ kind: 'kit', kitId: 'k1' })
    expect(parseMicRef(rxRef('rack1', '2'))).toEqual({
      kind: 'rx',
      instanceId: 'rack1',
      channelKey: '2',
    })
  })

  it('splits a receiver ref at the first colon, not the last', () => {
    // An instance id cannot contain a colon; a channel key is whatever the
    // receiver calls it, and a splitter that took the last colon would hand
    // back an instance id of "rack1:a" for this.
    expect(parseMicRef('rx:rack1:a:b')).toEqual({
      kind: 'rx',
      instanceId: 'rack1',
      channelKey: 'a:b',
    })
  })

  it('refuses anything that is neither', () => {
    for (const bad of ['', 'k1', 'kit:', 'rx:', 'rx:rack1', 'rx:rack1:', 'rx::2', 'mi:rack1:2']) {
      expect(parseMicRef(bad), bad).toBeNull()
    }
  })

  it('rejects a bad reference at the edge of the API', () => {
    expect(setMicCueSchema.safeParse({ ref: 'nonsense', level: 'standby' }).success).toBe(false)
    expect(setMicCueSchema.safeParse({ ref: 'kit:k1', level: null }).success).toBe(true)
  })
})

describe('the tap cycle', () => {
  it('goes straight there and straight back on the simple cycle', () => {
    expect(nextCueLevel(null, 'simple')).toBe('standby')
    expect(nextCueLevel('standby', 'simple')).toBeNull()
  })

  it('clears a live mic from a simple board, rather than being stuck', () => {
    // The cue state is show-wide, so a simple board meets mics a two-stage
    // board promoted. Anything other than clearing leaves a microphone
    // flashing at somebody with no way to stop it.
    expect(nextCueLevel('live', 'simple')).toBeNull()
  })

  it('steps through standby and live on the two-stage cycle', () => {
    expect(nextCueLevel(null, 'two-stage')).toBe('standby')
    expect(nextCueLevel('standby', 'two-stage')).toBe('live')
    expect(nextCueLevel('live', 'two-stage')).toBeNull()
  })
})

describe('merging the roster with what the receivers report', () => {
  it('shows a claimed channel once, under the name somebody chose', () => {
    // The whole reason the roster wins: "Ada — handheld" is what the crew
    // calls it, and "Vocal 1" is what the receiver calls it.
    const mics = mergeMics(
      [mic({ id: 'k1', name: 'Ada — handheld', instanceId: 'rack1', channelKey: '1' })],
      [channel({ channelKey: '1', name: 'Vocal 1' })],
    )
    expect(mics).toHaveLength(1)
    expect(mics[0]?.name).toBe('Ada — handheld')
    expect(mics[0]?.ref).toBe('kit:k1')
    // It still knows its other name, so a cue on the channel shows here.
    expect(mics[0]?.rx).toBe('rx:rack1:1')
  })

  it('picks up a channel nobody has claimed', () => {
    const mics = mergeMics([], [channel({ channelKey: '2', name: 'Vocal 2' })])
    expect(mics.map((mic) => [mic.ref, mic.name])).toEqual([['rx:rack1:2', 'Vocal 2']])
  })

  it('names an unnamed channel after its receiver, never after the bare key', () => {
    // `name` is null until the first full poll comes back, and "2" on its own
    // tells nobody which box it is in.
    const mics = mergeMics([], [channel({ channelKey: '2' })])
    expect(mics[0]?.name).toBe('Rack 1 ch 2')
  })

  it('keeps a microphone that is on a cable', () => {
    const mics = mergeMics([mic({ id: 'k1', name: 'Lectern' })], [])
    expect(mics.map((mic) => mic.name)).toEqual(['Lectern'])
    expect(mics[0]?.rx).toBeNull()
  })

  it('leaves out roster kit that is not a microphone', () => {
    const mics = mergeMics(
      [
        mic({ id: 'k1', name: 'Ada — handheld' }),
        mic({ id: 'k2', name: 'Belt pack', kind: 'comms' }),
      ],
      [],
    )
    expect(mics.map((mic) => mic.name)).toEqual(['Ada — handheld'])
  })

  it('still shows a microphone that has gone, so its cue can be cleared', () => {
    /*
     * A receiver unplugged mid-show, or kit somebody re-typed as a comms
     * pack. Without this the cue is still on the wire and still counted, but
     * there is nothing on any screen to tap, so nobody can cancel it.
     */
    const mics = mergeMics([], [], cued('rx:rack9:1', 'Vocal 1'))
    expect(mics).toEqual([{ ref: 'rx:rack9:1', name: 'Vocal 1', rx: null, missing: true }])
  })

  it('does not call a cued microphone missing just because it was cued by its other name', () => {
    // Cued as the channel, shown as the roster mic. One entry, not two.
    const mics = mergeMics(
      [mic({ id: 'k1', name: 'Ada — handheld', instanceId: 'rack1', channelKey: '1' })],
      [],
      cued('rx:rack1:1', 'Vocal 1'),
    )
    expect(mics).toHaveLength(1)
    expect(mics[0]?.missing).toBe(false)
  })

  it('puts the roster first, in its own order', () => {
    const mics = mergeMics(
      [mic({ id: 'k1', name: 'Second' }), mic({ id: 'k2', name: 'First' })],
      [channel({ channelKey: '1' })],
    )
    expect(mics.map((mic) => mic.name)).toEqual(['Second', 'First', 'Rack 1 ch 1'])
  })

  it('says which receiver a channel is on when the name is already taken', () => {
    /*
     * The everyday rig: a rack that discovered itself and a roster somebody
     * typed, naming the same microphone the same thing without linking the
     * two. Found in review 4s as three boxes reading "Vocal 1", identical
     * down to the accessible name — a cue on the wrong microphone, in a dark
     * wing, with nothing on screen to tell them apart.
     */
    const mics = mergeMics(
      [mic({ id: 'k1', name: 'Vocal 1' })],
      [channel({ channelKey: '1', name: 'Vocal 1' })],
    )
    expect(mics.map((mic) => mic.name)).toEqual(['Vocal 1', 'Vocal 1 · Rack 1'])
  })

  it('qualifies a second channel of the same name, from a second receiver', () => {
    const mics = mergeMics(
      [],
      [
        channel({ channelKey: '1', name: 'Vocal 1' }),
        channel({ instanceId: 'rack2', instanceName: 'Rack 2', channelKey: '1', name: 'Vocal 1' }),
      ],
    )
    // The first keeps the plain name — it is not ambiguous until the second
    // arrives, and renaming a box somebody is already reading is worse.
    expect(mics.map((mic) => mic.name)).toEqual(['Vocal 1', 'Vocal 1 · Rack 2'])
  })

  it('leaves a channel alone when its name is its own', () => {
    const mics = mergeMics(
      [mic({ id: 'k1', name: 'Lectern' })],
      [channel({ channelKey: '1', name: 'Vocal 1' })],
    )
    expect(mics.map((mic) => mic.name)).toEqual(['Lectern', 'Vocal 1'])
  })
})

describe('finding the cue on a microphone', () => {
  const linked = { ref: 'kit:k1', name: 'Ada — handheld', rx: 'rx:rack1:1', missing: false }

  it('answers to either of its names', () => {
    expect(cueFor(linked, cued('kit:k1', 'Ada'))?.name).toBe('Ada')
    expect(cueFor(linked, cued('rx:rack1:1', 'Vocal 1'))?.name).toBe('Vocal 1')
    expect(cueFor(linked, {})).toBeNull()
  })

  it('prefers the roster ref, which is the one its taps write', () => {
    const both: MicCues = {
      'kit:k1': { level: 'live', at: 2_000, name: 'Ada' },
      'rx:rack1:1': { level: 'standby', at: 1_000, name: 'Vocal 1' },
    }
    expect(cueFor(linked, both)?.level).toBe('live')
  })
})
