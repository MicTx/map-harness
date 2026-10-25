/**
 * One store's physical layout: a SQLite database plus bounded immutable
 * file areas under one store root, the monotonic schema version stored in
 * `PRAGMA user_version`, and the forward-only migration list. A store root
 * is one conversation's library (`<root>/sessions/<sessionId>/`, see
 * `./sessions.ts`); the store owns catalog/resource/artifact/intent/stream
 * rows, the governance ACL and audit rows, and the reference, pin, lease,
 * and staging tables that protect them; Session logs and the projection
 * cache stay upstream-owned and are only ever copied or dropped.
 *
 * Open refuses a schema version newer than the supported one — the store
 * never downgrades and never guesses across versions (see
 * {@link openStoreDatabase}); upgrades run through `migrateStore`.
 *
 * @module @map-harness/spatial-storage/schema
 */
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StorageError } from './errors.ts'

/** The store's on-disk schema version this build owns. */
export const SPATIAL_STORE_SCHEMA_VERSION = 6

/** Relative name of the SQLite database file inside the store root. */
export const STORE_DB_NAME = 'store.db'

/** One forward migration step: `up` runs inside the step's own transaction. */
export interface StoreMigrationStep {
  /** Version the store must be at before this step applies. */
  readonly from: number
  /** Version the store carries after this step commits. */
  readonly to: number
  /** Stable step name recorded in `migration_journal`. */
  readonly name: string
  /**
   * Apply the step's DDL/DML. Runs inside an open `BEGIN IMMEDIATE`
   * transaction; any throw (or process death) rolls the whole step back.
   * @param db - the store database the step mutates.
   * @param context - the migrating caller's parameters; `tenant` names the
   *   deployment tenant pre-@2 governance rows backfill under.
   */
  readonly up: (db: DatabaseSync, context: StoreMigrationContext) => void
}

/** Parameters one migration step receives from the migrating caller. */
export interface StoreMigrationContext {
  /**
   * The tenant id existing governance rows backfill under. The catalog
   * passes its configured deployment tenant; callers that manage stores
   * without tenant context get the single-tenant default.
   */
  readonly tenant: string
}

/** The tenant id rows backfill under when the migrating caller names none. */
export const MIGRATION_DEFAULT_TENANT = 'default'

/** The baseline tables shared by the domain, reference, and lifecycle rows. */
const BASELINE_DDL = `
CREATE TABLE catalog_resources (
  resource_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  schema_digest TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  input_refs TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE intents (
  operation_ref TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_call_seq INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE session_refs (
  session_id TEXT PRIMARY KEY,
  parent_session_id TEXT
);
CREATE TABLE map_refs (
  ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(session_id, layer_id, target_kind, target_id)
);
CREATE TABLE report_refs (
  ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(session_id, report_id, target_kind, target_id)
);
CREATE TABLE export_refs (
  ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(session_id, export_id, target_kind, target_id)
);
CREATE TABLE job_refs (
  ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(session_id, job_id, target_kind, target_id)
);
CREATE TABLE backup_pins (
  pin_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(target_kind, target_id, reason)
);
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE staging (
  staging_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  owner_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX staging_state_idx ON staging(state);
`

/**
 * The P0b versioned data-chain schema: logical resource identity over the
 * baseline byte registry, per-version feature refs, semantic bindings, richer
 * artifact identity, and publish-intent results. Columns carry defaults so a
 * v1 row stays valid; every new constraint is additive (forward-only ladder).
 */
const P0B_CATALOG_DDL = `
ALTER TABLE catalog_resources ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_resources ADD COLUMN media_type TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_resources ADD COLUMN feature_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_resources ADD COLUMN geometry_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE catalog_resources ADD COLUMN schema_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE catalog_resources ADD COLUMN native_crs TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_resources ADD COLUMN extent TEXT;
ALTER TABLE catalog_resources ADD COLUMN valid_time TEXT;
ALTER TABLE catalog_resources ADD COLUMN source_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_resources ADD COLUMN authorization TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_resources ADD COLUMN registered_by TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX catalog_resources_logical_version ON catalog_resources(logical_id, version);
CREATE TABLE feature_refs (
  resource_id TEXT NOT NULL,
  feature_ref TEXT NOT NULL,
  original_id TEXT,
  feature_index INTEGER NOT NULL,
  PRIMARY KEY (resource_id, feature_ref)
);
CREATE TABLE semantic_bindings (
  resource_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  mapping_version INTEGER NOT NULL,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, definition_id)
);
ALTER TABLE artifacts ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN parameters_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN analysis_crs TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN authorization TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX artifacts_logical_version ON artifacts(logical_id, version);
ALTER TABLE intents ADD COLUMN result_kind TEXT;
ALTER TABLE intents ADD COLUMN result_ref TEXT;
`

