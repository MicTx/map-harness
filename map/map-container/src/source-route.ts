/**
 * Session-bound, exact-path HTTP handlers for the controlled map sources.
 * @module @map-harness/map-container/source-route
 */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  BasemapSourceId,
  canonicalSourceWkid,
  createBasemapSelection,
  parseBasemapSelection,
  parseBasemapSource,
  type BasemapCatalogPage,
  type BasemapSelection,
  type BasemapSource,
  type SourceProvider,
} from '@map-harness/map-layers'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session/types'
import { SourceCatalogError, type SourceCatalogFailureCode } from './source-error.ts'
import { canonicalMapSource, resolveMapSourceSelection } from './sources.ts'
import { createSdkWmtsMetadata } from './source-wmts.ts'
import type { MapSourceService } from './source-service-protocol.ts'
import {
  MAP_SOURCE_CATALOG_ROUTE,
  MAP_SOURCE_RENDER_ROUTE,
  MAP_SOURCE_RESOURCE_ROUTE,
  MAX_SOURCE_CONDITIONAL_HEADER_CHARS,
  MAX_SOURCE_ROUTE_QUERY_BYTES,
  NativeSourceEpoch,
  SourceRuntimeEpoch,
  parseMapSourceRenderDescriptor,
  type MapSourceRenderDescriptor,
  type NativeSourceEpoch as NativeSourceEpochType,
  type SourceLayerKind,
  type SourceRuntimeEpoch as SourceRuntimeEpochType,
} from './source-render-protocol.ts'
import type { MapViewRecord } from './registry.ts'
import type { ImageryDisplayState } from './protocol.ts'
import { viewEngineKey } from './view-policy.ts'
import { waybackReleaseOf } from './wayback.ts'

/** Same-origin read-only Wayback catalog and point evidence route. */
export const MAP_WAYBACK_ROUTE = '/api/map/wayback'

/** The current session facts needed to authorize one source render/resource. */
export interface SourceSessionState {
  readonly basemap: BasemapSelection | null
  readonly imageryDisplay: ImageryDisplayState
  readonly mode: 'map' | 'scene'
  readonly view: MapViewRecord
}

/** Supported, non-activating authority seam used by the future production adaptor. */
export type SourceStateReader = (
  sessionId: SessionIdType,
  signal: AbortSignal,
) => Promise<SourceSessionState | null>

/** Exact-route closure returned to a Host Connection or focused test. */
export interface MapSourceRoutes {
  fetch(request: Request): Promise<Response>
  dispose(): void
}

interface RouteOperation {
  readonly controller: AbortController
}

const encoder = new TextEncoder()
const sessionIdPattern = /^[A-Za-z0-9._:-]+$/
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const providers: readonly SourceProvider[] = ['esri', 'osm', 'tianditu', 'amap', 'custom']
const resourceIdentityKeys = [
  'sessionId', 'role', 'sourceId', 'configDigest', 'runtimeEpoch', 'nativeEpoch', 'viewMode', 'viewWkid',
] as const

function denied(code: SourceCatalogFailureCode = 'SOURCE_RESOURCE_DENIED'): never {
  throw new SourceCatalogError(code)
}

function parseSessionId(value: string | null): SessionIdType {
  if (value === null || value.length === 0 || value.length > 128 || !sessionIdPattern.test(value)) denied()
  return SessionId(value)
}

function parseSourceId(value: string): string {
  try {
    return BasemapSourceId(value)
  } catch (error) {
    if (error instanceof TypeError) denied()
    throw error
  }
}

function parseRuntimeEpoch(value: string): SourceRuntimeEpochType {
  try {
    return SourceRuntimeEpoch(value)
  } catch (error) {
    if (error instanceof TypeError) denied()
    throw error
  }
}

function parseNativeEpoch(value: string): NativeSourceEpochType {
  try {
    return NativeSourceEpoch(value)
  } catch (error) {
    if (error instanceof TypeError) denied()
    throw error
  }
}

function abortFailure(signal: AbortSignal): never {
  denied(signal.reason === 'deadline' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELLED')
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) abortFailure(signal)
}

function responseHeaders(headers: HeadersInit = []): Headers {
  const result = new Headers(headers)
  result.set('cache-control', 'no-store')
  return result
}

