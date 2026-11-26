/**
 * V7 dual-image visual comparison tools. `map_compare_views` reads two saved
 * observation images from this session and returns both as model image blocks
 * beside a versioned comparison record. `map_mark_changes` accepts one bounded
 * candidate batch against an accepted comparison and returns durable,
 * unconfirmed change records; neither tool calls another model or writes a
 * user annotation.
 * @module @map-harness/map-tools/visual-change-tools
 */
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import {
  MAX_MAP_OBSERVATION_HISTORY,
  MAX_VISUAL_CHANGE_CANDIDATES,
  VISUAL_CHANGE_ID_PREFIX,
  VISUAL_COMPARISON_ID_PREFIX,
  VISUAL_COMPARISON_LIMITATIONS,
  buildVisualChangeMeta,
  buildVisualComparisonMeta,
  compareObservationEvidence,
  mapObservationRecordSchema,
  parseVisualChangeItems,
  visualChangePairingCode,
  visualProposalGeometryOf,
  type ComparisonRefusal,
  type MapComparisonRecord,
  type MapContainerService,
  type MapObservationRecord,
  type VisualChangeRecord,
} from '@map-harness/map-container'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { sessionOf } from './catalog-tools.ts'
import { renderJson } from './output.ts'
import { attachmentStoreOf, readObservationImage } from './visual-change-evidence.ts'
import { assertAutomatedMapUseAllowed } from './basemap-admission.ts'

/** Exact model-facing readout of the two saved images and their evidence. */
export const COMPARE_DESCRIPTION =
  'Compare two saved map_observe images from this session at one fixed view and return both images in before/after order, their fixed release sources, comparison id, and limits. '
  + 'The tool reads only persisted evidence; it does not capture new images, infer local acquisition dates, or call a second model. Same image bytes under different releases are refused.'

/** Exact model-facing text for one change-candidate batch. */
export const MARK_CHANGES_DESCRIPTION =
  `Propose up to ${MAX_VISUAL_CHANGE_CANDIDATES} appeared, disappeared, modified, or uncertain visual-change candidates from a map_compare_views pair. `
  + 'Cite comparison_id and bounded image-pixel geometry; the host verifies both saved images, projects each vertex through the common affine plane, and returns WGS84 candidates with source evidence. '
  + 'Apply or dismiss a candidate with map_edit_annotation, or draw its geometry with map_draw or map_apply_patch. Confidence is a self-assessment, not a calibrated probability; an empty result is an honest analysis conclusion.'

/** One model-supplied change item. */
const ITEM_DESCRIPTION =
  'One candidate: kind (appeared|disappeared|modified|uncertain), category (<=512 UTF-8 bytes), note (<=512 UTF-8 bytes), '
  + 'confidence (uncertain|likely), and pixelGeometry as one flat object: '
  + '{type:"point",point:[x,y]}, {type:"polyline",points:[[x,y],…]}, {type:"polygon",points:[[x,y],…]}, '
  + 'or {type:"bbox",corners:[[x,y],[x,y],[x,y],[x,y]]}. Coordinates are output-image pixels inside the map content, not longitude/latitude.'

/** Trusted current model identity from the agent execution context. */
interface ModelContextFace {
  current(): { provider: string; model: string } | undefined
}

/** Read the current model identity; a malformed execution context refuses. */
function modelIdentityOf(exec: ToolRunContext): { provider: string; model: string } {
  const agent = exec.agent as (typeof exec.agent & { model?: ModelContextFace }) | undefined
  let current: { provider: string; model: string } | undefined
  try {
    current = agent?.model?.current()
  } catch {
    current = undefined
  }
  if (current === undefined || typeof current.provider !== 'string' || current.provider.length === 0 || current.provider.length > 128
    || typeof current.model !== 'string' || current.model.length === 0 || current.model.length > 128) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_mark_changes requires a trusted current model identity.')
  }
  return { provider: current.provider, model: current.model }
}

/** Resolve two observation ids inside one session's bounded history. */
function historyPairOf(
  state: ReturnType<MapContainerService['stateOf']>,
  beforeId: string,
  afterId: string,
): { before: MapObservationRecord; after: MapObservationRecord } {
  const before = state.observationHistory.find(entry => entry.observationId === beforeId)
  const after = state.observationHistory.find(entry => entry.observationId === afterId)
  if (before === undefined || after === undefined) throw new SpatialError('UNKNOWN_OBSERVATION', 'Both cited observations must be saved in this session.')
  if (before.observationId === after.observationId) throw new SpatialError('COMPARISON_REFUSED', 'A comparison needs two distinct saved observations.')
  return { before, after }
}

