/**
 * Versioned two-image comparison facts and visual-change candidates. A
 * comparison only cites two already persisted observations and never carries
 * image bytes, URLs, model-inferred dates, or a second rendering receipt.
 * Unknown record versions refuse instead of receiving defaults.
 * @module @map-harness/map-container/comparison-protocol
 */
import { z } from 'zod'
import {
  MAX_VISUAL_CHANGE_CANDIDATES,
  MAX_VISUAL_CHANGE_META_BYTES,
  VISUAL_CHANGE_ID_PREFIX,
  VISUAL_CHANGE_META_KIND,
  VISUAL_COMPARISON_ID_PREFIX,
  VISUAL_COMPARISON_META_KIND,
} from './comparison-limits.ts'
import {
  MAP_OBSERVATION_META_KIND,
  MAP_OBSERVATION_SCHEMA_VERSION,
  observationCompositionSchema,
  type ObservationComposition,
  type MapObservationRecord,
} from './observation-protocol.ts'
import type { AnnotationGeometry } from './protocol.ts'
import type { VisualProposalPixelGeometry } from './visual-proposal-protocol.ts'

/** Current comparison and change-candidate meta version. */
export const VISUAL_CHANGE_SCHEMA_VERSION = 2
export {
  MAX_VISUAL_CHANGE_CANDIDATES,
  MAX_VISUAL_CHANGE_META_BYTES,
  VISUAL_CHANGE_ID_PREFIX,
  VISUAL_CHANGE_META_KIND,
  VISUAL_COMPARISON_ID_PREFIX,
  VISUAL_COMPARISON_META_KIND,
}

/** One fixed release's independently recorded dates. */
export interface ComparisonRelease {
  readonly role: 'before' | 'after'
  readonly sourceId: string
  readonly releaseId: string
  readonly publishedAt: string
  readonly acquiredAt: string | null
  readonly acquisitionScope: 'unknown' | 'mixed' | 'local'
  readonly overlayCount: number
  readonly overlayVisible: boolean
}

/** Why a pair cannot become a plottable comparison. */
export type ComparisonRefusal =
  | 'missing-observation'
  | 'same-observation'
  | 'cross-session'
  | 'missing-composition'
  | 'composition-changed'
  | 'view-changed'
  | 'georeference-changed'
  | 'unsupported-georeference'
  | 'source-policy-denied'
  | 'missing-fixed-release'
  | 'same-release'
  | 'same-image'
  | 'unknown-dates'
  | 'reverse-dates'
  | 'mixed-dates'
  | 'invalid-composition'
  | 'reverse-acquisition-dates'
  | 'unknown-acquisition-dates'
  | 'missing-attachment'
  | 'invalid-meta'

/** Comparability of one admitted pair, with named limitations. */
export type Comparability = 'comparable' | 'limited' | 'not-comparable'

/** One durable, replayable comparison of two saved observations. */
export interface MapComparisonRecord {
  readonly comparisonId: string
  readonly callId: string
  readonly callSeq: number
  readonly beforeObservationId: string
  readonly afterObservationId: string
  readonly beforeAttachmentSha256: string
  readonly afterAttachmentSha256: string
  readonly beforeRelease: ComparisonRelease
  readonly afterRelease: ComparisonRelease
  readonly comparability: Comparability
  readonly limitations: readonly string[]
  readonly sourceKind: typeof MAP_OBSERVATION_META_KIND
  readonly sourceVersion: typeof MAP_OBSERVATION_SCHEMA_VERSION
  readonly composition: ObservationComposition
  readonly focus: string | null
  readonly createdAt: string
}

/** One bounded candidate type the model may self-assess. */
export type VisualChangeKind = 'appeared' | 'disappeared' | 'modified' | 'uncertain'

/** Model self-assessment, never a calibrated probability. */
export type VisualChangeConfidence = 'uncertain' | 'likely'
/** Human review and agent decisions use distinct states. */
export type VisualChangeStatus = 'proposed' | 'accepted' | 'rejected' | 'agent-applied' | 'agent-dismissed'

/** One model-supplied change-candidate item. */
export interface VisualChangeItem {
  readonly kind: VisualChangeKind
  readonly category: string
  readonly note: string
  readonly confidence: VisualChangeConfidence
  readonly pixelGeometry: VisualProposalPixelGeometry
}

