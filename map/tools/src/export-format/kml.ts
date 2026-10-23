/**
 * Shared KML 2.2 serialization for the export paths: `viz_export_kml` keeps
 * its legacy single-geometry contract through the `first-geometry` mode
 * (byte-identical output to the previous inline implementation), while
 * `data_export` uses `per-part` mode — every Multi* part becomes its own
 * Placemark and Polygon holes travel as innerBoundaryIs rings, so KML
 * round-trips preserve data instead of silently dropping it.
 */
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'

/** How Multi* geometries serialize. */
export type KmlGeometryMode = 'first-geometry' | 'per-part'

/** Escape one XML text node. */
export function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Render nested coordinate positions as a KML coordinate list. */
function coordinatesOf(positions: unknown, mode: KmlGeometryMode): string {
  if (!Array.isArray(positions)) return ''
  if (typeof positions[0] === 'number') {
    // Legacy mode pins the three-component form its artifacts were pinned
    // with; per-part mode writes two components so round-trips stay exact,
    // keeping a real altitude when one is present.
    if (mode === 'first-geometry') return `${positions[0]},${positions[1] ?? 0},0`
    return typeof positions[2] === 'number' && positions[2] !== 0
      ? `${positions[0]},${positions[1]},${positions[2]}`
      : `${positions[0]},${positions[1]}`
  }
  return positions.map(child => coordinatesOf(child, mode)).join(' ')
}

/** One serialized geometry body with its KML element name. */
interface KmlGeometryElement {
  readonly element: string
  readonly body: string
}

/** Render one single geometry (Point/LineString/Polygon). */
function singleGeometryOf(type: string, coordinates: unknown, mode: KmlGeometryMode): KmlGeometryElement | undefined {
  if (type === 'Point') return { element: 'Point', body: `<coordinates>${coordinatesOf(coordinates, mode)}</coordinates>` }
  if (type === 'LineString') return { element: 'LineString', body: `<coordinates>${coordinatesOf(coordinates, mode)}</coordinates>` }
  if (type === 'Polygon') {
    const rings = Array.isArray(coordinates) ? coordinates as unknown[][] : []
    const outer = rings[0]
    if (outer === undefined) return undefined
    const inner = mode === 'per-part'
      ? rings.slice(1).map(ring => `<innerBoundaryIs><LinearRing><coordinates>${coordinatesOf(ring, mode)}</coordinates></LinearRing></innerBoundaryIs>`).join('')
      : ''
    return {
      element: 'Polygon',
      body: `<outerBoundaryIs><LinearRing><coordinates>${coordinatesOf(outer, mode)}</coordinates></LinearRing></outerBoundaryIs>${inner}`,
    }
  }
  return undefined
}

/** Render one feature's geometry into one or more geometry elements. */
function geometryElementsOf(geometry: { type: string; coordinates?: unknown } | null, mode: KmlGeometryMode): KmlGeometryElement[] {
  if (geometry === null) return []
  const single = singleGeometryOf(geometry.type, geometry.coordinates, mode)
  if (single !== undefined) return [single]
  const parts = geometry.type === 'MultiPoint' || geometry.type === 'MultiLineString'
    ? geometry.coordinates as unknown[]
    : geometry.type === 'MultiPolygon'
      ? (geometry.coordinates as unknown[][]).flat()
      : []
  const partType = geometry.type === 'MultiPoint' ? 'Point'
    : geometry.type === 'MultiLineString' ? 'LineString'
      : geometry.type === 'MultiPolygon' ? 'Polygon'
        : undefined
  if (partType === undefined) return []
  if (mode === 'first-geometry') {
    const first = singleGeometryOf(partType, parts[0], mode)
    return first === undefined ? [] : [first]
  }
  return parts.flatMap(part => {
    const element = singleGeometryOf(partType, part, mode)
    return element === undefined ? [] : [element]
  })
}

/**
 * Serialize one collection's current WGS84 data as a KML 2.2 document.
 * @param collection - canonical WGS84 FeatureCollection.
 * @param options - document name and the Multi* geometry contract.
 * @returns the KML document text, the placemark count, and how many
 *   features carried no exportable geometry (reported, never dropped
 *   silently).
 */
export function kmlDocumentOf(collection: GeoJsonFeatureCollection, options: {
  readonly name: string
  readonly mode: KmlGeometryMode
  readonly fallbackName: string
}): { document: string; placemarks: number; skipped: number } {
  const placemarks: string[] = []
  let skipped = 0
  for (const feature of collection.features as Array<{ geometry: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }>) {
    const elements = geometryElementsOf(feature.geometry, options.mode)
    if (elements.length === 0) {
      skipped += 1
      continue
    }
    const title = xmlEscape(String(feature.properties?.name ?? options.fallbackName))
    const extended = Object.entries(feature.properties ?? {})
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .map(([key, value]) => `<Data name="${xmlEscape(key)}"><value>${xmlEscape(String(value))}</value></Data>`)
      .join('')
    for (const element of elements) {
      placemarks.push(`<Placemark><name>${title}</name>${extended === '' ? '' : `<ExtendedData>${extended}</ExtendedData>`}<${element.element}>${element.body}</${element.element}></Placemark>`)
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEscape(options.name)}</name>${placemarks.join('')}</Document></kml>`
  return { document, placemarks: placemarks.length, skipped }
}
