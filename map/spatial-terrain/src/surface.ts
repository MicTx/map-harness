/**
 * The versioned elevation surface and its obstacles: a lon/lat grid of
 * elevation samples built from the exact bound bytes, bilinear interpolation
 * inside the grid hull (never extrapolation), building footprints with
 * height/base rules, and occupied voxel cells. Every structural defect — an
 * incomplete grid, a duplicate point, a footprint without the height
 * property — is a named issue, never a silent skip: a hole in the terrain
 * model is exactly where an unverifiable "clear" answer would come from.
 *
 * The analysis plane is the local tangent plane at the observer
 * (x = R·Δλ·cos φ0 easting, y = R·Δφ northing), which is what makes the
 * line-of-sight geometry analytically checkable in meters. Its accuracy
 * degrades with distance, so paths beyond {@link MAX_PATH_DISTANCE_M} are
 * refused rather than answered with an undisclosed error.
 *
 * @module @map-harness/spatial-terrain/surface
 */
import {
  EARTH_RADIUS_M,
  MAX_PATH_DISTANCE_M,
  MAX_TERRAIN_FEATURES,
  type BuildingsBinding,
  type ControlPoint,
  type SurfaceBinding,
  type VoxelsBinding,
} from './contract.ts'

/** One raw feature as admitted from the bound resource bytes. */
export type RawFeature = {
  type?: 'Feature'
  id?: unknown
  geometry?: { type?: string; coordinates?: unknown } | null
  properties?: Record<string, unknown> | null
}

/** The stable codes a surface/obstacle/control-point defect carries. */
export type SurfaceIssueCode =
  | 'incomplete-grid'
  | 'duplicate-grid-point'
  | 'grid-point-invalid'
  | 'footprint-invalid'
  | 'footprint-outside-surface'
  | 'voxel-invalid'
  | 'resource-too-large'
  | 'control-point-outside-surface'

/** One structural surface/obstacle defect: which feature, a stable code, and why. */
export interface SurfaceIssue {
  readonly field: string
  readonly code: SurfaceIssueCode
  readonly message: string
}

/** The gridded elevation surface one computation samples. */
export interface TerrainSurface {
  readonly surfaceRef: string
  /** Content digest of the exact bytes this grid was built from. */
  readonly revision: string
  readonly horizontalCrs: string
  /** Ascending distinct longitudes of the grid columns. */
  readonly lons: number[]
  /** Ascending distinct latitudes of the grid rows. */
  readonly lats: number[]
  /** Row-major elevations (`lats.length × lons.length`), indexed `lat*lonCount + lon`. */
  readonly cells: Float64Array
  /** The number of grid points the source carried (equals cells.length when complete). */
  readonly pointCount: number
}

/** One building footprint with its resolved base and top elevations. */
export interface BuildingFootprint {
  /** Footprint ring in WGS84 lon/lat (unclosed, ≥ 3 points). */
  readonly ring: readonly (readonly [number, number])[]
  /** Base elevation (meters in the computation's vertical unit). */
  readonly baseM: number
  /** Top elevation = base + height. */
  readonly topM: number
}

/** One occupied voxel cell with its center and edge length. */
export interface VoxelCell {
  readonly lon: number
  readonly lat: number
  /** Center elevation of the occupied cell. */
  readonly zM: number
  /** Cubic cell edge length in meters. */
  readonly cellMeters: number
}

/** The obstacles one computation considers alongside the surface. */
export interface TerrainObstacles {
  readonly buildings: readonly BuildingFootprint[]
  readonly voxels: readonly VoxelCell[]
  readonly buildingsRef?: string
  readonly voxelsRef?: string
}

/** The local tangent plane one computation runs in (anchored at the observer). */
export interface TangentPlane {
  readonly lon0: number
  readonly lat0: number
  /** cos(lat0) at the anchor, precomputed. */
  readonly cosLat0: number
}

/**
 * Anchor the local tangent plane at one point.
 * @param lon - anchor longitude, degrees.
 * @param lat - anchor latitude, degrees.
 * @returns the plane constants behind the projection pair.
 */
export function planeAt(lon: number, lat: number): TangentPlane {
  return { lon0: lon, lat0: lat, cosLat0: Math.cos(lat * Math.PI / 180) }
}

/**
 * Project WGS84 degrees to plane meters (easting x, northing y).
 * @param plane - the anchored plane.
 * @param lon - longitude, degrees.
 * @param lat - latitude, degrees.
 * @returns the [x, y] meters pair.
 */
