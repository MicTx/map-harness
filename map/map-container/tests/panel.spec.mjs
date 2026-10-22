/**
 * Panel queue channel and derivation faces: the `[map-panel v1]` vocabulary
 * round-trips all four ops and refuses every negative shape with the stable
 * reasons; badges, legend chips, and attribute tables derive from the wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PANEL_MAX_REQUEST_BYTES,
  PANEL_MAX_REQUESTS_PER_TEXT,
  PANEL_MAX_STATE_ENTRIES,
  PANEL_TEXT_MARKER,
  PANEL_TEXT_VERSION,
  parsePanelRequestText,
  serializePanelRequestText,
} from '../src/client/panel-request.ts'

function messageOf(requests, overrides = {}) {
  return {
    version: PANEL_TEXT_VERSION,
    sessionId: 'session-1',
    occurrenceKey: 'occ-1',
    revision: 7,
    requests,
    at: '2026-10-19T12:00:00.000Z',
    ...overrides,
  }
}

const fourOps = [
  { id: 'pr-1', op: 'set-state', states: [{ id: 'layer-a', visible: false, opacity: 0.5, group: '基线' }] },
  { id: 'pr-2', op: 'set-state', states: [{ id: 'layer-a', visible: true }, { id: 'layer-b', group: 'analysis' }] },
  { id: 'pr-3', op: 'set-style', layer: 'layer-a', preset: 'marker-square-red-large' },
  { id: 'pr-4', op: 'remove', layer: 'layer-b' },
  { id: 'pr-5', op: 'export', layer: 'layer-a', format: 'shapefile' },
]

test('constants pin the wire contract', () => {
  assert.equal(PANEL_MAX_REQUEST_BYTES, 2048)
  assert.equal(PANEL_MAX_STATE_ENTRIES, 32)
  assert.equal(PANEL_MAX_REQUESTS_PER_TEXT, 32)
  assert.equal(PANEL_TEXT_MARKER, '[map-panel v1]')
})

test('all four ops round-trip through the wire text', () => {
  for (const request of fourOps) {
    const message = messageOf([request])
    const serialized = serializePanelRequestText(message)
    assert.equal(serialized.ok, true, `serialize should accept ${request.op}`)
    const parsed = parsePanelRequestText(serialized.text)
    assert.equal(parsed.ok, true, `parse should accept ${request.op}`)
    assert.deepEqual(parsed.message, message)
  }
})

test('a multi-request batch round-trips with its envelope intact', () => {
  const message = messageOf(fourOps)
  const serialized = serializePanelRequestText(message)
  assert.equal(serialized.ok, true)
  const parsed = parsePanelRequestText(serialized.text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.message, message)
})

test('foreign text is a quiet not-panel miss', () => {
  assert.deepEqual(parsePanelRequestText('普通用户消息'), { ok: false, reason: 'not-panel' })
  assert.deepEqual(parsePanelRequestText('[map-gesture v1]\n{}'), { ok: false, reason: 'not-panel' })
  assert.deepEqual(parsePanelRequestText(''), { ok: false, reason: 'not-panel' })
})

test('unknown versions report explicitly, marker damage stays invalid-payload', () => {
  assert.deepEqual(parsePanelRequestText('[map-panel v2]\n{}'), { ok: false, reason: 'unknown-version' })
  assert.deepEqual(parsePanelRequestText('[map-panel v99]\n{}'), { ok: false, reason: 'unknown-version' })
  assert.deepEqual(parsePanelRequestText('[map-panel v1] {}'), { ok: false, reason: 'invalid-payload' })
  assert.deepEqual(parsePanelRequestText('[map-panel v1]'), { ok: false, reason: 'invalid-payload' })
})

test('malformed payloads refuse as invalid-payload', () => {
  const cases = [
    `${PANEL_TEXT_MARKER}\nnot json`,
    `${PANEL_TEXT_MARKER}\n{}`,
    `${PANEL_TEXT_MARKER}\n{"s":"","o":"occ","rev":1,"r":[{"id":"pr-1","op":"remove","layer":"l"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":-1,"r":[{"id":"pr-1","op":"remove","layer":"l"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"rename","layer":"l"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"","op":"remove","layer":"l"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"remove"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"export","layer":"l","format":"xlsx"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"export","layer":"l","format":"GeoJSON"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"set-style","layer":"l","preset":"marker-nope"}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"set-state","states":[]}],"at":"2026-10-19T12:00:00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"set-state","states":[{"id":"l"}]}],"at":"2026-10-19T12:00:00.00.000Z"}`,
    `${PANEL_TEXT_MARKER}\n{"s":"s","o":"o","rev":1,"r":[{"id":"pr-1","op":"set-state","states":[{"id":"l"}]}],"at":"2026-10-19T12:00:00:000Z"}`,
  ]
  for (const text of cases) {
    assert.deepEqual(parsePanelRequestText(text), { ok: false, reason: 'invalid-payload' }, text)
  }
})

test('state entries refuse empty patches, duplicates, bad groups, and out-of-range opacity', () => {
  const stateCases = [
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l' }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', visible: true }, { id: 'l', opacity: 0.5 }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', group: '' }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', group: 'x'.repeat(65) }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', opacity: -0.1 }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', opacity: 1.5 }] },
    { id: 'pr-1', op: 'set-state', states: [{ id: 'l', visible: 'yes' }] },
  ]
  for (const request of stateCases) {
    const serialized = serializePanelRequestText(messageOf([request]))
    assert.deepEqual(serialized, { ok: false, reason: 'invalid' }, JSON.stringify(request.states))
  }
  const oversizedStates = Array.from({ length: PANEL_MAX_STATE_ENTRIES + 1 }, (_, at) => ({ id: `l${at}`, visible: true }))
  const tooMany = serializePanelRequestText(messageOf([{ id: 'pr-1', op: 'set-state', states: oversizedStates }]))
  assert.deepEqual(tooMany, { ok: false, reason: 'invalid' })
  const atCap = serializePanelRequestText(messageOf([{ id: 'pr-1', op: 'set-state', states: oversizedStates.slice(0, PANEL_MAX_STATE_ENTRIES) }]))
  assert.equal(atCap.ok, true)
})

test('request batches beyond the per-text bound refuse', () => {
  const requests = Array.from({ length: PANEL_MAX_REQUESTS_PER_TEXT + 1 }, (_, at) => ({ id: `pr-${at}`, op: 'remove', layer: `l${at}` }))
  assert.deepEqual(serializePanelRequestText(messageOf(requests)), { ok: false, reason: 'invalid' })
})

test('oversized texts are refused on both faces, never truncated', () => {
  const fatStates = Array.from({ length: PANEL_MAX_STATE_ENTRIES }, (_, at) => ({ id: `layer-${at}`, group: 'g'.repeat(64) }))
  const serialized = serializePanelRequestText(messageOf([{ id: 'pr-1', op: 'set-state', states: fatStates }]))
  assert.deepEqual(serialized, { ok: false, reason: 'oversized' })
  const huge = `${PANEL_TEXT_MARKER}\n${' '.repeat(PANEL_MAX_REQUEST_BYTES)}`
  assert.deepEqual(parsePanelRequestText(huge), { ok: false, reason: 'oversized' })
})

// ── panel derivation faces ───────────────────────────────────────────

import { buildStyle, featureIdOf, legendOf } from '../../spatial-viz/src/index.ts'
import { asSingleSymbol, legendOfSymbol, symbolVersionOf } from '../../layers/src/index.ts'
import {
  PANEL_ATTRIBUTE_CELL_CHARS,
  PANEL_MAX_ATTRIBUTE_COLUMNS,
  panelAttributesOf,
  panelBadgeOf,
  panelChipOf,
} from '../src/client/panel-view.ts'
import { zh, en } from '../src/client/locales.ts'

function wireLayer(overrides = {}) {
  return {
    id: 'l1',
    name: 'Layer',
    data: { type: 'FeatureCollection', features: [] },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    ...overrides,
  }
}

function symbolOf(draft) {
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

function classStyle() {
  return buildStyle({
    field: 'score', unit: '分', measure: 'total', encoding: 'fill',
    classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
  })
}

test('chips derive from the same authority functions the map renders through', () => {
  const symbol = symbolOf({
    methodVersion: 'map-layers@1',
    presentation: 'single',
    point: { shape: 'square', color: '#e53935', sizePx: 12, opacity: 0.8, outlineColor: '#7f1d1d' },
  })
  const symbolChip = panelChipOf(wireLayer({ symbol }))
  assert.equal(symbolChip.kind, 'symbol')
  const expectedRows = legendOfSymbol(asSingleSymbol(symbol)).rows
  assert.deepEqual(symbolChip.rows, expectedRows)
  assert.equal(symbolChip.symbolVersion, symbol.symbolVersion)

  const style = classStyle()
  const classChip = panelChipOf(wireLayer({ style }))
  assert.equal(classChip.kind, 'class')
  const expectedColors = legendOf(style).rows.filter(row => row.kind === 'class').map(row => row.color)
  assert.deepEqual(classChip.colors, expectedColors)
  assert.equal(classChip.styleVersion, style.styleVersion)

  const heatmap = symbolOf({ methodVersion: 'map-layers@1', presentation: 'heatmap', heatmap: { radiusPx: 24, ramp: 'viridis' } })
  const heatChip = panelChipOf(wireLayer({ symbol: heatmap }))
  assert.equal(heatChip.kind, 'heatmap')
  assert.equal(heatChip.ramp, 'viridis')
  assert.equal(heatChip.stops[0], '#440154')

  assert.equal(panelChipOf(wireLayer({ imagery: { methodVersion: 'map-layers@1', urlTemplate: 'https://example.invalid/{level}/{row}/{col}' } })), null)
  assert.equal(panelChipOf(wireLayer()), null)
})

test('a semantic symbol badges from the data geometry and chips its resolved family', () => {
  const symbol = symbolOf({ methodVersion: 'map-layers@1', presentation: 'single', semantic: 'route' })
  const lines = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} }] }
  const layer = wireLayer({ symbol, data: lines })
  assert.equal(panelBadgeOf(layer), 'line')
  const chip = panelChipOf(layer)
  assert.deepEqual(chip.rows.map(row => row.geometry), ['line'])
  assert.equal(chip.rows[0].color, '#1f6feb')
})

test('badges derive imagery, heatmap, thematic, symbols, then data geometry', () => {
  assert.equal(panelBadgeOf(wireLayer({ imagery: { methodVersion: 'map-layers@1', urlTemplate: 'https://example.invalid/{level}/{row}/{col}' } })), 'imagery')
  assert.equal(panelBadgeOf(wireLayer({ symbol: symbolOf({ methodVersion: 'map-layers@1', presentation: 'heatmap', heatmap: { radiusPx: 24, ramp: 'reds' } }) })), 'heatmap')
  assert.equal(panelBadgeOf(wireLayer({ style: classStyle() })), 'thematic')
  assert.equal(panelBadgeOf(wireLayer({ symbol: symbolOf({ methodVersion: 'map-layers@1', presentation: 'single', line: { color: '#1f77b4', widthPx: 2, pattern: 'solid' } }) })), 'line')
  assert.equal(panelBadgeOf(wireLayer({
    data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} }] },
  })), 'polygon')
  assert.equal(panelBadgeOf(wireLayer()), 'data')
})

test('attribute tables are bounded, typed, and empty-state honest', () => {
  const features = [
    { type: 'Feature', id: 'a', geometry: null, properties: { x: 1, name: 'Alpha' } },
    { type: 'Feature', id: 'b', geometry: null, properties: { name: 'Beta', y: 2 } },
    { type: 'Feature', geometry: null },
  ]
  const face = panelAttributesOf(wireLayer({ data: { type: 'FeatureCollection', features } }))
  assert.deepEqual(face.columns, ['x', 'name', 'y'])
  assert.deepEqual(face.rows.map(row => row.id), ['a', 'b', featureIdOf(features[2], 2)])
  assert.deepEqual(face.rows[0].cells, ['1', 'Alpha', ''])
  assert.deepEqual(face.rows[2].cells, ['', '', ''])
  assert.equal(face.empty, false)
  assert.equal(face.columnOverflow, 0)
  assert.equal(face.rowOverflow, 0)

  // Column bound: 16 keys show 12 and count the overflow.
  const wide = {
    type: 'Feature', id: 'w', geometry: null,
    properties: Object.fromEntries(Array.from({ length: 16 }, (_, at) => [`k${at}`, at])),
  }
  const wideFace = panelAttributesOf(wireLayer({ data: { type: 'FeatureCollection', features: [wide] } }))
  assert.equal(wideFace.columns.length, PANEL_MAX_ATTRIBUTE_COLUMNS)
  assert.equal(wideFace.columnOverflow, 4)

  // Value truncation.
  const long = { type: 'Feature', id: 'l', geometry: null, properties: { text: 'x'.repeat(60) } }
  const longFace = panelAttributesOf(wireLayer({ data: { type: 'FeatureCollection', features: [long] } }))
  assert.equal(longFace.rows[0].cells[0].length, PANEL_ATTRIBUTE_CELL_CHARS + 1)
  assert.ok(longFace.rows[0].cells[0].endsWith('…'))

  // Row bound: 5001 features keep 5000 and count one.
  const many = Array.from({ length: 5001 }, (_, at) => ({ type: 'Feature', geometry: null, properties: { n: at } }))
  const manyFace = panelAttributesOf(wireLayer({ data: { type: 'FeatureCollection', features: many } }))
  assert.equal(manyFace.rows.length, 5000)
  assert.equal(manyFace.rowOverflow, 1)

  // Empty state: zero features and imagery layers.
  assert.equal(panelAttributesOf(wireLayer()).empty, true)
  assert.equal(panelAttributesOf(wireLayer({ imagery: { methodVersion: 'map-layers@1', urlTemplate: 'https://example.invalid/{level}/{row}/{col}' } })).empty, true)
})

test('panel locale dictionaries keep one key set across zh and en', () => {
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)
  assert.deepEqual(new Set(zhKeys), new Set(enKeys))
  assert.equal(zhKeys.length, enKeys.length)
  const panelKeys = zhKeys.filter(key => key.startsWith('panel.'))
  assert.ok(panelKeys.length >= 60, `expected the panel vocabulary, got ${panelKeys.length}`)
  for (const key of panelKeys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en missing ${key}`)
  }
})
