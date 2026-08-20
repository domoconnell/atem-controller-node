import { describe, expect, it } from 'vitest'
import { withConnector } from '../../../test/connector-harness.js'
import { companionModule } from '../companion/index.js'
import { demoModule } from '../demo/index.js'
import { digicoModule } from '../digico/index.js'
import { hyperdeckModule } from '../hyperdeck/index.js'
import { netcheckModule } from '../netcheck/index.js'
import { prodcomModule } from '../prodcom/index.js'
import { propresenterModule } from '../propresenter/index.js'
import { qlabModule } from '../qlab/index.js'
import { reaperModule } from '../reaper/index.js'
import { sennheiserModule } from '../sennheiser/index.js'
import { smaartModule } from '../smaart/index.js'
import { sysmonModule } from '../sysmon/index.js'
import { unifiModule } from '../unifi/index.js'
import { weatherModule } from '../weather/index.js'
import type { ConnectorModule } from './types.js'

/**
 * Declared fields have to be real fields.
 *
 * A stream's `fields` are what the Add widget dialogue binds a new widget to,
 * so a declaration that has drifted from the payload does not fail loudly —
 * it produces a widget that opens complaining, which is exactly the defect
 * declaring fields was introduced to remove. A list of names in a different
 * file from the code that builds the payload will drift; the only question is
 * whether anything notices.
 *
 * Every connector ships a simulator speaking its real wire protocol, so this
 * checks the declarations against actual frames rather than against a second
 * list written by the same hand on the same day.
 */

const MODULES: ConnectorModule<never>[] = [
  smaartModule,
  propresenterModule,
  qlabModule,
  reaperModule,
  hyperdeckModule,
  companionModule,
  demoModule,
  weatherModule,
  netcheckModule,
  sysmonModule,
  sennheiserModule,
  unifiModule,
  digicoModule,
  prodcomModule,
] as ConnectorModule<never>[]

/**
 * Streams no simulator emits unprompted, so this test cannot speak for them.
 *
 * Named rather than skipped silently: if a stream that used to be observable
 * stops being observable, that shows up here as an unexpected entry instead of
 * quietly dropping out of coverage. None of them declares fields today, and
 * adding fields to one means teaching its simulator to emit it first.
 *
 * `netcheck.speed` is the one that will never leave this list: the speed test
 * is off unless configured and measures against a host on the internet, so
 * there is nothing honest for a simulator to say.
 */
const NOT_EMITTED_UNPROMPTED = new Set([
  'netcheck.speed',
  'qlab.running',
  'digico.messages',
  'digico.snapshots',
  'digico.channels',
  'propresenter.timers',
  // An overload is a fault, not a reading. A simulator that produced one on a
  // healthy rig every four seconds would be teaching the wrong thing about
  // the board; `smaart.integration.test.ts` drives it deliberately instead.
  'smaart.overload',
])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const kindOf = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'object'
        ? 'object'
        : typeof value

describe('declared stream fields', () => {
  it('only names numeric fields as metrics', () => {
    // Pure, and it catches the cheapest kind of drift: a metric recorded for
    // history that the field list has since renamed or dropped.
    for (const module of MODULES) {
      for (const stream of module.meta.streams) {
        if (!stream.metricFields?.length || !stream.fields?.length) continue
        const numbers = stream.fields.filter((f) => f.kind === 'number').map((f) => f.id)
        for (const metric of stream.metricFields) {
          expect(
            numbers,
            `${module.meta.typeId}.${stream.id}: metric "${metric}" is not a declared number field`,
          ).toContain(metric)
        }
      }
    }
  })

  it('declares no duplicate field ids', () => {
    for (const module of MODULES) {
      for (const stream of module.meta.streams) {
        const ids = (stream.fields ?? []).map((f) => f.id)
        expect(new Set(ids).size, `${module.meta.typeId}.${stream.id} repeats a field`).toBe(
          ids.length,
        )
      }
    }
  })

  for (const module of MODULES) {
    const { typeId, streams } = module.meta

    // Concurrent, and each one stops as soon as it has what it needs.
    //
    // These thirteen used to wait a flat 2.5s each, one after another, which
    // made this file 33s and the whole server suite's critical path — it took
    // the run from 15s to 33s on its own. Nothing here waits on anything real;
    // every simulator is a local socket.
    it.concurrent(`${typeId}: every declared field appears in a simulated frame`, async () => {
      const observed = new Map<string, Map<string, string>>()

      await withConnector(module, {}, async ({ recorder }) => {
        const drain = () => {
          for (const frame of recorder.frames) {
            const payload = frame.payload as Record<string, unknown> | null
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
            const seen = observed.get(frame.streamId) ?? new Map<string, string>()
            for (const [key, value] of Object.entries(payload)) {
              const kind = kindOf(value)
              // A field seen as null once and a number later is a number: the
              // declaration describes the field, not one moment of it.
              if (kind !== null && !seen.has(key)) seen.set(key, kind)
            }
            observed.set(frame.streamId, seen)
          }
        }

        // Everything this test can assert on: every declared field seen, and
        // every stream heard from at least once. Waiting past that point only
        // slows the suite down, and stopping before it would make the failure
        // "not yet" rather than "not true".
        const settled = () =>
          streams.every((stream) => {
            if (NOT_EMITTED_UNPROMPTED.has(`${typeId}.${stream.id}`)) return true
            const seen = observed.get(stream.id)
            if (!seen) return false
            return (stream.fields ?? []).every((field) => seen.has(field.id))
          })

        const deadline = Date.now() + 4000
        do {
          await sleep(50)
          drain()
        } while (!settled() && Date.now() < deadline)
      })

      for (const stream of streams) {
        if (!stream.fields?.length) continue
        const seen = observed.get(stream.id)
        expect(seen, `${typeId}.${stream.id} declares fields but emitted no frame`).toBeDefined()

        for (const field of stream.fields) {
          expect(
            seen?.get(field.id),
            `${typeId}.${stream.id}.${field.id} declared as ${field.kind}`,
          ).toBe(field.kind)
        }
      }

      // Coverage, stated: a stream that emitted nothing is a stream this
      // test says nothing about, so the set of those has to be deliberate.
      const silent = streams
        .filter((stream) => !observed.has(stream.id))
        .map((stream) => `${typeId}.${stream.id}`)
      for (const name of silent) {
        expect(
          NOT_EMITTED_UNPROMPTED.has(name),
          `${name} emitted nothing — add it to NOT_EMITTED_UNPROMPTED, or teach the simulator to emit it`,
        ).toBe(true)
      }
    }, 20_000)
  }
})
