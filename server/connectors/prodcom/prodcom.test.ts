import { describe, expect, it } from 'vitest'
import {
  channelWanted,
  feedMessageFrom,
  type ProdComChannel,
  type ProdComEntry,
  ProdComError,
  parseEntry,
  parseKeywords,
  parseSseBlock,
  parseTranscriptPage,
  readEventFrame,
  takeSseBlocks,
  termsFor,
  unwrap,
} from './protocol.js'

/**
 * The parsers, on their own.
 *
 * Most of what follows is about what ProdCom might send that the document does
 * not promise: this is a 0.1.0 API the vendor still calls in development, and
 * the whole design of this connector assumes it will change under us.
 */

const entryBody = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  channelId: 'c1',
  channelName: 'Stage Left TB',
  text: 'Standby for cue 12',
  source: 'audio',
  inProgress: false,
  hasBeenSeen: false,
  date: '2026-04-13T14:28:15Z',
  completeDate: '2026-04-13T14:28:18Z',
  seenDate: null,
  translatedText: null,
  triggeredAutomations: [],
  ...over,
})

const channel: ProdComChannel = {
  id: 'c1',
  name: 'Stage Left TB',
  colour: '#FF6B35',
  sourceType: 'localAudio',
  locale: 'en-GB',
  typingEnabled: false,
  unread: 0,
  keywords: [],
}

describe('the response envelope', () => {
  it('hands back the data', () => {
    expect(unwrap({ data: { pong: true }, meta: {} })).toEqual({ pong: true })
  })

  it('throws what the server actually complained about', () => {
    const body = { error: { code: 'UNAUTHORIZED', message: 'API key required' }, meta: {} }
    expect(() => unwrap(body)).toThrow(ProdComError)
    try {
      unwrap(body)
    } catch (error) {
      // The distinction that matters: a wrong key is a well-formed 401 body,
      // and reporting it as "no reply from ProdCom" sends somebody to check
      // network cabling over a typo in a settings field.
      expect((error as ProdComError).code).toBe('UNAUTHORIZED')
      expect((error as ProdComError).message).toBe('API key required')
    }
  })

  it('does not mistake a body it cannot read for an empty one', () => {
    expect(() => unwrap('nonsense')).toThrow(ProdComError)
  })
})

describe('reading a transcript entry', () => {
  it('reads the documented shape', () => {
    const entry = parseEntry(entryBody())
    expect(entry?.id).toBe('e1')
    expect(entry?.text).toBe('Standby for cue 12')
    expect(entry?.live).toBe(false)
    expect(entry?.at).toBe(Date.parse('2026-04-13T14:28:15Z'))
  })

  it('drops an entry with nothing to identify or place it', () => {
    // Both are unusable rather than merely odd: without an id a completing
    // line cannot replace the half-heard one, and without a date it cannot be
    // put in order.
    expect(parseEntry(entryBody({ id: undefined }))).toBeNull()
    expect(parseEntry(entryBody({ date: 'not a date' }))).toBeNull()
  })

  it('falls back to audio for a source it has never heard of', () => {
    expect(parseEntry(entryBody({ source: 'telepathy' }))?.source).toBe('audio')
  })

  it('ignores fields it was not expecting', () => {
    expect(parseEntry(entryBody({ somethingNew: { nested: true } }))?.id).toBe('e1')
  })

  it('reads the count out of meta, not out of the array', () => {
    const page = parseTranscriptPage({
      data: [entryBody()],
      meta: { totalCount: 47, hasMore: true },
    })
    expect(page.entries).toHaveLength(1)
    expect(page.totalCount).toBe(47)
    expect(page.hasMore).toBe(true)
  })
})

