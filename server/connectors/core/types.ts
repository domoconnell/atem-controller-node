import type {
  CommandResult,
  ConfigOptions,
  ConnectorState,
  InstanceStatus,
  RateClass,
  Severity,
} from '@stageit/shared'
import type { Logger } from 'pino'
import type { z } from 'zod'

/**
 * One scalar a stream's payload carries.
 *
 * Declared in reading order: the first number is the headline value and the
 * first string is the one that says what the thing is doing, because that is
 * what a newly added widget binds itself to. Streams whose payload is a
 * collection declare nothing — there is no single value to point at.
 */
export interface FieldDecl {
  id: string
  kind: 'number' | 'string' | 'boolean'
  /** Only worth setting where the id would not read well on screen. */
  label?: string
  unit?: string
}

/** A stream a connector type can emit. Declared up front so the UI can offer it. */
export interface StreamDecl {
  id: string
  label: string
  rateClass: RateClass
  /**
   * What history to keep. `metric` samples numeric fields into the metrics
   * table (SPL compliance logs); `events` records each change in the timeline.
   */
  history?: 'none' | 'events' | 'metric'
  /** Numeric fields to record when history is 'metric'. */
  metricFields?: readonly string[]
  /** The scalars a widget can be pointed at. See `FieldDecl`. */
  fields?: readonly FieldDecl[]
}

export interface CommandDecl<I = unknown> {
  id: string
  label: string
  description?: string
  inputSchema: z.ZodType<I>
  /** Requires an explicit confirmation in the UI (power off, record stop...). */
  dangerous?: boolean
}

/** One evaluated item: a channel, a track, a disk — or the instance itself. */
export interface ConditionItemResult {
  /** Omit for whole-instance conditions. Widgets filter their rows by this. */
  itemKey?: string
  itemLabel?: string
  active: boolean
  value?: number | string
  detail?: string
}

/**
 * A named thing that can be wrong with a module.
 *
 * One declaration serves two purposes: it drives "show problems only" on a
 * widget, and it is the vocabulary an admin picks from when writing an alert
 * rule. Declaring them on the connector keeps that vocabulary honest — a
 * condition can only exist if the data behind it actually exists.
 */
export interface ConditionDecl<P = unknown> {
  id: string
  label: string
  description?: string
  /** Which stream's payloads to inspect. */
  streamId: string
  paramsSchema: z.ZodType<P>
  defaultParams: P
  defaultSeverity: Severity
  /**
   * Must be pure and cheap: this runs on the publish path, which for meters
   * means several times a second per instance.
   *
   * `wasActive` answers "is this item's problem already up?", which is what a
   * threshold needs in order not to chatter — see `overThreshold`. Optional so
   * that a condition with nothing to hold steady, like a device being in a
   * named state, need not mention it.
   */
  evaluate(
    payload: unknown,
    params: P,
    wasActive?: (itemKey?: string) => boolean,
  ): ConditionItemResult[]

  /**
   * What to offer for this condition's parameters, for one instance.
   *
   * Some parameters name a thing the equipment has — a metric, a variable, a
   * timer, a channel — and nobody knows those by heart. Left as bare text
   * boxes they are filled in from memory or from a screenshot, and a typo
   * produces a rule that is saved happily and never fires.
   *
   * **Suggestions, not a closed list.** They reach `SchemaForm` as a
   * `datalist`, so the field goes on accepting anything typed. That is not
   * timidity: the Leq windows a Smaart offers are configured inside Smaart, so
   * no list can be complete, and a dropdown that looked authoritative while
   * omitting the window somebody's licence is written around would be worse
   * than the text box it replaced.
   *
   * Optional, and most conditions want nothing: a threshold in dB or minutes
   * is a number somebody genuinely does know.
   */
  paramOptions?(source: ConditionOptionSource): ConfigOptions
}

/**
 * What a condition may look at to work out its suggestions.
 *
 * Two sources, because either alone has a hole. The **live payload** is the
 * truth about what this instance is publishing right now, and is empty when
 * the module is offline — which is most of the week before load-in, and is
 * exactly when somebody sits down to write the alert rules. **Recorded
 * series** survive that, and are stale by definition: they include names the
 * equipment has since stopped using.
 *
 * A condition should prefer the payload when there is one. `WidgetConfigDialog`
 * learned the same lesson the hard way and carries a mutation guard about it.
 */