function failure(error: SourceCatalogError): Response {
  const status: Record<SourceCatalogFailureCode, number> = {
    SOURCE_VERSION_UNSUPPORTED: 409,
    SOURCE_RESOURCE_DENIED: 403,
    SOURCE_COMBINATION_UNSUPPORTED: 400,
    SOURCE_NOT_CONFIGURED: 503,
    SOURCE_UNAVAILABLE: 502,
    SOURCE_NOT_FOUND: 404,
    SOURCE_LIMIT_EXCEEDED: 413,
    SOURCE_READ_ONLY: 403,
    SOURCE_CONFIG_INVALID: 500,
    SOURCE_CHANGED: 409,
    SOURCE_CREDENTIAL_REJECTED: 502,
    SOURCE_TIMEOUT: 504,
    SOURCE_CANCELLED: 499,
    SOURCE_POLICY_DENIED: 403,
  }
  return Response.json({ ok: false, code: error.code }, {
    status: status[error.code],
    headers: responseHeaders(),
  })
}

function queryMap(url: URL): Map<string, string> {
  if (encoder.encode(url.search).length > MAX_SOURCE_ROUTE_QUERY_BYTES) denied('SOURCE_LIMIT_EXCEEDED')
  const result = new Map<string, string>()
  const names = new Set<string>()
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase()
    if (names.has(lower)) denied()
    names.add(lower)
    result.set(key, value)
  }
  return result
}

function onlyKeys(query: ReadonlyMap<string, string>, names: readonly string[]): void {
  const exact = new Set(names)
  const lower = new Set(names.map(name => name.toLowerCase()))
  if (query.size !== names.length) denied()
  for (const key of query.keys()) {
    if (!exact.has(key) || !lower.has(key.toLowerCase())) denied()
  }
}

function allowsOnlyKeys(query: ReadonlyMap<string, string>, names: readonly string[]): void {
  const exact = new Set(names)
  if (query.size > names.length) denied()
  for (const key of query.keys()) {
    if (!exact.has(key)) denied()
  }
}

function decimal(value: string | undefined): number {
  if (value === undefined || !decimalPattern.test(value)) denied()
  const result = Number(value)
  if (!Number.isFinite(result)) denied()
  return result
}

function isProvider(value: string): value is SourceProvider {
  return providers.some(provider => provider === value)
}

function stateSelection(state: SourceSessionState, service: MapSourceService): BasemapSelection {
  return resolveMapSourceSelection(service.catalog, state.basemap)
}

function sameScope(
  state: SourceSessionState | null,
  expected: BasemapSelection,
  expectedDisplay: ImageryDisplayState,
  mode: 'map' | 'scene',
  engineWkid: number,
  service: MapSourceService,
): boolean {
  if (state === null || state.mode !== mode || viewEngineKey(state.view.wkid) !== engineWkid) return false
  const selection = stateSelection(state, service)
  return isDeepStrictEqual(selection, expected) && isDeepStrictEqual(state.imageryDisplay, expectedDisplay)
}

async function readScope(
  sessionId: SessionIdType,
  signal: AbortSignal,
  reader: SourceStateReader,
  service: MapSourceService,
  expected: BasemapSelection,
  expectedDisplay: ImageryDisplayState,
  mode: 'map' | 'scene',
  engineWkid: number,
): Promise<void> {
  ensureActive(signal)
  const state = await reader(sessionId, signal)
  ensureActive(signal)
  if (!sameScope(state, expected, expectedDisplay, mode, engineWkid, service)) denied('SOURCE_CHANGED')
}

function identityHref(
  sessionId: SessionIdType,
  role: 'basemap' | 'labels' | 'imagery-overlay',
  source: BasemapSource,
  runtimeEpoch: SourceRuntimeEpochType,
  nativeEpoch: NativeSourceEpochType,
  mode: 'map' | 'scene',
  engineWkid: number,
  wmtsMetadata = false,
): string {
  const query = new URLSearchParams({
    sessionId,
    role,
    sourceId: source.id,
    configDigest: source.configDigest,
    runtimeEpoch,
    nativeEpoch,
    viewMode: mode,
    viewWkid: String(engineWkid),
    ...(wmtsMetadata ? { resource: 'wmts' } : {}),
  })
  return `${MAP_SOURCE_RESOURCE_ROUTE}?${query.toString()}`
}

