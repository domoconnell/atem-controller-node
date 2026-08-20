import { describe, expect, it } from 'vitest'
import { smaartConfigSchema } from './index.js'
import {
  byMetricKind,
  classifyControlFrame,
  DEFAULT_METRIC_NAMES,
  endpointPath,
  metricKind,
  parseCalibratedInputs,
  parseLoggedData,
  parseMetricsFrame,
  parseRootProperties,
  parseTimestamp,
  selectChannel,
  slugForMetric,
  slugMetricNames,
  unitForMetric,
} from './protocol.js'

describe('slugForMetric', () => {
  /*
   * The highest-stakes pure function in this connector. A slug becomes a series
   * name in SQLite, a value inside a saved widget configuration and a parameter
   * on an alert rule — so changing the rule later does not error, it quietly
   * orphans every one of them. These cases are the contract.
   */
  it.each([
    ['SPL A Fast', 'splAFast'],
    ['SPL A Slow', 'splASlow'],
    ['SPL C Fast', 'splCFast'],
    ['SPL Fast', 'splFast'],
    ['SPL Slow', 'splSlow'],
    ['LAeq 1', 'laeq1'],
    ['LCeq 1', 'lceq1'],
    ['Leq 1', 'leq1'],
    ['LAeq 10', 'laeq10'],
    ['LCeq 10', 'lceq10'],
    ['Leq 10', 'leq10'],
    ['Peak C', 'peakC'],
    ['FS Peak', 'fsPeak'],
  ])('%s becomes %s', (name, expected) => {
    expect(slugForMetric(name)).toBe(expected)
  })

  it('keeps the case of later tokens, which is what tells Leq and LAeq apart', () => {
    // Lowercasing throughout would collapse these two onto `laeq10`, and one
    // series holding two different measurements is evidence of nothing.
    expect(slugForMetric('LAeq 10')).not.toBe(slugForMetric('Leq 10'))
  })

  it.each([
    ['  SPL A Fast  ', 'splAFast'],
    ['SPL   A   Fast', 'splAFast'],
    ['LAeq', 'laeq'],
    ['10EaZy Leq 15', '10eazyLeq15'],
  ])('copes with %o', (input, expected) => {
    expect(slugForMetric(input)).toBe(expected)
  })

  it.each(['', '   ', '!!!'])('returns nothing usable for %o', (input) => {
    expect(slugForMetric(input)).toBe('')
  })

  it('produces a slug for every metric the specification documents', () => {
    for (const name of DEFAULT_METRIC_NAMES) {
      expect(slugForMetric(name), name).not.toBe('')
    }
  })
})

describe('slugMetricNames', () => {
  it('pairs each name with its slug, in order', () => {
    expect(slugMetricNames(['SPL A Fast', 'LAeq 10']).pairs).toEqual([
      { name: 'SPL A Fast', field: 'splAFast' },
      { name: 'LAeq 10', field: 'laeq10' },
    ])
  })

  it('keeps the first of two names that slug alike, and reports the loser', () => {
    const { pairs, collisions } = slugMetricNames(['SPL A Fast', 'SPL  A  Fast'])
    expect(pairs).toEqual([{ name: 'SPL A Fast', field: 'splAFast' }])
    expect(collisions).toEqual(['SPL  A  Fast'])
  })

  it('drops a name with nothing sluggable in it', () => {
    expect(slugMetricNames(['', '???']).pairs).toEqual([])
  })

  it('gives all fourteen documented metrics distinct slugs', () => {
    const { pairs, collisions } = slugMetricNames([...DEFAULT_METRIC_NAMES])
    expect(collisions).toEqual([])
    expect(new Set(pairs.map((pair) => pair.field)).size).toBe(DEFAULT_METRIC_NAMES.length)
  })
})

describe('classifyControlFrame', () => {
  it('reads a reply', () => {
    expect(
      classifyControlFrame({ sequenceNumber: 42, response: { applicationName: 'x' } }),
    ).toEqual({ kind: 'reply', sequenceNumber: 42, response: { applicationName: 'x' } })
  })

  it('reads a reply that carries no sequence number', () => {
    // The specification only echoes one if the request set a non-zero value.
    expect(classifyControlFrame({ response: { ok: true } })).toMatchObject({
      kind: 'reply',
      sequenceNumber: null,
    })
  })

  it.each(['authentication required', 'incorrect password', 'unknown target', 'read only'])(
    'reads the documented error %o',
    (message) => {
      expect(classifyControlFrame({ sequenceNumber: 1, response: { error: message } })).toEqual({
        kind: 'error',
        sequenceNumber: 1,
        message,
      })
    },
  )

  it.each([null, 'ok', 42, {}, { response: 'ok' }, { sequenceNumber: 1 }])(
    'calls %o unknown rather than throwing',
    (value) => {
      expect(classifyControlFrame(value)).toEqual({ kind: 'unknown' })
    },
  )
})

