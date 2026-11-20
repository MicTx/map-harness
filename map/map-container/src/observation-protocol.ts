/**
 * The visual-observation evidence protocol: the versioned `map-observation`
 * `tool/result.meta` record that carries one bounded, replayable capture
 * receipt — identity (observation id, call, request seq, map revision, view,
 * generation, epochs), the persisted attachment descriptor with its sha256,
 * the actual display-plane camera, the georeference (affine-2d coefficients
 * or an explicit `none` reason), the captured sources, the composited
 * overlays, and the stated limitations. Pure data and zod schemas only: no
 * SDK, Node crypto, or decoder imports, so the client-shared surface and the
 * host fold share one contract.
 *
 * Unknown record versions refuse rather than infer; old `tool/result`s
 * without this kind carry no observation evidence.
 * @module @map-harness/map-container/observation-protocol
 */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { parseBasemapSelection, type BasemapSelection, type BasemapSource } from '@map-harness/map-layers'
import { stableDigestOf } from './stable-digest.ts'
import type { MapProjectedLayer } from './protocol.ts'

/** Opaque identifier of one published observation record. */
export type MapObservationId = Branded<'MapObservationId'>

/** Brand a host-minted observation id. */
export function MapObservationId(value: string): MapObservationId {
  return brandString<MapObservationId>(value)
}

/** The only meta kind the observation fold decodes. */
export const MAP_OBSERVATION_META_KIND = 'map-observation'
/** Current record version; versions 1–2 fixed-source records remain readable without a composition. */
export const MAP_OBSERVATION_SCHEMA_VERSION = 3
/** Previous fixed-release record version; retained for old session logs. */
export const MAP_OBSERVATION_SCHEMA_VERSION_2 = 2
/** Current version of the bounded capture-composition identity. */
export const OBSERVATION_COMPOSITION_VERSION = 1

/** Display WKIDs whose samples may carry affine-2d georeference in V1. */
export const GEORFFERENCE_WKIDS = [4326, 3857, 102100, 102113] as const

/** One named rectangle in output-image pixels. */
export interface ObservationRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One image size in pixels. */
export interface ObservationSize {
  readonly width: number
  readonly height: number
}

/** The actual display-plane camera the capture depicts (nullable with an unreadable-camera `none` georeference). */
export interface ObservationCamera {
  /** Display-plane center `[x, y]` in the display WKID. */
  readonly center: readonly [number, number]
  /** Visible extent `[minX, minY, maxX, maxY]` in the display WKID. */
  readonly extent: readonly [number, number, number, number]
  readonly wkid: number
  readonly scale: number
  /** Web-Mercator zoom when the engine reports one; `NaN`/absent on projected views. */
  readonly zoom: number | null
  /** View rotation in degrees. */
  readonly rotation: number
  readonly mode: 'map' | 'scene'
  /** CSS padding insets `[top, right, bottom, left]` the capture covers. */
  readonly padding: readonly [number, number, number, number]
}

/** The affine coefficients mapping output-image `(u, v)` to display-plane `[a*u+b*v+c, d*u+e*v+f]`. */
export interface Affine2dGeoreference {
  readonly kind: 'affine-2d'
  readonly coefficients: readonly [number, number, number, number, number, number]
  readonly wkid: number
  /** Largest independent control-point residual in CSS pixels (<= 1 is a protocol invariant). */
  readonly maxResidualCssPx: number
}

/** Why no georeference attests this capture. */
export type GeoreferenceNoneReason =
  | 'unsupported-projection'
  | 'non-finite-samples'
  | 'singular-mapping'
  | 'excessive-residual'
  | 'world-wrap'
  | 'unreadable-camera'
  | 'not-2d'

/** The positioning contract of this capture. */
export type ObservationGeoreference =
  | Affine2dGeoreference
  | { readonly kind: 'none'; readonly reason: GeoreferenceNoneReason }

/** One captured content source, identified opaquely (never a URL, token, or credential). */
export interface ObservationSource {
  /** Opaque source id (`esri-world-imagery` for the fixed base; layer id for vector overlays). */
  readonly id: string
  readonly kind: 'basemap' | 'vector-layer' | 'overlay'
  /** Source release/version when known (displayDigest for vector layers). */
  readonly version: string | null
  /** Attribution text, when the source requires it. */
  readonly attribution: string | null
  /** Historical source-policy classification; `unverified` also covers explicit denial. */
  readonly policy: 'fixed' | 'approved' | 'unverified'
}

