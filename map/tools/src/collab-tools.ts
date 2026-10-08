/**
 * The collaboration tools: `map_apply_patch` (conditional multi-op patch with
 * writer identity, expectedRevision, and idempotent operation ids) and
 * `map_undo` (compensating undo as a NEW revision). Both run the single-
 * segment commit checks — writer gate, CAS, per-op expectations — through
 * the `spatial-collab` engine against the authoritative `mapContainer`
 * projection, then return one versioned `map-change` v4 meta that folds
 * under the same commit protocol as every other mutation. Conflicts are
 * success results carrying the explainable diff: the writer re-reads and
 * re-decides; the server never rewrites a stale patch onto a new base, and
 * a patch naming deleted layers is never auto-replayed.
 *
 * Undo never promises to roll back external resources (published artifacts,
 * files, LBS jobs stay untouched — design §11.3); it only appends the
 * compensating revision and keeps the original history in the session log.
 *
 * @module @map-harness/map-tools/collab-tools
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MapChangeValidationError,
  validateMapChangeCandidate,
  buildMapChangeMeta,
  aoiDigestOf,
  layerDigestOf,
  type BaseMapChange,
  type GeoJsonFeatureCollection,
  type MapChange,
  type MapAoi,
  type MapContainerService,
  type MapOperationRecord,
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
} from '@map-harness/map-container'
import {
  checkUndoTarget,
  commitPatch,
  parseCollabPatch,
  renderConflictDiff,
  type CollabDocument,
  type CollabPatch,
  type CollabPatchOp,
  type SpatialCollabService,
} from '@map-harness/spatial-collab'
import { validateStyleSpec, type StyleSpec } from '@map-harness/spatial-viz'
import { DISPLAY_GEOMETRY_TYPES, validateGeoJsonValue } from '@map-harness/spatial-catalog'
import { sessionOf } from './catalog-tools.ts'
import { assertDisplaySupported, displayDigestOf } from './display.ts'
import { decodeJsonParam } from './json-param.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { renderJson } from './output.ts'

/** The accepted projection read face (host-plane service, same pattern as the map tools). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
  return map
}

/** The collaboration writer-lifecycle service (host plane). */
function collabServiceOf(exec: ToolRunContext): SpatialCollabService {
  const service = serviceOf<SpatialCollabService>(exec, 'spatialCollab')
  if (service === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'spatial collab service is unavailable in this process')
  }
  return service
}

/**
 * Resolve the accepted `tool/call` the collaboration mutation pairs with —
 * the same native-direct rule every map mutation follows.
 */
function requirePendingCollabMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: NonNullable<ToolRunContext['agent']>['session'],
  name: 'map_apply_patch' | 'map_undo',
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'collab tools support native model-direct calls only; nested dispatch cannot change the map')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `${name} requires its accepted tool/call in the session log before execution`)
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** The lifecycle failure codes the collab tools surface. */
const LIFECYCLE_CODES: Record<string, 'WRITER_UNKNOWN' | 'WRITER_OFFLINE' | 'WRITER_RELEASED' | 'WRITE_PERMISSION_DENIED' | 'INVALID_ARGUMENT' | 'SPATIAL_SERVICE_UNAVAILABLE'> = {
  'unknown-writer': 'WRITER_UNKNOWN',
  'writer-offline': 'WRITER_OFFLINE',
  'writer-released': 'WRITER_RELEASED',
  'permission-denied': 'WRITE_PERMISSION_DENIED',
  'writer-active': 'INVALID_ARGUMENT',
  'service-disposed': 'SPATIAL_SERVICE_UNAVAILABLE',
}

/** Resolve the writer and open its commit gate, mapping lifecycle failures onto stable codes. */
function writerGateOf(
  collab: SpatialCollabService,
  session: NonNullable<ToolRunContext['agent']>['session'],
  writerId: string | undefined,
): { writer: { id: string }; gate: { close(): void } } {
  try {
    const writer = collab.writerFor(session, writerId)
    return { writer, gate: collab.gate(session, writer.id) }
  } catch (error) {
    const code = (error as { code?: string }).code
    const mapped = LIFECYCLE_CODES[code ?? '']
    if (mapped === undefined) throw error
    throw new SpatialError(mapped, error instanceof Error ? error.message : String(error))
  }
}

/** The identity face of one projected layer the engine compares. */
function collabDocOf(state: MapProjectionState): CollabDocument {
  return {
    revision: state.revision,
    layers: state.layers.map(layer => ({
      id: layer.id,
      digest: layerDigestOf(layer),
      ...(layer.style === undefined ? {} : { styleVersion: layer.style.styleVersion }),
    })),
    view: { center: [state.view.center[0], state.view.center[1]], zoom: state.view.zoom, wkid: state.view.wkid },
    mode: state.mode,
    aoiDigest: aoiDigestOf(state.aoi),
  }
}

