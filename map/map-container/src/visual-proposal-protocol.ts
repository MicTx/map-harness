/**
 * Visual proposal protocol: bounded, versioned records for model-drawn
 * candidates tied to one accepted map observation. The record preserves the
 * model's image-pixel geometry and the independently projected WGS84 geometry
 * so a reviewer can inspect the same evidence after session recovery. Pure
 * data and schemas only; the projection owns candidate state transitions.
 *
 * Unknown versions refuse instead of inferring missing pixel evidence. This
 * module never reads attachments or model services.
 * @module @map-harness/map-container/visual-proposal-protocol
 */
import { z } from 'zod'
import {
  MAP_OBSERVATION_META_KIND,
  MAP_OBSERVATION_SCHEMA_VERSION,
  mapObservationRecordSchema,
  type MapObservationRecord,
} from './observation-protocol.ts'
import type { AnnotationGeometry } from './protocol.ts'

/** Current version of one durable visual-proposal record. */
export const VISUAL_PROPOSAL_META_KIND = 'map-visual-proposal'
/** Current schema version; only this version decodes. */
export const VISUAL_PROPOSAL_SCHEMA_VERSION = 1

/** Maximum items one `map_markup` call may submit. */
export const MAX_VISUAL_PROPOSAL_ITEMS = 100
/** Maximum active (non-rejected) candidates retained by one session. */
export const MAX_ACTIVE_VISUAL_PROPOSALS = 300
/** Maximum coordinate pairs in one candidate's pixel geometry. */
export const MAX_VISUAL_PROPOSAL_COORDINATES = 1024
/** Maximum UTF-8 bytes of one model-supplied category or note. */
export const MAX_VISUAL_PROPOSAL_TEXT_BYTES = 512
/** Maximum UTF-8 bytes of one serialized proposal meta record. */
export const MAX_VISUAL_PROPOSAL_META_BYTES = 64 * 1024
/** Candidate id prefix; the host appends a deterministic digest. */
export const VISUAL_PROPOSAL_ID_PREFIX = 'vprop-'

/** Fixed role of the candidate presentation layer. */
export const VISUAL_PROPOSAL_LAYER_ID = 'visual-proposals'

/** Model self-assessment, never a calibrated probability. */
export type VisualProposalConfidence = 'uncertain' | 'likely'
/** Human review and agent decisions use distinct states. */
export type VisualProposalStatus = 'proposed' | 'accepted' | 'rejected' | 'agent-applied' | 'agent-dismissed'
/** The model's bounded reason for submitting candidates. */
export type VisualProposalPurpose = 'sketch' | 'target'

/** One image-output pixel tuple. */
export type VisualProposalPixelPoint = readonly [number, number]

/** The exact persisted observation image a candidate cites. */
export type VisualProposalAttachment = MapObservationRecord['attachment']

/** Bounded pixel geometry the model reads directly from the observation image. */
export type VisualProposalPixelGeometry =
  | { readonly type: 'point'; readonly point: VisualProposalPixelPoint }
  | { readonly type: 'polyline'; readonly points: readonly VisualProposalPixelPoint[] }
  | { readonly type: 'polygon'; readonly points: readonly VisualProposalPixelPoint[] }
  | { readonly type: 'bbox'; readonly corners: readonly [
    VisualProposalPixelPoint, VisualProposalPixelPoint,
    VisualProposalPixelPoint, VisualProposalPixelPoint,
  ] }

/** One candidate item accepted from a model tool call. */
export interface VisualProposalItem {
  readonly kind: 'sketch' | 'target'
  readonly category: string
  readonly note: string
  readonly confidence: VisualProposalConfidence
  readonly pixelGeometry: VisualProposalPixelGeometry
}

/** One durable candidate with its host identity and projected geometry. */
export interface VisualProposalRecord {
  readonly proposalId: string
  readonly observationId: string
  readonly observationAttachmentSha256: string
  readonly observationAttachment: VisualProposalAttachment
  readonly sourceCallId: string
  readonly sourceCallSeq: number
  readonly mapRevision: number
  readonly modelProvider: string
  readonly modelName: string
  readonly purpose: VisualProposalPurpose
  readonly category: string
  readonly note: string
  readonly confidence: VisualProposalConfidence
  readonly pixelGeometry: VisualProposalPixelGeometry
  readonly geometry: AnnotationGeometry
  readonly status: VisualProposalStatus
  readonly createdAt: string
  readonly reviewedAt: string | null
  /** Explicit for agent decisions; historical human reviews omit this field. */
  readonly reviewedBy?: 'agent'
  readonly humanEdited: boolean
  readonly acceptedFeatureId: string | null
}

/** One versioned `tool/result.meta` value folding a complete candidate batch. */
export interface VisualProposalMeta {
  readonly kind: typeof VISUAL_PROPOSAL_META_KIND
  readonly schemaVersion: typeof VISUAL_PROPOSAL_SCHEMA_VERSION
  readonly record: {
    readonly observationId: string
    readonly callId: string
    readonly sourceCallSeq: number
    readonly targetRevision: number
    readonly purpose: VisualProposalPurpose
    readonly observationVersion: typeof MAP_OBSERVATION_SCHEMA_VERSION
    readonly observationKind: typeof MAP_OBSERVATION_META_KIND
    readonly modelProvider: string
    readonly modelName: string
    readonly proposals: readonly VisualProposalRecord[]
    readonly limitations: readonly string[]
  }
}

