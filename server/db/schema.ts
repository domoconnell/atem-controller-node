/**
 * The single SQLite store for Stage It Live. One embedded file, no server
 * process. Replaces every flat JSON store we used to keep (config.json,
 * looks/, data/*.json) so there is exactly one way to persist state.
 *
 * Design mirrors the connector-instance model: a `settings` k/v table for
 * truly-global config, an `instances` table for every device connection
 * (several of the same type allowed), and dedicated tables for looks,
 * surfaces, timer layouts, renderer presets, acceptance results and the
 * time-series metrics history (SPL compliance + widget sparklines).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id           TEXT PRIMARY KEY,
  type_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  config_json  TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1,
  allow_control INTEGER NOT NULL DEFAULT 0,
  simulate     INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS instances_type ON instances(type_id);

CREATE TABLE IF NOT EXISTS looks (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS surfaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timer_layouts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS renderer_presets (
  name        TEXT PRIMARY KEY,
  data_json   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance (
  pair_key    TEXT PRIMARY KEY,
  data_json   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Time-series for SPL compliance logging + widget sparklines. Clustered on
-- (instance, metric, ts) so a whole series reads sequentially; upsert on replay.
CREATE TABLE IF NOT EXISTS metrics (
  instance_id TEXT NOT NULL,
  metric      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  value       REAL NOT NULL,
  PRIMARY KEY (instance_id, metric, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
export const SCHEMA_VERSION = 1
