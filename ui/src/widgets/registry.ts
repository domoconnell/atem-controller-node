import type { ComponentType } from 'react'

export interface WidgetProps {
  config: Record<string, unknown>
  instanceId: string | null
  /** For multi-instance widgets: the instances this widget spans. */
  instances?: { id: string; typeId: string; name: string }[]
  title: string
}
export interface ConfigField { key: string; label: string; kind: 'stream' | 'field' | 'text' | 'number' }
export interface WidgetDef {
  type: string
  label: string
  /** connector types this widget can bind to; undefined = platform widget */
  supportedTypeIds?: readonly string[]
  /** 'type' = all instances of the bound connector type; 'all' = every connection. */
  multi?: 'type' | 'all'
  defaultSize: { w: number; h: number }
  configFields?: ConfigField[]
  Component: ComponentType<WidgetProps>
}

const REGISTRY = new Map<string, WidgetDef>()
export function registerWidget(def: WidgetDef) { REGISTRY.set(def.type, def) }
export function getWidget(type: string) { return REGISTRY.get(type) }
export function listWidgets() { return [...REGISTRY.values()] }
export function widgetsForType(typeId: string | null) {
  if (typeId == null) return listWidgets().filter((w) => !w.supportedTypeIds)  // platform widgets
  return listWidgets().filter((w) => w.supportedTypeIds?.includes(typeId))
}
