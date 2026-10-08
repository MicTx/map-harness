/**
 * The terrain tools: `terrain_add_layer` (a bounded terrain-preview layer
 * bound to one exact, authorized surface version) and `geo_line_of_sight`
 * (the sampled visibility computation over that version).
 *
 * Every computation binds the exact bytes it read: the tool resolves the raw
 * arguments into a fully-specified `spatial-terrain@1` spec — every default
 * is written into the resolved spec before validation — and refuses to run
 * without a named vertical datum, supported vertical units, a horizontal
 * CRS, and a versioned surface ref. When a terrain-preview layer is loaded,
 * `geo_line_of_sight` checks the computed revision against the displayed
 * one, so display and analysis never silently disagree about which terrain
 * version they describe. Successful runs publish the full sample table as an
 * immutable catalog artifact through the accepted-call pairing, keep only
 * bounded summaries in model content, and carry the durable
 * `spatial-terrain` meta.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type GeoJsonFeatureCollection,
  type MapContainerService,
  type MapPendingCall,
  type MapProjectedLayer,
  buildMapChangeMeta,
  validateMapChangeCandidate,
} from '@map-harness/map-container'
import {
  DEFAULT_MAX_SAMPLES,
  DEFAULT_REFRACTION_K,
  SUPPORTED_VERTICAL_UNITS,
  TERRAIN_METHOD_VERSION,
  buildTerrainObstacles,
  buildTerrainSurface,
  computeLineOfSight,
  revisionsMatch,
  surfaceDisplayPoints,
  validateTerrainSpec,
  type BuildingsBinding,
  type ControlPoint,
  type CurvatureCorrection,
  type LosEndpoint,
  type SurfaceBinding,
  type TerrainIssue,
  type TerrainObstacles,
  type TerrainSpec,
  type TerrainSurface,
  MAX_VIEWSHED_TARGETS,
  computeViewshed,
} from '@map-harness/spatial-terrain'
import { MAX_REGISTER_BYTES, admitCollection, parseCatalogRef } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { displayDigestOf, legendOf } from './display.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { bboxOf, renderJson, round6 } from './output.ts'
import { buildTerrainLosMeta } from './terrain-meta.ts'

/** The bounded read cap for one resolved terrain resource (same budget as registration). */
const MAX_TERRAIN_RESOURCE_BYTES = MAX_REGISTER_BYTES

/**
 * The bounded display decimation of one terrain preview: at most this many
 * lattice points ride the map projection, whatever the registered grid size.
 */
export const MAX_TERRAIN_DISPLAY_POINTS = 1024

/** Render helper shared by the terrain tools: model text omits the durable meta. */
function renderTerrainJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the terrain family. */
function terrainPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** The accepted projection read face (host-plane service, same pattern as the viz tools). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
  return map
}

/**
 * Resolve the accepted `tool/call` the terrain mutation pairs with — the
 * same rule every map mutation follows, so a preview folds only from a
 * native direct call the session log already accepted.
 */
function requirePendingTerrainMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: NonNullable<ToolRunContext['agent']>['session'],
  name: 'terrain_add_layer',
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'terrain_add_layer supports native model-direct calls only; nested dispatch cannot change the map')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'terrain_add_layer requires its accepted tool/call in the session log before execution')
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** Resolve one required nonempty string argument. */
function requireString(args: Record<string, unknown>, name: string, reason: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} is required: ${reason}`)
  }
  return value
}

/**
 * Resolve the vertical metadata triple. There is no default datum: a missing
 * datum or epoch, or a unit this implementation does not carry, refuses
 * before any byte is read.
 */
function resolveVertical(args: Record<string, unknown>): { datum: string; units: string; epoch: string } {
  const datum = requireString(args, 'vertical_datum', 'heights without a named datum are not comparable')
  const units = requireString(args, 'vertical_units', 'the vertical unit must be stated')
  const epoch = requireString(args, 'vertical_epoch', 'the datum epoch (or the literal "none") must be stated')
  if (!SUPPORTED_VERTICAL_UNITS.includes(units)) {
    throw new SpatialError('INVALID_ARGUMENT', `vertical_units "${units}" is unsupported; this implementation carries ${SUPPORTED_VERTICAL_UNITS.join('/')}`)
  }
  return { datum, units, epoch }
}

/** Reject a raw spec input with every structural issue named. */
function requireCleanSpec(issues: readonly TerrainIssue[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_ARGUMENT', `terrain spec rejected: ${issues.map(issue => `${issue.field} (${issue.code})`).join('; ')}`)
  }
}

/**
 * `terrain_add_layer`: propose a bounded terrain-preview layer from one
 * exact, authorized surface version. The preview decimates the grid to a
 * fixed point cap and carries the terrain identity (revision, vertical
 * metadata, grid shape) so every display face cites the version it draws.
 */
export const terrainAddLayer = defineTool({
  name: 'terrain_add_layer',
  description:
    'Add a terrain-preview layer to the map from one exact catalog surface version (res-…@vN). The surface is a '
    + 'registered grid of points carrying elevations under `elevation_field`; vertical metadata (datum/units/epoch) '
    + 'is required and recorded — there is no default datum. The preview is a bounded decimation for 2D/3D display; '
    + 'run visibility analysis against the same version with geo_line_of_sight.',
  parameters: {
    ref: { type: 'string', required: true, description: 'Exact surface resource ref, `res-…@vN` (a registered point grid).' },
    vertical_datum: { type: 'string', required: true, description: 'Named vertical datum, e.g. EGM96, NAVD88, ellipsoid-WGS84.' },
    vertical_units: { type: 'string', required: true, description: 'Vertical unit; "m" is the supported unit.' },
    vertical_epoch: { type: 'string', required: true, description: 'Datum epoch or realization, e.g. "2010.00"; literal "none" for datum-less ellipsoidal heights.' },
    elevation_field: { type: 'string', description: 'Numeric property holding each grid point\'s elevation; "elevation" is the recorded default.' },
    name: { type: 'string', description: 'Human-readable layer name; defaults to the surface ref.' },
    layer_id: { type: 'string', description: 'Stable layer id; re-adding an id replaces the layer.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderTerrainJson(value),
    presentationMeta: (_args, value) => terrainPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const {
      ref,
      name,
      layer_id: layerId,
      elevation_field: elevationFieldArg,
    } = args as Record<string, unknown>
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'ref must be an exact surface resource ref res-…@vN')
    }
    const parsed = parseCatalogRef(ref)
    if (parsed.kind !== 'resource') {
      throw new SpatialError('INVALID_ARGUMENT', 'terrain layers bind a registered surface resource (res-…@vN); published artifacts are not terrain surfaces')
    }
    const vertical = resolveVertical(args)
    const elevationField = elevationFieldArg === undefined ? 'elevation' : elevationFieldArg
    if (typeof elevationField !== 'string' || elevationField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'elevation_field must be a nonempty property name')
    }
    const binding: SurfaceBinding = {
      ref,
      revision: 'pending-read',
      elevationField,
      horizontalCrs: 'EPSG:4326',
      vertical,
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingTerrainMutation(exec, service, session, 'terrain_add_layer')
    const { resource, bytes } = await catalog.readResourceBytes(ref, catalog.deploymentDomain(), MAX_TERRAIN_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    const built = buildTerrainSurface(
      { ...binding, revision: resource.contentDigest, horizontalCrs: resource.nativeCrs },
      admitted.collection.features as Parameters<typeof buildTerrainSurface>[1],
    )
    requireCleanSurface(built.issues)
    const surface = built.surface
    if (surface === undefined) {
      throw new SpatialError('INVALID_GEOJSON', `surface ${ref} is not a usable elevation grid`)
    }
    exec.signal.throwIfAborted()
    const display = surfaceDisplayPoints(surface, elevationField, MAX_TERRAIN_DISPLAY_POINTS)
    const displayData: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: display.features as GeoJsonFeatureCollection['features'] }
    if (layerId !== undefined && (typeof layerId !== 'string' || layerId.length === 0)) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_id must be a nonempty string when given')
    }
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      throw new SpatialError('INVALID_ARGUMENT', 'name must be a nonempty string when given')
    }
    const layerId_ = layerId === undefined ? ref : layerId
    const layerName = name === undefined ? `terrain preview ${ref}` : name
    const layer: MapProjectedLayer = {
      id: layerId_,
      name: layerName,
      data: displayData,
      sourceCrs: resource.nativeCrs,
      opacity: 1,
      visible: true,
      sourceCallSeq: pending.callSeq,
      displayDigest: displayDigestOf(displayData),
      resourceRef: ref,
      legend: legendOf(layerName),
      terrain: {
        surfaceRef: ref,
        revision: resource.contentDigest,
        verticalDatum: vertical.datum,
        verticalUnits: vertical.units,
        epoch: vertical.epoch,
        elevationField,
        gridColumns: surface.lons.length,
        gridRows: surface.lats.length,
        sourcePointCount: surface.pointCount,
      },
    }
    const state = service.stateOf(session)
    const change = { op: 'add-layer', layer } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const replacing = state.layers.some(existing => existing.id === layer.id)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      layer: {
        id: layer.id,
        name: layer.name,
        point_count: display.features.length,
        source_point_count: surface.pointCount,
        sourceCrs: resource.nativeCrs,
        visible: true,
      },
      terrain: {
        surface_ref: ref,
        revision: resource.contentDigest,
        vertical,
        grid: { columns: surface.lons.length, rows: surface.lats.length, source_point_count: surface.pointCount },
        display_points: display.features.length,
      },
      bbox: bboxOf(displayData) ?? null,
      total_layers: replacing ? state.layers.length : state.layers.length + 1,
      limitations: [
        `the preview decimates the ${surface.pointCount}-point grid to at most ${MAX_TERRAIN_DISPLAY_POINTS} display points; analysis reads the full registered grid`,
        'the preview is display-only: visibility answers come from geo_line_of_sight bound to the same revision',
      ],
      meta,
    }
  },
})

/** Reject one built-surface issue list with every defect named. */
function requireCleanSurface(issues: readonly { field: string; code: string; message: string }[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_GEOJSON', `surface rejected: ${issues.map(issue => `${issue.field} (${issue.code}) ${issue.message}`).join('; ')}`)
  }
}

/** One optional obstacle resource the LOS tool may bind. */
interface ResolvedObstacles {
  readonly obstacles: TerrainObstacles
  readonly inputRefs: readonly string[]
  readonly authorizations: readonly string[]
}

/** The raw endpoint arguments one LOS call names. */
function resolveEndpoint(args: Record<string, unknown>, name: 'observer' | 'target'): LosEndpoint {
  const raw = args[name]
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'number' || typeof raw[1] !== 'number'
    || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])
    || raw[0] < -180 || raw[0] > 180 || raw[1] < -90 || raw[1] > 90) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} must be a WGS84 [lon, lat] pair`)
  }
  const heightRaw = args[`${name}_height_m`]
  const heightM = heightRaw === undefined ? 0 : heightRaw
  if (typeof heightM !== 'number' || !Number.isFinite(heightM)) {
    throw new SpatialError('INVALID_ARGUMENT', `${name}_height_m must be a finite number`)
  }
  const absoluteRaw = args[`${name}_elevation_m`]
  if (absoluteRaw !== undefined && (typeof absoluteRaw !== 'number' || !Number.isFinite(absoluteRaw))) {
    throw new SpatialError('INVALID_ARGUMENT', `${name}_elevation_m must be a finite number when given`)
  }
  return {
    lon: raw[0],
    lat: raw[1],
    heightM,
    ...(absoluteRaw !== undefined ? { elevationM: absoluteRaw } : {}),
  }
}