/** One durable change candidate with its host identity and independently projected geometry. */
export interface VisualChangeRecord {
  readonly changeId: string
  readonly comparisonId: string
  readonly beforeObservationId: string
  readonly afterObservationId: string
  readonly beforeAttachmentSha256: string
  readonly afterAttachmentSha256: string
  readonly observationAttachment: MapObservationRecord['attachment']
  readonly sourceCallId: string
  readonly sourceCallSeq: number
  readonly mapRevision: number
  readonly modelProvider: string
  readonly modelName: string
  readonly kind: VisualChangeKind
  readonly category: string
  readonly note: string
  readonly confidence: VisualChangeConfidence
  readonly pixelGeometry: VisualProposalPixelGeometry
  readonly geometry: AnnotationGeometry
  readonly status: VisualChangeStatus
  readonly createdAt: string
  readonly reviewedAt: string | null
  /** Explicit for agent decisions; historical human reviews omit this field. */
  readonly reviewedBy?: 'agent'
  readonly humanEdited: boolean
  readonly acceptedFeatureId: string | null
}

/** Durable `tool/result.meta` for one read-only comparison. */
export interface VisualComparisonMeta {
  readonly kind: typeof VISUAL_COMPARISON_META_KIND
  readonly schemaVersion: typeof VISUAL_CHANGE_SCHEMA_VERSION
  readonly record: MapComparisonRecord
}

/** Durable `tool/result.meta` for one complete change-candidate batch. */
export interface VisualChangeMeta {
  readonly kind: typeof VISUAL_CHANGE_META_KIND
  readonly schemaVersion: typeof VISUAL_CHANGE_SCHEMA_VERSION
  readonly record: {
    readonly comparisonId: string
    readonly callId: string
    readonly sourceCallSeq: number
    readonly targetRevision: number
    readonly modelProvider: string
    readonly modelName: string
    readonly changes: readonly VisualChangeRecord[]
    readonly limitations: readonly string[]
  }
}

const finite = z.number().finite()
const point = z.tuple([finite, finite])
const points = z.array(point).min(2).max(1024)
const ring = z.array(point).min(4).max(1024)
const bboxCorners = z.tuple([point, point, point, point])
const pixelGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), point }).strict(),
  z.object({ type: z.literal('polyline'), points }).strict(),
  z.object({ type: z.literal('polygon'), points: ring }).strict(),
  z.object({ type: z.literal('bbox'), corners: bboxCorners }).strict(),
]) as z.ZodType<VisualProposalPixelGeometry>

const wgs84Point = z.tuple([finite.min(-180).max(180), finite.min(-90).max(90)])
const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: wgs84Point }).strict(),
  z.object({ type: z.literal('LineString'), coordinates: z.array(wgs84Point).min(2).max(1024) }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(wgs84Point).min(4).max(1024)).length(1) }).strict(),
]) as z.ZodType<AnnotationGeometry>

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const text = z.string().max(512).check(value => {
  if (byteLength(value.value) > 512) value.issues.push({ code: 'custom', input: value.value, message: 'change text exceeds 512 UTF-8 bytes' })
})

const itemSchema = z.object({
  kind: z.enum(['appeared', 'disappeared', 'modified', 'uncertain']),
  category: text,
  note: text,
  confidence: z.enum(['uncertain', 'likely']),
  pixelGeometry: pixelGeometrySchema,
}).strict() as z.ZodType<VisualChangeItem>

const releaseSchema = z.object({
  role: z.enum(['before', 'after']),
  sourceId: z.string().min(1).max(256),
  releaseId: z.string().min(1).max(96),
  publishedAt: z.string().datetime(),
  acquiredAt: z.string().datetime().nullable(),
  acquisitionScope: z.enum(['unknown', 'mixed', 'local']),
  overlayCount: z.number().int().nonnegative(),
  overlayVisible: z.boolean(),
}).strict()

const comparisonSchema = z.object({
  comparisonId: z.string().regex(/^vcompare-[0-9a-f]{24}$/u),
  callId: z.string().min(1).max(256),
  callSeq: z.number().int().nonnegative(),
  beforeObservationId: z.string().min(1).max(256),
  afterObservationId: z.string().min(1).max(256),
  beforeAttachmentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  afterAttachmentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  beforeRelease: releaseSchema,
  afterRelease: releaseSchema,
  comparability: z.enum(['comparable', 'limited', 'not-comparable']),
  limitations: z.array(z.string().max(512)).max(16),
  sourceKind: z.literal(MAP_OBSERVATION_META_KIND),
  sourceVersion: z.literal(MAP_OBSERVATION_SCHEMA_VERSION),
  composition: observationCompositionSchema,
  focus: z.string().max(512).nullable(),
  createdAt: z.string().datetime(),
}).strict()