describe('the WebSocket frame reader', () => {
  it('knows the two housekeeping frames', () => {
    expect(readEventFrame('{"type":"welcome"}').kind).toBe('welcome')
    expect(readEventFrame('{"type":"heartbeat"}').kind).toBe('heartbeat')
  })

  /*
   * The document specifies the handshake and then describes events only as
   * "JSON-framed". Rather than bet on one wrapper, the reader looks in each
   * place a reasonable implementation would put an entry — so whichever it
   * turns out to be, this already reads it.
   */
  it.each([
    ['at the top level', (body: unknown) => body],
    ['under data', (body: unknown) => ({ type: 'transcript', data: body })],
    ['under entry', (body: unknown) => ({ type: 'transcript.created', entry: body })],
    ['under payload', (body: unknown) => ({ event: 'transcript', payload: body })],
    ['under transcript', (body: unknown) => ({ transcript: body })],
  ])('finds an entry %s', (_where, wrap) => {
    const frame = readEventFrame(JSON.stringify(wrap(entryBody())))
    expect(frame.kind).toBe('entry')
    expect(frame.kind === 'entry' && frame.entry.text).toBe('Standby for cue 12')
  })

  it('shrugs at anything else rather than throwing', () => {
    expect(readEventFrame('not json at all {{{').kind).toBe('unknown')
    expect(readEventFrame('null').kind).toBe('unknown')
    expect(readEventFrame('{"type":"automation","name":"Flash"}').kind).toBe('unknown')
  })
})

describe('the event stream, as ProdCom actually sends it', () => {
  /*
   * Captured from ProdCom 2.3.2 on the bench. The document points at the
   * WebSocket; the WebSocket sends nothing. This is the live path.
   */
  const added =
    'event: transcript.added\n' +
    'data: {"source":"audio","date":"2026-08-12T21:20:13Z","channelName":"Test",' +
    '"id":"77A79DFD-12CA-4731-B47C-D9594D9C5C2B","hasBeenSeen":false,"inProgress":true,' +
    '"channelId":"23B9DC17-2164-4E57-BD22-854E6D3DEAA8","text":" okay"}'

  const updated = added
    .replace('transcript.added', 'transcript.updated')
    .replace('" okay"', '" okay I\'m saying"')

  it('reads an entry out of a block', () => {
    const entry = parseSseBlock(added)
    expect(entry?.id).toBe('77A79DFD-12CA-4731-B47C-D9594D9C5C2B')
    expect(entry?.text).toBe(' okay')
    expect(entry?.live).toBe(true)
  })

  it('keeps the same id as the words arrive, which is what makes it one line', () => {
    // The whole upsert design rests on this. Measured, not assumed.
    expect(parseSseBlock(updated)?.id).toBe(parseSseBlock(added)?.id)
    expect(parseSseBlock(updated)?.text).toBe(" okay I'm saying")
  })

  it('shrugs at a block it cannot read', () => {
    expect(parseSseBlock('event: nonsense\ndata: {{{ not json')).toBeNull()
    expect(parseSseBlock(': just a comment')).toBeNull()
    expect(parseSseBlock('data: [DONE]')).toBeNull()
  })

  it('holds back a block that has not finished arriving', () => {
    /*
     * A chunk boundary lands mid-block often enough that not doing this drops
     * lines at random — a fault that looks like the recogniser misbehaving
     * rather than like our bug.
     */
    const { blocks, rest } = takeSseBlocks(`${added}\n\nevent: transcript.upda`)
    expect(blocks).toHaveLength(1)
    expect(rest).toBe('event: transcript.upda')
  })

  it('copes with carriage returns and blank padding', () => {
    const { blocks } = takeSseBlocks(`${added.replace(/\n/g, '\r\n')}\r\n\r\n`)
    expect(blocks).toHaveLength(1)
    expect(parseSseBlock(blocks[0] ?? '')?.text).toBe(' okay')
  })
})

