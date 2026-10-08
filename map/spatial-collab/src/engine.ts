/**
 * The serial commit engine: the single synchronous segment where the
 * expectedRevision check, the per-op expectation checks, and the acceptance
 * of one patch all run — one pure function call, no await points, so no
 * interleaving writer can slip between the check and the acceptance.
 *
 * Semantics (design §11.3, single-server serial commit):
 * - The base CAS comes first: `expectedRevision !== document.revision`
 *   conflicts with a `stale_revision` diff; the patch is never rewritten
 *   onto the new base and never auto-replayed.
 * - Per-op expectations are conditional reads: a stale same-layer update
 *   (digest), a delete of an already-deleted layer, a reorder against a
 *   changed order, an AOI/view/mode overwrite each conflict with a named
 *   per-op reason. A patch containing deletes NEVER partially applies.
 * - A repeated `operationId` replays its FIRST outcome from the caller's
 *   ledger (idempotent response), never applies twice.
 * - Acceptance is all-or-nothing and emits the next document and the next
 *   revision; the caller persists it through its own authoritative fold.
 *
 * Undo support: `checkUndoTarget` compares one recorded operation's
 * post-state and its inverse against the current document — `matched` means
 * the compensation can be proposed as a NEW revision, `already-undone` means
 * the recorded effect is already gone, `changed` means another writer wrote
 * the affected slice since and the undo conflicts instead of overwriting.
 *
 * @module @map-harness/spatial-collab/engine
 */
import {
  MAX_OPERATION_LEDGER,
  type CollabCommitCode,
  type CollabCommitResult,
  type CollabConflictDiff,
  type CollabConflictEntry,
  type CollabDocument,
  type CollabOperationOutcome,
  type CollabOperationPost,
  type CollabPatch,
  type CollabPatchOp,
  type CollabUndoVerdict,
} from './contract.ts'
import { diffDocumentSummary } from './diff.ts'

/** The document identity digest for view/aoi values: canonical JSON text (bounded inputs by schema). */
function valueDigest(value: unknown): string {
  return JSON.stringify(value)
}

/** Find one layer's index in the document, or `-1`. */
function layerIndex(document: CollabDocument, layerId: string): number {
  return document.layers.findIndex(layer => layer.id === layerId)
}

/** Build the conflict diff: per-op entries, the current face, and the summary. */
function conflictOf(
  baseRevision: number,
  document: CollabDocument,
  entries: readonly CollabConflictEntry[],
  base: CollabDocument | undefined,
): CollabConflictDiff {
  const first = entries[0]
  return {
    baseRevision,
    currentRevision: document.revision,
    entries,
    currentLayers: document.layers,
    summary: first === undefined
      ? `stale base: expected revision ${baseRevision}, current is ${document.revision}; ${diffDocumentSummary(base, document)}`
      : `op[${first.index}] ${first.kind} conflicts: ${first.detail}`,
  }
}

/** Document-level expectation check (order/view/mode/aoi). Layer expectations live per op. */
function documentExpectationConflict(
  document: CollabDocument,
  op: CollabPatchOp,
): { code: CollabCommitCode; detail: string } | undefined {
  const expect = op.expect
  if (expect === undefined) return undefined
  if (expect.order !== undefined
    && (expect.order.length !== document.layers.length
      || expect.order.some((id, at) => document.layers[at]?.id !== id))) {
    return {
      code: 'order_conflict',
      detail: `expected layer order [${expect.order.join(', ')}], current is [${document.layers.map(layer => layer.id).join(', ')}]`,
    }
  }
  if (expect.viewDigest !== undefined && valueDigest(document.view) !== expect.viewDigest) {
    return { code: 'view_conflict', detail: 'the view changed since this patch was prepared' }
  }
  if (expect.mode !== undefined && document.mode !== expect.mode) {
    return { code: 'mode_conflict', detail: `expected mode ${expect.mode}, current is ${document.mode}` }
  }
  if (expect.aoiDigest !== undefined
    && (expect.aoiDigest === null ? document.aoiDigest !== null : document.aoiDigest !== expect.aoiDigest)) {
    return { code: 'aoi_conflict', detail: 'the AOI changed since this patch was prepared' }
  }
  return undefined
}

