/**
 * The durable `map-save-receipt` meta record the `map_save` tool attaches to
 * its successful results: the accepted prefix the save covered, the map
 * revision it fixed, and the per-stage durability outcomes. The record never
 * folds into the map projection (it is not a map change) — it is the logged
 * receipt a later reader audits against the session log and the store.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable map-save-receipt meta record. */
export const MAP_SAVE_META_SCHEMA_VERSION = 1

/** The only save meta kind this version decodes; unknown kinds never apply. */
export const MAP_SAVE_META_KIND = 'map-save-receipt'

/** Maximum serialized bytes of one save receipt (bounded artifact listing). */
export const MAX_SAVE_META_BYTES = 64 * 1024

/** One stage of the cross-storage save, reported independently. */
export type MapSaveStageStatus =
  | 'confirmed'
  | 'failed'
  | 'not-checked'
  | 'not-performed'

/** The durable receipt a successful `map_save` carries. */
export type MapSaveReceiptMeta = {
  readonly schemaVersion: typeof MAP_SAVE_META_SCHEMA_VERSION
  readonly kind: typeof MAP_SAVE_META_KIND
  /** Seq of the last accepted event the flush covered (the fixed prefix end). */
  readonly durableThroughSeq: number
  /** The projection revision the receipt fixes. */
  readonly revision: number
  /** Artifact/catalog byte confirmation stage, when the save cited objects. */
  readonly artifactStage: MapSaveStageStatus
  /** The session flush stage. */
  readonly sessionFlush: MapSaveStageStatus
  /** Bounded refs the receipt confirmed (≤ 32 entries). */
  readonly confirmedRefs: readonly string[]
}

const receiptSchema = z.object({
  schemaVersion: z.literal(MAP_SAVE_META_SCHEMA_VERSION),
  kind: z.literal(MAP_SAVE_META_KIND),
  durableThroughSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  artifactStage: z.enum(['confirmed', 'failed', 'not-checked', 'not-performed']),
  sessionFlush: z.enum(['confirmed', 'failed', 'not-checked', 'not-performed']),
  confirmedRefs: z.array(z.string().min(1)).max(32),
}).strict()

/** Durable map-save-receipt meta schema. */
export const mapSaveReceiptMetaSchema = receiptSchema

/**
 * Build one durable save receipt and enforce its size bound.
 * @param meta - the complete receipt fields from the tool's canonical output.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildMapSaveReceiptMeta(meta: Omit<MapSaveReceiptMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: MapSaveReceiptMeta = { ...meta, schemaVersion: MAP_SAVE_META_SCHEMA_VERSION, kind: MAP_SAVE_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_SAVE_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `save receipt exceeds the ${MAX_SAVE_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable save receipt. Only the exact supported schemaVersion/
 * kind decodes; anything else returns `undefined`.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded receipt, or `undefined`.
 */
export function decodeMapSaveReceiptMeta(meta: unknown): MapSaveReceiptMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const parsed = receiptSchema.safeParse(meta)
  return parsed.success ? parsed.data : undefined
}
