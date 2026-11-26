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
import TileLayer, { type TileLayerProperties } from '@arcgis/core/layers/TileLayer.js'
import WMTSLayer from '@arcgis/core/layers/WMTSLayer.js'
import { Gcj02XYZTileLayer } from './gcj02-tile-layer.ts'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel.js'
import esriConfig from '@arcgis/core/config.js'
import type { BeforeInterceptorCallback, RequestInterceptor } from '@arcgis/core/request/types.js'
import Point from '@arcgis/core/geometry/Point.js'
import Polyline from '@arcgis/core/geometry/Polyline.js'
import Polygon from '@arcgis/core/geometry/Polygon.js'
import Extent from '@arcgis/core/geometry/Extent.js'
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js'
import { projectAsync } from '@arcgis/core/geometry/projectionUtils.js'
import { whenOnce, watch } from '@arcgis/core/core/reactiveUtils.js'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js'
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js'
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js'
import { classifyValue, featureIdOf, measureValueOf, sizeForClass, type ClassifiedValue, type StyleSpec } from '@map-harness/spatial-viz/browser'
import { semanticBlocksOf, shadeOf, type HeatmapBlock, type SingleSymbolStyle } from '@map-harness/map-layers'
import type { BrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MapContainerState, MapLayerRecord, MapLayerStream, MapLayerTerrain, MapViewRecord } from '../registry.ts'
import { PUBLIC_SOURCE_PRESETS, type MapSourceRenderDescriptor, type SourceRenderLayer } from '../source-render-protocol.ts'
import { geoJsonBbox, type LonLatBbox } from './bbox.ts'
import { basemapKindFor, explicitSpatialReferenceWkid, KEY_FREE_BASEMAP, scaleFromZoom, viewCameraEquals, viewEngineKey, viewportSnapshotOf, zoomFromScale, type ViewSnapshot } from './view-policy.ts'
import type { CaptureError, CaptureResult, MapControlState, MapHarnessTestHandle, MapOccurrence } from './face.ts'
import { createLabelOverlay, type ClusterCopy, type LabelOverlay } from './label-overlay.ts'
import { LABEL_FIELD_CANDIDATES, clusterUnplaced, labelAnchorOf, labelTextOf, placeLabels, type ClusterBadge, type LabelCandidate } from './labeling.ts'
import { inspectionOf, popupValueOf, type FeatureInspection } from './popup.ts'
import { featureScreenRectEqual, featureScreenRectOf, type FeatureInspectionFrame, type FeatureScreenPoint, type FeatureScreenRect } from './feature-card-anchor.ts'
import {
  createAnnotationDrawingHost,
  type AnnotationDrawKind,
  type AnnotationDrawingState,
  type SketchViewModelFace,
  type DrawingLayerFace,
} from './annotation-drawing.ts'
import type { AnnotationGeometry } from '../protocol.ts'
import type { MapInteractionDeclineCode, MapInteractionHit, MapUseClientRequest } from '../interaction-protocol.ts'
import type { MapObservationRecord } from '../observation-protocol.ts'
import { cssPointOf, displayPointOf, interactionHitOf, wgs84OfDisplayPoint } from '../map-use.ts'
import {
  cancelObservation,
  cameraOf,
  captureViewOf,
  claimObservation,
  declineObservation,
  loadImageElement,
  isCaptureDeadlineError,
  observationSources,
  runCaptureTransaction,
  runCaptureWithUpdatingRetry,
  sameCaptureIdentity,
  sameCaptureIdentityOutsideUpdating,
  submitObservation,
  waitForCaptureFrame,
  type CaptureIdentity,
} from './observation-capture.ts'
import {
  cancelMapUse,
  claimMapUse,
  declineMapUse,
  fenceRefusalOf,
  submitMapUse,
  stopMapUseTurn,
  type LiveMapUseFence,
} from './map-use-client.ts'
import { createRenderReceiptStore, type MapRenderFailure, type MapRenderReceipt } from './render-receipt.ts'
import { featureColorOf, heatmapStopsOf, overrideTableOf, rgbaOf, singleSymbolOf, type OverridePatch } from './layer-colors.ts'
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

/** Virtual service-root prefix rewritten only by this occurrence's request interceptor. */
const VIRTUAL_SOURCE_PREFIX = '/__map-source/'
const VIRTUAL_SOURCE_URL_PREFIX = new URL(VIRTUAL_SOURCE_PREFIX, globalThis.location?.href ?? 'https://map-harness.invalid').href

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
const GESTURE_INTERACTION_EVENTS = ['pointer-down', 'drag', 'pointer-drag', 'mouse-wheel', 'key-down', 'double-click'] as const

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
  /** The feature geometry's WGS84 envelope, or `null` when it has no finite coordinates. */
  readonly bbox: LonLatBbox | null
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

/** SDK carrier types owned by the selected base/label source pair. */
type SourceCarrier = WebTileLayer | MapImageLayer | TileLayer | WMTSLayer | Gcj02XYZTileLayer
type PublicSourceRenderLayer = Extract<SourceRenderLayer, { readonly transport: 'public-preset' }>
type ControlledSourceRenderLayer = Extract<SourceRenderLayer, { readonly transport: 'controlled' }>

/** Convert one controlled resource identity into an occurrence-private virtual service root. */
function virtualSourceUrl(layer: ControlledSourceRenderLayer): string {
  const suffix = layer.layerKind === 'wmts' ? '/WMTS' : '/MapServer'
  return `${VIRTUAL_SOURCE_URL_PREFIX}${encodeURIComponent(layer.resourceHref)}${suffix}`
}

/** Build the public endpoint carrier directly from the frozen public descriptor. */
function publicCarrierOf(layer: PublicSourceRenderLayer): SourceCarrier {
  const preset = PUBLIC_SOURCE_PRESETS[layer.presetId]
  if (layer.source.tileAdjustment?.kind === 'gcj02') {
    return new Gcj02XYZTileLayer({
      title: layer.source.title,
      urlTemplate: preset.url,
      copyright: layer.source.attribution,
    })
  }
  if (layer.layerKind === 'web-tile') {
    return new WebTileLayer({
      title: layer.source.title,
      urlTemplate: preset.url,
      copyright: layer.source.attribution,
    })
  }
  if (layer.layerKind === 'arcgis-tile') {
    // Pin the tile host: the SDK otherwise derives a multi-domain server list
    // from the service path and the added services.* host fails in this
    // deployment, so every tile must come from the preset host itself.
    const options: TileLayerProperties & { readonly tileServers: string[] } = {
      title: layer.source.title,
      url: preset.url,
      copyright: layer.source.attribution,
      tileServers: [preset.url],
    }
    return new TileLayer(options)
  }
  return new MapImageLayer({
    title: layer.source.title,
    url: preset.url,
    copyright: layer.source.attribution,
  })
}

/** Build a controlled carrier whose SDK requests are rewritten to the fixed source resource route. */
function controlledCarrierOf(layer: ControlledSourceRenderLayer): SourceCarrier {
  const url = virtualSourceUrl(layer)
  if (layer.source.tileAdjustment?.kind === 'gcj02') {
    return new Gcj02XYZTileLayer({
      title: layer.source.title,
      urlTemplate: `${layer.resourceHref}&resource=xyz-tile&z={z}&x={x}&y={y}`,
      copyright: layer.source.attribution,
    })
  }
  if (layer.layerKind === 'arcgis-tile') {
    return new TileLayer({ title: layer.source.title, url, copyright: layer.source.attribution })
  }
  if (layer.layerKind === 'arcgis-map-image') {
    return new MapImageLayer({ title: layer.source.title, url, copyright: layer.source.attribution })
  }
  if (layer.layerKind === 'wmts') {
    return new WMTSLayer({
      title: layer.source.title,
      url,
      activeLayer: { id: 'source' },
      serviceMode: 'KVP',
      copyright: layer.source.attribution,
    })
  }
  return new WebTileLayer({
    title: layer.source.title,
    urlTemplate: `${layer.resourceHref}&resource=xyz-tile&z={z}&x={x}&y={y}`,
    copyright: layer.source.attribution,
  })
}

/** Build one descriptor-selected source carrier. */
function sourceCarrierOf(layer: SourceRenderLayer): SourceCarrier {
  return layer.transport === 'public-preset' ? publicCarrierOf(layer) : controlledCarrierOf(layer)
}

/** Attribution lines for the selected raster pair, or the fixed legacy source. */
function attributionOf(state: MapContainerState, sourceDescriptor?: MapSourceRenderDescriptor): string {
  const attribution = [
    ...(state.imageryDisplay.earlyVisible && state.imageryDisplay.earlySource !== null
      ? [state.imageryDisplay.earlySource.attribution] : []),
    ...(state.imageryDisplay.recentVisible && state.imageryDisplay.recentOpacity > 0
      ? [state.basemap === null ? KEY_FREE_BASEMAP.copyright : state.basemap.basemap.attribution] : []),
    ...(state.imageryDisplay.labelsVisible
      ? [state.basemap?.labels?.attribution ?? sourceDescriptor?.labels?.source.attribution] : []),
  ].filter((value): value is string => value !== undefined)
  return [...new Set(attribution)].join(' | ')
}

/** Copy only the named query fields from an SDK request. */
function copyQuery(target: URLSearchParams, source: URLSearchParams, names: readonly string[]): void {
  const allowed = new Map(names.map(name => [name.toLowerCase(), name]))
  for (const [key, value] of source) {
    const name = allowed.get(key.toLowerCase())
    if (name !== undefined) target.set(name, value)
  }
}

/** Public preset endpoints whose tile traffic this occurrence watches for failures. */
const PUBLIC_TILE_PRESET_URLS: readonly string[] = Object.values(PUBLIC_SOURCE_PRESETS)
  .filter(preset => preset.adapter === 'arcgis-mapserver')
  .map(preset => preset.url)

/** Any matching preset-request failure raises the source failure bar; the next success resets it. */
const TILE_FAILURE_THRESHOLD = 1

/** Degrees added to each collapsed axis of a clicked cluster bbox; a camera fit pad, not the data bbox pad. */
const CLUSTER_FRAME_PAD_DEG = 0.0008

