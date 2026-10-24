/**
 * The ArcGIS view lifecycle behind one map tab occurrence.
 *
 * The view is created lazily at first mount: `@arcgis/core` is heavy, and a
 * tab opened late must not pay for it at plugin load. Zero-key mode bars
 * Esri `basemap`/`ground` enums and the geocoder; World Imagery is added as a
 * public XYZ WebTileLayer with no key.
 * Container state (WGS84 GeoJSON layers, view record, mode) is applied
 * idempotently after every convergence.
 */
import MapView from '@arcgis/core/views/MapView.js'
import SceneView from '@arcgis/core/views/SceneView.js'
import EsriMap from '@arcgis/core/Map.js'
import type { MapProperties } from '@arcgis/core/Map.js'
import Graphic from '@arcgis/core/Graphic.js'
import type { GraphicProperties } from '@arcgis/core/Graphic.js'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type { FeatureLayerProperties } from '@arcgis/core/layers/FeatureLayer.js'
import WebTileLayer from '@arcgis/core/layers/WebTileLayer.js'
import MapImageLayer from '@arcgis/core/layers/MapImageLayer.js'
import Point from '@arcgis/core/geometry/Point.js'
import Polyline from '@arcgis/core/geometry/Polyline.js'
import Polygon from '@arcgis/core/geometry/Polygon.js'
import Extent from '@arcgis/core/geometry/Extent.js'
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js'
import { whenOnce, watch } from '@arcgis/core/core/reactiveUtils.js'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js'
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js'
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js'
import { classifyValue, featureIdOf, measureValueOf, sizeForClass, type ClassifiedValue, type StyleSpec } from '@map-harness/spatial-viz'
import { inferredSymbolOf, resolveSingleSymbol, semanticBlocksOf, shadeOf, type HeatmapBlock, type SingleSymbolStyle } from '@map-harness/map-layers'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MapContainerState, MapLayerRecord, MapLayerStream, MapLayerTerrain, MapViewRecord } from '../registry.ts'
import { geoJsonBbox, type LonLatBbox } from './bbox.ts'
import { basemapKindFor, explicitSpatialReferenceWkid, KEY_FREE_BASEMAP, scaleFromZoom, viewCameraEquals, viewEngineKey, viewportSnapshotOf, zoomFromScale, type ViewSnapshot } from './view-policy.ts'
import type { CaptureError, CaptureResult, MapHarnessTestHandle, MapOccurrence } from './face.ts'
import { createLabelOverlay, type LabelOverlay } from './label-overlay.ts'
import { LABEL_FIELD_CANDIDATES, labelAnchorOf, labelTextOf, placeLabels, type LabelCandidate } from './labeling.ts'
import { inspectionOf, popupValueOf, type FeatureInspection } from './popup.ts'
import { createRenderReceiptStore, type MapRenderFailure, type MapRenderReceipt } from './render-receipt.ts'
import {
  createGestureObserver,
  emptyGestureMetrics,
  realGestureClock,
  type GestureCameraSnapshot,
  type GestureClock,
  type GestureEmit,
  type GestureMetrics,
  type GestureObserver,
} from './gesture.ts'

/** Live instances in this browser module; tab close releases the Session for a later reopen. */
const sessionOccurrences = new Map<SessionId, MapOccurrence>()

/** How long one SDK capture may take before the face reports `capture-timeout`. */
const CAPTURE_TIMEOUT_MS = 5_000

/** The active capture deadline; tests shorten it to exercise the hang path. */
let captureTimeoutMs = CAPTURE_TIMEOUT_MS

/**
 * Shorten or restore the capture deadline so tests exercise the real hang
 * path without waiting the production deadline out.
 * @param ms - the new deadline in milliseconds.
 */
export function setCaptureTimeoutForTest(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) captureTimeoutMs = ms
}

/** View events whose arrival attributes camera changes to the user. */
const GESTURE_INTERACTION_EVENTS = ['pointer-drag', 'mouse-wheel', 'key-down', 'double-click'] as const

/** One layer's live render carrier: a graphics layer, a heatmap feature layer, or a tile overlay. */
interface AppliedLayer {
  readonly kind: 'graphics' | 'heatmap' | 'tile'
  readonly carrier: GraphicsLayer | FeatureLayer | WebTileLayer
  readonly name: string
  /** Per-graphic identity and classification, kept for highlight re-symbols (graphics kind). */
  entries: AppliedGraphic[]
}

/** One rendered feature: its stable id, class, and graphic. */
interface AppliedGraphic {
  readonly id: string
  /** The GeoJSON geometry family (ArcGIS reports lowercase types, so the source family is kept). */
  readonly geometryType: 'Point' | 'LineString' | 'Polygon'
  readonly classified: ClassifiedValue
  readonly graphic: Graphic
  /** The label anchor in lon/lat, when the geometry has one. */
  readonly anchor: ReturnType<typeof labelAnchorOf>
}

/** Values ArcGIS accepts as feature attributes without retaining nested input objects. */
type GraphicAttribute = string | number | boolean | null

/**
 * Project durable GeoJSON properties into the ArcGIS attribute face.
 *
 * The projection keeps the bounded properties object for analysis and style
 * evaluation. ArcGIS receives only scalar values: nested objects/arrays have
 * no rendering contract, and reserved prototype keys must not cross into an
 * Accessor-owned object. The internal feature id is always written last.
 * @param properties - the admitted feature properties.
 * @param featureId - the stable id used by selection/highlighting.
 * @returns an ArcGIS-safe attribute record.
 */
function graphicAttributesOf(
  properties: Record<string, unknown> | null | undefined,
  featureId: string,
): Record<string, GraphicAttribute> {
  const attributes: Record<string, GraphicAttribute> = {}
  if (properties !== null && properties !== undefined) {
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'prototype' || Object.hasOwn(Object.prototype, key)) continue
      if (typeof value === 'string') {
        attributes[key] = popupValueOf(value)
      } else if (value === null || typeof value === 'boolean') {
        attributes[key] = value
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        attributes[key] = value
      }
    }
  }
  attributes.__fid = featureId
  return attributes
}

/**
 * The selection face every selected feature wears: a cyan ring (hue-
 * independent of the class ramps and readable on imagery), a wider stroke,
 * and a slightly larger marker.
 */
const HIGHLIGHT_COLOR = '#00b8ff'
const HIGHLIGHT_WIDTH = 3
const HIGHLIGHT_MARKER_GROWTH_PX = 4
/** The selected-marker ring stays thin so the fill (its class or semantic hue) remains readable. */
const HIGHLIGHT_MARKER_RING_PX = 2

/** The white halo markers wear when nothing names an outline. */
const HALO_COLOR = '#ffffff'
const HALO_WIDTH = 2

/** The casing every line draws beneath its stroke (Mapbox road-casing look). */
const CASING_COLOR = 'rgba(255, 255, 255, 0.85)'
const CASING_EXTRA_PX = 2

/** Fill opacity for polygons styled only by a legend color (translucent fill, crisp outline). */
const FALLBACK_FILL_OPACITY = 0.3

/** Shade factor deriving a polygon's default outline from its fill color. */
const FILL_OUTLINE_SHADE = 0.7

/**
 * A deterministic sync content digest over the display data (FNV-1a on the
 * canonical JSON) for layers without a tool-supplied display digest.
 * @param data - the WGS84 display collection.
 * @returns a 32-bit hex digest usable as a change token.
 */
