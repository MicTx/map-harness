/**
 * The durable `accessibility-run` meta record the P1 run tools attach to
 * their successful results. Model content, presentationMeta, and the logged
 * `tool/result.meta` all project from one canonical tool value: the model
 * text keeps the run identity, status, and headline metrics; the meta adds
 * the bounded evidence structure and exact references the session log folds.
 * Failures carry no meta — an error result never holds an applicable domain
 * record.
 *
 * @module @map-harness/map-tools/run-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable accessibility-run meta record. */
export const RUN_META_SCHEMA_VERSION = 1

/** The only run meta kind this version decodes; unknown kinds never apply. */
export const RUN_META_KIND = 'accessibility-run'

/**
 * Maximum serialized bytes of one accessibility-run meta record. Inputs are
 * bounded (ids, fixed metric/limitation tables), so the cap is a structural
 * backstop against unbounded input, not an expected operating point.
 */
export const MAX_RUN_META_BYTES = 64 * 1024

/** The headline coverage metrics the meta records beside the run identity. */
export interface AccessibilityRunMetrics {
  readonly outcome: 'complete' | 'partial' | 'empty'
  readonly populationDenominator: number
  readonly coveredPopulation: number
  readonly uncoveredPopulation: number
  readonly coverageRatio: number
}

/** The durable run record a successful run-tool result carries. */
export interface AccessibilityRunMeta {
  readonly schemaVersion: typeof RUN_META_SCHEMA_VERSION
  readonly kind: typeof RUN_META_KIND
  readonly tool: 'run_submit' | 'run_get' | 'run_cancel'
  readonly runId: string
  readonly operationRef: string
  /** Run status at result time; `run_cancel` reports the service adjudication. */
  readonly status: string
  readonly goalRevision: number
  readonly requestDigest: string | null
  readonly metrics: AccessibilityRunMetrics | null
  readonly artifactRefs: readonly string[]
  readonly comparisonDigest: string | null
  readonly limitations: readonly string[]
}

/** Decode outcome for one run meta value: readable or refused with a code. */
export type DecodedAccessibilityRunMeta =
  | { readonly status: 'ok'; readonly meta: AccessibilityRunMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const metricsSchema = z.object({
  outcome: z.enum(['complete', 'partial', 'empty']),
  populationDenominator: z.number(),
  coveredPopulation: z.number(),
  uncoveredPopulation: z.number(),
  coverageRatio: z.number(),
}).strict()

/** Durable accessibility-run meta schema (version 1). */
export const accessibilityRunMetaSchema = z.object({
  schemaVersion: z.literal(RUN_META_SCHEMA_VERSION),
  kind: z.literal(RUN_META_KIND),
  tool: z.enum(['run_submit', 'run_get', 'run_cancel']),
  runId: z.string().min(1),
  operationRef: z.string().min(1),
  status: z.string().min(1),
  goalRevision: z.number().int().nonnegative(),
  requestDigest: z.string().nullable(),
  metrics: metricsSchema.nullable(),
  artifactRefs: z.array(z.string()),
  comparisonDigest: z.string().nullable(),
  limitations: z.array(z.string()),
}).strict() as unknown as z.ZodType<AccessibilityRunMeta>

/**
 * Build one durable run meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildAccessibilityRunMeta(meta: Omit<AccessibilityRunMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: AccessibilityRunMeta = { ...meta, schemaVersion: RUN_META_SCHEMA_VERSION, kind: RUN_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_RUN_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `accessibility run metadata exceeds the ${MAX_RUN_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable run meta value. Only version 1 decodes; anything else —
 * including newer versions — is refused with its code and never silently
 * defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeAccessibilityRunMeta(meta: unknown): DecodedAccessibilityRunMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== RUN_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== RUN_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_RUN_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = accessibilityRunMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data }
}