/** The optional control-point block one LOS call may carry: all-or-nothing with the tolerance. */
function resolveControlPoints(args: Record<string, unknown>): { controlPoints?: readonly ControlPoint[]; controlToleranceM?: number } {
  const raw = args.control_points
  if (raw === undefined) return {}
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'control_points must be a nonempty array of {id, lon, lat, elevation_m}')
  }
  const toleranceRaw = args.control_tolerance_m
  if (typeof toleranceRaw !== 'number' || !Number.isFinite(toleranceRaw) || toleranceRaw <= 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'control_tolerance_m must be a positive number when control_points are given')
  }
  const points: ControlPoint[] = raw.map((entry, index) => {
    const record = entry as Record<string, unknown>
    if (typeof record !== 'object' || record === null
      || typeof record.id !== 'string' || record.id.length === 0
      || typeof record.lon !== 'number' || typeof record.lat !== 'number'
      || typeof record.elevation_m !== 'number') {
      throw new SpatialError('INVALID_ARGUMENT', `control_points[${index}] must be {id, lon, lat, elevation_m}`)
    }
    return { id: record.id, lon: record.lon, lat: record.lat, elevationM: record.elevation_m }
  })
  return { controlPoints: points, controlToleranceM: toleranceRaw }
}

/**
 * `geo_line_of_sight`: run the sampled visibility computation over one exact
 * surface version. The verdict reports visible/blocked/indeterminate with
 * the first obstruction named, slant and horizontal distances under the
 * recorded tangent-plane definition, and the clearance uncertainty the
 * declared accuracy budget implies. Publishes the full sample table as an
 * artifact; the model summary stays bounded.
 */
