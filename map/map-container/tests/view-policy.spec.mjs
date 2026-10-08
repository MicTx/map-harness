import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEY_FREE_BASEMAP,
  WEB_MERCATOR_ZOOM0_SCALE,
  basemapKindFor,
  rasterBasemapEnabled,
  scaleFromZoom,
  explicitSpatialReferenceWkid,
  viewCameraEquals,
  viewEngineKey,
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