/** Shared strict comparison-record decoder for projections and checkpoint readers. */
export const mapComparisonRecordSchema = comparisonSchema as z.ZodType<MapComparisonRecord>

const attachmentSchema = z.object({
  attachmentId: z.string().min(1).max(256),
  mediaType: z.literal('image/png'),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().max(512).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict()

const modelIdentity = z.string().min(1).max(128)
const changeSchema = z.object({
  changeId: z.string().regex(/^vchange-[0-9a-f]{24}$/u),
  comparisonId: z.string().regex(/^vcompare-[0-9a-f]{24}$/u),
  beforeObservationId: z.string().min(1).max(256),
  afterObservationId: z.string().min(1).max(256),
  beforeAttachmentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  afterAttachmentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  observationAttachment: attachmentSchema,
  sourceCallId: z.string().min(1).max(256),
  sourceCallSeq: z.number().int().nonnegative(),
  mapRevision: z.number().int().nonnegative(),
  modelProvider: modelIdentity,
  modelName: modelIdentity,
  kind: z.enum(['appeared', 'disappeared', 'modified', 'uncertain']),
  category: text,
  note: text,
  confidence: z.enum(['uncertain', 'likely']),
  pixelGeometry: pixelGeometrySchema,
  geometry: geometrySchema,
  status: z.enum(['proposed', 'accepted', 'rejected', 'agent-applied', 'agent-dismissed']),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedBy: z.literal('agent').optional(),
  humanEdited: z.boolean(),
  acceptedFeatureId: z.string().regex(/^ann-[0-9a-f]{24}$/u).nullable(),
}).strict().refine(value =>
  (value.status === 'proposed' && value.reviewedAt === null && value.acceptedFeatureId === null && value.reviewedBy === undefined)
  || (value.status === 'accepted' && value.reviewedAt !== null && value.acceptedFeatureId !== null && value.reviewedBy === undefined)
  || (value.status === 'rejected' && value.reviewedAt !== null && value.acceptedFeatureId === null && value.reviewedBy === undefined)
  || (value.status === 'agent-applied' && value.reviewedAt !== null && value.acceptedFeatureId !== null && value.reviewedBy === 'agent' && !value.humanEdited)
  || (value.status === 'agent-dismissed' && value.reviewedAt !== null && value.acceptedFeatureId === null && value.reviewedBy === 'agent' && !value.humanEdited),
{ message: 'change review fields must agree with its status' },
)

/** Shared strict change-record decoder for projections and checkpoint readers. */
export const visualChangeRecordSchema = changeSchema as z.ZodType<VisualChangeRecord>

const comparisonMetaSchema = z.object({
  kind: z.literal(VISUAL_COMPARISON_META_KIND),
  schemaVersion: z.literal(VISUAL_CHANGE_SCHEMA_VERSION),
  record: comparisonSchema,
}).strict() as z.ZodType<VisualComparisonMeta>

const changeMetaSchema = z.object({
  kind: z.literal(VISUAL_CHANGE_META_KIND),
  schemaVersion: z.literal(VISUAL_CHANGE_SCHEMA_VERSION),
  record: z.object({
    comparisonId: z.string().regex(/^vcompare-[0-9a-f]{24}$/u),
    callId: z.string().min(1).max(256),
    sourceCallSeq: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    modelProvider: modelIdentity,
    modelName: modelIdentity,
    changes: z.array(changeSchema).max(100),
    limitations: z.array(z.string().max(512)).max(8),
  }).strict(),
}).strict() as z.ZodType<VisualChangeMeta>

/** Model-facing limits every admitted comparison and candidate states. */
export const VISUAL_COMPARISON_LIMITATIONS: readonly string[] = [
  'The two images are saved visual evidence, not raster differencing or a calibrated change-detection result.',
  'Published release dates are not local acquisition dates; no exact occurrence date is inferred.',
  'Candidates are unconfirmed visual suggestions; their locations may require review.',
] as const

/** Validated verdict of one candidate two-image pair. */
export type ComparisonVerdict =
  | { readonly status: 'ok'; readonly comparability: Comparability; readonly limitations: readonly string[] }
  | { readonly status: 'refused'; readonly code: ComparisonRefusal }

/** One candidate observation pair with its already verified persisted facts. */
export interface ComparisonCandidate {
  readonly before: MapObservationRecord
  readonly after: MapObservationRecord
  readonly beforeCallId: string
  readonly afterCallId: string
}

/**
 * Compare two persisted observations without reading images or services.
 * Fixed releases, composition, camera, affine, image plane, and independently
 * known local dates are strict facts. Old v2 records
 * with no composition are explicitly not comparable.
 * @param candidate - two host-resolved observations from one session.
 * @returns the comparability verdict and named limitations.
 */
export function compareObservationEvidence(candidate: ComparisonCandidate): ComparisonVerdict {
  const { before, after, beforeCallId, afterCallId } = candidate
  if (before.observationId === after.observationId || before.callId !== beforeCallId || after.callId !== afterCallId) {
    return { status: 'refused', code: 'same-observation' }
  }
  const beforeBasemap = before.basemap?.basemap
  const afterBasemap = after.basemap?.basemap
  if (beforeBasemap === undefined || afterBasemap === undefined || beforeBasemap.id !== 'esri-wayback'
    || afterBasemap.id !== 'esri-wayback' || beforeBasemap.release.version === null
    || afterBasemap.release.version === null) return { status: 'refused', code: 'missing-fixed-release' }
  if (beforeBasemap.release.version === afterBasemap.release.version || before.attachment.sha256 === after.attachment.sha256) {
    return { status: 'refused', code: 'same-image' }
  }
  if (before.composition === undefined || after.composition === undefined) return { status: 'refused', code: 'missing-composition' }
  if (JSON.stringify(before.composition) !== JSON.stringify(after.composition)) return { status: 'refused', code: 'composition-changed' }
  const sourceIdentity = (source: MapObservationRecord['sources'][number]) => ({
    id: source.id, kind: source.kind, attribution: source.attribution, policy: source.policy,
  })
  if (JSON.stringify(before.sources.map(sourceIdentity)) !== JSON.stringify(after.sources.map(sourceIdentity))
    || JSON.stringify(before.camera) !== JSON.stringify(after.camera)
    || JSON.stringify(before.imageSize) !== JSON.stringify(after.imageSize)
    || JSON.stringify(before.mapContentRect) !== JSON.stringify(after.mapContentRect)
    || JSON.stringify(before.cssViewSize) !== JSON.stringify(after.cssViewSize)
    || JSON.stringify(before.includedOverlays) !== JSON.stringify(after.includedOverlays)) {
    return { status: 'refused', code: 'view-changed' }
  }
  if (before.camera === null || before.georeference.kind !== 'affine-2d' || after.georeference.kind !== 'affine-2d') {
    return { status: 'refused', code: 'unsupported-georeference' }
  }
  if (JSON.stringify(before.georeference) !== JSON.stringify(after.georeference)) return { status: 'refused', code: 'georeference-changed' }
  const beforePublished = beforeBasemap.release.publishedAt
  const afterPublished = afterBasemap.release.publishedAt
  if (beforePublished === null || afterPublished === null || beforePublished >= afterPublished) {
    return { status: 'refused', code: 'reverse-dates' }
  }
  const beforeAcquired = null
  const afterAcquired = null
  const limitations = [...VISUAL_COMPARISON_LIMITATIONS]
  let comparability: Comparability = 'comparable'
  if (beforeAcquired === null || afterAcquired === null) {
    comparability = 'limited'
    limitations.push('Local acquisition dates are unknown; call these visual differences between published releases, not changes between two dated image acquisitions.')
  }
  return { status: 'ok', comparability, limitations }
}

/**
 * Validate one model-supplied change-candidate batch before any projection write.
 * @param value - untrusted decoded tool arguments.
 * @returns the bounded items, or `undefined` when a field violates the contract.
 */
export function parseVisualChangeItems(value: unknown): readonly VisualChangeItem[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined
  const items: VisualChangeItem[] = []
  for (const entry of value) {
    const parsed = itemSchema.safeParse(entry)
    if (!parsed.success) return undefined
    items.push(parsed.data)
  }
  return items
}

/**
 * Decode one durable comparison meta without inferring missing facts.
 * @param meta - exact `tool/result.meta` value from the session log.
 * @returns the validated record or a named refusal.
 */
export function decodeVisualComparisonMeta(meta: unknown): MapComparisonRecord | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || byteLength(meta) > MAX_VISUAL_CHANGE_META_BYTES) return null
  const parsed = comparisonMetaSchema.safeParse(meta)
  return parsed.success ? parsed.data.record : null
}