/** The op-specific conditional read every kind runs against the current document. */
function opSpecificConflict(
  document: CollabDocument,
  op: CollabPatchOp,
): { code: CollabCommitCode; detail: string } | undefined {
  switch (op.kind) {
    case 'upsert-layer': {
      const at = layerIndex(document, op.layer.id)
      if (op.expect?.absent === true && at !== -1) {
        return { code: 'layer_present', detail: `layer ${op.layer.id} already exists (created or changed by another writer)` }
      }
      if (op.expect?.digest !== undefined) {
        if (at === -1) return { code: 'layer_missing', detail: `expected layer ${op.layer.id} at digest ${op.expect.digest}, but it is gone` }
        if (document.layers[at]?.digest !== op.expect.digest) {
          return { code: 'layer_digest_conflict', detail: `expected layer ${op.layer.id} at digest ${op.expect.digest}, but its content changed` }
        }
      }
      return undefined
    }
    case 'remove-layer': {
      const at = layerIndex(document, op.layerId)
      if (at === -1) return { code: 'layer_missing', detail: `layer ${op.layerId} is already gone; the delete is not replayed` }
      if (op.expect?.digest !== undefined && document.layers[at]?.digest !== op.expect.digest) {
        return { code: 'layer_digest_conflict', detail: `layer ${op.layerId} changed since this patch was prepared` }
      }
      return undefined
    }
    case 'reorder-layers': {
      const current = document.layers.map(layer => layer.id).sort().join('|')
      const proposed = [...op.layerIds].sort().join('|')
      if (current !== proposed) {
        return { code: 'order_conflict', detail: 'reorder must name exactly the current layer set' }
      }
      return undefined
    }
    case 'set-style': {
      for (const entry of op.entries) {
        const at = layerIndex(document, entry.layerId)
        if (at === -1) {
          return { code: 'layer_missing', detail: `set-style targets missing layer ${entry.layerId}` }
        }
        if (entry.expect?.digest !== undefined && document.layers[at]?.digest !== entry.expect.digest) {
          return { code: 'layer_digest_conflict', detail: `layer ${entry.layerId} changed since this patch was prepared` }
        }
      }
      return undefined
    }
    case 'set-view':
    case 'set-mode':
    case 'set-aoi':
      return undefined
  }
}

/** Apply one op to the document (pure); called only after every check passed. */
function applyOp(document: CollabDocument, op: CollabPatchOp): CollabDocument {
  switch (op.kind) {
    case 'upsert-layer': {
      const layers = document.layers.filter(layer => layer.id !== op.layer.id)
      layers.push({
        id: op.layer.id,
        ...(op.layer.digest === undefined ? {} : { digest: op.layer.digest }),
      })
      return { ...document, layers }
    }
    case 'remove-layer':
      return { ...document, layers: document.layers.filter(layer => layer.id !== op.layerId) }
    case 'reorder-layers':
      return {
        ...document,
        layers: op.layerIds.map(id => {
          const layer = document.layers.find(candidate => candidate.id === id)
          if (layer === undefined) throw new Error(`reorder lost layer ${id}`)
          return layer
        }),
      }
    case 'set-view':
      return { ...document, view: { center: [op.view.center[0], op.view.center[1]], zoom: op.view.zoom, wkid: op.view.wkid } }
    case 'set-mode':
      return { ...document, mode: op.mode }
    case 'set-style':
      // Style content lives on the layer payload in the authoritative plane;
      // the collab face records the touched layers so undo post-state checks
      // can judge whether anyone restyled since.
      return document
    case 'set-aoi':
      return { ...document, aoiDigest: op.aoi === null ? null : valueDigest(op.aoi) }
  }
}

/** The recorded-outcome lookup the engine accepts: rows (durable state) or a map. */
type CollabLedgerSource = readonly CollabOperationOutcome[] | ReadonlyMap<string, CollabOperationOutcome>

function ledgerLookup(ledger: CollabLedgerSource | undefined): (operationId: string) => CollabOperationOutcome | undefined {
  if (ledger === undefined) return () => undefined
  if (Array.isArray(ledger as readonly unknown[])) {
    const rows = ledger as readonly CollabOperationOutcome[]
    return operationId => rows.find(row => row.operationId === operationId)
  }
  const map = ledger as ReadonlyMap<string, CollabOperationOutcome>
  return operationId => map.get(operationId)
}

