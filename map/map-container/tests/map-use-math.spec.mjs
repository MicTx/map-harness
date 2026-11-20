/**
 * Pure continuous map-use math: pan follows a pointer drag, anchored zoom
 * keeps its world point fixed, click pixels respect the map-content rect and
 * DPR scale, and only geographic/Web-Mercator display coordinates convert
 * back to WGS84. Independent control points prove the direction/anchor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cssPointOf,
  interactionHitOf,
  panTargetOf,
  parseMapUseArguments,
  wgs84OfDisplayPoint,
  zoomTargetOf,
} from '../src/map-use.ts'
import { scaleFromZoom } from '../src/view-policy.ts'

/** One valid observation whose 800x600 image maps 1 px to 1000 Web-Mercator metres. */
function mercatorObservation(overrides = {}) {
  return {
    observationId: 'obs-1',
    callId: 'call-1',
    requestSeq: 3,
    mapRevision: 4,
    viewId: 'view-1',
    generation: 2,
    cameraEpoch: 5,
    gestureEpoch: 1,
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 800, height: 600, sha256: '0'.repeat(64) },
    capturedAt: '2026-11-06T00:00:00.000Z',
    imageSize: { width: 800, height: 600 },
    mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
    cssViewSize: { width: 800, height: 600 },
    camera: {
      center: [0, 0], extent: [-400000, -300000, 400000, 300000], wkid: 3857,
      scale: scaleFromZoom(10), zoom: 10, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
    },
    georeference: {
      kind: 'affine-2d',
      coefficients: [1000, 0, -400000, 0, -1000, 300000],
      wkid: 3857,
      maxResidualCssPx: 0,
    },
    sources: [{ id: 'esri-world-imagery', kind: 'basemap', version: null, attribution: null, policy: 'fixed' }],
    includedOverlays: ['attribution'],
    limitations: [],
    ...overrides,
  }
}

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}

test('pan follows a pointer drag: content moves right, camera centre moves west', () => {
  const target = panTargetOf(mercatorObservation(), 10, 0)
  assert.equal(typeof target, 'object')
  close(target.center[0], -10000 / 6378137 * 180 / Math.PI, 1e-7)
  close(target.center[1], 0, 1e-7)
  assert.equal(target.zoom, 10)
  assert.equal(target.wkid, 3857)
  const down = panTargetOf(mercatorObservation(), 0, 10)
  close(down.center[0], 0, 1e-7)
  close(down.center[1], Math.atan(Math.sinh(10000 / 6378137)) * 180 / Math.PI, 1e-10)
})

test('anchored zoom keeps the anchored world point fixed and applies the clamped delta', () => {
  const centred = zoomTargetOf(mercatorObservation(), 1)
  close(centred.center[0], 0, 1e-9)
  close(centred.center[1], 0, 1e-9)
  assert.equal(centred.zoom, 11)
  const offset = zoomTargetOf(mercatorObservation(), 1, [500, 300])
  // The anchor is 100 km east of centre; the centre must move halfway toward it.
  close(offset.center[0], 50000 / 6378137 * 180 / Math.PI, 1e-9)
  close(offset.center[1], 0, 1e-9)
  const clamped = zoomTargetOf(mercatorObservation({ camera: { ...mercatorObservation().camera, scale: scaleFromZoom(23), zoom: 23 } }), 4)
  assert.equal(clamped.zoom, 24)
})

test('zoom rejects anchors outside the map-content rect and unsupported georeferences', () => {
  assert.equal(zoomTargetOf(mercatorObservation(), 1, [900, 300]), 'outside-map')
  assert.equal(zoomTargetOf(mercatorObservation({ camera: null }), 1), 'unsupported-georeference')
  assert.equal(zoomTargetOf(mercatorObservation({ georeference: { kind: 'none', reason: 'not-2d' } }), 1), 'unsupported-georeference')
  assert.equal(zoomTargetOf(mercatorObservation(), 9), 'invalid-argument')
})