/** The idempotency ledger from the applied-operation records (accepted outcomes only — the fold is their source). */
function ledgerOf(state: MapProjectionState): Map<string, { operationId: string; status: 'accepted'; revision: number }> {
  const ledger = new Map<string, { operationId: string; status: 'accepted'; revision: number }>()
  for (const record of state.operations) {
    if (record.operationId !== null) {
      ledger.set(record.operationId, { operationId: record.operationId, status: 'accepted', revision: record.revision })
    }
  }
  return ledger
}

/** Compile one accepted collab op into the authoritative base change (validating content). */
function compileOp(op: CollabPatchOp, callSeq: number): BaseMapChange {
  switch (op.kind) {
    case 'upsert-layer': {
      const data = op.layer.data as GeoJsonFeatureCollection
      if (typeof data !== 'object' || data === null || !Array.isArray((data as { features?: unknown }).features)) {
        throw new SpatialError('INVALID_GEOJSON', `layer "${op.layer.id}" data must be a GeoJSON FeatureCollection`)
      }
      try {
        validateGeoJsonValue(data, {
          enforceWgs84Range: true,
          allowedGeometryTypes: new Set(DISPLAY_GEOMETRY_TYPES),
        })
      } catch (error) {
        throw new SpatialError('INVALID_GEOJSON', error instanceof Error ? error.message : `layer "${op.layer.id}" data failed GeoJSON admission`)
      }
      assertDisplaySupported(data)
      const displayDigest = displayDigestOf(data)
      if (op.layer.digest !== undefined && op.layer.digest !== displayDigest) {
        throw new SpatialError('INVALID_ARGUMENT', `layer "${op.layer.id}" digest does not match its display data`)
      }
      const layer: MapProjectedLayer = {
        id: op.layer.id,
        name: op.layer.name,
        data,
        sourceCrs: op.layer.sourceCrs,
        opacity: op.layer.opacity,
        visible: op.layer.visible,
        sourceCallSeq: callSeq,
        displayDigest,
        ...(op.layer.legend === undefined ? {} : { legend: op.layer.legend }),
        ...(op.layer.resourceRef === undefined ? {} : { resourceRef: op.layer.resourceRef }),
        ...(op.layer.artifactRef === undefined ? {} : { artifactRef: op.layer.artifactRef }),
      }
      return { op: 'add-layer', layer }
    }
    case 'remove-layer':
      return { op: 'remove-layer', layerId: op.layerId }
    case 'reorder-layers':
      return { op: 'reorder-layers', layerIds: [...op.layerIds] }
    case 'set-view':
      return { op: 'set-view', view: { center: [op.view.center[0], op.view.center[1]], zoom: op.view.zoom, wkid: op.view.wkid } }
    case 'set-mode':
      return { op: 'set-mode', mode: op.mode }
    case 'set-style':
      return {
        op: 'set-style',
        styles: op.entries.map(entry => {
          if (entry.style === undefined) {
            throw new SpatialError('INVALID_ARGUMENT', `set-style entry for "${entry.layerId}" needs a style record (build one with viz_create_style) or null to clear`)
          }
          if (entry.style !== null) {
            for (const issue of validateStyleSpec(entry.style as StyleSpec)) {
              throw new SpatialError('INVALID_ARGUMENT', `style for "${entry.layerId}" rejected: ${issue.field} (${issue.code})`)
            }
          }
          return { layerId: entry.layerId, style: entry.style as StyleSpec | null }
        }),
      }
    case 'set-aoi': {
      const aoi: MapAoi | null = op.aoi === null
        ? null
        : {
            ...(op.aoi.name === undefined ? {} : { name: op.aoi.name }),
            ring: op.aoi.ring.map(point => [point[0], point[1]] as [number, number]),
          }
      return { op: 'set-aoi', aoi }
    }
  }
}

/** Rebind compensating layer additions to the call that proposes the undo. */
function rebindUndoSourceCallSeq(change: MapChange, callSeq: number): MapChange {
  if (change.op === 'add-layer') {
    return { ...change, layer: { ...change.layer, sourceCallSeq: callSeq } }
  }
  if (change.op === 'patch') {
    return { ...change, changes: change.changes.map(nested => rebindUndoSourceCallSeq(nested, callSeq) as BaseMapChange) }
  }
  return change
}

