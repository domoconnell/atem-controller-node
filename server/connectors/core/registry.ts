import { type TypeCatalogueEntry, typeCatalogueEntrySchema } from '@stageit/shared'
import { z } from 'zod'
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
 * Every connector type the server was built with. Static imports on purpose:
 * dynamic plugin loading would mean arbitrary code execution configured
 * through a web form on a show network.
 */
const MODULES: readonly ConnectorModule<never>[] = [
  smaartModule as ConnectorModule<never>,
  propresenterModule as ConnectorModule<never>,
  qlabModule as ConnectorModule<never>,
  reaperModule as ConnectorModule<never>,
  hyperdeckModule as ConnectorModule<never>,
  companionModule as ConnectorModule<never>,
  demoModule as ConnectorModule<never>,
  weatherModule as ConnectorModule<never>,
  netcheckModule as ConnectorModule<never>,
  sysmonModule as ConnectorModule<never>,
  sennheiserModule as ConnectorModule<never>,
  unifiModule as ConnectorModule<never>,
  digicoModule as ConnectorModule<never>,
  prodcomModule as ConnectorModule<never>,
]

export class ConnectorRegistry {
  private readonly byType = new Map<string, ConnectorModule<unknown>>()

  constructor(modules: readonly ConnectorModule<never>[] = MODULES) {
    for (const module of modules) {
      if (this.byType.has(module.meta.typeId)) {
        throw new Error(`Duplicate connector typeId: ${module.meta.typeId}`)
      }
      this.byType.set(module.meta.typeId, module as ConnectorModule<unknown>)
    }
  }

  /**
   * Every registered module, including the unproven ones.
   *
   * Used where an *existing* instance still needs its declarations honoured —
   * the alert-rule condition catalogue, most of all. Hiding a module from the
   * shop window must not take away the ability to write a rule against one
   * somebody is already running.
   */
  all(): ConnectorModule<unknown>[] {
    return [...this.byType.values()]
  }

  get(typeId: string): ConnectorModule<unknown> | undefined {
    return this.byType.get(typeId)
  }

  has(typeId: string): boolean {
    return this.byType.has(typeId)
  }

  /**
   * The modules on offer: everything except the unproven ones.
   *
   * This is what the admin form renders and what demo mode seeds, so a module
   * nobody has run against the real equipment is neither addable nor
   * advertised. See `ConnectorMeta.unproven` for why that is a stronger claim
   * than "the tests pass".
   */
  list(): ConnectorModule<unknown>[] {
    return [...this.byType.values()].filter((module) => module.meta.unproven !== true)
  }

  /** The catalogue the admin UI renders forms from. */
  catalogue(modules: ConnectorModule<unknown>[] = this.list()): TypeCatalogueEntry[] {
    return modules.map((module) => {
      const { meta } = module
      return typeCatalogueEntrySchema.parse({
        typeId: meta.typeId,
        displayName: meta.displayName,
        description: meta.description,
        configJsonSchema: toJsonSchema(meta.configSchema),
        streams: meta.streams.map((s) => ({
          id: s.id,
          label: s.label,
          rateClass: s.rateClass,
          history: s.history ?? 'none',
          // Copied one key at a time, so anything added to a declaration and
          // not added here silently never reaches the browser. That is how
          // `fields` was lost the first time: declared on all thirteen
          // connectors, verified against their simulators, and still absent
          // from the catalogue the Add widget dialogue reads.
          fields: (s.fields ?? []).map((f) => ({
            id: f.id,
            kind: f.kind,
            label: f.label ?? null,
            unit: f.unit ?? null,
          })),
        })),
        commands: meta.commands.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description ?? null,
          dangerous: c.dangerous ?? false,
          inputJsonSchema: toJsonSchema(c.inputSchema),
        })),
        capabilities: {
          control: meta.capabilities.control,
          /*
           * Derived from whether the module can actually answer, not declared.
           *
           * It was a `meta` flag that nothing set and nothing read. A
           * capability a module announces separately from the code that
           * provides it is a capability that will one day be announced
           * falsely — and the cost lands on somebody pressing a button in the
           * admin form and getting a 404 from a module that said it could.
           */
          discovery: module.discoverConfigOptions !== undefined,
        },
        tier: meta.tier ?? 'official',
        vendorNotes: meta.vendorNotes ?? null,
      })
    })
  }
}

/** Zod schemas double as the source of the admin form; never let this throw. */
export function toJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input' })
  } catch {
    return { type: 'object' }
  }
}
