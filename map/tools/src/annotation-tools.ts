/** Agent-owned edits to the session's user annotation layer. */
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  AGENT_ANNOTATION_META_KIND,
  AGENT_ANNOTATION_SCHEMA_VERSION,
  decodeAgentAnnotationMeta,
  settleAgentAnnotation,
  type MapContainerService,
} from '@map-harness/map-container'
import { sessionOf } from './catalog-tools.ts'
import { serviceOf } from './service-context.ts'
import { SpatialError } from './spatial-errors.ts'
import { renderJson } from './output.ts'
import { modelSymbolOf } from './layer-tools.ts'

/** Edit annotations and settle visual candidates under the agent's identity. */
export const mapEditAnnotation = defineTool({
  name: 'map_edit_annotation',
  description: 'Update, delete, style, reorder, or undo annotations; apply or dismiss visual candidates. Every change is revision-checked and recorded as an agent action without claiming human review.',
  parameters: {
    change: { type: 'json', required: true, description: 'Change: annotation-update{featureId,expectedUpdatedAt,geometry?,name?,description?,symbol?}, annotation-delete{featureIds}, annotation-undo{operationId}, annotation-layer-style{symbol}, annotation-layer-order{layerIds}, visual-proposal-apply, visual-proposal-dismiss, visual-change-apply, or visual-change-dismiss. Each object includes its op; candidate operations require proposalId or changeId respectively. layerIds lists all layers in bottom-to-top order; symbol may be null and its version is derived by the host.' },
    expected_revision: { type: 'number', required: true, description: 'Current map revision from map_get_state.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, JsonValue>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    if (exec.parent !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'map_edit_annotation requires a native tool call.')
    exec.signal.throwIfAborted()
    const session = sessionOf(exec)
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'The map service is unavailable.')
    const pending = map.pendingCallOf(session, exec.callId)
    if (pending === undefined || pending.name !== 'map_edit_annotation') {
      throw new SpatialError('INVALID_ARGUMENT', 'map_edit_annotation requires its accepted tool call.')
    }
    const { change, expected_revision: revision } = args as { change?: unknown; expected_revision?: unknown }
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'expected_revision must be a nonnegative integer.')
    }
    const state = map.stateOf(session)
    if (revision !== state.revision) throw new SpatialError('STALE_OBSERVATION', 'The map changed; read its current revision.')
    const operationId = `agent-ann-${createHash('sha256').update(`${session.id}\n${pending.callId}\n${pending.callSeq}`).digest('hex').slice(0, 24)}`
    let proposedChange = change
    if (typeof change === 'object' && change !== null && !Array.isArray(change)) {
      const record = change as Record<string, unknown>
      if ((record.op === 'annotation-layer-style' || record.op === 'annotation-update')
        && record.symbol !== undefined && record.symbol !== null) {
        proposedChange = { ...record, symbol: modelSymbolOf(record.symbol, 'user-annotations') }
      }
    }
    const operation = typeof proposedChange === 'object' && proposedChange !== null && !Array.isArray(proposedChange)
      ? proposedChange as Record<string, unknown> : {}
    const appliesCandidate = operation.op === 'visual-proposal-apply' || operation.op === 'visual-change-apply'
    const featureId = appliesCandidate ? `ann-${createHash('sha256').update(`${operationId}\nfeature`).digest('hex').slice(0, 24)}` : undefined
    const meta = decodeAgentAnnotationMeta({
      kind: AGENT_ANNOTATION_META_KIND,
      schemaVersion: AGENT_ANNOTATION_SCHEMA_VERSION,
      sourceCallSeq: pending.callSeq,
      targetRevision: revision,
      operationId,
      sessionId: session.id,
      at: new Date().toISOString(),
      ...(featureId === undefined ? {} : { featureId }),
      change: proposedChange,
    })
    if (meta === undefined) throw new SpatialError('INVALID_ARGUMENT', 'The annotation change is invalid.')
    const candidate = settleAgentAnnotation(state, meta, pending.callId, Number.MAX_SAFE_INTEGER)
    if (candidate.revision !== state.revision + 1) {
      const code = candidate.diagnostics.at(-1)?.code ?? 'invalid-meta'
      throw new SpatialError('INVALID_ARGUMENT', `Annotation change was not applied (${code}).`)
    }
    return {
      status: 'proposed', target_revision: revision, operation_id: operationId,
      ...(featureId === undefined ? {} : { feature_id: featureId }),
      meta: JSON.parse(JSON.stringify(meta)) as JsonValue,
    }
  },
})
