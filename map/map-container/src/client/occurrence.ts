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
import type { MapContainerState, MapLayerRecord, MapLayerStream, MapLayerTerrain, MapViewRecord } from '../registry.ts'
import { geoJsonBbox } from './bbox.ts'
import { basemapKindFor, explicitSpatialReferenceWkid, KEY_FREE_BASEMAP, scaleFromZoom, viewCameraEquals, viewEngineKey, WEB_MERCATOR_ZOOM0_SCALE } from './view-policy.ts'
import type { MapHarnessTestHandle, MapOccurrence } from './face.ts'
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

/** View events whose arrival attributes camera changes to the user. */
const GESTURE_INTERACTION_EVENTS = ['pointer-drag', 'mouse-wheel', 'key-down', 'double-click'] as const

/** One layer's live graphics plus the name it was applied under. */
interface AppliedLayer {
  readonly graphics: GraphicsLayer
  readonly name: string
  /** Per-graphic identity and classification, kept for highlight re-symbols. */
  entries: AppliedGraphic[]
}

/** One rendered feature: its stable id, class, and graphic. */
interface AppliedGraphic {
  readonly id: string
  readonly classified: ClassifiedValue
  readonly graphic: Graphic
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
      if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        attributes[key] = value
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        attributes[key] = value
      }
    }
  }
  attributes.__fid = featureId
  return attributes
}

/** The highlight outline every selected feature wears (hue-independent of the class ramp). */
const HIGHLIGHT_COLOR = '#ffdf00'
const HIGHLIGHT_WIDTH = 3

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

/**
 * The symbol one feature wears under its style and classification:
 * class color (and graduated size for point totals), the missing shape with a
 * dashed outline, and the highlight outline over either. Unstyled layers
 * return `undefined` and keep ArcGIS's default single symbol.
 * @param geometryType - the feature's geometry type.
 * @param style - the layer's style, or `null` for an unstyled layer.
 * @param classified - the feature's class.
 * @param selected - whether the shared selection highlights the feature.
 * @returns the symbol, or `undefined` for unstyled layers.
 */
function symbolFor(
  geometryType: 'Point' | 'LineString' | 'Polygon',
  style: StyleSpec | null,
  classified: ClassifiedValue,
  selected: boolean,
): ArcgisSymbol | undefined {
  // `undefined` is a legal return: unstyled layers keep ArcGIS's default single symbol.
  if (style === null) return undefined
  const isClass = typeof classified === 'number'
  const color = isClass
    ? (style.palette[classified] as string)
    : classified === 'missing' ? style.missingColor : style.overflowColor
  if (geometryType === 'Point') {
    const size = style.encoding === 'size'
      ? sizeForClass(isClass ? classified : style.palette.length, style.palette.length)
      : SIZE_DEFAULT_PX
    return new SimpleMarkerSymbol({
      color,
      // Non-color encoding: classes graduate by size, missing renders as an x.
      style: classified === 'missing' ? 'x' : 'circle',
      size,
      outline: {
        color: selected ? HIGHLIGHT_COLOR : '#ffffff',
        width: selected ? HIGHLIGHT_WIDTH : 1,
      },
    }) as ArcgisSymbol
  }
  if (geometryType === 'LineString') {
    return new SimpleLineSymbol({
      color,
      // Non-color encoding: missing runs dashed.
      style: classified === 'missing' ? 'dash' : 'solid',
      width: selected ? HIGHLIGHT_WIDTH : 2,
    }) as ArcgisSymbol
  }
  return new SimpleFillSymbol({
    color,
    outline: {
      color: selected ? HIGHLIGHT_COLOR : '#ffffff',
      width: selected ? HIGHLIGHT_WIDTH : 1,
      style: classified === 'missing' ? 'dash' : 'solid',
    },
  }) as ArcgisSymbol
}

/** The non-undefined ArcGIS symbol face the factory builds. */
type ArcgisSymbol = NonNullable<GraphicProperties['symbol']>

/** Default point diameter when the style encodes by fill rather than size. */
const SIZE_DEFAULT_PX = 8

/**
 * Build one occurrence's map face.
 * @param getState - reads the current container state.
 * @param sessionId - the owning session, for the window test handle.
 * @param occurrenceKey - the sidebar occurrence key, for the test handle.
 * @returns the occurrence face with lazy ArcGIS lifecycle.
 */
