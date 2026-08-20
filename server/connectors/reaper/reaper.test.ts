import { describe, expect, it } from 'vitest'
import { reaperConfigSchema, reaperModule } from './index.js'
import {
  baseUrl,
  decodeTrackFlags,
  meterToDb,
  parseReaperResponse,
  playStateToTransport,
  splitRecords,
} from './protocol.js'

describe('splitRecords', () => {
  it('splits tab-separated records and drops blank lines', () => {
    expect(splitRecords('NTRACK\t3\n\nTRANSPORT\t0\t0\n')).toEqual([
      ['NTRACK', '3'],
      ['TRANSPORT', '0', '0'],
    ])
  })

  it('tolerates CRLF, which REAPER emits on Windows', () => {
    expect(splitRecords('NTRACK\t2\r\n')).toEqual([['NTRACK', '2']])
  })

  it('preserves empty fields rather than collapsing them', () => {
    // A track with no name arrives as an empty field, not a missing one, so
    // every later field would shift by one if these were dropped.
    expect(splitRecords('TRACK\t1\t\t64')).toEqual([['TRACK', '1', '', '64']])
  })
})

describe('playStateToTransport', () => {
  it('maps the states REAPER actually reports', () => {
    expect(playStateToTransport(0)).toBe('stopped')
    expect(playStateToTransport(1)).toBe('playing')
    expect(playStateToTransport(2)).toBe('paused')
    expect(playStateToTransport(5)).toBe('recording')
    expect(playStateToTransport(6)).toBe('record-paused')
  })

  it('refuses to guess at a code it does not know', () => {
    // Showing "playing" when the rig might be recording is worse than
    // admitting ignorance.
    expect(playStateToTransport(9)).toBe('unknown')
    expect(playStateToTransport(Number.NaN)).toBe('unknown')
  })
})

describe('decodeTrackFlags', () => {
  it('decodes each bit on its own', () => {
    expect(decodeTrackFlags(1).folder).toBe(true)
    expect(decodeTrackFlags(2).selected).toBe(true)
    expect(decodeTrackFlags(4).hasFx).toBe(true)
    expect(decodeTrackFlags(8).muted).toBe(true)
    expect(decodeTrackFlags(16).soloed).toBe(true)
    expect(decodeTrackFlags(32).soloInPlace).toBe(true)
    expect(decodeTrackFlags(64).recordArmed).toBe(true)
  })

  it('decodes a realistic armed-and-FX track', () => {
    // 68 = 64 (record-armed) + 4 (has FX): the normal state of a live input
    // channel with a gate on it.
    expect(decodeTrackFlags(68)).toMatchObject({
      recordArmed: true,
      hasFx: true,
      muted: false,
      soloed: false,
      folder: false,
    })
  })

  it('reports nothing set for zero and for nonsense', () => {
    expect(Object.values(decodeTrackFlags(0)).every((set) => set === false)).toBe(true)
    expect(Object.values(decodeTrackFlags(Number.NaN)).every((set) => set === false)).toBe(true)
  })
})

