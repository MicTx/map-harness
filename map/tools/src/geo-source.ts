/**
 * Workspace GeoJSON access shared by every map tool. The mounted filesystem
 * provider owns target identity and bounded reads; this module adds the
 * session-workspace containment and GeoJSON resource limits required before a
 * dataset may enter map state or spatial analysis. Every admission failure is
 * a {@link GeoJsonInputError} whose text starts with a stable
 * `SpatialErrorCode`, so model-facing error results stay machine-readable.
 */
import { constants as fsConstants, fstatSync, openSync, readSync, closeSync } from 'node:fs'
import { isAbsolute, join as joinPath, relative, resolve as resolvePath, sep } from 'node:path'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { isWgs84FamilyCrs, validateGeoJsonProperties, validateGeoJsonValue } from '@map-harness/spatial-catalog'
import proj4 from 'proj4'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'

/** Maximum GeoJSON bytes one tool call may read. */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** Maximum features retained from one GeoJSON file. */
const MAX_FEATURES = 10_000
/** Maximum coordinate tuples traversed in one GeoJSON file. */
const MAX_COORDINATE_TUPLES = 100_000
/** Maximum nested coordinate-array depth. */
const MAX_GEOMETRY_DEPTH = 16

/** Geometry types this map layer already renders and analyzes. */
const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
])

/**
 * Stable model-facing GeoJSON input failure; its message never contains a
 * host path. The text is `<code>: <diagnostics>`.
 */
class GeoJsonInputError extends SpatialError {}

/**
 * proj4 definition strings for the CGCS2000 3-degree Gauss-Kruger zones the
 * deployments of this harness actually touch. proj4 ships no EPSG dictionary,
 * so EPSG codes outside this table must arrive as explicit `+proj=` strings.
 */
const CGCS2000_3D = (cm: number): string =>
  `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=500000 +y_0=0 +a=6378137 +rf=298.257222101 +units=m +no_defs`

/** EPSG code to proj4 definition, consulted before plain-EPSG passthrough. */
const CRS_TABLE = new Map<string, string>()
for (let zone = 25; zone <= 45; zone++) {
  CRS_TABLE.set(`EPSG:${4534 + zone - 25}`, CGCS2000_3D(zone * 3))
}

/** How one tool call names the data it wants. */
export interface GeoSource {
  /** Path to the GeoJSON file; it must resolve inside the session workspace. */
  readonly path: string
  /** Source CRS of the file, for example `EPSG:4547`; defaults to WGS84. */
  readonly crs?: string
}

/** One loaded dataset: WGS84 features plus source metadata. */
export interface LoadedGeoData {
  readonly data: GeoJsonFeatureCollection
  readonly sourceCrs: string
  readonly byteLength: number
}

/** The caller's session workspace root, or `undefined` for non-agent calls. */
export function sessionCwdOf(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/** Resolve the mounted filesystem without relying on agent-plane property injection. */
function filesystemOf(exec: ToolExecution): FileSystem {
  const filesystem = serviceOf<FileSystem>(exec, 'fs')
  if (filesystem === undefined) throw new GeoJsonInputError('SPATIAL_SERVICE_UNAVAILABLE', 'GeoJSON filesystem service is unavailable')
  return filesystem
}

/**
 * Parse one CRS label into a proj4 definition.
 * @param crs - declared source CRS.
 * @returns a proj4 definition usable in `proj4(from, to, coordinates)`.
 */
export function projDefinitionOf(crs: string): string {
  const trimmed = crs.trim().toUpperCase()
  if (trimmed.startsWith('+PROJ=')) return crs.trim()
  const fromTable = CRS_TABLE.get(trimmed)
  if (fromTable !== undefined) return fromTable
  if (trimmed.startsWith('EPSG:')) return trimmed
  throw new SpatialError('CRS_UNKNOWN', `unsupported CRS "${crs}"; use a +proj= string or a tabled EPSG code`)
}

/**
 * Reject a CRS label the projection engine cannot actually construct —
 * untabled EPSG codes pass {@link projDefinitionOf} verbatim but fail at
 * first transform, so callers that admit a CRS into durable state (catalog
 * registration) validate construction up front.
 * @param crs - declared source CRS.
 * @throws {SpatialError} `CRS_UNKNOWN` when the label cannot build a converter.
 */
export function assertCrsSupported(crs: string): void {
  try {
    proj4(projDefinitionOf(crs), 'EPSG:4326')
  } catch {
    throw new SpatialError('CRS_UNKNOWN', `unsupported CRS "${crs}"; use a +proj= string or a tabled EPSG code`)
  }
}

/**
 * Reproject one GeoJSON geometry's coordinate tuples from `from` to WGS84.
 * @param geometry - GeoJSON geometry object.
 * @param from - proj4 definition of the source CRS.
 * @returns a new geometry tree in WGS84 lon/lat; the input is not mutated.
 */
export function toWgs84(geometry: { type: string; coordinates?: unknown }, from: string): { type: string; coordinates?: unknown } {
  const project = (coords: unknown): unknown => {
    if (!Array.isArray(coords)) return coords
    const first = coords[0]
    const second = coords[1]
    if (coords.length >= 2 && typeof first === 'number' && typeof second === 'number') {
      const rest = coords.slice(2)
      const [lon, lat] = proj4(from, 'EPSG:4326', [first, second])
      return rest.length > 0 ? [lon, lat, ...rest] : [lon, lat]
    }
    return coords.map(project)
  }
  return { type: geometry.type, coordinates: project(geometry.coordinates) }
}

/** Optional deterministic point between path admission and descriptor open. */
let beforeDescriptorOpen: (() => void | Promise<void>) | undefined

/**
 * Install a test-only hook used to swap a checked path before descriptor open.
 * @param hook - callback, or undefined to remove it.
 */
export function setGeoSourceTestHook(hook: (() => void | Promise<void>) | undefined): void {
  beforeDescriptorOpen = hook
}

/** Close one descriptor without masking the original failure. */
function closeDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor)
  } catch (_error: unknown) {
    // The caller owns the original filesystem failure.
  }
}

