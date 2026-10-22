/**
 * The error face of the spatial storage layer: one error class whose machine
 * code states what failed and whose message names the affected path or entry.
 * Every refusal in this package is loud — a damaged store, a future schema,
 * or an unresolved conflict is never silently skipped or defaulted.
 *
 * @module @map-harness/spatial-storage/errors
 */

/** Machine-readable failure codes the storage layer reports. */
export type StorageErrorCode =
  /** The store's schema version is newer than this build supports; never downgrade. */
  | 'future-schema-version'
  /** Stored bytes do not match the recorded digest. */
  | 'digest-mismatch'
  /** A referenced file does not exist. */
  | 'missing-file'
  /** A file or directory mode change made the entry unreadable. */
  | 'permission-denied'
  /** A backup manifest is missing, unparsable, or carries an unsupported version. */
  | 'invalid-manifest'
  /** The backup's authorization digest does not match the supplied token. */
  | 'authorization-mismatch'
  /** The restore target already holds different bytes or a live database. */
  | 'restore-conflict'
  /** The requested lease scope is held live by another owner. */
  | 'lease-held'
  /** The requested lease id is unknown, released, or expired. */
  | 'no-lease'
  /** The migration step list is not a contiguous forward chain from version 0. */
  | 'invalid-migration-list'
  /** The cleanup plan is stale or was not produced by the same store. */
  | 'invalid-plan'
  /** A session id cannot name a session store directory (empty, oversized, or carrying separators/traversal). */
  | 'invalid-session-id'
  /** The session has no store under the root (an explicit drop found nothing). */
  | 'missing-session-store'
  /** The GC target kind carries no file bytes (streams/intents are state rows). */
  | 'unsupported-gc-target'
  /** The named resource/artifact row does not exist in this store. */
  | 'unknown-target'
  /** No reader pin resolves for the (target, owner) pair. */
  | 'unknown-reader-pin'

/** The one error class every storage refusal uses. */
export class StorageError extends Error {
  /** Machine-readable refusal code. */
  readonly code: StorageErrorCode

  /**
   * @param code - the refusal code callers branch on.
   * @param message - the affected path, entry, or versions, for operators.
   */
  constructor(code: StorageErrorCode, message: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}
