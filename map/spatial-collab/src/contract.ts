/**
 * The spatial collaboration contract (`spatial-collab@1`): the vocabulary
 * multiple writers exchange to edit one authoritative map document — writer
 * identity, client operation ids, conditional patch operations with explicit
 * expectations, the conflict codes, and the bounded conflict diff.
 *
 * The contract is deliberate about what it does NOT claim: commits follow a
 * single-server serial model (the expectedRevision check and the acceptance
 * run in one synchronous segment of the owning service/fold), never a
 * distributed CAS or CRDT; undo produces a NEW compensating revision and
 * never promises to roll back external resources (files, published artifacts,
 * LBS jobs). See the design doc §11.3.
 *
 * The vocabulary carries identity digests, not content: a patch op names the
 * layer digest it assumes, so a stale patch against a changed or deleted
 * layer conflicts with an explainable per-op reason instead of silently
 * overwriting or auto-replaying. Layer/style/aoi payloads ride opaquely
 * through the engine; the consuming tool validates content and compiles the
 * accepted ops into the authoritative map-change record.
 *
 * @module @map-harness/spatial-collab/contract
 */
import { z } from 'zod'
import { isSupportedDisplayWkid } from '@map-harness/spatial-catalog'

/** Wire/contract version stamped into durable collab records. */
export const COLLAB_METHOD_VERSION = 'spatial-collab@1'

/** Maximum operations in one patch. */
export const MAX_PATCH_OPS = 8

/** Maximum entries retained in a commit outcome ledger (idempotency window). */
export const MAX_OPERATION_LEDGER = 128

/** Maximum length of one writer id or client operation id. */
export const MAX_COLLAB_ID_LENGTH = 64

/** Maximum points in one AOI ring. */
export const MAX_AOI_POINTS = 256

/** One writer identity format: `1..64` chars of `[A-Za-z0-9_.:-]`. */
export const collabIdSchema = z.string().min(1).max(MAX_COLLAB_ID_LENGTH).regex(/^[A-Za-z0-9_.:-]+$/)

/** One WGS84 [lon, lat] pair. */
export const lonLatSchema = z.tuple([z.number(), z.number()]).check((value) => {
  const [lon, lat] = value.value
  if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    value.issues.push({
      code: 'custom',
      message: 'coordinates must be finite WGS84 lon/lat in [-180,180]x[-90,90]',
      input: value.value,
      path: [],
    })
  }
})

/** The container view record as the collab plane sees it. */
export const collabViewSchema = z.object({
  center: lonLatSchema,
  zoom: z.number().min(0).max(24),
  wkid: z.number().int().check((value) => {
    if (!isSupportedDisplayWkid(value.value)) {
      value.issues.push({ code: 'custom', message: `unsupported display WKID ${value.value}`, input: value.value, path: [] })
    }
  }),
}).strict()

/** The display mode the collab plane can set. */
export const collabModeSchema = z.enum(['map', 'scene'])

/** An opaque content digest (`1..128` chars) identifying one value's bytes. */
export const collabDigestSchema = z.string().min(1).max(128)

/** One named AOI polygon: a closed WGS84 lon/lat ring (a bbox ring qualifies). */
export interface CollabAoi {
  readonly name?: string
  readonly ring: readonly (readonly [number, number])[]
}

export const collabAoiSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  ring: z.array(z.tuple([z.number(), z.number()])).min(3).max(MAX_AOI_POINTS),
}).strict().check((value) => {
  for (const [index, [lon, lat]] of value.value.ring.entries()) {
    if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      value.issues.push({
        code: 'custom',
        message: `aoi ring point ${index} is not finite WGS84 lon/lat`,
        input: value.value,
        path: ['ring', index],
      })
      break
    }
  }
}) as unknown as z.ZodType<CollabAoi>

/**
 * One layer as the collab plane carries it: identity (`id` + content
 * `digest`) plus the opaque display payload the consuming tool validates and
 * compiles into the authoritative layer record. The engine never inspects
 * `data`. The digest is identity, not a secret: when the writer omits it the
 * consuming tool computes it from the payload before the commit.
 */
