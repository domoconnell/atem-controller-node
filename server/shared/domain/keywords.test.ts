import { describe, expect, it } from 'vitest'
import { escapeForRegExp, findMatches, redact, type Term } from './keywords.js'

/**
 * This is the piece that decides whether somebody is told their name was said.
 * A miss is the failure that matters — the widget looks like it is working
 * right up until the evening it isn't — so most of what follows is about the
 * ways a naive substring search gets it wrong.
 */

const prodcom = (text: string, extra: Partial<Term> = {}): Term => ({
  id: `p:${text}`,
  text,
  source: 'prodcom',
  ...extra,
})

const watch = (text: string, extra: Partial<Term> = {}): Term => ({
  id: `w:${text}`,
  text,
  source: 'watch',
  whole: true,
  ...extra,
})

/** The matched substrings, which is what nearly every assertion is about. */
const hits = (text: string, terms: readonly Term[]): string[] =>
  findMatches(text, terms).map((span) => text.slice(span.start, span.end))

describe('finding keywords in a line', () => {
  it('finds a word wherever it sits in the line', () => {
    expect(hits('Standby for cue 12', [prodcom('cue')])).toEqual(['cue'])
  })

  it('does not care about case, in either direction', () => {
    expect(hits('STANDBY EVERYONE', [prodcom('standby')])).toEqual(['STANDBY'])
    expect(hits('standby everyone', [prodcom('STANDBY')])).toEqual(['standby'])
  })

  it('finds every occurrence, not just the first', () => {
    expect(hits('cue 12, then cue 13', [prodcom('cue')])).toEqual(['cue', 'cue'])
  })

  it('reports matches in reading order whatever order the terms came in', () => {
    const spans = findMatches('Dave to stage, cue 12', [prodcom('cue'), watch('Dave')])
    expect(spans.map((span) => span.term.text)).toEqual(['Dave', 'cue'])
  })

  it('says nothing about a line with nothing in it', () => {
    expect(findMatches('', [prodcom('cue')])).toEqual([])
    expect(findMatches('all quiet', [])).toEqual([])
  })
})

describe('whole-word matching, which is what a watch list needs', () => {
  it('does not hit a longer word that merely contains the name', () => {
    expect(hits('Ask Davenport about it', [watch('Dave')])).toEqual([])
    expect(hits('the flx unit', [watch('LX')])).toEqual([])
  })

  it('still hits the name on its own, and next to punctuation', () => {
    expect(hits('Dave, to stage', [watch('Dave')])).toEqual(['Dave'])
    expect(hits('(Dave)', [watch('Dave')])).toEqual(['Dave'])
    expect(hits('Dave', [watch('Dave')])).toEqual(['Dave'])
  })

  it('treats accented letters as part of the word, unlike \\b', () => {
    // The bug this guards: with \b, "Zoe" is a whole-word match inside "Zoë"
    // because the accented character is not an ASCII word character.
    expect(hits('Zoë to stage', [watch('Zoe')])).toEqual([])
    expect(hits('Zoë to stage', [watch('Zoë')])).toEqual(['Zoë'])
    expect(hits('Ask Siân', [watch('Siâ')])).toEqual([])
  })

  it('only demands a boundary where the term itself has one', () => {
    // "cue 12" ends in a digit, so the right-hand side matters...
    expect(hits('cue 123', [watch('cue 12')])).toEqual([])
    // ...but a term of pure punctuation would never match if we insisted.
    expect(hits('standby — go', [watch('—')])).toEqual(['—'])
  })

  it('leaves ProdCom keywords matching as substrings, as ProdCom does', () => {
    // Deliberately the opposite of the watch-list default: our highlighting has
    // to agree with what the operator sees in ProdCom's own window.
    expect(hits('Ask Davenport', [prodcom('Dave')])).toEqual(['Dave'])
  })
})

describe('overlaps', () => {
  it('prefers the longer phrase when two terms cover the same words', () => {
    expect(hits('do a sound check', [prodcom('sound'), prodcom('sound check')])).toEqual([
      'sound check',
    ])
  })

  it('never returns two spans that overlap', () => {
    const terms = [prodcom('stage left'), prodcom('left'), prodcom('age')]
    const spans = findMatches('go to stage left now', terms)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.start).toBeGreaterThanOrEqual(spans[i - 1]?.end ?? 0)
    }
  })

  it('keeps both when they merely sit next to each other', () => {
    expect(hits('cue go', [prodcom('cue'), prodcom('go')])).toEqual(['cue', 'go'])
  })

  it('lets a sensitive term win an overlap even when it is the shorter one', () => {
    /*
     * The regression this exists for. With longest-wins alone, a sensitive
     * "code" nested inside a non-sensitive "door code" lost the overlap and was
     * dropped from the result — so the text went out unblanked *and* the
     * covering keyword was published as a flag naming it. Silent, and failing
     * in the open direction.
     */
    const text = 'the door code is 4721'
    const terms = [prodcom('code', { sensitive: true }), prodcom('door code')]
    expect(hits(text, terms)).toEqual(['code'])
    expect(redact(text, findMatches(text, terms))).toBe('the door **** is 4721')
  })
})

describe('terms that would otherwise break something', () => {
  it('treats a keyword as text, not as a pattern', () => {
    // Unescaped, this is a match on every line of the show.
    expect(hits('nothing special here', [prodcom('.*')])).toEqual([])
    expect(hits('a .* literal', [prodcom('.*')])).toEqual(['.*'])
  })

  it('survives a keyword that is not valid regex syntax', () => {
    // Unescaped, `new RegExp('(')` throws and takes the module down with it.
    expect(() => findMatches('mic 1 (spare)', [prodcom('(')])).not.toThrow()
    expect(hits('mic 1 (spare)', [prodcom('(spare)')])).toEqual(['(spare)'])
  })

  it('ignores blank terms rather than matching everywhere', () => {
    // A trailing comma in the comma-separated config field produces exactly
    // this, and matching it everywhere would highlight the entire show.
    expect(hits('anything at all', [prodcom(''), prodcom('   ')])).toEqual([])
  })

  it('escapes every metacharacter it claims to', () => {
    const escaped = escapeForRegExp('.*+?^${}()|[]\\')
    expect(() => new RegExp(escaped)).not.toThrow()
    expect(new RegExp(escaped).test('.*+?^${}()|[]\\')).toBe(true)
  })
})

describe('redacting the sensitive ones', () => {
  const secret = prodcom('bank details', { sensitive: true })

  it('replaces the match and leaves the rest of the line alone', () => {
    const text = 'send the bank details over'
    expect(redact(text, findMatches(text, [secret]))).toBe('send the ************ over')
  })

  it('keeps the line the same length, so offsets either side still hold', () => {
    const text = 'send the bank details over'
    const out = redact(text, findMatches(text, [secret]))
    expect(out).toHaveLength(text.length)
    expect(out.indexOf('over')).toBe(text.indexOf('over'))
  })

  it('leaves a line with nothing sensitive in it untouched', () => {
    const text = 'standby for cue 12'
    expect(redact(text, findMatches(text, [prodcom('cue')]))).toBe(text)
  })

  it('blanks every occurrence, not only the first', () => {
    const text = 'code red, then code red again'
    const term = prodcom('code red', { sensitive: true })
    expect(redact(text, findMatches(text, [term]))).toBe('********, then ******** again')
  })
})
