import type { ComponentType } from 'react'

export interface WidgetProps {
  config: Record<string, unknown>
  instanceId: string | null
  /** For multi-instance widgets: the instances this widget spans. */
  instances?: { id: string; typeId: string; name: string }[]
  title: string
}
export interface ConfigField { key: string; label: string; kind: 'stream' | 'field' | 'text' | 'number' | 'service' }
export interface WidgetDef {
  type: string
  label: string
  /** connector types this widget can bind to; undefined = platform widget */
  supportedTypeIds?: readonly string[]
  /** Feature widget (not bound to a connector instance) — e.g. 'mics' composites.
   *  Configured with a selection (micIds) rather than an instance. */
  feature?: 'mics'
  /** 'type' = all instances of the bound connector type; 'all' = every connection. */
  multi?: 'type' | 'all'
  /** Applies to every connector type (generic field/overview widgets). */
  anyType?: boolean
  /** Designed for the thin header/footer strips (long, thin, icon+pill). */
  strip?: boolean
  /** Strip widget that should size to its content (e.g. a logo) rather than
   *  share the strip width — added with stripW: 0 ("fit"). */
  stripFit?: boolean
  defaultSize: { w: number; h: number }
  configFields?: ConfigField[]
  Component: ComponentType<WidgetProps>
}

const REGISTRY = new Map<string, WidgetDef>()
export function registerWidget(def: WidgetDef) { REGISTRY.set(def.type, def) }
export function getWidget(type: string) { return REGISTRY.get(type) }
export function listWidgets() { return [...REGISTRY.values()] }
export function widgetsForType(typeId: string | null) {
  if (typeId == null) return listWidgets().filter((w) => !w.supportedTypeIds && !w.anyType && !w.feature)  // pure platform
  return listWidgets().filter((w) => w.anyType || w.supportedTypeIds?.includes(typeId))
}
export function widgetsForFeature(feature: string) { return listWidgets().filter((w) => w.feature === feature) }