/**
 * Commit one patch in a single synchronous segment.
 * @param document - the authoritative document face at commit time.
 * @param patch - the conditional patch (ops + optimistic base revision + optional operation id).
 * @param context.ledger - prior outcomes keyed by operation id (bounded by the caller); enables idempotent replay.
 * @param context.baseDocument - the document at `patch.expectedRevision`, when the caller still holds it (enriches the stale diff).
 * @returns accepted (next document + revision), duplicate (recorded outcome), conflict (explainable diff), or invalid (structural).
 */
export function commitPatch(
  document: CollabDocument,
  patch: CollabPatch,
  context: {
    readonly ledger?: CollabLedgerSource
    readonly baseDocument?: CollabDocument
  } = {},
): CollabCommitResult {
  if (patch.expectedRevision !== document.revision) {
    return {
      status: 'conflict',
      code: 'stale_revision',
      diff: conflictOf(patch.expectedRevision, document, [], context.baseDocument),
    }
  }
  if (patch.operationId !== undefined) {
    const recorded = ledgerLookup(context.ledger)(patch.operationId)
    if (recorded !== undefined) return { status: 'duplicate', outcome: recorded }
  }
  const entries: CollabConflictEntry[] = []
  let working = document
  for (const [index, op] of patch.ops.entries()) {
    const failed = documentExpectationConflict(working, op) ?? opSpecificConflict(working, op)
    if (failed !== undefined) {
      entries.push({ index, kind: op.kind, code: failed.code, detail: failed.detail })
      break
    }
    working = applyOp(working, op)
  }
  if (entries.length > 0) {
    return {
      status: 'conflict',
      code: entries[0]?.code ?? 'stale_revision',
      diff: conflictOf(patch.expectedRevision, document, entries, context.baseDocument),
    }
  }
  const next: CollabDocument = { ...working, revision: document.revision + 1 }
  return { status: 'accepted', revision: next.revision, document: next, ops: patch.ops }
}

/**
 * Ledger append helper: bounded insert that drops the oldest outcome beyond
 * the ledger bound. Callers keep the ledger wherever their operation records
 * live (the authoritative projection state owns the durable copy).
 * @param ledger - the current bounded ledger rows.
 * @param outcome - the outcome to append.
 * @returns the next ledger rows (oldest dropped first beyond the bound).
 */
export function withLedgerEntry(
  ledger: readonly CollabOperationOutcome[],
  outcome: CollabOperationOutcome,
): CollabOperationOutcome[] {
  const next = [...ledger, outcome]
  return next.length > MAX_OPERATION_LEDGER ? next.slice(next.length - MAX_OPERATION_LEDGER) : next
}

/**
 * Judge one recorded operation against the current document — the
 * compensating-undo precondition. The record carries its post-state (what
 * the document looked like for the slices it touched) and its inverse (the
 * unconditional compensation ops). Verdicts:
 * - `matched` — every slice still shows the recorded post-state, so the
 *   inverse changes something real: propose it as a NEW revision.
 * - `already-undone` — every slice already equals the inverse's effect, so
 *   the compensation would be a no-op.
 * - `changed` — at least one slice moved on after the operation (or the mix
 *   of moved and intact slices makes an atomic undo impossible): undoing
 *   would overwrite concurrent work, so the caller refuses with the detail.
 * @param document - the current authoritative document face.
 * @param post - the recorded post-state of the operation.
 * @param inverse - the compensation ops (unconditional payloads).
 * @returns the undo verdict.
 */