test('click pixels map through the content rectangle and reject the attribution footer', () => {
  assert.deepEqual(cssPointOf(mercatorObservation(), 400, 300), [400, 300])
  const scaled = mercatorObservation({
    imageSize: { width: 1600, height: 1200 },
    mapContentRect: { x: 0, y: 0, width: 1600, height: 1200 },
    cssViewSize: { width: 800, height: 600 },
  })
  assert.deepEqual(cssPointOf(scaled, 800, 600), [400, 300])
  const footer = mercatorObservation({ imageSize: { width: 800, height: 660 }, mapContentRect: { x: 0, y: 0, width: 800, height: 600 } })
  assert.equal(cssPointOf(footer, 400, 630), 'outside-map')
  assert.equal(cssPointOf(footer, Number.NaN, 1), 'invalid-argument')
})

test('display coordinates convert back to WGS84 only for geographic/Web-Mercator WKIDs', () => {
  const centre = wgs84OfDisplayPoint([0, 0], 3857)
  assert.deepEqual(centre, [0, 0])
  const east = wgs84OfDisplayPoint([20037508.342789244, 0], 3857)
  close(east[0], 180, 1e-6)
  assert.deepEqual(wgs84OfDisplayPoint([116.4, 39.9], 4326), [116.4, 39.9])
  assert.equal(wgs84OfDisplayPoint([0, 0], 4547), 'unsupported-georeference')
  assert.equal(wgs84OfDisplayPoint([1e20, 0], 3857), 'world-wrap')
  assert.equal(wgs84OfDisplayPoint([200, 0], 4326), 'world-wrap')
})

test('map_use arguments are strict per action; finish needs no observation', () => {
  assert.deepEqual(parseMapUseArguments(JSON.stringify({ action: 'pan', observation_id: 'obs-1', dx_px: 1, dy_px: 2 })), {
    action: 'pan', observationId: 'obs-1', dxPx: 1, dyPx: 2,
  })
  assert.equal(parseMapUseArguments(JSON.stringify({ action: 'pan', observation_id: 'obs-1', dx_px: 1, dy_px: 2, extra: 1 })), null)
  assert.equal(parseMapUseArguments(JSON.stringify({ action: 'zoom', observation_id: 'obs-1', delta_zoom: 1, anchor_x_px: 2 })), null)
  assert.deepEqual(parseMapUseArguments(JSON.stringify({ action: 'finish', reason: 'done' })), { action: 'finish', reason: 'done' })
  assert.equal(parseMapUseArguments('not json'), null)
})

test('hit facts whitelist scalar attributes, block prototype keys, and bound the list', () => {
  const attributes = {
    name: 'Hospital',
    count: 12,
    open: true,
    missing: null,
    object: { nested: true },
    __proto__: { polluted: true },
    constructor: 'blocked',
    '__fid': 7,
  }
  const hit = interactionHitOf({ layerId: 'hospitals', layerName: 'Hospitals', featureId: 'feature-1' }, attributes, 'name')
  assert.equal(hit.title, 'Hospital')
  assert.deepEqual(hit.fields.map(field => field.name), ['name', 'count', 'open', 'missing'])
  assert.equal(hit.fields.find(field => field.name === 'missing').value, '—')
  assert.equal(hit.omitted, 0)
  const long = interactionHitOf({ layerId: 'l', layerName: 'L', featureId: 'f' }, { name: 'x'.repeat(300) }, 'name')
  assert.equal(long.fields[0].value.endsWith('…'), true)
  assert.equal([...long.fields[0].value].length, 256)
  const translated = interactionHitOf({ layerId: 'l', layerName: 'L', featureId: 'f' }, { '名称': '医院', emoji: '🌍'.repeat(256) }, '名称')
  assert.equal(translated.title, '医院')
  assert.equal(translated.fields[0].name, '名称')
  assert.ok(translated.fields[1].value.length <= 256)
})
