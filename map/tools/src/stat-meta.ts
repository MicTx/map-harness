/**
 * The durable `spatial-stat` meta record the P2 stat/pattern tools attach to
 * their successful results. Model content, presentationMeta, and the logged
 * `tool/result.meta` all project from one canonical tool value: the model
 * text keeps the status, headline statistic, and limitations; the meta adds
 * the versioned method identity, the spec digest, and the exact artifact
 * references the session log folds. Failures carry no meta — an error result
 * never holds an applicable domain record.
 *
 * @module @map-harness/map-tools/stat-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable spatial-stat meta record. */
export const STAT_META_SCHEMA_VERSION = 1

/** The only stat meta kind this version decodes; unknown kinds never apply. */
export const STAT_META_KIND = 'spatial-stat'

/**
 * Maximum serialized bytes of one spatial-stat meta record. Inputs are
 * bounded (ids, a single headline statistic, limitation texts), so the cap
 * is a structural backstop against unbounded input, not an operating point.
 */
export const MAX_STAT_META_BYTES = 64 * 1024

/** The tools whose successful results carry the spatial-stat meta. */
export const STAT_TOOLS = ['stats_zonal', 'stats_autocorrelation', 'stats_hotspot', 'pattern_change', 'pattern_cluster', 'pattern_flow'] as const

/** One stat tool name. */
export type StatToolName = typeof STAT_TOOLS[number]

/** The result statuses a stat tool reports (never `failed` — errors throw). */
export type StatResultStatus = 'succeeded' | 'partial' | 'not_applicable' | 'unknown'

/** The headline statistic the meta records beside the run identity. */
export interface SpatialStatHeadline {
  readonly metric: string
  readonly value: number | null
}

/** The durable stat record a successful stat-tool result carries. */
export interface SpatialStatMeta {
  readonly schemaVersion: typeof STAT_META_SCHEMA_VERSION
  readonly kind: typeof STAT_META_KIND
  readonly tool: StatToolName
  readonly status: StatResultStatus
  readonly methodVersion: string
  readonly resourceRef: string
  readonly field: string | null
  readonly goalRevision: number
  readonly specDigest: string
  readonly headline: SpatialStatHeadline
  readonly notApplicableReason: string | null
  readonly artifactRefs: readonly string[]
  readonly limitations: readonly string[]
}

/** Decode outcome for one stat meta value: readable or refused with a code. */
export type DecodedSpatialStatMeta =
  | { readonly status: 'ok'; readonly meta: SpatialStatMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const statMetaSchema = z.object({
  schemaVersion: z.literal(STAT_META_SCHEMA_VERSION),
  kind: z.literal(STAT_META_KIND),
  tool: z.enum(STAT_TOOLS),
  status: z.enum(['succeeded', 'partial', 'not_applicable', 'unknown']),
  methodVersion: z.string().min(1),
  resourceRef: z.string().min(1),
  field: z.string().nullable(),
  goalRevision: z.number().int().nonnegative(),
  specDigest: z.string().min(1),
  headline: z.object({ metric: z.string().min(1), value: z.number().nullable() }).strict(),
  notApplicableReason: z.string().nullable(),
  artifactRefs: z.array(z.string()),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable stat meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildSpatialStatMeta(meta: Omit<SpatialStatMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: SpatialStatMeta = { ...meta, schemaVersion: STAT_META_SCHEMA_VERSION, kind: STAT_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_STAT_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `spatial stat metadata exceeds the ${MAX_STAT_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable stat meta value. Only version 1 decodes; anything else —
 * including newer versions — is refused with its code and never silently
 * defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeSpatialStatMeta(meta: unknown): DecodedSpatialStatMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== STAT_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== STAT_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_STAT_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = statMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as SpatialStatMeta }
}
