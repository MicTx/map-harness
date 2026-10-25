/**
 * The export-format barrel: one entry point per format serializer for
 * `data_export`, each taking the canonical WGS84 collection and returning
 * self-describing bytes. Every serializer is pure — authorization, source
 * selection, and artifact publication belong to the tool layer.
 */
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { csvBytesOf } from './csv.ts'
import { kmlDocumentOf } from './kml.ts'
import { shapefileBytesOf } from './shapefile.ts'

/** The export formats `data_export` publishes. */
export type ExportFormat = 'geojson' | 'csv' | 'kml' | 'shapefile'

/** One serialized export result. */
export interface ExportPayload {
  readonly bytes: Buffer
  /** Artifact method algorithm identifier: `data-export-<format>`. */
  readonly algorithm: string
  /** File extension (without dot). */
  readonly extension: string
}

/**
 * Serialize one canonical WGS84 collection into the requested format.
 * @param format - target format.
 * @param collection - canonical WGS84 FeatureCollection.
 * @param options - base name used for embedded document names.
 * @returns the serialized bytes with format metadata.
 * @throws {SpatialError} with a stable code, never a host path, for
 *   geometry- and width-contract refusals.
 */
export function serializeExport(format: ExportFormat, collection: GeoJsonFeatureCollection, options: { readonly name: string }): ExportPayload {
  if (format === 'geojson') {
    return {
      bytes: Buffer.from(JSON.stringify(collection), 'utf8'),
      algorithm: 'data-export-geojson',
      extension: 'geojson',
    }
  }
  if (format === 'csv') {
    return { bytes: csvBytesOf(collection, options), algorithm: 'data-export-csv', extension: 'csv' }
  }
  if (format === 'kml') {
    const { document } = kmlDocumentOf(collection, { name: options.name, mode: 'per-part', fallbackName: options.name })
    return { bytes: Buffer.from(document, 'utf8'), algorithm: 'data-export-kml', extension: 'kml' }
  }
  return { bytes: shapefileBytesOf(collection, options), algorithm: 'data-export-shapefile', extension: 'zip' }
}

export { csvBytesOf } from './csv.ts'
export { kmlDocumentOf, xmlEscape, type KmlGeometryMode } from './kml.ts'
export { shapefileBytesOf } from './shapefile.ts'
export { zipBytesOf, type ZipEntryInput } from './zip.ts'