export interface ConditionOptionSource {
  /** The condition's stream, as last published. Null when nothing has arrived. */
  payload: unknown
  /**
   * Metric series recorded for this instance, as `<streamId>.<field>`.
   * Use `fieldsFromSeries` to get the bare field names for one stream.
   */
  recordedSeries: readonly string[]
}

/**
 * The field names a stream has recorded, from `<streamId>.<field>` series.
 *
 * Here rather than in each connector because the prefix is the recorder's
 * convention, not any one module's.
 */
export function fieldsFromSeries(series: readonly string[], streamId: string): string[] {
  const prefix = `${streamId}.`
  return series
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((name) => name.length > 0)
}

export interface ConnectorMeta<C = unknown> {
  typeId: string
  displayName: string
  description: string
  configSchema: z.ZodType<C>
  streams: readonly StreamDecl[]
  commands: readonly CommandDecl[]
  /** What can be wrong with this module; drives problems-only and alerts. */
  conditions?: readonly ConditionDecl[]
  /**
   * `discovery` is not declared here — the registry derives it from whether
   * the module implements `discoverConfigOptions`, so it cannot be announced
   * by a module that cannot do it.
   */
  capabilities: { control: boolean }
  /**
   * Honest labelling, surfaced in the admin UI. Some vendors give us a
   * documented API; others give us a reverse-engineered read-only channel, and
   * crew deserve to know which is which before they trust a number on a wall.
   */
  tier?: 'official' | 'stable-unofficial' | 'caveated' | 'workaround'
  /**
   * Built, tested against its simulator, and **never run against the real
   * equipment** — so not offered in the admin form.
   *
   * The distinction this draws is between "we implemented the documentation"
   * and "we know it works", and this project has been burned by the gap
   * twice: ProdCom's documented WebSocket transcript stream connects and then
   * never sends anything, and Companion's HTTP API refuses to create the
   * custom variable its own docs imply it will. A simulator written from a
   * specification inherits the specification's mistakes, so a green suite says
   * nothing about a module nobody has plugged in.
   *
   * Offering one in the form invites somebody to build a wall around it. The
   * type stays registered and stays creatable through the API, so an instance
   * that already exists — or arrives in a restored backup — keeps running and
   * keeps its history. This hides it from the shop window, nothing more.
   *
   * Clear the flag when somebody has run it against the actual hardware and
   * written down what the hardware said. That write-up is the point.
   */
  unproven?: boolean
  vendorNotes?: string
}

/**
 * What a running connector is handed. Every capability here is scoped to one
 * instance and one lifecycle generation: after `stop()`, publishes and timers
 * from a straggling callback are dropped rather than corrupting live state.
 */
export interface ConnectorContext<C = unknown> {
  readonly instanceId: string
  readonly instanceName: string
  readonly config: C
  readonly simulate: boolean
  readonly logger: Logger
  /** Aborted when the connector is stopped — pass to sockets and fetch(). */
  readonly signal: AbortSignal

  /**
   * Where the event is, or null if nobody has said.
   *
   * A function rather than a value so a connector reads it at poll time:
   * correcting the venue coordinates on the active event then takes effect on
   * the next fetch instead of at the next restart, and somebody fixing a typo
   * an hour before doors should not have to bounce a module to see it.
   */
  venue(): { latitude: number; longitude: number } | null

  /**
   * Content spoken at or before this must not be published. Zero normally.
   *
   * An administrator has taken something off the walls — see `comms/purge.ts`.
   * A function rather than a value for the same reason as `venue`: it is read
   * at publish time, so a purge takes effect on the next tick rather than at
   * the next restart, which is the entire point of the button.
   *
   * Only a connector that publishes **speech** need consult it. A meter
   * reading is not something anybody asks to have hidden.
   */
  purgedBefore(): number

  publish(streamId: string, payload: unknown): void

  /**
   * Hand over readings the *device* timestamped.
   *
   * Everything else here is live: `publish` is stamped with arrival time and
   * sampled down by the recorder, which is right for telemetry and wrong for
   * evidence. A device that keeps its own log — Smaart does — knows when each
   * reading was taken, and can replay what it logged while we were not
   * connected. Writes go to the same table, so retention, the CSV export and
   * the trend on a widget all keep working; only the clock changes.
   *
   * Idempotent by construction: the metrics table is keyed on instance, series
   * and timestamp, so replaying the same points twice writes nothing the
   * second time.
   */
  recordHistory(points: readonly HistoryPoint[]): void
  /** Report healthy operation. Anything worse is reported through `fail()`. */
  setStatus(state: 'online' | 'degraded', detail?: string): void
  /** Report a lost connection; the supervisor reconnects with backoff. */
  fail(error: unknown, detail?: string): void

