/**
 * Derive the read-only visual-candidate layer from the authoritative proposal
 * records. The layer is presentation data: no model change may write it, and
 * accepted or rejected candidates are no longer drawn as active candidates.
 * @module @map-harness/map-container/visual-proposal-layer
 */
import type { GeoJsonFeatureCollection } from './registry.ts'
import { stableDigestOf } from './stable-digest.ts'
import { VISUAL_PROPOSAL_LAYER_ID } from './comparison-limits.ts'
import type { MapProjectedLayer } from './protocol.ts'
import type { VisualProposalRecord } from './visual-proposal-protocol.ts'

/** Geometry kinds the browser's generic GeoJSON carrier renders. */
const displayGeometry = (record: VisualProposalRecord): { readonly type: 'Point' | 'LineString' | 'Polygon'; readonly coordinates: unknown } => {
  if (record.geometry.type === 'Point') return { type: 'Point', coordinates: [...record.geometry.coordinates] }
  if (record.geometry.type === 'LineString') return {
    type: 'LineString', coordinates: record.geometry.coordinates.map(point => [...point]),
  }
  return { type: 'Polygon', coordinates: record.geometry.coordinates.map(ring => ring.map(point => [...point])) }
}

/**
 * Build the active-candidate layer, or `undefined` when no candidate is proposed.
 * @param proposals - bounded persisted candidate records.
 * @returns the host-owned projected layer.
 */
export function visualProposalLayerOf(proposals: readonly VisualProposalRecord[]): MapProjectedLayer | undefined {
  const active = proposals.filter(proposal => proposal.status === 'proposed')
  if (active.length === 0) return undefined
  const data: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: active.map(proposal => ({
      type: 'Feature',
      id: proposal.proposalId,
      geometry: displayGeometry(proposal),
      properties: {
        name: proposal.category,
        purpose: proposal.purpose,
        confidence: proposal.confidence,
        dshRole: 'visual-proposal',
        dshStatus: 'proposed',
        dshProposalId: proposal.proposalId,
        dshObservationId: proposal.observationId,
      },
    })),
  }
  return {
    id: VISUAL_PROPOSAL_LAYER_ID,
    name: 'Visual proposals',
    role: 'visual-proposal',
    data,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 0,
    displayDigest: stableDigestOf(data),
  }
}