function controlledLayer(
  sessionId: SessionIdType,
  role: 'basemap' | 'labels' | 'imagery-overlay',
  runtimeEpoch: SourceRuntimeEpochType,
  nativeEpoch: NativeSourceEpochType,
  mode: 'map' | 'scene',
  engineWkid: number,
  source: BasemapSource,
  supportsExport: boolean,
  hasTileInfo: boolean,
): {
  readonly layerKind: SourceLayerKind
  readonly resourceHref: string
} {
  const canonicalEngine = canonicalSourceWkid(engineWkid)
  if (source.adapter === 'xyz' && canonicalSourceWkid(source.nativeWkid) === canonicalEngine) {
    return {
      layerKind: 'web-tile',
      resourceHref: identityHref(sessionId, role, source, runtimeEpoch, nativeEpoch, mode, engineWkid),
    }
  }
  if (source.adapter === 'wmts' && canonicalSourceWkid(source.nativeWkid) === canonicalEngine) {
    return {
      layerKind: 'wmts',
      resourceHref: identityHref(sessionId, role, source, runtimeEpoch, nativeEpoch, mode, engineWkid, true),
    }
  }
  if (source.adapter === 'arcgis-mapserver') {
    if (hasTileInfo && canonicalSourceWkid(source.nativeWkid) === canonicalEngine) {
      return {
        layerKind: 'arcgis-tile',
        resourceHref: identityHref(sessionId, role, source, runtimeEpoch, nativeEpoch, mode, engineWkid),
      }
    }
    if (source.supportsDynamicExport && supportsExport) {
      return {
        layerKind: 'arcgis-map-image',
        resourceHref: identityHref(sessionId, role, source, runtimeEpoch, nativeEpoch, mode, engineWkid),
      }
    }
  }
  denied('SOURCE_COMBINATION_UNSUPPORTED')
}

async function renderLayer(
  sessionId: SessionIdType,
  role: 'basemap' | 'labels' | 'imagery-overlay',
  source: BasemapSource,
  mode: 'map' | 'scene',
  engineWkid: number,
  service: MapSourceService,
  signal: AbortSignal,
): Promise<MapSourceRenderDescriptor['basemap']> {
  if (!source.supportedModes.includes(mode)) denied('SOURCE_COMBINATION_UNSUPPORTED')
  const binding = await service.prepare(source, signal)
  service.verifySource(source)
  ensureActive(signal)
  if (binding.source.id !== source.id || binding.runtimeEpoch !== service.runtimeEpoch) denied('SOURCE_CHANGED')
  if (!isDeepStrictEqual(binding.source, canonicalMapSource(service.catalog, source))) denied('SOURCE_CHANGED')
  if (binding.transport === 'public-preset') {
    let kind: SourceLayerKind | undefined = source.adapter === 'xyz'
      ? 'web-tile'
      : canonicalSourceWkid(source.nativeWkid) === canonicalSourceWkid(engineWkid)
        ? 'arcgis-tile'
        : source.supportsDynamicExport
          ? 'arcgis-map-image'
          : undefined
    if (kind === undefined) denied('SOURCE_COMBINATION_UNSUPPORTED')
    return Object.freeze({
      source: binding.source,
      nativeEpoch: binding.nativeEpoch,
      layerKind: kind,
      transport: 'public-preset',
      presetId: binding.presetId,
    })
  }
  const native = binding.native
  const recipe = controlledLayer(
    sessionId,
    role,
    service.runtimeEpoch,
    binding.nativeEpoch,
    mode,
    engineWkid,
    source,
    native.adapter === 'arcgis-mapserver' && native.metadata.supportsExport,
    native.adapter === 'arcgis-mapserver' && native.metadata.service.tileInfo !== undefined,
  )
  return Object.freeze({
    source: binding.source,
    nativeEpoch: binding.nativeEpoch,
    layerKind: recipe.layerKind,
    transport: 'controlled',
    resourceHref: recipe.resourceHref,
  })
}