export const geoLineOfSight = defineTool({
  name: 'geo_line_of_sight',
  description:
    'Compute line of sight (visibility) between two points over a registered terrain grid (res-…@vN). Requires the '
    + 'surface\'s vertical metadata (datum/units/epoch — no default) and its accuracy budget (surface_sigma_m). '
    + 'Samples the sightline at the given interval with optional earth-curvature/refraction correction and optional '
    + 'building/voxel obstacles, and reports visible/blocked/indeterminate with the first obstruction, slant and '
    + 'horizontal distances, and the clearance uncertainty. A grazing sightline inside the error budget reports '
    + 'indeterminate, never visible. Pass layer_id to refuse when the displayed terrain version is not this one.',
  parameters: {
    surface_ref: { type: 'string', required: true, description: 'Exact surface resource ref, `res-…@vN` (registered point grid).' },
    vertical_datum: { type: 'string', required: true, description: 'Named vertical datum of the surface elevations.' },
    vertical_units: { type: 'string', required: true, description: 'Vertical unit; "m" is the supported unit.' },
    vertical_epoch: { type: 'string', required: true, description: 'Datum epoch or the literal "none".' },
    elevation_field: { type: 'string', description: 'Elevation property; "elevation" is the recorded default.' },
    observer: { type: 'array', required: true, description: 'WGS84 [lon, lat] of the observer.', items: { type: 'number' } },
    observer_height_m: { type: 'number', description: 'Observer height above the terrain; 0 is the recorded default.' },
    observer_elevation_m: { type: 'number', description: 'Absolute observer elevation override; skips sampling the surface for the endpoint.' },
    target: { type: 'array', required: true, description: 'WGS84 [lon, lat] of the target.', items: { type: 'number' } },
    target_height_m: { type: 'number', description: 'Target height above the terrain; 0 is the recorded default.' },
    target_elevation_m: { type: 'number', description: 'Absolute target elevation override.' },
    sampling_interval_m: { type: 'number', description: 'Sample spacing in meters; 25 is the recorded default.' },
    max_samples: { type: 'number', description: 'Sample-count bound; 4096 is the recorded default. Exceeding it refuses instead of coarsening.' },
    surface_sigma_m: { type: 'number', required: true, description: 'Surface elevation one-sigma in meters; the clearance uncertainty and honest indeterminate band derive from it.' },
    endpoint_sigma_m: { type: 'number', description: 'Endpoint elevation one-sigma in meters for both endpoints; 0 is the recorded default.' },
    curvature: { type: 'string', description: '"corrected" (recorded default; drop (1−k)·d²/2R) or "none".' },
    refraction_k: { type: 'number', description: 'Refraction coefficient with curvature=corrected; 0.13 is the recorded default.' },
    buildings_ref: { type: 'string', description: 'Optional building-footprint resource ref (Polygons with a height property).' },
    height_field: { type: 'string', description: 'Building height property with buildings_ref; "height" is the recorded default.' },
    building_base: { type: 'string', description: '"terrain" (recorded default) or "absolute" (needs base_field).' },
    base_field: { type: 'string', description: 'Absolute base-elevation property with building_base="absolute".' },
    voxels_ref: { type: 'string', description: 'Optional occupied-voxel resource ref (Points at cell centers with a z property).' },
    z_field: { type: 'string', description: 'Voxel center-elevation property with voxels_ref; "z" is the recorded default.' },
    voxel_cell_m: { type: 'number', description: 'Cubic cell edge in meters with voxels_ref (required with voxels).' },
    control_points: { type: 'array', description: 'Surveyed {id, lon, lat, elevation_m} points the surface must match before computing.' },
    control_tolerance_m: { type: 'number', description: 'Control-point match tolerance in meters (required with control_points).' },
    layer_id: { type: 'string', description: 'Terrain-preview layer id to check against; refuses when its revision differs from the computed one.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderTerrainJson(value),
    presentationMeta: (_args, value) => terrainPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const rawArgs = args as Record<string, unknown>
    const surfaceRef = requireString(rawArgs, 'surface_ref', 'bind one exact surface version res-…@vN')
    const parsed = parseCatalogRef(surfaceRef)
    if (parsed.kind !== 'resource') {
      throw new SpatialError('INVALID_ARGUMENT', 'line of sight binds a registered surface resource (res-…@vN); artifacts are not terrain surfaces')
    }
    const vertical = resolveVertical(rawArgs)
    const surfaceSigma = rawArgs.surface_sigma_m
    if (typeof surfaceSigma !== 'number' || !Number.isFinite(surfaceSigma) || surfaceSigma < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'surface_sigma_m is required (finite, nonnegative): the verdict is only as good as the declared surface accuracy')
    }
    const endpointSigma = rawArgs.endpoint_sigma_m === undefined ? 0 : rawArgs.endpoint_sigma_m
    if (typeof endpointSigma !== 'number' || !Number.isFinite(endpointSigma) || endpointSigma < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'endpoint_sigma_m must be a finite nonnegative number')
    }
    const intervalRaw = rawArgs.sampling_interval_m
    const intervalM = intervalRaw === undefined ? 25 : intervalRaw
    if (typeof intervalM !== 'number' || !Number.isFinite(intervalM) || intervalM <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'sampling_interval_m must be a positive number')
    }
    const maxSamplesRaw = rawArgs.max_samples
    const maxSamples = maxSamplesRaw === undefined ? DEFAULT_MAX_SAMPLES : maxSamplesRaw
    if (typeof maxSamples !== 'number' || !Number.isInteger(maxSamples)) {
      throw new SpatialError('INVALID_ARGUMENT', 'max_samples must be an integer')
    }
    const curvatureRaw = rawArgs.curvature === undefined ? 'corrected' : rawArgs.curvature
    if (curvatureRaw !== 'corrected' && curvatureRaw !== 'none') {
      throw new SpatialError('INVALID_ARGUMENT', 'curvature must be "corrected" or "none"')
    }
    const refractionKRaw = rawArgs.refraction_k
    if (refractionKRaw !== undefined && (typeof refractionKRaw !== 'number' || !Number.isFinite(refractionKRaw) || refractionKRaw < 0 || refractionKRaw >= 1)) {
      throw new SpatialError('INVALID_ARGUMENT', 'refraction_k must be a finite number in [0, 1)')
    }
    const curvature: CurvatureCorrection = curvatureRaw === 'none'
      ? { kind: 'none' }
      : { kind: 'refraction-corrected', refractionK: refractionKRaw ?? DEFAULT_REFRACTION_K }
    const elevationField = rawArgs.elevation_field === undefined ? 'elevation' : rawArgs.elevation_field
    if (typeof elevationField !== 'string' || elevationField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'elevation_field must be a nonempty property name')
    }

    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], 'geo_line_of_sight')

    const spec: TerrainSpec = {
      methodVersion: TERRAIN_METHOD_VERSION,
      surface: { ref: surfaceRef, revision: 'pending-read', elevationField, horizontalCrs: 'EPSG:4326', vertical },
      curvature,
      accuracy: { surfaceMeters: surfaceSigma, observerMeters: endpointSigma, targetMeters: endpointSigma },
      sampling: { intervalMeters: intervalM, maxSamples },
      ...resolveControlPoints(rawArgs),
    }
    requireCleanSpec(validateTerrainSpec(spec))

    const observer = resolveEndpoint(rawArgs, 'observer')
    const target = resolveEndpoint(rawArgs, 'target')

    const { resource, bytes } = await catalog.readResourceBytes(surfaceRef, catalog.deploymentDomain(), MAX_TERRAIN_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    const built = buildTerrainSurface({ ...spec.surface, revision: resource.contentDigest, horizontalCrs: resource.nativeCrs }, admitted.collection.features as Parameters<typeof buildTerrainSurface>[1])
    requireCleanSurface(built.issues)
    const surface: TerrainSurface = built.surface as TerrainSurface

    const obstacles = await resolveObstacleResources(catalog, rawArgs, surface)

    // Optional display consistency: refuse an analysis whose terrain version
    // differs from the loaded preview the caller names.
    const layerId = rawArgs.layer_id
    if (layerId !== undefined) {
      if (typeof layerId !== 'string' || layerId.length === 0) throw new SpatialError('INVALID_ARGUMENT', 'layer_id must be a layer id')
      const layer = mapServiceOf(exec).stateOf(session).layers.find(candidate => candidate.id === layerId)
      if (layer === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `unknown layer ${layerId}; map_get_state lists the loaded layers`)
      }
      if (layer.terrain === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `layer ${layerId} is not a terrain preview; terrain_add_layer loads one`)
      }
      if (!revisionsMatch(
        { ref: surfaceRef, revision: resource.contentDigest },
        { ref: layer.terrain.surfaceRef, revision: layer.terrain.revision },
      )) {
        throw new SpatialError('TERRAIN_VERSION_CONFLICT', `layer ${layerId} displays ${layer.terrain.surfaceRef}@${layer.terrain.revision.slice(0, 12)} but this analysis resolved ${surfaceRef}@${resource.contentDigest.slice(0, 12)}; re-add the layer or pin the analysis to the displayed version`)
      }
    }

    const resolvedSpec: TerrainSpec = { ...spec, surface: { ...spec.surface, revision: resource.contentDigest, horizontalCrs: resource.nativeCrs } }
    exec.signal.throwIfAborted()
    const run = computeLineOfSight(resolvedSpec, surface, obstacles.obstacles, observer, target)
    if (run.status === 'refused') {
      throw new SpatialError('INVALID_ARGUMENT', `line of sight refused (${run.code}): ${run.message}`)
    }
    exec.signal.throwIfAborted()
    const result = run.result
    // The artifact keeps the resolved spec and the full per-sample table
    // (result.samples); the model summary carries only the decimated profile.
    const artifactBytes = new TextEncoder().encode(JSON.stringify({
      spec: resolvedSpec,
      spec_digest: result.specDigest,
      result,
    }))
    const published = await catalog.publishArtifact({
      bytes: artifactBytes,
      inputRefs: [surfaceRef, ...obstacles.inputRefs],
      method: { algorithm: 'line-of-sight', units: 'meters', parameters: { methodVersion: TERRAIN_METHOD_VERSION, specDigest: result.specDigest, curvature: curvature.kind } },
      analysisCrs: resolvedSpec.surface.horizontalCrs,
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [resource.authorization, ...obstacles.authorizations],
    })
    const status = result.status === 'indeterminate' ? 'indeterminate' : 'succeeded'
    const meta = buildTerrainLosMeta({
      tool: 'geo_line_of_sight',
      status,
      methodVersion: TERRAIN_METHOD_VERSION,
      surfaceRef,
      surfaceRevision: resource.contentDigest,
      vertical,
      horizontalCrs: resolvedSpec.surface.horizontalCrs,
      specDigest: result.specDigest,
      headline: {
        verdict: result.status,
        obstructionDistanceM: result.firstObstruction === null ? null : result.firstObstruction.distanceM,
        obstructionSource: result.firstObstruction === null ? null : result.firstObstruction.source,
      },
      samplingIntervalM: result.sampling.intervalMeters,
      sampleCount: result.sampling.sampleCount,
      distanceDefinition: result.distanceDefinition,
      artifactRefs: [published.artifact.ref],
      limitations: [...result.limitations],
    })
    return {
      status: result.status,
      surface: { ref: surfaceRef, revision: resource.contentDigest, vertical, horizontal_crs: resolvedSpec.surface.horizontalCrs },
      observer_elevation_m: round6(result.observerElevationM),
      target_elevation_m: round6(result.targetElevationM),
      first_obstruction: result.firstObstruction === null ? null : {
        sample_index: result.firstObstruction.sampleIndex,
        distance_m: round6(result.firstObstruction.distanceM),
        ray_elevation_m: round6(result.firstObstruction.rayElevationM),
        obstacle_elevation_m: round6(result.firstObstruction.obstacleElevationM),
        source: result.firstObstruction.source,
      },
      min_clearance_m: round6(result.minClearanceM),
      horizontal_distance_m: round6(result.horizontalDistanceM),
      slant_distance_m: round6(result.slantDistanceM),
      clearance_uncertainty_m: round6(result.clearanceUncertaintyM),
      curvature: result.curvature,
      distance_definition: result.distanceDefinition,
      sampling: result.sampling,
      artifact_ref: published.artifact.ref,
      limitations: result.limitations,
      meta,
    } as unknown as JsonValue
  },
})

