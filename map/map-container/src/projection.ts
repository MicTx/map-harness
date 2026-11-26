/**
 * The `mapContainer` session projection: a pure synchronous fold of
 * `tool/call` and `tool/result` events for the map tools into the container
 * state the browser tab renders — and, since P0a, the single authoritative
 * map state of the process.
 *
 * The session log is the durable source of truth: a mutation's successful
 * `tool/result` carries the versioned `map-change` meta (`tool/result.meta`),
 * and the fold pairs it with the `tool/call` that seeded the pending entry.
 * Only successful, paired, first-settled results apply; everything else
 * leaves the map unchanged (see {@link settleMapResult}). The persisted state
 * is plain JSON (ordered arrays, never `Map`/`Set`) so the projection cache
 * can checkpoint it; `stateVersion` 3 discards the pre-P0a Map-based cache
 * rows, which refold from the raw log. Pre-P0a flat metas decode through the
 * dedicated legacy path so old logs replay unchanged.
 *
 * @module @map-harness/map-container/projection
 */
import { z } from 'zod'
import { applyMapInteractionEvent } from './interaction-projection.ts'
import { MAP_INTERACTION_NOTICE, mapInteractionNoticeSchema, mapInteractionStateSchema, mapUseMetaSchema, stopMapInteraction, type MapInteractionState } from './interaction-protocol.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MAP_OBSERVATION_META_KIND,
  MAP_OBSERVATION_SCHEMA_VERSION,
  mapObservationRecordSchema,
} from './observation-protocol.ts'
import type { StyleSpec } from '@map-harness/spatial-viz'
import type { FeatureOverrides, ImagerySpec, SymbolStyle } from '@map-harness/map-layers'
import type { MapLayerStream, MapLayerTerrain } from './registry.ts'
import { isSupportedDisplayWkid } from '@map-harness/spatial-catalog'
import { resolveSymbolPreset } from '@map-harness/map-layers'
import {
  type VisualProposalRecord,
  visualProposalRecordSchema,
} from './visual-proposal-protocol.ts'
import { decodeMapObservationMeta, type MapObservationRecord } from './observation-protocol.ts'
import {
  compareObservationEvidence,
  decodeVisualComparisonMeta,
  mapComparisonRecordSchema,
  visualChangeRecordSchema,
  type MapComparisonRecord,
  type VisualChangeRecord,
} from './comparison-protocol.ts'
import { MAX_VISUAL_CHANGE_CANDIDATES, MAX_VISUAL_COMPARISONS } from './comparison-limits.ts'
import { MAP_USER_CHANGE_SOURCE, lowerUserChange, userChangeOfNoticeText } from './user-change.ts'
import { decodeAgentAnnotationMeta } from './agent-annotation.ts'
import {
  MAP_MUTATION_TOOL_NAMES,
  MAP_PENDING_TOOL_NAMES,
  MAP_PROJECTION_STATE_VERSION,
  MAX_MAP_DIAGNOSTICS,
  MAX_PENDING_MAP_CALLS,
  initialMapProjectionState,
  buildMapChangeMeta,
  mapProjectionStateSchema,
  MAX_MAP_OBSERVATION_HISTORY,
  observationCandidateOf,
  settleMapResult,
  settleAgentAnnotation,
  settleUserChange,
  withWaybackComparison,
  settleVisualProposalResult,
  settleVisualChangeResult,
  type MapDiagnostic,
  type MapPendingToolName,
  type MapPendingCall,
  type MapProjectionState,
} from './protocol.ts'

