import { describe, expect, it } from 'vitest'
import {
  HyperDeckResponseAssembler,
  isAsyncCode,
  isSuccessCode,
  parseDevice,
  parseSlot,
  parseTransport,
} from './protocol.js'

const TRANSPORT_BLOCK =
  '208 transport info:\r\nstatus: play\r\nspeed: 100\r\nslot id: 2\r\nclip id: 3\r\n' +
  'display timecode: 01:02:03:04\r\ntimecode: 01:02:03:04\r\nvideo format: 1080p25\r\n\r\n'

describe('HyperDeckResponseAssembler', () => {
  it('reads a multi-line response terminated by a blank line', () => {
    const assembler = new HyperDeckResponseAssembler()
    const [response] = assembler.push(TRANSPORT_BLOCK)

    expect(response).toMatchObject({ code: 208, text: 'transport info', asynchronous: false })
    expect(response?.fields).toMatchObject({
      status: 'play',
      speed: '100',
      'slot id': '2',
      // The value's own colons must survive: only the first one separates.
      timecode: '01:02:03:04',
    })
  })

  it('reads a single-line response with no fields', () => {
    const assembler = new HyperDeckResponseAssembler()
    expect(assembler.push('200 ok\r\n')).toEqual([
      { code: 200, text: 'ok', fields: {}, asynchronous: false },
    ])
  })

  it('accepts the indented field lines the protocol document shows', () => {
    // Blackmagic print the fields indented; shipping firmware does not send
    // them that way, and neither form may change what we parse.
    const assembler = new HyperDeckResponseAssembler()
    const [response] = assembler.push(
      '202 slot info:\r\n    slot id: 1\r\n    status: mounted\r\n    recording time: 4200\r\n\r\n',
    )
    expect(response?.fields).toEqual({
      'slot id': '1',
      status: 'mounted',
      'recording time': '4200',
    })
  })

  it('holds a response split across chunks, including mid-line', () => {
    const assembler = new HyperDeckResponseAssembler()
    expect(assembler.push('208 transport info:\r\nstatus: pl')).toEqual([])
    expect(assembler.push('ay\r\nspeed: 100\r\n')).toEqual([])

    const [response] = assembler.push('\r\n')
    expect(response?.fields).toEqual({ status: 'play', speed: '100' })
  })

  it('closes a block when the blank line lands in the next chunk', () => {
    // The terminator itself gets split by TCP more often than anything else.
    const assembler = new HyperDeckResponseAssembler()
    expect(assembler.push('202 slot info:\r\nstatus: mounted\r\n\r')).toEqual([])
    expect(assembler.push('\n').map((r) => r.text)).toEqual(['slot info'])
  })

  it('separates several responses arriving in one chunk', () => {
    const assembler = new HyperDeckResponseAssembler()
    const responses = assembler.push(
      `${TRANSPORT_BLOCK}200 ok\r\n502 slot info:\r\nstatus: empty\r\n\r\n`,
    )

    expect(responses.map((r) => `${r.code} ${r.text}`)).toEqual([
      '208 transport info',
      '200 ok',
      '502 slot info',
    ])
  })

  it('closes a block on the next header when the deck omits the blank line', () => {
    const assembler = new HyperDeckResponseAssembler()
    const responses = assembler.push('208 transport info:\r\nstatus: play\r\n200 ok\r\n')

    expect(responses.map((r) => r.code)).toEqual([208, 200])
    expect(responses[0]?.fields).toEqual({ status: 'play' })
  })

  it('marks 5xx responses as pushed by the device', () => {
    const assembler = new HyperDeckResponseAssembler()
    const [banner] = assembler.push(
      '500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio Mini\r\n\r\n',
    )

    expect(banner?.asynchronous).toBe(true)
    expect(parseDevice(banner?.fields ?? {})).toEqual({
      model: 'HyperDeck Studio Mini',
      protocolVersion: '1.11',
    })
  })

  it('ignores junk without losing the response that follows it', () => {
    const assembler = new HyperDeckResponseAssembler()
    expect(
      assembler.push('!!! nonsense\r\nstatus: orphan\r\n999\r\n\r\n200 ok\r\n').map((r) => r.code),
    ).toEqual([200])
  })

  it('drops a half-parsed block on reset', () => {
    const assembler = new HyperDeckResponseAssembler()
    assembler.push('208 transport info:\r\nstatus: play\r\n')
    assembler.reset()
    expect(assembler.push('200 ok\r\n')).toEqual([
      { code: 200, text: 'ok', fields: {}, asynchronous: false },
    ])
  })
})

describe('response codes', () => {
  it('treats 2xx as success and 1xx as the errors they are', () => {
    // "120 no video input" is an error despite the low number; the protocol
    // puts its failures in the 1xx range and its successes in 2xx.
    expect(isSuccessCode(200)).toBe(true)
    expect(isSuccessCode(208)).toBe(true)
    expect(isSuccessCode(120)).toBe(false)
    expect(isSuccessCode(100)).toBe(false)
    expect(isSuccessCode(500)).toBe(false)
  })

  it('recognises the asynchronous range', () => {
    expect(isAsyncCode(508)).toBe(true)
    expect(isAsyncCode(500)).toBe(true)
    expect(isAsyncCode(208)).toBe(false)
  })
})

describe('field parsing', () => {
  it('reads a transport block into the shape the dashboard renders', () => {
    expect(
      parseTransport({
        status: 'record',
        speed: '0',
        'slot id': '2',
        'clip id': '7',
        timecode: '10:11:12:13',
        'display timecode': '10:11:12:13',
      }),
    ).toEqual({
      status: 'record',
      speed: 0,
      slotId: 2,
      clipId: 7,
      timecode: '10:11:12:13',
      displayTimecode: '10:11:12:13',
    })
  })

  it('reports missing transport fields as null rather than zero', () => {
    // A slot id of 0 and an unknown slot id are different things, and only one
    // of them should reach a wall display.
    expect(parseTransport({ status: 'stopped' })).toEqual({
      status: 'stopped',
      speed: null,
      slotId: null,
      clipId: null,
      timecode: null,
      displayTimecode: null,
    })
  })

  it('reads recording time left off a slot block', () => {
    expect(
      parseSlot({
        'slot id': '1',
        status: 'mounted',
        'volume name': 'HyperDeck 1',
        'recording time': '4200',
        'video format': '1080p25',
      }),
    ).toEqual({
      slotId: 1,
      status: 'mounted',
      volumeName: 'HyperDeck 1',
      recordingTimeSeconds: 4200,
      videoFormat: '1080p25',
    })
  })

  it('survives an empty slot with no card in it', () => {
    expect(parseSlot({ 'slot id': '2', status: 'empty' })).toEqual({
      slotId: 2,
      status: 'empty',
      volumeName: null,
      recordingTimeSeconds: null,
      videoFormat: null,
    })
  })
})
