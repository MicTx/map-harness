/**
 * The catalog's own GeoJSON admission: structural validation, resource
 * budgets, schema extraction, extent computation, and deterministic feature
 * refs derived from the actual stored bytes. The durable boundary validates
 * what it stores — the tool boundary has already admitted the source path and
 * the declared CRS; this module never trusts either beyond the bytes
 * themselves.
 *
 * @module @map-harness/spatial-catalog/geojson
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { CatalogError } from './errors.ts'
import { sha256BytesHex, type FeatureRef } from './refs.ts'
import type { FeatureRefEntry } from './types.ts'

/** Maximum bytes one registered resource may store. */
export const MAX_REGISTER_BYTES = 32 * 1024 * 1024
/** Maximum features one registered collection may carry. */
export const MAX_REGISTER_FEATURES = 10_000
/** Maximum coordinate tuples traversed in one registration. */
export const MAX_REGISTER_COORDINATES = 100_000
/** Maximum nested coordinate-array depth. */
export const MAX_REGISTER_DEPTH = 16
/** Maximum nesting depth for one feature's properties JSON value. */
export const MAX_PROPERTY_DEPTH = 8
/** Maximum UTF-8 bytes in one feature's properties value. */
export const MAX_FEATURE_PROPERTIES_BYTES = 64 * 1024

/** Geometry types the analysis and display layers operate on. */
const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
])

/** The geometry types a map occurrence can construct as ArcGIS graphics. */
export const DISPLAY_GEOMETRY_TYPES = ['Point', 'LineString', 'Polygon'] as const

/** Options shared by catalog, tool, collaboration, and projection admission. */
export interface GeoJsonAdmissionOptions {
  readonly enforceWgs84Range: boolean
  /** Restrict geometry types when the value is entering the display plane. */
  readonly allowedGeometryTypes?: ReadonlySet<string>
}

/** The structural result of validating an already-parsed GeoJSON value. */
export interface ValidatedGeoJsonValue {
  readonly collection: { type: 'FeatureCollection'; features: unknown[] }
  readonly featureCount: number
  readonly geometryTypes: readonly string[]
  readonly coordinateCount: number
}

/** The canonical schema record a schema digest freezes. */
export interface ResourceSchemaRecord {
  readonly fields: readonly { readonly name: string; readonly type: string }[]
  readonly geometryTypes: readonly string[]
}

/** One admitted collection: parsed structure plus the identities registration publishes. */
export interface AdmittedCollection {
  readonly collection: { type: 'FeatureCollection'; features: unknown[] }
  readonly featureCount: number
  readonly geometryTypes: readonly string[]
  readonly fields: readonly { readonly name: string; readonly type: string }[]
  readonly extent: readonly [number, number, number, number] | null
  readonly schemaDigest: string
  readonly featureRefs: readonly FeatureRefEntry[]
  readonly coordinateCount: number
}

/**
 * Validate and structure one candidate resource payload.
 * @param bytes - the exact bytes that will be stored.
 * @param options - `enforceWgs84Range` rejects coordinates outside the
 *   geographic range (set by the caller for WGS84-family declarations).
 * @returns the admitted collection with its digests and feature identities.
 * @throws {CatalogError} `CATALOG_INVALID_INPUT` for every structural,
 *   budget, or range violation; `CATALOG_IO` never arises here.
 */
export function admitCollection(bytes: Uint8Array, options: GeoJsonAdmissionOptions): AdmittedCollection {
  if (bytes.byteLength > MAX_REGISTER_BYTES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `resource payload exceeds the ${MAX_REGISTER_BYTES} byte limit`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'resource payload is not valid UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'resource payload is not valid JSON')
  }
  const validated = validateGeoJsonValue(parsed, options)
  const candidate = validated.collection

  const geometryTypes: string[] = []
  const fieldTypes = new Map<string, string>()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let coordinateCount = 0
  const featureRefs: FeatureRefEntry[] = []

  candidate.features.forEach((featureValue, featureIndex) => {
    if (typeof featureValue !== 'object' || featureValue === null || Array.isArray(featureValue)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'collection contains an invalid feature')
    }
    const feature = featureValue as Record<string, unknown>
    if (feature.type !== 'Feature') {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'collection contains an invalid feature')
    }
    collectFieldTypes(feature.properties, fieldTypes)
    if (feature.geometry === null || feature.geometry === undefined) {
      featureRefs.push({ featureRef: featureRefOf(feature), originalId: originalIdOf(feature), featureIndex })
      return
    }
    if (typeof feature.geometry !== 'object' || Array.isArray(feature.geometry)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'feature contains an invalid geometry')
    }
    const geometry = feature.geometry as Record<string, unknown>
    if (typeof geometry.type !== 'string' || !GEOMETRY_TYPES.has(geometry.type)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `unsupported geometry type "${String(geometry.type).slice(0, 40)}"`)
    }
    if (!geometryTypes.includes(geometry.type)) geometryTypes.push(geometry.type)
    coordinateCount += walkCoordinates(geometry.coordinates, 0, options, (x, y) => {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    })
    featureRefs.push({ featureRef: featureRefOf(feature), originalId: originalIdOf(feature), featureIndex })
  })

  const schemaRecord: ResourceSchemaRecord = {
    fields: [...fieldTypes.entries()].map(([name, type]) => ({ name, type })).sort(byName),
    geometryTypes: [...geometryTypes].sort(),
  }
  return {
    collection: candidate as AdmittedCollection['collection'],
    featureCount: candidate.features.length,
    geometryTypes,
    fields: schemaRecord.fields,
    extent: coordinateCount === 0 ? null : [minX, minY, maxX, maxY],
    schemaDigest: sha256BytesHex(Buffer.from(JSON.stringify(schemaRecord), 'utf8')),
    featureRefs,
    coordinateCount,
  }
}