export function toPlane(plane: TangentPlane, lon: number, lat: number): [number, number] {
  const x = EARTH_RADIUS_M * (lon - plane.lon0) * Math.PI / 180 * plane.cosLat0
  const y = EARTH_RADIUS_M * (lat - plane.lat0) * Math.PI / 180
  return [x, y]
}

/**
 * Invert one plane point back to WGS84 degrees (for grid interpolation).
 * @param plane - the anchored plane.
 * @param x - easting, meters.
 * @param y - northing, meters.
 * @returns the [lon, lat] degrees pair.
 */
export function fromPlane(plane: TangentPlane, x: number, y: number): [number, number] {
  const lat = plane.lat0 + y * 180 / (EARTH_RADIUS_M * Math.PI)
  const lon = plane.lon0 + x * 180 / (EARTH_RADIUS_M * Math.PI * plane.cosLat0)
  return [lon, lat]
}

/**
 * Build the gridded surface from the admitted features of one bound version.
 * @param binding - the validated surface binding.
 * @param features - the raw features of the bound resource.
 * @returns the surface, or the structural issues that refuse it.
 */
export function buildTerrainSurface(
  binding: SurfaceBinding,
  features: readonly RawFeature[],
): { surface: TerrainSurface; issues: [] } | { surface: undefined; issues: SurfaceIssue[] } {
  if (features.length < 4) {
    return { surface: undefined, issues: [{ field: 'surface', code: 'incomplete-grid', message: `a grid needs at least 4 points; the bound version carries ${features.length}` }] }
  }
  if (features.length > MAX_TERRAIN_FEATURES) {
    return { surface: undefined, issues: [{ field: 'surface', code: 'resource-too-large', message: `surface exceeds the ${MAX_TERRAIN_FEATURES} point bound` }] }
  }
  const points: { lon: number; lat: number; z: number }[] = []
  const seen = new Set<string>()
  for (const [index, feature] of features.entries()) {
    const point = gridPointOf(feature, index, binding.elevationField)
    if ('issue' in point) return { surface: undefined, issues: [point.issue] }
    const key = `${point.point.lon},${point.point.lat}`
    if (seen.has(key)) {
      return { surface: undefined, issues: [{ field: `features[${index}]`, code: 'duplicate-grid-point', message: `two surface points share the coordinate (${point.point.lon}, ${point.point.lat}); a grid cell must hold exactly one sample` }] }
    }
    seen.add(key)
    points.push(point.point)
  }
  const lons = [...new Set(points.map(point => point.lon))].sort((a, b) => a - b)
  const lats = [...new Set(points.map(point => point.lat))].sort((a, b) => a - b)
  const lonIndex = new Map(lons.map((lon, at) => [lon, at]))
  const latIndex = new Map(lats.map((lat, at) => [lat, at]))
  if (points.length !== lons.length * lats.length) {
    return {
      surface: undefined,
      issues: [{
        field: 'surface',
        code: 'incomplete-grid',
        message: `the grid is incomplete: ${points.length} points placed on a ${lons.length}×${lats.length} lattice (${lons.length * lats.length} expected); holes are refused, never interpolated over`,
      }],
    }
  }
  const cells = new Float64Array(points.length)
  for (const point of points) {
    const latAt = latIndex.get(point.lat)
    const lonAt = lonIndex.get(point.lon)
    if (latAt === undefined || lonAt === undefined) {
      // Unreachable: both index maps are built from the same coordinate sets
      // this point was drawn from — fail loud rather than write out of place.
      return { surface: undefined, issues: [{ field: 'surface', code: 'grid-point-invalid', message: `point (${point.lon}, ${point.lat}) vanished from its own lattice index` }] }
    }
    cells[latAt * lons.length + lonAt] = point.z
  }
  return {
    surface: {
      surfaceRef: binding.ref,
      revision: binding.revision,
      horizontalCrs: binding.horizontalCrs,
      lons,
      lats,
      cells,
      pointCount: points.length,
    },
    issues: [],
  }
}

/** Resolve one grid-point feature. */
function gridPointOf(
  feature: RawFeature,
  index: number,
  elevationField: string,
): { point: { lon: number; lat: number; z: number } } | { issue: SurfaceIssue } {
  if (feature.geometry?.type !== 'Point') {
    return { issue: { field: `features[${index}]`, code: 'grid-point-invalid', message: `surface features must be Points; feature ${index} is ${feature.geometry?.type ?? 'geometry-less'}` } }
  }
  const coordinates = feature.geometry.coordinates as unknown
  if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number'
    || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
    return { issue: { field: `features[${index}]`, code: 'grid-point-invalid', message: `feature ${index} lacks finite lon/lat coordinates` } }
  }
  const raw = feature.properties?.[elevationField]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { issue: { field: `features[${index}].${elevationField}`, code: 'grid-point-invalid', message: `feature ${index} lacks a finite "${elevationField}" elevation` } }
  }
  return { point: { lon: coordinates[0], lat: coordinates[1], z: raw } }
}

