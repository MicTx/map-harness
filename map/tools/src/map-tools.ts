/**
 * The model-facing map tools: container control (`map_add_layer`,
 * `map_set_view`, `map_set_mode`, `map_get_state`, `map_remove_layer`,
 * `map_fit_view`, `map_draw`, `map_locate`) over
 * the session's authoritative `mapContainer` projection, and spatial analysis
 * (`geo_buffer`, `geo_area`, `geo_intersect`, `geo_distance`) over WGS84 data
 * through Turf.
 *
 * Commit protocol (P0a): mutation handlers never write state. They resolve
 * the calling agent's session, read the accepted projection through the
 * host-plane `ctx.map` read face, validate the candidate change (capacity,
 * references, revision), and return model content plus one versioned
 * `map-change` meta record. The agent loop's accepted successful
 * `tool/result` carries that meta and the projection folds it — failed,
 * cancelled, unpaired, or replayed results change nothing. Every handler
 * requires its accepted `tool/call` in the session log and rejects nested
 * (non-native) dispatch.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type GeoJsonFeatureCollection,
  type MapContainerService,
  type MapLayerLegend,
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
  buildMapChangeMeta,
  layerDigestOf,
  stableDigestOf,
  validateMapChangeCandidate,
  viewEngineKey,
} from '@map-harness/map-container'
import { sourceCompatibleWithView, type BasemapSelection, type SourceProvider } from '@map-harness/map-layers'
import { MAX_REGISTER_BYTES, parseCatalogRef } from '@map-harness/spatial-catalog'
import { SPATIAL_SEARCH_SERVICE, type SpatialSearchService } from '@map-harness/spatial-connect'
import { catalogServiceOf } from './catalog-tools.ts'
import { assertDisplaySupported, buildDisplayCopy, displayDigestOf, legendForLayer } from './display.ts'
import { loadGeoJson } from './geo-source.ts'
import { SpatialError } from './spatial-errors.ts'
import { imagerySpecOf, type ImagerySpec } from '@map-harness/map-layers'
import { serviceOf } from './service-context.ts'
import { admitCameraChange, type SourceVerificationFace } from './basemap-admission.ts'
import { assertHeatmapAdmissible, modelSymbolOf } from './layer-tools.ts'
import { bboxOf, renderJson, round6, type LayerSummary } from './output.ts'

/**
 * Reach the projection read face from the tool's execution context.
 *
 * The service is a host-plane service: it lives on the boot tree, outside
 * every agent preset's realm, so the agent-scoped `ctx.map` proxy rejects
 * access ("without inject"). `ctx.get` reads the global store without the
 * inject requirement — the same pattern the host plane's own helpers use.
 */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new Error('map container service unavailable in this process')
  return map
}

/** Resolve the host source verification face used by camera admission. */
function sourceServiceOf(exec: ToolRunContext): SourceVerificationFace | undefined {
  return serviceOf<SourceVerificationFace>(exec, 'mapSourceService')
}

/** Catalog and native-materialization face owned by the map-container plugin. */
interface MapSourceServiceFace extends SourceVerificationFace {
  readonly catalog: {
    list(query?: {
      readonly provider?: SourceProvider
      readonly cursor?: string
      readonly pageSize?: number
      readonly at?: { readonly lon: number; readonly lat: number }
      readonly zoom?: number
    }): unknown
    selection(sourceId: string, labelSourceId?: string | null): { readonly ok: true; readonly value: BasemapSelection } | { readonly ok: false; readonly code: string }
  }
  prepare(source: import('@map-harness/map-layers').BasemapSource, signal?: AbortSignal): Promise<unknown>
  waybackRelease(releaseId: number, signal?: AbortSignal): Promise<import('@map-harness/map-layers').BasemapSource>
  waybackCatalog(query?: { readonly cursor?: string; readonly pageSize?: number }, signal?: AbortSignal): Promise<unknown>
  waybackLocal(point: { readonly lon: number; readonly lat: number }, zoom: number, signal?: AbortSignal): Promise<unknown>
}