describe('building the term list', () => {
  const global = parseKeywords([
    {
      id: 'k1',
      text: 'standby',
      shouldHighlight: true,
      highlightColor: '#FF0',
      isSensitive: false,
    },
    { id: 'k2', text: 'door code', shouldHighlight: true, isSensitive: true },
  ])

  it("copies ProdCom's substring matching so the two interfaces agree", () => {
    const terms = termsFor({ global })
    expect(terms.every((term) => term.whole === false)).toBe(true)
  })

  it('matches our own watch words as whole words by default', () => {
    const terms = termsFor({ global: [], watchWords: ['Dave'] })
    expect(terms[0]?.whole).toBe(true)
    expect(terms[0]?.source).toBe('watch')
  })

  it('keeps a sensitive keyword even when it is not for highlighting', () => {
    const quiet = parseKeywords([
      { id: 'k9', text: 'door code', shouldHighlight: false, isSensitive: true },
    ])
    // Dropping it would leave the text unredacted, which is the one outcome
    // that must not happen.
    expect(termsFor({ global: quiet })).toHaveLength(1)
  })

  it('only applies a group’s keywords to channels in that group', () => {
    const groups = [
      {
        id: 'g1',
        name: 'Stage',
        channelIds: ['c9'],
        keywords: parseKeywords([{ id: 'k3', text: 'rigging' }]),
      },
    ]
    expect(termsFor({ global: [], groups, channel }).some((t) => t.text === 'rigging')).toBe(false)
    expect(
      termsFor({ global: [], groups, channel: { ...channel, id: 'c9' } }).some(
        (t) => t.text === 'rigging',
      ),
    ).toBe(true)
  })
})

describe('turning an entry into a published line', () => {
  const entry: ProdComEntry = {
    id: 'e1',
    channelId: 'c1',
    channelName: null,
    text: 'Standby, the door code is 4721',
    source: 'audio',
    live: false,
    at: 1_700_000_000_000,
    completedAt: null,
    translated: null,
  }

  it('blanks a sensitive match before the line is published at all', () => {
    const terms = termsFor({
      global: parseKeywords([{ id: 'k2', text: 'door code', isSensitive: true }]),
    })
    const message = feedMessageFrom(entry, channel, terms)
    // The reason this is here and not in the browser: anything published
    // crosses the realtime bus and can be written to the event database.
    expect(message.text).not.toContain('door code')
    expect(message.text).toContain('*********')
    expect(message.redacted).toBe(true)
  })

  it('blanks the translation too, against its own matches', () => {
    // The translation is a second string, not a view of the first. Redacting
    // only `text` would publish the same secret in the other language, to the
    // same bus and the same database — and a code or a name is exactly what a
    // translator leaves alone.
    const terms = termsFor({
      global: parseKeywords([{ id: 'k2', text: 'door code', isSensitive: true }]),
    })
    const message = feedMessageFrom(
      { ...entry, translated: 'Attention, le door code est 4721' },
      channel,
      terms,
    )
    expect(message.translated).not.toContain('door code')
    expect(message.translated).toContain('*********')
    expect(message.redacted).toBe(true)
  })

  it('leaves a translation with nothing sensitive in it alone', () => {
    const terms = termsFor({ global: parseKeywords([{ id: 'k1', text: 'standby' }]) })
    const message = feedMessageFrom({ ...entry, translated: 'Rien à signaler' }, channel, terms)
    expect(message.translated).toBe('Rien à signaler')
  })

  it('reports one flag per keyword and carries the channel colour', () => {
    const terms = termsFor({
      global: parseKeywords([{ id: 'k1', text: 'standby', highlightColor: '#FF0' }]),
      watchWords: ['Dave'],
    })
    const message = feedMessageFrom({ ...entry, text: 'Standby Dave, standby' }, channel, terms)
    expect(message.flags).toHaveLength(2)
    expect(message.flags.map((flag) => flag.source).sort()).toEqual(['prodcom', 'watch'])
    expect(message.colour).toBe('#FF6B35')
  })

  it('names the channel even when nothing else knows it', () => {
    expect(feedMessageFrom(entry, null, []).channel).toBe('Unknown channel')
    expect(feedMessageFrom({ ...entry, channelName: 'FOH' }, null, []).channel).toBe('FOH')
  })
})

describe('choosing channels', () => {
  it('takes a name or an id, and treats an empty list as all of them', () => {
    expect(channelWanted(channel, [])).toBe(true)
    expect(channelWanted(channel, ['c1'])).toBe(true)
    expect(channelWanted(channel, ['stage left tb'])).toBe(true)
    expect(channelWanted(channel, ['FOH'])).toBe(false)
  })
})