/** The fixed World Imagery base source identity. */
export const FIXED_BASEMAP_SOURCE_ID = 'esri-world-imagery'

/** Host-derived identity of every displayed layer's presentation at capture time. */
export interface ObservationComposition {
  readonly schemaVersion: typeof OBSERVATION_COMPOSITION_VERSION
  readonly digest: string
  readonly layers: readonly {
    readonly id: string
    readonly role: 'basemap' | 'overlay' | 'visual-change' | 'user-annotation' | 'visual-proposal'
    readonly visible: boolean
    readonly opacity: number
    readonly digest: string
  }[]
}

/** One projected layer's visible presentation facts the composition digest covers. */
export type ObservationCompositionLayer = Pick<MapProjectedLayer,
  'id' | 'role' | 'visible' | 'opacity' | 'data' | 'style' | 'symbol' | 'overrides'
  | 'imagery' | 'group' | 'terrain' | 'stream' | 'displayDigest' | 'resourceRef' | 'artifactRef' | 'legend'>

/**
 * Build one explicit digest of every visible layer's rendered identity.
 * A hidden layer cannot affect pixels, but a visible layer's data, imagery,
 * style, opacity, terrain, or stream state changes the captured scene.
 * @param layers - authoritative projected layers in render order.
 * @returns the bounded, versioned composition identity.
 */
export function observationCompositionOf(layers: readonly ObservationCompositionLayer[]): ObservationComposition {
  const visible = layers.filter(layer => layer.visible && layer.opacity > 0)
  const identity: readonly {
    readonly id: string
    readonly role: ObservationComposition['layers'][number]['role']
    readonly visible: boolean
    readonly opacity: number
    readonly digest: string
  }[] = visible.map(layer => ({
    id: layer.id,
    role: layer.role ?? 'overlay',
    visible: layer.visible,
    opacity: layer.opacity,
    digest: layer.displayDigest ?? stableDigestOf({
    data: layer.data ?? null,
    style: layer.style ?? null,
    symbol: layer.symbol ?? null,
    overrides: layer.overrides ?? null,
    imagery: layer.imagery ?? null,
    group: layer.group ?? null,
    terrain: layer.terrain ?? null,
    stream: layer.stream ?? null,
    resourceRef: layer.resourceRef ?? null,
    artifactRef: layer.artifactRef ?? null,
    legend: layer.legend ?? null,
    }),
  }))
  const json = JSON.stringify(identity) ?? '[]'
  let hash = 0x811c9dc5
  for (let at = 0; at < json.length; at += 1) {
    hash ^= json.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return Object.freeze({
    schemaVersion: OBSERVATION_COMPOSITION_VERSION,
    digest: (hash >>> 0).toString(16).padStart(8, '0'),
    layers: identity.map(entry => ({
      id: entry.id,
      role: entry.role,
      visible: entry.visible,
      opacity: entry.opacity,
      digest: entry.digest,
    })),
  })
}

/** The fixed basemap's required attribution text (the one owner of this string). */
export const FIXED_BASEMAP_ATTRIBUTION = 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'

/** The opaque source descriptor the fixed basemap always contributes. */
export const FIXED_BASEMAP_DESCRIPTOR: ObservationSource = Object.freeze({
  id: FIXED_BASEMAP_SOURCE_ID,
  kind: 'basemap',
  version: null,
  attribution: FIXED_BASEMAP_ATTRIBUTION,
  policy: 'fixed',
})

/** The projected layer facts the expected-source builder reads. */
export interface ObservationSourceLayer {
  readonly id: string
  readonly visible: boolean
  readonly opacity: number
  readonly displayDigest?: string | undefined
  readonly imagery?: unknown
}

/** Visibility and blend facts for the raster resources in one capture. */
export interface ObservationImageryDisplay {
  readonly labelsVisible: boolean
  readonly recentVisible: boolean
  readonly recentOpacity: number
  readonly earlyVisible: boolean
  readonly earlySource?: BasemapSource | null
}

/**
 * Build the expected source list for visible, positive-opacity map content.
 * `hasUnverified` describes source policy; it does not decide capture admission.
 * The host compares the browser receipt with its own result from this builder.
 * @param layers - projected business layers in render order.
 * @param selection - the accepted basemap and labels, or null for the default basemap.
 * @param display - visibility and opacity of the imagery carriers.
 * @param defaultLabels - resolved labels used only when the selection is null.
 * @returns the rendered source identities and their policy classification.
 */
export function expectedObservationSources(
  layers: readonly ObservationSourceLayer[],
  selection: BasemapSelection | null = null,
  display: ObservationImageryDisplay = {
    labelsVisible: false,
    recentVisible: true,
    recentOpacity: 1,
    earlyVisible: false,
    earlySource: null,
  },
  defaultLabels: BasemapSource | null = null,
): { readonly sources: readonly ObservationSource[]; readonly hasUnverified: boolean } {
  const sources: ObservationSource[] = []
  const raster = (source: BasemapSelection['basemap']): ObservationSource => ({
    id: source.id,
    kind: 'basemap',
    version: source.release.version,
    attribution: source.attribution,
    policy: source.screenshot === 'allowed' ? 'approved' : 'unverified',
  })
  let selectionUnverified = false
  if (display.earlyVisible && display.earlySource != null) {
    const early = raster(display.earlySource)
    sources.push({ ...early, kind: 'overlay' })
    selectionUnverified ||= display.earlySource.screenshot !== 'allowed'
  }
  if (display.recentVisible && display.recentOpacity > 0) {
    if (selection === null) {
      sources.push(FIXED_BASEMAP_DESCRIPTOR)
    } else {
      sources.push(raster(selection.basemap))
      selectionUnverified ||= selection.basemap.screenshot !== 'allowed'
    }
  }
  const labels = selection === null ? defaultLabels : selection.labels
  if (display.labelsVisible && labels !== null) {
    sources.push(raster(labels))
    selectionUnverified ||= labels.screenshot !== 'allowed'
  }
  let hasUnverified = false
  hasUnverified ||= selectionUnverified
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue
    if (layer.imagery !== undefined && layer.imagery !== null) {
      hasUnverified = true
      sources.push({ id: layer.id, kind: 'overlay', version: null, attribution: null, policy: 'unverified' })
      continue
    }
    sources.push({
      id: layer.id,
      kind: 'vector-layer',
      version: layer.displayDigest ?? null,
      attribution: null,
      policy: 'approved',
    })
  }
  return { sources, hasUnverified }
}

