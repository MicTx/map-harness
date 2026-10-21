/**
 * Palette determinism fixtures: the auto palette itself (distinct valid
 * colors), `autoSymbolOf` stability across calls and processes (same id,
 * same color), outline shading, and the validity of every derived symbol.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_FILL_OPACITY,
  AUTO_MARKER_SIZE_PX,
  AUTO_PALETTE,
  autoColorIndexOf,
  autoColorOf,
  autoSymbolOf,
  shadeOf,
  symbolVersionOf,
  validateSymbolStyle,
} from '../src/index.ts'

/** Twelve representative layer ids covering every palette slot. */
const TWELVE_LAYERS = [
  'rivers',
  'warehouses',
  'libraries',
  'landuse',
  'schools',
  'flood-zones',
  'charging-stations',
  'rail-freight',
  'terrain-contours',
  'bus-stops',
  'hospitals',
  'roads-primary',
]

test('the auto palette carries twelve distinct, valid hex colors', () => {
  assert.equal(AUTO_PALETTE.length, 12)
  assert.equal(new Set(AUTO_PALETTE).size, 12)
  for (const color of AUTO_PALETTE) assert.match(color, /^#[0-9a-f]{6}$/)
})

test('the same layer id always resolves to the same color', () => {
  for (const layerId of TWELVE_LAYERS) {
    const first = autoColorOf(layerId)
    const second = autoColorOf(layerId)
    assert.equal(first.color, second.color)
    assert.equal(first.outline, second.outline)
    const third = JSON.parse(JSON.stringify(autoSymbolOf(layerId)))
    assert.deepEqual(autoSymbolOf(layerId), third)
  }
})

test('twelve representative layers occupy twelve distinct palette slots', () => {
  const slots = TWELVE_LAYERS.map(layerId => autoColorIndexOf(layerId))
  assert.equal(new Set(slots).size, 12, `slots must be distinct: ${JSON.stringify(slots)}`)
  const colors = TWELVE_LAYERS.map(layerId => autoColorOf(layerId).color)
  assert.equal(new Set(colors).size, 12)
})

test('palette indices stay in range and shading darkens deterministically', () => {
  for (const layerId of [...TWELVE_LAYERS, '', 'ünicode-id', 'x'.repeat(500)]) {
    const index = autoColorIndexOf(layerId)
    assert.ok(index >= 0 && index < AUTO_PALETTE.length)
    assert.ok(Number.isInteger(index))
  }
  const dark = shadeOf('#ffffff', 0.5)
  assert.equal(dark, '#808080')
  assert.equal(shadeOf('#000000', 0.5), '#000000')
  assert.equal(shadeOf('#4264fb', 0.7), shadeOf('#4264fb', 0.7))
})

test('auto symbols validate, carry translucent fills, and version-consistently', () => {
  for (const layerId of TWELVE_LAYERS) {
    const symbol = autoSymbolOf(layerId)
    assert.deepEqual(validateSymbolStyle(symbol), [], `auto symbol for ${layerId} must be valid`)
    assert.equal(symbol.presentation, 'single')
    assert.equal(symbol.point.opacity, undefined)
    assert.equal(symbol.line.opacity, undefined)
    assert.equal(symbol.fill.opacity, AUTO_FILL_OPACITY, 'auto fills are translucent')
    assert.equal(symbol.point.sizePx, AUTO_MARKER_SIZE_PX)
    assert.equal(symbol.symbolVersion, symbolVersionOf(symbol))
    const { color, outline } = autoColorOf(layerId)
    assert.equal(symbol.point.color, color)
    assert.equal(symbol.point.outlineColor, '#ffffff', 'auto markers wear a white halo')
    assert.equal(symbol.fill.outlineColor, outline)
    assert.equal(symbol.fill.color, color)
    assert.equal(symbol.line.color, color)
  }
})

test('auto symbols stay stable across process-shaped key orders', () => {
  const direct = autoSymbolOf('hospitals')
  const rebuilt = {
    methodVersion: direct.methodVersion,
    presentation: direct.presentation,
    line: direct.line,
    fill: direct.fill,
    point: direct.point,
  }
  assert.equal(symbolVersionOf(rebuilt), direct.symbolVersion)
})
