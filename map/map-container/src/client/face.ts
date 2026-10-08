/**
 * Shared client types for the map tab: the occurrence lifecycle and the
 * smoke/diagnostic handle published per session container.
 */
import type { MapContainerState, MapLayerStream } from '../registry.ts'
import type { MapRenderReceipt } from './render-receipt.ts'
import type { GestureMetrics } from './gesture.ts'

/** One occurrence's map commands over the live ArcGIS view. */
export interface MapOccurrence {
  /** Read this live occurrence's observation; a new or unmounted occurrence is unavailable. */
  getRenderReceipt(): MapRenderReceipt
  /** Read the last stored observation; it may belong to a destroyed view and is not live proof. */
  getPersistedRenderReceipt(): MapRenderReceipt | null
  /** Read the gesture-channel counters of the live view (zeros without one). */
  getGestureMetrics(): GestureMetrics
  /**
   * Submit the current view as the user's explicit gesture observation. The
   * camera must be readable; a missing or unmounted view reports `no-view`.
   */
  submitGestureObservation(): 'emitted' | 'no-view'
  /** Mount the ArcGIS view into the given holder element. */
  mount(holder: HTMLDivElement | undefined): void
  /** Apply the latest container snapshot onto the live view. */
  refresh(state: MapContainerState | undefined): void
  /**
   * Keep one projected layer visible and frame its GeoJSON bbox.
   * Unknown ids are no-ops so a stale conversation focus cannot throw.
   */
  focusLayer(layerId: string): void
  /**
   * Pin the container to one time frame (half-open, epoch ms) or clear the
   * pin (`null`). Features outside the frame — and features whose event time
   * is missing — leave the view while a frame is pinned; the next refresh
   * re-syncs graphics.
   */
  setTimeFrame(frame: { readonly index: number; readonly startMs: number; readonly endMs: number } | null): void
  /**
   * Highlight one layer's selected features (the shared selection ids).
   * Unknown ids and unstyled features are no-ops; an empty set clears.
   */
  setHighlight(layerId: string, ids: ReadonlySet<string>): void
  /** Release the view; idempotent. */
  dispose(): void
}

/** The DOM test handle the browser smoke asserts on. */
export interface MapHarnessTestHandle {
  /** Current occurrence observation; publishing the handle itself is not a render completion. */
  readonly renderReceipt: MapRenderReceipt
  readonly mode: MapContainerState['mode']
  readonly layerCount: number
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly wkid: number
  readonly engine: 'arcgis-core'
  /** Layer ids carrying a classification style, in layer order. */
  readonly styledLayers: readonly string[]
  /** How many features the current time frame (or no frame) shows. */
  readonly visibleFeatureCount: number
  /** The pinned time frame index, or `null` when no frame is pinned. */
  readonly frameIndex: number | null
  /** How many features the shared selection currently highlights. */
  readonly highlightCount: number
  /** `ref@revision` tokens of the terrain-preview layers this occurrence renders, in layer order. */
  readonly terrainRevisions: readonly string[]
  /**
   * The stream-workbench layers this occurrence renders, in layer order:
   * id, realtime-vs-materialized mode, workbench revision, pause flag, and
   * the visibility facts (watermark, lag, gaps, late revisions) the
   * realtime-vs-final distinction displays through.
   */
  readonly streamStates: readonly {
    readonly id: string
    readonly mode: MapLayerStream['mode']
    readonly revision: number
    readonly paused: boolean
    readonly watermarkMs: number | null
    readonly lagMs: number | null
    readonly gapWindows: number
    readonly lateRevisions: number
  }[]
  /** Gesture write-channel counters snapshot at publish time. */
  readonly gesture: GestureMetrics
}
