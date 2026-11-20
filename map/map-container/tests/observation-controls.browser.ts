/**
 * Lead-authored raw SDK observations for the capture adapter and compositor.
 * This is a separate calibration view, not a substitute for the real Session
 * composition. The independent checker consumes the frozen toScreen results.
 */
import EsriMap from '@arcgis/core/Map.js'
import MapView from '@arcgis/core/views/MapView.js'
import WebTileLayer from '@arcgis/core/layers/WebTileLayer.js'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js'
import Graphic from '@arcgis/core/Graphic.js'
import Point from '@arcgis/core/geometry/Point.js'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js'
import esriConfig from '@arcgis/core/config.js'
import { whenOnce } from '@arcgis/core/core/reactiveUtils.js'
import { captureViewOf, loadImageElement, runCaptureTransaction } from '../src/client/observation-capture.ts'
import { OBSERVATION_CONTROL_CASES, OBSERVATION_CONTROL_POINTS } from './observation-control-cases.mjs'

/** Await one fixture-owned operation without keeping an abort listener alive. */
async function within<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/** Publish only fixture data in the owned document, never a global current-view hook. */
function publish(value: object): void {
  const output = document.querySelector('output')
  if (output === null) throw new Error('calibration output element is absent')
  output.textContent = JSON.stringify(value)
}

/** Create one real ArcGIS view, capture it, and retain independent SDK control positions. */
async function collect(): Promise<void> {
  const name = new URL(location.href).searchParams.get('case')
  const spec = OBSERVATION_CONTROL_CASES.find(value => value.name === name)
  if (spec === undefined) throw new Error('unknown calibration case')
  const holder = document.querySelector<HTMLDivElement>('#map')
  if (holder === null) throw new Error('calibration holder is absent')
  esriConfig.assetsPath = `${location.origin}/assets`
  const layer = new WebTileLayer({
    urlTemplate: `${location.origin}/tiles/{level}/{row}/{col}.png`,
    copyright: 'Generated local calibration grid',
  })
  const markers = new GraphicsLayer({
    graphics: OBSERVATION_CONTROL_POINTS.map(({ wgs84: [longitude, latitude], color }) => new Graphic({
      geometry: new Point({ longitude, latitude, spatialReference: { wkid: 4326 } }),
      symbol: new SimpleMarkerSymbol({ style: 'circle', color, size: 12, outline: { width: 0 } }),
    })),
  })
  const map = new EsriMap({ layers: [layer, markers] })
  const view = new MapView({
    map,
    container: holder,
    spatialReference: { wkid: 3857 },
    center: [116.4, 39.9],
    zoom: spec.zoom,
    rotation: spec.rotation,
    padding: spec.padding,
    constraints: { snapToZoom: false },
  })
  const controller = new AbortController()
  const expiresAtMs = Date.now() + 30_000
  const timer = setTimeout(() => controller.abort(new DOMException('calibration deadline', 'TimeoutError')), 30_000)
  try {
    await within(view.when(), controller.signal)
    await within(view.whenLayerView(layer), controller.signal)
    await whenOnce(() => view.stationary && !view.updating && !view.suspended, { signal: controller.signal })
    await within(new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), controller.signal)
    const controls = OBSERVATION_CONTROL_POINTS.map(({ wgs84: [longitude, latitude], color }) => ({
      wgs84: [longitude, latitude],
      markerColor: color,
      screen: view.toScreen(new Point({ longitude, latitude, spatialReference: { wkid: 4326 } })),
    }))
    const labels = controls.flatMap((point, index) => point.screen === null ? [] : [{
      key: `control-${index}`,
      text: String.fromCharCode(65 + index),
      x: point.screen.x,
      y: point.screen.y - 18,
      color: '#17324d',
    }])
    const identity = {
      viewId: `calibration-${spec.name}`,
      generation: 1,
      cameraEpoch: 0,
      gestureEpoch: 0,
      sourceDigest: 'generated-grid-v1',
      renderedRevision: 0,
      layersHealthy: layer.loadStatus === 'loaded',
    }
    const capture = await runCaptureTransaction(
      captureViewOf(view), 'map', () => identity, identity, labels,
      'Generated local calibration grid; no satellite imagery',
      loadImageElement, { signal: controller.signal, expiresAtMs },
    )
    if ('refusal' in capture) {
      publish({ ok: false, name: spec.name, capture })
      return
    }
    publish({
      ok: true,
      name: spec.name,
      requested: spec,
      devicePixelRatio: devicePixelRatio,
      capture,
      controlPoints: controls,
      sdkCamera: {
        rotation: view.rotation,
        padding: {
          top: view.padding.top,
          right: view.padding.right,
          bottom: view.padding.bottom,
          left: view.padding.left,
        },
        width: view.width,
        height: view.height,
        wkid: view.spatialReference.wkid,
      },
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
    view.destroy()
  }
}

void collect().catch((error: unknown) => {
  publish({ ok: false, error: error instanceof Error ? { name: error.name, message: error.message } : String(error) })
})
