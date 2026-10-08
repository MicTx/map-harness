/**
 * The durable spatial records the decisionFrame projection reads: the
 * versioned `decision-change` `tool/result.meta` codec (owned here — the
 * decision domain owns its record, and the `decision_update` tool imports the
 * builder, mirroring how the map projection owns `map-change`) plus the
 * bounded consumer-side readers for the `catalog-result` and
 * `analysis-result` records the map-tools producers write.
 *
 * Read contract (design §5.3, §6.3): only the exact supported schema
 * version/kind decodes; anything else — including newer versions — is
 * refused read-only and never silently defaulted. Failed results carry no
 * applicable domain record by producer discipline; the projection folds the
 * failure itself as a bounded `failed-tool` evidence entry instead.
 *
 * @module @map-harness/spatial-context/records
 */
import { z } from 'zod'
import {
  MAX_PLAN_LIST_ENTRIES,
  type PlanGap,
  type PlanMethod,
} from './frame.ts'

/** Wire/protocol version of the durable decision-change meta record. */
export const DECISION_META_SCHEMA_VERSION = 1

/** The only decision meta kind this version decodes; unknown kinds never apply. */
export const DECISION_META_KIND = 'decision-change'

/** The schema versions whose decision-change records decode. */
const DECODABLE_DECISION_VERSIONS = [DECISION_META_SCHEMA_VERSION] as const

/** Maximum serialized bytes of one decision-change meta record. */
export const MAX_DECISION_META_BYTES = 64 * 1024

/** One gap update inside a decision-change record. */
export type DecisionGapUpdate = Pick<PlanGap, 'id' | 'description' | 'status'>

/** One method candidate inside a decision-change record. */
export type DecisionMethodUpdate = Pick<PlanMethod, 'name' | 'rationale'>

/** The bounded plan update one `decision_update` result proposes. */
export interface DecisionPlanUpdate {
  readonly interpretation?: string
  readonly methods?: readonly DecisionMethodUpdate[]
  readonly steps?: readonly string[]
  readonly gaps?: readonly DecisionGapUpdate[]
}

/** The versioned durable record a successful `decision_update` result carries. */
export interface DecisionChangeMeta {
  readonly schemaVersion: typeof DECISION_META_SCHEMA_VERSION
  readonly kind: typeof DECISION_META_KIND
  /** Seq of this session's `decision_update` `tool/call` the record belongs to. */
  readonly sourceCallSeq: number
  /** The goal revision the plan was written against. */
  readonly goalRevision: number
  /** The plan revision the update was validated against. */
  readonly expectedPlanRevision: number
  /** Seqs of EvidenceLedger entries the plan cites (bounded, already settled). */
  readonly evidenceRefs: readonly number[]
  readonly update: DecisionPlanUpdate
}

const methodSchema = z.object({
  name: z.string().min(1).max(200),
  rationale: z.string().max(1000).optional(),
}).strict()

const gapSchema = z.object({
  id: z.string().min(1).max(120),
  description: z.string().max(1000),
  status: z.enum(['open', 'blocked', 'resolved']),
}).strict()

const updateSchema = z.object({
  interpretation: z.string().max(4000).optional(),
  methods: z.array(methodSchema).max(MAX_PLAN_LIST_ENTRIES).optional(),
  steps: z.array(z.string().max(1000)).max(MAX_PLAN_LIST_ENTRIES).optional(),
  gaps: z.array(gapSchema).max(MAX_PLAN_LIST_ENTRIES).optional(),
}).strict()

/** Durable decision-change meta schema. */
export const decisionChangeMetaSchema = z.object({
  schemaVersion: z.literal(DECISION_META_SCHEMA_VERSION),
  kind: z.literal(DECISION_META_KIND),
  sourceCallSeq: z.number().int().nonnegative(),
  goalRevision: z.number().int().nonnegative(),
  expectedPlanRevision: z.number().int().nonnegative(),
  evidenceRefs: z.array(z.number().int().nonnegative()).max(MAX_PLAN_LIST_ENTRIES),
  update: updateSchema,
}).strict() as unknown as z.ZodType<DecisionChangeMeta>

/** The stable model-facing failure codes a refused `decision_update` reports. */
export type DecisionUpdateRefusalCode = 'goal-revision-stale' | 'plan-revision-conflict' | 'unknown-evidence-ref' | 'invalid-argument'

/**
 * Build one durable decision-change meta record and enforce its size bound.
 * @param meta - the complete record fields from the tool's validated input.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {RangeError} when serialization exceeds the size bound.
 */
