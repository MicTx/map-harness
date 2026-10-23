/**
 * The durable `spatial-terrain` meta record the `geo_line_of_sight` tool
 * attaches to its successful results. Model content, presentationMeta, and
 * the logged `tool/result.meta` all project from one canonical tool value:
 * the model text keeps the verdict, obstruction diagnostics, distances, and
 * limitations; the meta adds the versioned method identity, the exact
 * surface revision and vertical metadata the verdict holds for, the sampling
 * and distance definition, and the artifact references the session log
 * folds. Failures carry no meta — an error result never holds an applicable
 * domain record.
 *
 * @module @map-harness/map-tools/terrain-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { SpatialError } from './spatial-errors.ts'

/** Wire/protocol version of the durable spatial-terrain meta record. */
export const TERRAIN_META_SCHEMA_VERSION = 1

/** The only terrain meta kind this version decodes; unknown kinds never apply. */
export const TERRAIN_META_KIND = 'spatial-terrain'

/**
 * Maximum serialized bytes of one spatial-terrain meta record. Inputs are
 * bounded (refs, one headline verdict, limitation texts), so the cap is a
 * structural backstop against unbounded input, not an operating point.
 */
export const MAX_TERRAIN_META_BYTES = 64 * 1024

/** The tools whose successful results carry the spatial-terrain meta. */
export const TERRAIN_TOOLS = ['geo_line_of_sight', 'terrain_viewshed'] as const

/** One terrain tool name. */
export type TerrainToolName = typeof TERRAIN_TOOLS[number]

/** The verdict statuses a terrain meta records (`indeterminate` is honest, errors throw). */
export type TerrainResultStatus = 'succeeded' | 'indeterminate'

/** The bounded headline verdict the meta records beside the run identity. `viewshed` marks an area run whose verdicts live in the artifact table. */
export interface TerrainLosHeadline {
  readonly verdict: 'visible' | 'blocked' | 'indeterminate' | 'viewshed'
  /** Distance of the first obstruction, meters; `null` when the verdict is not `blocked`. */
  readonly obstructionDistanceM: number | null
  /** Which obstacle kind blocked; `null` when the verdict is not `blocked`. */
  readonly obstructionSource: 'terrain' | 'building' | 'voxel' | null
}

/** The durable terrain record a successful `geo_line_of_sight` result carries. */
export interface TerrainLosMeta {
  readonly schemaVersion: typeof TERRAIN_META_SCHEMA_VERSION
  readonly kind: typeof TERRAIN_META_KIND
  readonly tool: TerrainToolName
  readonly status: TerrainResultStatus
  readonly methodVersion: string
  readonly surfaceRef: string
  /** Content digest of the exact bound surface bytes — the terrain revision. */
  readonly surfaceRevision: string
  readonly vertical: { readonly datum: string; readonly units: string; readonly epoch: string }
  readonly horizontalCrs: string
  readonly specDigest: string
  readonly headline: TerrainLosHeadline
  readonly samplingIntervalM: number
  readonly sampleCount: number
  readonly distanceDefinition: 'local-tangent-plane'
  readonly artifactRefs: readonly string[]
  readonly limitations: readonly string[]
}

/** Decode outcome for one terrain meta value: readable or refused with a code. */
export type DecodedTerrainLosMeta =
  | { readonly status: 'ok'; readonly meta: TerrainLosMeta }
  | { readonly status: 'refused'; readonly code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta' }

const terrainMetaSchema = z.object({
  schemaVersion: z.literal(TERRAIN_META_SCHEMA_VERSION),
  kind: z.literal(TERRAIN_META_KIND),
  tool: z.enum(TERRAIN_TOOLS),
  status: z.enum(['succeeded', 'indeterminate']),
  methodVersion: z.string().min(1),
  surfaceRef: z.string().min(1),
  surfaceRevision: z.string().min(1),
  vertical: z.object({ datum: z.string().min(1), units: z.string().min(1), epoch: z.string().min(1) }).strict(),
  horizontalCrs: z.string().min(1),
  specDigest: z.string().min(1),
  headline: z.object({
    verdict: z.enum(['visible', 'blocked', 'indeterminate', 'viewshed']),
    obstructionDistanceM: z.number().nullable(),
    obstructionSource: z.enum(['terrain', 'building', 'voxel']).nullable(),
  }).strict(),
  samplingIntervalM: z.number().positive(),
  sampleCount: z.number().int().positive(),
  distanceDefinition: z.literal('local-tangent-plane'),
  artifactRefs: z.array(z.string()),
  limitations: z.array(z.string()),
}).strict()

/**
 * Build one durable terrain meta record and enforce its size bound.
 * @param meta - the complete record fields from one canonical tool value.
 * @returns the record as plain JSON for `tool/result.meta`.
 * @throws {SpatialError} with `RESOURCE_TOO_LARGE` when serialization exceeds the bound.
 */
export function buildTerrainLosMeta(meta: Omit<TerrainLosMeta, 'schemaVersion' | 'kind'>): JsonValue {
  const record: TerrainLosMeta = { ...meta, schemaVersion: TERRAIN_META_SCHEMA_VERSION, kind: TERRAIN_META_KIND }
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_TERRAIN_META_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `spatial terrain metadata exceeds the ${MAX_TERRAIN_META_BYTES} byte limit`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * Decode one durable terrain meta value. Only version 1 decodes; anything
 * else — including newer versions — is refused with its code and never
 * silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeTerrainLosMeta(meta: unknown): DecodedTerrainLosMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== TERRAIN_META_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== TERRAIN_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (JSON.stringify(record).length > MAX_TERRAIN_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = terrainMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data as unknown as TerrainLosMeta }
}
