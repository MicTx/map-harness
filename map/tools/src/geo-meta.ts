/**
 * The durable `analysis-result` meta record every `geo_*` tool attaches to its
 * successful results. Model content, presentationMeta, and the logged
 * `tool/result.meta` all project from one canonical tool value: the canonical
 * value keeps the numeric fields and this meta; `output.render` strips the
 * meta for the model text and `output.presentationMeta` publishes it for the
 * session log. Failures carry no meta — an error result never holds an
 * applicable domain record.
 *
 * Schema version 2 adds the versioned-ref input identity (`resourceRef` +
 * `featureRef`) beside the legacy path identity. Readers accept v1 (old logs,
 * path inputs only) and v2; anything else is refused read-only, mirroring the
 * `map-change` decode contract.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { GeoToolName } from './mcp-service.ts'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable geo analysis meta record. */
export const GEO_META_SCHEMA_VERSION = 2

/** The only geo analysis meta kind this version decodes; unknown kinds never apply. */
export const GEO_META_KIND = 'analysis-result'

/** The schema versions whose records decode (1 = pre-P0b path inputs). */
const DECODABLE_SCHEMA_VERSIONS = [1, GEO_META_SCHEMA_VERSION] as const

/**
 * Maximum serialized bytes of one analysis-result meta record. Inputs are
 * bounded (paths, fixed metric/limitation tables), so the cap is a structural
 * backstop against unbounded path input, not an expected operating point.
 */
export const MAX_ANALYSIS_META_BYTES = 64 * 1024

/**
 * The consumed-input identity one analysis actually read. Path inputs keep
 * the legacy identity; versioned-ref inputs cite the exact resource version
 * and stable feature ref the computation consumed.
 */
export type GeoAnalysisInputRef =
  | { readonly path: string; readonly crs: string; readonly featureIndex: number }
  | { readonly resourceRef: string; readonly featureRef: string; readonly crs: string; readonly featureIndex: number }

/** One scalar metric with its unit, projected into content and meta alike. */
export interface GeoAnalysisMetric {
  readonly name: string
  readonly value: number | null
  readonly unit: string
}

/** The durable analysis record a successful geo tool result carries. */
export interface GeoAnalysisMeta {
  readonly schemaVersion: 1 | 2
  readonly kind: typeof GEO_META_KIND
  readonly tool: GeoToolName
  /** Execution status of the local synchronous computation. */
  readonly status: 'succeeded'
  /** Every consumed input with its actual feature selection. */
  readonly inputs: readonly GeoAnalysisInputRef[]
  /** Method identity and the parameters that shaped the computation. */
  readonly method: {
    readonly algorithm: 'turf-buffer' | 'turf-area' | 'turf-intersect' | 'turf-distance'
    readonly units: string
    readonly parameters: Readonly<Record<string, number | string>>
  }
  /** The scalar metrics the model content also reports, with units. */
  readonly metrics: readonly GeoAnalysisMetric[]
  /** Bounded key limitations restating the method's actual semantics. */
  readonly limitations: readonly string[]
}

/** Decode outcome for one analysis meta value: readable or refused with a code. */
export type DecodedGeoAnalysisMeta =
  | { readonly status: 'ok'; readonly meta: GeoAnalysisMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const pathInputSchema = z.object({
  path: z.string(),
  crs: z.string(),
  featureIndex: z.number().int().nonnegative(),
}).strict()

const refInputSchema = z.object({
  resourceRef: z.string().min(1),
  featureRef: z.string().min(1),
  crs: z.string(),
  featureIndex: z.number().int().nonnegative(),
}).strict()

const metricSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
}).strict()

/** Durable analysis-result meta schema: v2 accepts both input identities; v1 records decode through the same input union. */
export const geoAnalysisMetaSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(GEO_META_SCHEMA_VERSION)]),
  kind: z.literal(GEO_META_KIND),
  tool: z.enum(['geo_buffer', 'geo_area', 'geo_intersect', 'geo_distance']),
  status: z.literal('succeeded'),
  inputs: z.array(z.union([pathInputSchema, refInputSchema])),
  method: z.object({
    algorithm: z.enum(['turf-buffer', 'turf-area', 'turf-intersect', 'turf-distance']),
    units: z.string(),
    parameters: z.record(z.string(), z.union([z.number(), z.string()])),
  }).strict(),
  metrics: z.array(metricSchema),
  limitations: z.array(z.string()),
}).strict() as unknown as z.ZodType<GeoAnalysisMeta>

/**
 * Build one durable analysis meta record (schema version 2) and enforce its
 * size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildGeoAnalysisMeta(meta: Omit<GeoAnalysisMeta, 'schemaVersion'>): JsonValue {
  const record: GeoAnalysisMeta = { ...meta, schemaVersion: GEO_META_SCHEMA_VERSION }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_ANALYSIS_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `analysis metadata exceeds the ${MAX_ANALYSIS_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable analysis meta value. Versions 1 and 2 decode (v1 never
 * carries ref identities); anything else — including newer versions — is
 * refused with its code and never silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeGeoAnalysisMeta(meta: unknown): DecodedGeoAnalysisMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (!DECODABLE_SCHEMA_VERSIONS.includes(record.schemaVersion as 1 | 2)) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== GEO_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_ANALYSIS_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = geoAnalysisMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data }
}
