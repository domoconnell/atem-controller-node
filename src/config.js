import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const config = JSON.parse(readFileSync(path.join(projectRoot, 'config.json'), 'utf8'))

export const looksDir = path.join(projectRoot, 'looks')
export const macrosDir = path.join(projectRoot, 'macros')
