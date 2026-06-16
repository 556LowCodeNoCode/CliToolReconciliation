/**
 * SQLite layer (built-in node:sqlite, no native dependency).
 * Singular table names per project convention. Dataset rows live in dynamic
 * per-file tables (Dataset<id>) whose columns are registered in DatasetColumn.
 * All amount values are persisted as exact canonical decimal strings; the
 * engine computes on BigInt micro-units.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export const DDL = `
CREATE TABLE IF NOT EXISTS Meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS Profile (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  parse_spec_json     TEXT,
  last_fingerprint_id INTEGER,
  created_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS LoadedFile (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name     TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  format        TEXT NOT NULL CHECK (format IN ('delimited','xlsx','fixed')),
  encoding      TEXT NOT NULL,
  loaded_at     TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  dataset_table TEXT NOT NULL,
  profile_id    INTEGER REFERENCES Profile(id),
  fingerprint_id INTEGER
);
CREATE TABLE IF NOT EXISTS Fingerprint (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  loaded_file_id        INTEGER NOT NULL REFERENCES LoadedFile(id),
  profile_id            INTEGER REFERENCES Profile(id),
  encoding              TEXT NOT NULL,
  column_set_hash       TEXT NOT NULL,
  column_names_json     TEXT NOT NULL,
  type_bag_json         TEXT NOT NULL,
  null_rate_json        TEXT NOT NULL,
  cardinality_band_json TEXT NOT NULL,
  row_count_band        INTEGER NOT NULL,
  value_sketch_json     TEXT,
  drift_warnings_json   TEXT,
  computed_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS DatasetColumn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  loaded_file_id INTEGER NOT NULL REFERENCES LoadedFile(id),
  position       INTEGER NOT NULL,
  name_raw       TEXT NOT NULL,
  name_norm      TEXT NOT NULL,
  sql_name       TEXT NOT NULL,
  inferred_type  TEXT NOT NULL CHECK (inferred_type IN ('text','integer','decimal','date')),
  number_format  TEXT CHECK (number_format IN ('standard','greek')),
  null_count     INTEGER NOT NULL,
  distinct_count INTEGER NOT NULL,
  UNIQUE (loaded_file_id, sql_name)
);
CREATE TABLE IF NOT EXISTS ReconPair (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  profile_a_id INTEGER NOT NULL REFERENCES Profile(id),
  profile_b_id INTEGER NOT NULL REFERENCES Profile(id),
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ColumnMapping (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_pair_id INTEGER NOT NULL REFERENCES ReconPair(id),
  role          TEXT NOT NULL CHECK (role IN ('key','compare','display')),
  level         INTEGER NOT NULL DEFAULT 0,
  col_a         TEXT NOT NULL,
  col_b         TEXT NOT NULL,
  norm_mode     TEXT NOT NULL DEFAULT 'smart' CHECK (norm_mode IN ('smart','raw')),
  UNIQUE (recon_pair_id, role, level, col_a, col_b)
);
CREATE TABLE IF NOT EXISTS JoinKeyStat (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_pair_id    INTEGER NOT NULL REFERENCES ReconPair(id),
  loaded_file_a_id INTEGER NOT NULL REFERENCES LoadedFile(id),
  loaded_file_b_id INTEGER NOT NULL REFERENCES LoadedFile(id),
  col_a            TEXT NOT NULL,
  col_b            TEXT NOT NULL,
  uniqueness_a     REAL NOT NULL,
  uniqueness_b     REAL NOT NULL,
  overlap_ratio    REAL NOT NULL,
  null_rate_a      REAL NOT NULL,
  null_rate_b      REAL NOT NULL,
  computed_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ColumnHierarchy (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  loaded_file_id   INTEGER NOT NULL REFERENCES LoadedFile(id),
  parent_name      TEXT NOT NULL,
  child_name       TEXT NOT NULL,
  parent_distinct  INTEGER NOT NULL,
  child_distinct   INTEGER NOT NULL,
  consistency      REAL NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('aggregation','descriptive')),
  computed_at      TEXT NOT NULL,
  UNIQUE (loaded_file_id, parent_name, child_name)
);
CREATE TABLE IF NOT EXISTS Run (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid         TEXT NOT NULL UNIQUE,
  recon_pair_id    INTEGER NOT NULL REFERENCES ReconPair(id),
  loaded_file_a_id INTEGER NOT NULL REFERENCES LoadedFile(id),
  loaded_file_b_id INTEGER NOT NULL REFERENCES LoadedFile(id),
  config_json      TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  total_findings   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS RunLevelStat (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES Run(id),
  level    INTEGER NOT NULL,
  examined INTEGER NOT NULL,
  matched  INTEGER NOT NULL,
  only_a   INTEGER NOT NULL,
  only_b   INTEGER NOT NULL,
  differ   INTEGER NOT NULL,
  UNIQUE (run_id, level)
);
CREATE TABLE IF NOT EXISTS RunFinding (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES Run(id),
  parent_finding_id INTEGER REFERENCES RunFinding(id),
  level             INTEGER NOT NULL,
  bucket            TEXT NOT NULL CHECK (bucket IN ('ONLY_A','ONLY_B','DIFFER')),
  key_json          TEXT NOT NULL,
  compare_col       TEXT NOT NULL,
  value_a_micros    TEXT,
  value_b_micros    TEXT,
  delta_micros      TEXT,
  rows_a            INTEGER NOT NULL,
  rows_b            INTEGER NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  note              TEXT,
  lineage_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runfinding_run ON RunFinding(run_id, level, bucket);
`;

export function openDatabase(target: string): DatabaseSync {
  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  const salt = db.prepare("SELECT value FROM Meta WHERE key = 'hmac_salt'").get() as
    | { value: string }
    | undefined;
  if (!salt) {
    db.prepare("INSERT INTO Meta (key, value) VALUES ('hmac_salt', ?)").run(
      randomBytes(32).toString("hex"),
    );
  }
  return db;
}

export function hmacSalt(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM Meta WHERE key = 'hmac_salt'").get() as {
    value: string;
  };
  return row.value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Run `fn` inside a transaction; rollback on any throw. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Sanitize a header cell into a unique SQL column name. */
export function toSqlName(raw: string, taken: Set<string>): string {
  let base = raw
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9Ͱ-Ͽ]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  if (base === "") base = "col";
  if (/^[0-9]/.test(base)) base = `c_${base}`;
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  taken.add(name);
  return name;
}

/** Normalized column identity used in fingerprints and mappings. */
export function normColumnName(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().trim().replaceAll(/\s+/g, " ");
}

/** Prepared statement that reads SQLite INTEGERs as BigInt (exactness guard). */
export function prepareBig(db: DatabaseSync, sql: string): StatementSync {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  return st;
}