/**
 * In-range lattice read. Every call site derives its index from the same
 * lattice lengths (binary search clamped into `[0, n−1]`), so an out-of-range
 * index is an invariant break and fails loud instead of reading `undefined`.
 */
function lattice(values: readonly number[], index: number): number {
  const value = values[index]
  if (value === undefined) throw new RangeError(`terrain lattice index ${index} out of range (${values.length} entries)`)
  return value
}

/** Float64 cell read with the same in-range guarantee as {@link lattice}. */
function cellAt(cells: Float64Array, index: number): number {
  const value = cells[index]
  if (value === undefined) throw new RangeError(`terrain cell index ${index} out of range (${cells.length} entries)`)
  return value
}

/**
 * Bilinear elevation at one coordinate, or `undefined` outside the grid hull
 * (interpolation never extrapolates: outside-hull ground is an honest
 * refusal, not a fabricated number).
 * @param surface - the gridded surface.
 * @param lon - longitude, degrees.
 * @param lat - latitude, degrees.
 * @returns the interpolated elevation, or `undefined` outside the hull.
 */
export function elevationAt(surface: TerrainSurface, lon: number, lat: number): number | undefined {
  const { lons, lats, cells } = surface
  const lonLast = lons.length - 1
  const latLast = lats.length - 1
  if (lons.length === 0 || lats.length === 0) return undefined
  if (lon < lattice(lons, 0) || lon > lattice(lons, lonLast) || lat < lattice(lats, 0) || lat > lattice(lats, latLast)) return undefined
  const lonRight = upperIndex(lons, lon)
  const latRight = upperIndex(lats, lat)
  const lonLeft = Math.max(0, lonRight - 1)
  const latLeft = Math.max(0, latRight - 1)
  const x0 = lattice(lons, lonLeft)
  const x1 = lattice(lons, lonRight)
  const y0 = lattice(lats, latLeft)
  const y1 = lattice(lats, latRight)
  const tx = x1 === x0 ? 0 : (lon - x0) / (x1 - x0)
  const ty = y1 === y0 ? 0 : (lat - y0) / (y1 - y0)
  const lonCount = lons.length
  const z00 = cellAt(cells, latLeft * lonCount + lonLeft)
  const z10 = cellAt(cells, latLeft * lonCount + lonRight)
  const z01 = cellAt(cells, latRight * lonCount + lonLeft)
  const z11 = cellAt(cells, latRight * lonCount + lonRight)
  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty
}

