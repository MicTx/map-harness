/**
 * Symbol-legend derivation fixtures: the workbench symbol face derives from
 * the first visible symbol-only layer through `legendOfSymbol` (block opacity
 * carried), stays out of the way whenever a classification style owns the
 * layer's legend, and ignores imagery, heatmap, and hidden layers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symbolLegendOf } from '../src/client/symbol-legend.ts'
import { symbolVersionOf } from '../../layers/src/index.ts'

/** One wire layer carrying a single symbol. */
function wireSymbol(overrides = {}) {
  const draft = {
    methodVersion: 'map-layers@1',
    presentation: 'single',
    point: { shape: 'square', color: '#e53935', sizePx: 12, opacity: 0.8, outlineColor: '#7f1d1d' },
    line: { color: '#1f77b4', widthPx: 2, pattern: 'dash', opacity: 0.5 },
    fill: { color: '#2ca02c', outlineColor: '#145214' },
  }
  return { ...draft, symbolVersion: symbolVersionOf(draft), ...overrides }
}

function wireOf(layers) {
  return {
    layers,
    view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    mode: 'map',
    aoi: null,
    revision: 1,
    operations: [],
    observationRequest: null,
  }
}

function wireLayer(id, extra = {}) {
  return {
    id,
    name: id,
    data: { type: 'FeatureCollection', features: [] },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    ...extra,
  }
}

test('a symbol-only layer derives one legend row per block with its opacity', () => {
  const face = symbolLegendOf(wireOf([wireLayer('roads', { name: 'Roads', symbol: wireSymbol() })]))
  assert.ok(face !== null)
  assert.equal(face.layerId, 'roads')
  assert.equal(face.title, 'Roads')
  assert.equal(face.symbolVersion, wireSymbol().symbolVersion)
  assert.deepEqual(face.rows.map(row => row.geometry), ['point', 'line', 'fill'])
  assert.equal(face.rows[0].opacity, 0.8)
  assert.equal(face.rows[0].outline, '#7f1d1d')
  assert.equal(face.rows[1].opacity, 0.5)
  assert.equal(face.rows[2].opacity, 1, 'an absent block opacity renders opaque')
})

test('a classified layer keeps the classification legend — no symbol face', () => {
  const styled = { ...wireLayer('zones', { symbol: wireSymbol() }), style: { styleVersion: 'sty-x@v1' } }
  assert.equal(symbolLegendOf(wireOf([styled])), null)
})

test('hidden, imagery, and heatmap layers never produce a single-symbol legend', () => {
  assert.equal(symbolLegendOf(wireOf([wireLayer('hidden', { symbol: wireSymbol(), visible: false })])), null)
  const imagery = wireLayer('tiles', { imagery: { methodVersion: 'map-layers@1', urlTemplate: 'https://t.example.org/{level}/{row}/{col}.png' } })
  assert.equal(symbolLegendOf(wireOf([imagery])), null)
  const heatmap = { methodVersion: 'map-layers@1', presentation: 'heatmap', symbolVersion: 'sym-h@v1', heatmap: { radiusPx: 24, ramp: 'viridis' } }
  assert.equal(symbolLegendOf(wireOf([wireLayer('hot', { symbol: heatmap })])), null)
})

test('the first qualifying layer wins and an earlier styled layer does not hide it', () => {
  const styled = { ...wireLayer('zones'), style: { styleVersion: 'sty-x@v1' } }
  const plain = wireLayer('plain')
  const face = symbolLegendOf(wireOf([styled, plain, wireLayer('symbols', { symbol: wireSymbol() })]))
  assert.equal(face?.layerId, 'symbols')
})

test('a semantic symbol legends its resolved blocks, captioned and narrowed to the data geometry', () => {
  const draft = { methodVersion: 'map-layers@1', presentation: 'single', semantic: 'water' }
  const symbol = { ...draft, symbolVersion: symbolVersionOf(draft) }
  const polygons = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} }],
  }
  const face = symbolLegendOf(wireOf([{ ...wireLayer('lakes'), data: polygons, symbol }]))
  assert.equal(face.semantic, 'water')
  assert.deepEqual(face.rows.map(row => row.geometry), ['fill'], 'only the family the data draws')
  assert.ok(face.rows[0].opacity < 1, 'water fills are translucent')
})

test('a layer without a symbol legends the semantic its name implies, captioned', () => {
  const face = symbolLegendOf(wireOf([wireLayer('河流')]))
  assert.equal(face.semantic, 'water')
  assert.equal(face.rows.find(row => row.geometry === 'line').color, '#3d9ad1')
  assert.equal(symbolLegendOf(wireOf([wireLayer('图层A')])), null)
})
