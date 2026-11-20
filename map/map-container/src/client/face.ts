/**
 * Shared client types for the map tab: the occurrence lifecycle and the
 * smoke/diagnostic handle published per session container.
 */
import type { MapContainerState, MapLayerRecord, MapLayerStream } from '../registry.ts'
import type { MapObservationRecord } from '../observation-protocol.ts'
import type { MapRenderReceipt } from './render-receipt.ts'
import type { GestureMetrics } from './gesture.ts'
import type { ViewSnapshot } from './view-policy.ts'
import type { AnnotationDrawKind, AnnotationDrawingState } from './annotation-drawing.ts'
import type { MapUseClientRequest } from '../interaction-protocol.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Session-authorized durable image resolver for source-evidence previews. */
export type MapImageUrl = (sessionId: import('@deepseek-ai/dsh-session/types').SessionId, attachment: ImageAttachmentRef) => Promise<string>

/** One PNG capture of the live view, with the viewport fix it was taken at. */
export interface CaptureResult {
  /** PNG data URL (`data:image/png;base64,...`). */
  readonly dataUrl: string
  /** The viewport at capture time; `null` when the view cannot report one. */
  readonly viewport: ViewSnapshot | null
}

/** Why a capture was refused. Rejected as a plain object, never an `Error` instance. */
export type CaptureError =
  | { readonly code: 'no-view' }
  | { readonly code: 'capture-timeout' }
  | { readonly code: 'capture-failed'; readonly detail: string }

/** Live camera facts the Mapbox-style controls display. */
export interface MapControlState {
  /** View rotation in degrees; 0 points north. */
  readonly rotation: number
  /** Label for a fixed 100px scale bar; null when the scale is unreadable. */
  readonly scaleLabel: string | null
  /** Live SDK zoom; projected views driven by scale may report -1. */
  readonly zoom: number
}

/** One occurrence's map commands over the live ArcGIS view. */
export interface MapOccurrence {
  /** Read the source descriptor failure while automatic recovery continues; successful reads clear it. */
  sourceFailure(): 'error' | 'retrying' | null
  /** Retry the current source selection immediately and restart its backoff cycle. */
  retrySource(): void
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
   * Frame one projected layer's GeoJSON bbox. Visibility is untouched: a
   * hidden layer is framed without being shown. Unknown ids are no-ops so a
   * stale conversation focus cannot throw.
   */
  focusLayer(layerId: string): void
  /**
   * Frame one feature's geometry bbox on its layer's data, with the same
   * programmatic muting as {@link focusLayer}; a hidden layer stays hidden.
   * Unknown layer or feature ids are no-ops.
   */
  focusFeature(layerId: string, featureId: string): void
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
  setHighlight(layerId: string, ids: ReadonlySet<string>, source?: 'selection' | 'inspection'): void
  /** Dismiss the open hover inspection and clear its inspection highlight. */
  dismissInspection(): void
  /**
   * Capture the live view as a PNG data URL, with the viewport fix it was
   * taken at. Rejects with a {@link CaptureError} object (`code` plus optional
   * `detail`) when there is no live view, the SDK does not settle in time, or
   * the capture itself throws.
   */
  captureView(): Promise<CaptureResult>
  /**
   * Answer one accepted `map_use` fence: revalidate the cited observation on
   * the live view, perform a read-only SDK hit test for clicks, and submit the
   * bounded outcome. A superseded request or user takeover settles as a named
   * decline instead of executing an action.
   */
  runMapUse(request: MapUseClientRequest, observation: MapObservationRecord | null): Promise<void>
  /**
   * Stop continuous map use for one turn and immediately abort the in-flight
   * fence. Already accepted camera revisions are not rolled back.
   */
  stopMapUse(turn: number): void
  /**
   * Start one temporary Sketch drawing on the live 2D view. Completion submits
   * through the injected annotation write hook after WGS84 projection.
   */
  startAnnotationDrawing(kind: AnnotationDrawKind): Promise<'started' | 'busy' | 'no-view' | 'scene-mode'>
  /** Start editing one annotation geometry on the live 2D view. */
  startAnnotationEditing(featureId: string, geometry: import('../protocol.ts').AnnotationGeometry, expectedUpdatedAt: string): Promise<'started' | 'busy' | 'no-view' | 'scene-mode'>
  /** Cancel the active drawing and remove its temporary graphics. */
  cancelAnnotationDrawing(): boolean
  /** Read the live drawing lifecycle state. */
  annotationDrawingState(): AnnotationDrawingState
  /** Read the live rotation, zoom, and scale-bar label; null without a mounted view. */
  mapControlState(): MapControlState | null
  /** Zoom the live view by a signed step, clamped to ±4; reports no-view without a live view. */
  zoomBy(delta: number): 'applied' | 'no-view'
  /** Reset the live view rotation to north; reports no-view without a rotatable view. */
  resetBearing(): 'applied' | 'no-view'
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
  /** Live SDK camera in WGS84, not the projection target; null until readable or after disposal. */
  readonly camera: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number } | null
  /** Layer ids carrying a classification style, in layer order. */
  readonly styledLayers: readonly string[]
  /** How many features the current time frame (or no frame) shows. */
  readonly visibleFeatureCount: number
  /** The pinned time frame index, or `null` when no frame is pinned. */
  readonly frameIndex: number | null
  /** How many features the shared selection currently highlights. */
  readonly highlightCount: number
  /** The last accepted observation evidence record, or `null` when none has folded. */
  readonly latestObservation: MapObservationRecord | null
  readonly interaction: import('../interaction-protocol.ts').MapInteractionState
  /** Labels the last collision-free placement pass drew (2D view only). */
  readonly labelCount: number
  /** The labels the overlay currently draws: text, container-pixel centre, and color. */
  readonly labels: readonly { readonly text: string; readonly x: number; readonly y: number; readonly color: string }[]
  /** The cluster badges the overlay currently draws: container-pixel centre, covered count, and covering bbox (2D view only). */
  readonly labelClusters: readonly { readonly x: number; readonly y: number; readonly count: number; readonly bbox: { readonly west: number; readonly south: number; readonly east: number; readonly north: number } | null }[]
  /** Current annotation drawing lifecycle, for deterministic browser checks. */
  readonly annotationDrawing: AnnotationDrawingState
  /** Exact accepted protected annotation layer, for replay comparison. */
  readonly annotationSnapshot: MapLayerRecord | null
  /** Visual-proposal records in persisted order, for deterministic browser checks. */
  readonly visualProposals: readonly import('../visual-proposal-protocol.ts').VisualProposalRecord[]
  /** Persisted observation evidence in fold order, for deterministic browser checks. */
  readonly observationHistory: readonly MapObservationRecord[]
  /** Persisted two-image comparison records in fold order. */
  readonly comparisons: readonly import('../comparison-protocol.ts').MapComparisonRecord[]
  /** Persisted visual-change candidates in fold order. */
  readonly visualChanges: readonly import('../comparison-protocol.ts').VisualChangeRecord[]
  /** Project one WGS84 coordinate to container pixels on the live 2D view (`null` without one). */
  screenOf(longitude: number, latitude: number): { readonly x: number; readonly y: number } | null
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