/** The collab-face inverse ops of one recorded operation (the undo target check reads them). */
function collabInverseOps(change: MapChange): CollabPatchOp[] {
  switch (change.op) {
    case 'patch':
      return change.changes.flatMap(nested => collabInverseOps(nested))
    case 'add-layer':
      return [{
        kind: 'upsert-layer',
        layer: {
          id: change.layer.id,
          name: change.layer.name,
          digest: layerDigestOf(change.layer),
          sourceCrs: change.layer.sourceCrs,
          opacity: change.layer.opacity,
          visible: change.layer.visible,
          data: change.layer.data,
        },
      }]
    case 'remove-layer':
      return [{ kind: 'remove-layer', layerId: change.layerId }]
    case 'set-view':
      return [{ kind: 'set-view', view: { center: [change.view.center[0], change.view.center[1]], zoom: change.view.zoom, wkid: change.view.wkid } }]
    case 'set-mode':
      return [{ kind: 'set-mode', mode: change.mode }]
    case 'set-style':
      return [{ kind: 'set-style', entries: change.styles.map(entry => ({ layerId: entry.layerId, style: entry.style })) }]
    case 'reorder-layers':
      return [{ kind: 'reorder-layers', layerIds: [...change.layerIds] }]
    case 'set-aoi':
      return [{ kind: 'set-aoi', aoi: change.aoi === null ? null : { ...(change.aoi.name === undefined ? {} : { name: change.aoi.name }), ring: change.aoi.ring.map(point => [point[0], point[1]] as [number, number]) } }]
  }
}

/** Shared argument parse: expected_revision / operation_id / writer_id. */
function parseCollabArgs(args: Record<string, unknown>): { expectedRevision?: number; operationId?: string; writerId?: string } {
  const { expected_revision: expectedRevision, operation_id: operationId, writer_id: writerId } = args as {
    expected_revision?: unknown
    operation_id?: unknown
    writer_id?: unknown
  }
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new SpatialError('INVALID_ARGUMENT', 'expected_revision must be a non-negative integer')
  }
  if (operationId !== undefined && (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(operationId))) {
    throw new SpatialError('INVALID_ARGUMENT', 'operation_id must be 1..64 chars of [A-Za-z0-9_.:-]')
  }
  if (writerId !== undefined && (typeof writerId !== 'string' || writerId.length === 0 || writerId.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(writerId))) {
    throw new SpatialError('INVALID_ARGUMENT', 'writer_id must be 1..64 chars of [A-Za-z0-9_.:-]')
  }
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(writerId === undefined ? {} : { writerId }),
  }
}

/** The conflict response every named refusal returns as a SUCCESS result (machine-readable, no meta). */
function conflictResult(code: string, currentRevision: number, extra: Record<string, unknown>): JsonValue {
  return JSON.parse(JSON.stringify({
    status: 'conflict',
    code,
    current_revision: currentRevision,
    ...extra,
    meta: null,
  })) as JsonValue
}

/** Render helper: model text omits the durable meta. */
function renderCollabJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the collab family. */
function collabPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/**
 * `map_apply_patch`: submit one conditional patch (upserts, deletes,
 * reorder, view/mode/style/aoi values) against the revision the writer read.
 * Every op may carry expectations; one failing op refuses the whole patch
 * with a per-op diff — deletes never auto-replay and accepted patches are
 * idempotent by operation id.
 */