/** Verdict of decoding one untrusted durable meta value. */
export type VisualProposalMetaVerdict =
  | { readonly status: 'ok'; readonly meta: VisualProposalMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-kind' | 'unknown-schema-version' | 'oversized-meta' | 'invalid-meta' }

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const finite = z.number().finite()
const point = z.tuple([finite, finite])
const points = z.array(point).min(2).max(MAX_VISUAL_PROPOSAL_COORDINATES)
const ring = z.array(point).min(4).max(MAX_VISUAL_PROPOSAL_COORDINATES)
const bboxCorners = z.tuple([point, point, point, point])

const pixelGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), point }).strict(),
  z.object({ type: z.literal('polyline'), points }).strict(),
  z.object({ type: z.literal('polygon'), points: ring }).strict(),
  z.object({ type: z.literal('bbox'), corners: bboxCorners }).strict(),
]) as z.ZodType<VisualProposalPixelGeometry>

const wgs84Point = z.tuple([
  finite.min(-180).max(180),
  finite.min(-90).max(90),
])
const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: wgs84Point }).strict(),
  z.object({ type: z.literal('LineString'), coordinates: z.array(wgs84Point).min(2).max(MAX_VISUAL_PROPOSAL_COORDINATES) }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(wgs84Point).min(4).max(MAX_VISUAL_PROPOSAL_COORDINATES)).length(1) }).strict(),
]) as z.ZodType<AnnotationGeometry>

const itemSchema = z.object({
  kind: z.enum(['sketch', 'target']),
  category: z.string().max(MAX_VISUAL_PROPOSAL_TEXT_BYTES),
  note: z.string().max(MAX_VISUAL_PROPOSAL_TEXT_BYTES),
  confidence: z.enum(['uncertain', 'likely']),
  pixelGeometry: pixelGeometrySchema,
}).strict().check(value => {
  for (const key of ['category', 'note'] as const) {
    if (byteLength(value.value[key]) > MAX_VISUAL_PROPOSAL_TEXT_BYTES) {
      value.issues.push({ code: 'custom', input: value.value[key], path: [key], message: `proposal ${key} exceeds ${MAX_VISUAL_PROPOSAL_TEXT_BYTES} UTF-8 bytes` })
    }
  }
}) as z.ZodType<VisualProposalItem>