/**
 * Validate one parsed GeoJSON value before it enters a durable map or catalog
 * record. This is the value-side counterpart of {@link admitCollection}; it
 * is used for collaboration payloads, versioned map-change records, and
 * legacy replay where there are no source bytes to parse again.
 * @param value - parsed JSON value supplied by a model, log, or collaboration writer.
 * @param options - coordinate range and optional display geometry policy.
 * @returns bounded collection facts and the original validated value.
 * @throws {CatalogError} for malformed structure, unsupported geometry, budget,
 *   non-finite coordinate, or unsafe properties values.
 */
export function validateGeoJsonValue(value: unknown, options: GeoJsonAdmissionOptions): ValidatedGeoJsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'resource payload must be a GeoJSON FeatureCollection')
  }
  const candidate = value as Record<string, unknown>
  let serializedBytes: number
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'resource payload must be serializable JSON')
  }
  if (serializedBytes > MAX_REGISTER_BYTES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `resource payload exceeds the ${MAX_REGISTER_BYTES} byte limit`)
  }
  if (candidate.type !== 'FeatureCollection' || !Array.isArray(candidate.features)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'resource payload must be a GeoJSON FeatureCollection')
  }
  if (candidate.features.length > MAX_REGISTER_FEATURES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `resource feature limit exceeded (${MAX_REGISTER_FEATURES})`)
  }

  const geometryTypes: string[] = []
  let coordinateCount = 0
  const budget: CoordinateBudget = { count: 0, enforceWgs84: options.enforceWgs84Range }
  candidate.features.forEach((featureValue) => {
    if (typeof featureValue !== 'object' || featureValue === null || Array.isArray(featureValue)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'collection contains an invalid feature')
    }
    const feature = featureValue as Record<string, unknown>
    if (feature.type !== 'Feature') {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'collection contains an invalid feature')
    }
    validateGeoJsonProperties(feature.properties)
    if (feature.geometry === null || feature.geometry === undefined) return
    if (typeof feature.geometry !== 'object' || Array.isArray(feature.geometry)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'feature contains an invalid geometry')
    }
    const geometry = feature.geometry as Record<string, unknown>
    if (typeof geometry.type !== 'string' || !GEOMETRY_TYPES.has(geometry.type)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `unsupported geometry type "${String(geometry.type).slice(0, 40)}"`)
    }
    if (options.allowedGeometryTypes !== undefined && !options.allowedGeometryTypes.has(geometry.type)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `geometry type "${geometry.type}" is not display-supported`)
    }
    validateCoordinateShape(geometry.type, geometry.coordinates)
    if (!geometryTypes.includes(geometry.type)) geometryTypes.push(geometry.type)
    coordinateCount += walkCoordinates(geometry.coordinates, 0, options, () => undefined, budget)
  })
  return {
    collection: candidate as ValidatedGeoJsonValue['collection'],
    featureCount: candidate.features.length,
    geometryTypes,
    coordinateCount,
  }
}