describe('parseRootProperties', () => {
  it('reads what the server says about itself', () => {
    expect(
      parseRootProperties({
        applicationName: 'Smaart Suite',
        applicationVersion: '9.0.2',
        authenticationRequired: false,
        machineName: 'SmaartServer',
      }),
    ).toEqual({
      applicationName: 'Smaart Suite',
      applicationVersion: '9.0.2',
      authenticationRequired: false,
    })
  })

  it('treats a missing authentication flag as no password, not as unknown', () => {
    expect(parseRootProperties({ applicationName: 'Smaart SPL' })?.authenticationRequired).toBe(
      false,
    )
  })

  it('refuses a response with no application name rather than inventing one', () => {
    expect(parseRootProperties({ authenticationRequired: true })).toBeNull()
  })
})

describe('parseCalibratedInputs', () => {
  const response = {
    devices: [
      {
        deviceName: 'Smaart I-O',
        activeCalibratedChannels: [
          {
            channelIndex: 0,
            channelName: 'Front Left',
            streamEndpoint: '/api/v4/devices/Smaart%20I-O/channels/Front%20Left',
            logEndpointPrefix: '/api/v4/logs/Smaart%20I-O/Front%20Left/',
          },
        ],
      },
      {
        deviceName: 'OCTA-CAPTURE',
        activeCalibratedChannels: [
          {
            channelIndex: 3,
            channelName: 'Mic 1',
            streamEndpoint: '/api/v4/devices/OCTA-CAPTURE/channels/Mic%201',
            logEndpointPrefix: '/api/v4/logs/OCTA-CAPTURE/Mic%201/',
            alarms: [{ level: 110, metric: 'SPL A Slow' }],
          },
        ],
      },
    ],
    metrics: ['FS Peak', 'Peak C', 'SPL Fast'],
    colorThresholds: [{ greenAboveLevel: 80, yellowAboveLevel: 100, redAboveLevel: 103 }],
  }

  it('flattens devices and channels into one list', () => {
    const inputs = parseCalibratedInputs(response)
    expect(
      inputs.channels.map((channel) => `${channel.deviceName}/${channel.channelName}`),
    ).toEqual(['Smaart I-O/Front Left', 'OCTA-CAPTURE/Mic 1'])
  })

  it('carries the alarms Smaart has configured for itself', () => {
    const inputs = parseCalibratedInputs(response)
    expect(inputs.channels[0]?.alarms).toEqual([])
    expect(inputs.channels[1]?.alarms).toEqual([{ metric: 'SPL A Slow', level: 110 }])
  })

  it('carries the authoritative metric list and the display thresholds', () => {
    const inputs = parseCalibratedInputs(response)
    expect(inputs.metricNames).toEqual(['FS Peak', 'Peak C', 'SPL Fast'])
    expect(inputs.colorThresholds).toEqual([
      { greenAboveLevel: 80, yellowAboveLevel: 100, redAboveLevel: 103 },
    ])
  })

  it('does not offer a channel whose stream endpoint could not be used', () => {
    // Not an error worth dropping the link over: it simply is not selectable.
    const inputs = parseCalibratedInputs({
      devices: [
        {
          deviceName: 'Rogue',
          activeCalibratedChannels: [
            { channelName: 'Elsewhere', streamEndpoint: 'ws://attacker.example/api/v4/x' },
            { channelName: '', streamEndpoint: '/api/v4/devices/a/channels/b' },
          ],
        },
      ],
    })
    expect(inputs.channels).toEqual([])
  })

  it.each([{}, { devices: 'lots' }, { devices: [{ activeCalibratedChannels: 'two' }] }])(
    'returns an empty result for %o rather than throwing',
    (value) => {
      expect(parseCalibratedInputs(value).channels).toEqual([])
    },
  )
})

describe('endpointPath', () => {
  it('accepts a plain path under the API root', () => {
    expect(endpointPath('/api/v4/devices/a/channels/b')).toBe('/api/v4/devices/a/channels/b')
  })

  it.each([
    'ws://elsewhere.example/api/v4/x',
    'http://elsewhere.example/api/v4/x',
    '//elsewhere.example/api/v4/x',
    '/api/v4/../../etc/passwd',
    '/other/v4/x',
    '',
    42,
    null,
  ])('refuses %o', (value) => {
    // These arrive over the network and get turned into a URL a socket opens.
    expect(endpointPath(value)).toBeNull()
  })
})