/** The persisted image attachment descriptor (existing attachment face plus content sha256). */
export interface ObservationAttachment {
  readonly attachmentId: string
  readonly mediaType: 'image/png'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  /** Lowercase hex sha256 over the persisted attachment bytes. */
  readonly sha256: string
}

const finiteNumber = z.number().finite()
const sizeSchema = z.object({ width: finiteNumber, height: finiteNumber }).strict()
const rectSchema = z.object({
  x: finiteNumber, y: finiteNumber, width: finiteNumber, height: finiteNumber,
}).strict()

const cameraSchema = z.object({
  center: z.tuple([finiteNumber, finiteNumber]).readonly(),
  extent: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]).readonly(),
  wkid: z.number().int().positive(),
  scale: finiteNumber,
  zoom: finiteNumber.nullable(),
  rotation: finiteNumber,
  mode: z.union([z.literal('map'), z.literal('scene')]),
  padding: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]).readonly(),
}).strict()

const georeferenceSchema = z.union([
  z.object({
    kind: z.literal('affine-2d'),
    coefficients: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber]).readonly(),
    wkid: z.number().int().positive(),
    maxResidualCssPx: finiteNumber,
  }).strict(),
  z.object({
    kind: z.literal('none'),
    reason: z.union([
      z.literal('unsupported-projection'),
      z.literal('non-finite-samples'),
      z.literal('singular-mapping'),
      z.literal('excessive-residual'),
      z.literal('world-wrap'),
      z.literal('unreadable-camera'),
      z.literal('not-2d'),
    ]),
  }).strict(),
])

const sourceSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.union([z.literal('basemap'), z.literal('vector-layer'), z.literal('overlay')]),
  version: z.string().max(256).nullable(),
  attribution: z.string().max(512).nullable(),
  policy: z.union([z.literal('fixed'), z.literal('approved'), z.literal('unverified')]),
}).strict()

const basemapSelectionSchema = z.custom<BasemapSelection>(
  value => parseBasemapSelection(value).ok,
  { message: 'basemap selection rejected by the map-layers selection validator' },
)