/**
 * Open one absolute path without following a terminal symlink.
 *
 * `O_NOFOLLOW` makes the terminal-component rejection atomic at open time:
 * a regular file swapped for a symlink between admission and this open gets
 * `ELOOP`, never a read of the linked target. Intermediate components are
 * re-checked segment by segment in {@link readRootedNoFollow}; lexical
 * containment already confines those components to the workspace, so a swapped
 * intermediate link can only reach workspace-owned content, never an escape.
 *
 * @param path - absolute path whose final component must not be a symlink.
 * @param flags - open flags excluding no-follow.
 * @returns the opened descriptor.
 */
function openNoFollow(path: string, flags: number): number {
  return openSync(path, flags | fsConstants.O_NOFOLLOW)
}

/**
 * Read a regular file from an already opened no-follow descriptor.
 * @param descriptor - regular-file descriptor.
 * @param maxBytes - inclusive byte cap.
 * @returns the complete bounded content.
 */
function readDescriptor(descriptor: number, maxBytes: number): Uint8Array {
  const info = fstatSync(descriptor)
  if (!info.isFile()) throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON path must name a regular file')
  if (info.size > maxBytes) throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON file exceeds the ${maxBytes} byte limit`)
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (total <= maxBytes) {
    const count = readSync(descriptor, buffer, 0, buffer.length, total)
    if (count === 0) break
    total += count
    if (total > maxBytes) throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON file exceeds the ${maxBytes} byte limit`)
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total)
}

/**
 * Open a workspace-relative regular file without following any path component.
 *
 * Each prefix is re-opened with no-follow before descending, so a directory
 * segment swapped for a symlink is rejected at its own open; the final
 * component's rejection is atomic through `O_NOFOLLOW`. Directory descriptors
 * stay open only as the terminal-component anchor for that step.
 *
 * @param workspace - canonical workspace root.
 * @param requestedPath - workspace-relative path.
 * @param maxBytes - inclusive byte cap.
 * @returns bounded regular-file content.
 */
function readRootedNoFollow(workspace: string, requestedPath: string, maxBytes: number): Uint8Array {
  const segments = requestedPath.split(/[\\/]+/).filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON file must stay within the session workspace')
  }
  let directory = openNoFollow(workspace, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    const opened: number[] = []
    try {
      for (let index = 0; index < segments.length - 1; index += 1) {
        const child = openNoFollow(joinPath(workspace, ...segments.slice(0, index + 1)), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
        opened.push(child)
        directory = child
      }
      const file = openNoFollow(joinPath(workspace, ...segments), fsConstants.O_RDONLY)
      try {
        return readDescriptor(file, maxBytes)
      } finally {
        closeDescriptor(file)
      }
    } finally {
      for (const descriptor of opened) closeDescriptor(descriptor)
    }
  } finally {
    closeDescriptor(directory)
  }
}
function assertLexicalContainment(cwd: string, requestedPath: string): void {
  const candidate = isAbsolute(requestedPath) ? resolvePath(requestedPath) : resolvePath(cwd, requestedPath)
  const relation = relative(resolvePath(cwd), candidate)
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON file must stay within the session workspace')
  }
}