/**
 * The sensitive-data governance schema: per-object ACL grants with monotonic
 * grant versions and the append-only audit trail. The same step backfills one
 * `granted` ACL row for every already-published resource, artifact, and
 * semantic binding so an upgraded store keeps the access it had — no silent
 * lockout — while every object published after the upgrade gets its grant
 * inside its own publish transaction. Audit rows are never backfilled: the
 * trail records decisions from the governance introduction onward.
 */
const GOVERNANCE_DDL = `
CREATE TABLE governance_acl (
  object_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  domain TEXT NOT NULL,
  state TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_kind, ref, domain)
);
CREATE TABLE governance_audit (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  session_id TEXT,
  object_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  resource_version INTEGER,
  operation TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  domain TEXT NOT NULL,
  grant_version INTEGER
);
CREATE INDEX governance_audit_ref ON governance_audit(object_kind, ref);
INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at)
  SELECT 'resource', REPLACE(resource_id, '-v', '@v'), authorization,
         CASE state WHEN 'available' THEN 'granted' ELSE 'revoked' END, 1, registered_at
  FROM catalog_resources;
INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at)
  SELECT 'artifact', REPLACE(artifact_id, '-v', '@v'), authorization,
         CASE state WHEN 'available' THEN 'granted' ELSE 'revoked' END, 1, created_at
  FROM artifacts;
INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at)
  SELECT 'semantic', 'def-' || b.definition_id || '@v' || b.definition_version, r.authorization, 'granted', 1, b.created_at
  FROM semantic_bindings b JOIN catalog_resources r ON r.resource_id = b.resource_id;
`

/**
 * The semantic-index definition store: immutable definition versions and a
 * normalized alias index. ACL rows are created by the catalog repository in
 * the same publish transaction, so a definition never becomes searchable
 * before its authorization grant exists.
 */
const SEMANTIC_INDEX_DDL = `
CREATE TABLE semantic_definitions (
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_name_normalized TEXT NOT NULL,
  definition TEXT NOT NULL,
  applicability TEXT NOT NULL,
  applicability_normalized TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  review_status TEXT NOT NULL,
  authorization TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (definition_id, version)
);
CREATE INDEX semantic_definitions_name_idx ON semantic_definitions(canonical_name_normalized);
CREATE TABLE semantic_aliases (
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  PRIMARY KEY (definition_id, definition_version, alias),
  FOREIGN KEY (definition_id, definition_version)
    REFERENCES semantic_definitions(definition_id, version)
);
CREATE INDEX semantic_aliases_lookup_idx ON semantic_aliases(alias_normalized);
INSERT OR IGNORE INTO semantic_definitions (
  definition_id, version, canonical_name, canonical_name_normalized,
  definition, applicability, applicability_normalized, source_ref,
  review_status, authorization, created_at
)
  SELECT b.definition_id, b.definition_version, b.definition_id, lower(b.definition_id),
         '{"legacyBinding":true}', '{}', '', 'legacy:semantic_bindings',
         'legacy-binding', r.authorization, b.created_at
  FROM semantic_bindings b
  JOIN catalog_resources r ON r.resource_id = b.resource_id;
`

/** The published-version GC lifecycle tables: reader pins and explicit release markers. */
const GC_LIFECYCLE_DDL = `
CREATE TABLE reader_pins (
  pin_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(target_kind, target_id, owner)
);
CREATE INDEX reader_pins_target_idx ON reader_pins(target_kind, target_id);
CREATE TABLE released_versions (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  released_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
`

/**
 * The multi-tenant governance and copy-recall schema. The ACL table is
 * rebuilt with the tenant dimension inside its primary key (same rows, one
 * backfilled tenant column); the append-only audit trail gains a backfilled
 * tenant column without touching its sequence or history; and the copy
 * registry plus recall event tables give the governance plane its recall
 * address book. Recall events are append-only facts — a tenant-scoped event
 * carries NULL object columns, an object-scoped event names its target.
 */