/** One folded layer: the durable projection of a successful `map_add_layer` result's metadata. */
export interface ProjectedLayer {
  readonly id: string
  readonly name: string
  /** Protected authoring role; absent means an ordinary model/business layer. */
  readonly role?: 'user-annotation' | 'visual-proposal' | 'visual-change'
  readonly featureCount: number
  readonly sourceCrs: string
  readonly visible: boolean
  readonly opacity: number
  /** The GeoJSON the browser renders; WGS84 lon/lat per the coordinate exchange format. Absent on imagery layers. */
  readonly data: unknown
  /** The rendered-identity digest (P0b), when the tool supplied one. */
  readonly displayDigest?: string
  /** Exact artifact ref (P0b), when the layer renders a published artifact. */
  readonly artifactRef?: string
  /** Exact resource ref (P0b), when the layer renders catalog data. */
  readonly resourceRef?: string
  /** Minimal single-symbol legend (P0b), when the layer carries one. */
  readonly legend?: { title: string; symbol: { color: string; outline: string } }
  /** The classification style (P3 visualization), when `viz_classify`/`viz_compare` styled the layer. */
  readonly style?: StyleSpec
  /** The presentation symbol (layer-state work), when `layer_set_style` set one. */
  readonly symbol?: SymbolStyle
  /** The per-feature overrides (layer-state work), when `layer_set_style` set any. */
  readonly overrides?: FeatureOverrides
  /** The display group (layer-state work), when `layer_set_state` set one. */
  readonly group?: string
  /** The key-free tile-overlay identity, when the layer is an imagery layer. */
  readonly imagery?: ImagerySpec
  /** The terrain identity (terrain preview), when the layer is bound to one surface version. */
  readonly terrain?: MapLayerTerrain
  /** The realtime stream identity (stream workbench), when the layer drives one. */
  readonly stream?: MapLayerStream
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The client-visible container view (each layer carries its WGS84 GeoJSON for rendering). */
    mapContainer: {
      layers: ProjectedLayer[]
      view: { center: [number, number]; zoom: number; wkid: number; scale?: number; rotation?: number }
      interaction: MapInteractionState
      mode: 'map' | 'scene'
      /** Explicit basemap selection, or null for the historical fixed default. */
      basemap: import('@map-harness/map-layers').BasemapSelection | null
      imageryDisplay: import('./protocol.ts').ImageryDisplayState
      waybackComparison: import('./wayback-comparison.ts').WaybackComparison | null
      aoi: { name?: string; ring: [number, number][] } | null
      revision: number
      operations: { index: number; operationId: string | null; undoOf: number | null; writerId: string | null; revision: number; summary: string }[]
      /** The live visual-observation request, when one is pending. */
      observationRequest: { callId: string; requestSeq: number; revision: number; expiresAtMs: number } | null
      /** The last accepted observation evidence record, or `null`. */
      latestObservation: MapObservationRecord | null
      /** Bounded observation evidence records in fold order. */
      observationHistory: readonly MapObservationRecord[]
      /** Bounded two-image comparison records. */
      comparisons: readonly MapComparisonRecord[]
      /** Bounded visual-proposal records, including reviewed evidence. */
      visualProposals: readonly VisualProposalRecord[]
      /** Bounded visual-change records, including reviewed evidence. */
      visualChanges: readonly VisualChangeRecord[]
    }
  }
}

const MUTATION_NAMES: readonly string[] = [...MAP_MUTATION_TOOL_NAMES, ...MAP_PENDING_TOOL_NAMES]

/** How many operation summaries the wire exposes to the browser history face. */
const WIRE_OPERATION_SUMMARIES = 12

