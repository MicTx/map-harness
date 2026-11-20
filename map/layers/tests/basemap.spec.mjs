import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BasemapSourceId,
  ESRI_WORLD_IMAGERY_ATTRIBUTION,
  ESRI_WORLD_REFERENCE_ATTRIBUTION,
  LEGACY_ESRI_WORLD_IMAGERY_ATTRIBUTION,
  basemapPairCompatible,
  canonicalSourceWkid,
  createBasemapSelection,
  isValidSourceDate,
  parseBasemapSelection,
  parseBasemapSource,
  sourceCompatibleWithView,
} from '../src/index.ts'

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'esri-world-imagery',
    title: 'Imagery',
    provider: 'esri',
    role: 'basemap',
    adapter: 'arcgis-mapserver',
    configDigest: 'a'.repeat(64),
    nativeWkid: 3857,
    supportsDynamicExport: true,
    supportedModes: ['map', 'scene'],
    minZoom: 0,
    maxZoom: 30,
    compatibleBasemapIds: [],
    attribution: 'Attribution',
    release: { version: null, publishedAt: null, acquiredAt: null },
    screenshot: 'unverified',
    automatedMapUse: 'unverified',
    availability: { kind: 'configured' },
    ...overrides,
  }
}

test('valid strict source parses with a branded identifier and a fresh descriptor', () => {
  const input = source()
  const result = parseBasemapSource(input)
  assert.equal(result.ok, true)
  assert.equal(result.value.id, BasemapSourceId('esri-world-imagery'))
  assert.notEqual(result.value, input)
  assert.notEqual(result.value.supportedModes, input.supportedModes)
  assert.throws(() => BasemapSourceId('INVALID id'), /invalid BasemapSourceId/)
})

test('unknown versions, unknown keys, and malformed source data are distinct refusals', () => {
  assert.deepEqual(parseBasemapSource(source({ schemaVersion: 2 })), { ok: false, code: 'SOURCE_VERSION_UNSUPPORTED' })
  assert.deepEqual(parseBasemapSource(source({ title: '' })), { ok: false, code: 'SOURCE_RESOURCE_DENIED' })
  assert.deepEqual(parseBasemapSource({ ...source(), injected: true }), { ok: false, code: 'SOURCE_RESOURCE_DENIED' })
})

test('finite zoom, positive WKID, and valid mode bounds are required', () => {
  for (const bounds of [
    { minZoom: Number.NaN },
    { maxZoom: Number.POSITIVE_INFINITY },
    { minZoom: -1 },
    { minZoom: 12, maxZoom: 11 },
    { maxZoom: 31 },
    { nativeWkid: 0 },
  ]) assert.equal(parseBasemapSource(source(bounds)).ok, false)
  assert.equal(parseBasemapSource(source({ supportedModes: ['map', 'map'] })).ok, false)
  assert.equal(parseBasemapSource(source({ supportedModes: [] })).ok, false)
})

test('compatibility identifiers are unique and match source roles', () => {
  assert.equal(parseBasemapSource(source({ compatibleBasemapIds: ['base', 'base'] })).ok, false)
  assert.equal(parseBasemapSource(source({ compatibleBasemapIds: ['base'] })).ok, false)
  assert.equal(parseBasemapSource(source({ role: 'labels', compatibleBasemapIds: [] })).ok, false)
})

test('label pairing admits its compatible base and rejects another base', () => {
  const base = parseBasemapSource(source()).value
  const labels = parseBasemapSource(source({
    id: 'esri-world-boundaries-places', role: 'labels', adapter: 'arcgis-mapserver',
    compatibleBasemapIds: ['esri-world-imagery'],
  })).value
  const selection = createBasemapSelection(base, labels)
  assert.equal(selection.ok, true)
  assert.equal(selection.value.labels.id, labels.id)
  assert.deepEqual(createBasemapSelection(base, parseBasemapSource(source({
    id: 'other-labels', role: 'labels', adapter: 'xyz', supportsDynamicExport: false, compatibleBasemapIds: ['other-base'],
  })).value), { ok: false, code: 'SOURCE_COMBINATION_UNSUPPORTED' })
  assert.deepEqual(createBasemapSelection(labels, null), { ok: false, code: 'SOURCE_COMBINATION_UNSUPPORTED' })
})

test('unavailable sources remain parseable but cannot form a selection', () => {
  const missing = parseBasemapSource(source({
    id: 'tianditu-img-w', provider: 'tianditu',
    availability: { kind: 'unavailable', reason: 'missing-credential' },
  })).value
  const disabled = parseBasemapSource(source({
    availability: { kind: 'unavailable', reason: 'disabled' },
  })).value
  assert.deepEqual(createBasemapSelection(missing, null), { ok: false, code: 'SOURCE_NOT_CONFIGURED' })
  assert.deepEqual(createBasemapSelection(disabled, null), { ok: false, code: 'SOURCE_UNAVAILABLE' })
})

test('release dates are nullable or real calendar dates and UTC timestamps', () => {
  assert.equal(parseBasemapSource(source({
    release: { version: 'v1', publishedAt: '2024-02-29', acquiredAt: '2024-02-29T23:59:59.125Z' },
  })).ok, true)
  for (const release of [
    { version: null, publishedAt: '2023-02-29', acquiredAt: null },
    { version: null, publishedAt: null, acquiredAt: '2024-02-30T00:00:00Z' },
    { version: null, publishedAt: null, acquiredAt: '2024-01-01T24:00:00Z' },
    { version: null, publishedAt: null, acquiredAt: '2024-01-01T00:00:00+01:00' },
  ]) assert.equal(parseBasemapSource(source({ release })).ok, false)
  const nulls = parseBasemapSource(source({ release: { version: null, publishedAt: null, acquiredAt: null } }))
  assert.deepEqual(nulls.value.release, { version: null, publishedAt: null, acquiredAt: null })
})

