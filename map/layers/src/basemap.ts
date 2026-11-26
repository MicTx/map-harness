/**
 * Pure, versioned source descriptors and selection compatibility rules.
 * Host deployment details and endpoints are owned by map-container.
 * @module @map-harness/map-layers/basemap
 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Opaque, validated identifier for a configured map source. */
export type BasemapSourceId = Branded<'BasemapSourceId'>

/**
 * Validate and brand a source identifier.
 * @param value - identifier from configuration or a decoded source record.
 * @returns the opaque identifier; throws TypeError for invalid syntax.
 */
export function BasemapSourceId(value: string): BasemapSourceId {
  if (!isSourceId(value)) throw new TypeError('invalid BasemapSourceId')
  return brandString<BasemapSourceId>(value)
}

/** Permission applied to one source operation. */
export type SourcePermission = 'allowed' | 'denied' | 'unverified'
/** A source's role in a basemap selection. */
export type SourceRole = 'basemap' | 'labels'
/** Host-supported source adapter identifiers. */
export type SourceAdapter = 'arcgis-mapserver' | 'xyz' | 'wmts'
/** Public source provider labels. */
export type SourceProvider = 'esri' | 'osm' | 'tianditu' | 'amap' | 'custom'
/** A source render mode. */
export type SourceMode = 'map' | 'scene'

/** Historical World Imagery attribution retained for legacy observations. */
export const LEGACY_ESRI_WORLD_IMAGERY_ATTRIBUTION = 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
/** Current World Imagery attribution from its verified public service metadata. */
export const ESRI_WORLD_IMAGERY_ATTRIBUTION = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community'
/** Current World Boundaries and Places attribution from its verified public metadata. */
export const ESRI_WORLD_REFERENCE_ATTRIBUTION = 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community'

/** Release facts supplied by a deployment or service owner. */
export interface SourceRelease {
  readonly version: string | null
  readonly publishedAt: string | null
  readonly acquiredAt: string | null
}

/** Public source descriptor; endpoints and credential references are excluded. */
export interface BasemapSource {
  readonly schemaVersion: 1
  readonly id: BasemapSourceId
  readonly title: string
  readonly provider: SourceProvider
  readonly role: SourceRole
  readonly adapter: SourceAdapter
  readonly configDigest: string
  readonly nativeWkid: number
  readonly supportsDynamicExport: boolean
  readonly supportedModes: readonly SourceMode[]
  /** Application zoom bounds, not arbitrary WMTS matrix identifiers. */
  readonly minZoom: number
  readonly maxZoom: number
  readonly compatibleBasemapIds: readonly BasemapSourceId[]
  readonly attribution: string
  readonly release: SourceRelease
  readonly screenshot: SourcePermission
  readonly automatedMapUse: SourcePermission
  readonly availability:
    | { readonly kind: 'configured' }
    | { readonly kind: 'unavailable'; readonly reason: 'missing-credential' | 'disabled' }
  /** Optional raster coordinate correction applied before display. */
  readonly tileAdjustment?: { readonly kind: 'gcj02'; readonly version: 1 } | null
}

/** One complete, explicit basemap and optional compatible label source. */
export interface BasemapSelection {
  readonly schemaVersion: 1
  readonly basemap: BasemapSource
  readonly labels: BasemapSource | null
}

/** A bounded page from the host-owned source catalog. */
export interface BasemapCatalogPage {
  readonly schemaVersion: 1
  readonly catalogVersion: string
  readonly canChange: boolean
  readonly context: {
    readonly provider: SourceProvider | null
    readonly at: { readonly lon: number; readonly lat: number } | null
    readonly zoom: number | null
  }
  readonly sources: readonly BasemapSource[]
  readonly nextCursor: string | null
}

/** Safe parser and selection refusal codes. */
export type SourceFailureCode =
  | 'SOURCE_VERSION_UNSUPPORTED'
  | 'SOURCE_RESOURCE_DENIED'
  | 'SOURCE_COMBINATION_UNSUPPORTED'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_READ_ONLY'

