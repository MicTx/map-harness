/**
 * The map-owned spatial store: one independent SQLite library per
 * conversation under `<root>/sessions/<sessionId>/` (validated session ids,
 * directory-derived manifest, explicit-only drop), each carrying versioned
 * schema migrations with dry-run, backup-before-write, checksums, and
 * crash-safe journaling; backup bundles with layered, never-overwriting
 * restore; the reference graph with pins and leases; and dry-run-planned
 * staging/orphan cleanup. Session logs and the projection cache stay
 * upstream-owned — this package only copies session bytes (never
 * overwriting a released generation) and reports the projection cache as
 * discarded derived data.
 *
 * @module @map-harness/spatial-storage
 */
export {
  StorageError,
  type StorageErrorCode,
} from './errors.ts'
export {
  sha256Bytes,
  sha256File,
} from './checksum.ts'
export {
  createStoreRoot,
  openStoreDatabase,
  SPATIAL_STORE_SCHEMA_VERSION,
  storeDbPath,
  storeSchemaVersion,
  STORE_MIGRATION_STEPS,
  STORE_DIRS,
  STORE_DB_NAME,
  MIGRATION_DEFAULT_TENANT,
  type StoreMigrationContext,
  type StoreMigrationStep,
} from './schema.ts'
export {
  dryRunStoreMigration,
  migrateStore,
  planStoreMigration,
  type MigrationBackup,
  type MigrationPlan,
  type MigrationReport,
  type MigrationStepInfo,
} from './migrate.ts'
export {
  createBackup,
  restoreBackup,
  verifyBackup,
  BACKUP_MANIFEST_KIND,
  BACKUP_MANIFEST_VERSION,
  type BackupEntryKind,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupResult,
  type BackupSessionInput,
  type BackupVerification,
  type RestoreDatabaseLayer,
  type RestoredEntry,
  type RestoreReport,
} from './backup.ts'
export {
  isTargetProtected,
  parentSessionOf,
  protectorsOf,
  type RefProtector,
  type RefProtectorKind,
  type RefTarget,
  type RefTargetKind,
} from './refs.ts'
export {
  listPins,
  pinTarget,
  unpinTarget,
  type StorePin,
  type PinTargetKind,
} from './pins.ts'
export {
  acquireLease,
  isLeaseLive,
  releaseLease,
  renewLease,
  type StoreLease,
} from './leases.ts'
export {
  CLEANUP_LEASE_SCOPE,
  executeCleanup,
  listStaging,
  planCleanup,
  registerStaging,
  releaseStaging,
  type CleanupPlan,
  type CleanupPlanEntry,
  type CleanupResultEntry,
  type StagingRow,
} from './cleanup.ts'
export {
  acquireReaderPin,
  collectGarbage,
  GC_TARGET_KINDS,
  isReleased,
  releaseReaderPin,
  releaseVersion,
  type CollectionRun,
  type GcTargetKind,
  type ReaderPin,
} from './gc.ts'
export {
  verifyStore,
  type StoreEntryReport,
  type StoreEntryStatus,
  type StoreStatus,
  type StoreVerification,
} from './recovery.ts'
export {
  assertValidSessionId,
  dropSessionStore,
  listSessionStores,
  SESSIONS_DIR_NAME,
  sessionStoreRoot,
  type SessionStoreEntry,
} from './sessions.ts'