describe('selectChannel', () => {
  const channels = [
    { deviceName: 'Smaart I-O', channelName: 'Front Left' },
    { deviceName: 'OCTA-CAPTURE', channelName: 'Mic 1' },
  ].map((channel) => ({
    ...channel,
    channelIndex: 0,
    streamEndpoint: '/api/v4/x',
    logEndpointPrefix: null,
    alarms: [],
  }))

  it('takes the first when nothing is configured', () => {
    expect(selectChannel(channels)?.channelName).toBe('Front Left')
    expect(selectChannel(channels, '  ', '')?.channelName).toBe('Front Left')
  })

  it('matches on channel name alone', () => {
    expect(selectChannel(channels, '', 'Mic 1')?.deviceName).toBe('OCTA-CAPTURE')
  })

  it('matches on device and channel together', () => {
    expect(selectChannel(channels, 'OCTA-CAPTURE', 'Mic 1')?.channelIndex).toBe(0)
  })

  it('matches whatever case somebody typed it in at 2am', () => {
    expect(selectChannel(channels, 'octa-capture', 'mic 1')?.channelName).toBe('Mic 1')
  })

  it('finds nothing rather than falling back when the name is wrong', () => {
    // Falling back to the first channel would log the wrong measurement
    // position under the right name, which is worse than logging nothing.
    expect(selectChannel(channels, '', 'Delay Tower')).toBeNull()
    expect(selectChannel([], '', '')).toBeNull()
  })
})

describe('parseMetricsFrame', () => {
  const frame = {
    timestamp: '2022-04-02:T16:20:00.000-5:00',
    deviceName: 'Smaart I-O',
    channelName: 'Front Left',
    metrics: [{ 'FS Peak': -54.41 }, { 'SPL A Fast': 69.86 }, { 'LAeq 10': 74.9, violation: true }],
  }

  it('flattens the array of single-key objects into slugged readings', () => {
    expect(parseMetricsFrame(frame)?.values).toEqual({
      fsPeak: -54.41,
      splAFast: 69.86,
      laeq10: 74.9,
    })
  })

  it("collects Smaart's own alarm breaches", () => {
    expect(parseMetricsFrame(frame)?.violations).toEqual(['laeq10'])
  })

  it('carries where the reading came from and when', () => {
    const parsed = parseMetricsFrame(frame)
    expect(parsed?.deviceName).toBe('Smaart I-O')
    expect(parsed?.channelName).toBe('Front Left')
    expect(parsed?.ts).toBe(Date.parse('2022-04-02T16:20:00.000-05:00'))
  })

  it('leaves an unreadable metric out rather than calling it zero', () => {
    // A gap in a noise log is defensible at a licensing hearing. An invented
    // 0 dB reading is not.
    const parsed = parseMetricsFrame({
      metrics: [{ 'SPL A Fast': 'loud' }, { 'SPL A Slow': null }, { 'LAeq 1': Number.NaN }],
    })
    expect(parsed?.values).toEqual({})
  })

  it.each([{}, { metrics: 'none' }, null, 'frame'])('returns null for %o', (value) => {
    expect(parseMetricsFrame(value)).toBeNull()
  })
})

describe('parseLoggedData', () => {
  it('reads a batch of logged points', () => {
    expect(
      parseLoggedData({
        deviceName: 'Smaart I-O',
        channelName: 'Front Left',
        metricName: 'SPL A Slow',
        loggedData: [
          { timestamp: '2022-04-02:T16:20:00.000-5:00', value: 57.16 },
          { timestamp: '2022-04-02:T16:20:01.000-5:00', value: 103.2, violation: true },
          { timestamp: '2022-04-02:T16:20:02.000-5:00', value: 60.1, overload: true },
        ],
      }),
    ).toEqual({
      metricName: 'SPL A Slow',
      points: [
        {
          ts: Date.parse('2022-04-02T16:20:00.000-05:00'),
          value: 57.16,
          violation: false,
          overload: false,
        },
        {
          ts: Date.parse('2022-04-02T16:20:01.000-05:00'),
          value: 103.2,
          violation: true,
          overload: false,
        },
        {
          ts: Date.parse('2022-04-02T16:20:02.000-05:00'),
          value: 60.1,
          violation: false,
          overload: true,
        },
      ],
    })
  })

  it('drops a point with no usable timestamp rather than stamping it now', () => {
    // The whole reason to prefer Smaart's log is that it is stamped by the
    // instrument. A point we had to date ourselves is not that.
    const batch = parseLoggedData({
      metricName: 'LAeq 10',
      loggedData: [{ value: 57.16 }, { timestamp: 'yesterday', value: 60 }],
    })
    expect(batch?.points).toEqual([])
  })

  it('accepts an empty batch, which is what a metric with no log yet returns', () => {
    expect(parseLoggedData({ metricName: 'LAeq 10', loggedData: [] })).toEqual({
      metricName: 'LAeq 10',
      points: [],
    })
  })

  it.each([{}, { loggedData: [] }, null])('returns null for %o', (value) => {
    expect(parseLoggedData(value)).toBeNull()
  })
})

