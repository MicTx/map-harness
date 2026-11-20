/**
 * Credential-free native identifiers shared by source service and SDK clients.
 * @module @map-harness/map-container/source-render-protocol
 */
import type { SourceAdapter } from '@map-harness/map-layers'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session/types'
import {
  basemapPairCompatible,
  createBasemapSelection,
  parseBasemapSource,
  canonicalSourceWkid,
  type BasemapSource,
  type SourceFailureCode,
  type SourceParseResult,
} from '@map-harness/map-layers'

/** Opaque identity of one host source-service activation, never a credential hash. */
export type SourceRuntimeEpoch = Branded<'MapSourceRuntimeEpoch'>
/** Opaque identity of one admitted native geometry within its host activation. */
export type NativeSourceEpoch = Branded<'MapSourceNativeEpoch'>

/** Largest image accepted by native request compilation and header inspection. */
export const MAX_SOURCE_IMAGE_PIXELS = 16_777_216
/** Static raster formats admitted by the controlled resource route. */
export type SourceImageMime = 'image/png' | 'image/jpeg'

/** The only credential-free upstream URLs recognized as public presets. */
export const PUBLIC_SOURCE_PRESETS = Object.freeze({
  'esri-world-imagery': Object.freeze({
    adapter: 'arcgis-mapserver',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
  }),
  'esri-world-boundaries-places': Object.freeze({
    adapter: 'arcgis-mapserver',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
  }),
  'osm-standard': Object.freeze({
    adapter: 'xyz',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  }),
} as const satisfies Readonly<Record<string, { readonly adapter: SourceAdapter; readonly url: string }>>)

/** Identifier of one immutable public preset endpoint. */
export type PublicSourcePresetId = keyof typeof PUBLIC_SOURCE_PRESETS

/** Public WMTS names; upstream identifiers stay in the host translation map. */
export const PUBLIC_WMTS_IDS = Object.freeze({
  layer: 'source',
  style: 'default',
  matrixSet: 'grid',
})

/** Native fields credentials/static endpoint queries must not replace. */
export const SOURCE_NATIVE_QUERY_FIELDS: Readonly<Record<SourceAdapter, readonly string[]>> = Object.freeze({
  xyz: Object.freeze(['z', 'x', 'y']),
  'arcgis-mapserver': Object.freeze([
    'f', 'bbox', 'bboxsr', 'imagesr', 'size', 'dpi', 'format', 'transparent',
    'rotation', 'layers', 'layerdefs', 'dynamiclayers', 'gdbversion', 'callback',
    'time', 'blanktile', 'level', 'row', 'col',
  ]),
  wmts: Object.freeze(['service', 'request', 'version', 'layer', 'style', 'format', 'tilematrixset', 'tilematrix', 'tilerow', 'tilecol']),
})

/** Fixed HTTP paths owned by the source-route handler. */
export const MAP_SOURCE_CATALOG_ROUTE = '/api/map/sources/catalog'
/** Fixed HTTP path that renders an admitted map source. */
export const MAP_SOURCE_RENDER_ROUTE = '/api/map/sources/render'
/** Fixed HTTP path that serves an admitted source resource. */
export const MAP_SOURCE_RESOURCE_ROUTE = '/api/map/sources/resource'

/** SDK layer kind selected from the admitted source adapter and engine. */
export type SourceLayerKind = 'arcgis-tile' | 'arcgis-map-image' | 'web-tile' | 'wmts'
type SourceRenderRole = 'basemap' | 'labels' | 'imagery-overlay'

/** One SDK-safe source role with no private native metadata or endpoint. */
export type SourceRenderLayer = {
  readonly source: BasemapSource
  readonly nativeEpoch: NativeSourceEpoch
  readonly layerKind: SourceLayerKind
} & (
  | { readonly transport: 'public-preset'; readonly presetId: PublicSourcePresetId }
  | { readonly transport: 'controlled'; readonly resourceHref: string }
)