/** Strict decoder for one host-derived composition identity. */
export const observationCompositionSchema = z.object({
  schemaVersion: z.literal(OBSERVATION_COMPOSITION_VERSION),
  digest: z.string().regex(/^[0-9a-f]{8}$/u),
  layers: z.array(z.object({
    id: z.string().min(1).max(256),
    role: z.enum(['basemap', 'overlay', 'visual-change', 'user-annotation', 'visual-proposal']),
    visible: z.boolean(),
    opacity: z.number().finite().min(0).max(1),
    digest: z.string().min(1).max(256),
  }).strict()).max(32).readonly(),
}).strict()

const attachmentSchema = z.object({
  attachmentId: z.string().min(1).max(256),
  mediaType: z.literal('image/png'),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().max(512).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict()

/** Shared visual facts refined identically for submitted captures and durable records. */
interface ObservationVisualFields {
  readonly imageSize: ObservationSize
  readonly mapContentRect: ObservationRect
  readonly cssViewSize: ObservationSize
  readonly camera: ObservationCamera | null
  readonly georeference: ObservationGeoreference
}

/** Whether image, content, camera, and georeference facts form one valid 2D receipt. */
function observationVisualFieldsValid(value: ObservationVisualFields): boolean {
  const { imageSize, mapContentRect, cssViewSize, camera, georeference } = value
  const positiveIntegerSize = (size: ObservationSize): boolean =>
    Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0
  if (!positiveIntegerSize(imageSize) || !positiveIntegerSize(cssViewSize)) return false
  if (!(Number.isInteger(mapContentRect.x) && Number.isInteger(mapContentRect.y)
    && Number.isInteger(mapContentRect.width) && mapContentRect.width > 0
    && Number.isInteger(mapContentRect.height) && mapContentRect.height > 0
    && mapContentRect.x >= 0 && mapContentRect.y >= 0
    && mapContentRect.x + mapContentRect.width <= imageSize.width
    && mapContentRect.y + mapContentRect.height <= imageSize.height)) return false
  if (camera === null) {
    return georeference.kind === 'none' && georeference.reason === 'unreadable-camera'
  }
  if (georeference.kind === 'none') return true
  const [a, b, , d, e] = georeference.coefficients
  const determinant = a * e - b * d
  return camera.mode === 'map'
    && (GEORFFERENCE_WKIDS as readonly number[]).includes(georeference.wkid)
    && georeference.wkid === camera.wkid
    && Number.isFinite(determinant) && determinant !== 0
    && georeference.maxResidualCssPx >= 0 && georeference.maxResidualCssPx <= 1
}

/** Bounded record schema; brand the id only after the shared strict decoder accepts the complete record. */
export const mapObservationRecordSchema = z.object({
  observationId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
  requestSeq: z.number().int().nonnegative(),
  mapRevision: z.number().int().nonnegative(),
  viewId: z.string().min(1).max(256),
  generation: z.number().int().nonnegative(),
  cameraEpoch: z.number().int().nonnegative(),
  gestureEpoch: z.number().int().nonnegative(),
  attachment: attachmentSchema,
  capturedAt: z.string().datetime(),
  imageSize: sizeSchema,
  mapContentRect: rectSchema,
  cssViewSize: sizeSchema,
  camera: cameraSchema.nullable(),
  georeference: georeferenceSchema,
  sources: z.array(sourceSchema).max(64).readonly(),
  basemap: basemapSelectionSchema.nullable().optional(),
  includedOverlays: z.array(z.union([z.literal('labels'), z.literal('attribution')])).max(8).readonly(),
  limitations: z.array(z.string().max(512)).max(16).readonly(),
  composition: observationCompositionSchema.optional(),
}).strict()
  .refine(record => observationVisualFieldsValid(record)
    && record.attachment.width === record.imageSize.width
    && record.attachment.height === record.imageSize.height)
  .transform(record => ({
    ...record,
    observationId: MapObservationId(record.observationId),
  }))

/** One bounded visual-observation record (version 1), inferred from its strict decoder. */
export type MapObservationRecord = z.output<typeof mapObservationRecordSchema>

/** Bounded client capture-receipt schema: the untrusted body the host admits. */
export const mapObservationCaptureSchema = z.object({
  renderedRevision: z.number().int().nonnegative(),
  viewId: z.string().min(1).max(256),
  generation: z.number().int().nonnegative(),
  cameraEpoch: z.number().int().nonnegative(),
  gestureEpoch: z.number().int().nonnegative(),
  imageSize: sizeSchema,
  mapContentRect: rectSchema,
  cssViewSize: sizeSchema,
  camera: cameraSchema.nullable(),
  georeference: georeferenceSchema,
  sources: z.array(sourceSchema).max(64).readonly(),
  includedOverlays: z.array(z.union([z.literal('labels'), z.literal('attribution')])).max(8).readonly(),
  pngBase64: z.string().min(1),
  composition: observationCompositionSchema.optional(),
}).strict().refine(observationVisualFieldsValid)

/** The untrusted capture-receipt shape admitted by the host. */
export type MapObservationCaptureShape = z.output<typeof mapObservationCaptureSchema>

/** The durable `tool/result.meta` envelope one published observation rides. */
export interface MapObservationMeta {
  readonly schemaVersion: 1 | typeof MAP_OBSERVATION_SCHEMA_VERSION_2 | typeof MAP_OBSERVATION_SCHEMA_VERSION
  readonly kind: typeof MAP_OBSERVATION_META_KIND
  readonly record: MapObservationRecord
}

const metaSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(MAP_OBSERVATION_SCHEMA_VERSION_2), z.literal(MAP_OBSERVATION_SCHEMA_VERSION)]),
  kind: z.literal(MAP_OBSERVATION_META_KIND),
  record: mapObservationRecordSchema,
}).strict().superRefine((meta, ctx) => {
  if (meta.schemaVersion !== 1 && meta.record.basemap === undefined) {
    ctx.addIssue({ code: 'custom', message: 'observation versions 2 and 3 require their basemap selection', path: ['record', 'basemap'] })
  }
  if (meta.schemaVersion === MAP_OBSERVATION_SCHEMA_VERSION && meta.record.composition === undefined) {
    ctx.addIssue({ code: 'custom', message: 'observation version 3 requires its capture composition', path: ['record', 'composition'] })
  }
  if (meta.schemaVersion === MAP_OBSERVATION_SCHEMA_VERSION_2 && meta.record.composition !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'observation version 2 cannot carry a capture composition', path: ['record', 'composition'] })
  }
  if (meta.schemaVersion === 1 && meta.record.basemap !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'observation version 1 cannot carry a basemap selection', path: ['record', 'basemap'] })
  }
  if (meta.schemaVersion === 1 && meta.record.composition !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'observation version 1 cannot carry a capture composition', path: ['record', 'composition'] })
  }
})

