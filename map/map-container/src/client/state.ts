/**
 * Convert the `mapContainer` projection wire value into the occurrence's
 * container state. The session-bound Sidebar renders this value so replay
 * reconstructs the same layers, AOI outline, and operation history.
 */
import type { StyleSpec } from '@map-harness/spatial-viz/browser'
import type { BasemapSelection, FeatureOverrides, ImagerySpec, SymbolStyle } from '@map-harness/map-layers'
import type { GeoJsonFeatureCollection, MapContainerState, MapLayerStream, MapLayerTerrain, MapOperationSummary } from '../registry.ts'

/** Wire value published by the `mapContainer` projection. */
export interface MapContainerWire {
  readonly layers: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly role?: 'user-annotation' | 'visual-proposal' | 'visual-change'
    readonly data: unknown
    readonly sourceCrs: string
    readonly opacity: number
    readonly visible: boolean
    readonly legend?: import('../registry.ts').MapLayerLegend
    readonly style?: StyleSpec
    readonly symbol?: SymbolStyle
    readonly overrides?: FeatureOverrides
    readonly group?: string
    readonly imagery?: ImagerySpec
    readonly resourceRef?: string
    readonly artifactRef?: string
    readonly displayDigest?: string
    readonly terrain?: MapLayerTerrain
    readonly stream?: MapLayerStream
  }>
  readonly view: { center: [number, number]; zoom: number; wkid: number; scale?: number; rotation?: number }
  readonly interaction: import('../interaction-protocol.ts').MapInteractionState
  readonly mode: 'map' | 'scene'
  readonly basemap?: BasemapSelection | null
  readonly imageryDisplay?: import('../protocol.ts').ImageryDisplayState
  readonly waybackComparison?: import('../wayback-comparison.ts').WaybackComparison | null
  readonly aoi: { name?: string; ring: [number, number][] } | null
  /** Increments once per applied map change; export manifests pin it. */
  readonly revision: number
  readonly operations: ReadonlyArray<{
    readonly index: number
    readonly operationId: string | null
    readonly undoOf: number | null
    readonly writerId: string | null
    readonly revision: number
    readonly summary: string
  }>
  /** Newest annotation operation retained by the host's full undo ledger. */
  readonly undoableAnnotation?: {
    readonly index: number
    readonly operationId: string | null
    readonly undoOf: number | null
    readonly writerId: string | null
    readonly revision: number
    readonly summary: string
  } | null
  /** The live visual-observation request, when one is pending. */
  readonly observationRequest: { callId: string; requestSeq: number; revision: number; expiresAtMs: number } | null
  /** The last accepted observation evidence record, or `null`. */
  readonly latestObservation?: import('../observation-protocol.ts').MapObservationRecord | null
  /** Bounded visual-proposal candidates, including reviewed evidence. */
  readonly visualProposals?: readonly import('../visual-proposal-protocol.ts').VisualProposalRecord[]
  /** Bounded persisted observation evidence retained for comparisons. */
  readonly observationHistory?: readonly import('../observation-protocol.ts').MapObservationRecord[]
  /** Bounded accepted comparison records. */
  readonly comparisons?: readonly import('../comparison-protocol.ts').MapComparisonRecord[]
  /** Bounded visual-change candidates, including reviewed evidence. */
  readonly visualChanges?: readonly import('../comparison-protocol.ts').VisualChangeRecord[]
}

/**
 * Fold a projection wire snapshot into occurrence state.
 * @param wire - the current `mapContainer` wire value, or absent.
 * @returns container state, or `undefined` when the projection has not landed.
 */
export function wireToState(wire: MapContainerWire | undefined): MapContainerState | undefined {
  if (wire === undefined) return undefined
  const operations: MapOperationSummary[] = wire.operations.map(op => ({
    index: op.index,
    operationId: op.operationId,
    undoOf: op.undoOf,
    writerId: op.writerId,
    revision: op.revision,
    summary: op.summary,
  }))
  return {
    interaction: wire.interaction,
    observationRequest: wire.observationRequest === null || wire.observationRequest === undefined ? null : { ...wire.observationRequest },
    latestObservation: wire.latestObservation === null || wire.latestObservation === undefined ? null : wire.latestObservation,
    visualProposals: (wire.visualProposals ?? []).map(proposal => ({ ...proposal })),
    observationHistory: (wire.observationHistory ?? []).map(record => ({ ...record })),
    comparisons: (wire.comparisons ?? []).map(record => ({ ...record })),
    visualChanges: (wire.visualChanges ?? []).map(change => ({ ...change })),
    layers: new Map(wire.layers.map(layer => [layer.id, {
      id: layer.id,
      name: layer.name,
      ...(layer.role === undefined ? {} : { role: layer.role }),
      ...(layer.data === undefined ? {} : { data: layer.data as GeoJsonFeatureCollection }),
      sourceCrs: layer.sourceCrs,
      opacity: layer.opacity,
      visible: layer.visible,
      ...(layer.style === undefined ? {} : { style: layer.style }),
      ...(layer.symbol === undefined ? {} : { symbol: layer.symbol }),
      ...(layer.legend === undefined ? {} : { legend: layer.legend }),
      ...(layer.overrides === undefined ? {} : { overrides: layer.overrides }),
      ...(layer.group === undefined ? {} : { group: layer.group }),
      ...(layer.imagery === undefined ? {} : { imagery: layer.imagery }),
      ...(layer.resourceRef === undefined ? {} : { resourceRef: layer.resourceRef }),
      ...(layer.artifactRef === undefined ? {} : { artifactRef: layer.artifactRef }),
      ...(layer.displayDigest === undefined ? {} : { displayDigest: layer.displayDigest }),
      ...(layer.terrain === undefined ? {} : { terrain: layer.terrain }),
      ...(layer.stream === undefined ? {} : { stream: layer.stream }),
    }])),
    view: { ...wire.view, center: [wire.view.center[0], wire.view.center[1]] },
    mode: wire.mode,
    basemap: wire.basemap ?? null,
    imageryDisplay: wire.imageryDisplay ?? {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
      earlySource: null,
    },
    aoi: wire.aoi === null ? null : {
      ...(wire.aoi.name === undefined ? {} : { name: wire.aoi.name }),
      ring: wire.aoi.ring.map(point => [point[0], point[1]] as [number, number]),
    },
    revision: wire.revision,
    operations,
  }
}