describe('parseTimestamp', () => {
  it('repairs the malformed shape the specification itself prints', () => {
    // `2022-04-02:T16:20:00.000-5:00` — a stray colon before the T and a
    // single-digit offset hour. Both appear in the vendor's own examples, so a
    // real server may well send them.
    expect(parseTimestamp('2022-04-02:T16:20:00.000-5:00')).toBe(
      Date.parse('2022-04-02T16:20:00.000-05:00'),
    )
  })

  it('reads a well-formed timestamp unchanged', () => {
    expect(parseTimestamp('2026-08-28T21:00:00.000Z')).toBe(Date.parse('2026-08-28T21:00:00.000Z'))
  })

  it.each(['', 'yesterday', 42, null])('returns null for %o', (value) => {
    expect(parseTimestamp(value)).toBeNull()
  })
})

describe('the module configuration', () => {
  it('refuses more mirrored logs than Smaart can serve', () => {
    /*
     * Four is not a style preference. Measured against a 9.6.4: the fifth log
     * subscription onwards opened and then delivered nothing at all, which
     * looks configured and records nothing. This cap was written once and
     * silently lost in an edit that did not apply — hence a test for it.
     */
    const four = ['SPL A Slow', 'LAeq 1', 'LAeq 5', 'LAeq 15']
    expect(smaartConfigSchema.safeParse({ logMetrics: four }).success).toBe(true)
    expect(smaartConfigSchema.safeParse({ logMetrics: [...four, 'LCeq 1'] }).success).toBe(false)
  })

  it('mirrors nothing unless asked, because every log costs a subscription', () => {
    expect(smaartConfigSchema.parse({}).logMetrics).toEqual([])
  })
})

describe('what a metric is, and what to print beside it', () => {
  it('calls a sound level a level, whatever its weighting or window', () => {
    for (const name of ['SPL A Slow', 'SPL Fast', 'LAeq 1', 'LAeq 15', 'Leq 1', 'LCeq 1']) {
      expect(metricKind(name), name).toBe('level')
      expect(unitForMetric(name), name).toBe('dB')
    }
  })

  it('separates a peak from a level', () => {
    expect(metricKind('Peak C')).toBe('peak')
    expect(unitForMetric('Peak C')).toBe('dB')
  })

  it('does not call a digital full-scale peak a sound level', () => {
    /*
     * `FS Peak` is one by name and not by nature: dBFS, idling around −145,
     * which beside a room's 78 dB reads as a broken widget rather than a
     * different scale. Smaart itself refuses to log it.
     */
    expect(metricKind('FS Peak')).toBe('other')
    expect(unitForMetric('FS Peak')).toBe('dBFS')
  })

  it('prints no unit for an exposure figure, rather than a plausible one', () => {
    /*
     * `Exposure O` and `Exposure N` appear in no Smaart documentation we have
     * found. They are presumably OSHA and NIOSH dose, which would make them
     * percentages — and "presumably" is not a unit to print beside a
     * compliance figure. ProdCom taught this: a plausible reading of an
     * undocumented field is still a guess.
     */
    expect(metricKind('Exposure O')).toBe('other')
    expect(unitForMetric('Exposure O')).toBeUndefined()
    expect(unitForMetric('Exposure N')).toBeUndefined()
  })
})

describe('the order metrics are offered in', () => {
  /** What a real 9.6.4 reported, in the order it reported it. */
  const asReported = [
    'FS Peak',
    'Peak C',
    'SPL Fast',
    'SPL A Fast',
    'SPL A Slow',
    'LAeq 1',
    'LAeq 5',
    'LAeq 15',
    'Exposure O',
    'Exposure N',
  ].map((name) => ({ name }))

  it('puts the levels first and the things that are not levels last', () => {
    // The machine's order leads with `FS Peak` and trails with the two Leq
    // windows a licence is most likely written around. Exactly backwards.
    const order = byMetricKind(asReported).map((metric) => metric.name)

    expect(order.slice(0, 6)).toEqual([
      'SPL Fast',
      'SPL A Fast',
      'SPL A Slow',
      'LAeq 1',
      'LAeq 5',
      'LAeq 15',
    ])
    expect(order.slice(-3)).toEqual(['FS Peak', 'Exposure O', 'Exposure N'])
  })

  it('keeps the machine’s order within a kind, and drops nothing', () => {
    /*
     * Which Leq window matters is the rig's business. A connector that thought
     * it knew would sort the wrong one to the top — and a list that dropped
     * anything would decide a licence question it has no standing to decide.
     */
    const order = byMetricKind(asReported).map((metric) => metric.name)
    expect(order).toHaveLength(asReported.length)
    expect(order.indexOf('LAeq 5')).toBeLessThan(order.indexOf('LAeq 15'))
    expect(new Set(order).size).toBe(asReported.length)
  })
})