/** Rewrite one virtual SDK service request into the fixed controlled resource route. */
const rewriteVirtualSourceRequest: BeforeInterceptorCallback = params => {
  const incoming = new URL(params.url, globalThis.location?.href ?? 'https://map-harness.invalid')
  const marker = incoming.pathname.endsWith('/WMTS') ? '/WMTS' : '/MapServer'
  const markerAt = incoming.pathname.lastIndexOf(marker)
  if (markerAt <= VIRTUAL_SOURCE_PREFIX.length) return
  const identity = decodeURIComponent(incoming.pathname.slice(VIRTUAL_SOURCE_PREFIX.length, markerAt))
  const suffix = incoming.pathname.slice(markerAt + marker.length)
  const incomingQuery = new URLSearchParams(incoming.search)
  const requestQuery = params.requestOptions.query
  if (requestQuery instanceof URLSearchParams) {
    for (const [key, value] of requestQuery) incomingQuery.set(key, value)
  } else if (requestQuery !== null && requestQuery !== undefined) {
    for (const [key, value] of Object.entries(requestQuery)) {
      if (value !== undefined) incomingQuery.set(key, String(value))
    }
  }
  const query = new URLSearchParams()
  if (marker === '/WMTS') {
    query.set('resource', 'wmts')
    copyQuery(query, incomingQuery, [
      'service', 'version', 'request', 'layer', 'style', 'format',
      'tilematrixset', 'tilematrix', 'tilerow', 'tilecol',
    ])
  } else {
    const tile = /^\/tile\/(\d+)\/(-?\d+)\/(-?\d+)$/u.exec(suffix)
    if (tile !== null) {
      query.set('resource', 'arcgis-tile')
      query.set('level', tile[1]!)
      query.set('row', tile[2]!)
      query.set('col', tile[3]!)
    } else if (suffix === '/export') {
      query.set('resource', 'arcgis-export')
      copyQuery(query, incomingQuery, [
        'bbox', 'bboxsr', 'imagesr', 'size', 'dpi', 'format', 'transparent',
        'f', 'rotation', 'layers',
      ])
    } else if (suffix === '') {
      query.set('resource', 'arcgis-metadata')
      query.set('f', 'json')
    }
  }
  params.requestOptions.query = {}
  const target = new URL(identity, globalThis.location?.href ?? 'https://map-harness.invalid')
  // The identity href carries its own `resource` (the WMTS base query does); the
  // guarded operation appended below must be the only one the route receives.
  target.searchParams.delete('resource')
  for (const [key, value] of query) target.searchParams.append(key, value)
  params.url = target.href
}

/** Build an empty map; source carriers are synced into the live map without rebuilding the camera. */
function buildMap(): EsriMap {
  const map = new EsriMap()
  return map
}

/** The heatmap renderer properties face the SDK accepts (a plain properties object, never an instance). */
type HeatmapRendererProperties = Extract<NonNullable<FeatureLayerProperties['renderer']>, { type: 'heatmap' }>

/** Default point diameter when neither a style nor a symbol block decides one. */
const SIZE_DEFAULT_PX = 8

/** Default line width when neither a symbol block nor a highlight decides one. */
const LINE_DEFAULT_WIDTH = 2.5

/** The study-AOI outline: the `aoi` semantic line block, so the AOI reads like an `aoi` layer. */
const AOI_OUTLINE = semanticBlocksOf('aoi').line

/**
 * The symbol one feature wears under the R4 resolution order: per-feature
 * override > classification (StyleSpec colors, graduated sizes, missing
 * shape — unchanged semantics) > explicit symbol block (shape, size/width
 * baseline, line pattern, outline) > semantic block (`resolveSingleSymbol`)
 * > legend color with the default halo/translucent-fill look > ArcGIS default.
 * Declared symbol/override opacity folds into the color; inferred opacity
 * cannot dim a classified color. Layer opacity stays on `graphics.opacity`.
 * @returns the ArcGIS symbol, including transient selection styling when selected.
 */
