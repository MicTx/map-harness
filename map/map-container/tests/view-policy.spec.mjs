import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEY_FREE_BASEMAP,
  WEB_MERCATOR_ZOOM0_SCALE,
  basemapKindFor,
  boundsToZoom,
  rasterBasemapEnabled,
  scaleFromZoom,
  explicitSpatialReferenceWkid,
  viewCameraEquals,
  viewEngineKey,
  viewportSnapshotOf,
  zoomFromScale,
} from '../src/client/view-policy.ts'

test('key-free basemap uses ArcGIS Online World Imagery without an API token', () => {
  assert.equal(KEY_FREE_BASEMAP.title, 'World Imagery')
  assert.equal(
    KEY_FREE_BASEMAP.urlTemplate,
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{level}/{row}/{col}',
  )
  assert.equal(KEY_FREE_BASEMAP.urlTemplate.includes('token'), false)
  assert.match(KEY_FREE_BASEMAP.copyright, /Esri/)
})

test('geographic records keep the ArcGIS view default Web Mercator', () => {
  assert.equal(explicitSpatialReferenceWkid(4326), undefined)
})

test('projected records request their explicit spatial reference', () => {
  assert.equal(explicitSpatialReferenceWkid(4547), 4547)
  assert.equal(explicitSpatialReferenceWkid(3857), 3857)
})

test('projected views skip the Web-Mercator imagery tiles', () => {
  assert.equal(rasterBasemapEnabled(4326), true)
  assert.equal(rasterBasemapEnabled(3857), true)
  assert.equal(rasterBasemapEnabled(4547), false)
  assert.equal(viewEngineKey(4326), 3857)
  assert.equal(viewEngineKey(3857), 3857)
  assert.equal(viewEngineKey(4547), 4547)
})

test('zoom converts to scale for projected views without raster LODs', () => {
  assert.ok(Math.abs(scaleFromZoom(0) - WEB_MERCATOR_ZOOM0_SCALE) < 1e-6)
  assert.ok(Math.abs(scaleFromZoom(9) - WEB_MERCATOR_ZOOM0_SCALE / 512) < 1e-6)
  assert.ok(scaleFromZoom(12) < scaleFromZoom(9), 'higher zoom means smaller scale')
})

test('basemap source follows the engine: cached tiles or dynamic export', () => {
  assert.equal(basemapKindFor(4326), 'cached-xyz')
  assert.equal(basemapKindFor(3857), 'cached-xyz')
  assert.equal(basemapKindFor(4547), 'dynamic-export')
  assert.match(KEY_FREE_BASEMAP.urlTemplate.replace(/\/tile\/\{level\}\/\{row\}\/\{col\}$/u, ''), /World_Imagery\/MapServer$/u)
})

test('camera equality is by value so a new projection object does not retrigger sync', () => {
  const a = { center: [116.4, 39.9], zoom: 9, wkid: 4326 }
  assert.equal(viewCameraEquals(a, { center: [116.4, 39.9], zoom: 9, wkid: 4326 }), true)
  assert.equal(viewCameraEquals(a, { center: [116.4, 39.9], zoom: 10, wkid: 4326 }), false)
  assert.equal(viewCameraEquals(a, { center: [116.4, 39.9], zoom: 9, wkid: 4547 }), false)
})

test('scene construction uses the same 4326 skip as 2D camera sync', () => {
  const geographic = explicitSpatialReferenceWkid(4326)
  const projected = explicitSpatialReferenceWkid(4547)
  assert.equal(geographic === undefined, true)
  assert.deepEqual(
    geographic === undefined ? {} : { spatialReference: { wkid: geographic } },
    {},
  )
  assert.deepEqual(
    projected === undefined ? {} : { spatialReference: { wkid: projected } },
    { spatialReference: { wkid: 4547 } },
  )
})

test('zoom inverts scale through the same anchor constant', () => {
  for (const zoom of [0, 5, 10, 15, 20]) {
    assert.ok(Math.abs(zoomFromScale(scaleFromZoom(zoom)) - zoom) < 1e-9, `round trip at ${zoom}`)
  }
})

test('an unusable scale has no zoom', () => {
  assert.ok(Number.isNaN(zoomFromScale(Number.NaN)))
  assert.ok(Number.isNaN(zoomFromScale(0)))
  assert.ok(Number.isNaN(zoomFromScale(-1)))
})

test('bounds frame the whole world at zoom 0 and a tiny box near the ceiling', () => {
  assert.equal(boundsToZoom({ west: -180, south: -90, east: 180, north: 90 }), 0)
  const tight = boundsToZoom({ west: 0, south: 0, east: 0.001, north: 0.001 })
  assert.ok(tight > 18 && tight <= 20, `tight box zoom ${tight}`)
})

test('a degenerate or negative box frames nothing', () => {
  assert.equal(boundsToZoom({ west: 5, south: 5, east: 5, north: 5 }), 0)
  assert.equal(boundsToZoom({ west: 10, south: 10, east: 0, north: 0 }), 0)
})

test('bounds zoom stays inside the tool contract range', () => {
  const huge = boundsToZoom({ west: -1e6, south: -1e6, east: 1e6, north: 1e6 })
  assert.ok(huge >= 0 && huge <= 20)
  const tiny = boundsToZoom({ west: 0, south: 0, east: 1e-9, north: 1e-9 })
  assert.equal(tiny, 20)
})

function snapshotView(overrides = {}) {
  return {
    center: { x: 116.4, y: 39.9 },
    extent: { xmin: 116, ymin: 39.5, xmax: 116.8, ymax: 40.3 },
    spatialReference: { wkid: 4326 },
    scale: scaleFromZoom(9),
    zoom: 9,
    ...overrides,
  }
}

test('a readable view yields a complete snapshot', () => {
  assert.deepEqual(viewportSnapshotOf(snapshotView(), 'map'), {
    center: [116.4, 39.9],
    zoom: 9,
    extent: [116, 39.5, 116.8, 40.3],
    wkid: 4326,
    mode: 'map',
  })
  assert.equal(viewportSnapshotOf(snapshotView(), 'scene').mode, 'scene')
})

test('an unreadable field leaves no half-reported snapshot', () => {
  assert.equal(viewportSnapshotOf(snapshotView({ center: { y: 39.9 } }), 'map'), undefined)
  assert.equal(viewportSnapshotOf(snapshotView({ spatialReference: {} }), 'map'), undefined)
  assert.equal(viewportSnapshotOf(snapshotView({ extent: { xmin: 0, ymin: 0, xmax: 1 } }), 'map'), undefined)
})

test('a projected view without a zoom derives it from the scale', () => {
  const derived = viewportSnapshotOf(snapshotView({ zoom: -1, scale: scaleFromZoom(12) }), 'map')
  assert.ok(derived !== undefined)
  assert.ok(Math.abs(derived.zoom - 12) < 1e-9)
})

test('no zoom and no usable scale leaves no snapshot', () => {
  assert.equal(viewportSnapshotOf(snapshotView({ zoom: -1, scale: Number.NaN }), 'map'), undefined)
})
