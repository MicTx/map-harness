/**
 * Derive the read-only visual-change candidate layer from authoritative
 * records. Accepted or rejected candidates stop being active candidates;
 * no model change can write this layer directly.
 * @module @map-harness/map-container/visual-change-layer
 */
import type { GeoJsonFeatureCollection } from './registry.ts'
import { stableDigestOf } from './stable-digest.ts'
import { VISUAL_CHANGE_LAYER_ID } from './comparison-limits.ts'
import type { MapProjectedLayer } from './protocol.ts'
import type { VisualChangeRecord } from './comparison-protocol.ts'

/** Geometry kinds the browser's generic GeoJSON carrier renders. */
const displayGeometry = (record: VisualChangeRecord): { readonly type: 'Point' | 'LineString' | 'Polygon'; readonly coordinates: unknown } => {
  if (record.geometry.type === 'Point') return { type: 'Point', coordinates: [...record.geometry.coordinates] }
  if (record.geometry.type === 'LineString') return {
    type: 'LineString', coordinates: record.geometry.coordinates.map(point => [...point]),
  }
  return { type: 'Polygon', coordinates: record.geometry.coordinates.map(ring => ring.map(point => [...point])) }
}

/**
 * Build the active-change-candidate layer, or `undefined` when none is proposed.
 * @param changes - bounded persisted candidate records.
 * @returns the host-owned projected layer.
 */
export function visualChangeLayerOf(changes: readonly VisualChangeRecord[]): MapProjectedLayer | undefined {
  const active = changes.filter(change => change.status === 'proposed')
  if (active.length === 0) return undefined
  const data: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: active.map(change => ({
      type: 'Feature',
      id: change.changeId,
      geometry: displayGeometry(change),
      properties: {
        name: change.category,
        kind: change.kind,
        confidence: change.confidence,
        dshRole: 'visual-change',
        dshStatus: 'proposed',
        dshChangeId: change.changeId,
        dshComparisonId: change.comparisonId,
      },
    })),
  }
  return {
    id: VISUAL_CHANGE_LAYER_ID,
    name: 'Visual changes',
    role: 'visual-change',
    data,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 0,
    displayDigest: stableDigestOf(data),
  }
}