/** The visibility and blend state the prepared source carriers must render. */
export interface MapSourceDisplayState {
  readonly labelsVisible: boolean
  readonly recentVisible: boolean
  readonly recentOpacity: number
  readonly earlyVisible: boolean
}

/** Prepared recipe for an accepted session view; it does not claim render success. */
export interface MapSourceRenderDescriptor {
  readonly schemaVersion: 1
  readonly sessionId: SessionIdType
  readonly runtimeEpoch: SourceRuntimeEpoch
  readonly mode: 'map' | 'scene'
  readonly engineWkid: number
  readonly basemap: SourceRenderLayer
  readonly labels: SourceRenderLayer | null
  readonly earlyImagery: SourceRenderLayer | null
  readonly display: MapSourceDisplayState
}

/** Maximum UTF-8 bytes for a complete source render descriptor. */
export const MAX_SOURCE_RENDER_BYTES = 65_536
/** Maximum encoded query bytes accepted by a source route. */
export const MAX_SOURCE_ROUTE_QUERY_BYTES = 8_192
/** Maximum client conditional-validator header characters. */
export const MAX_SOURCE_CONDITIONAL_HEADER_CHARS = 4_096

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Brand one canonical lowercase UUIDv4 as an activation identity. */
export function SourceRuntimeEpoch(raw: string): SourceRuntimeEpoch {
  if (!uuidV4.test(raw)) throw new TypeError('invalid SourceRuntimeEpoch')
  return brandString<SourceRuntimeEpoch>(raw)
}

/** Brand one canonical lowercase UUIDv4 as an admitted-native identity. */
export function NativeSourceEpoch(raw: string): NativeSourceEpoch {
  if (!uuidV4.test(raw)) throw new TypeError('invalid NativeSourceEpoch')
  return brandString<NativeSourceEpoch>(raw)
}

const renderKeys = ['schemaVersion', 'sessionId', 'runtimeEpoch', 'mode', 'engineWkid', 'basemap', 'labels', 'earlyImagery', 'display'] as const
const displayKeys = ['labelsVisible', 'recentVisible', 'recentOpacity', 'earlyVisible'] as const
const layerKeys = {
  public: ['source', 'nativeEpoch', 'layerKind', 'transport', 'presetId'] as const,
  controlled: ['source', 'nativeEpoch', 'layerKind', 'transport', 'resourceHref'] as const,
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => allowed.has(key))
}

function fail<T>(code: SourceFailureCode): SourceParseResult<T> {
  return { ok: false, code }
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidV4.test(value)
}

function freezeSource(source: BasemapSource): BasemapSource {
  Object.freeze(source.supportedModes)
  Object.freeze(source.compatibleBasemapIds)
  Object.freeze(source.release)
  Object.freeze(source.availability)
  if (source.tileAdjustment !== null && source.tileAdjustment !== undefined) Object.freeze(source.tileAdjustment)
  return Object.freeze(source)
}

function layerKindFits(source: BasemapSource, kind: SourceLayerKind, mode: 'map' | 'scene', engineWkid: number): boolean {
  if (!source.supportedModes.includes(mode)) return false
  const native = canonicalSourceWkid(source.nativeWkid)
  const engine = canonicalSourceWkid(engineWkid)
  switch (source.adapter) {
    case 'xyz':
      return kind === 'web-tile' && native === engine
    case 'wmts':
      return kind === 'wmts' && native === engine
    case 'arcgis-mapserver':
      if (kind === 'arcgis-tile') return native === engine
      return kind === 'arcgis-map-image' && source.supportsDynamicExport && engineWkid > 0
    default:
      return false
  }
}