async function serveCatalog(
  request: Request,
  reader: SourceStateReader,
  service: MapSourceService,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(request.url)
  const query = queryMap(url)
  allowsOnlyKeys(query, ['sessionId', 'provider', 'lon', 'lat', 'zoom', 'cursor', 'pageSize'])
  const sessionId = parseSessionId(query.get('sessionId') ?? denied())
  const provider = query.get('provider') ?? null
  if (provider !== null && !isProvider(provider)) denied()
  const location = query.has('lon') || query.has('lat') || query.has('zoom')
  if (location !== (query.has('lon') && query.has('lat') && query.has('zoom'))) denied()
  const cursor = query.get('cursor') ?? null
  if (cursor !== null && cursor.length === 0) denied()
  const pageSizeValue = query.get('pageSize')
  const pageSize = pageSizeValue === undefined ? undefined : Number(pageSizeValue)
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize <= 0)) denied('SOURCE_LIMIT_EXCEEDED')
  ensureActive(signal)
  const state = await reader(sessionId, signal)
  ensureActive(signal)
  if (state === null) denied('SOURCE_NOT_FOUND')
  const page: BasemapCatalogPage = service.catalog.list({
    ...(provider === null ? {} : { provider }),
    ...(cursor === null ? {} : { cursor }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(location ? {
      at: Object.freeze({
        lon: decimal(query.get('lon')),
        lat: decimal(query.get('lat')),
      }),
      zoom: decimal(query.get('zoom')),
    } : {}),
  })
  return Response.json(page, { headers: responseHeaders() })
}

async function serveRender(
  request: Request,
  reader: SourceStateReader,
  service: MapSourceService,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(request.url)
  const query = queryMap(url)
  onlyKeys(query, ['sessionId'])
  const sessionId = parseSessionId(query.get('sessionId') ?? denied())
  ensureActive(signal)
  const state = await reader(sessionId, signal)
  ensureActive(signal)
  if (state === null) denied('SOURCE_NOT_FOUND')
  const mode = state.mode
  const engineWkid = viewEngineKey(state.view.wkid)
  const expected = stateSelection(state, service)
  if (expected.labels !== null) service.verifySource(expected.labels)
  if (state.imageryDisplay.earlySource !== null) service.verifySource(state.imageryDisplay.earlySource)
  const selection = createBasemapSelection(expected.basemap, expected.labels)
  if (!selection.ok) denied(selection.code)

  const basemap = await renderLayer(sessionId, 'basemap', expected.basemap, mode, engineWkid, service, signal)
  await readScope(sessionId, signal, reader, service, expected, state.imageryDisplay, mode, engineWkid)
  let labels: MapSourceRenderDescriptor['labels'] = null
  if (expected.labels !== null) {
    labels = await renderLayer(sessionId, 'labels', expected.labels, mode, engineWkid, service, signal)
    await readScope(sessionId, signal, reader, service, expected, state.imageryDisplay, mode, engineWkid)
  }
  let earlyImagery: MapSourceRenderDescriptor['earlyImagery'] = null
  if (state.imageryDisplay.earlySource !== null) {
    earlyImagery = await renderLayer(sessionId, 'imagery-overlay', state.imageryDisplay.earlySource, mode, engineWkid, service, signal)
    await readScope(sessionId, signal, reader, service, expected, state.imageryDisplay, mode, engineWkid)
  }

  const descriptorValue = Object.freeze({
    schemaVersion: 1,
    sessionId,
    runtimeEpoch: service.runtimeEpoch,
    mode,
    engineWkid,
    basemap,
    labels,
    earlyImagery,
    display: {
      labelsVisible: state.imageryDisplay.labelsVisible,
      recentVisible: state.imageryDisplay.recentVisible,
      recentOpacity: state.imageryDisplay.recentOpacity,
      earlyVisible: state.imageryDisplay.earlyVisible,
    },
  })
  const encoded = JSON.stringify(descriptorValue)
  if (encoder.encode(encoded).length > 65_536) denied('SOURCE_LIMIT_EXCEEDED')
  const descriptor = parseMapSourceRenderDescriptor(JSON.parse(encoded))
  if (!descriptor.ok) denied(descriptor.code)
  return Response.json(descriptor.value, { headers: responseHeaders() })
}