/** Reject coordinate nesting that does not match the declared GeoJSON geometry type. */
function validateCoordinateShape(type: string, coordinates: unknown): void {
  const position = (value: unknown): void => {
    if (!Array.isArray(value) || value.length < 2 || value.some(item => typeof item !== 'number')) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must contain positions`)
    }
  }
  const line = (value: unknown): void => {
    if (!Array.isArray(value) || value.length < 2) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must contain at least two positions`)
    }
    value.forEach(position)
  }
  const polygon = (value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must contain rings`)
    }
    value.forEach(ring => {
      if (!Array.isArray(ring) || ring.length < 4) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `${type} rings must contain at least four positions`)
      }
      ring.forEach(position)
    })
  }
  switch (type) {
    case 'Point': position(coordinates); break
    case 'MultiPoint':
      if (!Array.isArray(coordinates) || coordinates.length === 0) throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must not be empty`)
      coordinates.forEach(position)
      break
    case 'LineString': line(coordinates); break
    case 'MultiLineString':
      if (!Array.isArray(coordinates) || coordinates.length === 0) throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must not be empty`)
      coordinates.forEach(line)
      break
    case 'Polygon': polygon(coordinates); break
    case 'MultiPolygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) throw new CatalogError('CATALOG_INVALID_INPUT', `${type} coordinates must not be empty`)
      coordinates.forEach(polygon)
      break
    default: throw new CatalogError('CATALOG_INVALID_INPUT', `unsupported geometry type "${type}"`)
  }
}

/** Walk one nested coordinate array, enforcing budgets, finiteness, and optional WGS84 range. */
interface CoordinateBudget {
  count: number
  readonly enforceWgs84: boolean
}

function walkCoordinates(
  value: unknown,
  depth: number,
  options: { enforceWgs84Range: boolean },
  visit: (x: number, y: number) => void,
  budget?: CoordinateBudget,
): number {
  if (depth > MAX_REGISTER_DEPTH) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'geometry depth limit exceeded')
  }
  if (!Array.isArray(value)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'geometry coordinates must be nested arrays')
  }
  const first = value[0]
  const second = value[1]
  if (value.length >= 2 && typeof first === 'number' && typeof second === 'number') {
    for (const coordinate of value) {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
        throw new CatalogError('CATALOG_INVALID_INPUT', 'coordinates must contain only finite numbers')
      }
    }
    if (options.enforceWgs84Range && (first < -180 || first > 180 || second < -90 || second > 90)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', 'coordinate is outside the WGS84 range')
    }
    visit(first, second)
    if (budget !== undefined) {
      budget.count += 1
      if (budget.count > MAX_REGISTER_COORDINATES) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `resource coordinate limit exceeded (${MAX_REGISTER_COORDINATES})`)
      }
    }
    return 1
  }
  let count = 0
  for (const child of value) count += walkCoordinates(child, depth + 1, options, visit, budget)
  return count
}

/** Validate JSON-only feature properties without retaining unbounded objects. */
export function validateGeoJsonProperties(properties: unknown): void {
  if (properties === undefined || properties === null) return
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'feature properties must be an object or null')
  }
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new CatalogError('CATALOG_INVALID_INPUT', 'feature properties must contain finite JSON values')
      return
    }
    if (typeof value !== 'object') throw new CatalogError('CATALOG_INVALID_INPUT', 'feature properties must contain JSON values')
    if (depth > MAX_PROPERTY_DEPTH) throw new CatalogError('CATALOG_INVALID_INPUT', `feature properties depth exceeds ${MAX_PROPERTY_DEPTH}`)
    if (seen.has(value)) throw new CatalogError('CATALOG_INVALID_INPUT', 'feature properties must not contain cycles')
    seen.add(value)
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1)
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key.length === 0) throw new CatalogError('CATALOG_INVALID_INPUT', 'feature property names must be non-empty')
        visit(child, depth + 1)
      }
    }
    seen.delete(value)
  }
  visit(properties, 0)
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(properties), 'utf8')
  } catch {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'feature properties must be serializable JSON')
  }
  if (bytes > MAX_FEATURE_PROPERTIES_BYTES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `feature properties exceed the ${MAX_FEATURE_PROPERTIES_BYTES} byte limit`)
  }
}

/** Union property keys across features into one sorted field/type table. */
function collectFieldTypes(properties: unknown, into: Map<string, string>): void {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const existing = into.get(name)
    if (existing === undefined) into.set(name, type)
    else if (existing !== type) into.set(name, 'mixed')
  }
}

/** The feature's stable original identifier: top-level `id` when a plain string or number. */
function originalIdOf(feature: Record<string, unknown>): string | null {
  const id = feature.id
  if (typeof id === 'string' && id.length > 0 && id.length <= 256) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return null
}

/**
 * The deterministic within-version feature ref: `f-` plus the first 16 hex of
 * the feature's canonical JSON digest. Identical bytes always produce the
 * same refs, so a re-registration of unchanged data keeps feature identity.
 */
function featureRefOf(feature: Record<string, unknown>): FeatureRef {
  const digest = sha256BytesHex(Buffer.from(JSON.stringify(feature), 'utf8'))
  return brandString<FeatureRef>(`f-${digest.slice(0, 16)}`)
}

/** Field-name ordering for the canonical schema record. */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
