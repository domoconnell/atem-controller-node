import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ATEMCN_CONFIG lets a second instance (tests, a scratch copy) run from a
// different config file without ever touching the real config.json.
export const configPath = process.env.ATEMCN_CONFIG
  ? path.resolve(process.env.ATEMCN_CONFIG)
  : path.join(projectRoot, 'config.json')
export const config = JSON.parse(readFileSync(configPath, 'utf8'))

export const looksDir = path.join(projectRoot, 'looks')
export const macrosDir = path.join(projectRoot, 'macros')

// Keys that can be changed live without a restart. Everything else
// (network endpoints, ports) needs the process to come back up.
const HOT_KEYS = new Set([
  'animation.fps', 'animation.defaultDurationMs', 'animation.defaultEasing',
  'transition.keyFadeMs', 'transition.mixRateFrames', 'transition.videoFps',
  'supersource.displayBox', 'companion.varPrefix', 'companion.host', 'companion.port',
  'osc.feedback',
  'propresenter.ip', 'propresenter.port', 'propresenter.pollMs',
  'atem.simulate', 'atem.simFallbackMs',
  'wireLog',
  'wireConsole',
])

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

/**
 * Deep-merge `incoming` into the live config object (mutating it so every
 * module that imported `config` sees hot changes), and report which
 * changed keys need a restart to take effect.
 */
export function applyConfigUpdate(incoming) {
  const before = flatten(config)
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (k === 'comment' || k === '_comment') { dst[k] = v; continue }
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        merge(dst[k], v)
      } else {
        dst[k] = v
      }
    }
  }
  // Basic validation of the things that would break at runtime.
  const ip = (v) => typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$|^[a-z0-9.-]+$/i.test(v)
  if (incoming.atem?.ip !== undefined && !ip(incoming.atem.ip)) throw new Error('atem.ip is not a valid address')
  if (incoming.hyperdeck?.ip !== undefined && !ip(incoming.hyperdeck.ip)) throw new Error('hyperdeck.ip is not a valid address')
  for (const [k, v] of Object.entries(flatten(incoming))) {
    if (/port$/i.test(k) && v != null && !(Number.isInteger(v) && v > 0 && v < 65536)) throw new Error(`${k} must be a port number`)
  }
  merge(config, incoming)
  const after = flatten(config)
  const restartRequired = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k]) && !HOT_KEYS.has(k) && !HOT_KEYS.has(k.split('.').slice(0, 2).join('.'))) {
      restartRequired.push(k)
    }
  }
  return { merged: config, restartRequired }
}