async function serveWayback(
  request: Request,
  reader: SourceStateReader,
  service: MapSourceService,
  signal: AbortSignal,
): Promise<Response> {
  const raw = queryMap(new URL(request.url))
  const query = new Map<string, string>()
  const allowedNames = new Set(['sessionid', 'operation', 'lon', 'lat', 'zoom', 'cursor', 'pagesize', 'releaseid', 'minx', 'miny', 'maxx', 'maxy', 'wkid'])
  for (const key of raw.keys()) if (!allowedNames.has(key.toLowerCase())) denied()
  for (const name of ['sessionId', 'operation', 'lon', 'lat', 'zoom', 'cursor', 'pageSize', 'releaseId', 'minX', 'minY', 'maxX', 'maxY', 'wkid']) {
    const key = [...raw.keys()].find(candidate => candidate.toLowerCase() === name.toLowerCase())
    if (key !== undefined) query.set(name, raw.get(key)!)
  }
  allowsOnlyKeys(query, ['sessionId', 'operation', 'lon', 'lat', 'zoom', 'cursor', 'pageSize', 'releaseId', 'minX', 'minY', 'maxX', 'maxY', 'wkid'])
  const sessionId = parseSessionId(query.get('sessionId') ?? denied())
  ensureActive(signal)
  const state = await reader(sessionId, signal)
  ensureActive(signal)
  if (state === null) denied('SOURCE_NOT_FOUND')
  const operation = query.get('operation') ?? 'catalog'
  if (operation === 'catalog') {
    allowsOnlyKeys(query, ['sessionId', 'operation', 'cursor', 'pageSize'])
    const cursor = query.get('cursor') ?? undefined
    const size = query.get('pageSize')
    return Response.json(await service.waybackCatalog({
      ...(cursor === undefined ? {} : { cursor }),
      ...(size === undefined ? {} : { pageSize: Number(size) }),
    }, signal), { headers: responseHeaders() })
  }
  const lon = decimal(query.get('lon'))
  const lat = decimal(query.get('lat'))
  const zoom = decimal(query.get('zoom'))
  if (operation === 'local') {
    onlyKeys(query, ['sessionId', 'operation', 'lon', 'lat', 'zoom'])
    return Response.json(await service.waybackLocal({ lon, lat }, zoom, signal), { headers: responseHeaders() })
  }
  if (operation === 'metadata') {
    onlyKeys(query, ['sessionId', 'operation', 'lon', 'lat', 'zoom', 'releaseId'])
    const releaseId = Number(query.get('releaseId'))
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0) denied()
    return Response.json(await service.waybackMetadata({ lon, lat }, zoom, releaseId, signal), { headers: responseHeaders() })
  }
  if (operation === 'coverage') {
    onlyKeys(query, ['sessionId', 'operation', 'lon', 'lat', 'zoom', 'releaseId', 'minX', 'minY', 'maxX', 'maxY', 'wkid'])
    const releaseId = Number(query.get('releaseId'))
    const wkid = Number(query.get('wkid'))
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !Number.isSafeInteger(wkid) || wkid <= 0) denied()
    const viewport = {
      center: [lon, lat] as const,
      extent: [decimal(query.get('minX')), decimal(query.get('minY')), decimal(query.get('maxX')), decimal(query.get('maxY'))] as const,
      wkid,
    }
    return Response.json(await service.waybackCoverage(viewport, zoom, releaseId, signal), { headers: responseHeaders() })
  }
  denied()
}

interface AdmittedResource {
  readonly sessionId: SessionIdType
  readonly role: 'basemap' | 'labels' | 'imagery-overlay'
  readonly sourceId: string
  readonly configDigest: string
  readonly runtimeEpoch: SourceRuntimeEpochType
  readonly nativeEpoch: NativeSourceEpochType
  readonly mode: 'map' | 'scene'
  readonly engineWkid: number
  readonly operation: URLSearchParams
}

