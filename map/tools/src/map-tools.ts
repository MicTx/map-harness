/**
 * The model-facing map tools: container control (`map_add_layer`,
 * `map_set_view`, `map_set_mode`, `map_get_state`, `map_remove_layer`) over
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
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
  buildMapChangeMeta,
  layerDigestOf,
  validateMapChangeCandidate,
} from '@map-harness/map-container'
import { MAX_REGISTER_BYTES, parseCatalogRef } from '@map-harness/spatial-catalog'
import { catalogServiceOf } from './catalog-tools.ts'
import { assertDisplaySupported, buildDisplayCopy, displayDigestOf, legendOf } from './display.ts'
import { loadGeoJson } from './geo-source.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
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
  name: 'map_add_layer' | 'map_remove_layer' | 'map_set_view' | 'map_set_mode',
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

/** Summarize one projected layer for tool output. */
function summarize(layer: MapProjectedLayer): LayerSummary {
  return {
    id: layer.id,
    name: layer.name,
    featureCount: (layer.data as { features?: unknown[] })?.features?.length ?? 0,
    sourceCrs: layer.sourceCrs ?? 'EPSG:4326',
    visible: layer.visible,
  }
}

/**
 * `map_add_layer`: propose loading a layer into the session's container.
 * Inputs are strictly exclusive: a workspace `path` (legacy branch, unchanged
 * semantics) or a catalog `ref` (an exact `res-…@vN`/`art-…@vN` whose bytes
 * the map adapter reads and digests). Both branches converge to WGS84 and are
 * display-admitted before anything is proposed.
 */
export const mapAddLayer = defineTool({
  name: 'map_add_layer',
  description:
    'Add a GeoJSON layer to the map container of the current session. '
    + 'Give EITHER `path` (a workspace GeoJSON file; WGS84 lon/lat by default, pass `crs` for projected data) '
    + 'OR `ref` (an exact catalog ref `res-…@vN` from catalog_register, or a published artifact ref `art-…@vN` '
    + 'from geo_buffer) — never both. Versioned layers carry their data identity and display digest.',
  parameters: {
    path: { type: 'string', description: 'GeoJSON file path (workspace-relative or absolute). Legacy branch.' },
    ref: { type: 'string', description: 'Exact catalog ref (`res-…@vN` resource or `art-…@vN` artifact). Versioned branch.' },
    name: { type: 'string', description: 'Human-readable layer name; defaults to the file base name or resource identity.' },
    crs: { type: 'string', description: 'Source CRS for `path` inputs, e.g. "EPSG:4547" or a +proj= string. Defaults to WGS84. Ignored with `ref` (the version records its CRS).' },
    layer_id: { type: 'string', description: 'Stable layer id; re-adding an id replaces the layer.' },
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
    const { path, ref, name, crs, layer_id: layerId } = args as {
      path?: string
      ref?: string
      name?: string
      crs?: string
      layer_id?: string
    }
    if (path !== undefined && ref !== undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'path and ref are mutually exclusive: give exactly one data source')
    }
    if (path === undefined && ref === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_add_layer requires either a workspace `path` or a catalog `ref`')
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingMutation(exec, service, session, 'map_add_layer')

    let layerId_: string
    let layerName: string
    let data: GeoJsonFeatureCollection
    let sourceCrs: string
    let layerIdentity: Pick<MapProjectedLayer, 'displayDigest' | 'artifactRef' | 'resourceRef' | 'legend'>
    if (ref !== undefined) {
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
        legend: legendOf(layerName),
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
      data,
      sourceCrs,
      opacity: 1,
      visible: true,
      sourceCallSeq: pending.callSeq,
      ...layerIdentity,
    }
    const change = { op: 'add-layer', layer } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const replacing = state.layers.some(existing => existing.id === layer.id)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      layer: summarize(layer),
      bbox: bboxOf(data) ?? null,
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
    const current = service.stateOf(session).view
    const view = {
      center: [round6(center[0]), round6(center[1])] as [number, number],
      zoom: zoom ?? current.zoom,
      wkid: wkid ?? current.wkid,
    }
    const change = { op: 'set-view', view } as const
    const targetRevision = validateMapChangeCandidate(service.stateOf(session), change)
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
    const targetRevision = validateMapChangeCandidate(service.stateOf(session), change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return { mode, meta }
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
    const state: MapProjectionState = mapServiceOf(exec).stateOf(session)
    return {
      revision: state.revision,
      layers: state.layers.map(layer => ({
        ...summarize(layer),
        digest: layerDigestOf(layer),
        ...(layer.style === undefined ? {} : { style_version: layer.style.styleVersion }),
      })),
      view: { center: [state.view.center[0], state.view.center[1]], zoom: state.view.zoom, wkid: state.view.wkid },
      mode: state.mode,
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