/** The smallest index whose value is ≥ target (binary search over an ascending array). */
function upperIndex(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (lattice(values, mid) < target) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Build the obstacle model from the admitted building/voxel features. Base
 * elevations resolve per the binding (`terrain` samples the surface under
 * the footprint centroid; `absolute` reads the base property).
 * @param buildings - the validated buildings binding, when present.
 * @param buildingsFeatures - the bound building features.
 * @param voxels - the validated voxels binding, when present.
 * @param voxelsFeatures - the bound voxel features.
 * @param surface - the built surface (the terrain-base rule samples it).
 * @returns the obstacles, or the structural issues that refuse them.
 */
export function buildTerrainObstacles(
  buildings: BuildingsBinding | undefined,
  buildingsFeatures: readonly RawFeature[] | undefined,
  voxels: VoxelsBinding | undefined,
  voxelsFeatures: readonly RawFeature[] | undefined,
  surface: TerrainSurface,
): { obstacles: TerrainObstacles; issues: [] } | { obstacles: undefined; issues: SurfaceIssue[] } {
  const footprints: BuildingFootprint[] = []
  if (buildings !== undefined && buildingsFeatures !== undefined) {
    if (buildingsFeatures.length > MAX_TERRAIN_FEATURES) {
      return { obstacles: undefined, issues: [{ field: 'buildings', code: 'resource-too-large', message: `buildings exceed the ${MAX_TERRAIN_FEATURES} feature bound` }] }
    }
    for (const [index, feature] of buildingsFeatures.entries()) {
      const footprint = buildingOf(feature, index, buildings, surface)
      if ('issue' in footprint) return { obstacles: undefined, issues: [footprint.issue] }
      footprints.push(footprint.footprint)
    }
  }
  const cells: VoxelCell[] = []
  if (voxels !== undefined && voxelsFeatures !== undefined) {
    if (voxelsFeatures.length > MAX_TERRAIN_FEATURES) {
      return { obstacles: undefined, issues: [{ field: 'voxels', code: 'resource-too-large', message: `voxels exceed the ${MAX_TERRAIN_FEATURES} cell bound` }] }
    }
    for (const [index, feature] of voxelsFeatures.entries()) {
      const cell = voxelOf(feature, index, voxels)
      if ('issue' in cell) return { obstacles: undefined, issues: [cell.issue] }
      cells.push(cell.cell)
    }
  }
  return {
    obstacles: {
      buildings: footprints,
      voxels: cells,
      ...(buildings !== undefined ? { buildingsRef: buildings.ref } : {}),
      ...(voxels !== undefined ? { voxelsRef: voxels.ref } : {}),
    },
    issues: [],
  }
}

/** Resolve one building feature into its footprint. */
function buildingOf(
  feature: RawFeature,
  index: number,
  binding: BuildingsBinding,
  surface: TerrainSurface,
): { footprint: BuildingFootprint } | { issue: SurfaceIssue } {
  if (feature.geometry?.type !== 'Polygon') {
    return { issue: { field: `buildings[${index}]`, code: 'footprint-invalid', message: `building features must be Polygons; feature ${index} is ${feature.geometry?.type ?? 'geometry-less'}` } }
  }
  const rings = feature.geometry.coordinates as unknown
  const outer = Array.isArray(rings) ? rings[0] : undefined
  if (!Array.isArray(outer) || outer.length < 3) {
    return { issue: { field: `buildings[${index}]`, code: 'footprint-invalid', message: `building ${index} has no outer ring of at least 3 points` } }
  }
  const height = feature.properties?.[binding.heightField]
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) {
    return { issue: { field: `buildings[${index}].${binding.heightField}`, code: 'footprint-invalid', message: `building ${index} lacks a finite nonnegative "${binding.heightField}" height` } }
  }
  const ring: [number, number][] = []
  for (const point of outer as unknown[]) {
    if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
      return { issue: { field: `buildings[${index}]`, code: 'footprint-invalid', message: `building ${index} ring points must be finite lon/lat pairs` } }
    }
    ring.push([point[0], point[1]])
  }
  let base: number
  if (binding.base === 'absolute') {
    const raw = feature.properties?.[binding.baseField as string]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { issue: { field: `buildings[${index}].${binding.baseField as string}`, code: 'footprint-invalid', message: `building ${index} lacks a finite "${binding.baseField as string}" base elevation` } }
    }
    base = raw
  } else {
    let sx = 0
    let sy = 0
    for (const [lon, lat] of ring) {
      sx += lon
      sy += lat
    }
    const ground = elevationAt(surface, sx / ring.length, sy / ring.length)
    if (ground === undefined) {
      return { issue: { field: `buildings[${index}]`, code: 'footprint-outside-surface', message: `building ${index} sits outside the surface grid; its terrain base is unknowable` } }
    }
    base = ground
  }
  return { footprint: { ring, baseM: base, topM: base + height } }
}

/** Resolve one voxel feature into its occupied cell. */
function voxelOf(
  feature: RawFeature,
  index: number,
  binding: VoxelsBinding,
): { cell: VoxelCell } | { issue: SurfaceIssue } {
  if (feature.geometry?.type !== 'Point') {
    return { issue: { field: `voxels[${index}]`, code: 'voxel-invalid', message: `voxel features must be Points at cell centers; feature ${index} is ${feature.geometry?.type ?? 'geometry-less'}` } }
  }
  const coordinates = feature.geometry.coordinates as unknown
  if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') {
    return { issue: { field: `voxels[${index}]`, code: 'voxel-invalid', message: `voxel ${index} lacks finite lon/lat coordinates` } }
  }
  const z = feature.properties?.[binding.zField]
  if (typeof z !== 'number' || !Number.isFinite(z)) {
    return { issue: { field: `voxels[${index}].${binding.zField}`, code: 'voxel-invalid', message: `voxel ${index} lacks a finite "${binding.zField}" center elevation` } }
  }
  return {
    cell: { lon: coordinates[0], lat: coordinates[1], zM: z, cellMeters: binding.cellMeters },
  }
}

/**
 * Whether one plane point sits inside a footprint ring (ray casting on the
 * tangent plane; the ring is closed implicitly).
 * @param polygon - the ring in plane meters.
 * @param x - easting of the sample.
 * @param y - northing of the sample.
 * @returns true when the point is inside.
 */