/** Map a comparison refusal to its authored stable error code. */
function refusedComparison(code: ComparisonRefusal): never {
  if (code === 'missing-observation' || code === 'missing-attachment') throw new SpatialError('UNKNOWN_OBSERVATION', 'The cited observation evidence is incomplete or no longer available.')
  if (code === 'missing-fixed-release') throw new SpatialError('COMPARISON_REFUSED', 'Both observations must cite a fixed Wayback release.')
  if (code === 'same-image') throw new SpatialError('COMPARISON_REFUSED', 'The two releases produced the same image bytes; no independent local imagery is available.')
  if (code === 'reverse-dates' || code === 'reverse-acquisition-dates' || code === 'unknown-acquisition-dates'
    || code === 'unknown-dates' || code === 'mixed-dates') {
    throw new SpatialError('COMPARISON_REFUSED', 'The recorded release or local acquisition dates cannot order the pair.')
  }
  throw new SpatialError('COMPARISON_REFUSED', `The two observations are not comparable (${code}).`)
}

/** Verify current sources, recorded releases, and both exact persisted PNGs. */
async function assertPairEvidence(
  exec: ToolRunContext,
  state: ReturnType<MapContainerService['stateOf']>,
  before: MapObservationRecord,
  after: MapObservationRecord,
): Promise<{ before: Awaited<ReturnType<typeof readObservationImage>>; after: Awaited<ReturnType<typeof readObservationImage>> }> {
  const sourceService = serviceOf<import('@map-harness/map-container').MapSourceService>(exec, 'mapSourceService')
  assertAutomatedMapUseAllowed(state, sourceService)
  if (sourceService === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'The map source service is unavailable.')
  for (const record of [before, after]) {
    const selection = record.basemap
    if (selection === null || selection === undefined || selection.basemap.id !== 'esri-wayback') {
      throw new SpatialError('COMPARISON_REFUSED', 'The cited observations lack fixed Wayback releases.')
    }
    const source = selection.basemap
    if (!record.sources.some(entry => entry.kind === 'basemap' && entry.id === source.id
      && entry.version === source.release.version && entry.attribution === source.attribution)) {
      throw new SpatialError('COMPARISON_REFUSED', 'The cited observation does not match its fixed-release source.')
    }
    try {
      sourceService.catalog.verifyWaybackPolicy(source)
      if (selection.labels !== null) sourceService.verifySource(selection.labels)
    } catch (error) {
      throw new SpatialError('SOURCE_CHANGED', 'The cited source no longer matches the current catalog.', { cause: error })
    }
  }
  const attachments = attachmentStoreOf(exec)
  const beforeImage = await readObservationImage(before, 'map_compare_views', attachments, exec.signal)
  const afterImage = await readObservationImage(after, 'map_compare_views', attachments, exec.signal)
  exec.signal.throwIfAborted()
  assertAutomatedMapUseAllowed(state, serviceOf<import('@map-harness/map-container').MapSourceService>(exec, 'mapSourceService'))
  return { before: beforeImage, after: afterImage }
}