/** The decode verdict for one observation meta. */
export type MapObservationMetaVerdict =
  | { readonly status: 'ok'; readonly record: MapObservationRecord }
  | { readonly status: 'refused'; readonly code: 'unknown-kind' | 'unknown-schema-version' | 'invalid-meta' }

/**
 * Decode one observation meta record. Unknown kinds are not this module's
 * records; unknown versions and malformed payloads refuse rather than infer.
 * @param meta - the raw `tool/result.meta` value.
 */
export function decodeMapObservationMeta(meta: unknown): MapObservationMetaVerdict {
  if (typeof meta !== 'object' || meta === null) return { status: 'refused', code: 'unknown-kind' }
  const kind = (meta as { kind?: unknown }).kind
  if (kind !== MAP_OBSERVATION_META_KIND) return { status: 'refused', code: 'unknown-kind' }
  const version = (meta as { schemaVersion?: unknown }).schemaVersion
  if (version !== 1 && version !== MAP_OBSERVATION_SCHEMA_VERSION_2 && version !== MAP_OBSERVATION_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  const parsed = metaSchema.safeParse(meta)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', record: parsed.data.record }
}

/**
 * Build the durable meta envelope for one record.
 * @param record - the assembled observation record.
 */
export function buildMapObservationMeta(record: MapObservationRecord): MapObservationMeta {
  const schemaVersion = record.composition !== undefined ? MAP_OBSERVATION_SCHEMA_VERSION
    : record.basemap === undefined ? 1 : MAP_OBSERVATION_SCHEMA_VERSION_2
  return {
    schemaVersion,
    kind: MAP_OBSERVATION_META_KIND,
    record,
  }
}

/** Authored base limitation lines (verbatim, model-facing). */
export const OBSERVATION_BASE_LIMITATIONS = [
  'The image depicts the cited revision on the cited view.',
  'Pixel reading is observation, not measurement.',
] as const

/** Authored limitation line for captures without safe positioning. */
export const OBSERVATION_NO_GEOREFERENCE_LIMITATION =
  'This image cannot safely locate map positions from pixels.'

/** Authored limitation line when HTML overlays beyond committed labels/attribution exist. */
export const OBSERVATION_HTML_OVERLAY_LIMITATION =
  'Only committed map labels and source attribution are included; other HTML overlays are not captured.'
