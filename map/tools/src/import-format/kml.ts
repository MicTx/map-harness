/**
 * KML import admission for `data_import`: fixed-WGS84 KML 2.2 parsing
 * through `@xmldom/xmldom` + `@tmcw/togeojson`. Decoding honors the BOM, then
 * the XML declaration, then UTF-8; DTDs are rejected before parsing so entity
 * expansion never runs; external references (NetworkLink, icons) are counted
 * and reported, never dereferenced. togeojson emits `GeometryCollection` for
 * every MultiGeometry; same-type collections are normalized to the matching
 * `Multi*` type so renderable data stays renderable, while mixed-type
 * collections stay and the shared GeoJSON admission refuses them. The `ready`
 * collection always re-enters {@link loadGeoJsonString} under WGS84.
 */
import { DOMParser } from '@xmldom/xmldom'
import { kml as kmlToGeoJson } from '@tmcw/togeojson'
import { loadGeoJsonString } from '../geo-source.ts'
import { SpatialError } from '../spatial-errors.ts'
import {
  type ImportAdmission,
  type ImportOutcome,
  importFingerprintOf,
  sourceDigestOf,
} from './admission.ts'
import { MAX_IMPORT_FEATURES } from './limits.ts'

/** Geometry types a same-type MultiGeometry can normalize into. */
const NORMALIZABLE_MULTI: Readonly<Record<string, string>> = {
  Point: 'MultiPoint',
  LineString: 'MultiLineString',
  Polygon: 'MultiPolygon',
}

/** One import request shape for the KML channel. */
export interface KmlImportRequest {
  readonly bytes: Uint8Array
  /** KML is fixed to WGS84; any crs parameter refuses. */
  readonly crs?: string
}

/** Sniff a BOM into a TextDecoder label. */
function sniffBom(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

/**
 * Extract the XML declaration's encoding label from the ASCII-compatible
 * prolog prefix.
 */
function declaredEncodingOf(bytes: Uint8Array): string | undefined {
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 256)).toString('latin1')
  const match = /^<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(prefix)
  return match?.[1]
}

/**
 * Decode the raw bytes honoring BOM, then declaration, then UTF-8.
 * @throws {SpatialError} `INVALID_ARGUMENT` for unknown labels and undecodable bytes.
 */
function decodeKml(bytes: Uint8Array): { text: string; encoding: string } {
  const label = sniffBom(bytes) ?? declaredEncodingOf(bytes) ?? 'utf-8'
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes)
    return { text: text.replace(/^\ufeff/, ''), encoding: label.toLowerCase() }
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new SpatialError('IMPORT_ENCODING_INVALID', `KML declares unsupported encoding "${label}"`)
    }
    throw new SpatialError('IMPORT_ENCODING_INVALID', `KML content cannot be decoded as ${label}`)
  }
}

/**
 * Parse the decoded text into a DOM document, refusing DTDs and malformed
 * XML. The parser runs strict: well-formedness errors and undefined entity
 * references throw instead of degrading into a partial tree.
 * @throws {SpatialError} `INVALID_ARGUMENT` with no host paths.
 */
function parseDocument(text: string): ReturnType<DOMParser['parseFromString']> {
  if (/<!DOCTYPE/i.test(text)) {
    throw new SpatialError('IMPORT_FORMAT_INVALID', 'KML must not carry a DTD; entity declarations are rejected')
  }
  try {
    return new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') throw new Error(`${level}: ${message}`)
      },
    }).parseFromString(text, 'text/xml')
  } catch {
    throw new SpatialError('IMPORT_FORMAT_INVALID', 'KML is not well-formed XML')
  }
}

/**
 * Normalize one togeojson geometry: same-type GeometryCollections become the
 * matching Multi* type; mixed types are returned untouched for the shared
 * admission to refuse.
 */
function normalizeGeometry(geometry: { type: string; geometries?: unknown[]; coordinates?: unknown } | null): unknown {
  if (geometry === null || geometry.type !== 'GeometryCollection' || !Array.isArray(geometry.geometries)) return geometry
  const parts = geometry.geometries as Array<{ type: string; coordinates?: unknown }>
  const multiType = NORMALIZABLE_MULTI[parts[0]?.type ?? '']
  if (multiType !== undefined && parts.length > 0 && parts.every(part => part.type === parts[0]!.type)) {
    return { type: multiType, coordinates: parts.map(part => part.coordinates) }
  }
  return geometry
}

/**
 * Parse one KML import into its admission outcome.
 * @param request - raw bytes; a `crs` parameter always refuses (KML 2.2 is fixed WGS84).
 * @returns `ready` with the canonical WGS84 collection.
 * @throws {SpatialError} with a stable code, never a host path, for decode,
 *   DTD, structure, range, and budget failures.
 */
export function parseKmlImport(request: KmlImportRequest): ImportOutcome {
  if (request.crs !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'KML is fixed to WGS84; omit the crs parameter')
  }
  const sourceDigest = sourceDigestOf(request.bytes)
  const { text, encoding } = decodeKml(request.bytes)
  const document = parseDocument(text)
  const placemarkCount = document.getElementsByTagName('Placemark').length
  if (placemarkCount > MAX_IMPORT_FEATURES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `KML exceeds the ${MAX_IMPORT_FEATURES} placemark limit`)
  }
  const externalRefs = document.getElementsByTagName('href').length
  const converted = kmlToGeoJson(document) as { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; geometry: unknown; properties?: unknown }> }
  const features = converted.features.map(feature => ({ ...feature, geometry: normalizeGeometry(feature.geometry as { type: string; geometries?: unknown[]; coordinates?: unknown } | null) }))
  const geojson = loadGeoJsonString(Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }), 'utf8'), 'EPSG:4326')
  const admission: ImportAdmission = {
    format: 'kml',
    formatCandidates: null,
    encoding,
    nativeCrs: 'EPSG:4326',
    sourceDigest,
    columnMapping: null,
    columnCandidates: null,
    prjConclusion: null,
    crsCandidates: null,
    warnings: externalRefs === 0 ? [] : [`ignored-external-refs:${externalRefs}`],
    candidatesFingerprint: importFingerprintOf({
      format: 'kml',
      sourceDigest,
      encoding,
      nativeCrs: 'EPSG:4326',
      candidates: null,
    }),
  }
  return { kind: 'ready', geojson, admission }
}