function parseResourceQuery(url: URL): AdmittedResource {
  const query = queryMap(url)
  const identity = new Map<string, string>()
  const lowerIdentity = new Map(resourceIdentityKeys.map(key => [key.toLowerCase(), key]))
  const operation = new URLSearchParams()
  for (const [key, value] of query) {
    const expected = lowerIdentity.get(key.toLowerCase())
    if (expected === undefined) {
      operation.append(key, value)
      continue
    }
    if (expected !== key || identity.has(expected)) denied()
    identity.set(expected, value)
  }
  if (identity.size !== resourceIdentityKeys.length) denied()
  const role = identity.get('role')
  const mode = identity.get('viewMode')
  const engineValue = identity.get('viewWkid')
  const engineWkid = Number(engineValue)
  if (role !== 'basemap' && role !== 'labels' && role !== 'imagery-overlay') denied()
  if (mode !== 'map' && mode !== 'scene') denied()
  if (engineValue === undefined || !Number.isSafeInteger(engineWkid) || engineWkid <= 0) denied()
  const sourceIdValue = identity.get('sourceId')
  const configDigest = identity.get('configDigest')
  const runtimeEpochValue = identity.get('runtimeEpoch')
  const nativeEpochValue = identity.get('nativeEpoch')
  if (sourceIdValue === undefined || configDigest === undefined || configDigest.length === 0
    || runtimeEpochValue === undefined || nativeEpochValue === undefined) denied()
  return {
    sessionId: parseSessionId(identity.get('sessionId') ?? denied()),
    role,
    sourceId: parseSourceId(sourceIdValue),
    configDigest,
    runtimeEpoch: parseRuntimeEpoch(runtimeEpochValue),
    nativeEpoch: parseNativeEpoch(nativeEpochValue),
    mode,
    engineWkid,
    operation,
  }
}

async function serveResource(
  request: Request,
  reader: SourceStateReader,
  service: MapSourceService,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(request.url)
  const conditional = request.headers.get('if-none-match')
  if (conditional !== null && conditional.length > MAX_SOURCE_CONDITIONAL_HEADER_CHARS) {
    denied('SOURCE_LIMIT_EXCEEDED')
  }
  const admitted = parseResourceQuery(url)
  if (admitted.runtimeEpoch !== service.runtimeEpoch) denied('SOURCE_CHANGED')
  ensureActive(signal)
  const state = await reader(admitted.sessionId, signal)
  ensureActive(signal)
  if (state === null) denied('SOURCE_NOT_FOUND')
  const mode = state.mode
  const engineWkid = viewEngineKey(state.view.wkid)
  if (mode !== admitted.mode || engineWkid !== admitted.engineWkid) denied('SOURCE_CHANGED')
  const selection = stateSelection(state, service)
  const selected = admitted.role === 'basemap' ? selection.basemap
    : admitted.role === 'labels' ? selection.labels
      : state.imageryDisplay.earlySource
  if (selected === null || selected.id !== admitted.sourceId || selected.configDigest !== admitted.configDigest) {
    denied('SOURCE_CHANGED')
  }
  service.verifySource(selected)
  const result = await service.resource(
    selected,
    admitted.nativeEpoch,
    { wkid: engineWkid },
    admitted.operation,
    signal,
  )
  await readScope(admitted.sessionId, signal, reader, service, selection, state.imageryDisplay, mode, engineWkid)
  if (result.kind === 'image') {
    const headers = new Headers({
      'content-type': result.contentType,
      'content-length': String(result.body.byteLength),
      etag: result.etag,
      'cache-control': result.cacheControl,
      'x-content-type-options': 'nosniff',
    })
    if (conditional !== null && etagMatches(conditional, result.etag)) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(new Uint8Array(result.body), { headers })
  }
  if (result.kind === 'arcgis-metadata') {
    const body = JSON.stringify(result.metadata)
    if (encoder.encode(body).length > service.catalog.networkConfig.maxMetadataBytes) {
      denied('SOURCE_LIMIT_EXCEEDED')
    }
    return new Response(body, {
      headers: responseHeaders([
        ['content-type', 'application/json;charset=utf-8'],
        ['x-content-type-options', 'nosniff'],
      ]),
    })
  }
  const metadataHref = identityHref(
    admitted.sessionId,
    admitted.role,
    selected,
    service.runtimeEpoch,
    admitted.nativeEpoch,
    mode,
    engineWkid,
    true,
  )
  const body = createSdkWmtsMetadata(selected, result.metadata, new URL(metadataHref, url).href)
  if (encoder.encode(body).length > service.catalog.networkConfig.maxMetadataBytes) {
    denied('SOURCE_LIMIT_EXCEEDED')
  }
  return new Response(body, {
    headers: responseHeaders([
      ['content-type', 'application/xml;charset=utf-8'],
      ['x-content-type-options', 'nosniff'],
    ]),
  })
}

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const value = ifNoneMatch.trim()
  if (value === '*') return true
  return value.split(',').some(candidate => {
    const trimmed = candidate.trim()
    const normalized = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed
    return normalized === etag
  })
}

