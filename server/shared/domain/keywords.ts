/**
 * Finding the words that matter in a line of speech.
 *
 * ProdCom transcribes comms audio and lets an operator flag keywords, but its
 * API hands over the *rules* and not the *matches* — a transcript entry says
 * what was said and never which keywords it tripped. So the matching is ours,
 * and it has to happen twice: on the server, where a match becomes an alert and
 * a line in the show's timeline, and in the browser, where it becomes a
 * highlight. Two implementations would eventually disagree, and the day they
 * disagree is the day somebody is told nobody said their name.
 *
 * Hence one module, imported by both.
 */

/** A word worth noticing, and how to treat it. */
export interface Term {
  id: string
  text: string
  /** ProdCom's own highlight colour, where it set one. */
  colour?: string | null
  /** ProdCom blanks these on screen; we blank them before they are stored. */
  sensitive?: boolean
  /**
   * Require a word boundary either side.
   *
   * ProdCom matches plain substrings and our mirror of its keywords copies
   * that, so the two interfaces agree. Our own watch list defaults the other
   * way — see `WHOLE_WORD_BY_DEFAULT` below.
   */
  whole?: boolean
  source: 'prodcom' | 'watch'
}

/** Where a term was found. `end` is exclusive, as with `String.slice`. */
export interface Span {
  start: number
  end: number
  term: Term
}

/**
 * A watch list is names and roles, so it matches whole words.
 *
 * ProdCom's own keywords are substrings and we keep them that way. But a watch
 * list is "Dave", "LX", "medical" — and as substrings those hit "Davenport",
 * "flx" and, less obviously, any French crew member's "médical" not at all
 * while still firing on "medicals". A callout widget that cries wolf is one
 * people stop reading, and then it is worse than nothing.
 */
export const WHOLE_WORD_BY_DEFAULT = true

/**
 * What counts as part of a word, for boundary purposes.
 *
 * Deliberately not `\b`, which is defined over ASCII `[A-Za-z0-9_]` even under
 * the `u` flag: with `\b`, "Zoë" ends after "Zo" and a search for "Zo" would
 * report a whole-word hit. Letters, numbers and combining marks from any
 * script, which is what a festival crew list actually contains.
 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u

/**
 * Regexes are cached because the terms change once a show and the text changes
 * several times a second. Keyed by the pattern itself, so there is nothing to
 * invalidate; bounded only so an operator holding a key down cannot grow it
 * without limit.
 */
const CACHE_LIMIT = 500
const patterns = new Map<string, RegExp>()

function patternFor(text: string): RegExp {
  const cached = patterns.get(text)
  if (cached) return cached
  if (patterns.size >= CACHE_LIMIT) patterns.clear()
  /*
   * Matched with a regex rather than by lowercasing both sides and using
   * `indexOf`, because lowercasing can change a string's length — `'İ'` becomes
   * two characters — and every offset after it would then point at the wrong
   * place. The `i` and `u` flags together do proper case folding and still
   * report offsets into the original text.
   */
  const compiled = new RegExp(escapeForRegExp(text), 'giu')
  patterns.set(text, compiled)
  return compiled
}

/**
 * A keyword comes straight out of a text field in someone's preferences, so it
 * may contain anything. Unescaped, "(" is a syntax error that would take the
 * module down, and ".*" is a match on every line of the show.
 */
export function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isWholeWordAt(text: string, term: string, start: number, end: number): boolean {
  // Only require a boundary on a side where the term itself ends in a word
  // character. A term of "cue 12" has a digit at the end and a space in the
  // middle; a term of "—" has neither, and demanding boundaries around it
  // would mean it never matched anything.
  const leftMatters = WORD_CHAR.test(term.slice(0, 1))
  const rightMatters = WORD_CHAR.test(term.slice(-1))
  if (leftMatters && start > 0 && WORD_CHAR.test(text[start - 1] ?? '')) return false
  if (rightMatters && end < text.length && WORD_CHAR.test(text[end] ?? '')) return false
  return true
}

/**
 * Every place one of these terms appears, with the overlaps resolved.
 *
 * Returned in reading order and guaranteed not to overlap, because the callers
 * both walk the list in order — one to slice the text into highlighted runs,
 * the other to blank the sensitive ones. Two overlapping spans would produce
 * nested `<mark>` elements in the first case and mangled offsets in the second.
 *
 * Where two terms cover the same ground the longer one wins: an operator who
 * has flagged both "sound" and "sound check" meant the phrase when the phrase
 * is what was said.
 */
export function findMatches(text: string, terms: readonly Term[]): Span[] {
  if (text.length === 0) return []

  const found: Span[] = []
  for (const term of terms) {
    // An empty or blank term would otherwise match at every position in the
    // line. This is not hypothetical: it is what a trailing comma in the
    // comma-separated config field produces.
    const needle = term.text.trim()
    if (needle.length === 0) continue

    const whole = term.whole ?? false
    const pattern = patternFor(needle)
    pattern.lastIndex = 0

    let match = pattern.exec(text)
    while (match !== null) {
      const start = match.index
      const end = start + match[0].length
      if (!whole || isWholeWordAt(text, needle, start, end)) {
        found.push({ start, end, term })
      }
      // A zero-length match cannot happen here — the needle is non-empty — but
      // advancing explicitly keeps this loop safe if that ever changes.
      pattern.lastIndex = end > start ? end : start + 1
      match = pattern.exec(text)
    }
  }

  if (found.length < 2) return found

  /*
   * Sensitive first, then longest, then earliest.
   *
   * Sensitivity outranks length because losing an overlap means losing the
   * redaction. With longest-wins alone, a sensitive "code" nested inside a
   * non-sensitive "door code" was dropped from the result — so the text went
   * out unblanked *and* the covering keyword was emitted as a flag naming it.
   * The failure was silent and in the open direction, which is the worst shape
   * a redaction bug can have.
   *
   * Length still decides between two terms of equal sensitivity, so an operator
   * who has flagged both "sound" and "sound check" gets the phrase. Ties fall
   * back to position, and then to the order the terms arrived, so the result is
   * stable rather than dependent on how the engine happened to sort.
   */
  const byPreference = [...found].sort(
    (a, b) =>
      Number(b.term.sensitive ?? false) - Number(a.term.sensitive ?? false) ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  )

  const kept: Span[] = []
  for (const span of byPreference) {
    if (kept.some((other) => span.start < other.end && other.start < span.end)) continue
    kept.push(span)
  }
  return kept.sort((a, b) => a.start - b.start)
}

/**
 * Blank out the sensitive matches.
 *
 * ProdCom shows these as asterisks on its own screen. We do it in the connector
 * rather than the widget, before the line is published: the alternative puts
 * the raw text on our WebSocket bus and into SQLite, which is a wider exposure
 * than the one ProdCom was protecting against in the first place.
 *
 * Replaced character for character so that offsets either side stay valid —
 * whatever holds the line next can still highlight it without re-deriving
 * anything.
 */
export function redact(text: string, spans: readonly Span[]): string {
  const sensitive = spans.filter((span) => span.term.sensitive)
  if (sensitive.length === 0) return text

  let out = ''
  let cursor = 0
  for (const span of [...sensitive].sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue
    out += text.slice(cursor, span.start) + '*'.repeat(span.end - span.start)
    cursor = span.end
  }
  return out + text.slice(cursor)
}