function symbolFor(
  geometryType: 'Point' | 'LineString' | 'Polygon',
  style: StyleSpec | null,
  classified: ClassifiedValue,
  selected: boolean,
  symbol: SingleSymbolStyle | undefined,
  declaredSymbol: boolean,
  override: OverridePatch | undefined,
  legendColor: string | undefined,
): ArcgisSymbol | undefined {
  const isClass = typeof classified === 'number'
  const { color, opacity } = featureColorOf(geometryType, style, classified, symbol, declaredSymbol, override, legendColor)
  if (geometryType === 'Point') {
    const block = symbol?.point
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

/**
 * The WGS84 envelope a feature card follows: a point stays exact, while a
 * line or polygon uses its geometry envelope.
 * @returns the feature envelope, or `null` when it has no finite coordinates.
 */
function featureBoundsOf(
  geometry: { readonly type?: string; readonly coordinates?: unknown } | null,
  anchor: ReturnType<typeof labelAnchorOf>,
): LonLatBbox | null {
  if (geometry?.type === 'Point' && anchor?.kind === 'point') {
    return { west: anchor.lon, south: anchor.lat, east: anchor.lon, north: anchor.lat }
  }
  return geoJsonBbox(geometry)
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
    /** Instance-scoped browser persistence for occurrence-local render receipts. */
    readonly browserStorage?: BrowserStorage
    readonly onGestureObservation?: GestureEmit
    readonly gestureClock?: GestureClock
    /** Receives the hovered feature's attribute card and screen anchor, or `null` when the pointer leaves every feature. */
    readonly onInspect?: (inspection: FeatureInspectionFrame | null) => void
    /** Receives every settled 2D camera (user or programmatic) as implicit model context. */
    readonly onViewport?: (snapshot: GestureCameraSnapshot) => void
    /** Receives a user's settled camera when it differs from the accepted map view. */
    readonly onUserCamera?: (view: MapViewRecord) => void | Promise<void>
    /** Reads the session-bound public render recipe for an explicit source selection. */
    readonly loadRenderDescriptor?: (sessionId: SessionId, signal: AbortSignal) => Promise<MapSourceRenderDescriptor>
    /** Receives one completed, projected annotation draft for the user write path. */
    readonly onAnnotationCreate?: (geometry: AnnotationGeometry, kind: AnnotationDrawKind) => Promise<void>
    /** Receives one completed annotation geometry edit for the user write path. */
    readonly onAnnotationUpdate?: (featureId: string, geometry: AnnotationGeometry, expectedUpdatedAt: string) => Promise<void>
    readonly onControlError?: () => void
    readonly sourceRetryScheduler?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
    /** Localized "+N" badge face and hover hint for one cluster of unplaced labels. */
    readonly labelClusterCopy?: (count: number) => ClusterCopy
  } = {},
): MapOccurrence {
  if (sessionOccurrences.has(sessionId)) throw new Error('A map occurrence is already bound to this Session')
  const handleKey = `${sessionId}:${occurrenceKey}`
  const sourceInterceptor: RequestInterceptor = {
    urls: VIRTUAL_SOURCE_URL_PREFIX,
    before: rewriteVirtualSourceRequest,
  }
  let tileFailures = 0
  let tileFailure: 'error' | null = null
  const resetTileFailure = (): void => {
    tileFailures = 0
    tileFailure = null
  }
  const tileInterceptor: RequestInterceptor = {
    urls: [...PUBLIC_TILE_PRESET_URLS],
    after: () => { resetTileFailure() },
    error: error => {
      // Superseded requests (pan/zoom tile cancellation) are not failures.
      if (/abort/i.test(error?.name ?? '')) return
      tileFailures += 1
      if (tileFailures >= TILE_FAILURE_THRESHOLD) tileFailure = 'error'
    },
  }
  esriConfig.request.interceptors.push(sourceInterceptor)
  esriConfig.request.interceptors.push(tileInterceptor)
  const receiptStore = createRenderReceiptStore(sessionId, occurrenceKey, hooks.browserStorage)
  let generation = receiptStore.get()?.generation ?? 0
  let viewId: string | null = null
  let lastObservationSeq: number | null = null
  let observationAttempt: {
    readonly requestSeq: number
    readonly identity: { sessionId: string; callId: string; requestSeq: number }
    readonly controller: AbortController
    readonly expiresAtMs: number
    frozen?: CaptureIdentity
    token?: string
    terminal: boolean
  } | undefined
  let mapUseAttempt: {
    readonly requestSeq: number
    readonly identity: { sessionId: string; callId: string; requestSeq: number }
    readonly controller: AbortController
    readonly expiresAtMs: number
    token?: string
    terminal: boolean
    abortCode?: MapInteractionDeclineCode
  } | undefined
  /** Turn in which the user pressed Stop; a later turn re-enables map use. */
  let mapUseStoppedTurn: number | null = null
  let lastMapUseSeq: number | null = null
  /** Capture identity epochs: every camera settle and user interaction invalidates an in-flight capture. */
  let cameraEpoch = 0
  let gestureEpoch = 0
  let layoutEpoch = 0
  let renderUpdateEpoch = 0
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
  let sourceDescriptor: MapSourceRenderDescriptor | undefined
  let sourceKey: string | undefined
  let sourceErrorKey: string | undefined
  let sourceRetry: ReturnType<typeof setTimeout> | undefined
  let sourceFailures = 0
  let sourceFailure: 'error' | 'retrying' | null = null
  let sourceRequest: { readonly key: string; readonly controller: AbortController } | undefined
  const scheduleSourceRetry = hooks.sourceRetryScheduler ?? globalThis.setTimeout
  let baseSourceCarrier: SourceCarrier | undefined
  let labelSourceCarrier: SourceCarrier | undefined
  let earlySourceCarrier: SourceCarrier | undefined
  let baseSourceIdentity: string | undefined
  let labelSourceIdentity: string | undefined
  let earlySourceIdentity: string | undefined
  let sourceRetryEpoch = 0
  let cameraWriteToken = 0
  const cameraSettlements = new WeakMap<MapView | SceneView, Promise<void>>()
  const protectedCameraWrites = new WeakMap<MapView | SceneView, number>()
  let userCameraReportToken = 0
  let pendingUserCamera = false
  let appliedCamera: MapViewRecord | undefined
  let inspectedUseSeq: number | null = null
  let supersededCamera: { revision: number; turnStartSeq: number | null } | undefined
  const layerByName = new Map<string, AppliedLayer>()

  /** Abort the one occurrence-owned observation transaction on identity change. */
  function invalidateObservationAttempt(): void {
    const active = observationAttempt
    if (active !== undefined && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException('map observation identity changed', 'AbortError'))
    }
  }

  /** Abort the one interaction fence and report its authored reason. */
  function invalidateMapUseAttempt(code: MapInteractionDeclineCode): void {
    const active = mapUseAttempt
    if (active === undefined) return
    if (active.abortCode !== 'user-interrupted') active.abortCode = code
    // Before the claim exists there is no token to decline with. Let the
    // claim finish, then report the authored reason; aborting here would turn
    // a user takeover into an unauthenticated timeout.
    if (active.token !== undefined && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException(`map use ${code}`, 'AbortError'))
    }
  }

  function takeMapControl(): void {
    invalidateObservationAttempt()
    invalidateMapUseAttempt('user-interrupted')
    const state = getState()?.interaction
    if (state === undefined || !state.open || state.turnStartSeq === null
      || (state.actions === 0 && state.observations === 0) || state.stopped !== null
      || mapUseStoppedTurn === state.turnStartSeq) return
    mapUseStoppedTurn = state.turnStartSeq
    void stopMapUseTurn(sessionId, state.turnStartSeq).then(ok => {
      if (!ok && !disposed) hooks.onControlError?.()
    })
  }
  /** The pinned time frame, or `null` when every feature shows. */
  let timeFrame: { readonly index: number; readonly startMs: number; readonly endMs: number } | null = null
  /** Per-layer shared-selection ids the highlight wears. */
  const highlights = new Map<string, Set<string>>()
  const inspectionHighlights = new Map<string, Set<string>>()
  const highlightIds = (layerId: string): Set<string> => new Set([
    ...(highlights.get(layerId) ?? []),
    ...(inspectionHighlights.get(layerId) ?? []),
  ])
  /** The AOI outline layer and the ring key it currently draws. */
  let aoiLive: { readonly graphics: GraphicsLayer; readonly ringKey: string } | undefined
  /** The label overlay (always the top layer of the 2D map) and its last placement count. */
  let labelOverlay: LabelOverlay | undefined
  let hoverBusy = false
  /** The live hovered feature; its screen anchor is recomputed after camera moves. */
  let hoveredTarget: { readonly layerId: string; readonly featureId: string; readonly entry: AppliedGraphic; readonly inspection: FeatureInspection } | null = null
  let hoveredAnchor: FeatureScreenRect | null = null
  /** Layer ids the last applied state carried; `undefined` before the first apply (mount and replay never auto-frame). */
  let knownLayerIds: Set<string> | undefined
  let hoverNext: { readonly view: MapView; readonly x: number; readonly y: number; readonly sequence: number } | 'leave' | undefined
  let hoverSequence = 0
  let placedLabelCount = 0
  /** Gesture observer + event handles of the live view; rebuilt with the view. */
  let gestureObserver: GestureObserver | undefined
  const gestureHandles: { remove(): void }[] = []
  interface AnnotationDraftLayer extends DrawingLayerFace {
    readonly actual: GraphicsLayer
  }
  let drawingState: AnnotationDrawingState = { status: 'idle', kind: null, lastError: null }
  let drawingHost: ReturnType<typeof createAnnotationDrawingHost<MapView, AnnotationDraftLayer>> | undefined

  /** Lazily bind the injectable Sketch host to whichever 2D view is live. */
  function arcgisGeometryOfAnnotation(geometry: AnnotationGeometry): Point | Polyline | Polygon {
    if (geometry.type === 'Point') return new Point({ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1], spatialReference: SpatialReference.WGS84 })
    if (geometry.type === 'LineString') return new Polyline({ paths: [geometry.coordinates.map(point => [point[0], point[1]])], spatialReference: SpatialReference.WGS84 })
    return new Polygon({ rings: geometry.coordinates.map(ring => ring.map(point => [point[0], point[1]])), spatialReference: SpatialReference.WGS84 })
  }

  function ensureDrawingHost(): ReturnType<typeof createAnnotationDrawingHost<MapView, AnnotationDraftLayer>> {
    drawingHost ??= createAnnotationDrawingHost<MapView, AnnotationDraftLayer>({
      viewOf: () => mapView,
      modeOf: () => getState()?.mode ?? 'map',
      createLayer() {
        const actual = new GraphicsLayer({ title: 'User annotation draft' })
        let destroyed = false
        const draft: AnnotationDraftLayer = {
          actual,
          removeAll: () => actual.removeAll(),
          destroy: () => {
            if (destroyed) return
            destroyed = true
            mapForMapView?.remove(actual)
            actual.destroy()
          },
        }
        mapForMapView?.add(actual)
        return draft
      },
      createSketch: (view, layer) => new SketchViewModel({
        view,
        layer: layer.actual,
        creationMode: 'single',
        defaultCreateOptions: { mode: 'click' },
      }) as SketchViewModelFace,
      projectGeometry: geometry => projectAsync(geometry, SpatialReference.WGS84),
      submit: (geometry, kind) => hooks.onAnnotationCreate?.(geometry, kind) ?? Promise.resolve(),
      submitUpdate: (featureId, geometry, expectedUpdatedAt) => hooks.onAnnotationUpdate?.(featureId, geometry, expectedUpdatedAt) ?? Promise.resolve(),
      onState: next => {
        drawingState = next
      },
    })
    return drawingHost
  }

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

  /** Resolve the live center to WGS84; projected scenes may not expose longitude/latitude directly. */
  async function wgs84CenterOf(view: MapView | SceneView): Promise<[number, number] | undefined> {
    const center = view.center
    if (center === null || center === undefined) return undefined
    const longitude = center.longitude
    const latitude = center.latitude
    if (typeof longitude === 'number' && typeof latitude === 'number'
      && Number.isFinite(longitude) && Number.isFinite(latitude)) return [longitude, latitude]
    const projected = await projectAsync(center, SpatialReference.WGS84)
    const projectedRecord = projected as Record<string, unknown> | null
    const projectedLongitude = projectedRecord?.['longitude']
    const projectedLatitude = projectedRecord?.['latitude']
    return typeof projectedLongitude === 'number' && typeof projectedLatitude === 'number'
      && Number.isFinite(projectedLongitude) && Number.isFinite(projectedLatitude)
      ? [projectedLongitude, projectedLatitude]
      : undefined
  }

  /** Persist one settled camera only when it differs from the accepted map view. */
  async function reportUserCamera(view: MapView | SceneView, snapshot: GestureCameraSnapshot): Promise<void> {
    const notify = hooks.onUserCamera
    const initial = getState()
    if (notify === undefined || initial === undefined) return
    const token = ++userCameraReportToken
    const round6 = (value: number): number => Number.parseFloat(value.toFixed(6))
    try {
      const center = await wgs84CenterOf(view)
      if (center === undefined || disposed || view.destroyed || token !== userCameraReportToken) return
      const current = getState()
      if (current === undefined) return
      const record: MapViewRecord = {
        center: [round6(center[0]), round6(center[1])],
        zoom: round6(snapshot.zoom),
        wkid: current.view.wkid,
        ...(snapshot.scale === undefined ? {} : { scale: round6(snapshot.scale) }),
        ...(snapshot.rotation === undefined ? {} : { rotation: round6(snapshot.rotation) }),
      }
      const samePosition = current.view.wkid === record.wkid && current.view.zoom === record.zoom
        && current.view.center[0] === record.center[0] && current.view.center[1] === record.center[1]
      const sameRotation = (current.view.rotation ?? 0) === (record.rotation ?? 0)
      const sameScale = current.view.scale === undefined || record.scale === undefined || current.view.scale === record.scale
      if (samePosition && sameRotation && sameScale) return
      await notify(record)
    } catch {
      // Camera persistence is advisory; a failed projection or transport leaves live context intact.
    }
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
    const state = getState()
    if (state === undefined) return captureFailure({ code: 'capture-failed', detail: 'no container state' })
    const frozen = captureIdentityOf(state)
    if (frozen === null) return captureFailure({ code: 'no-view' })
    const controller = new AbortController()
    const expiresAtMs = Date.now() + captureTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException('capture deadline expired', 'TimeoutError'))
        reject({ code: 'capture-timeout' } satisfies CaptureError)
      }, captureTimeoutMs)
    })
    try {
      const product = await Promise.race([
        runCaptureTransaction(
          captureViewOf(view), mode,
          () => {
            const liveState = getState()
            return liveState === undefined
              ? { ...frozen, viewId: '', sourceDigest: 'disposed' }
              : captureIdentityOf(liveState) ?? { ...frozen, viewId: '', sourceDigest: 'disposed' }
          },
          frozen, labelOverlay?.labels ?? [], attributionOf(state, sourceDescriptor), loadImageElement,
          { signal: controller.signal, expiresAtMs },
        ),
        timeout,
      ])
      if ('refusal' in product) {
        if (product.refusal === 'no-view') return captureFailure({ code: 'no-view' })
        return captureFailure({ code: 'capture-failed', detail: product.detail ?? product.refusal })
      }
      return { dataUrl: `data:image/png;base64,${product.pngBase64}`, viewport }
    } catch (error: unknown) {
      // A stage that reaches the shared capture deadline before the outer timer
      // still reports the face-level timeout code. The deadline DOMException
      // carries a numeric `code`, so its name is checked before the typed
      // pass-through that preserves an already-coded rejection.
      if (isCaptureDeadlineError(error)) {
        throw { code: 'capture-timeout' } satisfies CaptureError
      }
      // A timeout rejects with its own typed object and must keep that code.
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      return captureFailure({ code: 'capture-failed', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Mute attribution while the occurrence itself drives the camera (syncCamera, focus goTo).
   * The frame absorbs an earlier gesture's pending flag, but must not advance userCameraReportToken:
   * a user gesture during a queued frame is already reporting, and that report is the one to keep. */
  function muteGestureAttribution(): void {
    pendingUserCamera = false
    gestureObserver?.programmatic()
  }

  /** Pick a 1/2/5 scaled distance for the official 100px scale bar. */
  function scaleBarLabel(metersPerPixel: number): string | null {
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null
    const meters = metersPerPixel * 100
    const magnitude = 10 ** Math.floor(Math.log10(meters))
    const step = [1, 2, 5, 10].find(candidate => candidate * magnitude >= meters) ?? 10
    const distance = step * magnitude
    return distance >= 1000 ? `${Number((distance / 1000).toFixed(1))} km` : `${Number(distance.toFixed(1))} m`
  }

  /** Live control facts; meters per pixel follow the 96dpi CSS pixel convention. */
  function mapControlState(): MapControlState | null {
    const active = mapView ?? sceneView
    if (disposed || active === undefined || active.destroyed) return null
    const rotation = 'rotation' in active ? Number(active.rotation ?? 0) : 0
    const scale = typeof active.scale === 'number' ? active.scale : 0
    return {
      rotation: Number.isFinite(rotation) ? rotation : 0,
      scaleLabel: scaleBarLabel(scale * 0.0254 / 96),
      zoom: active.zoom,
    }
  }

  /** Zoom by a signed step; the settled-camera watcher persists the result. */
  function zoomBy(delta: number): 'applied' | 'no-view' {
    const active = mapView ?? sceneView
    if (disposed || active === undefined || active.destroyed) return 'no-view'
    const step = Number.isFinite(delta) ? Math.max(-4, Math.min(4, delta)) : 0
    if (step === 0) return 'applied'
    const zoom = active.zoom >= 0 ? active.zoom : zoomFromScale(active.scale)
    muteGestureAttribution()
    active.zoom = zoom + step
    active.scale = scaleFromZoom(zoom + step)
    return 'applied'
  }

  /** Reset north through the same muted programmatic path as camera restoration. */
  function resetBearing(): 'applied' | 'no-view' {
    const active = mapView ?? sceneView
    if (disposed || active === undefined || active.destroyed || !('rotation' in active)) return 'no-view'
    muteGestureAttribution()
    active.rotation = 0
    return 'applied'
  }

  /** Frame one cluster badge's covering box, padding a degenerate one so `goTo` still has an extent. */
  function zoomToCluster(badge: ClusterBadge): void {
    if (badge.bbox === null) return
    const active = mapView ?? sceneView
    if (active === undefined) return
    const { west, south, east, north } = badge.bbox
    const padLon = east - west < Number.EPSILON ? CLUSTER_FRAME_PAD_DEG : 0
    const padLat = north - south < Number.EPSILON ? CLUSTER_FRAME_PAD_DEG : 0
    frameBbox(active, { west: west - padLon, south: south - padLat, east: east + padLon, north: north + padLat })
  }

  /** Serialize writes on the same SDK view without making replacements wait for it. */
  function enqueueCamera(view: MapView | SceneView, operation: () => Promise<void>): Promise<void> {
    const previous = cameraSettlements.get(view) ?? Promise.resolve()
    const settlement = previous.then(operation)
    cameraSettlements.set(view, settlement.catch(() => undefined))
    return settlement
  }
  /** Frame one WGS84 bbox without attributing the move to a gesture. */
  function frameBbox(view: MapView | SceneView, bbox: LonLatBbox): Promise<void> {
    const extent = new Extent({
      xmin: bbox.west,
      ymin: bbox.south,
      xmax: bbox.east,
      ymax: bbox.north,
      spatialReference: SpatialReference.WGS84,
    })
    return enqueueCamera(view, async () => {
      if (disposed || view.destroyed) return
      muteGestureAttribution()
      await view.goTo(extent).catch(() => {
        // Empty geometry or a view already destroyed during tab switch.
      })
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
      gestureHandles.push(view.on(eventName, () => {
        gestureEpoch += 1
        pendingUserCamera = true
        takeMapControl()
        observer.interaction()
      }))
    }
    gestureHandles.push(watch(
      () => `${view.width}x${view.height}`,
      () => {
        layoutEpoch += 1
        if (observationAttempt?.frozen !== undefined) invalidateObservationAttempt()
        invalidateMapUseAttempt('stale')
      },
    ))
    gestureHandles.push(watch(() => view.updating, () => {
      renderUpdateEpoch += 1
    }, { sync: true }))
    gestureHandles.push(watch(
      () => JSON.stringify(view.padding ?? null),
      () => {
        layoutEpoch += 1
        if (observationAttempt?.frozen !== undefined) invalidateObservationAttempt()
        invalidateMapUseAttempt('stale')
      },
    ))
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
        refreshHoveredAnchor(view as MapView)
        labelOverlay?.setSuspended(false)
        const userMove = pendingUserCamera
        pendingUserCamera = false
        const snapshot = gestureSnapshotOf(view, 'map')
        if (snapshot !== undefined) {
          hooks.onViewport?.(snapshot)
          if (userMove) void reportUserCamera(view, snapshot)
        }
      }))
    }
    gestureHandles.push(watch(readCamera, () => {
      cameraEpoch += 1
      if (observationAttempt?.frozen !== undefined) invalidateObservationAttempt()
      invalidateMapUseAttempt('stale')
      const snapshot = gestureSnapshotOf(view, mode)
      if (snapshot !== undefined) observer.cameraChanged(snapshot)
    }))
  }

  /** Schedule one hover hit test; `null` means the pointer left the view. */
  function hoverAt(view: MapView, event: { readonly x: number; readonly y: number } | null): void {
    const sequence = ++hoverSequence
    hoverNext = event === null ? 'leave' : { view, x: event.x, y: event.y, sequence }
    if (hoverBusy) return
    hoverBusy = true
    void (async () => {
      try {
        while (hoverNext !== undefined && !disposed) {
          const next = hoverNext
          hoverNext = undefined
          if (next === 'leave') reportHover(null)
          else await inspectAt(next.view, next, next.sequence)
        }
      } finally {
        hoverBusy = false
      }
    })()
  }

  /** Project one WGS84 coordinate through the live view into overlay pixels. */
  function projectedScreenOf(view: MapView | SceneView, longitude: number, latitude: number): FeatureScreenPoint | null {
    const screen = view.toScreen(new Point({ longitude, latitude, spatialReference: SpatialReference.WGS84 }))
    return screen == null ? null : { x: screen.x, y: screen.y }
  }

  /**
   * Report one hover outcome when its feature or screen anchor changed.
   * The same feature may emit again after a camera move: its attribute card
   * stays open while the anchor follows the projected geometry.
   */
  function reportHover(
    target: { readonly layerId: string; readonly featureId: string; readonly entry: AppliedGraphic; readonly inspection: FeatureInspection } | null,
    view?: MapView | SceneView,
  ): void {
    if (target === null) {
      const previous = hoveredTarget
      hoveredTarget = null
      hoveredAnchor = null
      if (previous !== null) occurrence.setHighlight(previous.layerId, new Set(), 'inspection')
      hooks.onInspect?.(null)
      return
    }
    if (view === undefined) return
    const fallbackAnchor = target.entry.anchor
    const fallback = fallbackAnchor === null ? null : projectedScreenOf(view, fallbackAnchor.lon, fallbackAnchor.lat)
    const anchor = featureScreenRectOf(target.entry.bbox, (longitude, latitude) => projectedScreenOf(view, longitude, latitude), fallback)
    if (anchor === null) {
      reportHover(null)
      return
    }
    const sameFeature = hoveredTarget?.layerId === target.layerId && hoveredTarget.featureId === target.featureId
    if (sameFeature && featureScreenRectEqual(hoveredAnchor, anchor)) return
    hoveredTarget = target
    hoveredAnchor = anchor
    occurrence.setHighlight(target.layerId, new Set([target.featureId]), 'inspection')
    hooks.onInspect?.({ ...target.inspection, anchor })
  }

  /** Recompute the open card's anchor when the camera settles without changing its feature. */
  function refreshHoveredAnchor(view: MapView | SceneView): void {
    const target = hoveredTarget
    if (target === null) return
    const live = layerByName.get(target.layerId)
    if (live === undefined || !live.carrier.visible || !live.entries.includes(target.entry)) {
      reportHover(null)
      return
    }
    reportHover(target, view)
  }

  /**
   * Resolve one hover position to the topmost data feature and hand its
   * attribute card to the host; the feature takes the shared highlight while
   * hovered. Casing and label graphics are skipped: only a layer's own
   * entries count.
   */
  async function inspectAt(view: MapView, event: { readonly x: number; readonly y: number }, sequence: number): Promise<void> {
    const onInspect = hooks.onInspect
    if (onInspect === undefined) return
    const include = [...layerByName.values()].filter(live => live.kind === 'graphics' && live.carrier.visible).map(live => live.carrier as GraphicsLayer)
    let hits: readonly { readonly type: string; readonly graphic?: Graphic }[]
    try {
      hits = include.length === 0 ? [] : (await view.hitTest({ x: event.x, y: event.y }, { include })).results
    } catch {
      // A view destroyed mid-hover has nothing to inspect; the card stays closed.
      hits = []
    }
    if (disposed || view.destroyed || view !== mapView || sequence !== hoverSequence) return
    for (const hit of hits) {
      if (hit.type !== 'graphic' || hit.graphic === undefined) continue
      for (const [layerId, live] of layerByName) {
        const entry = live.entries.find(candidate => candidate.graphic === hit.graphic)
        if (entry === undefined) continue
        const record = getState()?.layers.get(layerId)
        const attributes = (entry.graphic.attributes ?? {}) as Record<string, unknown>
        reportHover({
          layerId,
          featureId: entry.id,
          entry,
          inspection: inspectionOf({ layerId, layerName: record?.name ?? live.name, featureId: entry.id }, attributes, record === undefined ? null : labelFieldOf(record, live.entries)),
        }, view)
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
          lon: entry.anchor.lon,
          lat: entry.anchor.lat,
        })
      }
    }
    const placed = placeLabels(candidates, { width, height })
    // Every candidate the pass dropped collapses into one "+N" badge, so
    // zooming in spreads features over more cells and shows more names.
    const clusters = clusterUnplaced(placed, candidates, { width, height })
    if (labelOverlay === undefined && holder !== undefined) {
      labelOverlay = createLabelOverlay(holder, {
        ...(hooks.labelClusterCopy === undefined ? {} : { clusterCopy: hooks.labelClusterCopy }),
        onClusterClick: badge => zoomToCluster(badge),
      })
    }
    labelOverlay?.render(placed, clusters)
    placedLabelCount = placed.length
  }

  /** Drop graphics and destroy both engines so a WKID change can rebuild. */
  function destroyViews(): void {
    invalidateObservationAttempt()
    hoverSequence += 1
    hoverNext = undefined
    drawingHost?.dispose()
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
    baseSourceCarrier = undefined
    labelSourceCarrier = undefined
    earlySourceCarrier = undefined
    baseSourceIdentity = undefined
    labelSourceIdentity = undefined
    earlySourceIdentity = undefined
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
    pendingUserCamera = false
    supersededCamera = undefined
    viewId = null
  }

  /** Publish one live observation and store it without treating persistence as session durability. */
  function observe(next: MapRenderReceipt, state: MapContainerState | undefined): void {
    receiptStore.set(next)
    receipt = receiptStore.get()!
    if (state !== undefined) publishHandle(state)
    void maybeCaptureObservation()
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

  /** Attest the current view only after its camera, visible layers and paint settle. */
  async function finishRender(
    view: MapView | SceneView, state: MapContainerState, target: MapRenderReceipt,
    layers: readonly { id: string | null; graphics: GraphicsLayer | FeatureLayer | SourceCarrier }[],
    cameraSettlement: Promise<void> | undefined, signal: AbortSignal,
  ): Promise<void> {
    try {
      await view.when()
      if (!ownsRender(target, view, signal)) return
      const outcomes = await Promise.all(layers.map(async ({ id, graphics }) => {
        try {
          return { layerView: await view.whenLayerView(graphics), failure: null }
        } catch {
          // Raw SDK exceptions may contain URLs; receipts carry fixed reason codes only.
          return { layerView: null, failure: { layerId: id, code: id === null ? 'AOI_FAILED' : id === 'basemap' || id === 'labels' || id === 'early-imagery' ? 'BASEMAP_FAILED' : 'LAYER_FAILED' } as MapRenderFailure }
        }
      }))
      if (!ownsRender(target, view, signal)) return
      const failures = outcomes.flatMap(outcome => outcome.failure === null ? [] : [outcome.failure])
      if (failures.length > 0) {
        observe({ ...target, status: 'failed', failedLayers: failures, at: new Date().toISOString() }, state)
        return
      }
      await cameraSettlement
      if (!ownsRender(target, view, signal)) return
      const settled = (): boolean => !view.updating && !view.suspended
        && outcomes.every(outcome => outcome.layerView !== null && !outcome.layerView.updating)
      do {
        await whenOnce(settled, { signal })
        await paintFrame(signal)
        await paintFrame(signal)
      } while (!settled() && ownsRender(target, view, signal))
      if (!ownsRender(target, view, signal)) return
      if (supersededCamera?.revision === target.revision && supersededCamera.turnStartSeq === state.interaction?.turnStartSeq) {
        observe({ ...target, status: 'failed', renderedRevision: null, failedLayers: [{ layerId: null, code: 'CAMERA_SUPERSEDED' }], at: new Date().toISOString() }, state)
        return
      }
      observe({ ...target, status: 'rendered', renderedRevision: target.revision, at: new Date().toISOString() }, state)
    } catch {
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
  /** The fixed legacy carrier retained by every old null-selection session. */
  function legacyCarrier(wkid: number): SourceCarrier {
    if (basemapKindFor(wkid) === 'cached-xyz') {
      return new WebTileLayer({
        title: KEY_FREE_BASEMAP.title,
        urlTemplate: KEY_FREE_BASEMAP.urlTemplate,
        copyright: KEY_FREE_BASEMAP.copyright,
      })
    }
    return new MapImageLayer({
      title: KEY_FREE_BASEMAP.title,
      url: KEY_FREE_BASEMAP.urlTemplate.replace(/\/tile\/\{level\}\/\{row\}\/\{col\}$/u, ''),
      copyright: KEY_FREE_BASEMAP.copyright,
    })
  }

  /** Start or reuse one descriptor read for every non-legacy visible source selection. */
  function ensureSourceDescriptor(state: MapContainerState): void {
    const legacyOnly = state.basemap === null && !state.imageryDisplay.labelsVisible && state.imageryDisplay.earlySource === null
    if (legacyOnly) {
      sourceRequest?.controller.abort()
      if (sourceRetry !== undefined) clearTimeout(sourceRetry)
      sourceRetry = undefined
      sourceRequest = undefined
      sourceDescriptor = undefined
      sourceErrorKey = undefined
      sourceKey = 'legacy'
      sourceFailures = 0
      sourceFailure = null
      resetTileFailure()
      return
    }
    const key = JSON.stringify([state.basemap, state.imageryDisplay, state.mode, viewEngineKey(state.view.wkid)])
    if (sourceKey === key && (sourceDescriptor !== undefined || sourceRequest !== undefined || sourceErrorKey === key)) return
    sourceRequest?.controller.abort()
    sourceFailure = null
    if (sourceRetry !== undefined) clearTimeout(sourceRetry)
    sourceRetry = undefined
    sourceDescriptor = undefined
    sourceErrorKey = undefined
    sourceKey = key
    const controller = new AbortController()
    sourceRequest = { key, controller }
    const reader = hooks.loadRenderDescriptor
    if (reader === undefined) {
      sourceErrorKey = key
      return
    }
    void reader(sessionId, controller.signal).then(descriptor => {
      if (disposed || sourceRequest?.key !== key || controller.signal.aborted) return
      sourceDescriptor = descriptor
      sourceRequest = undefined
      sourceErrorKey = undefined
      sourceFailures = 0
      sourceFailure = null
      if (sourceRetry !== undefined) clearTimeout(sourceRetry)
      sourceRetry = undefined
      renderKey = undefined
      applyState(getState())
    }).catch(() => {
      const request = sourceRequest
      if (disposed || request?.key !== key || controller.signal.aborted) return
      sourceRequest = undefined
      sourceErrorKey = key
      sourceFailure = 'error'
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(sourceFailures, 5))
      sourceFailures += 1
      sourceRetry = scheduleSourceRetry(() => {
        if (disposed || sourceErrorKey !== key) return
        sourceErrorKey = undefined
        sourceFailure = 'retrying'
        renderKey = undefined
        applyState(getState())
      }, delay)
      renderKey = undefined
      applyState(getState())
    })
  }

  /** Replace only source carriers; the camera, business layers, and AOI remain live. */
  function syncSourceCarriers(map: EsriMap, state: MapContainerState): MapRenderFailure[] {
    ensureSourceDescriptor(state)
    const key = JSON.stringify([state.basemap, state.imageryDisplay, state.mode, viewEngineKey(state.view.wkid)])
    const legacyOnly = state.basemap === null && !state.imageryDisplay.labelsVisible && state.imageryDisplay.earlySource === null
    const descriptor = sourceKey === key ? sourceDescriptor : undefined
    const identityOf = (layer: SourceRenderLayer): string => JSON.stringify([sourceRetryEpoch, layer])
    const reconcile = (
      carrier: SourceCarrier | undefined,
      previous: string | undefined,
      identity: string | undefined,
      create: () => SourceCarrier,
      opacity: number,
    ): SourceCarrier | undefined => {
      if (carrier !== undefined && (identity === undefined || identity !== previous)) {
        map.remove(carrier)
        carrier.destroy()
        carrier = undefined
      }
      if (identity === undefined) return undefined
      if (carrier === undefined) {
        carrier = create()
        map.add(carrier)
      }
      if (carrier.opacity !== opacity) carrier.opacity = opacity
      return carrier
    }
    const early = descriptor?.earlyImagery ?? null
    const base = descriptor?.basemap
    const labels = descriptor?.labels ?? null
    const nextEarlyIdentity = state.imageryDisplay.earlyVisible && early !== null ? identityOf(early) : undefined
    const nextBaseIdentity = !state.imageryDisplay.recentVisible ? undefined
      : legacyOnly ? JSON.stringify([sourceRetryEpoch, 'legacy', state.mode, viewEngineKey(state.view.wkid)])
        : base === undefined ? undefined : identityOf(base)
    const nextLabelIdentity = state.imageryDisplay.labelsVisible && labels !== null ? identityOf(labels) : undefined
    earlySourceCarrier = reconcile(earlySourceCarrier, earlySourceIdentity, nextEarlyIdentity, () => sourceCarrierOf(early!), 1)
    earlySourceIdentity = nextEarlyIdentity
    baseSourceCarrier = reconcile(baseSourceCarrier, baseSourceIdentity, nextBaseIdentity,
      () => legacyOnly ? legacyCarrier(viewEngineKey(state.view.wkid)) : sourceCarrierOf(base!), state.imageryDisplay.recentOpacity)
    baseSourceIdentity = nextBaseIdentity
    labelSourceCarrier = reconcile(labelSourceCarrier, labelSourceIdentity, nextLabelIdentity, () => sourceCarrierOf(labels!), 1)
    labelSourceIdentity = nextLabelIdentity
    const carriers = [earlySourceCarrier, baseSourceCarrier, labelSourceCarrier].filter((carrier): carrier is SourceCarrier => carrier !== undefined)
    carriers.forEach((carrier, index) => {
      if (map.layers.indexOf(carrier) !== index) map.reorder(carrier, index)
    })
    const failures: MapRenderFailure[] = []
    if (state.imageryDisplay.earlyVisible && earlySourceCarrier === undefined) failures.push({ layerId: 'early-imagery', code: 'BASEMAP_FAILED' })
    if (state.imageryDisplay.recentVisible && baseSourceCarrier === undefined) failures.push({ layerId: 'basemap', code: 'BASEMAP_FAILED' })
    const labelsRequired = state.basemap === null || state.basemap.labels !== null
    if (state.imageryDisplay.labelsVisible && labelsRequired && labelSourceCarrier === undefined) {
      failures.push({ layerId: 'labels', code: 'BASEMAP_FAILED' })
    }
    if (!legacyOnly && descriptor === undefined && failures.length === 0) failures.push({ layerId: 'basemap', code: 'BASEMAP_FAILED' })
    return failures
  }

  /** FNV-1a digest of the rendered-source set, incl. view size (a resize invalidates captures). */
  function sourceDigestOf(state: MapContainerState, width: number, height: number): string {
    const parts = [`w${width}x${height}`, JSON.stringify([state.basemap ?? 'legacy', state.imageryDisplay, sourceDescriptor])]
    for (const layer of state.layers.values()) {
      parts.push(`${layer.id}:${layer.visible ? 1 : 0}:${layer.opacity}:${layer.displayDigest ?? layer.resourceRef ?? ''}:${layer.imagery === undefined ? 'v' : 'i'}`)
    }
    let hash = 0x811c9dc5
    const text = parts.join('\n')
    for (let at = 0; at < text.length; at += 1) {
      hash ^= text.charCodeAt(at)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16)
  }

  /** Read the live capture identity for the frozen-identity comparison. */
  function captureIdentityOf(state: MapContainerState): CaptureIdentity | null {
    const active = mapView ?? sceneView
    if (disposed || active === undefined || active.destroyed) return null
    const center = active.center
    const extent = active.extent
    const rotation = 'rotation' in active ? active.rotation : null
    const padding = active.padding ?? null
    return {
      viewId: viewId ?? '',
      generation,
      mapRevision: state.revision,
      cameraEpoch,
      gestureEpoch,
      sourceDigest: sourceDigestOf(state, active.width, active.height),
      renderedRevision: receipt.status === 'rendered' ? receipt.renderedRevision : null,
      layersHealthy: receipt.failedLayers.length === 0,
      cameraSignature: JSON.stringify({
        center: center == null ? null : [center.x, center.y],
        extent: extent == null ? null : [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
        wkid: active.spatialReference?.wkid ?? null,
        scale: active.scale,
        zoom: active.zoom,
        rotation,
      }),
      layoutSignature: JSON.stringify({
        width: active.width,
        height: active.height,
        padding,
        epoch: layoutEpoch,
      }),
      paintSignature: JSON.stringify({
        stationary: active.stationary,
        suspended: active.suspended,
        status: receipt.status,
        revision: receipt.renderedRevision,
        failedLayers: receipt.failedLayers,
      }),
      renderUpdateEpoch,
      updating: active.updating,
    }
  }

  /** Own one claim/readiness/capture/submit lifecycle for the current request. */
  async function maybeCaptureObservation(): Promise<void> {
    const initial = getState()
    const request = initial?.observationRequest
    if (disposed || request === null || request === undefined) return
    if (initial?.interaction?.stopped != null || (mapUseStoppedTurn !== null && mapUseStoppedTurn === initial?.interaction?.turnStartSeq)) return
    if (lastObservationSeq === request.requestSeq) return
    const existing = observationAttempt
    if (existing !== undefined) {
      if (existing.requestSeq === request.requestSeq) {
        const live = getState()
        if (existing.frozen !== undefined && live !== undefined) {
          const currentIdentity = captureIdentityOf(live)
          if (currentIdentity === null || !sameCaptureIdentityOutsideUpdating(currentIdentity, existing.frozen)) {
            invalidateObservationAttempt()
          }
        }
        return
      }
      invalidateObservationAttempt()
    }
    const identity = { sessionId, callId: request.callId, requestSeq: request.requestSeq }
    const controller = new AbortController()
    const attemptState: NonNullable<typeof observationAttempt> = {
      requestSeq: request.requestSeq,
      identity,
      controller,
      expiresAtMs: request.expiresAtMs,
      terminal: false,
    }
    observationAttempt = attemptState
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new DOMException('map observation deadline expired', 'TimeoutError'))
    }, Math.max(0, request.expiresAtMs - Date.now()))
    const operation = { signal: controller.signal, expiresAtMs: request.expiresAtMs }
    let token: string | undefined
    const decline = async (code: 'no-view' | 'not-ready' | 'stale' | 'policy' | 'capture-failed'): Promise<void> => {
      if (token === undefined || controller.signal.aborted) return
      attemptState.terminal = await declineObservation(identity, token, code, controller.signal, attemptState.expiresAtMs)
    }
    const readRequestedState = (): MapContainerState | undefined => {
      const live = getState()
      const pending = live?.observationRequest
      if (disposed || observationAttempt !== attemptState || controller.signal.aborted || live === undefined
        || pending == null || live.interaction?.stopped != null
        || (mapUseStoppedTurn !== null && mapUseStoppedTurn === live.interaction?.turnStartSeq)
        || pending.callId !== request.callId || pending.requestSeq !== request.requestSeq
        || pending.revision !== request.revision || pending.expiresAtMs !== request.expiresAtMs
        || live.revision !== request.revision) return undefined
      return live
    }
    try {
      let claim = await claimObservation({ ...identity, revision: request.revision, expiresAtMs: request.expiresAtMs }, controller.signal)
      while (claim.status === 'full') {
        for (let frame = 0; frame < 6; frame += 1) await waitForCaptureFrame(operation)
        if (readRequestedState() === undefined) return
        claim = await claimObservation({ ...identity, revision: request.revision, expiresAtMs: request.expiresAtMs }, controller.signal)
      }
      if (claim.status !== 'claimed') return
      token = claim.token
      attemptState.token = token
      let frozen: CaptureIdentity | undefined
      let captureState: MapContainerState | undefined
      let active: MapView | SceneView | undefined
      let sources: ReturnType<typeof observationSources>['sources'] = []

      while (true) {
        controller.signal.throwIfAborted()
        if (Date.now() >= request.expiresAtMs) throw new DOMException('map observation deadline expired', 'TimeoutError')
        const liveState = readRequestedState()
        if (liveState === undefined) {
          await decline('stale')
          return
        }
        if (holder === undefined) {
          await decline('no-view')
          return
        }
        active = mapView ?? sceneView
        if (active === undefined || active.destroyed) {
          await waitForCaptureFrame(operation)
          continue
        }
        if (receipt.status === 'failed' || receipt.status === 'unavailable') {
          await decline('not-ready')
          return
        }
        frozen = captureIdentityOf(liveState) ?? undefined
        const ready = frozen !== undefined
          && receipt.status === 'rendered'
          && receipt.renderedRevision === request.revision
          && frozen.layersHealthy
          && active.stationary === true && !active.updating && !active.suspended
        if (!ready) {
          await waitForCaptureFrame(operation)
          continue
        }
        if (frozen === undefined) continue
        const expected = observationSources([...liveState.layers.values()].map(layer => ({
          id: layer.id,
          visible: layer.visible,
          opacity: layer.opacity,
          ...(layer.displayDigest === undefined ? {} : { displayDigest: layer.displayDigest }),
          ...(layer.imagery === undefined ? {} : { imagery: layer.imagery }),
        })), liveState.basemap, liveState.imageryDisplay, sourceDescriptor?.labels?.source ?? null)
        sources = expected.sources
        captureState = liveState
        attemptState.frozen = frozen
        break
      }

      if (active === undefined || frozen === undefined || captureState === undefined) {
        await decline('no-view')
        return
      }
      const initialIdentity = frozen
      const capturedView = active
      const captureView = captureViewOf(capturedView)
      const mode = mapView !== undefined ? 'map' : 'scene'
      const attribution = attributionOf(captureState, sourceDescriptor)
      const probe = (): CaptureIdentity => {
        const liveState = readRequestedState()
        if (liveState === undefined) return { ...initialIdentity, viewId: '', sourceDigest: 'stale-request' }
        return captureIdentityOf(liveState) ?? { ...initialIdentity, viewId: '', sourceDigest: 'disposed' }
      }
      let captureFrozen = initialIdentity
      const product = await runCaptureWithUpdatingRetry(
        initialIdentity,
        probe,
        () => readRequestedState() !== undefined,
        () => capturedView.stationary === true && !capturedView.updating && !capturedView.suspended
          && receipt.status === 'rendered' && receipt.renderedRevision === request.revision
          && receipt.failedLayers.length === 0,
        (retryIdentity, readIdentity) => {
          captureFrozen = retryIdentity
          return runCaptureTransaction(
            captureView,
            mode,
            readIdentity,
            retryIdentity,
            labelOverlay?.labels ?? [],
            attribution,
            loadImageElement,
            operation,
          )
        },
        operation,
      )
      frozen = captureFrozen
      attemptState.frozen = frozen
      if ('refusal' in product) {
        await decline(product.refusal === 'no-context' ? 'capture-failed' : product.refusal)
        return
      }
      controller.signal.throwIfAborted()
      if (Date.now() >= operation.expiresAtMs) throw new DOMException('map observation deadline expired', 'TimeoutError')
      if (!sameCaptureIdentity(frozen, probe())) {
        await decline('stale')
        return
      }
      const submitted = await submitObservation({ ...identity, revision: request.revision, token }, {
        renderedRevision: request.revision,
        viewId: frozen.viewId,
        generation: frozen.generation,
        cameraEpoch: frozen.cameraEpoch,
        gestureEpoch: frozen.gestureEpoch,
        imageSize: product.imageSize,
        mapContentRect: product.mapContentRect,
        cssViewSize: product.cssViewSize,
        camera: product.camera,
        georeference: product.georeference,
        sources,
        includedOverlays: ['labels', 'attribution'],
        pngBase64: product.pngBase64,
      }, controller.signal)
      if (submitted.ok) {
        attemptState.terminal = true
      } else {
        const code = submitted.code === 'oversized'
          ? 'oversized'
          : submitted.code === 'malformed'
            ? 'invalid-image'
            : submitted.code === 'stale-revision'
              ? 'stale'
              : 'capture-failed'
        attemptState.terminal = await declineObservation(identity, token, code, controller.signal, attemptState.expiresAtMs)
      }
    } catch (error: unknown) {
      if (isCaptureDeadlineError(error)) {
        if (!controller.signal.aborted) controller.abort(error)
      } else if (!controller.signal.aborted) await decline('capture-failed')
    } finally {
      if (token !== undefined && !attemptState.terminal) {
        if (controller.signal.reason instanceof DOMException
          && controller.signal.reason.message === 'map observation identity changed') {
          attemptState.terminal = await declineObservation(identity, token, 'stale', controller.signal, attemptState.expiresAtMs)
        } else {
          attemptState.terminal = await cancelObservation(identity, token, attemptState.expiresAtMs)
        }
      }
      clearTimeout(timeout)
      if (attemptState.terminal) lastObservationSeq = request.requestSeq
      if (observationAttempt === attemptState) observationAttempt = undefined
    }
  }

  /** Read the live 2D fence compared with one frozen observation. */
  function liveMapUseFence(view: MapView): LiveMapUseFence {
    const padding = view.padding
    return {
      viewId: viewId ?? '',
      generation,
      mapRevision: getState()?.revision ?? -1,
      cameraEpoch,
      gestureEpoch,
      mode: 'map',
      width: view.width,
      height: view.height,
      padding: [padding?.top ?? 0, padding?.right ?? 0, padding?.bottom ?? 0, padding?.left ?? 0],
      camera: cameraOf(captureViewOf(view), 'map'),
    }
  }

  /**
   * Resolve the topmost bounded SDK hits at one CSS point. Only the layer's
   * own graphics entries count; labels, casing, and base imagery never become
   * a fake feature.
   */
  async function hitFactsAt(view: MapView, x: number, y: number): Promise<MapInteractionHit[]> {
    const include = [...layerByName.values()]
      .filter(live => live.kind === 'graphics' && live.carrier.visible)
      .map(live => live.carrier as GraphicsLayer)
    if (include.length === 0) return []
    const results = (await view.hitTest({ x, y }, { include })).results
    const hits: MapInteractionHit[] = []
    const state = getState()
    for (const hit of results) {
      if (hit.type !== 'graphic' || hit.graphic === undefined) continue
      for (const [layerId, live] of layerByName) {
        const entry = live.entries.find(candidate => candidate.graphic === hit.graphic)
        if (entry === undefined) continue
        const record = state?.layers.get(layerId)
        hits.push(interactionHitOf(
          { layerId, layerName: record?.name ?? live.name, featureId: entry.id },
          (entry.graphic.attributes ?? {}) as Record<string, unknown>,
          record === undefined ? null : labelFieldOf(record, live.entries),
        ))
        break
      }
      if (hits.length >= 5) break
    }
    return hits
  }

  /** Own one claim/fence/hit-test/submit lifecycle for the current request. */
  async function runMapUse(request: MapUseClientRequest, observation: MapObservationRecord | null): Promise<void> {
    if (disposed || mapUseAttempt?.requestSeq === request.requestSeq || lastMapUseSeq === request.requestSeq) return
    if (request.action === 'finish') return
    invalidateMapUseAttempt('stale')
    const identity = { sessionId, callId: request.callId, requestSeq: request.requestSeq }
    const controller = new AbortController()
    const attemptState: NonNullable<typeof mapUseAttempt> = {
      requestSeq: request.requestSeq,
      identity,
      controller,
      expiresAtMs: request.expiresAtMs,
      terminal: false,
    }
    mapUseAttempt = attemptState
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new DOMException('map use deadline expired', 'TimeoutError'))
    }, Math.max(0, request.expiresAtMs - Date.now()))
    let token: string | undefined
    const decline = async (code: MapInteractionDeclineCode): Promise<void> => {
      if (token === undefined) return
      attemptState.terminal = await declineMapUse(identity, token, code, request.expiresAtMs)
    }
    try {
      const claim = await claimMapUse({ ...identity, expiresAtMs: request.expiresAtMs }, controller.signal)
      if (claim.status !== 'claimed') return
      token = claim.token
      attemptState.token = token
      if (attemptState.abortCode !== undefined) {
        await decline(attemptState.abortCode)
        return
      }
      if (mapUseStoppedTurn === request.turnStartSeq || getState()?.interaction?.stopped != null) {
        await decline('user-interrupted')
        return
      }
      if (observation === null || observation.observationId !== request.observationId) {
        await decline('stale')
        return
      }
      const state = getState()
      const view = mapView
      if (state === undefined) {
        await decline('stale')
        return
      }
      if (view === undefined || view.destroyed) {
        await decline('no-view')
        return
      }
      if (sceneView !== undefined || state.mode !== 'map') {
        await decline('unsupported')
        return
      }
      if (drawingState.status !== 'idle') {
        await decline('edit-in-progress')
        return
      }
      if (controller.signal.aborted || Date.now() >= request.expiresAtMs
        || getState()?.interaction?.request?.requestSeq !== request.requestSeq) { await decline('stale'); return }
      if (receipt.status !== 'rendered' || receipt.renderedRevision !== observation.mapRevision
        || !view.stationary || view.updating || view.suspended) { await decline('render-failed'); return }
      const refusal = fenceRefusalOf(observation, liveMapUseFence(view))
      if (refusal !== null) {
        await decline(refusal)
        return
      }
      if (request.action === 'click') {
        if (request.xPx === undefined || request.yPx === undefined) {
          await decline('outside-map')
          return
        }
        const css = cssPointOf(observation, request.xPx, request.yPx)
        if (typeof css === 'string') {
          await decline(css === 'outside-map' ? 'outside-map' : 'stale')
          return
        }
        const hits = await Promise.race([
          hitFactsAt(view, css[0], css[1]),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        ])
        if (attemptState.abortCode !== undefined) {
          await decline(attemptState.abortCode)
          return
        }
        const after = fenceRefusalOf(observation, liveMapUseFence(view))
        if (after !== null) {
          await decline(after)
          return
        }
        if (observation.georeference.kind !== 'affine-2d' || observation.camera === null) {
          await decline('unsupported')
          return
        }
        const world = wgs84OfDisplayPoint(
          displayPointOf(observation.georeference.coefficients, request.xPx, request.yPx),
          observation.camera.wkid,
        )
        if (typeof world === 'string') {
          await decline('unsupported')
          return
        }
        if (await submitMapUse({ ...identity, token }, { status: 'hits', hits, world }, controller.signal)) {
          attemptState.terminal = true
        } else {
          await decline('stale')
        }
        return
      }
      if (await submitMapUse({ ...identity, token }, { status: 'validated' }, controller.signal)) {
        attemptState.terminal = true
      } else {
        await decline('stale')
      }
    } catch {
      // Every unknown local failure is a refusal; it never grants an SDK action.
      if (token !== undefined && !attemptState.terminal) await decline(attemptState.abortCode ?? 'stale')
    } finally {
      if (token !== undefined && !attemptState.terminal) {
        if (attemptState.abortCode !== undefined) await decline(attemptState.abortCode)
        else await cancelMapUse(identity, token, request.expiresAtMs)
      }
      clearTimeout(timeout)
      if (attemptState.terminal) lastMapUseSeq = request.requestSeq
      if (mapUseAttempt === attemptState) mapUseAttempt = undefined
      controller.abort()
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
    } catch {
      observe({
        ...receipt, status: 'failed', revision: possible.revision, renderedRevision: null,
        generation, viewId, attempt: ++attempt, layerVersions: [],
        failedLayers: [{ layerId: null, code: 'VIEW_FAILED' }], reason: null, at: new Date().toISOString(),
      }, possible)
      return
    }
    if (active === undefined) return
    const key = JSON.stringify([generation, possible.revision, possible.view, possible.aoi, possible.basemap, possible.imageryDisplay, possible.interaction?.lastResult?.sourceCallSeq, possible.interaction?.turnStartSeq,
      [...possible.layers.values()].map(record => [record.id, renderToken(record), record.visible, record.opacity])])
    if (key === renderKey) {
      publishHandle(possible)
      return
    }
    renderWait?.abort()
    renderWait = new AbortController()
    const signal = renderWait.signal
    renderKey = key
    const known = knownLayerIds
    const added = known === undefined ? [] : [...possible.layers.values()].filter(layer => !known.has(layer.id))
    knownLayerIds = new Set(possible.layers.keys())
    const sourceFailures = active.map == null ? [{ layerId: 'basemap', code: 'BASEMAP_FAILED' } as MapRenderFailure] : syncSourceCarriers(active.map, possible)
    const failures = [...sourceFailures, ...applyLayers(active, possible)]
    const target: MapRenderReceipt = {
      sessionId, occurrenceKey, status: 'applied', revision: possible.revision, renderedRevision: null,
      generation, viewId, attempt: ++attempt,
      layerVersions: [
        ...(earlySourceCarrier === undefined ? [] : [{ id: 'early-imagery', token: possible.imageryDisplay.earlySource?.configDigest ?? 'fixed-release' }]),
        ...(baseSourceCarrier === undefined ? [] : [{ id: 'basemap', token: possible.basemap?.basemap.configDigest ?? 'legacy' }]),
        ...(labelSourceCarrier === undefined ? [] : [{ id: 'labels', token: possible.basemap?.labels?.configDigest ?? 'default-amap' }]),
        ...[...possible.layers.values()].map(record => ({ id: record.id, token: renderToken(record) })),
      ],
      failedLayers: [], reason: null, at: new Date().toISOString(),
    }
    try {
      applyAoi(active, possible)
    } catch {
      failures.push({ layerId: null, code: 'AOI_FAILED' } as MapRenderFailure)
    }
    const nextCamera = possible.view
    const cameraMoved = appliedCamera !== undefined && !viewCameraEquals(appliedCamera, nextCamera)
    let targetCameraSettlement = cameraSettlements.get(active)
    if (appliedCamera === undefined || !viewCameraEquals(appliedCamera, nextCamera)) {
      const result = possible.interaction?.lastResult
      const blocked = appliedCamera !== undefined && result?.view !== null && result?.targetRevision === possible.revision - 1
        && (mapUseStoppedTurn === possible.interaction?.turnStartSeq || possible.interaction?.stopped === 'user-interrupted')
      if (blocked) supersededCamera = { revision: possible.revision, turnStartSeq: possible.interaction?.turnStartSeq ?? null }
      if (!blocked) targetCameraSettlement = syncCamera(active, possible.view)
      appliedCamera = nextCamera
    }
    // Annotation creation and undo preserve the camera; locating an annotation is explicit.
    const framed = added.reverse()
      .map(layer => layer.role === 'user-annotation' || layer.data === undefined ? null : geoJsonBbox(layer.data))
      .find(bbox => bbox !== null)
    if (framed !== undefined && framed !== null && !cameraMoved && !bboxInView(active, framed)
      && (protectedCameraWrites.get(active) ?? 0) === 0) {
      targetCameraSettlement = frameBbox(active, framed)
    }
    const layers: { id: string | null; graphics: GraphicsLayer | FeatureLayer | SourceCarrier }[] = []
    if (earlySourceCarrier !== undefined) {
      layers.push({ id: 'early-imagery', graphics: earlySourceCarrier })
    }
    if (baseSourceCarrier !== undefined) {
      layers.push({ id: 'basemap', graphics: baseSourceCarrier })
    }
    if (labelSourceCarrier !== undefined) {
      layers.push({ id: 'labels', graphics: labelSourceCarrier })
    }
    if (possible.imageryDisplay.recentVisible && baseSourceCarrier === undefined) {
      if (!failures.some(failure => failure.layerId === 'basemap')) {
        failures.push({ layerId: 'basemap', code: 'BASEMAP_FAILED' })
      }
    }
    layers.push(...[...layerByName].filter(([, live]) => live.carrier.visible)
      .map(([id, live]) => ({ id, graphics: live.carrier })))
    if (aoiLive !== undefined) layers.push({ id: null, graphics: aoiLive.graphics })
    observe(failures.length > 0 ? { ...target, status: 'failed', failedLayers: failures } : target, possible)
    if (failures.length > 0) return
    placeLabelsNow()
    void finishRender(active, possible, target, layers, targetCameraSettlement, signal)
    // Inspection can synchronously refresh the occurrence; publish this attempt first.
    const inspected = possible.interaction?.lastResult
    if (inspected?.action === 'click' && inspected.sourceCallSeq !== inspectedUseSeq) {
      inspectedUseSeq = inspected.sourceCallSeq
      const hit = inspected.hits[0]
      const entry = hit === undefined ? undefined : layerByName.get(hit.layerId)?.entries.find(candidate => candidate.id === hit.featureId)
      if (hit !== undefined && entry !== undefined) reportHover({ layerId: hit.layerId, featureId: hit.featureId, entry, inspection: hit }, active)
      else reportHover(null)
    }
  }

  /** Ensure the 2D MapView exists for this holder. */
  function ensureMap(state: MapContainerState): MapView | undefined {
    if (holder === undefined) return undefined
    const engine = viewEngineKey(state.view.wkid)
    if (mapView !== undefined && mapEngineKey !== engine) destroyViews()
    if (mapView === undefined) {
      // The cast bridges ArcGIS's exactOptionalPropertyTypes gap between the
      // Map instance type and the MapProperties the View constructor declares.
      const map = buildMap() as unknown as MapProperties
      const built = new MapView({
        container: holder,
        map,
        ui: { components: [] },
        spatialReference: SpatialReference.fromJSON({ wkid: engine }),
      })
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
      const map = buildMap() as unknown as MapProperties
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
  function syncCamera(view: MapView | SceneView, record: MapViewRecord): Promise<void> {
    const restoring = appliedCamera === undefined
    const writeToken = ++cameraWriteToken
    if (!restoring) protectedCameraWrites.set(view, (protectedCameraWrites.get(view) ?? 0) + 1)
    return enqueueCamera(view, async () => {
      try {
        if (disposed || view.destroyed || writeToken !== cameraWriteToken) return
        const wkid = explicitSpatialReferenceWkid(record.wkid)
        if (wkid !== undefined && view.spatialReference?.wkid !== wkid) view.spatialReference = SpatialReference.fromJSON({ wkid })
        await view.when(() => {
          // A WKID/mode switch destroys this view while the when() promise is
          // still pending; a resolved-then-destroyed view must not be written.
          if (view.destroyed || writeToken !== cameraWriteToken) return
          const control = getState()?.interaction
          if (!restoring && control?.lastResult?.view !== null && control?.lastResult?.targetRevision === (getState()?.revision ?? 0) - 1
            && (control?.stopped === 'user-interrupted' || (mapUseStoppedTurn !== null && mapUseStoppedTurn === control?.turnStartSeq))) {
            supersededCamera = { revision: getState()?.revision ?? 0, turnStartSeq: control?.turnStartSeq ?? null }
            return
          }
          muteGestureAttribution()
          view.center = new Point({ longitude: record.center[0], latitude: record.center[1], spatialReference: SpatialReference.WGS84 })
          if ('rotation' in view) view.rotation = record.rotation ?? 0
          if (record.scale !== undefined) {
            if ('constraints' in view && view.constraints != null && 'snapToZoom' in view.constraints) view.constraints.snapToZoom = false
            view.scale = record.scale
            return
          }
          // Cached-tile (Web Mercator) views have raster LODs; projected views
          // keep MapView.zoom at -1 and take the camera through scale instead.
          if (basemapKindFor(record.wkid) === 'cached-xyz') {
            view.zoom = record.zoom
            view.scale = scaleFromZoom(record.zoom)
          }
          else view.scale = scaleFromZoom(record.zoom)
        })
      } finally {
        if (!restoring) {
          const remaining = (protectedCameraWrites.get(view) ?? 1) - 1
          if (remaining > 0) protectedCameraWrites.set(view, remaining)
          else protectedCameraWrites.delete(view)
        }
      }
    })
  }

  /** The render carrier one layer record wants (imagery tiles, heatmap features, plain graphics). */
  function carrierKindOf(record: MapLayerRecord): AppliedLayer['kind'] {
    if (record.imagery !== undefined) return 'tile'
    if (record.symbol !== undefined && record.symbol.presentation === 'heatmap') return 'heatmap'
    return 'graphics'
  }

  function heatmapRendererOf(block: HeatmapBlock): HeatmapRendererProperties {
    const stops = heatmapStopsOf(block.ramp)
    return {
      type: 'heatmap',
      radius: block.radiusPx,
      ...(block.field === undefined ? {} : { field: block.field }),
      ...(block.minIntensity === undefined ? {} : { minDensity: block.minIntensity }),
      ...(block.maxIntensity === undefined ? {} : { maxDensity: block.maxIntensity }),
      colorStops: stops.map((color, at) => ({ ratio: at / (stops.length - 1), color: at === 0 ? `${color}00` : color })),
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
      } catch {
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
        inspectionHighlights.delete(id)
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
    if (hoveredTarget?.layerId === record.id) reportHover(null)
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
    const overrides = overrideTableOf(record.overrides)
    const legendColor = record.legend?.symbol.color
    const sr = SpatialReference.WGS84
    const entries: AppliedGraphic[] = []
    const casings: Graphic[] = []
    const selected = highlightIds(record.id)
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
        record.symbol !== undefined,
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
      const anchor = labelAnchorOf(geometry)
      entries.push({ id, geometryType: geometry.type as AppliedGraphic['geometryType'], classified, graphic, anchor, bbox: featureBoundsOf(geometry, anchor) })
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
      get observationCapture(): MapHarnessTestHandle['observationCapture'] {
        const active = mapView ?? sceneView
        const liveState = getState()
        const captureIdentity = liveState === undefined ? null : captureIdentityOf(liveState)
        return {
          cameraEpoch: captureIdentity?.cameraEpoch ?? -1,
          layoutEpoch,
          updating: active === undefined || active.destroyed ? null : active.updating,
          renderUpdateEpoch,
          receiptStatus: receipt.status,
          renderedRevision: receipt.renderedRevision,
          generation: receipt.generation,
        }
      },
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
      highlightCount: [...new Set([...highlights.keys(), ...inspectionHighlights.keys()])].reduce((total, id) => total + highlightIds(id).size, 0),
      get labelCount() { return placedLabelCount },
      get latestObservation(): MapHarnessTestHandle['latestObservation'] { return state.latestObservation },
      get interaction(): MapHarnessTestHandle['interaction'] { return state.interaction },
      get labels() { return (labelOverlay?.labels ?? []).map(label => ({ text: label.text, x: label.x, y: label.y, color: label.color })) },
      get labelClusters() { return (labelOverlay?.clusters ?? []).map(badge => ({ x: badge.x, y: badge.y, count: badge.count, bbox: badge.bbox })) },
      get annotationDrawing(): AnnotationDrawingState { return drawingState },
      get annotationSnapshot(): MapHarnessTestHandle['annotationSnapshot'] {
        return state.layers.get('user-annotations') ?? null
      },
      get visualProposals(): MapHarnessTestHandle['visualProposals'] {
        return [...state.visualProposals]
      },
      get observationHistory(): MapHarnessTestHandle['observationHistory'] {
        return [...state.observationHistory]
      },
      get comparisons(): MapHarnessTestHandle['comparisons'] {
        return [...state.comparisons]
      },
      get visualChanges(): MapHarnessTestHandle['visualChanges'] {
        return [...state.visualChanges]
      },
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
    sourceFailure: () => sourceFailure ?? tileFailure,
    retrySource: () => {
      if (disposed) return
      sourceRequest?.controller.abort()
      if (sourceRetry !== undefined) clearTimeout(sourceRetry)
      sourceRetry = undefined
      sourceErrorKey = undefined
      sourceFailures = 0
      sourceFailure = null
      resetTileFailure()
      sourceKey = undefined
      sourceRetryEpoch += 1
      renderKey = undefined
      applyState(getState())
    },
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
      void maybeCaptureObservation()
    },
    focusLayer(layerId: string) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      const record = getState()?.layers.get(layerId)
      const bbox = record === undefined || record.data === undefined ? null : geoJsonBbox(record.data)
      if (bbox === null) return
      const active = mapView ?? sceneView
      if (active !== undefined) frameBbox(active, bbox)
    },
    focusFeature(layerId: string, featureId: string) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      const features = getState()?.layers.get(layerId)?.data?.features
      if (features === undefined) return
      for (const [index, feature] of features.entries()) {
        if (featureIdOf(feature as { id?: unknown }, index) !== featureId) continue
        const bbox = geoJsonBbox(feature.geometry)
        if (bbox !== null) {
          const active = mapView ?? sceneView
          if (active !== undefined) frameBbox(active, bbox)
        }
        return
      }
    },
    setTimeFrame(frame) {
      timeFrame = frame
      // Re-sync under the new frame: the data token embeds it, so every
      // styled layer redraws (or restores its full set on `null`).
      applyState(getState())
    },
    setHighlight(layerId, ids, source = 'selection') {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      ;(source === 'inspection' ? inspectionHighlights : highlights).set(layerId, new Set(ids))
      const state = getState()
      const record = state?.layers.get(layerId)
      if (state === undefined || record === undefined) return
      if (live.kind !== 'graphics') return
      const symbol = singleSymbolOf(record)
      const overrides = overrideTableOf(record.overrides)
      const legendColor = record.legend?.symbol.color
      const selected = highlightIds(layerId)
      for (const entry of live.entries) {
        const resolved = symbolFor(
          entry.geometryType,
          record.style ?? null,
          entry.classified,
          selected.has(entry.id),
          symbol,
          record.symbol !== undefined,
          overrides.get(entry.id),
          legendColor,
        )
        if (resolved === undefined) continue
        entry.graphic.symbol = resolved
      }
      // Highlights are painted in place and never rebuild carriers, so the render key does not
      // carry them; a frozen capture must still be refused because its pixels would no longer match.
      if (observationAttempt?.frozen !== undefined) invalidateObservationAttempt()
      invalidateMapUseAttempt('stale')
      applyState(state)
    },
    dismissInspection() {
      hoverSequence += 1
      reportHover(null)
    },
    captureView: captureLiveView,
    runMapUse,
    stopMapUse(turn) {
      if (getState()?.interaction?.turnStartSeq === turn) takeMapControl()
    },
    startAnnotationDrawing: kind => {
      takeMapControl()
      return ensureDrawingHost().start(kind)
    },
    startAnnotationEditing: (featureId, geometry, expectedUpdatedAt) => {
      takeMapControl()
      const graphic = new Graphic({ geometry: arcgisGeometryOfAnnotation(geometry), attributes: { featureId } })
      return ensureDrawingHost().startEditing(featureId, graphic, expectedUpdatedAt)
    },
    cancelAnnotationDrawing: () => drawingHost?.cancel() ?? false,
    annotationDrawingState: () => drawingState,
    mapControlState,
    zoomBy,
    resetBearing,
    dispose() {
      if (disposed) return
      takeMapControl()
      disposed = true
      invalidateMapUseAttempt('stale')
      mapUseAttempt?.controller.abort()
      sessionOccurrences.delete(sessionId)
    sourceRequest?.controller.abort()
    if (sourceRetry !== undefined) clearTimeout(sourceRetry)
    sourceRetry = undefined
      destroyViews()
      holder = undefined
      // Keep the last applied/rendered/failed observation as historical evidence.
      receipt = Object.freeze({ ...receipt, status: 'unavailable', renderedRevision: null, viewId: null, reason: 'disposed' })
      const handles = (globalThis as { __mapHarness?: Map<string, unknown> }).__mapHarness
      if (handles !== undefined && handles.get(handleKey) === publishedHandle) handles.delete(handleKey)
      publishedHandle = undefined
    const interceptors = esriConfig.request.interceptors
    const interceptorAt = interceptors.indexOf(sourceInterceptor)
    if (interceptorAt >= 0) interceptors.splice(interceptorAt, 1)
    const tileInterceptorAt = interceptors.indexOf(tileInterceptor)
    if (tileInterceptorAt >= 0) interceptors.splice(tileInterceptorAt, 1)
    },
  }
  sessionOccurrences.set(sessionId, occurrence)
  return occurrence
}
