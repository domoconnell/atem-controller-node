import { describe, expect, it } from 'vitest'
import { type ConfigOptions, optionsFor } from './configOptions.js'

const options: ConfigOptions = {
  deviceName: [{ value: 'Scarlett 18i20' }, { value: 'Dante Virtual Soundcard' }],
  channelName: [
    { value: 'FOH Left', when: { field: 'deviceName', equals: 'Scarlett 18i20' } },
    { value: 'FOH Right', when: { field: 'deviceName', equals: 'Scarlett 18i20' } },
    { value: 'Delay Tower', when: { field: 'deviceName', equals: 'Dante Virtual Soundcard' } },
  ],
}

describe('offering what the equipment reported', () => {
  it('offers every device, because a device depends on nothing', () => {
    expect(optionsFor('deviceName', options, {}).map((o) => o.value)).toEqual([
      'Scarlett 18i20',
      'Dante Virtual Soundcard',
    ])
  })

  it('narrows the channels once a device is chosen', () => {
    const chosen = { deviceName: 'Dante Virtual Soundcard' }
    expect(optionsFor('channelName', options, chosen).map((o) => o.value)).toEqual(['Delay Tower'])
  })

  it('offers every channel while no device is chosen', () => {
    /*
     * Blank means "whichever device Smaart lists first", so this is somebody
     * with no preference rather than somebody with no channels. Narrowing to
     * nothing here would say the second thing.
     */
    expect(optionsFor('channelName', options, {}).map((o) => o.value)).toHaveLength(3)
    expect(optionsFor('channelName', options, { deviceName: '' }).map((o) => o.value)).toHaveLength(
      3,
    )
  })

  it('offers nothing for a device that reported nothing, rather than everything', () => {
    // A name typed by hand for a machine that was not on the network. It is
    // still a legitimate value; it simply has no channels to suggest under it.
    const typed = { deviceName: 'The one in the rack, probably' }
    expect(optionsFor('channelName', options, typed)).toEqual([])
  })

  it('says nothing about a field the equipment did not describe', () => {
    expect(optionsFor('host', options, {})).toEqual([])
  })
})