/** Build one host-owned comparison record from two verified observations. */
function comparisonRecordOf(
  callId: string,
  callSeq: number,
  before: MapObservationRecord,
  after: MapObservationRecord,
  verdict: Extract<ReturnType<typeof compareObservationEvidence>, { status: 'ok' }>,
  focus: string | null,
): MapComparisonRecord {
  const beforeBasemap = before.basemap?.basemap
  const afterBasemap = after.basemap?.basemap
  if (beforeBasemap === undefined || afterBasemap === undefined || beforeBasemap.release.version === null
    || afterBasemap.release.version === null || beforeBasemap.release.publishedAt === null
    || afterBasemap.release.publishedAt === null || before.composition === undefined) {
    throw new SpatialError('COMPARISON_REFUSED', 'The comparison record cannot be built from incomplete release facts.')
  }
  const id = VISUAL_COMPARISON_ID_PREFIX + createHash('sha256')
    .update(`${callId}\n${callSeq}\n${before.observationId}\n${after.observationId}`)
    .digest('hex').slice(0, 24)
  return {
    comparisonId: id,
    callId,
    callSeq,
    beforeObservationId: before.observationId,
    afterObservationId: after.observationId,
    beforeAttachmentSha256: before.attachment.sha256,
    afterAttachmentSha256: after.attachment.sha256,
    beforeRelease: {
      role: 'before', sourceId: beforeBasemap.id, releaseId: beforeBasemap.release.version,
      publishedAt: beforeBasemap.release.publishedAt, acquiredAt: beforeBasemap.release.acquiredAt,
      acquisitionScope: 'unknown', overlayCount: before.composition.layers.length,
      overlayVisible: before.composition.layers.some(layer => layer.visible),
    },
    afterRelease: {
      role: 'after', sourceId: afterBasemap.id, releaseId: afterBasemap.release.version,
      publishedAt: afterBasemap.release.publishedAt, acquiredAt: afterBasemap.release.acquiredAt,
      acquisitionScope: 'unknown', overlayCount: after.composition?.layers.length ?? 0,
      overlayVisible: after.composition?.layers.some(layer => layer.visible) ?? false,
    },
    comparability: verdict.comparability,
    limitations: verdict.limitations,
    sourceKind: 'map-observation',
    sourceVersion: 3,
    composition: before.composition,
    focus,
    createdAt: new Date().toISOString(),
  }
}

/** Render two exact image blocks after a text summary that carries no meta. */
const imageAttachmentReferenceSchema = z.object({
  attachmentId: z.string().min(1).max(256).transform(AttachmentId),
  mediaType: z.literal('image/png'),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().max(512).optional(),
  originalDimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict().optional(),
}).strict().transform((ref): ImageAttachmentRef => ({
  attachmentId: ref.attachmentId,
  mediaType: ref.mediaType,
  bytes: ref.bytes,
  width: ref.width,
  height: ref.height,
  ...(ref.name === undefined ? {} : { name: ref.name }),
  ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
}))

function renderComparison(_args: JsonValue, value: JsonValue): ContentBlock[] {
  const parsed = z.json().parse(value)
  const fields = z.object({
    before_image: imageAttachmentReferenceSchema,
    after_image: imageAttachmentReferenceSchema,
  }).passthrough().parse(parsed)
  const { meta: _meta, before_image: _before, after_image: _after, ...summary } = z.record(z.string(), z.json()).parse(parsed) as Record<string, JsonValue>
  return [
    ...renderJson(summary),
    { type: 'image', attachment: fields.before_image },
    { type: 'image', attachment: fields.after_image },
  ]
}

/** Convert a geometry/math refusal to the authored stable error vocabulary. */
function refusalOf(refusal: string): never {
  if (refusal === 'outside-map') throw new SpatialError('INVALID_PROPOSAL', 'A candidate pixel lies outside the captured map content.')
  if (refusal === 'world-wrap') throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'The candidate crosses the supported world boundary; compare a smaller area.')
  if (refusal === 'unsupported-georeference') throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'The cited images have no safe common 2D affine pixel positioning.')
  if (refusal === 'geometry-invalid') throw new SpatialError('INVALID_PROPOSAL', 'The candidate geometry is degenerate, self-intersecting, or not a closed ring.')
  throw new SpatialError('INVALID_PROPOSAL', 'Candidate pixel coordinates must be finite and inside the captured map content.')
}

/** Build host-owned change records after all validation has passed. */
function changesOf(
  comparison: MapComparisonRecord,
  comparisonState: ReturnType<MapContainerService['stateOf']>,
  items: ReturnType<typeof parseVisualChangeItems>,
  identity: { readonly callId: string; readonly callSeq: number; readonly provider: string; readonly model: string },
): readonly VisualChangeRecord[] {
  if (items === undefined) throw new SpatialError('INVALID_PROPOSAL', 'Every candidate must use one bounded geometry and a non-probability self-assessment.')
  const { before, after } = historyPairOf(comparisonState, comparison.beforeObservationId, comparison.afterObservationId)
  const createdAt = new Date().toISOString()
  return items.map((item, index) => {
    const geometry = visualProposalGeometryOf(after, item.pixelGeometry)
    if (typeof geometry === 'string') refusalOf(geometry)
    const changeId = VISUAL_CHANGE_ID_PREFIX + createHash('sha256')
      .update(`${identity.callId}\n${identity.callSeq}\n${comparison.comparisonId}\n${index}\n${JSON.stringify(item)}`)
      .digest('hex').slice(0, 24)
    return {
      changeId,
      comparisonId: comparison.comparisonId,
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      beforeAttachmentSha256: before.attachment.sha256,
      afterAttachmentSha256: after.attachment.sha256,
      observationAttachment: { ...after.attachment },
      sourceCallId: identity.callId,
      sourceCallSeq: identity.callSeq,
      mapRevision: comparisonState.revision,
      modelProvider: identity.provider,
      modelName: identity.model,
      kind: item.kind,
      category: item.category,
      note: item.note,
      confidence: item.confidence,
      pixelGeometry: item.pixelGeometry,
      geometry,
      status: 'proposed',
      createdAt,
      reviewedAt: null,
      humanEdited: false,
      acceptedFeatureId: null,
    } satisfies VisualChangeRecord
  })
}