test('calendar validation handles early leap years without Date.UTC year coercion', () => {
  for (const date of ['0000-02-29', '0000-02-29T23:59:59.123456789Z', '0096-02-29', '2024-02-29']) {
    assert.equal(isValidSourceDate(date), true)
  }
  for (const date of [
    '0001-02-29', '1900-02-29', '2023-02-29', '2024-02-30',
    '2024-00-01', '2024-13-01', '2024-01-00',
    '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z',
  ]) assert.equal(isValidSourceDate(date), false)
})

test('pair capabilities require shared mode, zoom, and native or dynamic projection', () => {
  const base = parseBasemapSource(source({
    adapter: 'xyz', supportsDynamicExport: false, supportedModes: ['map'], maxZoom: 12,
  })).value
  const label = overrides => parseBasemapSource(source({
    id: 'labels', role: 'labels', compatibleBasemapIds: [base.id],
    adapter: 'wmts', supportsDynamicExport: false, ...overrides,
  })).value
  for (const labels of [
    label({ supportedModes: ['scene'] }),
    label({ minZoom: 13 }),
    label({ nativeWkid: 4547 }),
  ]) {
    assert.equal(basemapPairCompatible(base, labels), false)
    assert.deepEqual(createBasemapSelection(base, labels), { ok: false, code: 'SOURCE_COMBINATION_UNSUPPORTED' })
  }
  for (const nativeWkid of [102100, 102113, 900913]) {
    assert.equal(basemapPairCompatible(base, label({ nativeWkid })), true)
    assert.equal(canonicalSourceWkid(nativeWkid), 3857)
  }
  assert.equal(canonicalSourceWkid(4547), 4547)
  const dynamic = label({ adapter: 'arcgis-mapserver', supportsDynamicExport: true, nativeWkid: 4547 })
  assert.equal(basemapPairCompatible(base, dynamic), true)
  assert.equal(createBasemapSelection(base, dynamic).ok, true)
})

test('missing credentials do not change a pair capability declaration', () => {
  const base = parseBasemapSource(source({
    availability: { kind: 'unavailable', reason: 'missing-credential' },
  })).value
  const labels = parseBasemapSource(source({
    id: 'labels', role: 'labels', compatibleBasemapIds: [base.id],
  })).value
  assert.equal(basemapPairCompatible(base, labels), true)
  assert.deepEqual(createBasemapSelection(base, labels), { ok: false, code: 'SOURCE_NOT_CONFIGURED' })
})

test('current source credits remain separate from immutable historical image credits', () => {
  assert.equal(LEGACY_ESRI_WORLD_IMAGERY_ATTRIBUTION, 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community')
  assert.equal(ESRI_WORLD_IMAGERY_ATTRIBUTION, 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community')
  assert.equal(ESRI_WORLD_REFERENCE_ATTRIBUTION, 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community')
})

test('parse and selection creation do not mutate caller-owned input', () => {
  const descriptor = source()
  const selection = { schemaVersion: 1, basemap: descriptor, labels: null }
  const before = structuredClone(selection)
  const parsed = parseBasemapSelection(selection)
  assert.equal(parsed.ok, true)
  assert.deepEqual(selection, before)
  parsed.value.basemap.supportedModes.push('map')
  assert.deepEqual(selection, before)
})

test('view compatibility accepts aliases and ArcGIS dynamic export for map and local scene', () => {
  const base = parseBasemapSource(source()).value
  for (const wkid of [3857, 102100, 102113, 900913]) {
    assert.equal(sourceCompatibleWithView(base, { mode: 'map', wkid, zoom: 10 }), true)
  }
  assert.equal(sourceCompatibleWithView(base, { mode: 'scene', wkid: 3857, zoom: 10 }), true)
  assert.equal(sourceCompatibleWithView(base, { mode: 'scene', wkid: 4547, zoom: 10 }), true)
  assert.equal(sourceCompatibleWithView(base, { mode: 'map', wkid: 4547, zoom: 10 }), true)
  assert.equal(sourceCompatibleWithView(base, { mode: 'map', wkid: 3857, zoom: null }), false)
  assert.equal(sourceCompatibleWithView(base, { mode: 'scene', wkid: 3857, zoom: 31 }), false)
  assert.equal(sourceCompatibleWithView(base, { mode: 'map', wkid: 3857, zoom: 10 }), true)
})

test('fixed XYZ and WMTS cannot claim dynamic export or arbitrary projected display', () => {
  for (const adapter of ['xyz', 'wmts']) {
    const fixed = parseBasemapSource(source({ adapter, supportsDynamicExport: false, supportedModes: ['map', 'scene'] })).value
    assert.equal(sourceCompatibleWithView(fixed, { mode: 'map', wkid: 4547, zoom: 10 }), false)
    assert.equal(sourceCompatibleWithView(fixed, { mode: 'scene', wkid: 4547, zoom: 10 }), false)
    assert.equal(parseBasemapSource(source({ adapter, supportsDynamicExport: true })).ok, false)
  }
  const mapOnly = parseBasemapSource(source({ supportedModes: ['map'] })).value
  assert.equal(sourceCompatibleWithView(mapOnly, { mode: 'scene', wkid: 3857, zoom: 10 }), false)
})