function sourceFailure(error: unknown): never {
  const code = (error as { readonly code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('SOURCE_')) {
    throw new SpatialError(code as import('./spatial-errors.ts').SpatialErrorCode, 'the map source request was refused')
  }
  throw error
}

function requireSourceService(exec: ToolRunContext): MapSourceServiceFace {
  const service = serviceOf<MapSourceServiceFace>(exec, 'mapSourceService')
  if (service === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the map source service is unavailable in this process')
  }
  return service
}

/** The live session object a tool execution's agent owns (inferred; no extra package dep). */
type ToolSession = NonNullable<ToolRunContext['agent']>['session']

/** Resolve the calling agent's session; every map tool requires an agent caller. */
function sessionOf(exec: ToolRunContext): ToolSession {
  const session = exec.agent?.session
  if (session === undefined || typeof session.id !== 'string') {
    throw new Error('map tools require an agent session caller')
  }
  return session
}

/**
 * Resolve the accepted `tool/call` this execution pairs with. The agent loop
 * appends the call event before the body runs; without that pairing there is
 * no honest `sourceCallSeq` and the result could never fold, so direct
 * execution outside the loop fails loud instead of mutating anything.
 */
function requirePendingMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: ToolSession,
  name: 'map_add_layer' | 'map_remove_layer' | 'map_set_view' | 'map_set_mode' | 'map_draw' | 'map_fit_view' | 'map_set_basemap' | 'map_set_imagery',
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new Error('map tools support native model-direct calls only; nested dispatch cannot change the map')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new Error('map mutation requires its accepted tool/call in the session log before execution')
  }
  if (pending.name !== name) {
    throw new Error(`session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/**
 * Attach the model-designed symbol to a new layer, when one was given.
 * @param layer - the layer candidate.
 * @param rawSymbol - the raw `symbol` argument, or `undefined`.
 * @returns the layer, carrying the versioned symbol when one was given.
 */
function withModelSymbol(layer: MapProjectedLayer, rawSymbol: unknown): MapProjectedLayer {
  if (rawSymbol === undefined || rawSymbol === null) return layer
  const symbol = modelSymbolOf(rawSymbol, layer.id)
  assertHeatmapAdmissible(symbol, layer)
  return { ...layer, symbol }
}

/** The default layer id of one tile template (stable content digest of the normalized template). */
function stableTileTokenOf(urlTemplate: string): string {
  return stableDigestOf(urlTemplate).slice(0, 12)
}

/** Summarize one projected layer for tool output. */
function summarize(layer: MapProjectedLayer): LayerSummary & { opacity: number; group?: string } {
  return {
    id: layer.id,
    name: layer.name,
    featureCount: (layer.data as { features?: unknown[] })?.features?.length ?? 0,
    sourceCrs: layer.sourceCrs ?? 'EPSG:4326',
    visible: layer.visible,
    opacity: layer.opacity,
    ...(layer.group === undefined ? {} : { group: layer.group }),
  }
}

/**
 * `map_add_layer`: propose loading a layer into the session's container.
 * Inputs are strictly exclusive: a workspace `path` (legacy branch, unchanged
 * semantics), a catalog `ref` (an exact `res-…@vN`/`art-…@vN` whose bytes
 * the map adapter reads and digests), or a key-free HTTPS `tile_url` (the
 * imagery branch: an overlay tile layer with no feature data). All data
 * branches converge to WGS84 and are display-admitted before anything is
 * proposed.
 */
export const mapAddLayer = defineTool({
  name: 'map_add_layer',
  description:
    'Add a layer to the map container of the current session. '
    + 'Give EITHER `path` (a workspace GeoJSON file; WGS84 lon/lat by default, pass `crs` for projected data) '
    + 'OR `ref` (an exact catalog ref `res-…@vN` from catalog_register, or a published artifact ref `art-…@vN` '
    + 'from geo_buffer) OR `tile_url` (a key-free HTTPS XYZ tile template like https://tiles.example.org/{z}/{y}/{x}.png — an imagery overlay with no feature data) — never more than one. '
    + 'Versioned layers carry their data identity and display digest; imagery layers carry their normalized tile identity. '
    + 'Pass `symbol` to style the new layer in the same revision; the map frames a newly added layer automatically.',
  parameters: {
    path: { type: 'string', description: 'GeoJSON file path (workspace-relative or absolute). Legacy branch.' },
    ref: { type: 'string', description: 'Exact catalog ref (`res-…@vN` resource or `art-…@vN` artifact). Versioned branch.' },
    tile_url: { type: 'string', description: 'Key-free HTTPS XYZ tile template ({z}/{y}/{x} or {level}/{row}/{col}); no query strings or credentials. Imagery branch.' },
    tile_attribution: { type: 'string', description: 'Attribution line for `tile_url` layers (optional).' },
    name: { type: 'string', description: 'Human-readable layer name; defaults to the file base name, resource identity, or tile host.' },
    crs: { type: 'string', description: 'Source CRS for `path` inputs, e.g. "EPSG:4547" or a +proj= string. Defaults to WGS84. Ignored with `ref` (the version records its CRS); refused with `tile_url`.' },
    layer_id: { type: 'string', description: 'Stable layer id; re-adding an id replaces the layer.' },
    symbol: { type: 'json', description: 'Optional SymbolStyle you design for this layer (same record as layer_set_style; symbolVersion is derived). Lands in the same revision as the layer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    // The durable meta carries the versioned map-change candidate (GeoJSON
    // included) so the accepted successful `tool/result` folds it into the
    // authoritative projection. The model-facing text omits it.
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { path, ref, tile_url: tileUrl, tile_attribution: tileAttribution, name, crs, layer_id: layerId, symbol: rawSymbol } = args as {
      symbol?: unknown
      path?: string
      ref?: string
      tile_url?: string
      tile_attribution?: string
      name?: string
      crs?: string
      layer_id?: string
    }
    if (rawSymbol !== undefined && tileUrl !== undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'symbol applies to feature layers; a tile_url layer has no feature data to style')
    }
    const sources = [path, ref, tileUrl].filter(value => value !== undefined).length
    if (sources > 1) {
      throw new SpatialError('INVALID_ARGUMENT', 'path, ref, and tile_url are mutually exclusive: give exactly one data source')
    }
    if (sources === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_add_layer requires a workspace `path`, a catalog `ref`, or a `tile_url`')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_add_layer')

    let layerId_: string
    let layerName: string
    let data: GeoJsonFeatureCollection | undefined
    let sourceCrs: string
    let layerIdentity: { displayDigest?: string; artifactRef?: string; resourceRef?: string; legend?: MapLayerLegend; imagery?: ImagerySpec }
    if (tileUrl !== undefined) {
      // Imagery branch: a key-free tile overlay — no feature data, no catalog
      // identity; the normalized template is the rendered identity.
      if (crs !== undefined) {
        throw new SpatialError('INVALID_ARGUMENT', 'crs applies to path inputs only; a tile layer reads the template\'s own tiling scheme')
      }
      const imagery = imagerySpecOf(tileUrl, tileAttribution)
      const host = new URL(imagery.urlTemplate).host
      layerId_ = layerId ?? `tile-${stableTileTokenOf(imagery.urlTemplate)}`
      layerName = name ?? host
      data = undefined
      sourceCrs = 'EPSG:4326'
      layerIdentity = { imagery }
    } else if (ref !== undefined) {
      // Versioned branch: read the authorized version's immutable bytes and
      // converge with the version's own recorded CRS.
      if (crs !== undefined) {
        throw new SpatialError('INVALID_ARGUMENT', 'crs applies to path inputs only; a catalog ref reads its recorded version CRS')
      }
      const parsed = parseCatalogRef(ref)
      const catalog = catalogServiceOf(exec)
      const identity = parsed.kind === 'artifact'
        ? await catalog.readArtifactBytes(ref, catalog.deploymentDomain())
        : await catalog.readResourceBytes(ref, catalog.deploymentDomain(), MAX_REGISTER_BYTES)
      const nativeCrs = 'artifact' in identity ? identity.artifact.analysisCrs : identity.resource.nativeCrs
      const copy = buildDisplayCopy(identity.bytes, nativeCrs)
      layerId_ = layerId ?? ref
      layerName = name ?? ref
      data = copy.data
      sourceCrs = nativeCrs
      layerIdentity = {
        displayDigest: copy.displayDigest,
        ...(parsed.kind === 'artifact' ? { artifactRef: ref } : { resourceRef: ref }),
        legend: legendForLayer(layerId_, layerName),
      }
      // The display assembly carried authorized bytes out of the store;
      // register the display copy so a later recall can name this address.
      await catalog.registerCopy({
        objectKind: parsed.kind,
        ref,
        channel: 'display',
        holder: layerId_,
        sessionId: session.id,
      })
    } else {
      // Legacy path branch: unchanged read semantics and no catalog identity fields.
      const sourcePath: string = path as string
      const loaded = await loadGeoJson(crs === undefined ? { path: sourcePath } : { path: sourcePath, crs }, exec)
      layerId_ = layerId ?? sourcePath
      layerName = name ?? sourcePath.split('/').pop() ?? sourcePath
      data = loaded.data
      sourceCrs = loaded.sourceCrs
      assertDisplaySupported(loaded.data)
      layerIdentity = { displayDigest: displayDigestOf(loaded.data) }
    }
    // File IO is the one async window in a mutation body: recheck the caller
    // cancellation so an aborted execution never returns a foldable candidate.
    exec.signal.throwIfAborted()
    const state = service.stateOf(session)
    const layer: MapProjectedLayer = {
      id: layerId_,
      name: layerName,
      sourceCrs,
      opacity: 1,
      visible: true,
      sourceCallSeq: pending.callSeq,
      ...(data === undefined ? {} : { data }),
      ...layerIdentity,
    }
    const styled = withModelSymbol(layer, rawSymbol)
    const change = { op: 'add-layer', layer: styled } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const replacing = state.layers.some(existing => existing.id === layer.id)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      layer: summarize(styled),
      ...(styled.symbol === undefined ? {} : { symbol_version: styled.symbol.symbolVersion }),
      bbox: data === undefined ? null : (bboxOf(data) ?? null),
      total_layers: replacing ? state.layers.length : state.layers.length + 1,
      meta,
    }
  },
})

/** `map_remove_layer`: propose dropping one layer from the session's container. */
export const mapRemoveLayer = defineTool({
  name: 'map_remove_layer',
  description: 'Remove one layer (by layer id) from the current session\'s map container.',
  parameters: {
    layer_id: { type: 'string', required: true, description: 'The layer id previously reported by map_add_layer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    // The durable meta carries the removal candidate so the accepted
    // successful `tool/result` folds it out of the authoritative projection.
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { layer_id: layerId } = args as { layer_id: string }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_remove_layer')
    const state = service.stateOf(session)
    const change = { op: 'remove-layer', layerId } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const present = state.layers.some(layer => layer.id === layerId)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      removed: present,
      total_layers: present ? state.layers.length - 1 : state.layers.length,
      meta,
    }
  },
})

/** `map_set_view`: propose positioning the session's container view (WGS84 center + zoom) and optionally its display projection. */
export const mapSetView = defineTool({
  name: 'map_set_view',
  description:
    'Move the map view of the current session. `center` is WGS84 [lon, lat]. '
    + '`zoom` follows the Web-Mercator scale convention. Optionally set the display projection `wkid` '
    + '(supported values: 4326/4490 geographic, 3857/102100/102113 Web Mercator, or CGCS2000 zones 4534-4554).',
  parameters: {
    center: {
      type: 'array',
      required: true,
      description: 'WGS84 [lon, lat] pair.',
      items: { type: 'number' },
    },
    zoom: { type: 'number', description: 'Zoom level; larger is closer.' },
    wkid: { type: 'number', description: 'Supported display WKID (default keeps the current one): 4326/4490, 3857/102100/102113, or 4534-4554.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    // The durable meta carries the view candidate so the accepted successful
    // `tool/result` folds it into the authoritative projection.
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { center, zoom, wkid } = args as { center: [number, number]; zoom?: number; wkid?: number }
    if (!Array.isArray(center) || center.length < 2
      || typeof center[0] !== 'number' || typeof center[1] !== 'number'
      || center[0] < -180 || center[0] > 180 || center[1] < -90 || center[1] > 90) {
      throw new Error('center must be a WGS84 [lon, lat] pair with lon in [-180, 180] and lat in [-90, 90]')
    }
    if (zoom !== undefined && (!Number.isFinite(zoom) || zoom < 0 || zoom > 24)) {
      throw new Error('zoom must be a number in [0, 24]')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_set_view')
    const state = service.stateOf(session)
    const current = state.view
    const view = {
      center: [round6(center[0]), round6(center[1])] as [number, number],
      zoom: zoom ?? current.zoom,
      wkid: wkid ?? current.wkid,
    }
    const change = { op: 'set-view', view } as const
    admitCameraChange(state, change, sourceServiceOf(exec))
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      center: [view.center[0], view.center[1]],
      zoom: view.zoom,
      wkid: view.wkid,
      meta,
    }
  },
})

/** `map_set_mode`: propose switching the session's container between 2D map and 3D local scene. */
export const mapSetMode = defineTool({
  name: 'map_set_mode',
  description:
    'Switch the current session\'s map container between 2D (`map`) and 3D (`scene`). '
    + 'The 3D scene is a local scene: it supports projected coordinate systems and renders extruded, draped, and elevated data.',
  parameters: {
    mode: {
      required: true,
      description: '"map" for 2D or "scene" for 3D.',
      oneOf: [
        { type: 'string', const: 'map', description: '2D MapView.' },
        { type: 'string', const: 'scene', description: '3D local SceneView.' },
      ],
    },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    // The durable meta carries the mode candidate so the accepted successful
    // `tool/result` folds it into the authoritative projection.
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { mode } = args as { mode: 'map' | 'scene' }
    if (mode !== 'map' && mode !== 'scene') throw new Error('mode must be "map" or "scene"')
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_set_mode')
    const change = { op: 'set-mode', mode } as const
    const state = service.stateOf(session)
    admitCameraChange(state, change, sourceServiceOf(exec))
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return { mode, meta }
  },
})

/** `map_list_basemaps`: read the deployment-owned public source catalog. */
export const mapListBasemaps = defineTool({
  name: 'map_list_basemaps',
  description: 'List this session\'s configured basemaps and compatible reference-label sources, with availability, attribution, publication/version information, and source policy metadata. Publication dates are not imagery acquisition dates.',
  parameters: {
    source_id: { type: 'string', description: 'Use esri-wayback to list official historical releases; optional at+zoom restricts this to real local changes.' },
    provider: { type: 'string', description: 'Optional provider filter: esri, osm, tianditu, or custom.' },
    at: { type: 'array', description: 'Optional WGS84 [lon, lat] query context; must accompany zoom.', items: { type: 'number' } },
    zoom: { type: 'number', description: 'Optional finite application zoom; must accompany at.' },
    cursor: { type: 'string', description: 'Opaque next-page cursor returned by a prior list result.' },
    page_size: { type: 'number', description: 'Positive page size within the configured bound.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderJson(value),
  },
  async execute(args, exec) {
    const sources = requireSourceService(exec)
    const { provider, at, zoom, cursor, page_size: pageSize } = args as {
      provider?: unknown
      at?: unknown
      zoom?: unknown
      cursor?: unknown
      page_size?: unknown
    }
    const sourceId = (args as { source_id?: unknown }).source_id
    if (sourceId !== undefined && sourceId !== 'esri-wayback') throw new SpatialError('SOURCE_RESOURCE_DENIED', 'source_id must be esri-wayback for the historical catalog')
    if (sourceId === 'esri-wayback') {
      if (provider !== undefined) throw new SpatialError('SOURCE_RESOURCE_DENIED', 'provider cannot accompany the historical catalog')
      if ((at === undefined) !== (zoom === undefined)) throw new SpatialError('SOURCE_RESOURCE_DENIED', 'at and zoom must be supplied together')
      if (cursor !== undefined && typeof cursor !== 'string') throw new SpatialError('SOURCE_RESOURCE_DENIED', 'cursor must be an opaque string')
      if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0)) {
        throw new SpatialError('SOURCE_LIMIT_EXCEEDED', 'page_size must be a positive safe integer')
      }
      if (at !== undefined && zoom !== undefined) {
        if (!Array.isArray(at) || at.length !== 2 || !at.every(value => typeof value === 'number' && Number.isFinite(value))
          || typeof zoom !== 'number' || !Number.isFinite(zoom) || cursor !== undefined || pageSize !== undefined) {
          throw new SpatialError('SOURCE_RESOURCE_DENIED', 'local history requires finite at and zoom without pagination')
        }
        try {
          return await sources.waybackLocal({ lon: at[0] as number, lat: at[1] as number }, zoom, exec.signal) as JsonValue
        } catch (error) {
          sourceFailure(error)
        }
      }
      try {
        return await sources.waybackCatalog({ ...(cursor === undefined ? {} : { cursor: cursor as string }), ...(pageSize === undefined ? {} : { pageSize: pageSize as number }) }, exec.signal) as JsonValue
      } catch (error) {
        sourceFailure(error)
      }
    }
    const providers = ['esri', 'osm', 'tianditu', 'custom']
    if (provider !== undefined && (typeof provider !== 'string' || !providers.includes(provider))) {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'provider must be esri, osm, tianditu, or custom')
    }
    if ((at === undefined) !== (zoom === undefined)) {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'at and zoom must be supplied together')
    }
    let location: { lon: number; lat: number } | undefined
    if (at !== undefined) {
      if (!Array.isArray(at) || at.length !== 2 || !at.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new SpatialError('SOURCE_RESOURCE_DENIED', 'at must be a finite [lon, lat] pair')
      }
      location = { lon: at[0] as number, lat: at[1] as number }
    }
    if (zoom !== undefined && (typeof zoom !== 'number' || !Number.isFinite(zoom))) {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'zoom must be finite when supplied')
    }
    if (cursor !== undefined && typeof cursor !== 'string') {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'cursor must be an opaque string')
    }
    if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0)) {
      throw new SpatialError('SOURCE_LIMIT_EXCEEDED', 'page_size must be a positive safe integer')
    }
    try {
      const page = sources.catalog.list({
        ...(provider === undefined ? {} : { provider: provider as SourceProvider }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(location === undefined || zoom === undefined ? {} : { at: location, zoom }),
      }) as {
        readonly catalogVersion: string
        readonly canChange: boolean
        readonly context: { readonly provider: SourceProvider | null; readonly at: { lon: number; lat: number } | null; readonly zoom: number | null }
        readonly sources: readonly unknown[]
        readonly nextCursor: string | null
      }
      return JSON.parse(JSON.stringify({
        catalog_version: page.catalogVersion,
        can_change: page.canChange,
        context: page.context,
        sources: page.sources,
        next_cursor: page.nextCursor,
      })) as JsonValue
    } catch (error) {
      sourceFailure(error)
    }
  },
})

/** `map_set_basemap`: propose one accepted source selection change. */
export const mapSetBasemap = defineTool({
  name: 'map_set_basemap',
  description: 'Select a configured basemap and optional compatible reference-label source without moving the camera or changing business layers. Omit label_source_id to preserve the current labels, or pass null to turn them off. Unavailable, incompatible, or changed sources are refused.',
  parameters: {
    source_id: { type: 'string', required: true, description: 'Configured basemap id from map_list_basemaps.' },
    release_id: { type: 'number', description: 'Official fixed Wayback release id; accepted only with source_id=esri-wayback.' },
    label_source_id: {
      oneOf: [
        { type: 'string', description: 'Compatible label source id.' },
        { type: 'null', description: 'Turn reference labels off.' },
      ],
      description: 'Compatible label id; omission preserves the current labels and null turns labels off.',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { source_id: sourceId, label_source_id: labelId, release_id: releaseId } = args as { source_id?: unknown; label_source_id?: unknown; release_id?: unknown }
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'source_id is required')
    }
    if (labelId !== undefined && labelId !== null && typeof labelId !== 'string') {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'label_source_id must be a source id or null')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_set_basemap')
    const sources = requireSourceService(exec)
    const state = service.stateOf(session)
    const initialRevision = state.revision
    let current = state.basemap
    if (current === null) {
      const legacy = sources.catalog.selection('esri-world-imagery')
      if (!legacy.ok) throw new SpatialError(legacy.code as import('./spatial-errors.ts').SpatialErrorCode, 'the default map source is unavailable')
      current = legacy.value
    }
    const desiredLabels = labelId === undefined ? current.labels?.id ?? null : labelId
    if (sourceId !== 'esri-wayback' && releaseId !== undefined) throw new SpatialError('SOURCE_RESOURCE_DENIED', 'release_id is accepted only for esri-wayback')
    if (sourceId === 'esri-wayback' && (typeof releaseId !== 'number' || !Number.isSafeInteger(releaseId) || releaseId <= 0)) {
      throw new SpatialError('SOURCE_RESOURCE_DENIED', 'esri-wayback requires an official fixed release_id')
    }
    if (sourceId === 'esri-wayback') {
      const admission = sources.catalog.selection(sourceId, null)
      if (!admission.ok && admission.code === 'SOURCE_READ_ONLY') {
        throw new SpatialError('SOURCE_READ_ONLY', 'map source changes are disabled')
      }
    }
    let historical: import('@map-harness/map-layers').BasemapSource | null = null
    if (sourceId === 'esri-wayback') {
      try {
        historical = await sources.waybackRelease(releaseId as number, exec.signal)
      } catch (error) {
        sourceFailure(error)
      }
    }
    if (historical !== null && desiredLabels !== null) {
      throw new SpatialError('SOURCE_COMBINATION_UNSUPPORTED', 'the historical basemap requires labels to be turned off')
    }
    const selection = historical === null ? sources.catalog.selection(sourceId, desiredLabels) : {
      ok: true as const,
      value: {
        schemaVersion: 1 as const,
        basemap: historical,
        labels: null,
      },
    }
    if (!selection.ok) throw new SpatialError(selection.code as import('./spatial-errors.ts').SpatialErrorCode, 'the requested map source selection was refused')
    const compatible = (candidate: MapProjectionState) => [selection.value.basemap, selection.value.labels].every(source => {
      return source === null || sourceCompatibleWithView(source, {
        mode: candidate.mode,
        wkid: viewEngineKey(candidate.view.wkid),
        zoom: candidate.view.zoom,
      })
    })
    if (!compatible(state)) {
      throw new SpatialError('SOURCE_COMBINATION_UNSUPPORTED', 'The selected basemap and reference labels are incompatible. Choose compatible labels or turn them off.')
    }
    try {
      exec.signal.throwIfAborted()
      await sources.prepare(selection.value.basemap, exec.signal)
      if (selection.value.labels !== null) await sources.prepare(selection.value.labels, exec.signal)
    } catch (error) {
      sourceFailure(error)
    }
    const live = service.stateOf(session)
    if (live.revision !== initialRevision) {
      throw new SpatialError('SOURCE_CHANGED', 'the map changed while the map source was verified; retry the selection')
    }
    if (!compatible(live)) {
      throw new SpatialError('SOURCE_CHANGED', 'the view changed while the map source was verified; retry the selection')
    }
    const change = { op: 'set-basemap', selection: selection.value } as const
    const targetRevision = validateMapChangeCandidate(live, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return JSON.parse(JSON.stringify({
      selection: selection.value,
      target_revision: targetRevision,
      note: 'applies when this result is accepted; it is not a rendered-success claim',
      meta,
    })) as JsonValue
  },
})

/** Read one optional boolean tool argument, refusing a non-boolean value. */
function optionalBooleanArg(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new SpatialError('INVALID_ARGUMENT', `${name} must be a boolean`)
  return value
}

/** Read one optional `[0, 1]` opacity tool argument, refusing other numbers. */
function optionalOpacityArg(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new SpatialError('INVALID_ARGUMENT', 'recent_opacity must be a finite number in [0, 1]')
  }
  return value
}

/** Read the optional fixed-release argument; `null` clears it and omission preserves it. */
function optionalReleaseArg(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SpatialError('SOURCE_RESOURCE_DENIED', 'early_release_id must be a positive official Wayback release id or null')
  }
  return value
}

/**
 * `map_set_imagery`: propose visibility, blend, and fixed Wayback release
 * changes for the three imagery resources. Every omitted field keeps its
 * current value; only the fields the model names change in this revision.
 */
export const mapSetImagery = defineTool({
  name: 'map_set_imagery',
  description:
    'Control the three imagery resources of the map container: reference labels, recent imagery, and fixed early imagery. '
    + 'Each field is optional and an omitted field keeps its current value. '
    + '`early_release_id` selects one official World Imagery Wayback release from map_list_basemaps (source_id=esri-wayback); pass null to clear the fixed release, which also turns early imagery off. '
    + 'Recent imagery blends above early imagery, so `recent_opacity` in [0, 1] tunes the two-period comparison. '
    + 'Unavailable or incompatible releases are refused; the target_revision result is a proposal, not a rendered-success claim.',
  parameters: {
    labels_visible: { type: 'boolean', description: 'Show or hide the reference-label source.' },
    recent_visible: { type: 'boolean', description: 'Show or hide the recent imagery basemap.' },
    recent_opacity: { type: 'number', description: 'Recent imagery opacity in [0, 1]; the layer stacks above early imagery.' },
    early_visible: { type: 'boolean', description: 'Show or hide the fixed early imagery; requires a selected early_release_id.' },
    early_release_id: {
      oneOf: [
        { type: 'number', description: 'Official fixed Wayback release id.' },
        { type: 'null', description: 'Clear the fixed early release.' },
      ],
      description: 'Fixed Wayback release id; omission preserves the current release and null clears it.',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const raw = args as {
      labels_visible?: unknown
      recent_visible?: unknown
      recent_opacity?: unknown
      early_visible?: unknown
      early_release_id?: unknown
    }
    const labelsVisible = optionalBooleanArg('labels_visible', raw.labels_visible)
    const recentVisible = optionalBooleanArg('recent_visible', raw.recent_visible)
    const earlyVisible = optionalBooleanArg('early_visible', raw.early_visible)
    const recentOpacity = optionalOpacityArg(raw.recent_opacity)
    const releaseId = optionalReleaseArg(raw.early_release_id)
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_set_imagery')
    const state = service.stateOf(session)
    const current = state.imageryDisplay
    let earlySource = current.earlySource
    if (releaseId === null) {
      earlySource = null
    } else if (releaseId !== undefined) {
      const sources = requireSourceService(exec)
      const admission = sources.catalog.selection('esri-wayback', null)
      if (!admission.ok && admission.code === 'SOURCE_READ_ONLY') {
        throw new SpatialError('SOURCE_READ_ONLY', 'map source changes are disabled')
      }
      let release: import('@map-harness/map-layers').BasemapSource
      try {
        release = await sources.waybackRelease(releaseId, exec.signal)
      } catch (error) {
        sourceFailure(error)
      }
      if (!sourceCompatibleWithView(release, {
        mode: state.mode,
        wkid: viewEngineKey(state.view.wkid),
        zoom: state.view.zoom,
      })) {
        throw new SpatialError('SOURCE_COMBINATION_UNSUPPORTED', 'The fixed early release is incompatible with the current view mode, projection, or zoom.')
      }
      earlySource = release
    }
    const nextEarlyVisible = earlyVisible === undefined ? current.earlyVisible && earlySource !== null : earlyVisible
    if (nextEarlyVisible && earlySource === null) {
      throw new SpatialError('SOURCE_COMBINATION_UNSUPPORTED', 'Visible early imagery requires a fixed Wayback release; pass early_release_id first.')
    }
    const display: {
      readonly labelsVisible: boolean
      readonly recentVisible: boolean
      readonly recentOpacity: number
      readonly earlyVisible: boolean
      readonly earlySource: import('@map-harness/map-layers').BasemapSource | null
    } = {
      labelsVisible: labelsVisible ?? current.labelsVisible,
      recentVisible: recentVisible ?? current.recentVisible,
      recentOpacity: recentOpacity ?? current.recentOpacity,
      earlyVisible: nextEarlyVisible,
      earlySource,
    }
    exec.signal.throwIfAborted()
    const change = { op: 'set-imagery-display', display } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return JSON.parse(JSON.stringify({
      imagery_display: display,
      target_revision: targetRevision,
      note: 'applies when this result is accepted; it is not a rendered-success claim',
      meta,
    })) as JsonValue
  },
})

/** `map_get_state`: read the session's authoritative container state (layers, view, revision, AOI, operation history) from the accepted projection. */
export const mapGetState = defineTool({
  name: 'map_get_state',
  description: 'Read the current session\'s map container state: every layer (id, name, feature count, visibility, content digest), the view, the current revision (cite it as expected_revision when patching), the AOI, and the recent operation history (undo targets).',
  parameters: {},
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderJson(value),
  },
  async execute(_args, exec) {
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const state: MapProjectionState = service.stateOf(session)
    let effectiveBasemap = state.basemap
    if (effectiveBasemap === null) {
      const sources = sourceServiceOf(exec) as MapSourceServiceFace | undefined
      const legacy = sources?.catalog.selection('esri-world-imagery')
      if (legacy === undefined || !legacy.ok) {
        throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the legacy map source is unavailable')
      }
      effectiveBasemap = legacy.value
    }
    return {
      revision: state.revision,
      layers: state.layers.map(layer => ({
        ...summarize(layer),
        digest: layerDigestOf(layer),
        ...(layer.style === undefined ? {} : { style_version: layer.style.styleVersion }),
      })),
      view: { ...state.view, center: [state.view.center[0], state.view.center[1]] },
      mode: state.mode,
      basemap: JSON.parse(JSON.stringify(effectiveBasemap)),
      basemap_explicit: state.basemap !== null,
      imagery_display: JSON.parse(JSON.stringify(state.imageryDisplay)),
      annotations: JSON.parse(JSON.stringify(state.layers.find(layer => layer.role === 'user-annotation')?.data?.features ?? [])) as JsonValue,
      aoi: state.aoi === null ? null : {
        ...(state.aoi.name === undefined ? {} : { name: state.aoi.name }),
        ring: state.aoi.ring.map(point => [point[0], point[1]]),
      },
      operations: state.operations.slice(-8).map(op => ({
        index: op.index,
        revision: op.revision,
        summary: op.summary,
        ...(op.writerId === null ? {} : { writer: op.writerId }),
        ...(op.operationId === null ? {} : { operation_id: op.operationId }),
        ...(op.undoOf === null ? {} : { undo_of: op.undoOf }),
      })),
    }
  },
})

/**
 * The canonical viewport `map_fit_view`'s zoom derivation assumes. The
 * authoritative view record stays center+zoom; a fit names the derivation so
 * the model can predict the result instead of treating it as opaque.
 */
export const FIT_VIEWPORT = { width: 1024, height: 768 } as const

/** Default share of each viewport edge kept clear by a fit (15%). */
export const FIT_DEFAULT_PADDING = 0.15

/** Web-Mercator equatorial circumference in projected meters (R = 6378137). */
const WEB_MERCATOR_CIRCUMFERENCE = 40075016.686

/** Web-Mercator northing of a latitude in radians-scaled units (times the sphere radius outside). */
function mercatorNorthing(latDeg: number): number {
  const lat = latDeg * Math.PI / 180
  return Math.log(Math.tan(Math.PI / 4 + lat / 2))
}

/**
 * Derive the fitting center+zoom for one WGS84 bbox over the canonical
 * viewport: Web-Mercator projected meters per pixel at zoom z is
 * `40075016.686 / (256 · 2^z)`, so the zoom is the largest integer level whose
 * projected spans still fit the padded viewport in both axes.
 * @param bbox - non-degenerate `[west, south, east, north]` in WGS84 degrees.
 * @param padding - clear edge share in `[0, 0.45]`.
 * @returns the 6-decimal center and the clamped `[0, 24]` zoom.
 */
export function fitViewToBbox(
  bbox: readonly [number, number, number, number],
  padding: number = FIT_DEFAULT_PADDING,
): { center: [number, number]; zoom: number } {
  const [west, south, east, north] = bbox
  const usableWidth = FIT_VIEWPORT.width * (1 - 2 * padding)
  const usableHeight = FIT_VIEWPORT.height * (1 - 2 * padding)
  const spanX = WEB_MERCATOR_CIRCUMFERENCE * ((east - west) / 360)
  const spanY = WEB_MERCATOR_CIRCUMFERENCE * (Math.abs(mercatorNorthing(north) - mercatorNorthing(south)) / (2 * Math.PI))
  const metersPerPixel = WEB_MERCATOR_CIRCUMFERENCE / 256
  const zoomW = Math.log2((metersPerPixel * usableWidth) / spanX)
  const zoomH = Math.log2((metersPerPixel * usableHeight) / spanY)
  const zoom = Math.min(24, Math.max(0, Math.floor(Math.min(zoomW, zoomH))))
  return { center: [round6((west + east) / 2), round6((south + north) / 2)], zoom }
}

/**
 * `map_fit_view`: propose positioning the session's view to exactly contain
 * one extent source — an explicit WGS84 `bbox`, one layer's extent
 * (`layer_id`), or the current study AOI (`aoi: true`) — exactly one of the
 * three. The zoom follows the documented Web-Mercator derivation over a
 * canonical 1024×768 viewport with `padding` (default 0.15) clear on every
 * edge; the change itself is an ordinary `set-view` candidate.
 */
export const mapFitView = defineTool({
  name: 'map_fit_view',
  description:
    'Fit the session map view to exactly one extent source: `bbox` ([west,south,east,north] WGS84), `layer_id` (that layer\'s extent), or `aoi: true` (the study AOI outline). '
    + 'Derivation: largest integer Web-Mercator zoom whose projected extent fits a canonical 1024×768 viewport with `padding` (default 0.15) clear per edge; center is the bbox midpoint. '
    + 'The display projection (wkid) is kept. An unknown layer, unset AOI, or degenerate (zero-area) bbox refuses instead of guessing.',
  parameters: {
    bbox: { type: 'array', items: { type: 'number' }, description: 'Extent [west, south, east, north] in WGS84 degrees; non-degenerate.' },
    layer_id: { type: 'string', description: 'Fit to this existing layer\'s extent (from map_get_state).' },
    aoi: { type: 'boolean', description: 'Fit to the current study AOI; refuses when none is set.' },
    padding: { type: 'number', description: 'Clear edge share in [0, 0.45]; default 0.15.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { bbox, layer_id: layerId, aoi, padding } = args as {
      bbox?: unknown
      layer_id?: string
      aoi?: boolean
      padding?: number
    }
    const sources = [bbox, layerId, aoi].filter(value => value !== undefined).length
    if (sources !== 1) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_fit_view takes exactly one extent source: bbox, layer_id, or aoi')
    }
    if (padding !== undefined && (!Number.isFinite(padding) || padding < 0 || padding > 0.45)) {
      throw new SpatialError('INVALID_ARGUMENT', 'padding must be a number in [0, 0.45]')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_fit_view')
    const state = service.stateOf(session)

    let extent: [number, number, number, number]
    let source: { kind: 'bbox'; bbox: [number, number, number, number] } | { kind: 'layer'; layer_id: string; bbox: [number, number, number, number] } | { kind: 'aoi'; bbox: [number, number, number, number] }
    if (bbox !== undefined) {
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new SpatialError('INVALID_ARGUMENT', 'bbox must be four finite numbers [west, south, east, north]')
      }
      const [west, south, east, north] = bbox as [number, number, number, number]
      if (west < -180 || east > 180 || south < -90 || north > 90) {
        throw new SpatialError('INVALID_ARGUMENT', 'bbox must stay inside WGS84 lon [-180,180] lat [-90,90]')
      }
      if (west >= east || south >= north) {
        throw new SpatialError('INVALID_ARGUMENT', 'bbox is degenerate: it needs west < east and south < north')
      }
      extent = [west, south, east, north]
      source = { kind: 'bbox', bbox: extent }
    } else if (layerId !== undefined) {
      const layer = state.layers.find(entry => entry.id === layerId)
      if (layer === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `unknown layer_id "${layerId}"; current layers: ${state.layers.map(entry => entry.id).join(', ') || '(none)'}`)
      }
      const layerBbox = layer.data === undefined ? undefined : bboxOf(layer.data)
      if (layerBbox === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `layer "${layerId}" has no drawable extent (no coordinates)`)
      }
      extent = layerBbox
      source = { kind: 'layer', layer_id: layerId, bbox: layerBbox }
    } else {
      if (state.aoi === null) {
        throw new SpatialError('INVALID_ARGUMENT', 'no study AOI is set; pass an explicit bbox or draw one first')
      }
      const lons = state.aoi.ring.map(point => point[0])
      const lats = state.aoi.ring.map(point => point[1])
      extent = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
      source = { kind: 'aoi', bbox: extent }
    }

    const { center, zoom } = fitViewToBbox(extent, padding ?? FIT_DEFAULT_PADDING)
    const view = { center, zoom, wkid: state.view.wkid }
    const change = { op: 'set-view', view } as const
    admitCameraChange(state, change, sourceServiceOf(exec))
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      source,
      center: [view.center[0], view.center[1]],
      zoom: view.zoom,
      wkid: view.wkid,
      meta,
    }
  },
})

/** Maximum coordinates one `map_draw` call accepts; larger authoring belongs in a workspace file or catalog ref. */
export const MAX_DRAW_COORDINATES = 1024

/**
 * Build one display-supported WGS84 FeatureCollection from explicit model
 * coordinates. A polygon ring auto-closes when the first vertex differs from
 * the last; every other malformation refuses.
 * @param kind - `point` (exactly one pair), `line` (at least 2), or `polygon` (at least 3).
 * @param coordinates - WGS84 `[lon, lat]` pairs.
 * @param name - feature label carried into the feature properties.
 * @returns the one-feature collection ready for the add-layer channel.
 */
export function drawnCollectionOf(
  kind: 'point' | 'line' | 'polygon',
  coordinates: unknown,
  name: string,
): GeoJsonFeatureCollection {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'coordinates must be a non-empty array of [lon, lat] pairs')
  }
  if (coordinates.length > MAX_DRAW_COORDINATES) {
    throw new SpatialError('INVALID_ARGUMENT', `draw accepts at most ${MAX_DRAW_COORDINATES} coordinates; larger geometry belongs in a workspace file or catalog ref`)
  }
  const pairs: [number, number][] = []
  for (const entry of coordinates) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'number' || typeof entry[1] !== 'number' || !Number.isFinite(entry[0]) || !Number.isFinite(entry[1])) {
      throw new SpatialError('INVALID_ARGUMENT', 'every coordinate must be a finite [lon, lat] number pair')
    }
    const [lon, lat] = entry as [number, number]
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new SpatialError('INVALID_ARGUMENT', `coordinate [${lon}, ${lat}] is outside WGS84 lon [-180,180] lat [-90,90]`)
    }
    pairs.push([round6(lon), round6(lat)])
  }
  let geometry: { type: 'Point' | 'LineString' | 'Polygon'; coordinates: unknown }
  if (kind === 'point') {
    if (pairs.length !== 1) throw new SpatialError('INVALID_ARGUMENT', 'a point draw takes exactly one coordinate pair')
    geometry = { type: 'Point', coordinates: pairs[0] }
  } else if (kind === 'line') {
    if (pairs.length < 2) throw new SpatialError('INVALID_ARGUMENT', 'a line draw needs at least 2 coordinate pairs')
    geometry = { type: 'LineString', coordinates: pairs }
  } else {
    if (pairs.length < 3) throw new SpatialError('INVALID_ARGUMENT', 'a polygon draw needs at least 3 coordinate pairs')
    const first = pairs[0]
    const last = pairs[pairs.length - 1]
    if (first === undefined || last === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'a polygon draw needs at least 3 coordinate pairs')
    }
    const ring = first[0] === last[0] && first[1] === last[1] ? pairs : [...pairs, [first[0], first[1]]]
    geometry = { type: 'Polygon', coordinates: [ring] }
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry, properties: { name } }],
  } as GeoJsonFeatureCollection
}

/**
 * `map_draw`: propose drawing one point, line, or polygon feature from
 * explicit WGS84 coordinates as a layer — the direct counterpart of
 * authoring a workspace GeoJSON file. A polygon ring auto-closes. The result
 * travels the same `add-layer` candidate channel as `map_add_layer`, so
 * folding, undo, and replay semantics are identical; re-drawing the same
 * `layer_id` replaces the layer in one new revision.
 */
export const mapDraw = defineTool({
  name: 'map_draw',
  description:
    'Draw one point, line, or polygon feature on the session map from explicit WGS84 [lon, lat] coordinates — no file needed. '
    + '`kind` is point (exactly 1 pair), line (≥2), or polygon (≥3; the ring auto-closes). At most 1024 coordinates; larger geometry belongs in a workspace file or a catalog ref. '
    + 'Re-drawing the same layer_id replaces the layer. For navigation-only place lookup use map_locate; to persist fetched data use catalog_register.',
  parameters: {
    kind: { type: 'string', required: true, description: 'point | line | polygon.' },
    coordinates: { type: 'json', required: true, description: 'Array of WGS84 [lon, lat] pairs; a polygon\'s first vertex may differ from the last (auto-closed).' },
    layer_id: { type: 'string', description: 'Stable layer id (default drawn-<kind>); re-drawing an id replaces the layer.' },
    name: { type: 'string', description: 'Human-readable layer name; defaults to the kind.' },
    label: { type: 'string', description: 'Feature label carried into the feature properties (e.g. an entry point name).' },
    symbol: { type: 'json', description: 'Optional SymbolStyle you design for this layer (same record as layer_set_style; symbolVersion is derived). Lands in the same revision as the layer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { kind, coordinates, layer_id: layerId, name, label, symbol: rawSymbol } = args as {
      symbol?: unknown
      kind?: unknown
      coordinates?: unknown
      layer_id?: string
      name?: string
      label?: string
    }
    if (kind !== 'point' && kind !== 'line' && kind !== 'polygon') {
      throw new SpatialError('INVALID_ARGUMENT', 'kind must be "point", "line", or "polygon"')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_draw')
    const layerName = name ?? `drawn ${kind}`
    const data = drawnCollectionOf(kind, coordinates, label ?? layerName)
    assertDisplaySupported(data)
    const state = service.stateOf(session)
    const layer: MapProjectedLayer = {
      id: layerId ?? `drawn-${kind}`,
      name: layerName,
      data,
      sourceCrs: 'EPSG:4326',
      opacity: 1,
      visible: true,
      sourceCallSeq: pending.callSeq,
      displayDigest: displayDigestOf(data),
    }
    const styled = withModelSymbol(layer, rawSymbol)
    const change = { op: 'add-layer', layer: styled } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const replacing = state.layers.some(existing => existing.id === layer.id)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      layer: summarize(styled),
      ...(styled.symbol === undefined ? {} : { symbol_version: styled.symbol.symbolVersion }),
      bbox: bboxOf(data) ?? null,
      total_layers: replacing ? state.layers.length : state.layers.length + 1,
      meta,
    }
  },
})

/**
 * `map_locate`: resolve one place name to provider coordinates for
 * navigation — a read-only lookup through the deployment's online search
 * provider. Without `bbox` it geocodes (the geocoder's single candidate,
 * with its known limitation surfaced); with a WGS84 `bbox` it runs a bounded
 * POI search whose candidates carry names and addresses — and which can
 * honestly report zero. Registering fetched data belongs to
 * `catalog_register`; the tool never invents coordinates.
 */
export const mapLocate = defineTool({
  name: 'map_locate',
  description:
    'Resolve one place name to coordinates for map navigation (read-only; nothing is registered). '
    + 'Without `bbox` returns the geocoder\'s single candidate; with `bbox` ([west,south,east,north] WGS84) returns bounded POI candidates with addresses — and honestly reports found: 0 inside an area the provider cannot match. '
    + 'Points are in the provider\'s geographic CRS (EPSG:4490 lon/lat for Tianditu, usable directly in map_set_view/map_fit_view). To persist or analyze fetched data use catalog_register.',
  parameters: {
    query: { type: 'string', required: true, description: 'The place name to resolve (1..256 chars).' },
    bbox: { type: 'array', items: { type: 'number' }, description: 'Optional [west, south, east, north] WGS84 window: switch to a bounded POI search for multiple candidates.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderJson(value),
  },
  async execute(args, exec) {
    const { query, bbox } = args as { query?: unknown; bbox?: unknown }
    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 256) {
      throw new SpatialError('INVALID_ARGUMENT', 'query must be a place name of 1..256 characters')
    }
    if (bbox !== undefined && (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value)))) {
      throw new SpatialError('INVALID_ARGUMENT', 'bbox must be four finite numbers [west, south, east, north]')
    }
    if (bbox !== undefined && (bbox[0] >= bbox[2] || bbox[1] >= bbox[3])) {
      throw new SpatialError('INVALID_ARGUMENT', 'bbox is degenerate: it needs west < east and south < north')
    }
    exec.signal.throwIfAborted()
    const search = serviceOf<SpatialSearchService>(exec, SPATIAL_SEARCH_SERVICE)
    if (search === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_locate requires the spatialSearch provider; this deployment has none configured')
    }
    const trimmed = query.trim()
    const request = bbox === undefined
      ? { kind: 'geocode', query: trimmed }
      : { kind: 'search', query: trimmed, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number], limit: 5 }
    const result = await search.search(request, exec.signal)
    const candidates = result.data.features
      .filter(feature => feature.geometry.type === 'Point')
      .map(feature => ({
        name: feature.properties.name ?? trimmed,
        point: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]] as [number, number],
        ...(feature.properties.address === undefined || feature.properties.address === '' ? {} : { address: feature.properties.address }),
      }))
    return {
      query: trimmed,
      ...(bbox === undefined ? {} : { bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] }),
      provider: result.provider,
      crs: result.nativeCrs,
      found: candidates.length,
      candidates,
      ...(result.hasMore ? { more_available: true } : {}),
      ...(candidates.length === 0
        ? { note: 'the provider matched no candidate; refine the name, widen the bbox, or place the area yourself with map_fit_view' }
        : {}),
      limitations: [...result.limitations],
    }
  },
})
