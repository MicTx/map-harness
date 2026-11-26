import test from 'node:test'
import assert from 'node:assert/strict'
import { createMapSourceCatalog } from '../src/sources.ts'
import { createMapSourceRoutes } from '../src/source-route.ts'
import { waybackDescriptor } from '../src/wayback.ts'
import {
  NativeSourceEpoch,
  SourceRuntimeEpoch,
  parseMapSourceRenderDescriptor,
} from '../src/source-render-protocol.ts'

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const base = catalog.descriptorOf('esri-world-imagery')
const labels = catalog.descriptorOf('esri-world-boundaries-places')
const early = waybackDescriptor({
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
})
const runtimeEpoch = SourceRuntimeEpoch('0f0f0f0f-0f0f-40f0-8f0f-0f0f0f0f0f0f')
const baseEpoch = NativeSourceEpoch('11111111-2222-4333-8444-555555555555')
const labelsEpoch = NativeSourceEpoch('99999999-8888-4777-8666-555555555555')
const earlyEpoch = NativeSourceEpoch('77777777-6666-4555-9444-333333333333')

function href(source, nativeEpoch, role, extra = {}) {
  const query = new URLSearchParams({
    sessionId: 'session-1',
    role,
    sourceId: source.id,
    configDigest: source.configDigest,
    runtimeEpoch,
    nativeEpoch,
    viewMode: 'map',
    viewWkid: '3857',
    ...extra,
  })
  return `/api/map/sources/resource?${query.toString()}`
}

function layer(source, nativeEpoch, role, extra = {}) {
  return {
    source,
    nativeEpoch,
    layerKind: role === 'imagery-overlay' ? 'wmts' : 'arcgis-tile',
    transport: 'controlled',
    resourceHref: href(source, nativeEpoch, role, role === 'imagery-overlay' ? { resource: 'wmts' } : extra),
  }
}

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runtimeEpoch,
    mode: 'map',
    engineWkid: 3857,
    basemap: layer(base, baseEpoch, 'basemap'),
    labels: layer(labels, labelsEpoch, 'labels'),
    earlyImagery: layer(early, earlyEpoch, 'imagery-overlay'),
    display: {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 0.45,
      earlyVisible: true,
    },
    ...overrides,
  }
}

test('render descriptor admits a fixed Wayback early overlay and its blend state', () => {
  const parsed = parseMapSourceRenderDescriptor(descriptor())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.earlyImagery.source.release.version, '10')
  assert.equal(parsed.value.earlyImagery.layerKind, 'wmts')
  assert.deepEqual(parsed.value.display, {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 0.45,
    earlyVisible: true,
  })
  const again = parseMapSourceRenderDescriptor(parsed.value)
  assert.deepEqual(again, parsed)
})

test('render descriptor rejects non-Wayback early overlays and incomplete display state', () => {
  assert.equal(parseMapSourceRenderDescriptor({
    ...descriptor(),
    earlyImagery: layer(base, earlyEpoch, 'imagery-overlay'),
  }).ok, false)
  assert.equal(parseMapSourceRenderDescriptor({
    ...descriptor(),
    display: { labelsVisible: true, recentVisible: true, recentOpacity: 1 },
  }).ok, false)
  assert.equal(parseMapSourceRenderDescriptor({
    ...descriptor(),
    display: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: true },
    earlyImagery: null,
  }).ok, false)
})

test('source render route publishes the selected fixed release as an overlay resource', async () => {
  const catalog = createMapSourceCatalog({
    presets: { 'esri-wayback': { enabled: true, screenshot: 'allowed', automatedMapUse: 'allowed' } },
  }, 'allow', {})
  const service = {
    catalog,
    runtimeEpoch,
    verifySource() {},
    async prepare(source) {
      if (source.id === 'esri-wayback') {
        return {
          transport: 'controlled',
          runtimeEpoch,
          nativeEpoch: earlyEpoch,
          source,
          native: { adapter: 'wmts', resolved: { source, endpoint: 'https://wayback.maptiles.arcgis.com' }, metadata: {} },
        }
      }
      if (source.id === 'amap-imagery-labels') {
        return {
          transport: 'controlled',
          runtimeEpoch,
          nativeEpoch: labelsEpoch,
          source,
          native: { adapter: 'xyz', resolved: { source, endpoint: source.endpoint }, metadata: null },
        }
      }
      return {
        transport: 'public-preset',
        runtimeEpoch,
        nativeEpoch: source.id === 'esri-world-imagery' ? baseEpoch : labelsEpoch,
        source,
        presetId: source.id,
      }
    },
  }
  const display = {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 0.45,
    earlyVisible: true,
    earlySource: early,
  }
  const route = createMapSourceRoutes(service, async () => ({
    basemap: catalog.selection('esri-world-imagery', 'amap-imagery-labels').value,
    imageryDisplay: display,
    mode: 'map',
    view: { center: [116, 39], zoom: 12, wkid: 4326 },
  }))
  const response = await route.fetch(new Request('http://owner.test/api/map/sources/render?sessionId=overlay'))
  const published = await response.json()
  assert.equal(response.status, 200, JSON.stringify(published))
  assert.equal(published.earlyImagery.source.release.version, '10')
  assert.equal(published.earlyImagery.layerKind, 'wmts')
  assert.match(published.earlyImagery.resourceHref, /role=imagery-overlay/u)
  assert.deepEqual(published.display, {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 0.45,
    earlyVisible: true,
  })
})