const wireSchema = z.object({
  interaction: mapInteractionStateSchema,
  layers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['user-annotation', 'visual-proposal', 'visual-change']).optional(),
    featureCount: z.number().int().nonnegative(),
    sourceCrs: z.string(),
    visible: z.boolean(),
    opacity: z.number(),
    data: z.unknown(),
    displayDigest: z.string().optional(),
    artifactRef: z.string().optional(),
    resourceRef: z.string().optional(),
    legend: z.object({
      title: z.string(),
      symbol: z.object({ color: z.string(), outline: z.string() }).strict(),
    }).strict().optional(),
    style: z.unknown().optional(),
    symbol: z.unknown().optional(),
    overrides: z.unknown().optional(),
    group: z.string().optional(),
    imagery: z.unknown().optional(),
    terrain: z.object({
      surfaceRef: z.string(),
      revision: z.string(),
      verticalDatum: z.string(),
      verticalUnits: z.string(),
      epoch: z.string(),
      elevationField: z.string(),
      gridColumns: z.number().int().positive(),
      gridRows: z.number().int().positive(),
      sourcePointCount: z.number().int().positive(),
    }).strict().optional(),
    stream: z.unknown().optional(),
  })).max(32),
  view: z.object({
    center: z.tuple([z.number(), z.number()]),
    zoom: z.number(),
    scale: z.number().positive().optional(),
    rotation: z.number().finite().optional(),
    wkid: z.number().int().check((value) => {
      if (!isSupportedDisplayWkid(value.value)) value.issues.push({ code: 'custom', message: `unsupported display WKID ${value.value}`, input: value.value, path: [] })
    }),
  }),
  mode: z.union([z.literal('map'), z.literal('scene')]),
  basemap: z.unknown().nullable(),
  imageryDisplay: z.unknown(),
  waybackComparison: z.unknown().nullable(),
  aoi: z.object({
    name: z.string().optional(),
    ring: z.array(z.tuple([z.number(), z.number()])),
  }).nullable(),
  revision: z.number().int().nonnegative(),
  operations: z.array(z.object({
    index: z.number().int().nonnegative(),
    operationId: z.string().nullable(),
    undoOf: z.number().int().nonnegative().nullable(),
    writerId: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    summary: z.string(),
  })).max(12),
  undoableAnnotation: z.object({
    index: z.number().int().nonnegative(),
    operationId: z.string().nullable(),
    undoOf: z.number().int().nonnegative().nullable(),
    writerId: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    summary: z.string(),
  }).nullable(),
  observationRequest: z.object({ callId: z.string().min(1), requestSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), expiresAtMs: z.number() }).nullable(),
  latestObservation: mapObservationRecordSchema.nullable(),
  observationHistory: z.array(mapObservationRecordSchema).max(MAX_MAP_OBSERVATION_HISTORY),
  comparisons: z.array(mapComparisonRecordSchema).max(MAX_VISUAL_COMPARISONS),
  visualProposals: z.array(visualProposalRecordSchema),
  visualChanges: z.array(visualChangeRecordSchema).max(MAX_VISUAL_CHANGE_CANDIDATES),
})

/**
 * Fold one message when it is a user map change notice: parse the record
 * from its text, lower it, and settle it once per operation id.
 * @param state - the accepted state.
 * @param seq - seq of the committing event.
 * @param message - an inserted inbox message or a committed user message.
 * @returns the next state, or the input state for any other message.
 */
function foldUserChangeMessage(state: MapProjectionState, seq: number, message: { readonly source: { readonly kind: string }; readonly content: readonly unknown[] }): MapProjectionState {
  if (message.source.kind === 'map-interaction') {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null || !('text' in block)
        || typeof block.text !== 'string' || !block.text.startsWith(MAP_INTERACTION_NOTICE)) continue
      let payload: unknown
      try { payload = JSON.parse(block.text.slice(MAP_INTERACTION_NOTICE.length)) }
      catch (invalidNotice) { void invalidNotice; continue }
      const parsed = mapInteractionNoticeSchema.safeParse(payload)
      if (!parsed.success || parsed.data.turnStartSeq !== state.interaction.turnStartSeq) return state
      return { ...state, interaction: stopMapInteraction(state.interaction, 'user-interrupted'), observationRequest: null }
    }
    return state
  }
  if (message.source.kind !== MAP_USER_CHANGE_SOURCE) return state
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { type?: unknown; text?: unknown }).type === 'text' ? (block as { text?: unknown }).text : undefined
    if (typeof text !== 'string') continue
    const record = userChangeOfNoticeText(text)
    if (record === undefined) continue
    if (record.change.op === 'set-wayback-comparison') {
      if (record.targetRevision !== state.revision || state.operations.some(operation => operation.operationId === record.operationId)) return state
      return withWaybackComparison(state, record.change.pair, record.operationId, seq) ?? state
    }
    const lowered = lowerUserChange(record.change, resolvePresetSymbol)
    if (lowered === 'preset-unknown') return state
    const changed = settleUserChange(state, {
      seq,
      operationId: record.operationId,
      targetRevision: record.targetRevision,
      change: lowered,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.at === undefined ? {} : { at: record.at }),
      ...(record.featureId === undefined ? {} : { featureId: record.featureId }),
    })
    return changed.revision === state.revision ? changed : {
      ...changed, interaction: stopMapInteraction(changed.interaction, 'user-interrupted'), observationRequest: null,
    }
  }
  return state
}