export const mapApplyPatch = defineTool({
  name: 'map_apply_patch',
  description:
    'Apply a conditional multi-op patch to the session map as one atomic change (one new revision). '
    + 'Each op may carry expectations (digests/absence/order/values read via map_get_state); a stale op conflicts '
    + 'with a per-op diff and NOTHING applies — re-read and re-decide. Repeating an operation_id replays its first '
    + 'outcome instead of applying twice. Deletes of already-deleted layers are never replayed.',
  parameters: {
    patch: {
      type: 'json',
      required: true,
      description: 'Array of 1..8 conditional ops: '
        + '{kind:"upsert-layer",layer:{id,name,data,sourceCrs,opacity,visible,digest?},expect?} | '
        + '{kind:"remove-layer",layerId,expect?:{digest}} | {kind:"reorder-layers",layerIds,expect?:{order}} | '
        + '{kind:"set-view",view:{center,zoom,wkid},expect?:{viewDigest}} | {kind:"set-mode",mode,expect?:{mode}} | '
        + '{kind:"set-style",entries:[{layerId,style|null,expect?}]} | {kind:"set-aoi",aoi:{name?,ring}|null}. '
        + 'expect fields name what you read: {digest,absent,order,viewDigest,mode,aoiDigest}.',
    },
    expected_revision: { type: 'number', required: true, description: 'The map revision this patch was prepared against (map_get_state).' },
    operation_id: { type: 'string', description: 'Client operation id for idempotency; repeating it replays the first outcome.' },
    writer_id: { type: 'string', description: 'Registered writer to commit as; defaults to this session\'s own writer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCollabJson(value),
    presentationMeta: (_args, value) => collabPresentationMeta(value),
  },
  async execute(args, exec) {
    const { patch: rawPatch } = args as { patch?: unknown }
    const decodedPatch = decodeJsonParam(rawPatch, 'patch')
    const parsedArgs = parseCollabArgs(args as Record<string, unknown>)
    if (decodedPatch === undefined) throw new SpatialError('INVALID_ARGUMENT', 'patch is required')
    const parsed = parseCollabPatch({
      ...(parsedArgs.operationId === undefined ? {} : { operationId: parsedArgs.operationId }),
      expectedRevision: parsedArgs.expectedRevision ?? 0,
      ops: decodedPatch,
    })
    if (parsed.status === 'invalid') throw new SpatialError('INVALID_ARGUMENT', parsed.detail)
    const patch: CollabPatch = { ...parsed.patch, expectedRevision: parsedArgs.expectedRevision ?? parsed.patch.expectedRevision }

    const session = sessionOf(exec)
    const mapService = mapServiceOf(exec)
    const collab = collabServiceOf(exec)
    const pending = requirePendingCollabMutation(exec, mapService, session, 'map_apply_patch')
    const { writer, gate } = writerGateOf(collab, session, parsedArgs.writerId)
    try {
      exec.signal.throwIfAborted()
      const state = mapService.stateOf(session)
      const result = commitPatch(collabDocOf(state), patch, { ledger: ledgerOf(state) })
      if (result.status === 'invalid') throw new SpatialError('INVALID_ARGUMENT', result.detail)
      if (result.status === 'duplicate') {
        return JSON.parse(JSON.stringify({
          status: 'duplicate',
          operation_id: result.outcome.operationId,
          recorded_status: result.outcome.status,
          ...(result.outcome.revision === undefined ? {} : { recorded_revision: result.outcome.revision }),
          note: 'this operation id already settled; nothing applied again',
          meta: null,
        })) as JsonValue
      }
      if (result.status === 'conflict') {
        return conflictResult(result.code, result.diff.currentRevision, {
          expected_revision: patch.expectedRevision,
          diff: {
            entries: result.diff.entries,
            summary: result.diff.summary,
            current_layers: result.diff.currentLayers,
          },
          detail: renderConflictDiff(result.diff),
        })
      }
      // Accepted by the engine: compile to the authoritative change and
      // pre-validate bounds. One op compiles to its bare change; several ops
      // become one atomic patch change (one revision on the fold).
      const compiled: BaseMapChange[] = result.ops.map(op => compileOp(op, pending.callSeq))
      const change: MapChange = compiled.length === 1 ? compiled[0] as BaseMapChange : { op: 'patch', changes: compiled }
      let targetRevision: number
      try {
        targetRevision = validateMapChangeCandidate(state, change)
      } catch (error) {
        if (error instanceof MapChangeValidationError) {
          throw new SpatialError('INVALID_ARGUMENT', `patch refused: ${error.message}`)
        }
        throw error
      }
      const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change, {
        ...(parsedArgs.operationId === undefined ? {} : { operationId: parsedArgs.operationId }),
        writerId: writer.id,
      })))
      return JSON.parse(JSON.stringify({
        status: 'proposed',
        target_revision: targetRevision,
        commit: 'applies when this result is accepted; re-read map_get_state to confirm',
        ops: result.ops.map(op => op.kind),
        meta,
      })) as JsonValue
    } finally {
      gate.close()
    }
  },
})

/**
 * `map_undo`: propose the compensating change of one recorded operation as a
 * NEW revision. Without an index it walks the newest undoable operation;
 * operations whose slice moved on after them conflict with a named detail
 * instead of overwriting concurrent work. Undo never claims to roll back
 * external resources — published artifacts, files, and LBS jobs stay as they
 * are; only the map document compensates.
 */