export function checkUndoTarget(
  document: CollabDocument,
  post: CollabOperationPost,
  inverse: readonly CollabPatchOp[],
): CollabUndoVerdict {
  type Slice = 'matched' | 'undone'
  const slices: Slice[] = []
  let changed: string | undefined

  const judgeLayer = (id: string, postDigest: string | undefined): void => {
    const at = layerIndex(document, id)
    if (at === -1) {
      // The layer is gone now. If the inverse removes it too, the effect is
      // already undone; if the inverse needs it (re-add or order), undoing
      // cannot restore what another writer deleted.
      const inverseRemoves = inverse.some(op => op.kind === 'remove-layer' && op.layerId === id)
      if (inverseRemoves) slices.push('undone')
      else changed = `layer ${id} was removed after the operation`
      return
    }
    const currentDigest = document.layers[at]?.digest
    const inverseAdds = inverse.some(op => op.kind === 'upsert-layer' && op.layer.id === id)
    if (inverseAdds) {
      // Undoing an add (or re-adding a removal): present with the post digest
      // means the operation's effect is live (or the removal was undone with
      // the same content); a different digest means someone rewrote it.
      if (postDigest === undefined || currentDigest === postDigest) slices.push('matched')
      else changed = `layer ${id} changed after the operation`
      return
    }
    if (currentDigest !== postDigest) changed = `layer ${id} changed after the operation`
    else slices.push('matched')
  }

  for (const layer of post.layers ?? []) judgeLayer(layer.id, layer.digest)
  for (const style of post.styleVersions ?? []) {
    // A style touch is live while the layer carries the recorded style
    // version; a restyle by anyone (or a removal) moved it on. If the layer
    // already carries the inverse's style version, the undo is a no-op.
    const at = layerIndex(document, style.layerId)
    const current = document.layers[at]?.styleVersion
    if (at === -1) {
      changed = `layer ${style.layerId} was removed after the operation`
      continue
    }
    if (current === style.styleVersion) {
      slices.push('matched')
      continue
    }
    const inverseEntry = inverse.find(op => op.kind === 'set-style' && op.entries.some(entry => entry.layerId === style.layerId))
    const inverseVersion = inverseEntry?.kind === 'set-style'
      ? (inverseEntry.entries.find(entry => entry.layerId === style.layerId)?.style as { styleVersion?: string } | null | undefined)?.styleVersion
      : undefined
    if (inverseVersion !== undefined && current === inverseVersion) slices.push('undone')
    else changed = `layer ${style.layerId} was restyled after the operation`
  }
  for (const id of post.absentIds ?? []) {
    const at = layerIndex(document, id)
    if (at === -1) {
      slices.push('matched')
      continue
    }
    // The id is back. Same content as the inverse's re-add means the removal
    // was already undone; different content means someone wrote new material.
    const inverseAdd = inverse.find(op => op.kind === 'upsert-layer' && op.layer.id === id)
    if (inverseAdd?.kind === 'upsert-layer' && document.layers[at]?.digest === inverseAdd.layer.digest) {
      slices.push('undone')
    } else {
      changed = `layer ${id} appeared after the operation`
    }
  }
  if (post.order !== undefined) {
    const currentOrder = document.layers.map(layer => layer.id)
    const inverseReorders = inverse.some(op => op.kind === 'reorder-layers')
    if (post.order.length === currentOrder.length && post.order.every((id, at) => currentOrder[at] === id)) {
      slices.push('matched')
    } else if (inverseReorders) {
      slices.push('undone')
    } else {
      changed = `layer order moved on after the operation (now [${currentOrder.join(', ')}])`
    }
  }
  if (post.view !== undefined) {
    const inverseView = inverse.find(op => op.kind === 'set-view')
    if (valueDigest(document.view) === valueDigest(post.view)) slices.push('matched')
    else if (inverseView?.kind === 'set-view' && valueDigest(document.view) === valueDigest(inverseView.view)) slices.push('undone')
    else changed = 'the view was moved after the operation'
  }
  if (post.mode !== undefined) {
    const inverseMode = inverse.find(op => op.kind === 'set-mode')
    if (document.mode === post.mode) slices.push('matched')
    else if (inverseMode?.kind === 'set-mode' && document.mode === inverseMode.mode) slices.push('undone')
    else changed = `the mode was switched after the operation (now ${document.mode})`
  }
  if (post.aoiDigest !== undefined) {
    const inverseAoi = inverse.find(op => op.kind === 'set-aoi')
    const current = document.aoiDigest
    const inverseDigest = inverseAoi?.kind === 'set-aoi'
      ? (inverseAoi.aoi === null ? null : valueDigest(inverseAoi.aoi))
      : undefined
    if (current === post.aoiDigest) slices.push('matched')
    else if (inverseDigest !== undefined && current === inverseDigest) slices.push('undone')
    else changed = 'the AOI changed after the operation'
  }

  if (changed !== undefined) return { verdict: 'changed', detail: changed }
  if (slices.length > 0 && slices.every(slice => slice === 'undone')) return { verdict: 'already-undone' }
  return { verdict: 'matched' }
}