/**
 * Decode one durable change-candidate meta without inferring missing facts.
 * @param meta - exact `tool/result.meta` value from the session log.
 * @returns the validated meta or a named refusal.
 */
export function decodeVisualChangeMeta(meta: unknown): { readonly status: 'ok'; readonly meta: VisualChangeMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-kind' | 'unknown-schema-version' | 'oversized-meta' | 'invalid-meta' } {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { status: 'refused', code: 'invalid-meta' }
  const candidate = meta as Record<string, unknown>
  if (candidate.kind !== VISUAL_CHANGE_META_KIND) return { status: 'refused', code: 'unknown-kind' }
  if (candidate.schemaVersion !== VISUAL_CHANGE_SCHEMA_VERSION) return { status: 'refused', code: 'unknown-schema-version' }
  if (byteLength(candidate) > MAX_VISUAL_CHANGE_META_BYTES) return { status: 'refused', code: 'oversized-meta' }
  const parsed = changeMetaSchema.safeParse(candidate)
  return parsed.success ? { status: 'ok', meta: parsed.data } : { status: 'refused', code: 'invalid-meta' }
}

/**
 * Build one trusted comparison meta from host-owned facts.
 * @param record - validated comparison record.
 * @returns durable JSON meta.
 */
export function buildVisualComparisonMeta(record: MapComparisonRecord): VisualComparisonMeta {
  return { kind: VISUAL_COMPARISON_META_KIND, schemaVersion: VISUAL_CHANGE_SCHEMA_VERSION, record }
}