/** Read bounded file bytes after path, type, and containment admission. */
async function readWorkspaceBytes(source: GeoSource, exec: ToolExecution): Promise<Uint8Array> {
  return readBoundedWorkspaceFile(source, exec, MAX_FILE_BYTES)
}

/**
 * Read one workspace file's exact bytes after the full admission sequence
 * (containment, no-follow, type, size). The catalog registration path uses
 * this to copy source bytes verbatim, so the workspace-admission contract is
 * identical for analysis reads and registrations.
 * @param source - workspace path (and optional CRS, unused for the read).
 * @param exec - tool execution supplying session cwd, filesystem, and cancellation.
 * @param maxBytes - inclusive byte cap.
 * @returns the bounded file content.
 * @throws {GeoJsonInputError} with a stable `SpatialErrorCode` on every
 *   admission or read failure.
 */
export async function readBoundedWorkspaceFile(source: GeoSource, exec: ToolExecution, maxBytes: number): Promise<Uint8Array> {
  const cwd = sessionCwdOf(exec)
  if (cwd === undefined) throw new GeoJsonInputError('SPATIAL_SERVICE_UNAVAILABLE', 'GeoJSON tools require an agent session workspace')
  assertLexicalContainment(cwd, source.path)
  const filesystem = filesystemOf(exec)
  try {
    const pathInfo = await filesystem.lstat(source.path, { cwd }, exec.signal)
    if (pathInfo === undefined) throw new GeoJsonInputError('SPATIAL_SERVICE_UNAVAILABLE', 'GeoJSON file could not be read')
    if (pathInfo.type === 'symlink') throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON path must not be a symbolic link')
    if (pathInfo.type !== 'file') throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON path must name a regular file')
    if (pathInfo.size !== undefined && pathInfo.size > maxBytes) {
      throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON file exceeds the ${maxBytes} byte limit`)
    }
    const [workspace, target] = await Promise.all([
      filesystem.resolve(cwd, { signal: exec.signal }),
      filesystem.resolve(source.path, { cwd, signal: exec.signal }),
    ])
    if (!filesystem.contains(workspace, target)) {
      throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON file must stay within the session workspace')
    }
    const relativePath = relative(resolvePath(cwd), resolvePath(cwd, source.path))
    if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON file must stay within the session workspace')
    }
    await beforeDescriptorOpen?.()
    return readRootedNoFollow(resolvePath(cwd), relativePath, maxBytes)
  } catch (error: unknown) {
    if (error instanceof GeoJsonInputError) throw error
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') {
      throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON file exceeds the ${maxBytes} byte limit`)
    }
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'ELOOP' || code === 'EEXIST' || code === 'EMLINK') {
      throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON path must not be a symbolic link')
    }
    if (code === 'ENOTDIR' || code === 'EISDIR') throw new GeoJsonInputError('WORKSPACE_ESCAPE', 'GeoJSON path must name a regular file')
    if (exec.signal.aborted || (error instanceof FsError && error.code === 'FS_ABORTED')) {
      throw new GeoJsonInputError('CALL_CANCELED', 'GeoJSON file read was canceled')
    }
    throw new GeoJsonInputError('SPATIAL_SERVICE_UNAVAILABLE', `GeoJSON file could not be read (${String(code ?? 'unknown')})`)
  }
}

interface CoordinateBudget {
  count: number
  readonly enforceWgs84: boolean
}