/** Resolve the optional building/voxel obstacle bindings from raw args. */
async function resolveObstacleResources(
  catalog: ReturnType<typeof catalogServiceOf>,
  rawArgs: Record<string, unknown>,
  surface: TerrainSurface,
): Promise<ResolvedObstacles> {
  const inputRefs: string[] = []
  const authorizations: string[] = []
  let buildings: BuildingsBinding | undefined
  let buildingsFeatures
  if (rawArgs.buildings_ref !== undefined) {
    const buildingsRef = rawArgs.buildings_ref
    if (typeof buildingsRef !== 'string' || buildingsRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'buildings_ref must be an exact resource ref res-…@vN')
    }
    if (buildingsRef === rawArgs.surface_ref) {
      throw new SpatialError('INVALID_ARGUMENT', 'buildings_ref must differ from surface_ref')
    }
    const heightField = rawArgs.height_field === undefined ? 'height' : rawArgs.height_field
    if (typeof heightField !== 'string' || heightField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'height_field must be a nonempty property name')
    }
    const base = rawArgs.building_base === undefined ? 'terrain' : rawArgs.building_base
    if (base !== 'terrain' && base !== 'absolute') {
      throw new SpatialError('INVALID_ARGUMENT', 'building_base must be "terrain" or "absolute"')
    }
    const baseField = rawArgs.base_field
    if (base === 'absolute' && (typeof baseField !== 'string' || baseField.length === 0)) {
      throw new SpatialError('INVALID_ARGUMENT', 'building_base="absolute" requires base_field')
    }
    if (base === 'terrain' && baseField !== undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'base_field applies to building_base="absolute" only')
    }
    const { bytes, resource } = await catalog.readResourceBytes(buildingsRef, catalog.deploymentDomain(), MAX_TERRAIN_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    buildingsFeatures = admitted.collection.features as Parameters<typeof buildTerrainObstacles>[1]
    buildings = {
      ref: buildingsRef,
      revision: resource.contentDigest,
      heightField,
      base,
      ...(base === 'absolute' ? { baseField: baseField as string } : {}),
    } satisfies BuildingsBinding
    inputRefs.push(buildingsRef)
    authorizations.push(resource.authorization)
  }
  let voxels
  let voxelsFeatures
  if (rawArgs.voxels_ref !== undefined) {
    const voxelsRef = rawArgs.voxels_ref
    if (typeof voxelsRef !== 'string' || voxelsRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'voxels_ref must be an exact resource ref res-…@vN')
    }
    if (voxelsRef === rawArgs.surface_ref || voxelsRef === rawArgs.buildings_ref) {
      throw new SpatialError('INVALID_ARGUMENT', 'voxels_ref must differ from the surface and buildings refs')
    }
    const zField = rawArgs.z_field === undefined ? 'z' : rawArgs.z_field
    if (typeof zField !== 'string' || zField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'z_field must be a nonempty property name')
    }
    const cellMeters = rawArgs.voxel_cell_m
    if (typeof cellMeters !== 'number' || !Number.isFinite(cellMeters) || cellMeters <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'voxel_cell_m must be a positive number with voxels_ref')
    }
    const { bytes, resource } = await catalog.readResourceBytes(voxelsRef, catalog.deploymentDomain(), MAX_TERRAIN_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    voxelsFeatures = admitted.collection.features as Parameters<typeof buildTerrainObstacles>[3]
    voxels = { ref: voxelsRef, revision: resource.contentDigest, zField, cellMeters }
    inputRefs.push(voxelsRef)
    authorizations.push(resource.authorization)
  }
  if (buildings === undefined && voxels === undefined) {
    return { obstacles: { buildings: [], voxels: [] }, inputRefs, authorizations }
  }
  const built = buildTerrainObstacles(buildings, buildingsFeatures, voxels, voxelsFeatures, surface)
  requireCleanSurface(built.issues)
  return {
    obstacles: built.obstacles as TerrainObstacles,
    inputRefs,
    authorizations,
  }
}

