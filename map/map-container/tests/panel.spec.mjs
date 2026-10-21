/**
 * Panel write channel, protocol half: the `[map-panel v1]` vocabulary
 * round-trips all four ops, refuses every negative shape with the stable
 * reasons, and the pending book walks its full path space — target-matched
 * settle, latest-wins supersede, moot clearing, TTL expiry, capacity
 * overflow, and the preset-derived symbol-version match.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PANEL_MAX_REQUEST_BYTES,
  PANEL_MAX_REQUESTS_PER_TEXT,
  PANEL_MAX_STATE_ENTRIES,
  PANEL_PENDING_CAPACITY,
  PANEL_PENDING_TTL_MS,
  PANEL_TEXT_MARKER,
  PANEL_TEXT_VERSION,
  emptyPendingBook,
  clearMootEntries,
  expirePending,
  hasPendingFor,
  parsePanelRequestText,
  recordRequest,
  serializePanelRequestText,
  settlePending,
} from '../src/client/panel-request.ts'
import { resolveSymbolPreset } from '../../layers/src/index.ts'

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
  assert.equal(PANEL_PENDING_TTL_MS, 120_000)
  assert.equal(PANEL_PENDING_CAPACITY, 32)
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

function wireOf(layers) {
  return { layers }
}

test('set-state settle clears on per-field target match and keeps mismatches', () => {
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'set-state', states: [{ id: 'l1', visible: false, opacity: 0.5, group: 'g1' }] }, 0)
  assert.equal(book.entries.length, 3)
  // Nothing matches yet.
  let settled = settlePending(book, wireOf([{ id: 'l1', visible: true, opacity: 1, group: 'g0' }]))
  assert.equal(settled.entries.length, 3)
  // One field reaches its target: only that entry clears.
  settled = settlePending(book, wireOf([{ id: 'l1', visible: false, opacity: 1, group: 'g0' }]))
  assert.deepEqual(settled.entries.map(entry => entry.field).sort(), ['group', 'opacity'])
  // All fields reach their targets: the request fully settles.
  settled = settlePending(book, wireOf([{ id: 'l1', visible: false, opacity: 0.5, group: 'g1' }]))
  assert.equal(settled.entries.length, 0)
})

test('supersede merges latest-wins per layer and field, different fields coexist', () => {
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'set-state', states: [{ id: 'l1', visible: true }] }, 0)
  book = recordRequest(book, { id: 'pr-2', op: 'set-state', states: [{ id: 'l1', visible: false }] }, 10)
  assert.equal(book.entries.length, 1)
  const entry = book.entries[0]
  assert.equal(entry.field, 'visible')
  assert.equal(entry.value, false)
  assert.equal(entry.requestId, 'pr-2')
  assert.equal(entry.recordedAt, 10)
  // A different field of the same layer coexists.
  book = recordRequest(book, { id: 'pr-3', op: 'set-state', states: [{ id: 'l1', opacity: 0.25 }] }, 20)
  assert.equal(book.entries.length, 2)
  // The stale target survives an old-target wire: only the newest clears.
  const settled = settlePending(book, wireOf([{ id: 'l1', visible: true, opacity: 0.25 }]))
  assert.deepEqual(settled.entries.map(e => e.field), ['visible'])
})

test('set-style settle matches the preset-local symbolVersion derivation', () => {
  const preset = resolveSymbolPreset('preset:fill-translucent-orange')
  assert.notEqual(preset, undefined)
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'set-style', layer: 'l1', preset: 'fill-translucent-orange' }, 0)
  assert.equal(book.entries.length, 1)
  const style = book.entries[0]
  assert.equal(style.kind, 'set-style')
  assert.equal(style.expectedSymbolVersion, preset.symbol.symbolVersion)
  // A different symbol version keeps the entry pending.
  let settled = settlePending(book, wireOf([{ id: 'l1', visible: true, opacity: 1, symbol: { symbolVersion: 'sym-other@v1' } }]))
  assert.equal(settled.entries.length, 1)
  // The wire reaching the preset-expanded version settles it.
  settled = settlePending(book, wireOf([{ id: 'l1', visible: true, opacity: 1, symbol: { symbolVersion: preset.symbol.symbolVersion } }]))
  assert.equal(settled.entries.length, 0)
  // A new set-style for the same layer supersedes the old expectation.
  book = recordRequest(book, { id: 'pr-1', op: 'set-style', layer: 'l1', preset: 'fill-translucent-orange' }, 0)
  book = recordRequest(book, { id: 'pr-2', op: 'set-style', layer: 'l1', preset: 'heatmap-viridis' }, 5)
  assert.equal(book.entries.length, 1)
  const replaced = book.entries[0]
  assert.equal(replaced.expectedSymbolVersion, resolveSymbolPreset('heatmap-viridis').symbol.symbolVersion)
})

test('remove settles on layer absence and export requests book nothing', () => {
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'export', layer: 'l1', format: 'geojson' }, 0)
  assert.equal(book.entries.length, 0)
  assert.equal(hasPendingFor(book, 'l1'), false)
  book = recordRequest(book, { id: 'pr-2', op: 'remove', layer: 'l1' }, 0)
  assert.equal(hasPendingFor(book, 'l1'), true)
  let settled = settlePending(book, wireOf([{ id: 'l1', visible: true, opacity: 1 }]))
  assert.equal(settled.entries.length, 1)
  settled = settlePending(book, wireOf([{ id: 'l2', visible: true, opacity: 1 }]))
  assert.equal(settled.entries.length, 0)
})

test('moot clearing drops unreachable state and style entries for missing layers', () => {
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'set-state', states: [{ id: 'gone', visible: false }] }, 0)
  book = recordRequest(book, { id: 'pr-2', op: 'set-style', layer: 'gone', preset: 'line-solid-blue' }, 0)
  book = recordRequest(book, { id: 'pr-3', op: 'set-state', states: [{ id: 'kept', group: 'g' }] }, 0)
  book = recordRequest(book, { id: 'pr-4', op: 'remove', layer: 'kept' }, 0)
  const cleared = clearMootEntries(book, wireOf([{ id: 'kept', visible: true, opacity: 1 }]))
  assert.deepEqual(cleared.entries.map(entry => entry.layerId), ['kept', 'kept'])
  assert.deepEqual(cleared.entries.map(entry => entry.kind).sort(), ['remove', 'set-state'])
})

test('TTL expiry returns expired entries and clears them at the boundary', () => {
  let book = emptyPendingBook()
  book = recordRequest(book, { id: 'pr-1', op: 'set-state', states: [{ id: 'l1', visible: false }] }, 1_000)
  const before = expirePending(book, 1_000 + PANEL_PENDING_TTL_MS - 1)
  assert.equal(before.book.entries.length, 1)
  assert.equal(before.expired.length, 0)
  const atBoundary = expirePending(book, 1_000 + PANEL_PENDING_TTL_MS)
  assert.equal(atBoundary.book.entries.length, 0)
  assert.equal(atBoundary.expired.length, 1)
  assert.equal(atBoundary.expired[0].layerId, 'l1')
})

test('book capacity drops the oldest entries and counts them', () => {
  let book = emptyPendingBook()
  for (let at = 0; at < PANEL_PENDING_CAPACITY + 3; at++) {
    book = recordRequest(book, { id: `pr-${at}`, op: 'set-state', states: [{ id: `l${at}`, visible: true }] }, at)
  }
  assert.equal(book.entries.length, PANEL_PENDING_CAPACITY)
  assert.equal(book.droppedOverflow, 3)
  // The oldest three layers were dropped; the newest entry survives.
  assert.equal(hasPendingFor(book, 'l0'), false)
  assert.equal(hasPendingFor(book, 'l1'), false)
  assert.equal(hasPendingFor(book, 'l2'), false)
  assert.equal(hasPendingFor(book, `l${PANEL_PENDING_CAPACITY + 2}`), true)
  const first = book.entries[0]
  assert.equal(first.layerId, 'l3')
  // Settling and expiring preserve the overflow counter.
  const settled = settlePending(book, wireOf([]))
  assert.equal(settled.droppedOverflow, 3)
  const expired = expirePending(book, 10_000 * PANEL_PENDING_TTL_MS)
  assert.equal(expired.book.droppedOverflow, 3)
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
  panelFaceMatches,
  panelGroupsOf,
  panelSearchTokensOf,
} from '../src/client/panel-view.ts'
import { zh, en } from '../src/client/locales.ts'
import { syncPendingBook } from '../src/client/panel-request.ts'

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

test('panel groups render in first-appearance order with the ungrouped section last', () => {
  const a = wireLayer({ id: 'a', name: 'A', group: 'b' })
  const b = wireLayer({ id: 'b', name: 'B', group: 'a' })
  const c = wireLayer({ id: 'c', name: 'C' })
  const d = wireLayer({ id: 'd', name: 'D', group: 'b' })
  const groups = panelGroupsOf(wireOf([a, b, c, d]), '')
  assert.equal(groups.length, 3)
  assert.equal(groups[0].name, 'b')
  assert.deepEqual(groups[0].layers.map(layer => layer.id), ['a', 'd'])
  assert.equal(groups[1].name, 'a')
  assert.deepEqual(groups[1].layers.map(layer => layer.id), ['b'])
  assert.equal(groups[2].name, null)
  assert.deepEqual(groups[2].layers.map(layer => layer.id), ['c'])
})

test('search matches any token against name, id, group, badge key, and badge label', () => {
  const named = wireLayer({ id: 'zones', name: 'Zone A' })
  const grouped = wireLayer({ id: 'pts', name: 'Points', group: 'basemaps' })
  const heat = wireLayer({ id: 'h1', name: 'H', symbol: symbolOf({ methodVersion: 'map-layers@1', presentation: 'heatmap', heatmap: { radiusPx: 24, ramp: 'viridis' } }) })
  const wire = wireOf([named, grouped, heat])
  assert.equal(panelGroupsOf(wire, 'zone').reduce((sum, group) => sum + group.layers.length, 0), 1)
  assert.equal(panelGroupsOf(wire, 'basemaps').reduce((sum, group) => sum + group.layers.length, 0), 1)
  // Multi-word OR: each token selects independently.
  assert.equal(panelGroupsOf(wire, 'zone heatmap').reduce((sum, group) => sum + group.layers.length, 0), 2)
  // Badge keys match; localized labels match only when supplied.
  assert.equal(panelGroupsOf(wire, 'heatmap').reduce((sum, group) => sum + group.layers.length, 0), 1)
  assert.equal(panelGroupsOf(wire, '热力').reduce((sum, group) => sum + group.layers.length, 0), 0)
  const withLabels = panelGroupsOf(wire, '热力', { heatmap: '热力' })
  assert.equal(withLabels.reduce((sum, group) => sum + group.layers.length, 0), 1)
  assert.deepEqual(panelSearchTokensOf('  Zone   HEAT '), ['zone', 'heat'])
  assert.equal(panelFaceMatches(panelGroupsOf(wireOf([named]), '')[0].layers[0], []), true)
  assert.equal(panelGroupsOf(wire, 'nomatch').length, 0)
})

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

test('the pending book wiring settles on wire truth and clears moot targets', () => {
  const withBoth = [{ id: 'l1', visible: true, opacity: 1 }, { id: 'l2', visible: true, opacity: 1 }]
  let book = recordRequest(emptyPendingBook(), { id: 'pr-1', op: 'set-state', states: [{ id: 'l1', visible: false }] }, 0)
  book = recordRequest(book, { id: 'pr-2', op: 'remove', layer: 'l2' }, 0)
  assert.equal(book.entries.length, 2)
  // Nothing reached yet: both stay.
  let synced = syncPendingBook(book, wireOf(withBoth))
  assert.equal(synced.entries.length, 2)
  // The state target lands: only that entry clears.
  synced = syncPendingBook(book, wireOf([{ id: 'l1', visible: false, opacity: 1 }, { id: 'l2', visible: true, opacity: 1 }]))
  assert.equal(synced.entries.length, 1)
  assert.equal(synced.entries[0].kind, 'remove')
  // The removed layer leaves the wire: the removal settles (absence is success, not moot).
  const removed = syncPendingBook(book, wireOf([{ id: 'l1', visible: true, opacity: 1 }]))
  assert.deepEqual(removed.entries.map(entry => entry.kind), ['set-state'])
  // A booked state whose layer vanishes is moot, not satisfied.
  let mootBook = recordRequest(emptyPendingBook(), { id: 'pr-3', op: 'set-state', states: [{ id: 'l2', opacity: 0.3 }] }, 0)
  mootBook = syncPendingBook(mootBook, wireOf([{ id: 'l1', visible: true, opacity: 1 }]))
  assert.equal(mootBook.entries.length, 0)
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