export function createMapOccurrence(
  getState: () => MapContainerState | undefined,
  sessionId: string,
  occurrenceKey: string,
  hooks: { readonly onGestureObservation?: GestureEmit; readonly gestureClock?: GestureClock } = {},
): MapOccurrence {
  const handleKey = `${sessionId}:${occurrenceKey}`
  const receiptStore = createRenderReceiptStore(sessionId, occurrenceKey)
  let generation = receiptStore.get()?.generation ?? 0
  let viewId: string | null = null
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
  /** Gesture observer + event handles of the live view; rebuilt with the view. */
  let gestureObserver: GestureObserver | undefined
  const gestureHandles: { remove(): void }[] = []

  /** Forward one settled observation to the session-queue sink. */
  const gestureEmit: GestureEmit = (text, observation) => {
    hooks.onGestureObservation?.(text, observation)
  }

  /** Plain-number camera fix from the live view; `undefined` when the view cannot report one. */
  function gestureSnapshotOf(view: MapView | SceneView, mode: 'map' | 'scene'): GestureCameraSnapshot | undefined {
    const center = view.center as { x?: number; y?: number } | undefined
    const extent = view.extent as { xmin?: number; ymin?: number; xmax?: number; ymax?: number } | undefined
    const wkid = (view.spatialReference as { wkid?: number } | undefined)?.wkid
    if (center?.x === undefined || center.y === undefined || extent?.xmin === undefined || wkid === undefined) return undefined
    const scale = (view as { scale?: number }).scale
    const rawZoom = (view as { zoom?: number }).zoom
    const zoom = typeof rawZoom === 'number' && rawZoom >= 0
      ? rawZoom
      : typeof scale === 'number' && scale > 0
        ? Math.log2(WEB_MERCATOR_ZOOM0_SCALE / scale)
        : Number.NaN
    if (!Number.isFinite(zoom)) return undefined
    if (extent.ymin === undefined || extent.xmax === undefined || extent.ymax === undefined) return undefined
    return {
      center: [center.x, center.y],
      zoom,
      extent: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
      wkid,
      mode,
    }
  }

  /** Mute attribution while the occurrence itself drives the camera (syncCamera, focus goTo). */
  function muteGestureAttribution(): void {
    gestureObserver?.programmatic()
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
    const viewWithEvents = view as unknown as {
      on: (names: readonly string[], handler: () => void) => { remove(): void }
    }
    gestureHandles.push(viewWithEvents.on(GESTURE_INTERACTION_EVENTS, () => observer.interaction()))
    gestureHandles.push(watch(readCamera, () => {
      const snapshot = gestureSnapshotOf(view, mode)
      if (snapshot !== undefined) observer.cameraChanged(snapshot)
    }))
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
    for (const live of layerByName.values()) live.graphics.destroy()
    layerByName.clear()
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
    layers: readonly { id: string | null; graphics: GraphicsLayer }[], signal: AbortSignal,
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
    if (appliedCamera === undefined || !viewCameraEquals(appliedCamera, nextCamera)) {
      syncCamera(active, possible.view)
      appliedCamera = nextCamera
    }
    observe(failures.length > 0 ? { ...target, status: 'failed', failedLayers: failures } : target, possible)
    if (failures.length > 0) return
    const layers = [...layerByName].filter(([, live]) => live.graphics.visible)
      .map(([id, live]) => ({ id: id as string | null, graphics: live.graphics }))
    if (aoiLive !== undefined) layers.push({ id: null, graphics: aoiLive.graphics })
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

  /** Make the graphics layers match the state's layer records. */
  function applyLayers(view: MapView | SceneView, state: MapContainerState): MapRenderFailure[] {
    const failures: MapRenderFailure[] = []
    const map = view.map
    if (map == null) return [{ layerId: null, code: 'VIEW_FAILED' }]
    for (const record of state.layers.values()) {
      try {
        let live = layerByName.get(record.id)
        if (live === undefined) {
          const graphics = new GraphicsLayer({ title: record.name })
          map.add(graphics)
          live = { graphics, name: record.name, entries: [] }
          layerByName.set(record.id, live)
        }
        if (live.graphics.visible !== record.visible) live.graphics.visible = record.visible
        if (live.graphics.opacity !== record.opacity) live.graphics.opacity = record.opacity
        syncGraphics(live, record, state)
      } catch (error) {
        dataTokens.delete(record.id)
        failures.push({ layerId: record.id, code: 'LAYER_FAILED' })
      }
    }
    for (const [id, live] of layerByName) {
      if (!state.layers.has(id)) {
        map.remove(live.graphics)
        live.graphics.destroy()
        layerByName.delete(id)
        // Dropping the layer also drops its rendered identity: a later
        // re-add of the same id must rebuild graphics, never reuse a
        // cached data token from the removed layer.
        dataTokens.delete(id)
        highlights.delete(id)
      }
    }
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
        outline: { color: '#7a5cd6', width: 2, style: 'dash' },
      }) as ArcgisSymbol,
    }))
    aoiLive = { graphics, ringKey }
  }

  const dataTokens = new Map<string, string>()
  function renderToken(record: MapLayerRecord): string {
    const dataToken = record.displayDigest ?? contentDigestOf(record.data)
    // The terrain revision rides the render token explicitly: two surface
    // versions can decimate to identical display copies, and only the
    // revision tells the occurrence to redraw for the new version. The same
    // logic keeps stream workbenches live: the workbench revision and mode
    // change even when the window display copy does not (pause, gap counts).
    const streamToken = record.stream === undefined
      ? 'none'
      : `${record.stream.mode}:${record.stream.revision}:${record.stream.paused ? 'paused' : 'live'}`
    return `${dataToken}|${record.style?.styleVersion ?? 'plain'}|${record.terrain?.revision ?? 'none'}|${streamToken}|${timeFrame === null ? 'all' : `${timeFrame.index}:${timeFrame.startMs}-${timeFrame.endMs}`}`
  }
  function syncGraphics(live: AppliedLayer, record: MapLayerRecord, state: MapContainerState): void {
    const graphics = live.graphics
    const token = renderToken(record)
    if (dataTokens.get(record.id) === token) return
    graphics.removeAll()
    const sr = SpatialReference.WGS84
    const entries: AppliedGraphic[] = []
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
      const style = record.style ?? null
      const classified: ClassifiedValue = style === null
        ? 'missing'
        : classifyValue(style, measureValueOf(feature.properties ?? null, style))
      const id = featureIdOf(feature as { id?: unknown }, index)
      const symbol = symbolFor(geometry.type as 'Point' | 'LineString' | 'Polygon', style, classified, selected.has(id))
      const graphic = new Graphic({
        geometry: g,
        attributes: graphicAttributesOf(feature.properties, id),
        ...(symbol === undefined ? {} : { symbol }),
      })
      graphics.add(graphic)
      entries.push({ id, classified, graphic })
    }
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
      styledLayers: [...state.layers.values()].filter(layer => layer.style !== undefined).map(layer => layer.id),
      visibleFeatureCount: [...layerByName.values()].reduce((total, live) => total + live.entries.length, 0),
      frameIndex: timeFrame?.index ?? null,
      highlightCount: [...highlights.values()].reduce((total, ids) => total + ids.size, 0),
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

  return {
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
    },
    focusLayer(layerId: string) {
      const live = layerByName.get(layerId)
      if (live === undefined) return
      if (!live.graphics.visible) live.graphics.visible = true
      const record = getState()?.layers.get(layerId)
      const bbox = record === undefined ? null : geoJsonBbox(record.data)
      const active = mapView ?? sceneView
      if (bbox === null || active === undefined) return
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
      for (const entry of live.entries) {
        const symbol = symbolFor(
          entry.graphic.geometry?.type as 'Point' | 'LineString' | 'Polygon',
          record.style ?? null,
          entry.classified,
          ids.has(entry.id),
        )
        if (symbol === undefined) continue
        entry.graphic.symbol = symbol
      }
      applyState(state)
    },
    dispose() {
      if (disposed) return
      disposed = true
      destroyViews()
      holder = undefined
      // Keep the last applied/rendered/failed observation as historical evidence.
      receipt = Object.freeze({ ...receipt, status: 'unavailable', renderedRevision: null, viewId: null, reason: 'disposed' })
      const handles = (globalThis as { __mapHarness?: Map<string, unknown> }).__mapHarness
      if (handles !== undefined && handles.get(handleKey) === publishedHandle) handles.delete(handleKey)
      publishedHandle = undefined
    },
  }
}