export interface CollabLayerInput {
  readonly id: string
  readonly name: string
  /** Content digest of the display payload this op writes; the tool computes it when omitted. */
  readonly digest?: string
  readonly sourceCrs: string
  readonly opacity: number
  readonly visible: boolean
  /** Opaque display payload (GeoJSON FeatureCollection for the map plane). */
  readonly data: unknown
  readonly legend?: { readonly title: string; readonly symbol: { readonly color: string; readonly outline: string } }
  readonly resourceRef?: string
  readonly artifactRef?: string
}

export const collabLayerInputSchema = z.object({
  id: collabIdSchema,
  name: z.string().min(1).max(200),
  digest: collabDigestSchema.optional(),
  sourceCrs: z.string().min(1).max(64),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  data: z.unknown(),
  legend: z.object({
    title: z.string().min(1).max(200),
    symbol: z.object({ color: z.string().min(1), outline: z.string().min(1) }).strict(),
  }).strict().optional(),
  resourceRef: collabIdSchema.optional(),
  artifactRef: collabIdSchema.optional(),
}).strict()

/** Per-op expectation: what the patch assumes the CURRENT document looks like. */
export interface CollabExpectation {
  /** The layer must be present carrying exactly this digest. */
  readonly digest?: string
  /** The layer must be absent (delete-conflict guard for upserts). */
  readonly absent?: true
  /** The whole layer order must equal this id sequence (reorder guard). */
  readonly order?: readonly string[]
  /** The current view must carry this digest (value-undo/overwrite guard). */
  readonly viewDigest?: string
  /** The current mode must equal this value. */
  readonly mode?: 'map' | 'scene'
  /** The current AOI must carry this digest (`null` expects no AOI). */
  readonly aoiDigest?: string | null
}

export const collabExpectationSchema = z.object({
  digest: collabDigestSchema.optional(),
  absent: z.literal(true).optional(),
  order: z.array(collabIdSchema).optional(),
  viewDigest: collabDigestSchema.optional(),
  mode: collabModeSchema.optional(),
  aoiDigest: collabDigestSchema.nullable().optional(),
}).strict()

/** One conditional patch operation. Payloads ride opaquely; expectations guard staleness. */
export type CollabPatchOp =
  | { readonly kind: 'upsert-layer'; readonly layer: CollabLayerInput; readonly expect?: CollabExpectation }
  | { readonly kind: 'remove-layer'; readonly layerId: string; readonly expect?: CollabExpectation }
  | { readonly kind: 'reorder-layers'; readonly layerIds: readonly string[]; readonly expect?: CollabExpectation }
  | { readonly kind: 'set-view'; readonly view: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number }; readonly expect?: CollabExpectation }
  | { readonly kind: 'set-mode'; readonly mode: 'map' | 'scene'; readonly expect?: CollabExpectation }
  | { readonly kind: 'set-style'; readonly entries: readonly { readonly layerId: string; readonly style?: unknown; readonly expect?: CollabExpectation }[]; readonly expect?: CollabExpectation }
  | { readonly kind: 'set-aoi'; readonly aoi: CollabAoi | null; readonly expect?: CollabExpectation }

export const collabPatchOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upsert-layer'),
    layer: collabLayerInputSchema,
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('remove-layer'),
    layerId: collabIdSchema,
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('reorder-layers'),
    layerIds: z.array(collabIdSchema).min(1).max(MAX_PATCH_OPS * 8),
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('set-view'),
    view: collabViewSchema,
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('set-mode'),
    mode: collabModeSchema,
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('set-style'),
    entries: z.array(z.object({
      layerId: collabIdSchema,
      style: z.unknown().optional(),
      expect: collabExpectationSchema.optional(),
    }).strict()).min(1).max(MAX_PATCH_OPS),
    expect: collabExpectationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('set-aoi'),
    aoi: collabAoiSchema.nullable(),
    expect: collabExpectationSchema.optional(),
  }).strict(),
]) as unknown as z.ZodType<CollabPatchOp>

/** One submitted patch: ordered conditional ops plus its optimistic base. */
export interface CollabPatch {
  /** Client operation id — the idempotency key; re-submitting replays the first outcome. */
  readonly operationId?: string
  /** The document revision this patch was prepared against. */
  readonly expectedRevision: number
  readonly ops: readonly CollabPatchOp[]
}

export const collabPatchSchema = z.object({
  operationId: collabIdSchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
  ops: z.array(collabPatchOpSchema).min(1).max(MAX_PATCH_OPS),
}).strict()

