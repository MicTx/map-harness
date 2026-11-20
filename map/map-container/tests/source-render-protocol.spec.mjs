import test from 'node:test'
import assert from 'node:assert/strict'
import { createMapSourceCatalog } from '../src/sources.ts'
import {
  NativeSourceEpoch,
  PUBLIC_SOURCE_PRESETS,
  SourceRuntimeEpoch,
  parseMapSourceRenderDescriptor,
} from '../src/source-render-protocol.ts'

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const base = catalog.descriptorOf('esri-world-imagery')
const labels = catalog.descriptorOf('esri-world-boundaries-places')
const runtimeEpoch = SourceRuntimeEpoch('0f0f0f0f-0f0f-40f0-8f0f-0f0f0f0f0f0f')
const baseEpoch = NativeSourceEpoch('11111111-2222-4333-8444-555555555555')
const labelsEpoch = NativeSourceEpoch('99999999-8888-4777-8666-555555555555')

function href(source, nativeEpoch, overrides = {}) {
  const query = new URLSearchParams({
    sessionId: 'session-1',
    role: source.role,
    sourceId: source.id,
    configDigest: source.configDigest,
    runtimeEpoch,
    nativeEpoch,
    viewMode: 'map',
    viewWkid: '3857',
    ...overrides,
  })
  return `/api/map/sources/resource?${query.toString()}`
}

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runtimeEpoch,
    mode: 'map',
    engineWkid: 3857,
    basemap: {
      source: base,
      nativeEpoch: baseEpoch,
      layerKind: 'arcgis-tile',
      transport: 'controlled',
      resourceHref: href(base, baseEpoch),
    },
    labels: {
      source: labels,
      nativeEpoch: labelsEpoch,
      layerKind: 'arcgis-tile',
      transport: 'controlled',
      resourceHref: href(labels, labelsEpoch),
    },
    earlyImagery: null,
    display: {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
    },
    ...overrides,
  }
}

test('public Esri presets stay single-host on server.arcgisonline.com', () => {
  for (const id of ['esri-world-imagery', 'esri-world-boundaries-places']) {
    const preset = PUBLIC_SOURCE_PRESETS[id]
    assert.equal(new URL(preset.url).protocol, 'https:')
    assert.equal(new URL(preset.url).host, 'server.arcgisonline.com')
  }
  assert.equal(JSON.stringify(Object.values(PUBLIC_SOURCE_PRESETS)).includes('services.arcgisonline.com'), false,
    'no preset may point at the failing services host')
})

test('render descriptor round-trips without aliasing mutable input records', () => {
  const input = descriptor()
  const mutableSource = { ...input.basemap.source }
  input.basemap = { ...input.basemap, source: mutableSource }
  const parsed = parseMapSourceRenderDescriptor(input)
  assert.equal(parsed.ok, true)
  input.basemap.source.title = 'mutated'
  input.basemap.resourceHref = '/arbitrary'
  assert.equal(parsed.value.basemap.source.title, 'Esri World Imagery')
  assert.equal(parsed.value.basemap.resourceHref.startsWith('/api/map/sources/resource?'), true)
  const again = parseMapSourceRenderDescriptor(parsed.value)
  assert.deepEqual(again, parsed)
})

test('render descriptor rejects structure, identities and transport mismatches', () => {
  const cases = [
    descriptor({ extra: 1 }),
    descriptor({ schemaVersion: 2 }),
    descriptor({ runtimeEpoch: 'not-an-epoch' }),
    descriptor({ engineWkid: 0 }),
    descriptor({ basemap: { ...descriptor().basemap, nativeEpoch: 'not-an-epoch' } }),
    descriptor({ basemap: { ...descriptor().basemap, presetId: 'esri-world-imagery' } }),
    descriptor({ basemap: { ...descriptor().basemap, resourceHref: `https://host.test${href(base, baseEpoch)}` } }),
    descriptor({ basemap: { ...descriptor().basemap, resourceHref: `${href(base, baseEpoch)}#fragment` } }),
    descriptor({ basemap: { ...descriptor().basemap, resourceHref: href(base, baseEpoch, labelsEpoch) } }),
    descriptor({ basemap: { ...descriptor().basemap, layerKind: 'web-tile' } }),
    descriptor({ labels: { ...descriptor().basemap, source: base } }),
  ]
  for (const value of cases) {
    const parsed = parseMapSourceRenderDescriptor(value)
    assert.equal(parsed.ok, false, JSON.stringify(Object.keys(value)))
  }
})

test('render descriptor bounds the complete multibyte JSON payload before decoding', () => {
  const parsed = parseMapSourceRenderDescriptor(descriptor({ padding: '界'.repeat(25_000) }))
  assert.deepEqual(parsed, { ok: false, code: 'SOURCE_LIMIT_EXCEEDED' })
  assert.throws(() => SourceRuntimeEpoch('00000000-0000-0000-0000-000000000000'), TypeError)
  assert.throws(() => NativeSourceEpoch('00000000-0000-0000-0000-000000000000'), TypeError)
})
