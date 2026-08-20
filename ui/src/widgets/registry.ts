import type { ComponentType } from 'react'

export interface WidgetProps {
  config: Record<string, unknown>
  instanceId: string | null
  title: string
}
export interface ConfigField { key: string; label: string; kind: 'stream' | 'field' | 'text' | 'number' }
export interface WidgetDef {
  type: string
  label: string
  /** connector types this widget can bind to; undefined = platform widget */
  supportedTypeIds?: readonly string[]
  defaultSize: { w: number; h: number }
  configFields?: ConfigField[]
  Component: ComponentType<WidgetProps>
}

const REGISTRY = new Map<string, WidgetDef>()
export function registerWidget(def: WidgetDef) { REGISTRY.set(def.type, def) }
export function getWidget(type: string) { return REGISTRY.get(type) }
export function listWidgets() { return [...REGISTRY.values()] }
export function widgetsForType(typeId: string | null) {
  return listWidgets().filter((w) => !w.supportedTypeIds || (typeId != null && w.supportedTypeIds.includes(typeId)))
}