function hrefMatches(
  href: unknown,
  sessionId: SessionIdType,
  runtimeEpoch: SourceRuntimeEpoch,
  mode: 'map' | 'scene',
  engineWkid: number,
  role: SourceRenderRole,
  source: BasemapSource,
  nativeEpoch: NativeSourceEpoch,
  wmts: boolean,
): href is string {
  if (typeof href !== 'string' || !href.startsWith(`${MAP_SOURCE_RESOURCE_ROUTE}?`)
    || href.includes('#') || href.includes('\\')) return false
  const base = 'https://source-render.invalid'
  let url: URL
  try {
    url = new URL(href, base)
  } catch (error) {
    // A malformed relative resource path is a refusal; no user value is returned.
    if (error instanceof TypeError) return false
    throw error
  }
  if (url.origin !== base || url.pathname !== MAP_SOURCE_RESOURCE_ROUTE
    || new TextEncoder().encode(url.search).length > MAX_SOURCE_ROUTE_QUERY_BYTES) return false
  const expected = new Map<string, string>([
    ['sessionId', sessionId],
    ['role', role],
    ['sourceId', source.id],
    ['configDigest', source.configDigest],
    ['runtimeEpoch', runtimeEpoch],
    ['nativeEpoch', nativeEpoch],
    ['viewMode', mode],
    ['viewWkid', String(engineWkid)],
  ])
  if (wmts) expected.set('resource', 'wmts')
  const seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || expected.get(key) !== value) return false
    seen.add(key)
  }
  return seen.size === expected.size && [...expected.keys()].every(key => seen.has(key))
}

function parseRenderLayer(
  value: unknown,
  role: SourceRenderRole,
  sessionId: SessionIdType,
  runtimeEpoch: SourceRuntimeEpoch,
  mode: 'map' | 'scene',
  engineWkid: number,
): SourceParseResult<SourceRenderLayer> {
  if (!object(value) || typeof value.transport !== 'string') return fail('SOURCE_RESOURCE_DENIED')
  const publicTransport = value.transport === 'public-preset'
  const keys = publicTransport ? layerKeys.public : value.transport === 'controlled' ? layerKeys.controlled : null
  if (keys === null || !exactKeys(value, keys)) return fail('SOURCE_RESOURCE_DENIED')
  const parsedSource = parseBasemapSource(value.source)
  if (!parsedSource.ok) return parsedSource
  const source = freezeSource(parsedSource.value)
  const sourceRole = role === 'imagery-overlay' ? 'basemap' : role
  if (source.role !== sourceRole || !source.supportedModes.includes(mode)
    || (role === 'imagery-overlay' && (source.id !== 'esri-wayback' || source.release.version === null || !/^\d+$/.test(source.release.version)))) {
    return fail('SOURCE_COMBINATION_UNSUPPORTED')
  }
  if (typeof value.layerKind !== 'string'
    || !['arcgis-tile', 'arcgis-map-image', 'web-tile', 'wmts'].includes(value.layerKind)
    || !layerKindFits(source, value.layerKind as SourceLayerKind, mode, engineWkid)) {
    return fail('SOURCE_COMBINATION_UNSUPPORTED')
  }
  if (!canonicalUuid(value.nativeEpoch)) return fail('SOURCE_RESOURCE_DENIED')
  const nativeEpoch = NativeSourceEpoch(value.nativeEpoch)
  if (publicTransport) {
    if (typeof value.presetId !== 'string'
      || !Object.hasOwn(PUBLIC_SOURCE_PRESETS, value.presetId)
      || value.presetId !== source.id
      || source.adapter !== PUBLIC_SOURCE_PRESETS[value.presetId as PublicSourcePresetId].adapter) {
      return fail('SOURCE_RESOURCE_DENIED')
    }
    return {
      ok: true,
      value: Object.freeze({
        source,
        nativeEpoch,
        layerKind: value.layerKind as SourceLayerKind,
        transport: 'public-preset',
        presetId: value.presetId as PublicSourcePresetId,
      }),
    }
  }
  const isWmts = source.adapter === 'wmts'
  if (!hrefMatches(value.resourceHref, sessionId, runtimeEpoch, mode, engineWkid, role, source, nativeEpoch, isWmts)) {
    return fail('SOURCE_RESOURCE_DENIED')
  }
  return {
    ok: true,
    value: Object.freeze({
      source,
      nativeEpoch,
      layerKind: value.layerKind as SourceLayerKind,
      transport: 'controlled',
      resourceHref: value.resourceHref,
    }),
  }
}