export function buildDecisionChangeMeta(meta: Omit<DecisionChangeMeta, 'schemaVersion' | 'kind'>): DecisionChangeMeta {
  const record: DecisionChangeMeta = { ...meta, schemaVersion: DECISION_META_SCHEMA_VERSION, kind: DECISION_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_DECISION_META_BYTES) {
    throw new RangeError(`decision-change metadata exceeds the ${MAX_DECISION_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as DecisionChangeMeta
}

/** Decode outcome for one decision-change meta value. */
export type DecodedDecisionChangeMeta =
  | { readonly status: 'ok'; readonly meta: DecisionChangeMeta }
  | {
    readonly status: 'refused'
    readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta'
  }

/**
 * Decode one durable decision-change meta value. Only the exact supported
 * schemaVersion/kind decodes; anything else is refused with its code.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeDecisionChangeMeta(meta: unknown): DecodedDecisionChangeMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (!DECODABLE_DECISION_VERSIONS.includes(record.schemaVersion as typeof DECODABLE_DECISION_VERSIONS[number])) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== DECISION_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_DECISION_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = decisionChangeMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data }
}

// ── consumer-side readers for producer-owned records ─────────────────────────

/** The bounded presentation identity one catalog result carries per resource. */
export interface CatalogResultResourceRead {
  readonly ref: string
  readonly contentDigest: string
  readonly schemaDigest: string
  readonly nativeCrs: string
  readonly featureCount: number
  readonly authorization: string
}

/** Decoded shape of the catalog-result records this projection reads. */
export interface CatalogResultRead {
  readonly operation: 'register' | 'resolve'
  readonly resources: readonly CatalogResultResourceRead[]
}

const catalogResourceSchema = z.object({
  ref: z.string().min(1),
  contentDigest: z.string().min(1),
  schemaDigest: z.string().min(1),
  nativeCrs: z.string(),
  featureCount: z.number().int().nonnegative(),
  authorization: z.string(),
}).strict()

/**
 * Consumer-side read schema for the catalog-result record the `catalog_*`
 * tools produce. The producer's builder lives in map-tools; this read side
 * is pinned to it by a parity test so the two faces cannot drift.
 */
const catalogResultReadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('catalog-result'),
  operation: z.enum(['register', 'resolve']),
  resources: z.array(catalogResourceSchema).max(16),
}).strict()

/**
 * Read one accepted `catalog-result` meta value. Unknown versions and kinds
 * are refused read-only.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded read, or `undefined` when the value is not a
 *   supported catalog-result record.
 */
export function readCatalogResult(meta: unknown): CatalogResultRead | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const parsed = catalogResultReadSchema.safeParse(meta)
  return parsed.success ? parsed.data : undefined
}

/** One consumed input a successful analysis record cites. */
export type AnalysisInputRead =
  | { readonly path: string; readonly featureIndex: number }
  | { readonly resourceRef: string; readonly featureRef: string; readonly featureIndex: number }

/** One scalar metric with its unit, read from an analysis record. */
export interface AnalysisMetricRead {
  readonly name: string
  readonly value: number | null
  readonly unit: string
}

/** Decoded shape of the analysis-result records this projection reads. */
export interface AnalysisResultRead {
  readonly tool: string
  readonly status: 'succeeded'
  readonly inputs: readonly AnalysisInputRead[]
  readonly metrics: readonly AnalysisMetricRead[]
  readonly limitations: readonly string[]
}

const analysisInputSchema = z.union([
  z.object({
    path: z.string(),
    crs: z.string(),
    featureIndex: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    resourceRef: z.string().min(1),
    featureRef: z.string().min(1),
    crs: z.string(),
    featureIndex: z.number().int().nonnegative(),
  }).strict(),
])

/**
 * Consumer-side read schema for the analysis-result records the `geo_*`
 * tools produce. Version 1 (pre-P0b path inputs) and version 2 (versioned
 * ref identities) both decode; anything else is refused read-only. Pinned to
 * the producer's codec by a parity test.
 */
const analysisResultReadSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  kind: z.literal('analysis-result'),
  tool: z.enum(['geo_buffer', 'geo_area', 'geo_intersect', 'geo_distance']),
  status: z.literal('succeeded'),
  inputs: z.array(analysisInputSchema),
  method: z.object({
    algorithm: z.string(),
    units: z.string(),
    parameters: z.record(z.string(), z.union([z.number(), z.string()])),
  }).strict(),
  metrics: z.array(z.object({
    name: z.string(),
    value: z.number().nullable(),
    unit: z.string(),
  }).strict()),
  limitations: z.array(z.string()),
}).strict()

/**
 * Read one accepted `analysis-result` meta value. Unknown versions and kinds
 * are refused read-only.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded read, or `undefined` when the value is not a
 *   supported analysis-result record.
 */
export function readAnalysisResult(meta: unknown): AnalysisResultRead | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const parsed = analysisResultReadSchema.safeParse(meta)
  if (!parsed.success) return undefined
  const { method: _method, ...rest } = parsed.data
  return rest
}

/** The bounded receipt fields the projection reads from a map-save receipt. */
export interface SaveReceiptRead {
  /** Whether the save completed across all stages. */
  readonly saved: boolean
  readonly durableThroughSeq: number
  readonly revision: number
}

const saveReceiptReadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('map-save-receipt'),
  saved: z.boolean(),
  durableThroughSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).strip()

/**
 * Read one accepted `map-save-receipt` meta value (fields only; the record
 * stays owned by the save tool).
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the receipt fields, or `undefined` when unsupported.
 */
export function readSaveReceipt(meta: unknown): SaveReceiptRead | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const parsed = saveReceiptReadSchema.safeParse(meta)
  return parsed.success ? parsed.data : undefined
}
