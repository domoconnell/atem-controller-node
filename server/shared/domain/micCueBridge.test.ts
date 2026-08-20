import { describe, expect, it } from 'vitest'
import {
  bindingForSlug,
  cueValue,
  micCueBindingSchema,
  oscCueAddress,
  parseOscCueAddress,
  saveMicCueBindingsSchema,
  variableFor,
} from './micCueBridge.js'

const binding = (over: Partial<{ ref: string; slug: string; instanceId: string | null }> = {}) => ({
  ref: 'kit:abc',
  slug: 'mc2',
  instanceId: null,
  ...over,
})

describe('mic cue bindings', () => {
  it('lower-cases the slug on the way in', () => {
    // Companion variable names are case-sensitive, so `MC2` and `mc2` would be
    // two variables and one of them would never be written.
    const parsed = micCueBindingSchema.parse(binding({ slug: '  MC2  ' }))
    expect(parsed.slug).toBe('mc2')
  })

  it('refuses a slug that would not survive being a variable name', () => {
    for (const slug of ['mc 2', 'mc.2', '-mc2', '', 'a'.repeat(41), 'mc/2']) {
      expect(micCueBindingSchema.safeParse(binding({ slug })).success, slug).toBe(false)
    }
    for (const slug of ['mc2', 'lectern', 'vox_1', 'a-b-c', '2']) {
      expect(micCueBindingSchema.safeParse(binding({ slug })).success, slug).toBe(true)
    }
  })

  it('refuses a reference that is not one', () => {
    expect(micCueBindingSchema.safeParse(binding({ ref: 'nonsense' })).success).toBe(false)
    expect(micCueBindingSchema.safeParse(binding({ ref: 'rx:rack1:2' })).success).toBe(true)
  })

  it('refuses two keys claiming one name', () => {
    const result = saveMicCueBindingsSchema.safeParse({
      bindings: [binding({ ref: 'kit:a' }), binding({ ref: 'kit:b' })],
    })
    expect(result.success).toBe(false)
  })

  it('refuses one microphone on two keys', () => {
    // Two variables for one mic means one of them goes stale the first time
    // somebody cues it, and a key showing the wrong colour is believed.
    const result = saveMicCueBindingsSchema.safeParse({
      bindings: [binding({ slug: 'mc2' }), binding({ slug: 'compere' })],
    })
    expect(result.success).toBe(false)
  })

  it('allows the wiring the page will actually save', () => {
    const result = saveMicCueBindingsSchema.safeParse({
      bindings: [
        binding({ slug: 'mc1', ref: 'kit:a', instanceId: 'companion1' }),
        binding({ slug: 'mc2', ref: 'kit:b', instanceId: 'companion1' }),
        binding({ slug: 'vox1', ref: 'rx:rack1:1', instanceId: null }),
      ],
    })
    expect(result.success).toBe(true)
  })

  it('names one variable per slug, and says off rather than nothing', () => {
    expect(variableFor('mc2')).toBe('sil_mc2')
    expect(cueValue('standby')).toBe('standby')
    expect(cueValue('live')).toBe('live')
    // Not an empty string: a cleared variable and one never set look the same
    // on a Companion button, and the difference is what somebody debugging needs.
    expect(cueValue(null)).toBe('off')
  })

  it('looks a slug up the way Companion will send it', () => {
    const bindings = [binding({ slug: 'mc2' })]
    expect(bindingForSlug(bindings, 'mc2')?.ref).toBe('kit:abc')
    expect(bindingForSlug(bindings, ' MC2 ')?.ref).toBe('kit:abc')
    expect(bindingForSlug(bindings, 'mc9')).toBeUndefined()
  })

  describe('the OSC address', () => {
    it('round-trips every level the page can offer', () => {
      for (const level of ['standby', 'live', 'off', 'next'] as const) {
        expect(parseOscCueAddress(oscCueAddress('mc2', level))).toEqual({ slug: 'mc2', level })
      }
    })

    it('means next when the level is left off, because that is what a key does', () => {
      expect(parseOscCueAddress('/sil/mc2')).toEqual({ slug: 'mc2', level: 'next' })
    })

    it('refuses what it cannot act on rather than guessing', () => {
      // A typo'd level is the whole reason this returns null instead of
      // defaulting: `nxt` silently meaning `next` would hide the mistake for
      // as long as the key happened to do the right thing.
      expect(parseOscCueAddress('/sil/mc2/nxt')).toBeNull()
      expect(parseOscCueAddress('/sil/')).toBeNull()
      expect(parseOscCueAddress('/sil')).toBeNull()
      expect(parseOscCueAddress('/sil/mc2/next/extra')).toBeNull()
      // Close but not ours: the namespace is a whole segment, not a substring.
      expect(parseOscCueAddress('/silly/mc2/next')).toBeNull()
      expect(parseOscCueAddress('/mc2/next')).toBeNull()
      expect(parseOscCueAddress('/other/thing')).toBeNull()
      // A console broadcasting its own OSC across the subnet reaches this port
      // all evening; none of it may be mistaken for a cue.
      expect(parseOscCueAddress('/Input_Channels/1/fader')).toBeNull()
    })

    it('keeps a slug that has an underscore in it', () => {
      expect(parseOscCueAddress(oscCueAddress('mc_2', 'live'))).toEqual({
        slug: 'mc_2',
        level: 'live',
      })
    })

    it('names the address and the variable from the one slug', () => {
      // The pair an operator types into two fields of the same Companion
      // action. They are derived from the same string on purpose.
      expect(oscCueAddress('mc1', 'live')).toBe('/sil/mc1/live')
      expect(variableFor('mc1')).toBe('sil_mc1')
    })

    it('finds the microphone the page named, whatever case it arrives in', () => {
      const bindings = [binding({ slug: 'mc2' })]
      const parsed = parseOscCueAddress('/sil/MC2/live')
      expect(parsed).not.toBeNull()
      expect(bindingForSlug(bindings, (parsed as { slug: string }).slug)?.ref).toBe('kit:abc')
    })
  })
})