const GOVERNANCE_TENANT_ACL_DDL = `
CREATE TABLE governance_acl_next (
  tenant TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  domain TEXT NOT NULL,
  state TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, object_kind, ref, domain)
);
`
const GOVERNANCE_TENANT_RECALL_DDL = `
CREATE TABLE governance_copies (
  copy_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  channel TEXT NOT NULL,
  holder TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  UNIQUE (tenant, object_kind, ref, channel, holder)
);
CREATE INDEX governance_copies_object_idx ON governance_copies(tenant, object_kind, ref);
CREATE TABLE governance_recall (
  recall_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  scope TEXT NOT NULL,
  object_kind TEXT,
  ref TEXT,
  origin TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  recalled_at TEXT NOT NULL
);
CREATE INDEX governance_recall_object_idx ON governance_recall(tenant, object_kind, ref);
ALTER TABLE governance_audit ADD COLUMN tenant TEXT NOT NULL DEFAULT '';
`

/** The production migration list; successor versions append steps, never rewrite. */
export const STORE_MIGRATION_STEPS: readonly StoreMigrationStep[] = [
  { from: 0, to: 1, name: 'baseline', up: db => { db.exec(BASELINE_DDL) } },
  { from: 1, to: 2, name: 'p0b-catalog-chain', up: db => { db.exec(P0B_CATALOG_DDL) } },
  { from: 2, to: 3, name: 'spatial-governance', up: db => { db.exec(GOVERNANCE_DDL) } },
  { from: 3, to: 4, name: 'semantic-index', up: db => { db.exec(SEMANTIC_INDEX_DDL) } },
  { from: 4, to: 5, name: 'published-version-gc', up: db => { db.exec(GC_LIFECYCLE_DDL) } },
  {
    from: 5,
    to: 6,
    name: 'governance-tenant-recall',
    up: (db, context) => {
      db.exec(GOVERNANCE_TENANT_RECALL_DDL)
      db.prepare("UPDATE governance_audit SET tenant = ? WHERE tenant = ''").run(context.tenant)
      db.exec(GOVERNANCE_TENANT_ACL_DDL)
      db.prepare(
        'INSERT INTO governance_acl_next (tenant, object_kind, ref, domain, state, grant_version, updated_at) '
        + 'SELECT ?, object_kind, ref, domain, state, grant_version, updated_at FROM governance_acl',
      ).run(context.tenant)
      db.exec('DROP TABLE governance_acl')
      db.exec('ALTER TABLE governance_acl_next RENAME TO governance_acl')
    },
  },
]

/** The store-relative directory names this package creates and owns. */
export const STORE_DIRS = ['files', 'staging', 'backups', 'trash'] as const

/**
 * Create the store root's directory layout and database file when missing.
 * Directories get owner-only modes; an existing database keeps its mode.
 * @param root - the store root directory.
 */
export function createStoreRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const dir of STORE_DIRS) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 })
  }
  const dbPath = join(root, STORE_DB_NAME)
  try {
    const handle = openSync(dbPath, 'wx', 0o600)
    closeSync(handle)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Resolve the database file path inside one store root. */
export function storeDbPath(root: string): string {
  return join(root, STORE_DB_NAME)
}

/**
 * Read the store's schema version from `PRAGMA user_version`.
 * @param db - the open database handle.
 * @returns the recorded version (0 = fresh, un-migrated file).
 */
export function storeSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number | bigint }
  return Number(row.user_version)
}

/**
 * Open one store database with the store's pragmas applied.
 * @param dbPath - the SQLite database file (or `:memory:` in tests).
 * @param options - `readOnly` opens a read-only connection for scans and
 *   dry-runs; `supportedSchemaVersion` overrides the refusal ceiling (the
 *   production default is {@link SPATIAL_STORE_SCHEMA_VERSION}; migration
 *   fixtures pass their fixture list's maximum).
 * @returns the open handle; the caller owns closing it.
 * @throws {StorageError} `future-schema-version` when the file carries a
 *   version newer than supported — never downgraded, never opened anyway.
 */
export function openStoreDatabase(
  dbPath: string,
  options: { readOnly?: boolean; supportedSchemaVersion?: number } = {},
): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: options.readOnly === true })
  try {
    // Rollback-journal mode keeps the store one file plus a transient journal:
    // file digests stay stable between writes and a crash mid-write rolls
    // back on next open. WAL's sidecar files would complicate both.
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA foreign_keys = ON')
    const supported = options.supportedSchemaVersion ?? SPATIAL_STORE_SCHEMA_VERSION
    const version = storeSchemaVersion(db)
    if (version > supported) {
      throw new StorageError(
        'future-schema-version',
        `store at "${dbPath}" has schema version ${version}, newer than this build supports (${supported}); upgrade the build instead of downgrading the store`,
      )
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
