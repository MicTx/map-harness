/**
 * Convert the `mapContainer` projection wire value into the occurrence's
 * container state. Both the right-Sidebar tab and the conversation view
 * render from this conversion so a replay reconstructs the same layers,
 * AOI outline, and operation history.
 */
import type { StyleSpec } from '@map-harness/spatial-viz'
import type { GeoJsonFeatureCollection, MapContainerState, MapLayerStream, MapLayerTerrain, MapOperationSummary } from '../registry.ts'

/** Wire value published by the `mapContainer` projection. */
export interface MapContainerWire {
  readonly layers: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly data: unknown
    readonly sourceCrs: string
    readonly opacity: number
    readonly visible: boolean
    readonly style?: StyleSpec
    readonly resourceRef?: string
    readonly artifactRef?: string
    readonly displayDigest?: string
    readonly terrain?: MapLayerTerrain
    readonly stream?: MapLayerStream
  }>
  readonly view: { center: [number, number]; zoom: number; wkid: number }
  readonly mode: 'map' | 'scene'
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
    layers: new Map(wire.layers.map(layer => [layer.id, {
      id: layer.id,
      name: layer.name,
      data: layer.data as GeoJsonFeatureCollection,
      sourceCrs: layer.sourceCrs,
      opacity: layer.opacity,
      visible: layer.visible,
      ...(layer.style === undefined ? {} : { style: layer.style }),
      ...(layer.resourceRef === undefined ? {} : { resourceRef: layer.resourceRef }),
      ...(layer.artifactRef === undefined ? {} : { artifactRef: layer.artifactRef }),
      ...(layer.displayDigest === undefined ? {} : { displayDigest: layer.displayDigest }),
      ...(layer.terrain === undefined ? {} : { terrain: layer.terrain }),
      ...(layer.stream === undefined ? {} : { stream: layer.stream }),
    }])),
    view: { center: [wire.view.center[0], wire.view.center[1]], zoom: wire.view.zoom, wkid: wire.view.wkid },
    mode: wire.mode,
    aoi: wire.aoi === null ? null : {
      ...(wire.aoi.name === undefined ? {} : { name: wire.aoi.name }),
      ring: wire.aoi.ring.map(point => [point[0], point[1]] as [number, number]),
    },
    revision: wire.revision,
    operations,
  }
}