const proposalId = z.string().regex(/^vprop-[0-9a-f]{24}$/u)
const modelIdentity = z.string().min(1).max(128)
const proposalSchema = z.object({
  proposalId,
  observationId: z.string().min(1).max(256),
  observationAttachmentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  observationAttachment: z.object({
    attachmentId: z.string().min(1).max(256),
    mediaType: z.literal('image/png'),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    name: z.string().max(512).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
  sourceCallId: z.string().min(1).max(256),
  sourceCallSeq: z.number().int().nonnegative(),
  mapRevision: z.number().int().nonnegative(),
  modelProvider: modelIdentity,
  modelName: modelIdentity,
  purpose: z.enum(['sketch', 'target']),
  category: z.string().max(MAX_VISUAL_PROPOSAL_TEXT_BYTES),
  note: z.string().max(MAX_VISUAL_PROPOSAL_TEXT_BYTES),
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
{ message: 'proposal review fields must agree with its status' },
) as z.ZodType<VisualProposalRecord>

/** Bounded durable candidate schema, shared by the projection cache reader. */
export const visualProposalRecordSchema = proposalSchema

const visualProposalMetaSchema = z.object({
  kind: z.literal(VISUAL_PROPOSAL_META_KIND),
  schemaVersion: z.literal(VISUAL_PROPOSAL_SCHEMA_VERSION),
  record: z.object({
    observationId: z.string().min(1).max(256),
    callId: z.string().min(1).max(256),
    sourceCallSeq: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    purpose: z.enum(['sketch', 'target']),
    observationVersion: z.literal(MAP_OBSERVATION_SCHEMA_VERSION),
    observationKind: z.literal(MAP_OBSERVATION_META_KIND),
    modelProvider: modelIdentity,
    modelName: modelIdentity,
    proposals: z.array(proposalSchema).max(MAX_VISUAL_PROPOSAL_ITEMS),
    limitations: z.array(z.string().max(MAX_VISUAL_PROPOSAL_TEXT_BYTES)).max(8),
  }).strict(),
}).strict() as z.ZodType<VisualProposalMeta>

/** The three limitations every candidate result states to the model. */
export const VISUAL_PROPOSAL_LIMITATIONS = [
  'Candidates are visual suggestions, not confirmed targets or measurements.',
  'Confidence is a model self-assessment, not a calibrated probability.',
  'Review the source image and geographic position before accepting a candidate.',
] as const

/**
 * Validate one model-supplied candidate batch before any projection write.
 * @param value - untrusted decoded tool arguments.
 * @returns the bounded items, or `undefined` when any field violates the contract.
 */
export function parseVisualProposalItems(value: unknown): readonly VisualProposalItem[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_VISUAL_PROPOSAL_ITEMS) return undefined
  const items: VisualProposalItem[] = []
  for (const entry of value) {
    const parsed = itemSchema.safeParse(entry)
    if (!parsed.success) return undefined
    items.push(parsed.data)
  }
  return items
}

/**
 * Build the durable versioned meta for one complete accepted candidate batch.
 * @param input - trusted host-built batch fields.
 * @returns plain JSON for `tool/result.meta`.
 * @throws {Error} when the serialized record exceeds its byte bound.
 */
export function buildVisualProposalMeta(input: Omit<VisualProposalMeta['record'], 'observationVersion' | 'observationKind' | 'limitations'> & { readonly limitations?: readonly string[] }): VisualProposalMeta {
  const record: VisualProposalMeta['record'] = {
    ...input,
    observationVersion: MAP_OBSERVATION_SCHEMA_VERSION,
    observationKind: MAP_OBSERVATION_META_KIND,
    limitations: input.limitations ?? VISUAL_PROPOSAL_LIMITATIONS,
  }
  const meta: VisualProposalMeta = { kind: VISUAL_PROPOSAL_META_KIND, schemaVersion: VISUAL_PROPOSAL_SCHEMA_VERSION, record }
  if (byteLength(meta) > MAX_VISUAL_PROPOSAL_META_BYTES) throw new Error('visual proposal meta exceeds its byte bound')
  return meta
}

/**
 * Decode one untrusted durable meta value.
 * @param meta - the exact `tool/result.meta` value from the session log.
 * @returns the decoded meta, or a named refusal.
 */
export function decodeVisualProposalMeta(meta: unknown): VisualProposalMetaVerdict {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { status: 'refused', code: 'invalid-meta' }
  const candidate = meta as Record<string, unknown>
  if (candidate.kind !== VISUAL_PROPOSAL_META_KIND) return { status: 'refused', code: 'unknown-kind' }
  if (candidate.schemaVersion !== VISUAL_PROPOSAL_SCHEMA_VERSION) return { status: 'refused', code: 'unknown-schema-version' }
  if (byteLength(candidate) > MAX_VISUAL_PROPOSAL_META_BYTES) return { status: 'refused', code: 'oversized-meta' }
  const parsed = visualProposalMetaSchema.safeParse(candidate)
  return parsed.success ? { status: 'ok', meta: parsed.data } : { status: 'refused', code: 'invalid-meta' }
}

/**
 * Validate one candidate batch against the current observation and state.
 * @param state - current projection state.
 * @param meta - already decoded durable meta.
 * @param pendingCallId - accepted `tool/call` id this result settles.
 * @param pendingCallSeq - accepted `tool/call` seq this result cites.
 * @param existing - currently retained candidates.
 * @returns `null` when the batch may fold, otherwise a bounded diagnostic code.
 */
export function visualProposalPairingCode(
  state: {
    readonly revision: number
    readonly latestObservation: MapObservationRecord | null
  },
  meta: VisualProposalMeta,
  pendingCallId: string,
  pendingCallSeq: number,
  existing: readonly VisualProposalRecord[],
): 'visual-proposal-pairing' | 'visual-proposal-limit' | 'stale-revision' | 'observation-pairing' | 'invalid-meta' | null {
  const { record } = meta
  const observation = state.latestObservation
  if (observation === null || observation.observationId !== record.observationId || observation.mapRevision !== state.revision) return 'observation-pairing'
  if (record.callId !== pendingCallId || record.sourceCallSeq !== pendingCallSeq) return 'visual-proposal-pairing'
  if (record.targetRevision !== state.revision) return 'stale-revision'
  if (record.proposals.some(proposal => proposal.observationAttachmentSha256 !== observation.attachment.sha256
    || JSON.stringify(proposal.observationAttachment) !== JSON.stringify(observation.attachment))) return 'visual-proposal-pairing'
  const parsedObservation = mapObservationRecordSchema.safeParse(observation)
  if (!parsedObservation.success) return 'invalid-meta'
  for (const proposal of record.proposals) {
    if (proposal.observationId !== record.observationId || proposal.sourceCallId !== record.callId
      || proposal.sourceCallSeq !== record.sourceCallSeq || proposal.mapRevision !== state.revision
      || proposal.status !== 'proposed' || proposal.reviewedAt !== null || proposal.humanEdited
      || proposal.acceptedFeatureId !== null || proposal.purpose !== record.purpose) return 'invalid-meta'
    if (proposal.modelProvider !== record.modelProvider || proposal.modelName !== record.modelName) return 'visual-proposal-pairing'
  }
  const ids = new Set(existing.map(proposal => proposal.proposalId))
  if (record.proposals.some(proposal => ids.has(proposal.proposalId))) return 'visual-proposal-pairing'
  const active = existing.filter(proposal => proposal.status === 'proposed').length
  if (active + record.proposals.length > MAX_ACTIVE_VISUAL_PROPOSALS) return 'visual-proposal-limit'
  return null
}