/**
 * `terrain_viewshed`: compute the area viewshed around one observer over a
 * registered terrain grid — a deterministic target lattice, the exact
 * single-sightline core per target (same sampling, curvature, uncertainty),
 * and honest per-target verdicts with tallies. The full target table
 * publishes as an artifact citing the surface version; the model summary
 * carries the tallies and the bounded near-field rows. The same
 * TERRAIN_VERSION_CONFLICT check applies when a preview layer is named.
 */
export const terrainViewshed = defineTool({
  name: 'terrain_viewshed',
  description:
    'Compute the area viewshed around one observer over a registered terrain grid (res-…@vN): a deterministic '
    + 'lattice of ground targets within radius_m runs the same line-of-sight core per target — identical sampling, '
    + 'curvature/refraction, uncertainty band, and refusal semantics — and reports per-target visible/blocked/'
    + 'indeterminate/outside with tallies. Off-surface lattice points tally as outside, never as invisible. '
    + 'The full table publishes as an artifact citing the surface version. Pass layer_id to refuse when the '
    + 'displayed terrain version is not this one.',
  parameters: {
    surface_ref: { type: 'string', required: true, description: 'Exact surface resource ref, `res-…@vN` (registered point grid).' },
    vertical_datum: { type: 'string', required: true, description: 'Named vertical datum of the surface elevations.' },
    vertical_units: { type: 'string', required: true, description: 'Vertical unit; "m" is the supported unit.' },
    vertical_epoch: { type: 'string', required: true, description: 'Datum epoch or the literal "none".' },
    elevation_field: { type: 'string', description: 'Elevation property; "elevation" is the recorded default.' },
    observer: { type: 'array', required: true, description: 'WGS84 [lon, lat] of the observer.', items: { type: 'number' } },
    observer_height_m: { type: 'number', description: 'Observer height above the terrain; 0 is the recorded default.' },
    observer_elevation_m: { type: 'number', description: 'Absolute observer elevation override.' },
    radius_m: { type: 'number', required: true, description: 'Area radius in meters, up to 20000 (the viewshed bound).' },
    max_targets: { type: 'number', description: 'Lattice target bound in [1, 512]; 512 is the recorded default. Nearest targets answer first.' },
    sampling_interval_m: { type: 'number', description: 'Per-sightline sample spacing in meters; 25 is the recorded default.' },
    surface_sigma_m: { type: 'number', required: true, description: 'Surface elevation one-sigma in meters; the per-target indeterminate band derives from it.' },
    curvature: { type: 'string', description: '"corrected" (recorded default) or "none".' },
    refraction_k: { type: 'number', description: 'Refraction coefficient with curvature=corrected; 0.13 is the recorded default.' },
    buildings_ref: { type: 'string', description: 'Optional building-footprint resource ref.' },
    height_field: { type: 'string', description: 'Building height property with buildings_ref.' },
    layer_id: { type: 'string', description: 'Terrain-preview layer id to check against; refuses when its revision differs from the computed one.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderTerrainJson(value),
    presentationMeta: (_args, value) => terrainPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const rawArgs = args as Record<string, unknown>
    const surfaceRef = requireString(rawArgs, 'surface_ref', 'bind one exact surface version res-…@vN')
    const parsed = parseCatalogRef(surfaceRef)
    if (parsed.kind !== 'resource') {
      throw new SpatialError('INVALID_ARGUMENT', 'the viewshed binds a registered surface resource (res-…@vN); artifacts are not terrain surfaces')
    }
    const vertical = resolveVertical(rawArgs)
    const surfaceSigma = rawArgs.surface_sigma_m
    if (typeof surfaceSigma !== 'number' || !Number.isFinite(surfaceSigma) || surfaceSigma < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'surface_sigma_m is required (finite, nonnegative): the verdict is only as good as the declared surface accuracy')
    }
    const radiusRaw = rawArgs.radius_m
    if (typeof radiusRaw !== 'number' || !Number.isFinite(radiusRaw) || radiusRaw <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'radius_m must be a positive finite number of meters')
    }
    const maxTargetsRaw = rawArgs.max_targets
    const maxTargets = maxTargetsRaw === undefined ? MAX_VIEWSHED_TARGETS : maxTargetsRaw
    if (typeof maxTargets !== 'number' || !Number.isInteger(maxTargets)) {
      throw new SpatialError('INVALID_ARGUMENT', 'max_targets must be an integer')
    }
    const intervalRaw = rawArgs.sampling_interval_m
    const intervalM = intervalRaw === undefined ? 25 : intervalRaw
    if (typeof intervalM !== 'number' || !Number.isFinite(intervalM) || intervalM <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'sampling_interval_m must be a positive number')
    }
    const curvatureRaw = rawArgs.curvature === undefined ? 'corrected' : rawArgs.curvature
    if (curvatureRaw !== 'corrected' && curvatureRaw !== 'none') {
      throw new SpatialError('INVALID_ARGUMENT', 'curvature must be "corrected" or "none"')
    }
    const elevationField = rawArgs.elevation_field === undefined ? 'elevation' : rawArgs.elevation_field
    if (typeof elevationField !== 'string' || elevationField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'elevation_field must be a nonempty property name')
    }

    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], 'terrain_viewshed')

    const spec: TerrainSpec = {
      methodVersion: TERRAIN_METHOD_VERSION,
      surface: { ref: surfaceRef, revision: 'pending-read', elevationField, horizontalCrs: 'EPSG:4326', vertical },
      curvature: curvatureRaw === 'none'
        ? { kind: 'none' }
        : { kind: 'refraction-corrected', refractionK: rawArgs.refraction_k === undefined ? DEFAULT_REFRACTION_K : rawArgs.refraction_k as number },
      accuracy: { surfaceMeters: surfaceSigma, observerMeters: rawArgs.endpoint_sigma_m === undefined ? 0 : rawArgs.endpoint_sigma_m as number, targetMeters: 0 },
      sampling: { intervalMeters: intervalM, maxSamples: DEFAULT_MAX_SAMPLES },
      ...resolveControlPoints(rawArgs),
    }
    requireCleanSpec(validateTerrainSpec(spec))

    const observer = resolveEndpoint(rawArgs, 'observer')
    if (rawArgs.target !== undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'terrain_viewshed takes radius_m, not a single target; use geo_line_of_sight for one sightline')
    }

    const { resource, bytes } = await catalog.readResourceBytes(surfaceRef, catalog.deploymentDomain(), MAX_TERRAIN_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    const built = buildTerrainSurface({ ...spec.surface, revision: resource.contentDigest, horizontalCrs: resource.nativeCrs }, admitted.collection.features as Parameters<typeof buildTerrainSurface>[1])
    requireCleanSurface(built.issues)
    const surface: TerrainSurface = built.surface as TerrainSurface

    const obstacles = await resolveObstacleResources(catalog, rawArgs, surface)

    const layerId = rawArgs.layer_id
    if (layerId !== undefined) {
      if (typeof layerId !== 'string' || layerId.length === 0) throw new SpatialError('INVALID_ARGUMENT', 'layer_id must be a layer id')
      const layer = mapServiceOf(exec).stateOf(session).layers.find(candidate => candidate.id === layerId)
      if (layer === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `unknown layer ${layerId}; map_get_state lists the loaded layers`)
      }
      if (layer.terrain === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `layer ${layerId} is not a terrain preview; terrain_add_layer loads one`)
      }
      if (!revisionsMatch(
        { ref: surfaceRef, revision: resource.contentDigest },
        { ref: layer.terrain.surfaceRef, revision: layer.terrain.revision },
      )) {
        throw new SpatialError('TERRAIN_VERSION_CONFLICT', `layer ${layerId} displays ${layer.terrain.surfaceRef}@${layer.terrain.revision.slice(0, 12)} but this analysis resolved ${surfaceRef}@${resource.contentDigest.slice(0, 12)}; re-add the layer or pin the analysis to the displayed version`)
      }
    }

    const resolvedSpec: TerrainSpec = { ...spec, surface: { ...spec.surface, revision: resource.contentDigest, horizontalCrs: resource.nativeCrs } }
    exec.signal.throwIfAborted()
    const run = computeViewshed(resolvedSpec, surface, obstacles.obstacles, observer, radiusRaw, maxTargets)
    if (run.status === 'refused') {
      throw new SpatialError('INVALID_ARGUMENT', `viewshed refused (${run.code}): ${run.message}`)
    }
    exec.signal.throwIfAborted()
    const result = run.result
    const artifactBytes = new TextEncoder().encode(JSON.stringify({
      spec: resolvedSpec,
      spec_digest: result.specDigest,
      result,
    }))
    const published = await catalog.publishArtifact({
      bytes: artifactBytes,
      inputRefs: [surfaceRef, ...obstacles.inputRefs],
      method: { algorithm: 'area-viewshed', units: 'meters', parameters: { methodVersion: TERRAIN_METHOD_VERSION, specDigest: result.specDigest, radiusM: radiusRaw, maxTargets } },
      analysisCrs: resolvedSpec.surface.horizontalCrs,
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [resource.authorization, ...obstacles.authorizations],
    })
    const artifactRef = published.artifact.ref
    const nearRows = result.targets.slice(0, 24).map((target: (typeof result.targets)[number]) => ({
      lon: target.lon,
      lat: target.lat,
      distance_m: Math.round(target.distanceM),
      status: target.status,
      min_clearance_m: Number.isFinite(target.minClearanceM) ? Math.round(target.minClearanceM * 10) / 10 : null,
    }))
    return {
      artifact_ref: artifactRef,
      surface_ref: surfaceRef,
      method_version: result.methodVersion,
      radius_m: result.radiusM,
      lattice_step_m: Math.round(result.latticeStepM * 10) / 10,
      target_count: result.targets.length,
      tallies: result.tallies,
      curvature: result.curvature.kind,
      sampling_interval_m: result.sampling.intervalMeters,
      near_rows: nearRows,
      limitations: [...result.limitations],
      meta: buildTerrainLosMeta({
        tool: 'terrain_viewshed',
        status: 'succeeded',
        methodVersion: TERRAIN_METHOD_VERSION,
        surfaceRef,
        surfaceRevision: resource.contentDigest,
        vertical,
        horizontalCrs: resolvedSpec.surface.horizontalCrs,
        specDigest: result.specDigest,
        headline: { verdict: 'viewshed', obstructionDistanceM: null, obstructionSource: null },
        samplingIntervalM: result.sampling.intervalMeters,
        sampleCount: result.targets.length,
        distanceDefinition: 'local-tangent-plane',
        artifactRefs: [artifactRef],
        limitations: [...result.limitations],
      }),
    } as unknown as JsonValue
  },
})