function contentDigestOf(data: { features: unknown[] }): string {
  const text = JSON.stringify(data)
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Build the map: cached imagery tiles on Web Mercator, reprojected dynamic export on projected views. */
function buildMap(wkid: number): EsriMap {
  const map = new EsriMap()
  if (basemapKindFor(wkid) === 'cached-xyz') {
    map.add(new WebTileLayer({
      title: KEY_FREE_BASEMAP.title,
      urlTemplate: KEY_FREE_BASEMAP.urlTemplate,
      copyright: KEY_FREE_BASEMAP.copyright,
    }))
  } else {
    map.add(new MapImageLayer({
      title: KEY_FREE_BASEMAP.title,
      url: KEY_FREE_BASEMAP.urlTemplate.replace(/\/tile\/\{level\}\/\{row\}\/\{col\}$/u, ''),
      copyright: KEY_FREE_BASEMAP.copyright,
    }))
  }
  return map
}

/** The heatmap renderer properties face the SDK accepts (a plain properties object, never an instance). */
type HeatmapRendererProperties = Extract<NonNullable<FeatureLayerProperties['renderer']>, { type: 'heatmap' }>

/** One feature override patch the map-layers contract carries. */
type OverridePatch = NonNullable<NonNullable<MapLayerRecord['overrides']>['entries'][number]>['patch']

/** The base color of a symbol-less layer without a legend (neutral ArcGIS-family blue-gray). */
const DEFAULT_BASE_COLOR = '#4264fb'

/** Default point diameter when neither a style nor a symbol block decides one. */
const SIZE_DEFAULT_PX = 8

/** Default line width when neither a symbol block nor a highlight decides one. */
const LINE_DEFAULT_WIDTH = 2.5

/** The study-AOI outline: the `aoi` semantic line block, so the AOI reads like an `aoi` layer. */
const AOI_OUTLINE = semanticBlocksOf('aoi').line

/** Render one hex color with the block opacity folded into its alpha (CSS rgba). */
function rgbaOf(hex: string, opacity: number): string {
  if (opacity >= 1) return hex
  const channels = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Math.max(0, Math.min(1, opacity))})`
}

/** One layer's override table: last entry wins the shared id. */
function overrideTableOf(record: MapLayerRecord): Map<string, OverridePatch> {
  const table = new Map<string, OverridePatch>()
  for (const entry of record.overrides?.entries ?? []) {
    for (const id of entry.featureIds) table.set(id, entry.patch)
  }
  return table
}

/** The single-presentation symbol of one layer, when it carries one. */
function singleSymbolOf(record: MapLayerRecord): SingleSymbolStyle | undefined {
  if (record.symbol !== undefined) return record.symbol.presentation === 'single' ? resolveSingleSymbol(record.symbol) : undefined
  // A layer that declared no symbol wears the style of what its name says it is.
  return inferredSymbolOf(record.name, record.id)
}

/**
 * The symbol one feature wears under the R4 resolution order: per-feature
 * override > classification (StyleSpec colors, graduated sizes, missing
 * shape — unchanged semantics) > explicit symbol block (shape, size/width
 * baseline, line pattern, outline) > semantic block (`resolveSingleSymbol`)
 * > legend color with the default halo/translucent-fill look > ArcGIS default. Block and override opacity fold
 * into the symbol color as rgba; the layer-level opacity keeps its own
 * `graphics.opacity` channel, so the renderer multiplies both naturally.
 * @returns the symbol, or `undefined` when nothing styles the layer (ArcGIS default).
 */
function symbolFor(
  geometryType: 'Point' | 'LineString' | 'Polygon',
  style: StyleSpec | null,
  classified: ClassifiedValue,
  selected: boolean,
  symbol: SingleSymbolStyle | undefined,
  override: OverridePatch | undefined,
  legendColor: string | undefined,
): ArcgisSymbol | undefined {
  const isClass = typeof classified === 'number'
  const classColor = style === null
    ? undefined
    : isClass ? (style.palette[classified] as string) : classified === 'missing' ? style.missingColor : style.overflowColor
  if (geometryType === 'Point') {
    const block = symbol?.point
    const color = override?.color ?? classColor ?? block?.color ?? legendColor ?? DEFAULT_BASE_COLOR
    const opacity = override?.opacity ?? block?.opacity ?? 1
    const size = override?.sizePx
      ?? (style?.encoding === 'size'
        ? sizeForClass(isClass ? classified : style.palette.length, style.palette.length)
        : block?.sizePx ?? SIZE_DEFAULT_PX)
    // A classified missing value keeps its x shape (the existing semantics);
    // otherwise the symbol block decides the shape.
    const shape = override?.shape
      ?? (style !== null && classified === 'missing' ? 'x' : block?.shape ?? 'circle')
    return new SimpleMarkerSymbol({
      color: rgbaOf(color, opacity),
      style: shape,
      size: selected ? size + HIGHLIGHT_MARKER_GROWTH_PX : size,
      outline: {
        color: selected ? HIGHLIGHT_COLOR : override?.outlineColor ?? block?.outlineColor ?? HALO_COLOR,
        width: selected ? HIGHLIGHT_MARKER_RING_PX : override?.outlineWidthPx ?? block?.outlineWidthPx ?? HALO_WIDTH,
      },
    }) as ArcgisSymbol
  }
  if (geometryType === 'LineString') {
    const block = symbol?.line
    const color = override?.color ?? classColor ?? block?.color ?? legendColor ?? DEFAULT_BASE_COLOR
    const opacity = override?.opacity ?? block?.opacity ?? 1
    const pattern = override?.pattern
      ?? (style !== null && classified === 'missing' ? 'dash' : block?.pattern ?? 'solid')
    const width = override?.widthPx ?? block?.widthPx ?? LINE_DEFAULT_WIDTH
    return new SimpleLineSymbol({
      color: selected ? HIGHLIGHT_COLOR : rgbaOf(color, opacity),
      style: pattern,
      width: selected ? Math.max(width + 1, HIGHLIGHT_WIDTH) : width,
      cap: 'round',
      join: 'round',
    }) as ArcgisSymbol
  }
  const block = symbol?.fill
  const color = override?.color ?? classColor ?? block?.color ?? legendColor ?? DEFAULT_BASE_COLOR
  // A classified or block-styled fill keeps its declared opacity (1 by
  // contract); only the legend-color fallback takes the translucent default.
  const opacity = override?.opacity ?? block?.opacity ?? (classColor === undefined && block === undefined ? FALLBACK_FILL_OPACITY : 1)
  return new SimpleFillSymbol({
    color: rgbaOf(color, opacity),
    outline: {
      color: selected ? HIGHLIGHT_COLOR : override?.outlineColor ?? block?.outlineColor ?? shadeOf(color, FILL_OUTLINE_SHADE),
      width: selected ? HIGHLIGHT_WIDTH : override?.outlineWidthPx ?? block?.outlineWidthPx ?? 1.2,
      style: style !== null && classified === 'missing' ? 'dash' : 'solid',
    },
  }) as ArcgisSymbol
}

/** Label text color of a layer with no symbol: neutral dark gray under a white halo, as in MapLibre/OSM basemap styles. */
const LABEL_TEXT_COLOR = '#333333'

/** Channel factor deep-shading a symbol color into label ink (water labels read dark blue, as in Mapbox styles). */
const LABEL_SHADE = 0.55

/**
 * The field one layer labels by: the symbol's declared label field, else
 * the first name-like candidate any rendered feature carries.
 * @returns the field, or `null` when the layer has nothing to label.
 */
function labelFieldOf(record: MapLayerRecord, entries: readonly AppliedGraphic[]): string | null {
  const declared = record.symbol !== undefined && record.symbol.presentation === 'single' ? record.symbol.label?.field : undefined
  if (declared !== undefined) return declared
  for (const field of LABEL_FIELD_CANDIDATES) {
    if (entries.some(entry => typeof (entry.graphic.attributes as Record<string, unknown> | null)?.[field] === 'string')) return field
  }
  return null
}

/** Whether one layer's label visibility range admits the view zoom. */
function labelZoomAdmits(record: MapLayerRecord, zoom: number): boolean {
  const label = record.symbol !== undefined && record.symbol.presentation === 'single' ? record.symbol.label : undefined
  if (label === undefined) return true
  return (label.minZoom === undefined || zoom >= label.minZoom) && (label.maxZoom === undefined || zoom <= label.maxZoom)
}

/**
 * The casing stroke drawn beneath one line feature: a translucent white
 * stroke wider than the feature's own, so lines separate from imagery.
 * @returns the casing symbol, or `undefined` when the line has no explicit width source.
 */
function casingFor(main: ArcgisSymbol | undefined): ArcgisSymbol | undefined {
  const width = (main as { width?: unknown } | undefined)?.width
  if (typeof width !== 'number') return undefined
  return new SimpleLineSymbol({ color: CASING_COLOR, style: 'solid', width: width + CASING_EXTRA_PX, cap: 'round', join: 'round' }) as ArcgisSymbol
}

/** The non-undefined ArcGIS symbol face the factory builds. */
type ArcgisSymbol = NonNullable<GraphicProperties['symbol']>

/**
 * Build one occurrence's map face.
 * @param getState - reads the current container state.
 * @param sessionId - exclusive owning Session in this browser module.
 * @param occurrenceKey - the bound Sidebar tab id used by render receipts and gestures.
 * @param hooks - observation delivery and its clock.
 * @returns the lazy ArcGIS face; dispose releases its Session identity.
 * @throws If that Session already owns a live occurrence.
 */
export function createMapOccurrence(
  getState: () => MapContainerState | undefined,
  sessionId: SessionId,
  occurrenceKey: string,
  hooks: {
    readonly onGestureObservation?: GestureEmit
    readonly gestureClock?: GestureClock
    /** Receives the hovered feature's attribute card, or `null` when the pointer leaves every feature. */
    readonly onInspect?: (inspection: FeatureInspection | null) => void
    /** Receives every settled 2D camera (user or programmatic) as implicit model context. */
    readonly onViewport?: (snapshot: GestureCameraSnapshot) => void
  } = {},
): MapOccurrence {
  if (sessionOccurrences.has(sessionId)) throw new Error('A map occurrence is already bound to this Session')
  const handleKey = `${sessionId}:${occurrenceKey}`
  const receiptStore = createRenderReceiptStore(sessionId, occurrenceKey)
  let generation = receiptStore.get()?.generation ?? 0
  let viewId: string | null = null
  let lastObservationSeq: number | null = null
  let attempt = 0
  let disposed = false
  let renderWait: AbortController | undefined
  let renderKey: string | undefined
  let receipt: MapRenderReceipt = Object.freeze({
    sessionId, occurrenceKey, status: 'unavailable', revision: getState()?.revision ?? null,
    renderedRevision: null, generation, viewId, attempt, layerVersions: Object.freeze([]),
    failedLayers: Object.freeze([]), reason: 'not-mounted', at: new Date().toISOString(),
  })
  let publishedHandle: MapHarnessTestHandle | undefined
  let mapView: MapView | undefined
  let sceneView: SceneView | undefined
  let mapForMapView: EsriMap | undefined
  let mapForSceneView: EsriMap | undefined
  let mapEngineKey: number | undefined
  let sceneEngineKey: number | undefined
  let appliedCamera: { center: readonly [number, number]; zoom: number; wkid: number } | undefined
  const layerByName = new Map<string, AppliedLayer>()
  /** The pinned time frame, or `null` when every feature shows. */
  let timeFrame: { readonly index: number; readonly startMs: number; readonly endMs: number } | null = null
  /** Per-layer shared-selection ids the highlight wears. */
  const highlights = new Map<string, Set<string>>()
  /** The AOI outline layer and the ring key it currently draws. */
  let aoiLive: { readonly graphics: GraphicsLayer; readonly ringKey: string } | undefined
  /** The label overlay (always the top layer of the 2D map) and its last placement count. */
  let labelOverlay: LabelOverlay | undefined
  let hoverBusy = false
  /** Layer ids the last applied state carried; `undefined` before the first apply (mount and replay never auto-frame). */
  let knownLayerIds: Set<string> | undefined
  let hoverNext: { readonly x: number; readonly y: number } | 'leave' | undefined
  let hoveredKey: string | null = null
  let placedLabelCount = 0
  /** Gesture observer + event handles of the live view; rebuilt with the view. */
  let gestureObserver: GestureObserver | undefined
  const gestureHandles: { remove(): void }[] = []

  /** Forward one settled observation to the session-queue sink. */
  const gestureEmit: GestureEmit = (text, observation) => {
    const state = getState()
    if (state !== undefined) publishHandle(state)
    hooks.onGestureObservation?.(text, observation)
  }

  /** Plain-number camera fix from the live view; `undefined` when the view cannot report one. */
  function gestureSnapshotOf(view: MapView | SceneView, mode: 'map' | 'scene'): GestureCameraSnapshot | undefined {
    // The policy module owns the conversion; its snapshot is field-for-field
    // the gesture wire type, so the assertion is the only bridge needed.
    return viewportSnapshotOf(view, mode) as GestureCameraSnapshot | undefined
  }

  /** A refused capture, as the plain object the face documents rather than an `Error`. */
  function captureFailure(error: CaptureError): Promise<never> {
    return Promise.reject(error)
  }

  /** Capture the live view; a destroyed or missing view, a hang, or an SDK throw all reject distinctly. */
  async function captureLiveView(): Promise<CaptureResult> {
    const mode = mapView !== undefined ? 'map' : 'scene'
    const view = mapView ?? sceneView
    if (disposed || view === undefined || view.destroyed) return captureFailure({ code: 'no-view' })
    const viewport: ViewSnapshot | null = viewportSnapshotOf(view, mode) ?? null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject({ code: 'capture-timeout' } satisfies CaptureError), captureTimeoutMs)
    })
    try {
      const shot = await Promise.race([view.takeScreenshot({ format: 'png' }), timeout])
      return { dataUrl: shot.dataUrl, viewport }
    } catch (error: unknown) {
      // A timeout rejects with its own typed object and must keep that code.
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      return captureFailure({ code: 'capture-failed', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Mute attribution while the occurrence itself drives the camera (syncCamera, focus goTo). */
  function muteGestureAttribution(): void {
    gestureObserver?.programmatic()
  }

  /** Frame one WGS84 bbox with programmatic attribution, so the move never becomes a gesture draft. */
  function frameBbox(bbox: LonLatBbox): void {
    const active = mapView ?? sceneView
    if (active === undefined) return
    muteGestureAttribution()
    const extent = new Extent({
      xmin: bbox.west,
      ymin: bbox.south,
      xmax: bbox.east,
      ymax: bbox.north,
      spatialReference: SpatialReference.WGS84,
    })
    void active.goTo(extent).catch(() => {
      // Empty geometry or a view already destroyed during tab switch.
    })
  }

  /**
   * Whether one WGS84 bbox already sits inside the live view: both corners
   * project inside the view's pixel box. A view that cannot project (no size
   * yet, 3D off-globe) counts as not containing it.
   */
  function bboxInView(view: MapView | SceneView, bbox: LonLatBbox): boolean {
    const width = view.width
    const height = view.height
    if (!(width > 0 && height > 0)) return false
    for (const [lon, lat] of [[bbox.west, bbox.south], [bbox.east, bbox.north]] as const) {
      const screen = view.toScreen(new Point({ longitude: lon, latitude: lat, spatialReference: SpatialReference.WGS84 }))
      if (screen == null || screen.x < 0 || screen.y < 0 || screen.x > width || screen.y > height) return false
    }
    return true
  }

  /** Attach interaction events and the camera watch for one freshly built view. */
  function attachGestureView(
    view: MapView | SceneView,
    mode: 'map' | 'scene',
    readCamera: () => MapView['viewpoint'] | SceneView['camera'],
  ): void {
    gestureObserver?.dispose()
    gestureHandles.length = 0
    const observer = createGestureObserver({
      sessionId, occurrenceKey, generationOf: () => generation, emit: gestureEmit,
      clock: hooks.gestureClock ?? realGestureClock,
    })
    gestureObserver = observer
    for (const eventName of GESTURE_INTERACTION_EVENTS) {
      gestureHandles.push(view.on(eventName, () => { observer.interaction() }))
    }
    if (mode === 'map') {
      // Hover inspects: one hit test in flight, the latest pointer position wins.
      gestureHandles.push(view.on('pointer-move', event => { hoverAt(view as MapView, event) }))
      gestureHandles.push(view.on('pointer-leave', () => { hoverAt(view as MapView, null) }))
      // Labels are hidden while the camera moves and re-placed once it
      // settles: screen positions change with every pan and zoom, and
      // drawing them mid-gesture would only lag and flicker.
      gestureHandles.push(watch(() => view.stationary, stationary => {
        if (stationary !== true) {
          labelOverlay?.setSuspended(true)
          return
        }
        placeLabelsNow()
        labelOverlay?.setSuspended(false)
        const snapshot = gestureSnapshotOf(view, 'map')
        if (snapshot !== undefined) hooks.onViewport?.(snapshot)
      }))
    }
    gestureHandles.push(watch(readCamera, () => {
      const snapshot = gestureSnapshotOf(view, mode)
      if (snapshot !== undefined) observer.cameraChanged(snapshot)
    }))
  }

  /** Schedule one hover hit test; `null` means the pointer left the view. */
  function hoverAt(view: MapView, event: { readonly x: number; readonly y: number } | null): void {
    hoverNext = event === null ? 'leave' : { x: event.x, y: event.y }
    if (hoverBusy) return
    hoverBusy = true
    void (async () => {
      try {
        while (hoverNext !== undefined && !disposed) {
          const next = hoverNext
          hoverNext = undefined
          if (next === 'leave') reportHover(null)
          else await inspectAt(view, next)
        }
      } finally {
        hoverBusy = false
      }
    })()
  }

  /** Report one hover outcome only when the hovered feature changed. */
  function reportHover(target: { readonly layerId: string; readonly featureId: string; readonly report: () => void } | null): void {
    const key = target === null ? null : `${target.layerId}\u0000${target.featureId}`
    if (key === hoveredKey) return
    hoveredKey = key
    if (target === null) hooks.onInspect?.(null)
    else target.report()
  }

  /**
   * Resolve one hover position to the topmost data feature and hand its
   * attribute card to the host; the feature takes the shared highlight while
   * hovered. Casing and label graphics are skipped: only a layer's own
   * entries count.
   */
  async function inspectAt(view: MapView, event: { readonly x: number; readonly y: number }): Promise<void> {
    const onInspect = hooks.onInspect
    if (onInspect === undefined) return
    const include = [...layerByName.values()].filter(live => live.kind === 'graphics' && live.carrier.visible).map(live => live.carrier as GraphicsLayer)
    let hits: readonly { readonly type: string; readonly graphic?: Graphic }[]
    try {
      hits = include.length === 0 ? [] : (await view.hitTest({ x: event.x, y: event.y }, { include })).results
    } catch (hitTestError) {
      // A view destroyed mid-hover has nothing to inspect; the card stays closed.
      hits = []
    }
    if (disposed || view.destroyed) return
    for (const hit of hits) {
      if (hit.type !== 'graphic' || hit.graphic === undefined) continue
      for (const [layerId, live] of layerByName) {
        const entry = live.entries.find(candidate => candidate.graphic === hit.graphic)
        if (entry === undefined) continue
        const record = getState()?.layers.get(layerId)
        const attributes = (entry.graphic.attributes ?? {}) as Record<string, unknown>
        reportHover({
          layerId, featureId: entry.id,
          report: () => {
            occurrence.setHighlight(layerId, new Set([entry.id]))
            onInspect(inspectionOf({ layerId, layerName: record?.name ?? live.name, featureId: entry.id }, attributes, record === undefined ? null : labelFieldOf(record, live.entries)))
          },
        })
        return
      }
    }
    reportHover(null)
  }

  /**
   * Re-place every label of the live 2D view: project each visible graphics
   * layer's anchors to screen pixels (top layer first claims space), place
   * greedily without collisions, and redraw the label overlay.
   */
  function placeLabelsNow(): void {
    const view = mapView
    const state = getState()
    if (view === undefined || view.destroyed || state === undefined || view.map == null) return
    const width = view.width
    const height = view.height
    if (!(width > 0 && height > 0)) return
    const zoom = view.zoom >= 0 ? view.zoom : zoomFromScale(view.scale)
    const candidates: LabelCandidate[] = []
    const ids = [...state.layers.keys()].reverse()
    for (const id of ids) {
      const record = state.layers.get(id)
      const live = layerByName.get(id)
      if (record === undefined || live === undefined || live.kind !== 'graphics' || !record.visible) continue
      if (!labelZoomAdmits(record, zoom)) continue
      const field = labelFieldOf(record, live.entries)
      if (field === null) continue
      const labelSymbol = singleSymbolOf(record)
      const symbolColor = labelSymbol?.point?.color ?? labelSymbol?.line?.color ?? labelSymbol?.fill?.color
      const color = symbolColor === undefined ? LABEL_TEXT_COLOR : shadeOf(symbolColor, LABEL_SHADE)
      for (const entry of live.entries) {
        if (entry.anchor === null) continue
        const text = labelTextOf(entry.graphic.attributes as Record<string, unknown> | null, field)
        if (text === null) continue
        const screen = view.toScreen(new Point({ longitude: entry.anchor.lon, latitude: entry.anchor.lat, spatialReference: SpatialReference.WGS84 }))
        if (screen == null) continue
        const marker = entry.graphic.symbol as { size?: unknown } | null
        candidates.push({
          key: `${id}:${entry.id}`, text, kind: entry.anchor.kind, x: screen.x, y: screen.y,
          markerPx: typeof marker?.size === 'number' ? marker.size : 0,
          color,
        })
      }
    }
    const placed = placeLabels(candidates, { width, height })
    if (labelOverlay === undefined && holder !== undefined) labelOverlay = createLabelOverlay(holder)
    labelOverlay?.render(placed)
    placedLabelCount = placed.length
  }

  /** Drop graphics and destroy both engines so a WKID change can rebuild. */
  function destroyViews(): void {
    renderWait?.abort()
    renderKey = undefined
    gestureObserver?.dispose()
    gestureObserver = undefined
    for (const handle of gestureHandles.splice(0)) handle.remove()
    const liveMaps = new Set<EsriMap>()
    if (mapForMapView !== undefined) liveMaps.add(mapForMapView)
    if (mapForSceneView !== undefined) liveMaps.add(mapForSceneView)
    if (aoiLive !== undefined) {
      for (const map of liveMaps) map.remove(aoiLive.graphics)
      aoiLive.graphics.destroy()
      aoiLive = undefined
    }
    for (const live of layerByName.values()) live.carrier.destroy()
    layerByName.clear()
    labelOverlay?.dispose()
    labelOverlay = undefined
    placedLabelCount = 0
    dataTokens.clear()
    mapView?.destroy()
    sceneView?.destroy()
    for (const map of liveMaps) map.destroy()
    mapView = undefined
    sceneView = undefined
    mapForMapView = undefined
    mapForSceneView = undefined
    mapEngineKey = undefined
    sceneEngineKey = undefined
    appliedCamera = undefined
    viewId = null
  }

  /** Publish one live observation and store it without treating persistence as session durability. */
  function observe(next: MapRenderReceipt, state: MapContainerState | undefined): void {
    void maybeCaptureObservation(state)
    receiptStore.set(next)
    receipt = receiptStore.get()!
    if (state !== undefined) publishHandle(state)
  }

  /** Invalidate pending rendering when no current mounted view can attest the projection. */
  function unavailable(reason: 'not-mounted' | 'no-projection' | 'disposed', state: MapContainerState | undefined): void {
    renderWait?.abort()
    renderKey = undefined
    observe({
      ...receipt, status: 'unavailable', revision: state?.revision ?? null, renderedRevision: null,
      generation, viewId: null, attempt: ++attempt, layerVersions: [], failedLayers: [], reason,
      at: new Date().toISOString(),
    }, state)
  }

  /** Await one browser paint opportunity; abort releases the queued callback during teardown. */
  function paintFrame(signal: AbortSignal): Promise<void> {
    if (typeof requestAnimationFrame === 'undefined') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        cancelAnimationFrame(id)
        reject(signal.reason)
      }
      const id = requestAnimationFrame(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** Only this attempt on this concrete view may finish its receipt. */
  function ownsRender(target: MapRenderReceipt, view: MapView | SceneView, signal: AbortSignal): boolean {
    return !signal.aborted && !disposed && holder !== undefined && !view.destroyed
      && receipt.attempt === target.attempt && receipt.viewId === target.viewId
  }

  /** Wait for the view, every visible graphics layer, and a stable post-update paint. */
  async function finishRender(
    view: MapView | SceneView, state: MapContainerState, target: MapRenderReceipt,
    layers: readonly { id: string | null; graphics: GraphicsLayer | FeatureLayer | WebTileLayer }[], signal: AbortSignal,
  ): Promise<void> {
    try {
      await view.when()
      if (!ownsRender(target, view, signal)) return
      const outcomes = await Promise.all(layers.map(async ({ id, graphics }) => {
        try {
          return { layerView: await view.whenLayerView(graphics), failure: null }
        } catch (error) {
          // Raw SDK exceptions may contain URLs; receipts carry fixed reason codes only.
          return { layerView: null, failure: { layerId: id, code: id === null ? 'AOI_FAILED' : 'LAYER_FAILED' } as MapRenderFailure }
        }
      }))
      if (!ownsRender(target, view, signal)) return
      const failures = outcomes.flatMap(outcome => outcome.failure === null ? [] : [outcome.failure])
      if (failures.length > 0) {
        observe({ ...target, status: 'failed', failedLayers: failures, at: new Date().toISOString() }, state)
        return
      }
      const settled = (): boolean => !view.updating && !view.suspended
        && outcomes.every(outcome => outcome.layerView !== null && !outcome.layerView.updating)
      do {
        await whenOnce(settled, { signal })
        await paintFrame(signal)
        await paintFrame(signal)
      } while (!settled() && ownsRender(target, view, signal))
      if (!ownsRender(target, view, signal)) return
      observe({ ...target, status: 'rendered', renderedRevision: target.revision, at: new Date().toISOString() }, state)
    } catch (error) {
      // Superseded/disposed observations are cancelled, never reported as new failures.
      if (!ownsRender(target, view, signal)) return
      observe({ ...target, status: 'failed', failedLayers: [{ layerId: null, code: 'VIEW_FAILED' }], at: new Date().toISOString() }, state)
    }
  }

  /** Whether one feature shows under the pinned time frame; a missing event time never matches. */
  function featureWithinFrame(state: MapContainerState, layerId: string, feature: { properties?: Record<string, unknown> | null }): boolean {
    if (timeFrame === null) return true
    const binding = state.layers.get(layerId)?.style?.timeBinding
    if (binding === undefined) return true
    const raw = feature.properties?.[binding.timeField]
    const timeMs = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
    return Number.isFinite(timeMs) && timeMs >= timeFrame.startMs && timeMs < timeFrame.endMs
  }

  /** Apply container state onto the live view; missing pieces are created on demand. */
  /**
   * Visual observation: when the projection carries a fresh
   * `observationRequest` and this occurrence has RENDERED that exact
   * revision, capture the view and submit the PNG to the host route. An
   * offline or unrendered occurrence simply never submits — the host-side
   * wait times out honestly.
   */
  async function maybeCaptureObservation(state: MapContainerState | undefined): Promise<void> {
    const request = state?.observationRequest
    if (disposed || request === null || request === undefined) return
    if (lastObservationSeq === request.requestSeq) return
    lastObservationSeq = request.requestSeq
    const active = mapView ?? sceneView
    if (active === undefined || active.destroyed) return
    if (receipt.status !== 'rendered' || receipt.renderedRevision !== request.revision) return
    try {
      const shot = await active.takeScreenshot({ format: 'png' })
      const pngBase64 = (shot.dataUrl.split(',')[1] ?? '')
      await fetch('/api/map/observation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          callId: request.callId,
          requestSeq: request.requestSeq,
          renderedRevision: receipt.renderedRevision,
          viewId: viewId ?? '',
          pngBase64,
        }),
      })
    } catch {
      // Submission failures surface host-side as an honest timeout.
    }
  }

  function applyState(possible: MapContainerState | undefined): void {
    if (disposed) return
    if (possible === undefined || holder === undefined) {
      unavailable(possible === undefined ? 'no-projection' : 'not-mounted', possible)
      return
    }
    // A mode switch leaves the other engine behind: its graphics still point
    // at the old map and its camera was never synced for this mode. Rebuild.
    if (possible.mode === 'map' && sceneView !== undefined) destroyViews()
    if (possible.mode === 'scene' && mapView !== undefined) destroyViews()
    let active: MapView | SceneView | undefined
    try {
      active = possible.mode === 'scene' ? ensureScene(possible) : ensureMap(possible)
    } catch (error) {
      observe({
        ...receipt, status: 'failed', revision: possible.revision, renderedRevision: null,
        generation, viewId, attempt: ++attempt, layerVersions: [],
        failedLayers: [{ layerId: null, code: 'VIEW_FAILED' }], reason: null, at: new Date().toISOString(),
      }, possible)
      return
    }
    if (active === undefined) return
    const key = JSON.stringify([generation, possible.revision, possible.view, possible.aoi,
      [...possible.layers.values()].map(record => [record.id, renderToken(record), record.visible, record.opacity]),
      [...highlights].map(([id, ids]) => [id, [...ids]])])
    if (key === renderKey) {
      publishHandle(possible)
      return
    }
    renderWait?.abort()
    renderWait = new AbortController()
    const signal = renderWait.signal
    renderKey = key
    const target: MapRenderReceipt = {
      sessionId, occurrenceKey, status: 'applied', revision: possible.revision, renderedRevision: null,
      generation, viewId, attempt: ++attempt,
      layerVersions: [...possible.layers.values()].map(record => ({ id: record.id, token: renderToken(record) })),
      failedLayers: [], reason: null, at: new Date().toISOString(),
    }
    const known = knownLayerIds
    const added = known === undefined ? [] : [...possible.layers.keys()].filter(id => !known.has(id))
    knownLayerIds = new Set(possible.layers.keys())
    const failures = applyLayers(active, possible)
    try {
      applyAoi(active, possible)
    } catch (error) {
      failures.push({ layerId: null, code: 'AOI_FAILED' } as MapRenderFailure)
    }
    const nextCamera = {
      center: possible.view.center,
      zoom: possible.view.zoom,
      wkid: possible.view.wkid,
    }
    const cameraMoved = appliedCamera !== undefined && !viewCameraEquals(appliedCamera, nextCamera)
    if (appliedCamera === undefined || !viewCameraEquals(appliedCamera, nextCamera)) {
      syncCamera(active, possible.view)
      appliedCamera = nextCamera
    }
    // A layer the conversation just produced comes into view: frame the
    // newest one with extent when it lies outside the visible view, unless
    // the same revision also moved the camera.
    const framed = added.reverse()
      .map(id => { const data = possible.layers.get(id)?.data; return data === undefined ? null : geoJsonBbox(data) })
      .find(bbox => bbox !== null)
    if (framed !== undefined && framed !== null && !cameraMoved && !bboxInView(active, framed)) frameBbox(framed)
    observe(failures.length > 0 ? { ...target, status: 'failed', failedLayers: failures } : target, possible)
    if (failures.length > 0) return
    const layers = [...layerByName].filter(([, live]) => live.carrier.visible)
      .map(([id, live]) => ({ id: id as string | null, graphics: live.carrier }))
    if (aoiLive !== undefined) layers.push({ id: null, graphics: aoiLive.graphics })
    placeLabelsNow()
    void finishRender(active, possible, target, layers, signal)
  }

  /** Ensure the 2D MapView exists for this holder. */
  function ensureMap(state: MapContainerState): MapView | undefined {
    if (holder === undefined) return undefined
    const engine = viewEngineKey(state.view.wkid)
    if (mapView !== undefined && mapEngineKey !== engine) destroyViews()
    if (mapView === undefined) {
      // The cast bridges ArcGIS's exactOptionalPropertyTypes gap between the
      // Map instance type and the MapProperties the View constructor declares.
      const map = buildMap(state.view.wkid) as unknown as MapProperties
      const built = new MapView({ container: holder, map, ui: { components: [] } })
      mapView = built
      mapForMapView = map as unknown as EsriMap
      mapEngineKey = engine
      generation += 1
      viewId = crypto.randomUUID()
      attachGestureView(built, 'map', () => built.viewpoint)
    }
    return mapView
  }

  /** Ensure the 3D SceneView exists; local scenes accept projected WKIDs. */
  function ensureScene(state: MapContainerState): SceneView | undefined {
    if (holder === undefined) return undefined
    const engine = viewEngineKey(state.view.wkid)
    if (sceneView !== undefined && sceneEngineKey !== engine) destroyViews()
    if (sceneView === undefined) {
      const map = buildMap(state.view.wkid) as unknown as MapProperties
      const wkid = explicitSpatialReferenceWkid(state.view.wkid)
      const built = new SceneView({
        container: holder,
        map,
        ui: { components: [] },
        viewingMode: 'local',
        ...wkid === undefined ? {} : { spatialReference: SpatialReference.fromJSON({ wkid }) },
      })
      sceneView = built
      mapForSceneView = map as unknown as EsriMap
      sceneEngineKey = engine
      generation += 1
      viewId = crypto.randomUUID()
      attachGestureView(built, 'scene', () => built.camera)
    }
    return sceneView
  }

  /** The holder element the view was mounted into. */
  let holder: HTMLDivElement | undefined

  /** Position a view per the record; center is WGS84 lon/lat, zoom is the Web-Mercator scale convention.
   *
   * A 4326 display record means "geographic" and leaves the view in its
   * default Web Mercator: raster tile services are 3857, and forcing a
   * geographic spatial reference renders no tiles. Projected WKIDs are
   * applied explicitly. Called on every convergence so a view created under an
   * older record keeps following map_set_view. */
  function syncCamera(view: MapView | SceneView, record: MapViewRecord): void {
    const wkid = explicitSpatialReferenceWkid(record.wkid)
    if (wkid !== undefined && view.spatialReference?.wkid !== wkid) view.spatialReference = SpatialReference.fromJSON({ wkid })
    void view.when(() => {
      // A WKID/mode switch destroys this view while the when() promise is
      // still pending; a resolved-then-destroyed view must not be written.
      if (view.destroyed || appliedCamera === undefined || !viewCameraEquals(appliedCamera, record)) return
      muteGestureAttribution()
      view.center = new Point({ longitude: record.center[0], latitude: record.center[1], spatialReference: SpatialReference.WGS84 })
      // Cached-tile (Web Mercator) views have raster LODs; projected views
      // keep MapView.zoom at -1 and take the camera through scale instead.
      if (basemapKindFor(record.wkid) === 'cached-xyz') view.zoom = record.zoom
      else view.scale = scaleFromZoom(record.zoom)
    }).catch(() => {
      // A view can reject while ArcGIS is tearing it down during a tab switch.
      // The occurrence remains disposable and the next refresh can rebuild it.
    })
  }

  /** The render carrier one layer record wants (imagery tiles, heatmap features, plain graphics). */
  function carrierKindOf(record: MapLayerRecord): AppliedLayer['kind'] {
    if (record.imagery !== undefined) return 'tile'
    if (record.symbol !== undefined && record.symbol.presentation === 'heatmap') return 'heatmap'
    return 'graphics'
  }

  /** The display ramp stops one heatmap block renders (explicit, deterministic). */
  function heatmapStopsOf(ramp: HeatmapBlock['ramp']): string[] {
    switch (ramp) {
      case 'viridis': return ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725']
      case 'plasma': return ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921']
      case 'inferno': return ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4']
      case 'magma': return ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']
      case 'blues': return ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b']
      case 'reds': return ['#fff5f0', '#fcbba1', '#fb6a4a', '#cb181d', '#67000d']
    }
  }

    function heatmapRendererOf(block: HeatmapBlock): HeatmapRendererProperties {
    const stops = heatmapStopsOf(block.ramp)
    return {
      type: 'heatmap',
      radius: block.radiusPx,
      ...(block.field === undefined ? {} : { field: block.field }),
      ...(block.minIntensity === undefined ? {} : { minDensity: block.minIntensity }),
      ...(block.maxIntensity === undefined ? {} : { maxDensity: block.maxIntensity }),
      colorStops: stops.map((color, at) => ({ ratio: at / (stops.length - 1), color })),
    }
  }

  /** The client-side FeatureLayer source one heatmap layer renders (same data authority, swapped carrier). */
  function heatmapCarrierOf(record: MapLayerRecord): FeatureLayer {
    const block = record.symbol !== undefined && record.symbol.presentation === 'heatmap' ? record.symbol.heatmap : undefined
    const sr = SpatialReference.WGS84
    const features = (record.data as { features?: { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null }[] } | undefined)?.features ?? []
    const source = features.map((feature, index) => {
      const [x, y] = (feature.geometry?.coordinates ?? [0, 0]) as [number, number]
      const weight = block?.field === undefined ? undefined : feature.properties?.[block.field]
      return new Graphic({
        geometry: new Point({ longitude: x, latitude: y, spatialReference: sr }),
        attributes: {
          __fid: index + 1,
          ...(block?.field === undefined || typeof weight !== 'number' ? {} : { [block.field]: weight }),
        },
      })
    })
    return new FeatureLayer({
      title: record.name,
      source,
      objectIdField: '__fid',
      fields: [
        { name: '__fid', type: 'oid' },
        ...(block?.field === undefined ? [] : [{ name: block.field, type: 'double' as const }]),
      ],
      ...(block === undefined ? {} : { renderer: heatmapRendererOf(block) }),
    })
  }

  /** Make the live render carriers match the state's layer records. */
  function applyLayers(view: MapView | SceneView, state: MapContainerState): MapRenderFailure[] {
    const failures: MapRenderFailure[] = []
    const map = view.map
    if (map == null) return [{ layerId: null, code: 'VIEW_FAILED' }]
    for (const record of state.layers.values()) {
      try {
        const kind = carrierKindOf(record)
        let live = layerByName.get(record.id)
        if (live !== undefined && live.kind !== kind) {
          // A presentation change swaps the carrier (graphics ↔ heatmap); an
          // imagery identity arrives on a fresh layer record.
          map.remove(live.carrier)
          live.carrier.destroy()
          layerByName.delete(record.id)
          dataTokens.delete(record.id)
          live = undefined
        }
        if (live === undefined) {
          const carrier = kind === 'tile'
            ? new WebTileLayer({ title: record.name, urlTemplate: record.imagery?.urlTemplate ?? '', copyright: record.imagery?.attribution ?? '' })
            : kind === 'heatmap'
              ? heatmapCarrierOf(record)
              : new GraphicsLayer({ title: record.name })
          map.add(carrier)
          live = { kind, carrier, name: record.name, entries: [] }
          layerByName.set(record.id, live)
        }
        if (live.carrier.visible !== record.visible) live.carrier.visible = record.visible
        if (live.carrier.opacity !== record.opacity) live.carrier.opacity = record.opacity
        syncLayer(live, record, state)
      } catch (error) {
        dataTokens.delete(record.id)
        failures.push({ layerId: record.id, code: 'LAYER_FAILED' })
      }
    }
    for (const [id, live] of layerByName) {
      if (!state.layers.has(id)) {
        map.remove(live.carrier)
        live.carrier.destroy()
        layerByName.delete(id)
        // Dropping the layer also drops its rendered identity: a later
        // re-add of the same id must rebuild the carrier, never reuse a
        // cached data token from the removed layer.
        dataTokens.delete(id)
        highlights.delete(id)
      }
    }
    // Draw order follows the state's layer order (last draws on top). Only
    // the data carriers permute, inside the slots they already occupy, so
    // basemap tiles and the AOI outline keep their positions.
    const wanted = [...state.layers.keys()].map(id => layerByName.get(id)?.carrier).filter(carrier => carrier !== undefined)
    const slots = wanted.map(carrier => map.layers.indexOf(carrier)).sort((left, right) => left - right)
    wanted.forEach((carrier, at) => {
      const slot = slots[at]
      if (slot !== undefined && map.layers.indexOf(carrier) !== slot) map.reorder(carrier, slot)
    })
    return failures
  }

  /**
   * Replace a layer's graphics when its rendered identity changed. The token
   * folds the display identity (the tool's digest, else a content digest over
   * the actual geometry and properties), the style version, and the pinned
   * frame — so a same-id, same-feature-count update with moved features, a
   * reclassification, or a frame step always redraws.
   */
  /**
   * Sync the study AOI outline: a non-null AOI draws as one closed WGS84
   * polygon outline (content-free — the fill stays transparent so features
   * under it stay readable), and `null` clears the graphic.
   */
  function applyAoi(view: MapView | SceneView, state: MapContainerState): void {
    const map = view.map
    if (map == null) return
    const ring = state.aoi?.ring
    const ringKey = ring === undefined ? 'null' : JSON.stringify(ring)
    if (aoiLive !== undefined && aoiLive.ringKey === ringKey) return
    if (aoiLive !== undefined) {
      map.remove(aoiLive.graphics)
      aoiLive.graphics.destroy()
      aoiLive = undefined
    }
    if (ring === undefined || ring.length < 3) return
    const graphics = new GraphicsLayer({ title: state.aoi?.name ?? 'aoi' })
    map.add(graphics)
    const closed = [...ring.map(point => [point[0], point[1]] as number[]), [ring[0]![0], ring[0]![1]]]
    const polygon = new Polygon({ rings: [closed], spatialReference: SpatialReference.WGS84 })
    graphics.add(new Graphic({
      geometry: polygon,
      // The symbol cast bridges ArcGIS's exactOptionalPropertyTypes gap on
      // the outline property (same as the layer-symbol factories above).
      symbol: new SimpleFillSymbol({
        color: [0, 0, 0, 0],
        outline: { color: AOI_OUTLINE.color, width: AOI_OUTLINE.widthPx, style: 'dash' },
      }) as ArcgisSymbol,
    }))
    aoiLive = { graphics, ringKey }
  }

  const dataTokens = new Map<string, string>()
  function renderToken(record: MapLayerRecord): string {
    const dataToken = record.displayDigest ?? (record.data !== undefined ? contentDigestOf(record.data) : `imagery:${record.imagery?.urlTemplate ?? 'none'}`)
    // The terrain revision rides the render token explicitly: two surface
    // versions can decimate to identical display copies, and only the
    // revision tells the occurrence to redraw for the new version. The same
    // logic keeps stream workbenches live: the workbench revision and mode
    // change even when the window display copy does not (pause, gap counts).
    // Presentation changes ride the symbol/overrides version tokens the
    // same way, and an imagery layer's rendered identity is its template.
    const streamToken = record.stream === undefined
      ? 'none'
      : `${record.stream.mode}:${record.stream.revision}:${record.stream.paused ? 'paused' : 'live'}`
    return `${dataToken}|${record.style?.styleVersion ?? 'plain'}|${record.symbol?.symbolVersion ?? 'plain'}|${record.overrides?.overridesVersion ?? 'plain'}|${record.terrain?.revision ?? 'none'}|${streamToken}|${timeFrame === null ? 'all' : `${timeFrame.index}:${timeFrame.startMs}-${timeFrame.endMs}`}`
  }
  function syncLayer(live: AppliedLayer, record: MapLayerRecord, state: MapContainerState): void {
    const token = renderToken(record)
    if (dataTokens.get(record.id) === token) return
    switch (live.kind) {
      case 'tile': {
        const carrier = live.carrier as WebTileLayer
        if (record.imagery !== undefined) {
          carrier.urlTemplate = record.imagery.urlTemplate
          carrier.copyright = record.imagery.attribution ?? ''
        }
        dataTokens.set(record.id, token)
        return
      }
      case 'heatmap': {
        // Same data authority, swapped carrier: the FeatureLayer source and
        // renderer are replaced when the token moves (symbol radius/ramp,
        // data, frame), never a second data copy.
        const carrier = live.carrier as FeatureLayer
        const fresh = heatmapCarrierOf(record)
        carrier.source = fresh.source
        if (record.symbol !== undefined && record.symbol.presentation === 'heatmap') {
          carrier.renderer = heatmapRendererOf(record.symbol.heatmap)
        }
        dataTokens.set(record.id, token)
        live.entries = []
        return
      }
      case 'graphics':
        break
    }
    const graphics = live.carrier as GraphicsLayer
    graphics.removeAll()
    if (record.data === undefined) {
      dataTokens.set(record.id, token)
      live.entries = []
      return
    }
    const style = record.style ?? null
    const symbol = singleSymbolOf(record)
    const overrides = overrideTableOf(record)
    const legendColor = record.legend?.symbol.color
    const sr = SpatialReference.WGS84
    const entries: AppliedGraphic[] = []
    const casings: Graphic[] = []
    const selected = highlights.get(record.id) ?? new Set<string>()
    for (const [index, feature] of record.data.features.entries()) {
      if (!featureWithinFrame(state, record.id, feature)) continue
      const geometry = feature.geometry as { type?: string; coordinates?: unknown } | null
      if (geometry === null || geometry === undefined) continue
      const g = (() => {
        if (geometry.type === 'Point') {
          const [x, y] = geometry.coordinates as [number, number]
          // Terrain-preview points carry their elevation as z: the 3D local
          // scene draws them at height; the 2D MapView ignores z. The preview
          // is a bounded decimation — never the analysis surface itself.
          if (record.terrain !== undefined) {
            const elevation = feature.properties?.[record.terrain.elevationField]
            return new Point({
              longitude: x,
              latitude: y,
              ...(typeof elevation === 'number' ? { z: elevation } : {}),
              spatialReference: sr,
            })
          }
          return new Point({ longitude: x, latitude: y, spatialReference: sr })
        }
        if (geometry.type === 'LineString') {
          return new Polyline({ paths: [geometry.coordinates as number[][]], spatialReference: sr })
        }
        if (geometry.type === 'Polygon') {
          return new Polygon({ rings: geometry.coordinates as number[][][], spatialReference: sr })
        }
        return undefined
      })()
      if (g === undefined) continue
      const classified: ClassifiedValue = style === null
        ? 'missing'
        : classifyValue(style, measureValueOf(feature.properties ?? null, style))
      const id = featureIdOf(feature as { id?: unknown }, index)
      const symbolSpec = symbolFor(
        geometry.type as 'Point' | 'LineString' | 'Polygon',
        style,
        classified,
        selected.has(id),
        symbol,
        overrides.get(id),
        legendColor,
      )
      const attributes = graphicAttributesOf(feature.properties, id)
      const graphic = new Graphic({
        geometry: g,
        attributes,
        ...(symbolSpec === undefined ? {} : { symbol: symbolSpec }),
      })
      if (geometry.type === 'LineString') {
        const casing = casingFor(symbolSpec)
        if (casing !== undefined) casings.push(new Graphic({ geometry: g, attributes, symbol: casing }))
      }
      entries.push({ id, geometryType: geometry.type as AppliedGraphic['geometryType'], classified, graphic, anchor: labelAnchorOf(geometry) })
    }
    // Casings draw first so every stroke sits on top of every casing.
    for (const casing of casings) graphics.add(casing)
    for (const entry of entries) graphics.add(entry.graphic)
    live.entries = entries
    dataTokens.set(record.id, token)
  }

  /** Publish the smoke/diagnostic handle for this session's container. */
  function publishHandle(state: MapContainerState): void {
    const handles = (globalThis as { __mapHarness?: Map<string, unknown> }).__mapHarness ?? new Map()
    ;(globalThis as { __mapHarness?: Map<string, unknown> }).__mapHarness = handles
    const handle = {
      renderReceipt: receipt,
      mode: state.mode,
      layerCount: state.layers.size,
      center: state.view.center,
      zoom: state.view.zoom,
      wkid: state.view.wkid,
      engine: 'arcgis-core',
      get camera(): MapHarnessTestHandle['camera'] {
        const active = mapView ?? sceneView
        if (active === undefined || active.destroyed) return null
        const longitude = active.center?.longitude
        const latitude = active.center?.latitude
        const wkid = active.spatialReference?.wkid
        const zoom = active.zoom >= 0 ? active.zoom : zoomFromScale(active.scale)
        if (typeof longitude !== 'number' || typeof latitude !== 'number' || typeof wkid !== 'number'
          || ![longitude, latitude, zoom, wkid].every(Number.isFinite)) return null
        return { center: [longitude, latitude], zoom, wkid }
      },
      styledLayers: [...state.layers.values()].filter(layer => layer.style !== undefined).map(layer => layer.id),
      visibleFeatureCount: [...layerByName.values()].reduce((total, live) => total + live.entries.length, 0),
      frameIndex: timeFrame?.index ?? null,
      highlightCount: [...highlights.values()].reduce((total, ids) => total + ids.size, 0),
      get labelCount() { return placedLabelCount },
      get labels() { return (labelOverlay?.labels ?? []).map(label => ({ text: label.text, x: label.x, y: label.y, color: label.color })) },
      screenOf(longitude: number, latitude: number) {
        if (mapView === undefined || mapView.destroyed) return null
        const screen = mapView.toScreen(new Point({ longitude, latitude, spatialReference: SpatialReference.WGS84 }))
        return screen == null ? null : { x: screen.x, y: screen.y }
      },
      terrainRevisions: [...state.layers.values()]
        .filter(layer => layer.terrain !== undefined)
        .map(layer => `${layer.id}@${(layer.terrain as MapLayerTerrain).revision}`),
      streamStates: [...state.layers.values()]
        .filter(layer => layer.stream !== undefined)
        .map(layer => {
          const stream = layer.stream as MapLayerStream
          return {
            id: layer.id,
            mode: stream.mode,
            revision: stream.revision,
            paused: stream.paused,
            watermarkMs: stream.watermarkMs,
            lagMs: stream.lagMs,
            gapWindows: stream.gapWindows,
            lateRevisions: stream.lateRevisions,
          }
        }),
      gesture: { ...(gestureObserver?.metrics ?? emptyGestureMetrics()) },
    } satisfies MapHarnessTestHandle
    handles.set(handleKey, handle)
    publishedHandle = handle
  }

  const occurrence: MapOccurrence = {
    getRenderReceipt: () => receipt,
    getPersistedRenderReceipt: () => receiptStore.get(),
    getGestureMetrics: (): GestureMetrics => ({ ...gestureObserver?.metrics ?? emptyGestureMetrics() }),
    submitGestureObservation(): 'emitted' | 'no-view' {
      const view = mapView ?? sceneView
      const observer = gestureObserver
      if (view === undefined || observer === undefined) return 'no-view'
      const snapshot = gestureSnapshotOf(view, mapView !== undefined ? 'map' : 'scene')
      if (snapshot === undefined) return 'no-view'
      observer.explicit(snapshot)
      return 'emitted'
    },
    mount(element: HTMLDivElement | undefined) {
      if (disposed) return
      if (holder !== undefined && holder !== element) destroyViews()
      holder = element instanceof HTMLDivElement ? element : undefined
      applyState(getState())
    },
    /** Apply the latest projection snapshot onto the live view. */
    refresh(next: MapContainerState | undefined) {
      applyState(next)
      void maybeCaptureObservation(getState())
    },
    focusLayer(layerId: string) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      const record = getState()?.layers.get(layerId)
      const bbox = record === undefined || record.data === undefined ? null : geoJsonBbox(record.data)
      if (bbox === null) return
      frameBbox(bbox)
    },
    focusFeature(layerId: string, featureId: string) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      const features = getState()?.layers.get(layerId)?.data?.features
      if (features === undefined) return
      for (const [index, feature] of features.entries()) {
        if (featureIdOf(feature as { id?: unknown }, index) !== featureId) continue
        const bbox = geoJsonBbox(feature.geometry)
        if (bbox !== null) frameBbox(bbox)
        return
      }
    },
    setTimeFrame(frame) {
      timeFrame = frame
      // Re-sync under the new frame: the data token embeds it, so every
      // styled layer redraws (or restores its full set on `null`).
      applyState(getState())
    },
    setHighlight(layerId, ids) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      highlights.set(layerId, new Set(ids))
      const state = getState()
      const record = state?.layers.get(layerId)
      if (state === undefined || record === undefined) return
      if (live.kind !== 'graphics') return
      const symbol = singleSymbolOf(record)
      const overrides = overrideTableOf(record)
      const legendColor = record.legend?.symbol.color
      for (const entry of live.entries) {
        const resolved = symbolFor(
          entry.geometryType,
          record.style ?? null,
          entry.classified,
          ids.has(entry.id),
          symbol,
          overrides.get(entry.id),
          legendColor,
        )
        if (resolved === undefined) continue
        entry.graphic.symbol = resolved
      }
      applyState(state)
    },
    captureView: captureLiveView,
    dispose() {
      if (disposed) return
      disposed = true
      sessionOccurrences.delete(sessionId)
      destroyViews()
      holder = undefined
      // Keep the last applied/rendered/failed observation as historical evidence.
      receipt = Object.freeze({ ...receipt, status: 'unavailable', renderedRevision: null, viewId: null, reason: 'disposed' })
      const handles = (globalThis as { __mapHarness?: Map<string, unknown> }).__mapHarness
      if (handles !== undefined && handles.get(handleKey) === publishedHandle) handles.delete(handleKey)
      publishedHandle = undefined
    },
  }
  sessionOccurrences.set(sessionId, occurrence)
  return occurrence
}
