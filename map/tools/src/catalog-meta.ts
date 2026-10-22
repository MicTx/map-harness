/**
 * The durable `catalog-result` meta record the `catalog_register` and
 * `catalog_resolve` tools attach to their successful results: the resource
 * identities and digests actually presented to the model at this catalog read
 * point. Rebuilding context after compaction replays this record — the model
 * never silently re-reads the catalog's current head. The record never folds
 * into the map projection; it is logged evidence, bounded like the
 * analysis-result meta.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable catalog-result meta record. */
export const CATALOG_META_SCHEMA_VERSION = 1

/** The only catalog meta kind this version decodes; unknown kinds never apply. */
export const CATALOG_META_KIND = 'catalog-result'

/** Maximum serialized bytes of one catalog-result meta record. */
export const MAX_CATALOG_META_BYTES = 64 * 1024

/** One resource's frozen presentation identity inside a catalog result. */
export type CatalogResultResource = {
  /** Exact ref of the resource version that was presented. */
  readonly ref: string
  readonly contentDigest: string
  readonly schemaDigest: string
  readonly nativeCrs: string
  readonly featureCount: number
  readonly authorization: string
}

/** The durable catalog record a successful catalog tool result carries. */
export type CatalogResultMeta = {
  readonly schemaVersion: typeof CATALOG_META_SCHEMA_VERSION
  readonly kind: typeof CATALOG_META_KIND
  /** Which catalog operation produced this record. */
  readonly operation: 'register' | 'resolve'
  /** The bounded resource list the model content presented (≤ 16 entries). */
  readonly resources: readonly CatalogResultResource[]
}

const resourceSchema = z.object({
  ref: z.string().min(1),
  contentDigest: z.string().min(1),
  schemaDigest: z.string().min(1),
  nativeCrs: z.string(),
  featureCount: z.number().int().nonnegative(),
  authorization: z.string(),
}).strict()

/** Durable catalog-result meta schema. */
export const catalogResultMetaSchema = z.object({
  schemaVersion: z.literal(CATALOG_META_SCHEMA_VERSION),
  kind: z.literal(CATALOG_META_KIND),
  operation: z.enum(['register', 'resolve']),
  resources: z.array(resourceSchema).max(16),
}).strict() as unknown as z.ZodType<CatalogResultMeta>

/**
 * Build one durable catalog-result meta record and enforce its size bound.
 * @param meta - the complete record fields from the tool's canonical output.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildCatalogResultMeta(meta: Omit<CatalogResultMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: CatalogResultMeta = { ...meta, schemaVersion: CATALOG_META_SCHEMA_VERSION, kind: CATALOG_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_CATALOG_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `catalog metadata exceeds the ${MAX_CATALOG_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable catalog-result meta value. Only the exact supported
 * schemaVersion/kind decodes; anything else is refused with its code.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or `undefined` when the value is not a
 *   decodable catalog-result record.
 */
export function decodeCatalogResultMeta(meta: unknown): CatalogResultMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const parsed = catalogResultMetaSchema.safeParse(meta)
  return parsed.success ? parsed.data : undefined
}
