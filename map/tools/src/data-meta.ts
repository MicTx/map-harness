/**
 * The durable `data-export` meta record the `data_export` tool attaches to
 * its successful results: the exact source refs consumed, the format and
 * algorithm identity of each published artifact, and the honest limitations
 * the export carries. Failures carry no meta — an error result never holds
 * a publication identity.
 *
 * @module @map-harness/map-tools/data-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable data-export meta record. */
export const DATA_META_SCHEMA_VERSION = 1

/** The only data meta kind this version decodes; unknown kinds never apply. */
export const DATA_META_KIND = 'data-export'

/**
 * Maximum serialized bytes of one data-export meta record. A whole-map
 * export lists one artifact per layer (bounded by the layer budget), so the
 * cap is a structural backstop against unbounded input, not an operating
 * point.
 */
export const MAX_DATA_META_BYTES = 64 * 1024

/** The tools whose successful results carry the data-export meta. */
export const DATA_EXPORT_TOOLS = ['data_export'] as const

/** One data-export tool name. */
export type DataExportToolName = typeof DATA_EXPORT_TOOLS[number]

/** One published artifact identity inside a data-export record. */
export interface DataExportArtifactEntry {
  /** Exact artifact ref of the published export. */
  readonly ref: string
  /** Serializer identity, for example `data-export-shapefile`. */
  readonly algorithm: string
  /** Exact source ref the artifact derives from. */
  readonly sourceRef: string
  /** Layer id the source was read from, when the source was a loaded layer. */
  readonly layerId: string | null
  readonly featureCount: number
}

/** The durable data-export record a successful `data_export` result carries. */
export interface DataExportMeta {
  readonly schemaVersion: typeof DATA_META_SCHEMA_VERSION
  readonly kind: typeof DATA_META_KIND
  readonly tool: DataExportToolName
  /** Export format shared by every artifact in this record. */
  readonly format: 'geojson' | 'csv' | 'kml' | 'shapefile'
  readonly artifacts: readonly DataExportArtifactEntry[]
  readonly limitations: readonly string[]
}

/** Decode outcome for one data-export meta value. */
export type DecodedDataExportMeta =
  | { readonly status: 'ok'; readonly meta: DataExportMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const dataExportMetaSchema = z.object({
  schemaVersion: z.literal(DATA_META_SCHEMA_VERSION),
  kind: z.literal(DATA_META_KIND),
  tool: z.enum(DATA_EXPORT_TOOLS),
  format: z.enum(['geojson', 'csv', 'kml', 'shapefile']),
  artifacts: z.array(z.object({
    ref: z.string().min(1),
    algorithm: z.string().min(1),
    sourceRef: z.string().min(1),
    layerId: z.string().nullable(),
    featureCount: z.number().int().nonnegative(),
  })).min(1),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable data-export meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildDataExportMeta(meta: Omit<DataExportMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: DataExportMeta = { ...meta, schemaVersion: DATA_META_SCHEMA_VERSION, kind: DATA_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_DATA_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `data-export metadata exceeds the ${MAX_DATA_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable data-export meta value. Only version 1 decodes;
 * anything else — including newer versions — is refused with its code and
 * never silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeDataExportMeta(meta: unknown): DecodedDataExportMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== DATA_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== DATA_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_DATA_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = dataExportMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as DataExportMeta }
}