  setInterval(fn: () => void, ms: number): () => void
  setTimeout(fn: () => void, ms: number): () => void
}

export interface Connector<C = unknown> {
  /**
   * Establish the connection. May return before the device answers — call
   * `ctx.setStatus('online')` once data is actually flowing.
   */
  start(ctx: ConnectorContext<C>): Promise<void> | void
  /** Release sockets and timers. Must settle quickly; 5s then force-disposed. */
  stop(): Promise<void> | void
  exec?(commandId: string, input: unknown): Promise<CommandResult>
}

/** A fake device speaking the real wire protocol, for tests and demo mode. */
/**
 * Where a running simulator can be reached.
 *
 * `port` is the main one — the protocol the connector is fundamentally about.
 * `ports` carries the others for equipment that speaks more than one, which is
 * commoner than it sounds: Companion takes HTTP on 8000 and OSC on 12321, and
 * a simulator binding both has to say so or a test can only ever exercise one.
 * Ephemeral in tests, so neither number can be assumed.
 */
export interface SimulatorAddress {
  host: string
  port: number
  ports?: Record<string, number>
}

export interface SimulatorHandle {
  listen(host?: string, port?: number): Promise<SimulatorAddress>
  close(): Promise<void>
  /** Force-close current client connections, to exercise reconnect paths. */
  dropConnections?(): void
  /** Emit protocol-violating data, to prove the parser can't take us down. */
  sendGarbage?(): void
}

export interface ConnectorModule<C = unknown> {
  meta: ConnectorMeta<C>
  create(): Connector<C>
  /**
   * Required for every type: it powers the integration tests, demo mode, and
   * lets crew build and rehearse a dashboard before the trucks arrive.
   */
  createSimulator(): SimulatorHandle
  /** Point a config at the simulator's ephemeral address. */
  simulatedConfig(address: SimulatorAddress, base: C): C
  /**
   * Ask the equipment what its config fields could be set to.
   *
   * Optional, and most modules will never want it. It exists because some
   * fields name something only the device knows — Smaart's calibrated inputs,
   * a receiver's channels — and typing those from a photograph of a patch
   * sheet is how they get typed wrong.
   *
   * **Called with a config nobody has saved**, from the add-module form, so it
   * gets whatever has been typed so far and must not assume an instance
   * exists. It is also called for instances that do, which is why it takes a
   * config rather than an id.
   *
   * Two obligations. It must be **read-only and cheap** — a question asked of
   * a machine that may be mid-show, so open what is needed to ask, and close
   * it. And whatever it returns is a **suggestion**: the form keeps accepting
   * typed values, because the commonest moment to configure this system is the
   * week before load-in with none of the equipment switched on.
   */
  discoverConfigOptions?(config: C, signal: AbortSignal): Promise<ConfigOptions>
}

/** One historical reading, stamped by whatever measured it. */
export interface HistoryPoint {
  /** Series name, `<stream>.<field>`, matching what the recorder would write. */
  metric: string
  ts: number
  value: number
}

/** Where a supervisor sends data and status. Implemented by the realtime hub. */
export interface ConnectorSink {
  publish(instanceId: string, streamId: string, payload: unknown): void
  status(status: InstanceStatus): void
  /** Platform-wide topics (`sys:*`) that aren't tied to one instance. */
  publishSystem(topic: string, payload: unknown): void
  /**
   * History a device kept itself. See `ConnectorContext.recordHistory`.
   *
   * Required, and deliberately so. It was optional, the manager forwarded the
   * other three methods by hand, and this one was silently dropped for every
   * connector in the running product — while every test passed, because the
   * test harness builds a Supervisor directly and never goes through the
   * manager. A sink that cannot carry history should now fail to compile.
   */
  recordHistory(instanceId: string, points: readonly HistoryPoint[]): void
}

/** The persisted definition of one configured instance. */
export interface InstanceDefinition {
  id: string
  typeId: string
  name: string
  config: unknown
  enabled: boolean
  allowControl: boolean
  simulate: boolean
}

export type { ConnectorState, InstanceStatus }
