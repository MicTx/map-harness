/**
 * The durable `spatial-decision` meta record the P3 attribution/forecast/
 * scenario tools attach to their successful results. Model content,
 * presentationMeta, and the logged `tool/result.meta` all project from one
 * canonical tool value: the model text keeps the status, claim level,
 * headline statistic, and limitations; the meta adds the versioned method
 * identity, the spec digest, and the exact artifact references the session
 * log folds. Failures carry no meta — an error result never holds an
 * applicable domain record.
 *
 * @module @map-harness/map-tools/decision-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { DecisionModelToolName } from './mcp-service.ts'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable spatial-decision meta record. */
export const DECISION_MODEL_META_SCHEMA_VERSION = 1

/** The only decision meta kind this version decodes; unknown kinds never apply. */
export const DECISION_MODEL_META_KIND = 'spatial-decision'

/**
 * Maximum serialized bytes of one spatial-decision meta record. Inputs are
 * bounded (ids, a single headline statistic, limitation texts), so the cap
 * is a structural backstop against unbounded input, not an operating point.
 */
export const MAX_DECISION_META_BYTES = 64 * 1024

/** The tools whose successful results carry the spatial-decision meta. */
export const DECISION_MODEL_TOOLS = [
  'attribution_association',
  'attribution_explain',
  'attribution_effect',
  'forecast_validate',
  'forecast_fit',
  'forecast_predict',
  'scenario_compare',
  'location_allocate',
] as const

/** One decision-model tool name. */
export type DecisionToolName = DecisionModelToolName

/** The result statuses a decision tool reports (never `failed` — errors throw). */
export type DecisionResultStatus = 'succeeded' | 'partial' | 'not_applicable' | 'unknown'

/** The headline statistic the meta records beside the run identity. */
export interface SpatialDecisionHeadline {
  readonly metric: string
  readonly value: number | string | null
}

/** The durable decision record a successful decision-tool result carries. */
export interface SpatialDecisionMeta {
  readonly schemaVersion: typeof DECISION_MODEL_META_SCHEMA_VERSION
  readonly kind: typeof DECISION_MODEL_META_KIND
  readonly tool: DecisionToolName
  readonly status: DecisionResultStatus
  /** The epistemic label attribution tools carry; other tools record `null`. */
  readonly claimLevel: string | null
  readonly methodVersion: string
  /** The primary input resource ref; `null` for inline-only scenario inputs. */
  readonly resourceRef: string | null
  readonly field: string | null
  readonly goalRevision: number
  readonly specDigest: string
  readonly headline: SpatialDecisionHeadline
  readonly notApplicableReason: string | null
  readonly artifactRefs: readonly string[]
  readonly limitations: readonly string[]
}

/** Decode outcome for one decision meta value: readable or refused with a code. */
export type DecodedSpatialDecisionMeta =
  | { readonly status: 'ok'; readonly meta: SpatialDecisionMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const decisionMetaSchema = z.object({
  schemaVersion: z.literal(DECISION_MODEL_META_SCHEMA_VERSION),
  kind: z.literal(DECISION_MODEL_META_KIND),
  tool: z.enum(DECISION_MODEL_TOOLS),
  status: z.enum(['succeeded', 'partial', 'not_applicable', 'unknown']),
  claimLevel: z.string().nullable(),
  methodVersion: z.string().min(1),
  resourceRef: z.string().nullable(),
  field: z.string().nullable(),
  goalRevision: z.number().int().nonnegative(),
  specDigest: z.string().min(1),
  headline: z.object({ metric: z.string().min(1), value: z.union([z.number(), z.string()]).nullable() }).strict(),
  notApplicableReason: z.string().nullable(),
  artifactRefs: z.array(z.string()),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable decision meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildSpatialDecisionMeta(meta: Omit<SpatialDecisionMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: SpatialDecisionMeta = { ...meta, schemaVersion: DECISION_MODEL_META_SCHEMA_VERSION, kind: DECISION_MODEL_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_DECISION_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `spatial decision metadata exceeds the ${MAX_DECISION_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable decision meta value. Only version 1 decodes; anything
 * else — including newer versions — is refused with its code and never
 * silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeSpatialDecisionMeta(meta: unknown): DecodedSpatialDecisionMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== DECISION_MODEL_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== DECISION_MODEL_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_DECISION_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = decisionMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as SpatialDecisionMeta }
}