/** Minimal non-activating session projection reader face. */
interface SessionProjectionController {
  projections(
    request: { readonly sessionId: SessionIdType },
    signal: AbortSignal,
  ): Promise<{
    readonly kind: 'sequenced' | 'migration-required'
    readonly values?: Readonly<Record<string, unknown>>
  } | null>
}

/** Minimal Connection exact Fetch route registry. */
interface ConnectionFetchSurface {
  readonly fetch?: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['GET']
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

async function readProductionSourceState(
  controller: SessionProjectionController,
  sessionId: SessionIdType,
  signal: AbortSignal,
): Promise<SourceSessionState | null> {
  const projection = await controller.projections({ sessionId }, signal)
  if (projection === null || projection.kind !== 'sequenced') return null
  const value = projection.values?.mapContainer
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  const record = value as {
    readonly basemap?: unknown
    readonly imageryDisplay?: unknown
    readonly mode?: unknown
    readonly view?: unknown
  }
  if (record.mode !== 'map' && record.mode !== 'scene') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  if (typeof record.view !== 'object' || record.view === null || Array.isArray(record.view)) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  const view = record.view as { readonly center?: unknown; readonly zoom?: unknown; readonly wkid?: unknown }
  if (!Array.isArray(view.center) || view.center.length !== 2
    || typeof view.center[0] !== 'number' || typeof view.center[1] !== 'number'
    || typeof view.zoom !== 'number' || typeof view.wkid !== 'number') {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  let basemap: BasemapSelection | null = null
  if (record.basemap !== null) {
    const parsed = parseBasemapSelection(record.basemap)
    if (!parsed.ok) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    basemap = parsed.value
  }
  let imageryDisplay: ImageryDisplayState = {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 1,
    earlyVisible: false,
    earlySource: null,
  }
  if (record.imageryDisplay !== undefined) {
    if (typeof record.imageryDisplay !== 'object' || record.imageryDisplay === null || Array.isArray(record.imageryDisplay)) {
      throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
    const display = record.imageryDisplay as Record<string, unknown>
    const earlySource = display.earlySource
    if (Object.keys(display).length !== 5
      || typeof display.labelsVisible !== 'boolean'
      || typeof display.recentVisible !== 'boolean'
      || typeof display.recentOpacity !== 'number'
      || !Number.isFinite(display.recentOpacity)
      || display.recentOpacity < 0 || display.recentOpacity > 1
      || typeof display.earlyVisible !== 'boolean') {
      throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
    let parsedEarly: BasemapSource | null = null
    if (earlySource !== null) {
      const parsed = parseBasemapSource(earlySource)
      if (!parsed.ok || waybackReleaseOf(parsed.value) === null) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      parsedEarly = parsed.value
    }
    if (display.earlyVisible && parsedEarly === null) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    imageryDisplay = {
      labelsVisible: display.labelsVisible,
      recentVisible: display.recentVisible,
      recentOpacity: display.recentOpacity,
      earlyVisible: display.earlyVisible,
      earlySource: parsedEarly,
    }
  }
  return {
    basemap,
    imageryDisplay,
    mode: record.mode,
    view: {
      center: [view.center[0], view.center[1]],
      zoom: view.zoom,
      wkid: view.wkid,
    },
  }
}

/**
 * Register the three production exact Fetch routes when Connection and SessionController are present.
 * @param ctx - host context owning optional late-mounted services.
 * @param service - process source service activation.
 * @returns combined async disposer, or undefined when a required service is absent.
 */
export function registerMapSourceRoutes(
  ctx: Context,
  service: MapSourceService,
): (() => Promise<void>) | undefined {
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  const controller = ctx.get('sessionController', false) as SessionProjectionController | undefined
  const fetchRegistry = connection?.fetch
  if (fetchRegistry === undefined || controller === undefined) return undefined
  const routes = createMapSourceRoutes(service, (sessionId, signal) =>
    readProductionSourceState(controller, sessionId, signal))
  const disposers = [
    MAP_SOURCE_CATALOG_ROUTE,
    MAP_SOURCE_RENDER_ROUTE,
    MAP_SOURCE_RESOURCE_ROUTE,
    MAP_WAYBACK_ROUTE,
  ].map(path => fetchRegistry.register({
    path,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => routes.fetch(request),
  }))
  return async () => {
    // Deregister synchronously so a service reload can register the same paths.
    const teardowns = disposers.reverse().map(dispose => dispose())
    routes.dispose()
    await Promise.all(teardowns)
  }
}

function promptAbort<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    void work.then(value => {
      signal.removeEventListener('abort', refuse)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', refuse)
      reject(error)
    })
    const refuse = (): void => {
      reject(new SourceCatalogError(signal.reason === 'deadline' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELLED'))
    }
    if (signal.aborted) {
      refuse()
      return
    }
    signal.addEventListener('abort', refuse, { once: true })
  })
}

/**
 * Create the three exact source routes around one shared source-service activation.
 * @param service - activation-owned native service; the routes never dispose it.
 * @param readState - authority-backed current session snapshot reader.
 * @returns route closure with its own bounded operation retention and lifecycle.
 */
export function createMapSourceRoutes(
  service: MapSourceService,
  readState: SourceStateReader,
): MapSourceRoutes {
  const active = new Set<RouteOperation>()
  const capacity = service.catalog.networkConfig.maxConcurrentRequests + service.catalog.networkConfig.maxQueuedRequests
  let disposed = false

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      if (disposed) return failure(new SourceCatalogError('SOURCE_CANCELLED'))
      const url = new URL(request.url)
      if (url.pathname !== MAP_SOURCE_CATALOG_ROUTE
        && url.pathname !== MAP_SOURCE_RENDER_ROUTE
        && url.pathname !== MAP_SOURCE_RESOURCE_ROUTE
        && url.pathname !== MAP_WAYBACK_ROUTE) {
        return Response.json({ ok: false, code: 'SOURCE_RESOURCE_DENIED' }, {
          status: 404,
          headers: responseHeaders(),
        })
      }
      if (request.method !== 'GET') {
        return Response.json({ ok: false, code: 'SOURCE_RESOURCE_DENIED' }, {
          status: 405,
          headers: responseHeaders([['allow', 'GET']]),
        })
      }
      const conditional = request.headers.get('if-none-match')
      if (conditional !== null && conditional.length > MAX_SOURCE_CONDITIONAL_HEADER_CHARS) {
        return failure(new SourceCatalogError('SOURCE_LIMIT_EXCEEDED'))
      }
      if (encoder.encode(url.search).length > MAX_SOURCE_ROUTE_QUERY_BYTES) {
        return failure(new SourceCatalogError('SOURCE_LIMIT_EXCEEDED'))
      }
      if (active.size >= capacity) return failure(new SourceCatalogError('SOURCE_LIMIT_EXCEEDED'))

      const operation: RouteOperation = { controller: new AbortController() }
      active.add(operation)
      const timer = setTimeout(
        () => operation.controller.abort('deadline'),
        url.pathname === MAP_WAYBACK_ROUTE ? service.waybackRequestTimeoutMs : service.catalog.networkConfig.requestTimeoutMs,
      )
      const onCallerAbort = (): void => operation.controller.abort('caller')
      request.signal.addEventListener('abort', onCallerAbort, { once: true })
      if (request.signal.aborted) onCallerAbort()
      const work = (async () => {
        try {
          ensureActive(operation.controller.signal)
          const handler = url.pathname === MAP_SOURCE_CATALOG_ROUTE ? serveCatalog
            : url.pathname === MAP_SOURCE_RENDER_ROUTE ? serveRender
              : url.pathname === MAP_WAYBACK_ROUTE ? serveWayback
                : serveResource
          return await handler(request, readState, service, operation.controller.signal)
        } finally {
          clearTimeout(timer)
          request.signal.removeEventListener('abort', onCallerAbort)
          active.delete(operation)
        }
      })()
      try {
        return await promptAbort(work, operation.controller.signal)
      } catch (error) {
        if (error instanceof SourceCatalogError) return failure(error)
        throw error
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const operation of [...active]) operation.controller.abort('dispose')
    },
  })
}