/** Decode and strictly validate one bounded public render recipe. */
export function parseMapSourceRenderDescriptor(value: unknown): SourceParseResult<MapSourceRenderDescriptor> {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    // Cyclic/non-JSON input is refused without retaining or reporting its contents.
    if (error instanceof TypeError) return fail('SOURCE_RESOURCE_DENIED')
    throw error
  }
  if (encoded === undefined) return fail('SOURCE_RESOURCE_DENIED')
  if (new TextEncoder().encode(encoded).length > MAX_SOURCE_RENDER_BYTES) return fail('SOURCE_LIMIT_EXCEEDED')
  if (!object(value) || !Object.hasOwn(value, 'schemaVersion') || value.schemaVersion !== 1) {
    return fail(object(value) && Object.hasOwn(value, 'schemaVersion') ? 'SOURCE_VERSION_UNSUPPORTED' : 'SOURCE_RESOURCE_DENIED')
  }
  if (!exactKeys(value, renderKeys)
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value.sessionId)
    || !canonicalUuid(value.runtimeEpoch)
    || (value.mode !== 'map' && value.mode !== 'scene')
    || typeof value.engineWkid !== 'number' || !Number.isSafeInteger(value.engineWkid) || value.engineWkid <= 0) {
    return fail('SOURCE_RESOURCE_DENIED')
  }
  if (!object(value.display) || !exactKeys(value.display, displayKeys)
    || typeof value.display.labelsVisible !== 'boolean'
    || typeof value.display.recentVisible !== 'boolean'
    || typeof value.display.earlyVisible !== 'boolean'
    || typeof value.display.recentOpacity !== 'number'
    || !Number.isFinite(value.display.recentOpacity)
    || value.display.recentOpacity < 0 || value.display.recentOpacity > 1) {
    return fail('SOURCE_RESOURCE_DENIED')
  }
  const display: MapSourceDisplayState = Object.freeze({
    labelsVisible: value.display.labelsVisible,
    recentVisible: value.display.recentVisible,
    recentOpacity: value.display.recentOpacity,
    earlyVisible: value.display.earlyVisible,
  })
  const sessionId = SessionId(value.sessionId)
  const runtimeEpoch = SourceRuntimeEpoch(value.runtimeEpoch)
  const mode = value.mode
  const engineWkid = value.engineWkid
  const basemap = parseRenderLayer(value.basemap, 'basemap', sessionId, runtimeEpoch, mode, engineWkid)
  if (!basemap.ok) return basemap
  let labels: SourceRenderLayer | null = null
  if (value.labels !== null) {
    const parsedLabels = parseRenderLayer(value.labels, 'labels', sessionId, runtimeEpoch, mode, engineWkid)
    if (!parsedLabels.ok) return parsedLabels
    labels = parsedLabels.value
  }
  let earlyImagery: SourceRenderLayer | null = null
  if (value.earlyImagery !== null) {
    const parsedEarly = parseRenderLayer(value.earlyImagery, 'imagery-overlay', sessionId, runtimeEpoch, mode, engineWkid)
    if (!parsedEarly.ok) return parsedEarly
    earlyImagery = parsedEarly.value
  }
  if (display.earlyVisible && earlyImagery === null) return fail('SOURCE_COMBINATION_UNSUPPORTED')
  const selection = createBasemapSelection(basemap.value.source, labels?.source ?? null)
  if (!selection.ok) return selection
  if (!basemapPairCompatible(basemap.value.source, labels?.source ?? null)) {
    return fail('SOURCE_COMBINATION_UNSUPPORTED')
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      sessionId,
      runtimeEpoch,
      mode,
      engineWkid,
      basemap: basemap.value,
      labels,
      earlyImagery,
      display,
    }),
  }
}
