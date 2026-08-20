import { encodeOscMessage } from '../../lib/osc.js'

/**
 * Bitfocus Companion's HTTP API, as far as this connector needs it.
 *
 * Companion is the glue layer at most venues — it already talks to hundreds of
 * devices — so reading its variables buys reach we would never get by
 * integrating each of those devices ourselves.
 */

export interface VariableRef {
  /** The config entry exactly as the operator typed it; also the published key. */
  key: string
  kind: 'module' | 'custom'
  /** Connection label for a module variable, null for a custom variable. */
  connection: string | null
  name: string
}

/**
 * Splits `connectionLabel:variableName` (what appears inside `$(...)` in
 * Companion) or `custom:name`. Only the first colon separates: Companion
 * itself allows no further colons, so anything after one is a typo we would
 * rather surface at save time than turn into a mystery 404 at showtime.
 */
export function parseVariableRef(entry: string): VariableRef | null {
  const separator = entry.indexOf(':')
  if (separator <= 0 || separator === entry.length - 1) return null

  const prefix = entry.slice(0, separator)
  const name = entry.slice(separator + 1)
  if (name.includes(':')) return null

  return prefix === 'custom'
    ? { key: entry, kind: 'custom', connection: null, name }
    : { key: entry, kind: 'module', connection: prefix, name }
}

export function isVariableRef(entry: string): boolean {
  return parseVariableRef(entry) !== null
}

/** The read path for one variable. Every segment is encoded: labels are free text. */
export function variableValuePath(ref: VariableRef): string {
  return ref.kind === 'custom'
    ? `/api/custom-variable/${encodeURIComponent(ref.name)}/value`
    : `/api/variable/${encodeURIComponent(ref.connection ?? '')}/${encodeURIComponent(ref.name)}/value`
}

/**
 * Companion answers with the raw value as text, so `"42"` and `"stopped"`
 * arrive identically. Widgets want to do arithmetic and draw gauges, so a
 * value that is unambiguously a number is published as one — but only when it
 * round-trips, keeping `007` and `1.50` the strings the operator sees in
 * Companion rather than silently reformatted numbers.
 */
export function coerceVariableValue(raw: string): string | number {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return raw

  const asNumber = Number(trimmed)
  return Number.isFinite(asNumber) && String(asNumber) === trimmed ? asNumber : raw
}

/**
 * Show networks hand out IPv6 addresses more often than anyone expects, and a
 * bare `::1` in a URL parses as a host with a port. Bracket it.
 */
export function baseUrl(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${port}`
}

/*
 * ── The same two commands, over OSC ─────────────────────────────────────────
 *
 * Companion listens for OSC on a separate port (12321 by default) and speaks
 * a vocabulary that mirrors the HTTP one almost exactly. Read out of the
 * shipped `OscApi.ts` rather than the documentation page, because this project
 * has been caught by a faithful simulator of wrong documentation before:
 *
 *   /location/<page>/<row>/<column>/press      no arguments
 *   /custom-variable/<name>/value  <value>     first argument, any type
 *
 * **Two things it does not do.** It never replies — OSC here is one-way, so a
 * command's success means the datagram left this machine and nothing more. And
 * `#customVariableSetValue` throws away the return of `setCustomVariableValue`,
 * which is the string `'Unknown name'` for a variable nobody created. Over
 * HTTP that is the 404 the connector reports; over OSC it is *nothing at all*.
 * A key wired to an undeclared variable stays dark for ever with no error on
 * either side of the wire, which is why the connector checks the name over
 * HTTP before it will send the datagram.
 */

/** Presses a button by location, exactly as `POST /api/location/…/press` does. */
export const oscButtonPress = (page: number, row: number, column: number): Buffer =>
  encodeOscMessage(`/location/${page}/${row}/${column}/press`)

/**
 * Sets a custom variable.
 *
 * The value goes as a string even when it looks like a number, matching the
 * HTTP path: Companion stores whatever it is given and a feedback rule
 * comparing `standby` against a float is a bad afternoon.
 */
export const oscVariableSet = (name: string, value: string): Buffer =>
  encodeOscMessage(`/custom-variable/${name}/value`, [{ type: 's', value }])
