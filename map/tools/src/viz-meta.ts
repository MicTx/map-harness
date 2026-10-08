/**
 * The durable `viz-style` meta record the `viz_create_style` tool attaches to
 * its successful results: the versioned style identity, the exact breaks and
 * their statistic source, and the style artifact ref the session log keeps.
 * The style record itself lives in the published artifact; the meta stays a
 * bounded identity + breaks digest. Failures carry no meta — an error result
 * never holds an applicable style record.
 *
 * `viz_classify` and `viz_compare` do not carry this meta: their map change
 * rides the durable `map-change` v3 record (`set-style` op), so the style the
 * layer renders folds with the same commit protocol as every other mutation.
 *
 * @module @map-harness/map-tools/viz-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable viz-style meta record. */
export const VIZ_META_SCHEMA_VERSION = 1

/** The only viz meta kind this version decodes; unknown kinds never apply. */
export const VIZ_META_KIND = 'viz-style'

/**
 * Maximum serialized bytes of one viz-style meta record. Inputs are bounded
 * (identity fields, at most eleven breaks, limitation texts), so the cap is a
 * structural backstop against unbounded input, not an operating point.
 */
export const MAX_VIZ_META_BYTES = 32 * 1024

/** The tools whose successful results carry the viz-style meta. */
export const VIZ_STYLE_TOOLS = ['viz_create_style'] as const

/** One viz-style tool name. */
export type VizStyleToolName = typeof VIZ_STYLE_TOOLS[number]

/** The durable viz-style record a successful `viz_create_style` result carries. */
export interface VizStyleMeta {
  readonly schemaVersion: typeof VIZ_META_SCHEMA_VERSION
  readonly kind: typeof VIZ_META_KIND
  readonly tool: VizStyleToolName
  readonly styleVersion: string
  /** The exact resource version the breaks were computed from. */
  readonly dataRef: string
  readonly field: string
  readonly unit: string
  readonly measure: 'total' | 'rate' | 'density'
  readonly breaks: readonly number[]
  readonly breaksSourceRef: string | null
  readonly artifactRefs: readonly string[]
  readonly limitations: readonly string[]
}

/** Decode outcome for one viz-style meta value. */
export type DecodedVizStyleMeta =
  | { readonly status: 'ok'; readonly meta: VizStyleMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const vizMetaSchema = z.object({
  schemaVersion: z.literal(VIZ_META_SCHEMA_VERSION),
  kind: z.literal(VIZ_META_KIND),
  tool: z.enum(VIZ_STYLE_TOOLS),
  styleVersion: z.string().min(1),
  dataRef: z.string().min(1),
  field: z.string().min(1),
  unit: z.string().min(1),
  measure: z.enum(['total', 'rate', 'density']),
  breaks: z.array(z.number()).min(1).max(11),
  breaksSourceRef: z.string().nullable(),
  artifactRefs: z.array(z.string()),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable viz-style meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildVizStyleMeta(meta: Omit<VizStyleMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: VizStyleMeta = { ...meta, schemaVersion: VIZ_META_SCHEMA_VERSION, kind: VIZ_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_VIZ_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `viz-style metadata exceeds the ${MAX_VIZ_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable viz-style meta value. Only version 1 decodes; anything
 * else — including newer versions — is refused with its code and never
 * silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeVizStyleMeta(meta: unknown): DecodedVizStyleMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== VIZ_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== VIZ_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_VIZ_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = vizMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as VizStyleMeta }
}