/**
 * Fold a read-only comparison result without entering pendingCalls or the
 * map revision. Only two already persisted observations can be cited.
 */
function diagnostic(state: MapProjectionState, seq: number, code: MapDiagnostic['code']): MapProjectionState {
  return { ...state, diagnostics: [...state.diagnostics, { seq, code }].slice(-MAX_MAP_DIAGNOSTICS) }
}

function foldComparisonResult(
  state: MapProjectionState,
  meta: unknown,
  seq: number,
  pending: MapPendingCall | undefined,
  isError: boolean,
  citations: readonly number[] | undefined,
): MapProjectionState {
  if (pending?.name !== 'map_compare_views' || isError || citations === undefined
    || citations.length !== 1 || citations[0] !== pending.callSeq) return diagnostic(state, seq, 'comparison-pairing')
  const record = decodeVisualComparisonMeta(meta)
  if (record === null) return diagnostic(state, seq, 'comparison-pairing')
  const observations = state.observationHistory
  const before = observations.find(entry => entry.observationId === record.beforeObservationId)
  const after = observations.find(entry => entry.observationId === record.afterObservationId)
  if (before === undefined || after === undefined || before.observationId === after.observationId) return diagnostic(state, seq, 'comparison-pairing')
  const verdict = compareObservationEvidence({ before, after, beforeCallId: before.callId, afterCallId: after.callId })
  if (verdict.status !== 'ok' || verdict.comparability !== record.comparability
    || JSON.stringify(verdict.limitations) !== JSON.stringify(record.limitations)
    || JSON.stringify(before.composition) !== JSON.stringify(record.composition)
    || JSON.stringify(after.composition) !== JSON.stringify(record.composition)) return diagnostic(state, seq, 'comparison-pairing')
  const beforeRelease = before.basemap?.basemap.release
  const afterRelease = after.basemap?.basemap.release
  const beforeComposition = before.composition
  const afterComposition = after.composition
  const sourceIdentity = (entry: MapObservationRecord['sources'][number]) => ({
    id: entry.id, kind: entry.kind, attribution: entry.attribution, policy: entry.policy,
  })
  if (record.callId !== pending.callId || record.callSeq !== pending.callSeq
    || record.beforeAttachmentSha256 !== before.attachment.sha256
    || record.afterAttachmentSha256 !== after.attachment.sha256
    || record.beforeRelease.role !== 'before' || record.afterRelease.role !== 'after'
    || record.beforeRelease.sourceId !== before.basemap?.basemap.id
    || record.afterRelease.sourceId !== after.basemap?.basemap.id
    || record.beforeRelease.acquisitionScope !== 'unknown'
    || record.afterRelease.acquisitionScope !== 'unknown'
    || beforeRelease === undefined || afterRelease === undefined
    || beforeComposition === undefined || afterComposition === undefined
    || record.beforeRelease.acquiredAt !== beforeRelease.acquiredAt
    || record.afterRelease.acquiredAt !== afterRelease.acquiredAt
    || beforeRelease.version !== record.beforeRelease.releaseId
    || afterRelease.version !== record.afterRelease.releaseId
    || beforeRelease.publishedAt !== record.beforeRelease.publishedAt
    || afterRelease.publishedAt !== record.afterRelease.publishedAt
    || record.beforeRelease.overlayCount !== beforeComposition.layers.length
    || record.afterRelease.overlayCount !== afterComposition.layers.length
    || record.beforeRelease.overlayVisible !== beforeComposition.layers.some(layer => layer.visible)
    || record.afterRelease.overlayVisible !== afterComposition.layers.some(layer => layer.visible)
    || JSON.stringify(before.sources.map(sourceIdentity)) !== JSON.stringify(after.sources.map(sourceIdentity))
    || !before.sources.some(source => source.kind === 'basemap'
      && source.id === record.beforeRelease.sourceId && source.version === record.beforeRelease.releaseId)
    || !after.sources.some(source => source.kind === 'basemap'
      && source.id === record.afterRelease.sourceId && source.version === record.afterRelease.releaseId)
    || record.sourceKind !== MAP_OBSERVATION_META_KIND
    || record.sourceVersion !== MAP_OBSERVATION_SCHEMA_VERSION
    || record.beforeObservationId !== before.observationId || record.afterObservationId !== after.observationId
    || record.beforeRelease.publishedAt === record.afterRelease.publishedAt
    || record.beforeRelease.releaseId === record.afterRelease.releaseId
    || JSON.stringify(before.includedOverlays) !== JSON.stringify(after.includedOverlays)
    || JSON.stringify(before.limitations) !== JSON.stringify(after.limitations)
    || record.beforeAttachmentSha256 === record.afterAttachmentSha256) return diagnostic(state, seq, 'comparison-pairing')
  if (state.comparisons.some(entry => entry.comparisonId === record.comparisonId)) return state
  const next: MapProjectionState = { ...state, comparisons: [...state.comparisons, record].slice(-MAX_VISUAL_COMPARISONS) }
  return mapProjectionStateSchema.safeParse(next).success ? next
    : diagnostic(state, seq, 'comparison-limit')
}