/** `map_compare_views`: read two persisted images from one session for one view. */
export const mapCompareViews = defineTool({
  name: 'map_compare_views',
  description: COMPARE_DESCRIPTION,
  parameters: {
    before_observation_id: { type: 'string', required: true, description: 'Observation id of the earlier fixed release from map_observe.' },
    after_observation_id: { type: 'string', required: true, description: 'Observation id of the later fixed release from map_observe.' },
    focus: { type: 'string', description: 'Optional bounded name of the user focus; it never changes the evidence or dates.' },
  },
  output: {
    schema: { type: 'json' },
    render: renderComparison,
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    if (exec.parent !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'map_compare_views requires its accepted native tool call in this session.')
    const { before_observation_id: beforeId, after_observation_id: afterId, focus } = args as {
      before_observation_id?: unknown; after_observation_id?: unknown; focus?: unknown
    }
    if (typeof beforeId !== 'string' || beforeId.length === 0 || beforeId.length > 256
      || typeof afterId !== 'string' || afterId.length === 0 || afterId.length > 256
      || (focus !== undefined && (typeof focus !== 'string' || focus.length > 512))) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_compare_views requires two bounded observation ids and an optional bounded focus.')
    }
    const session = sessionOf(exec)
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_compare_views requires the map container service.')
    const pending = map.pendingCallOf(session, exec.callId)
    if (pending === undefined || pending.name !== 'map_compare_views') {
      throw new SpatialError('INVALID_ARGUMENT', 'map_compare_views requires its accepted tool/call in the session log before execution.')
    }
    const state = map.stateOf(session)
    if (state.observationHistory.length >= MAX_MAP_OBSERVATION_HISTORY) {
      throw new SpatialError('BUDGET_EXHAUSTED', 'The bounded observation history is full; no further comparison evidence can be retained.')
    }
    const { before, after } = historyPairOf(state, beforeId, afterId)
    if (!mapObservationRecordSchema.safeParse(before).success || !mapObservationRecordSchema.safeParse(after).success) {
      throw new SpatialError('UNKNOWN_OBSERVATION', 'Both cited observations must be complete, versioned records.')
    }
    const verdict = compareObservationEvidence({ before, after, beforeCallId: before.callId, afterCallId: after.callId })
    if (verdict.status !== 'ok') refusedComparison(verdict.code)
    const stored = await assertPairEvidence(exec, state, before, after)
    const live = map.stateOf(session)
    const livePair = historyPairOf(live, beforeId, afterId)
    if (live.revision !== state.revision || livePair.before !== before || livePair.after !== after) {
      throw new SpatialError('STALE_OBSERVATION', 'The map or comparison observations changed during image verification.')
    }
    const record = comparisonRecordOf(exec.callId, pending.callSeq, before, after, verdict, typeof focus === 'string' ? focus : null)
    const meta = buildVisualComparisonMeta(record)
    return z.json().parse({
      comparison_id: record.comparisonId,
      before_observation_id: before.observationId,
      after_observation_id: after.observationId,
      before_release: record.beforeRelease,
      after_release: record.afterRelease,
      comparability: verdict.comparability,
      limitations: verdict.limitations,
      image_order: ['before', 'after'],
      before_image: stored.before.ref,
      after_image: stored.after.ref,
      ...(typeof focus === 'string' ? { focus } : {}),
      note: 'Inspect both images together; these are saved visual evidence, not a raster difference or a calibrated change-detection result.',
      meta: JSON.parse(JSON.stringify(meta)) as JsonValue,
    })
  },
})