/** Discriminated result for untrusted source or selection data. */
export type SourceParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SourceFailureCode }

const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const digestPattern = /^[a-f0-9]{64}$/
const providers: readonly SourceProvider[] = ['esri', 'osm', 'tianditu', 'amap', 'custom']
const roles: readonly SourceRole[] = ['basemap', 'labels']
const adapters: readonly SourceAdapter[] = ['arcgis-mapserver', 'xyz', 'wmts']
const modes: readonly SourceMode[] = ['map', 'scene']
const permissions: readonly SourcePermission[] = ['allowed', 'denied', 'unverified']
const sourceKeys = [
  'schemaVersion', 'id', 'title', 'provider', 'role', 'adapter', 'configDigest', 'nativeWkid',
  'supportsDynamicExport', 'supportedModes', 'minZoom', 'maxZoom', 'compatibleBasemapIds',
  'attribution', 'release', 'screenshot', 'automatedMapUse', 'availability',
  'tileAdjustment',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value)
}

function isBoundedString(value: unknown, maximum: number, nonempty = true): value is string {
  return typeof value === 'string' && (nonempty ? value.length > 0 : true)
    && value.length <= maximum && new TextEncoder().encode(value).length <= maximum * 4
    // oxlint-disable-next-line no-control-regex -- Public source text must reject control bytes.
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Validate a nullable calendar date or UTC timestamp without local-time normalization.
 * @param value - untrusted release or acquisition date.
 * @returns whether the value is null or a valid calendar date/UTC timestamp.
 */
export function isValidSourceDate(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string') return false
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  const match = dateOnly ?? timestamp
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (timestamp !== null) {
    const hour = Number(timestamp[4])
    const minute = Number(timestamp[5])
    const second = Number(timestamp[6])
    if (hour > 23 || minute > 59 || second > 59) return false
  }
  const date = new Date(value)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function sourceFailure<T>(code: SourceFailureCode): SourceParseResult<T> {
  return { ok: false, code }
}

function parseSource(value: unknown): SourceParseResult<BasemapSource> {
  if (!isRecord(value)) return sourceFailure('SOURCE_RESOURCE_DENIED')
  if (!Object.hasOwn(value, 'schemaVersion')) return sourceFailure('SOURCE_RESOURCE_DENIED')
  if (value.schemaVersion !== 1) return sourceFailure('SOURCE_VERSION_UNSUPPORTED')
  if (!hasOnlyKeys(value, sourceKeys)) return sourceFailure('SOURCE_RESOURCE_DENIED')
  const availability = value.availability
  if (!isRecord(availability)
    || (availability.kind === 'configured' && !hasOnlyKeys(availability, ['kind']))
    || (availability.kind === 'unavailable' && (!hasOnlyKeys(availability, ['kind', 'reason'])
      || (availability.reason !== 'missing-credential' && availability.reason !== 'disabled')))
    || (availability.kind !== 'configured' && availability.kind !== 'unavailable')) {
    return sourceFailure('SOURCE_RESOURCE_DENIED')
  }
  const release = value.release
  if (!isRecord(release) || !hasOnlyKeys(release, ['version', 'publishedAt', 'acquiredAt'])
    || !(release.version === null || isBoundedString(release.version, 96))
    || !isValidSourceDate(release.publishedAt) || (typeof release.publishedAt === 'string' && release.publishedAt.length > 96)
    || !isValidSourceDate(release.acquiredAt) || (typeof release.acquiredAt === 'string' && release.acquiredAt.length > 96)) {
    return sourceFailure('SOURCE_RESOURCE_DENIED')
  }
  const tileAdjustment = value.tileAdjustment ?? null
  if (tileAdjustment !== null
    && (!isRecord(tileAdjustment) || !hasOnlyKeys(tileAdjustment, ['kind', 'version'])
      || tileAdjustment.kind !== 'gcj02' || tileAdjustment.version !== 1)) {
    return sourceFailure('SOURCE_RESOURCE_DENIED')
  }
  if (!isSourceId(value.id)
    || !isBoundedString(value.title, 96)
    || !providers.includes(value.provider as SourceProvider)
    || !roles.includes(value.role as SourceRole)
    || !adapters.includes(value.adapter as SourceAdapter)
    || (value.supportsDynamicExport === true && value.adapter !== 'arcgis-mapserver')
    || typeof value.configDigest !== 'string' || !digestPattern.test(value.configDigest)
    || !Number.isSafeInteger(value.nativeWkid) || (value.nativeWkid as number) <= 0
    || typeof value.supportsDynamicExport !== 'boolean'
    || !Array.isArray(value.supportedModes) || value.supportedModes.length < 1 || value.supportedModes.length > 2
    || value.supportedModes.some(mode => !modes.includes(mode as SourceMode))
    || new Set(value.supportedModes).size !== value.supportedModes.length
    || typeof value.minZoom !== 'number' || !Number.isFinite(value.minZoom)
    || typeof value.maxZoom !== 'number' || !Number.isFinite(value.maxZoom)
    || value.minZoom < 0 || value.maxZoom > 30 || value.minZoom > value.maxZoom
    || !Array.isArray(value.compatibleBasemapIds) || value.compatibleBasemapIds.length > 64
    || value.compatibleBasemapIds.some(id => !isSourceId(id))
    || new Set(value.compatibleBasemapIds).size !== value.compatibleBasemapIds.length
    || !isBoundedString(value.attribution, 1024)
    || !permissions.includes(value.screenshot as SourcePermission)
    || !permissions.includes(value.automatedMapUse as SourcePermission)) {
    return sourceFailure('SOURCE_RESOURCE_DENIED')
  }
  const compatibleBasemapIds = (value.compatibleBasemapIds as string[]).map(BasemapSourceId)
  if ((value.role === 'basemap' && compatibleBasemapIds.length !== 0)
    || (value.role === 'labels' && compatibleBasemapIds.length === 0)) {
    return sourceFailure('SOURCE_RESOURCE_DENIED')
  }
  const parsed: BasemapSource = {
    schemaVersion: 1,
    id: BasemapSourceId(value.id),
    title: value.title,
    provider: value.provider as SourceProvider,
    role: value.role as SourceRole,
    adapter: value.adapter as SourceAdapter,
    configDigest: value.configDigest,
    nativeWkid: value.nativeWkid as number,
    supportsDynamicExport: value.supportsDynamicExport,
    supportedModes: [...value.supportedModes] as SourceMode[],
    minZoom: value.minZoom as number,
    maxZoom: value.maxZoom as number,
    compatibleBasemapIds,
    attribution: value.attribution,
    release: {
      version: release.version as string | null,
      publishedAt: release.publishedAt as string | null,
      acquiredAt: release.acquiredAt as string | null,
    },
    screenshot: value.screenshot as SourcePermission,
    automatedMapUse: value.automatedMapUse as SourcePermission,
    availability: availability.kind === 'configured'
      ? { kind: 'configured' }
      : { kind: 'unavailable', reason: availability.reason as 'missing-credential' | 'disabled' },
    tileAdjustment: tileAdjustment as { readonly kind: 'gcj02'; readonly version: 1 } | null,
  }
  return { ok: true, value: parsed }
}

/**
 * Parse a strict public source descriptor without preserving input objects.
 * @param value - untrusted configuration, wire or durable source record.
 * @returns a cloned descriptor or a fixed refusal code; unexpected faults propagate.
 */
export function parseBasemapSource(value: unknown): SourceParseResult<BasemapSource> {
  return parseSource(value)
}

/**
 * Parse a strict public source selection.
 * @param value - untrusted complete selection, including an explicit labels value.
 * @returns a cloned compatible selection or a fixed refusal code.
 */
export function parseBasemapSelection(value: unknown): SourceParseResult<BasemapSelection> {
  if (!isRecord(value)) return sourceFailure('SOURCE_RESOURCE_DENIED')
  if (!Object.hasOwn(value, 'schemaVersion')) return sourceFailure('SOURCE_RESOURCE_DENIED')
  if (value.schemaVersion !== 1) return sourceFailure('SOURCE_VERSION_UNSUPPORTED')
  if (!hasOnlyKeys(value, ['schemaVersion', 'basemap', 'labels'])) return sourceFailure('SOURCE_RESOURCE_DENIED')
  const basemap = parseSource(value.basemap)
  if (!basemap.ok) return basemap
  let labels: BasemapSource | null = null
  if (value.labels !== null) {
    const parsedLabels = parseSource(value.labels)
    if (!parsedLabels.ok) return parsedLabels
    labels = parsedLabels.value
  }
  return createBasemapSelection(basemap.value, labels)
}

/**
 * Build a selection from statically validated source records.
 * @param basemap - the base source; the factory never mutates either source.
 * @param labels - compatible reference labels, or null to turn them off.
 * @returns the selection or a semantic role, availability or compatibility refusal.
 */
export function createBasemapSelection(
  basemap: BasemapSource,
  labels: BasemapSource | null,
): SourceParseResult<BasemapSelection> {
  if (!basemapPairCompatible(basemap, labels)) {
    return sourceFailure('SOURCE_COMBINATION_UNSUPPORTED')
  }
  if (basemap.availability.kind === 'unavailable') {
    return sourceFailure(basemap.availability.reason === 'missing-credential' ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_UNAVAILABLE')
  }
  if (labels?.availability.kind === 'unavailable') {
    return sourceFailure(labels.availability.reason === 'missing-credential' ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_UNAVAILABLE')
  }
  return { ok: true, value: { schemaVersion: 1, basemap, labels } }
}

/**
 * Normalize the known Web Mercator service aliases without changing other CRSs.
 * @param wkid - validated native or engine WKID.
 * @returns equivalent canonical WKID, independent of application default-engine policy.
 */
export function canonicalSourceWkid(wkid: number): number {
  return wkid === 102100 || wkid === 102113 || wkid === 900913 ? 3857 : wkid
}

/**
 * Check a basemap/labels pair without consulting permissions or availability.
 * @param basemap - statically validated base candidate.
 * @param labels - reference-label candidate, or null.
 * @returns whether declared roles, references and render capabilities intersect.
 */
export function basemapPairCompatible(basemap: BasemapSource, labels: BasemapSource | null): boolean {
  if (basemap.role !== 'basemap') return false
  if (labels === null) return true
  if (labels.role !== 'labels' || !labels.compatibleBasemapIds.includes(basemap.id)) return false
  if (!basemap.supportedModes.some(mode => labels.supportedModes.includes(mode))) return false
  if (Math.max(basemap.minZoom, labels.minZoom) > Math.min(basemap.maxZoom, labels.maxZoom)) return false
  const sameNativeWkid = canonicalSourceWkid(basemap.nativeWkid) === canonicalSourceWkid(labels.nativeWkid)
  const dynamicSide = (basemap.adapter === 'arcgis-mapserver' && basemap.supportsDynamicExport)
    || (labels.adapter === 'arcgis-mapserver' && labels.supportsDynamicExport)
  return sameNativeWkid || dynamicSide
}

/**
 * Test source compatibility against a caller-normalized view descriptor.
 * @param source - statically validated source and its declared capabilities.
 * @param view - actual engine WKID and application zoom, never a raw WMTS matrix id.
 * @returns whether availability, mode, zoom and projection admit this view.
 */
export function sourceCompatibleWithView(
  source: BasemapSource,
  view: { readonly mode: SourceMode; readonly wkid: number; readonly zoom: number | null },
): boolean {
  if (source.availability.kind !== 'configured'
    || !source.supportedModes.includes(view.mode)
    || !Number.isSafeInteger(view.wkid) || view.wkid <= 0
    || view.zoom === null || !Number.isFinite(view.zoom)
    || view.zoom < source.minZoom || view.zoom > source.maxZoom) return false
  const native = canonicalSourceWkid(source.nativeWkid)
  const display = canonicalSourceWkid(view.wkid)
  return native === display
    || (source.adapter === 'arcgis-mapserver' && source.supportsDynamicExport && view.wkid > 0)
}