describe('meterToDb', () => {
  it('converts the wire format, which is dB × 10', () => {
    expect(meterToDb(0)).toBe(0)
    expect(meterToDb(-300)).toBe(-30)
    expect(meterToDb(-95)).toBe(-9.5)
  })

  it('treats an unreadable meter as silence rather than 0 dB', () => {
    // 0 dB is full scale. Guessing it from a broken field would paint every
    // meter on the wall red.
    expect(meterToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('parseReaperResponse', () => {
  const body = [
    'TRANSPORT\t5\t123.456000\t1\t2:03.456\t4.1.00',
    'NTRACK\t3',
    'TRACK\t1\tKick\t68\t1.000000\t0.000000\t-120\t-1\t0\t0',
    'TRACK\t2\tSnare\t8\t1.000000\t0.000000\t-95\t-1\t0\t0',
    'TRACK\t3\tAmbience\t16\t1.000000\t0.000000\t0\t-1\t0\t0',
    'EXTSTATE\tStageItLive\tdisk_free_mb\t512000',
    '',
  ].join('\n')

  it('reads the transport record', () => {
    expect(parseReaperResponse(body).transport).toEqual({
      state: 'recording',
      positionSeconds: 123.456,
      positionString: '2:03.456',
      isRepeatOn: true,
    })
  })

  it('reads the project track count separately from the track records', () => {
    const poll = parseReaperResponse(body)
    expect(poll.trackCount).toBe(3)
    expect(poll.tracks).toHaveLength(3)
  })

  it('decodes each track’s flags and meter', () => {
    const [kick, snare, ambience] = parseReaperResponse(body).tracks
    expect(kick).toEqual({
      number: 1,
      name: 'Kick',
      recordArmed: true,
      muted: false,
      soloed: false,
      peakDb: -12,
    })
    expect(snare).toMatchObject({ recordArmed: false, muted: true, peakDb: -9.5 })
    expect(ambience).toMatchObject({ soloed: true, peakDb: 0 })
  })

  it('reads extended state keyed by section and key', () => {
    expect(parseReaperResponse(body).extState.get('StageItLive/disk_free_mb')).toBe('512000')
  })

  it('names an unnamed track after its number', () => {
    // REAPER sends an empty name for a track nobody labelled; a blank row on
    // the wall where a channel should be is worse than "Track 7".
    const poll = parseReaperResponse('TRACK\t7\t\t0\t1\t0\t-200\t-1')
    expect(poll.tracks[0]?.name).toBe('Track 7')
  })

  it('ignores records it does not recognise', () => {
    // REAPER adds records between versions, and one of them must never take
    // an instance offline.
    const poll = parseReaperResponse('BEATPOS\t1\t2\t3\nNTRACK\t1\nSOMETHING_NEW\tx')
    expect(poll.trackCount).toBe(1)
    expect(poll.transport).toBeNull()
  })

  it('drops a malformed record without losing the good ones around it', () => {
    const poll = parseReaperResponse('TRANSPORT\tbanana\t?\nNTRACK\t4\nTRACK\tnope\tGhost\t64')
    expect(poll.transport).toBeNull()
    expect(poll.trackCount).toBe(4)
    expect(poll.tracks).toEqual([])
  })

  it('returns an empty result for a page that is not REAPER at all', () => {
    const poll = parseReaperResponse('<html><body>Guest network sign-in</body></html>')
    expect(poll).toMatchObject({ transport: null, trackCount: null, tracks: [] })
    expect(poll.extState.size).toBe(0)
  })

  it('copes with a transport record truncated mid-way', () => {
    const poll = parseReaperResponse('TRANSPORT\t0')
    expect(poll.transport).toEqual({
      state: 'stopped',
      positionSeconds: 0,
      positionString: '',
      isRepeatOn: false,
    })
  })
})

describe('baseUrl', () => {
  it('builds an ordinary origin', () => {
    expect(baseUrl('10.0.1.20', 8080)).toBe('http://10.0.1.20:8080')
  })

  it('brackets an IPv6 literal, which show networks hand out more than expected', () => {
    expect(baseUrl('::1', 8080)).toBe('http://[::1]:8080')
  })
})

describe('reaper config schema', () => {
  it('defaults to a stock REAPER web remote', () => {
    expect(reaperConfigSchema.parse({})).toEqual({
      host: '127.0.0.1',
      port: 8080,
      pollIntervalMs: 1_000,
      trackLimit: 64,
    })
  })

  it('refuses a poll interval that would hammer the record machine', () => {
    expect(reaperConfigSchema.safeParse({ pollIntervalMs: 10 }).success).toBe(false)
  })

  it('bounds the track limit', () => {
    expect(reaperConfigSchema.safeParse({ trackLimit: 0 }).success).toBe(false)
    expect(reaperConfigSchema.safeParse({ trackLimit: 513 }).success).toBe(false)
  })
})

describe('reaper module declaration', () => {
  it('marks the transport commands that can ruin a set as dangerous', () => {
    const byId = new Map(reaperModule.meta.commands.map((command) => [command.id, command]))
    expect(byId.get('record')?.dangerous).toBe(true)
    expect(byId.get('stop')?.dangerous).toBe(true)
    // Play cannot destroy a take, so it does not need a confirmation dialog
    // in front of it during a show.
    expect(byId.get('play')?.dangerous).toBeUndefined()
  })

  it('declares free disk space as a recorded metric', () => {
    const disk = reaperModule.meta.streams.find((stream) => stream.id === 'disk')
    expect(disk).toMatchObject({ rateClass: 'slow', history: 'metric', metricFields: ['freeMb'] })
  })
})