/**
 * Build one trusted change-candidate meta from host-owned facts.
 * @param input - validated batch facts.
 * @returns durable JSON meta.
 * @throws {Error} when the serialized meta exceeds its byte bound.
 */
export function buildVisualChangeMeta(input: VisualChangeMeta['record']): VisualChangeMeta {
  const meta: VisualChangeMeta = { kind: VISUAL_CHANGE_META_KIND, schemaVersion: VISUAL_CHANGE_SCHEMA_VERSION, record: input }
  if (byteLength(meta) > MAX_VISUAL_CHANGE_META_BYTES) throw new Error('visual change meta exceeds its byte bound')
  return meta
}

/**
 * Check one candidate batch against the current comparison and accepted state.
 * @param state - the authoritative comparison records and revision.
 * @param meta - already decoded durable meta.
 * @param pendingCallId - accepted `tool/call` id this result settles.
 * @param pendingCallSeq - accepted `tool/call` seq this result cites.
 * @param existing - currently retained candidates.
 * @returns `null` when safe to fold, otherwise a bounded diagnostic code.
 */
export function visualChangePairingCode(
  state: { readonly revision: number; readonly comparisons: readonly MapComparisonRecord[] },
  meta: VisualChangeMeta,
  pendingCallId: string,
  pendingCallSeq: number,
  existing: readonly VisualChangeRecord[],
): 'comparison-pairing' | 'comparison-limit' | 'stale-revision' | 'invalid-meta' | null {
  const { record } = meta
  const comparison = state.comparisons.find(entry => entry.comparisonId === record.comparisonId)
  if (comparison === undefined || comparison.comparability === 'not-comparable') return 'comparison-pairing'
  if (record.callId !== pendingCallId || record.sourceCallSeq !== pendingCallSeq || record.targetRevision !== state.revision) return 'comparison-pairing'
  const ids = new Set(existing.map(change => change.changeId))
  if (record.changes.some(change => ids.has(change.changeId))) return 'comparison-pairing'
  for (const change of record.changes) {
    if (change.comparisonId !== record.comparisonId
      || change.beforeObservationId !== comparison.beforeObservationId
      || change.afterObservationId !== comparison.afterObservationId
      || change.beforeAttachmentSha256 !== comparison.beforeAttachmentSha256
      || change.afterAttachmentSha256 !== comparison.afterAttachmentSha256
      || change.sourceCallId !== record.callId || change.sourceCallSeq !== record.sourceCallSeq
      || change.mapRevision !== state.revision || change.status !== 'proposed'
      || change.reviewedAt !== null || change.humanEdited || change.acceptedFeatureId !== null
      || change.modelProvider !== record.modelProvider || change.modelName !== record.modelName) return 'invalid-meta'
  }
  if (existing.length + record.changes.length > MAX_VISUAL_CHANGE_CANDIDATES) return 'comparison-limit'
  return null
}
