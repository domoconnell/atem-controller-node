import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { looksDir } from './config.js'

/**
 * Named "looks": full snapshots of the state we choreograph between.
 * Each look records:
 *   - boxes:        SuperSource box layout (raw ATEM units)
 *   - ssProperties: SuperSource art fill/key settings
 *   - me:           main M/E program/preview, next-transition, USK on-air
 *   - hyperdeck:    transport status + clip at capture time
 *
 * Stored one JSON file per look in looks/ so they are easy to hand-edit.
 * The controller tracks which look is "current" so from->to transition
 * macros can pick the right choreography.
 */
export class LookStore extends EventEmitter {
  constructor(atemController, hyperdeck, store = null, propresenter = null) {
    super()
    this.atem = atemController
    this.hyperdeck = hyperdeck
    this.propresenter = propresenter // optional: records/recalls the PP audience look
    this.store = store // SQLite store = source of truth; JSON files kept as a backup
    this.looks = new Map()
    this.currentLook = null
    if (!existsSync(looksDir)) mkdirSync(looksDir, { recursive: true })
    this.loadAll()
  }

  loadAll() {
    this.looks.clear()
    if (this.store) {
      for (const row of this.store.listLooks()) {
        const look = this._normalize(row) // row = {slug, name, ...data}
        this.looks.set(look.name ?? row.slug, look)
      }
      console.log(`[looks] loaded ${this.looks.size} look(s) from DB`)
      return
    }
    for (const f of readdirSync(looksDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const look = JSON.parse(readFileSync(path.join(looksDir, f), 'utf8'))
        this.looks.set(look.name, this._normalize(look))
      } catch (e) {
        console.error(`[looks] failed to load ${f}:`, e.message)
      }
    }
    console.log(`[looks] loaded ${this.looks.size} look(s) from JSON`)
  }

  /** Upgrade look files captured by earlier versions to the current shape. */
  _normalize(look) {
    if (!look.me && (look.uskOnAir || look.programInput !== undefined)) {
      look.me = {
        programInput: look.programInput,
        previewInput: undefined,
        uskOnAir: look.uskOnAir ?? [],
      }
      delete look.uskOnAir
      delete look.programInput
    }
    return look
  }

  list() {
    return [...this.looks.values()]
  }

  get(name) {
    return this.looks.get(name)
  }

  /** Capture the full live state (SuperSource, M/E, USKs, HyperDeck). */
  capture(rawName) {
    const name = slug(rawName)
    if (!name) throw new Error('Look name required')
    const me = this.atem.getMixEffect()
    const transport = this.hyperdeck?.transport ?? {}
    const look = {
      name,
      capturedAt: new Date().toISOString(),
      boxes: this.atem.getBoxes().map((b) =>
        b ? { ...b, sourceName: this.atem.getInputName(b.source) } : null
      ),
      ssProperties: this._ssPropertiesWithNames(),
      me: {
        index: this.atem.me,
        programInput: me?.programInput,
        programInputName: this.atem.getInputName(me?.programInput),
        previewInput: me?.previewInput,
        previewInputName: this.atem.getInputName(me?.previewInput),
        nextTransition: this.atem.getNextTransition(),
        uskOnAir: (me?.upstreamKeyers ?? []).map((k) => k?.onAir ?? false),
        usk: this.atem.getUskSettings(),
      },
      mediaPlayers: this.atem.getMediaPlayers(),
      hyperdeck: {
        connected: this.hyperdeck?.connected ?? false,
        status: transport['status'] ?? null,
        clipId: transport['clip id'] != null ? Number(transport['clip id']) : null,
        loop: transport['loop'] === 'true',
        singleClip: transport['single clip'] === 'true',
        speed: transport['speed'] != null ? Number(transport['speed']) : null,
      },
      // ProPresenter: the live audience look at capture time, plus any macro
      // the operator attached (preserved across re-capture).
      pro: this._capturePro(this.looks.get(name)),
    }
    this.looks.set(name, look)
    if (this.store) this.store.putLook(name, name, look) // DB is the source of truth
    try { writeFileSync(path.join(looksDir, `${slug(name)}.json`), JSON.stringify(look, null, 2)) } catch { /* backup only */ }
    console.log(`[looks] captured '${name}'`)
    this.emit('changed')
    return look
  }

  /** Build the ProPresenter block for a captured look: the live audience look
   *  (recalled by its stable uuid, name kept for display), keeping any macro
   *  already attached to the look being re-captured. Returns null if PP has no
   *  current look. */
  _capturePro(existing = null) {
    const macro = existing?.pro?.macro ?? null
    const c = this.propresenter?.currentLook
    if (!c) return existing?.pro ? { look: existing.pro.look ?? null, macro } : null
    return { look: { uuid: c.stableUuid ?? c.uuid ?? null, name: c.name ?? null, index: c.index ?? null }, macro }
  }

  /** Set/replace a look's ProPresenter block (audience look and/or macro) from
   *  the UI, without disturbing the rest of the captured state. */
  setPro(name, pro) {
    const look = this.mustGet(name)
    look.pro = pro && (pro.look || pro.macro) ? { look: pro.look ?? null, macro: pro.macro ?? null } : null
    if (this.store) this.store.putLook(slug(name), look.name, look)
    try { writeFileSync(path.join(looksDir, `${slug(name)}.json`), JSON.stringify(look, null, 2)) } catch { /* backup only */ }
    this.emit('changed')
    return look
  }

  _ssPropertiesWithNames() {
    const props = this.atem.getSsProperties()
    if (!props) return null
    return {
      ...props,
      artFillSourceName: this.atem.getInputName(props.artFillSource),
      artCutSourceName: this.atem.getInputName(props.artCutSource),
      artOptionName: props.artOption === 1 ? 'foreground' : 'background',
    }
  }

  delete(name) {
    if (!this.looks.has(name)) return false
    this.looks.delete(name)
    if (this.store) this.store.deleteLook(slug(name))
    const f = path.join(looksDir, `${slug(name)}.json`)
    if (existsSync(f)) rmSync(f)
    console.log(`[looks] deleted '${name}'`)
    if (this.currentLook === name) this.setCurrent(null)
    this.emit('changed')
    return true
  }

  /** Snap the SuperSource straight to a look's box layout (no animation). */
  async apply(name) {
    const look = this.mustGet(name)
    const frame = {}
    look.boxes.forEach((b, i) => {
      if (b) frame[i] = { ...b }
    })
    await this.atem.setBoxes(frame)
    this.setCurrent(name)
  }

  mustGet(name) {
    const look = this.looks.get(name) ?? this.looks.get(slug(name))
    if (!look) throw new Error(`Unknown look '${name}'`)
    return look
  }

  setCurrent(name) {
    if (this.currentLook !== name) {
      this.currentLook = name
      this.emit('current', name)
    }
  }
}

/** Canonical look-name form: lowercase, hyphen-separated, no punctuation. */
export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