/** The collaborative document face the engine commits against: identity + order, not content. */
export interface CollabDocument {
  readonly revision: number
  /** Layers in document order; the digest is the rendered-identity token, the style version the classification identity. */
  readonly layers: readonly { readonly id: string; readonly digest?: string; readonly styleVersion?: string }[]
  readonly view: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number }
  readonly mode: 'map' | 'scene'
  /** Digest of the current AOI, or `null` when none is set. */
  readonly aoiDigest: string | null
}

/** One recorded commit outcome (the idempotency ledger row). */
export interface CollabOperationOutcome {
  readonly operationId: string
  readonly status: 'accepted' | 'conflict'
  /** Post-commit revision for accepted outcomes. */
  readonly revision?: number
  readonly code?: string
}

/** Why one committed patch could not apply — every refusal is named. */
export type CollabCommitCode =
  | 'stale_revision'
  | 'duplicate_operation'
  | 'layer_missing'
  | 'layer_present'
  | 'layer_digest_conflict'
  | 'order_conflict'
  | 'view_conflict'
  | 'mode_conflict'
  | 'aoi_conflict'
  | 'capacity'

/** Why the patch was structurally rejected before any document read. */
export type CollabPatchInvalidCode = 'invalid-patch' | 'invalid-operation-id' | 'empty-patch'

/** One per-op conflict reason: what the op assumed versus what is. */
export interface CollabConflictEntry {
  /** Index of the failing op in the patch. */
  readonly index: number
  readonly kind: CollabPatchOp['kind']
  readonly code: CollabCommitCode
  readonly detail: string
}

/** The explainable difference a conflict returns: per-op reasons plus the current document face. */
export interface CollabConflictDiff {
  readonly baseRevision: number
  readonly currentRevision: number
  readonly entries: readonly CollabConflictEntry[]
  /** Current layer identities in document order (id + digest) at conflict time. */
  readonly currentLayers: readonly { readonly id: string; readonly digest?: string }[]
  /** Human-readable bounded summary for model-facing text. */
  readonly summary: string
}

/** The single-segment commit outcome. `accepted` carries the next document; nothing partial exists. */
export type CollabCommitResult =
  | { readonly status: 'accepted'; readonly revision: number; readonly document: CollabDocument; readonly ops: readonly CollabPatchOp[] }
  | { readonly status: 'duplicate'; readonly outcome: CollabOperationOutcome }
  | { readonly status: 'conflict'; readonly code: CollabCommitCode; readonly diff: CollabConflictDiff }
  | { readonly status: 'invalid'; readonly code: CollabPatchInvalidCode; readonly detail: string }

/** How the undo target check judged one recorded operation against the current document. */
export type CollabUndoVerdict =
  | { readonly verdict: 'matched' }
  | { readonly verdict: 'already-undone' }
  | { readonly verdict: 'changed'; readonly detail: string }

/**
 * The post-state expectations one recorded operation carries: the engine
 * checks these against the CURRENT document to decide whether the operation's
 * effect is still the live state (undoable) or someone has written since
 * (changed — undo conflicts instead of overwriting).
 */
export interface CollabOperationPost {
  /** Layer identities AFTER the op, in post order, for the layers the op touched. */
  readonly layers?: readonly { readonly id: string; readonly digest?: string; readonly styleVersion?: string }[]
  /** Layer ids the op left ABSENT (removals), so undo can judge re-additions. */
  readonly absentIds?: readonly string[]
  /** Full layer-id order AFTER the op, when the op could change order. */
  readonly order?: readonly string[]
  readonly view?: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number }
  readonly mode?: 'map' | 'scene'
  readonly aoiDigest?: string | null
  /** The style versions of restyled layers AFTER the op (style-touch identity). */
  readonly styleVersions?: readonly { readonly layerId: string; readonly styleVersion: string }[]
}

/** Validate one raw patch value; the message names every structural issue. */
export function parseCollabPatch(value: unknown): { status: 'ok'; patch: CollabPatch } | { status: 'invalid'; code: CollabPatchInvalidCode; detail: string } {
  const parsed = collabPatchSchema.safeParse(value)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      status: 'invalid',
      code: 'invalid-patch',
      detail: `patch rejected: ${first?.path.join('.') ?? 'patch'} ${first?.message ?? 'is invalid'}`,
    }
  }
  return { status: 'ok', patch: parsed.data as CollabPatch }
}
