/**
 * `@map-harness/spatial-collab` — the spatial collaboration contracts and
 * machinery: the versioned writer/patch/conflict vocabulary
 * (`spatial-collab@1`), the pure serial commit engine (expectedRevision
 * check and acceptance in one synchronous segment), the explainable conflict
 * diff, the compensating-undo target checks, and the writer lease lifecycle
 * (join, disconnect, reconnect, release with in-flight quiescence, permission
 * revoke). A pure library — the collab tools and host service consume it; a
 * single-server serial model throughout, never a distributed CAS/CRDT, and
 * no promise of rolling back external resources.
 *
 * @module @map-harness/spatial-collab
 */
export {
  COLLAB_METHOD_VERSION,
  MAX_AOI_POINTS,
  MAX_COLLAB_ID_LENGTH,
  MAX_OPERATION_LEDGER,
  MAX_PATCH_OPS,
  collabPatchSchema,
  parseCollabPatch,
  type CollabAoi,
  type CollabCommitCode,
  type CollabCommitResult,
  type CollabConflictDiff,
  type CollabConflictEntry,
  type CollabDocument,
  type CollabExpectation,
  type CollabLayerInput,
  type CollabOperationOutcome,
  type CollabOperationPost,
  type CollabPatch,
  type CollabPatchInvalidCode,
  type CollabPatchOp,
  type CollabUndoVerdict,
} from './contract.ts'
export {
  checkUndoTarget,
  commitPatch,
  withLedgerEntry,
} from './engine.ts'
export {
  diffDocumentSummary,
  renderConflictDiff,
} from './diff.ts'
export {
  CollabLifecycleError,
  WriterRegistry,
  type CollabGate,
  type CollabLifecycleCode,
  type CollabWriterRecord,
} from './lifecycle.ts'
export {
  SPATIAL_COLLAB_SERVICE,
  createSpatialCollabService,
  type CollabWriterDescriptor,
  type SpatialCollabService,
} from './service.ts'
export { apply, name, type SpatialCollabPluginConfig } from './plugin.ts'