export function insideFootprint(polygon: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false
  for (let at = 0, before = polygon.length - 1; at < polygon.length; before = at++) {
    const [xi, yi] = vertexAt(polygon, at)
    const [xb, yb] = vertexAt(polygon, before)
    const crosses = (yi > y) !== (yb > y)
    if (crosses && x < ((xb - xi) * (y - yi)) / (yb - yi) + xi) inside = !inside
  }
  return inside
}

/** In-range ring vertex read (indices derive from the ring length itself). */
function vertexAt(polygon: readonly (readonly [number, number])[], index: number): readonly [number, number] {
  const vertex = polygon[index]
  if (vertex === undefined) throw new RangeError(`footprint ring index ${index} out of range (${polygon.length} vertices)`)
  return vertex
}

/** One control-point check outcome. */
export interface ControlPointDelta {
  readonly id: string
  readonly lon: number
  readonly lat: number
  readonly surveyedM: number
  readonly surfaceM: number
  readonly deltaM: number
}

/**
 * Check surveyed control points against the surface grid (bilinear at each
 * point). A point outside the hull is a refusal — a control point the
 * surface cannot see cannot certify it.
 * @param surface - the built surface.
 * @param controlPoints - the surveyed points.
 * @returns per-point deltas with a tolerance verdict helper, or the refusal.
 */
export function checkControlPoints(
  surface: TerrainSurface,
  controlPoints: readonly ControlPoint[],
): { ok: true; deltas: readonly ControlPointDelta[]; withinTolerance: (toleranceM: number) => boolean } | { ok: false; issues: SurfaceIssue[] } {
  const deltas: ControlPointDelta[] = []
  for (const point of controlPoints) {
    const surfaceM = elevationAt(surface, point.lon, point.lat)
    if (surfaceM === undefined) {
      return {
        ok: false,
        issues: [{ field: `controlPoints[${point.id}]`, code: 'control-point-outside-surface', message: `control point ${point.id} lies outside the surface grid hull` }],
      }
    }
    deltas.push({
      id: point.id,
      lon: point.lon,
      lat: point.lat,
      surveyedM: point.elevationM,
      surfaceM,
      deltaM: surfaceM - point.elevationM,
    })
  }
  return {
    ok: true,
    deltas,
    withinTolerance: (toleranceM: number) => deltas.every(delta => Math.abs(delta.deltaM) <= toleranceM),
  }
}

/** The surface/obstacle model one line-of-sight run consumes. */
export interface AnalysisModel {
  readonly surface: TerrainSurface
  readonly obstacles: TerrainObstacles
}

/**
 * Derive the bounded WGS84 display grid of one built surface: evenly spaced
 * lattice rows/columns (both grid corners always kept) that never exceeds
 * `cap` Point features, each carrying the surface's own elevation under
 * `elevationField`. This is the 2D-preview/3D-display copy — the analysis
 * surface stays the built grid, never this decimation.
 * @param surface - the built surface grid.
 * @param elevationField - the property name the display points carry the elevation under.
 * @param cap - the maximum number of display points (≥ 4).
 * @returns the bounded display FeatureCollection and the grid's true point count.
 */
export function surfaceDisplayPoints(
  surface: TerrainSurface,
  elevationField: string,
  cap: number,
): { features: RawFeature[]; totalPointCount: number } {
  if (cap < 4) throw new RangeError(`display cap must be at least 4, got ${cap}`)
  const total = surface.lons.length * surface.lats.length
  const scale = total <= cap ? 1 : Math.sqrt(cap / total)
  const lonIndices = evenIndices(surface.lons.length, Math.max(2, Math.floor(surface.lons.length * scale)))
  const latIndices = evenIndices(surface.lats.length, Math.max(2, Math.floor(surface.lats.length * scale)))
  const features: RawFeature[] = []
  for (const lat of latIndices) {
    for (const lon of lonIndices) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lattice(surface.lons, lon), lattice(surface.lats, lat)] },
        properties: { [elevationField]: cellAt(surface.cells, lat * surface.lons.length + lon) },
      })
    }
  }
  return { features, totalPointCount: total }
}

/** Evenly spaced indices over `[0, n)`, count-bounded, always including both ends. */
function evenIndices(n: number, count: number): number[] {
  if (n <= count) return Array.from({ length: n }, (_, at) => at)
  const picked = new Set<number>()
  for (let at = 0; at < count; at++) {
    picked.add(Math.round(at * (n - 1) / (count - 1)))
  }
  return [...picked].sort((a, b) => a - b)
}

/** The farthest path distance the local tangent plane answers for (meters). */
export { MAX_PATH_DISTANCE_M }