/**
 * Resolve one preset id to its symbol for the user change fold.
 * @param preset - preset id or bare name.
 * @returns the symbol, or `undefined` for an unknown preset.
 */
export function resolvePresetSymbol(preset: string): SymbolStyle | undefined {
  return resolveSymbolPreset(preset)?.symbol
}

/** The `mapContainer` projection unit registered on `ctx.sessionProjections`. */
export const mapContainerProjectionDefinition = {
  key: 'mapContainer',
  stateVersion: MAP_PROJECTION_STATE_VERSION,
  stateSchema: mapProjectionStateSchema,
  init: () => initialMapProjectionState(),
  apply: (state: MapProjectionState, event: SessionEvent): MapProjectionState => {
    const interaction = applyMapInteractionEvent(state.interaction, event)
    if (interaction !== state.interaction) state = { ...state, interaction }
    if (event.type === 'tool/call') {
      const name = event.data.name
      if (name === 'map_observe') {
        // The observation request rides the accepted call event: the client
        // occurrence captures the view for exactly this revision, and the
        // paired result (any outcome) clears the request.
        let timeoutMs = 20_000
        try {
          const parsed = JSON.parse(event.data.arguments as string) as { timeout_ms?: unknown }
          if (typeof parsed.timeout_ms === 'number' && Number.isFinite(parsed.timeout_ms)) {
            timeoutMs = Math.min(60_000, Math.max(1_000, parsed.timeout_ms))
          }
        } catch { /* malformed arguments keep the default window */ }
        return { ...state, observationRequest: { callId: event.data.callId, requestSeq: event.seq, revision: state.revision, expiresAtMs: event.time + timeoutMs } }
      }
      if (!MUTATION_NAMES.includes(name)) return state
      const entry: MapPendingCall = { callId: event.data.callId, callSeq: event.seq, name: name as MapPendingToolName }
      if (state.pendingCalls.length + 1 > MAX_PENDING_MAP_CALLS) {
        // Damaged or adversarial logs must not grow pending calls without
        // bound: evict the oldest into a bounded diagnostic; its later result
        // finds no pending entry and settles as unpaired.
        const evicted = state.pendingCalls[0]
        const kept = state.pendingCalls.slice(1)
        const diagnostics: MapDiagnostic[] = evicted === undefined
          ? [...state.diagnostics]
          : [...state.diagnostics, { seq: evicted.callSeq, code: 'pending-overflow' }]
        return {
          ...state,
          pendingCalls: [...kept, entry],
          diagnostics: diagnostics.slice(-MAX_MAP_DIAGNOSTICS),
        }
      }
      return { ...state, pendingCalls: [...state.pendingCalls, entry] }
    }
    if (event.type === 'agent/inbox/spliced') {
      // A user change applies when its notice enters the inbox, not when a
      // later turn claims it; the claim and its user/message replay as
      // duplicates of the same operation id.
      let next = state
      for (const message of event.data.inserted) next = foldUserChangeMessage(next, event.seq, message)
      return next
    }
    if (event.type === 'user/message') return foldUserChangeMessage(state, event.seq, event.data)
    if (event.type !== 'tool/result') return state
    let callId: string | undefined = event.data.message.toolCallId
    let resultIsError = event.data.message.isError === true
    if (typeof callId !== 'string') {
      for (const candidate of event.data.message.content) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const block = candidate as { type?: unknown; toolCallId?: unknown; isError?: unknown }
        if (block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue
        callId = block.toolCallId
        resultIsError = block.isError === true
        break
      }
    }
    if (typeof callId !== 'string') return state
    const index = state.pendingCalls.findIndex(pending => pending.callId === callId)
    const pending = state.pendingCalls[index]
    if (pending?.name === 'map_use') {
      const request = state.interaction.request
      const cleared = { ...state, pendingCalls: state.pendingCalls.filter(entry => entry.callId !== callId) }
      if (request?.callId !== callId) return cleared
      const settled = { ...cleared, interaction: { ...state.interaction, request: null } }
      const parsed = mapUseMetaSchema.safeParse(event.data.meta)
      if (resultIsError || !parsed.success) return settled
      const record = parsed.data.record
      if (record.callId !== callId || record.sourceCallSeq !== pending.callSeq
        || record.turnStartSeq !== request.turnStartSeq || record.controlEpoch !== state.interaction.controlEpoch
        || record.action !== request.action || record.observationId !== request.observationId
        || !state.interaction.open || event.data.turn !== state.interaction.turn
        || (event.sourceEventSeqs !== undefined && (event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== pending.callSeq))) return settled
      if (record.action === 'finish') return { ...settled, interaction: {
        ...stopMapInteraction(settled.interaction, 'finished'), lastResult: record,
      } }
      if (state.interaction.stopped !== null || event.time >= record.expiresAtMs
        || event.time < state.interaction.observedAt
        || record.expiresAtMs > request.expiresAtMs || record.targetRevision !== state.revision
        || state.latestObservation?.observationId !== record.observationId
        || state.latestObservation.mapRevision !== state.revision
        || state.latestObservation.viewId !== record.viewId
        || state.interaction.usedObservationId === record.observationId) return settled
      let accepted: MapProjectionState = settled
      if (record.action === 'pan' || record.action === 'zoom') {
        if (record.view === null || record.hits.length !== 0) return settled
        accepted = settleMapResult(settled, {
          resultSeq: event.seq, pending, isError: false,
          meta: buildMapChangeMeta(pending.callSeq, record.targetRevision, { op: 'set-view', view: record.view }),
          citedCallSeq: pending.callSeq,
        })
        if (accepted.revision !== settled.revision + 1) return accepted
      } else if (record.view !== null) return settled
      const complete = { ...accepted, interaction: { ...accepted.interaction, lastResult: record, usedObservationId: record.observationId } }
      return mapProjectionStateSchema.safeParse(complete).success ? complete
        : diagnostic(settled, event.seq, 'invalid-meta')
    }
    if (index === -1) {
      // map_observe results never enter pendingCalls; its own settling result
      // (any outcome, including a timeout error) clears the live request, and
      // a successful result folds its `map-observation` meta into
      // `latestObservation`. Old results without the kind carry no evidence;
      // refused versions/metamarks record a bounded diagnostic, never evidence.
      if (state.observationRequest?.callId === callId) {
        let next: MapProjectionState = { ...state, observationRequest: null }
        if (state.interaction.stopped !== null) return next
        if (!resultIsError && event.data.meta !== undefined) {
          const verdict = decodeMapObservationMeta(event.data.meta)
          if (verdict.status === 'ok') {
            const candidate = observationCandidateOf(state, verdict.record)
            if (candidate.ok) {
              next = candidate.state
            } else {
              next = {
                ...next,
                diagnostics: [...next.diagnostics, { seq: event.seq, code: candidate.code }].slice(-MAX_MAP_DIAGNOSTICS),
              }
            }
          } else if (verdict.code !== 'unknown-kind') {
            next = {
              ...next,
              diagnostics: [...next.diagnostics, { seq: event.seq, code: verdict.code }].slice(-MAX_MAP_DIAGNOSTICS),
            }
          }
        }
        return next
      }
      return state
    }
    const pendingCalls = state.pendingCalls.filter((_, at) => at !== index)
    const cleared = { ...state, pendingCalls }
    if (pending?.name === 'map_edit_annotation') {
      if (resultIsError) return cleared
      const meta = decodeAgentAnnotationMeta(event.data.meta)
      if (meta === undefined || meta.sourceCallSeq !== pending.callSeq
        || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== pending.callSeq) {
        return diagnostic(cleared, event.seq, 'call-pairing')
      }
      return settleAgentAnnotation(cleared, meta, callId, event.seq)
    }
    if (pending?.name === 'map_compare_views') {
      return foldComparisonResult(cleared, event.data.meta, event.seq, pending, resultIsError, event.sourceEventSeqs)
    }
    if (pending?.name === 'map_markup') {
      return settleVisualProposalResult(cleared, {
        resultSeq: event.seq,
        pending: state.pendingCalls[index] as MapPendingCall,
        isError: resultIsError,
        meta: event.data.meta,
        citedCallSeq: event.sourceEventSeqs === undefined ? undefined : event.sourceEventSeqs[0],
        ...(event.sourceEventSeqs === undefined ? {} : { citedCallSeqs: event.sourceEventSeqs }),
      })
    }
    if (pending?.name === 'map_mark_changes') {
      return settleVisualChangeResult(cleared, {
        resultSeq: event.seq,
        pending: state.pendingCalls[index] as MapPendingCall,
        isError: resultIsError,
        meta: event.data.meta,
        citedCallSeq: event.sourceEventSeqs === undefined ? undefined : event.sourceEventSeqs[0],
        ...(event.sourceEventSeqs === undefined ? {} : { citedCallSeqs: event.sourceEventSeqs }),
      })
    }
    return settleMapResult(cleared, {
      resultSeq: event.seq,
      pending: state.pendingCalls[index] as MapPendingCall,
      isError: resultIsError,
      meta: event.data.meta,
      citedCallSeq: event.sourceEventSeqs === undefined ? undefined : event.sourceEventSeqs[0],
      ...(event.sourceEventSeqs === undefined ? {} : { citedCallSeqs: event.sourceEventSeqs }),
    })
  },
  wire: {
    // The zod-inferred optional props read `T | undefined`; the wire type's
    // exactOptionalPropertyTypes face does not, so the schema is cast to the
    // declared view type (the runtime validation is unchanged).
    viewSchema: wireSchema as unknown as z.ZodType<{
      layers: ProjectedLayer[]
      view: { center: [number, number]; zoom: number; wkid: number; scale?: number; rotation?: number }
      interaction: MapInteractionState
      mode: 'map' | 'scene'
      basemap: import('@map-harness/map-layers').BasemapSelection | null
      imageryDisplay: import('./protocol.ts').ImageryDisplayState
      waybackComparison: import('./wayback-comparison.ts').WaybackComparison | null
      aoi: { name?: string; ring: [number, number][] } | null
      revision: number
      operations: { index: number; operationId: string | null; undoOf: number | null; writerId: string | null; revision: number; summary: string }[]
      undoableAnnotation: { index: number; operationId: string | null; undoOf: number | null; writerId: string | null; revision: number; summary: string } | null
      observationRequest: { callId: string; requestSeq: number; revision: number; expiresAtMs: number } | null
      latestObservation: MapObservationRecord | null
      observationHistory: readonly MapObservationRecord[]
      comparisons: readonly MapComparisonRecord[]
      visualProposals: readonly VisualProposalRecord[]
      visualChanges: readonly VisualChangeRecord[]
    }>,
    view: (state: MapProjectionState) => ({
      interaction: state.interaction,
      layers: state.layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        featureCount: (layer.data as { features?: unknown[] } | null)?.features?.length ?? 0,
        sourceCrs: layer.sourceCrs ?? 'EPSG:4326',
        visible: layer.visible,
        opacity: layer.opacity,
        data: layer.data,
        ...(layer.displayDigest === undefined ? {} : { displayDigest: layer.displayDigest }),
        ...(layer.artifactRef === undefined ? {} : { artifactRef: layer.artifactRef }),
        ...(layer.resourceRef === undefined ? {} : { resourceRef: layer.resourceRef }),
        ...(layer.legend === undefined ? {} : { legend: layer.legend }),
        ...(layer.style === undefined ? {} : { style: layer.style }),
        ...(layer.symbol === undefined ? {} : { symbol: layer.symbol }),
        ...(layer.overrides === undefined ? {} : { overrides: layer.overrides }),
        ...(layer.group === undefined ? {} : { group: layer.group }),
        ...(layer.imagery === undefined ? {} : { imagery: layer.imagery }),
        ...(layer.terrain === undefined ? {} : { terrain: layer.terrain }),
        ...(layer.stream === undefined ? {} : { stream: layer.stream }),
        ...(layer.role === undefined ? {} : { role: layer.role }),
      })),
      view: { ...state.view, center: [state.view.center[0], state.view.center[1]] },
      mode: state.mode,
      basemap: state.basemap === null ? null : JSON.parse(JSON.stringify(state.basemap)),
      imageryDisplay: JSON.parse(JSON.stringify(state.imageryDisplay)),
      waybackComparison: state.waybackComparison === null ? null : JSON.parse(JSON.stringify(state.waybackComparison)),
      aoi: state.aoi === null
        ? null
        : {
            ...(state.aoi.name === undefined ? {} : { name: state.aoi.name }),
            ring: state.aoi.ring.map(point => [point[0], point[1]] as [number, number]),
          },
      revision: state.revision,
      operations: state.operations.slice(-WIRE_OPERATION_SUMMARIES).map(op => ({
        index: op.index,
        operationId: op.operationId,
        undoOf: op.undoOf,
        writerId: op.writerId,
        revision: op.revision,
        summary: op.summary,
      })),
      undoableAnnotation: [...state.operations].reverse()
        .find(op => op.writerId === 'user' && op.summary.startsWith('annotation-')) ?? null,
      observationRequest: state.observationRequest === null ? null : { ...state.observationRequest },
      latestObservation: state.latestObservation === null ? null : { ...state.latestObservation },
      observationHistory: state.observationHistory.map(record => ({ ...record })),
      comparisons: state.comparisons.map(record => ({ ...record })),
      visualProposals: state.visualProposals.map(proposal => ({ ...proposal })),
      visualChanges: state.visualChanges.map(change => ({ ...change })),
    }),
  },
} satisfies ProjectionDefinition<'mapContainer', MapProjectionState>
