/**
 * The durable `spatial-scale` meta record the scale tools attach to their
 * successful results. Model content, presentationMeta, and the logged
 * `tool/result.meta` all project from one canonical tool value: the model
 * text keeps the version identity, the bounded read/scan summary, and the
 * limitations; the meta adds the versioned method identity, the manifest and
 * record digests, and the exact resource/artifact references the session
 * log folds. Failures carry no meta — an error result never holds an
 * applicable domain record.
 *
 * @module @map-harness/map-tools/scale-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable spatial-scale meta record. */
export const SCALE_META_SCHEMA_VERSION = 1

/** The only scale meta kind this version decodes; unknown kinds never apply. */
export const SCALE_META_KIND = 'spatial-scale'

/**
 * Maximum serialized bytes of one spatial-scale meta record. Inputs are
 * bounded (refs, digests, counts, bounded summaries), so the cap is a
 * structural backstop against unbounded input, not an operating point.
 */
export const MAX_SCALE_META_BYTES = 64 * 1024

/** The tools whose successful results carry the spatial-scale meta. */
export const SCALE_TOOLS = ['scale_ingest', 'scale_read', 'scale_scan'] as const

/** One scale tool name. */
export type ScaleToolName = typeof SCALE_TOOLS[number]

/** The durable scale record a successful scale-tool result carries. */
export interface SpatialScaleMeta {
  readonly schemaVersion: typeof SCALE_META_SCHEMA_VERSION
  readonly kind: typeof SCALE_META_KIND
  readonly tool: ScaleToolName
  readonly methodVersion: string
  /** The scale version ref (`scl-…@<digest12>`) the call consumed or produced. */
  readonly scaleRef: string
  /** The registered catalog resource the scale version was copied from. */
  readonly sourceRef: string | null
  /** The version manifest digest (null for reads that did not resolve a manifest — never in practice). */
  readonly manifestDigest: string | null
  /** The published artifact ref, when the call published one. */
  readonly artifactRef: string | null
  /** The scan-record digest of the run, when the call ran one. */
  readonly recordDigest: string | null
  /** The authorization domain every byte moved under. */
  readonly authorization: string
  readonly limitations: readonly string[]
}

/** Decode outcome for one scale meta value: readable or refused with a code. */
export type DecodedSpatialScaleMeta =
  | { readonly status: 'ok'; readonly meta: SpatialScaleMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const scaleMetaSchema = z.object({
  schemaVersion: z.literal(SCALE_META_SCHEMA_VERSION),
  kind: z.literal(SCALE_META_KIND),
  tool: z.enum(SCALE_TOOLS),
  methodVersion: z.string().min(1),
  scaleRef: z.string().min(1),
  sourceRef: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  artifactRef: z.string().nullable(),
  recordDigest: z.string().nullable(),
  authorization: z.string().min(1),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable scale meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildSpatialScaleMeta(meta: Omit<SpatialScaleMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: SpatialScaleMeta = { ...meta, schemaVersion: SCALE_META_SCHEMA_VERSION, kind: SCALE_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_SCALE_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `spatial scale metadata exceeds the ${MAX_SCALE_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable scale meta value. Only version 1 decodes; anything
 * else — including newer versions — is refused with its code and never
 * silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeSpatialScaleMeta(meta: unknown): DecodedSpatialScaleMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== SCALE_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== SCALE_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_SCALE_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = scaleMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as SpatialScaleMeta }
}
