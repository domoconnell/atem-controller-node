import { describe, expect, it } from 'vitest'
import { LineSplitter } from './protocol.js'

describe('LineSplitter', () => {
  it('splits complete lines', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('a\nb\n')).toEqual(['a', 'b'])
  })

  it('holds a partial line until the rest arrives', () => {
    // This is the failure that bites every socket parser: TCP splits a frame
    // wherever it likes and the JSON parse blows up on half an object.
    const splitter = new LineSplitter()
    expect(splitter.push('{"type":"me')).toEqual([])
    expect(splitter.push('ter","value":1}\n')).toEqual(['{"type":"meter","value":1}'])
  })

  it('handles several frames arriving in one chunk', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
  })

  it('tolerates CRLF line endings', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('a\r\nb\r\n')).toEqual(['a', 'b'])
  })

  it('skips empty lines from keepalive newlines', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('\n\na\n\n')).toEqual(['a'])
  })

  it('discards an unbounded line rather than growing the heap', () => {
    // A device stuck mid-frame must not be able to exhaust memory on a Pi.
    const splitter = new LineSplitter(64)
    expect(splitter.push('x'.repeat(200))).toEqual([])
    expect(splitter.push('rest\n')).toEqual(['rest'])
  })

  it('drops buffered data on reset', () => {
    const splitter = new LineSplitter()
    splitter.push('partial')
    splitter.reset()
    expect(splitter.push(' line\n')).toEqual([' line'])
  })
})