export const mapUndo = defineTool({
  name: 'map_undo',
  description:
    'Undo one recorded map operation by proposing its compensating change as a NEW revision (history stays). '
    + 'Without undo_of, undoes the newest still-live operation (repeat to walk back). Another writer having changed '
    + 'the affected slice since conflicts the undo — re-decide explicitly. External artifacts and files are NOT rolled back.',
  parameters: {
    undo_of: { type: 'number', description: 'Operation index to undo (from map_get_state history); default walks the newest undoable operation.' },
    expected_revision: { type: 'number', description: 'Refuse unless the map is still at this revision.' },
    operation_id: { type: 'string', description: 'Client operation id for the undo itself (idempotency).' },
    writer_id: { type: 'string', description: 'Registered writer to commit as; defaults to this session\'s own writer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCollabJson(value),
    presentationMeta: (_args, value) => collabPresentationMeta(value),
  },
  async execute(args, exec) {
    const parsedArgs = parseCollabArgs(args as Record<string, unknown>)
    const { undo_of: undoOf } = args as { undo_of?: unknown }
    if (undoOf !== undefined && (typeof undoOf !== 'number' || !Number.isInteger(undoOf) || undoOf < 1)) {
      throw new SpatialError('INVALID_ARGUMENT', 'undo_of must be a positive operation index')
    }

    const session = sessionOf(exec)
    const mapService = mapServiceOf(exec)
    const collab = collabServiceOf(exec)
    const pending = requirePendingCollabMutation(exec, mapService, session, 'map_undo')
    const { writer, gate } = writerGateOf(collab, session, parsedArgs.writerId)
    try {
      exec.signal.throwIfAborted()
      const state = mapService.stateOf(session)
      if (parsedArgs.expectedRevision !== undefined && state.revision !== parsedArgs.expectedRevision) {
        return conflictResult('stale_revision', state.revision, {
          expected_revision: parsedArgs.expectedRevision,
          detail: `the map moved to revision ${state.revision}; re-read map_get_state before undoing`,
        })
      }
      const doc = collabDocOf(state)
      const verdictOf = (record: MapOperationRecord) => checkUndoTarget(doc, record.post, collabInverseOps(record.inverse as MapChange))

      let target: MapOperationRecord | undefined
      let latestVerdict: { verdict: string; detail?: string } | undefined
      if (undoOf !== undefined) {
        const record = state.operations.find(candidate => candidate.index === undoOf)
        if (record === undefined) {
          throw new SpatialError('INVALID_ARGUMENT', `no recorded operation ${undoOf}; it may have left the undo horizon — read map_get_state history`)
        }
        const verdict = record.inverse === null ? { verdict: 'changed', detail: 'the operation has no expressible compensation' } : verdictOf(record)
        latestVerdict = verdict
        if (verdict.verdict === 'matched') target = record
      } else {
        // Walk back the ORIGINAL history: undo records compensate explicitly
        // (redo = map_undo with undo_of naming the undo record), so the
        // repeated-command semantics stay stable.
        for (let at = state.operations.length - 1; at >= 0; at -= 1) {
          const record = state.operations[at]
          if (record === undefined || record.inverse === null || record.undoOf !== null) continue
          const verdict = verdictOf(record)
          if (verdict.verdict === 'matched') {
            target = record
            break
          }
          if (latestVerdict === undefined) latestVerdict = verdict
        }
      }

      if (target === undefined) {
        if (latestVerdict?.verdict === 'already-undone') {
          return JSON.parse(JSON.stringify({
            status: 'already-undone',
            note: 'the recorded effect is already gone; nothing to compensate',
            meta: null,
          })) as JsonValue
        }
        if (latestVerdict?.verdict === 'changed') {
          return conflictResult('undo_conflict', state.revision, {
            detail: latestVerdict.detail ?? 'the affected slice changed after the operation',
            note: 'undoing would overwrite concurrent work; re-read map_get_state and re-decide',
          })
        }
        return JSON.parse(JSON.stringify({
          status: 'nothing-to-undo',
          note: 'no recorded operation is still live; the ledger horizon may have passed',
          meta: null,
        })) as JsonValue
      }

      const inverse = rebindUndoSourceCallSeq(target.inverse as BaseMapChange, pending.callSeq) as BaseMapChange
      let targetRevision: number
      try {
        targetRevision = validateMapChangeCandidate(state, inverse)
      } catch (error) {
        if (error instanceof MapChangeValidationError) {
          return conflictResult('capacity', state.revision, {
            detail: `the compensation no longer fits the current map: ${error.message}`,
          })
        }
        throw error
      }
      const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, inverse, {
        ...(parsedArgs.operationId === undefined ? {} : { operationId: parsedArgs.operationId }),
        undoOf: target.index,
        writerId: writer.id,
      })))
      return JSON.parse(JSON.stringify({
        status: 'proposed',
        undo_of: target.index,
        undoing: target.summary,
        target_revision: targetRevision,
        commit: 'applies when this result is accepted; re-read map_get_state to confirm',
        external_note: 'map-plane compensation only; external artifacts and files are not rolled back',
        meta,
      })) as JsonValue
    } finally {
      gate.close()
    }
  },
})