/** `map_mark_changes`: one bounded, durable batch of unconfirmed visual changes. */
export const mapMarkChanges = defineTool({
  name: 'map_mark_changes',
  description: MARK_CHANGES_DESCRIPTION,
  parameters: {
    comparison_id: { type: 'string', required: true, description: 'The comparison id returned by map_compare_views.' },
    items: { type: 'json', required: true, description: `An array of 0..${MAX_VISUAL_CHANGE_CANDIDATES} candidates. ${ITEM_DESCRIPTION}` },
    limitations: { type: 'string', description: 'Optional short reason when no visible change is supported; omit for normal candidates.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest as JsonValue)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    if (exec.parent !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'map_mark_changes requires its accepted native tool call in this session.')
    const { comparison_id: comparisonId, items, limitations } = args as {
      comparison_id?: unknown; items?: unknown; limitations?: unknown
    }
    if (typeof comparisonId !== 'string' || comparisonId.length === 0 || comparisonId.length > 256
      || (limitations !== undefined && (typeof limitations !== 'string' || limitations.length > 512))) {
      throw new SpatialError('INVALID_PROPOSAL', 'map_mark_changes requires comparison_id and bounded items.')
    }
    const parsedItems = parseVisualChangeItems(items)
    if (parsedItems === undefined) throw new SpatialError('INVALID_PROPOSAL', 'Every candidate must use one bounded geometry and a non-probability self-assessment.')
    const session = sessionOf(exec)
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_mark_changes requires the map container service.')
    const pending = map.pendingCallOf(session, exec.callId)
    if (pending === undefined || pending.name !== 'map_mark_changes') {
      throw new SpatialError('INVALID_ARGUMENT', 'map_mark_changes requires its accepted tool/call in the session log before execution.')
    }
    const state = map.stateOf(session)
    const comparison = state.comparisons.find(entry => entry.comparisonId === comparisonId)
    if (comparison === undefined || comparison.comparability === 'not-comparable') {
      throw new SpatialError('UNKNOWN_COMPARISON', 'The cited comparison is not an accepted, plottable pair in this session.')
    }
    const { before, after } = historyPairOf(state, comparison.beforeObservationId, comparison.afterObservationId)
    const verdict = compareObservationEvidence({ before, after, beforeCallId: before.callId, afterCallId: after.callId })
    if (verdict.status !== 'ok') refusedComparison(verdict.code)
    await assertPairEvidence(exec, state, before, after)
    const live = map.stateOf(session)
    const livePair = historyPairOf(live, comparison.beforeObservationId, comparison.afterObservationId)
    if (live.revision !== state.revision || livePair.before !== before || livePair.after !== after
      || !live.comparisons.some(entry => entry.comparisonId === comparisonId)) {
      throw new SpatialError('STALE_OBSERVATION', 'The map or comparison observations changed during image verification.')
    }
    const model = modelIdentityOf(exec)
    const changes = changesOf(comparison, state, parsedItems, {
      callId: exec.callId, callSeq: pending.callSeq,
      provider: model.provider, model: model.model,
    })
    if (state.visualChanges.filter(change => change.status === 'proposed').length + changes.length > MAX_VISUAL_CHANGE_CANDIDATES) {
      throw new SpatialError('PROPOSAL_LIMIT', 'The active visual-change budget is full; review existing candidates first.')
    }
    const meta = buildVisualChangeMeta({
      comparisonId, callId: exec.callId, sourceCallSeq: pending.callSeq,
      targetRevision: state.revision, modelProvider: model.provider, modelName: model.model,
      changes,
      limitations: limitations === undefined ? VISUAL_COMPARISON_LIMITATIONS : [...VISUAL_COMPARISON_LIMITATIONS, limitations],
    })
    const pairing = visualChangePairingCode(state, meta, exec.callId, pending.callSeq, state.visualChanges)
    if (pairing !== null) throw new SpatialError('STALE_OBSERVATION', `The change batch is no longer current (${pairing}).`)
    return z.json().parse({
      comparison_id: comparisonId,
      candidates: changes.length,
      status: 'proposed',
      source_revision: state.revision,
      candidate_ids: changes.map(change => change.changeId),
      proposals: changes.map(change => ({
        id: change.changeId,
        kind: change.kind,
        category: change.category,
        note: change.note,
        confidence: change.confidence,
        geometry: change.geometry,
      })),
      limitations: meta.record.limitations,
      must_confirm: false,
      meta: JSON.parse(JSON.stringify(meta)) as JsonValue,
    })
  },
})
