/**
 * Camera-change admission against the accepted basemap selection.
 * @module @map-harness/map-tools/basemap-admission
 */
import { sourceCompatibleWithView, type BasemapSource } from '@map-harness/map-layers'
import { resolveMapSourceSelection, viewEngineKey, type MapChange, type MapProjectionState } from '@map-harness/map-container'
import { SpatialError } from './spatial-errors.ts'
import type { MapSourceService } from '@map-harness/map-container'

/** Verify current rendered source identities without treating their policy as an operation grant. */
export function assertAutomatedMapUseAllowed(state: MapProjectionState, service: MapSourceService | undefined): void {
  if (service === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'The map source service is unavailable.')
  const selection = resolveMapSourceSelection(service.catalog, state.basemap)
  const display = state.imageryDisplay
  const sources = [
    ...(display.recentVisible && display.recentOpacity > 0 ? [selection.basemap] : []),
    ...(display.labelsVisible && selection.labels !== null ? [selection.labels] : []),
    ...(display.earlyVisible && display.earlySource !== null ? [display.earlySource] : []),
  ]
  for (const source of sources) service.verifySource(source)
}

/** Host service face required to verify persisted source descriptors against the live catalog. */
export interface SourceVerificationFace {
  verifySource(source: BasemapSource): void
}

/**
 * Derive the view/mode a change would leave, then verify both raster roles.
 * @param state - accepted projection used for every omitted camera field.
 * @param change - camera-changing candidate.
 * @param sources - live host source verification service.
 */
export function admitCameraChange(
  state: MapProjectionState,
  change: MapChange,
  sources: SourceVerificationFace | undefined,
): void {
  const selection = state.basemap
  if (selection === null) return
  let mode = state.mode
  let view = state.view
  const changes = change.op === 'patch' ? change.changes : [change]
  for (const nested of changes) {
    if (nested.op === 'set-view') view = nested.view
    else if (nested.op === 'set-mode') mode = nested.mode
  }
  for (const source of [selection.basemap, selection.labels]) {
    if (source === null) continue
    if (sources === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the current map source service is required to change the camera')
    }
    try {
      sources.verifySource(source)
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code
      if (code === 'SOURCE_CHANGED') throw new SpatialError('SOURCE_CHANGED', 'the map source configuration changed; refresh the catalog and select it again')
      throw error
    }
    if (!sourceCompatibleWithView(source, { mode, wkid: viewEngineKey(view.wkid), zoom: view.zoom })) {
      throw new SpatialError('SOURCE_COMBINATION_UNSUPPORTED', 'The selected basemap and reference labels are incompatible. Choose compatible labels or turn them off.')
    }
  }
}