/** Validate and count one nested coordinate array. */
function validateCoordinates(value: unknown, depth: number, budget: CoordinateBudget): void {
  if (depth > MAX_GEOMETRY_DEPTH) throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON geometry depth limit exceeded')
  if (!Array.isArray(value)) throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON geometry coordinates must be nested arrays')
  if (value.length === 0) return
  const first = value[0]
  const second = value[1]
  if (typeof first === 'number' && typeof second === 'number') {
    for (const coordinate of value) {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
        throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON coordinates must contain only finite numbers')
      }
    }
    budget.count += 1
    if (budget.count > MAX_COORDINATE_TUPLES) {
      throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON coordinate limit exceeded (${MAX_COORDINATE_TUPLES})`)
    }
    if (budget.enforceWgs84 && (first < -180 || first > 180 || second < -90 || second > 90)) {
      throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON coordinate is outside the WGS84 range')
    }
    return
  }
  for (const child of value) validateCoordinates(child, depth + 1, budget)
}

/** Validate the supported FeatureCollection and all geometry coordinates. */
function validateCollection(value: unknown, enforceWgs84: boolean): GeoJsonFeatureCollection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON file must contain a FeatureCollection')
  }
  const collection = value as Record<string, unknown>
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON file must contain a FeatureCollection')
  }
  if (collection.features.length > MAX_FEATURES) {
    throw new GeoJsonInputError('RESOURCE_TOO_LARGE', `GeoJSON feature limit exceeded (${MAX_FEATURES})`)
  }
  const budget: CoordinateBudget = { count: 0, enforceWgs84 }
  for (const featureValue of collection.features) {
    if (typeof featureValue !== 'object' || featureValue === null || Array.isArray(featureValue)) {
      throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON FeatureCollection contains an invalid feature')
    }
    const feature = featureValue as Record<string, unknown>
    if (feature.type !== 'Feature') throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON FeatureCollection contains an invalid feature')
    try {
      validateGeoJsonProperties(feature.properties)
    } catch {
      throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON feature properties must be bounded, finite JSON values')
    }
    if (feature.geometry === null) continue
    if (typeof feature.geometry !== 'object' || Array.isArray(feature.geometry)) {
      throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON feature contains an invalid geometry')
    }
    const geometry = feature.geometry as Record<string, unknown>
    if (typeof geometry.type !== 'string' || !GEOMETRY_TYPES.has(geometry.type)) {
      throw new GeoJsonInputError('GEOMETRY_UNSUPPORTED', 'GeoJSON feature uses an unsupported geometry type')
    }
    validateCoordinates(geometry.coordinates, 0, budget)
  }
  try {
    validateGeoJsonValue(value, { enforceWgs84Range: enforceWgs84 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'GeoJSON value failed canonical admission'
    const detail = message.replace(/^CATALOG_INVALID_INPUT:\s*/, '')
    throw new GeoJsonInputError('INVALID_GEOJSON', detail)
  }
  return value as GeoJsonFeatureCollection
}

/** Decode bounded UTF-8 JSON without exposing parser or host-path details. */
function parseGeoJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON file is not valid UTF-8')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new GeoJsonInputError('INVALID_GEOJSON', 'GeoJSON file is not valid JSON')
  }
}

/**
 * Normalize already-admitted GeoJSON bytes to a WGS84 collection using one
 * declared source CRS — the shared transform both the file-reading path and
 * the catalog display-copy path apply, so a resource and its source file
 * always produce identical display data.
 * @param bytes - GeoJSON file content.
 * @param sourceCrs - declared CRS of the bytes.
 * @returns the validated dataset in WGS84.
 * @throws {GeoJsonInputError} for malformed payloads; `SpatialError`
 *   `CRS_UNKNOWN` for untabled CRS labels.
 */
export function loadGeoJsonString(bytes: Uint8Array, sourceCrs: string): GeoJsonFeatureCollection {
  const parsed = parseGeoJson(bytes)
  if (isWgs84FamilyCrs(sourceCrs)) {
    return validateCollection(parsed, true)
  }
  const collection = validateCollection(parsed, false)
  const from = projDefinitionOf(sourceCrs)
  let features
  try {
    features = collection.features.map((feature) => {
      const geometry = feature.geometry as { type: string; coordinates?: unknown } | null
      if (geometry === null || geometry === undefined) return feature
      return { ...feature, geometry: toWgs84(geometry, from) }
    })
  } catch (error: unknown) {
    if (error instanceof SpatialError) throw error
    // proj4 rejects untabled EPSG labels and malformed +proj= definitions at
    // first use; surface the stable CRS code instead of its raw parse text.
    throw new SpatialError('CRS_UNKNOWN', `unsupported CRS "${sourceCrs}"; use a +proj= string or a tabled EPSG code`)
  }
  return validateCollection({ ...collection, features }, true)
}

/**
 * Read and normalize one workspace GeoJSON source.
 * @param source - workspace path and optional source CRS.
 * @param exec - tool execution supplying session cwd, filesystem, and cancellation.
 * @returns the validated dataset in WGS84.
 */
export async function loadGeoJson(source: GeoSource, exec: ToolExecution): Promise<LoadedGeoData> {
  const bytes = await readWorkspaceBytes(source, exec)
  const sourceCrs = source.crs ?? 'EPSG:4326'
  const data = loadGeoJsonString(bytes, sourceCrs)
  return {
    data,
    sourceCrs: isWgs84FamilyCrs(sourceCrs) ? 'EPSG:4326' : sourceCrs,
    byteLength: bytes.byteLength,
  }
}
