/**
 * Semantic symbol table fixtures: every word resolves to valid, distinct
 * blocks; explicit blocks win per geometry family; the legend reads the
 * resolved blocks and narrows to the data's geometry families.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURE_SEMANTICS,
  LAYERS_METHOD_VERSION,
  SEMANTIC_HALO_COLOR,
  legendOfSymbol,
  resolveSingleSymbol,
  semanticBlocksOf,
  symbolVersionOf,
  validateSymbolStyle,
} from '../src/index.ts'

function versioned(draft) {
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

test('every semantic resolves to a valid block set with a distinct hue', () => {
  const hues = new Set()
  for (const semantic of FEATURE_SEMANTICS) {
    const blocks = semanticBlocksOf(semantic)
    const draft = { methodVersion: LAYERS_METHOD_VERSION, presentation: 'single', ...blocks }
    assert.deepEqual(validateSymbolStyle(versioned(draft)), [], semantic)
    assert.equal(blocks.point.outlineColor, SEMANTIC_HALO_COLOR, `${semantic} markers wear the halo`)
    assert.ok((blocks.fill.opacity ?? 1) < 0.5, `${semantic} fills stay translucent`)
    hues.add(blocks.point.color)
  }
  assert.equal(hues.size, FEATURE_SEMANTICS.length)
})

test('explicit blocks replace the semantic block of their family only', () => {
  const symbol = versioned({
    methodVersion: LAYERS_METHOD_VERSION,
    presentation: 'single',
    semantic: 'water',
    line: { color: '#000000', widthPx: 1, pattern: 'dot' },
  })
  const resolved = resolveSingleSymbol(symbol)
  assert.deepEqual(resolved.line, symbol.line)
  assert.deepEqual(resolved.point, semanticBlocksOf('water').point)
  assert.deepEqual(resolved.fill, semanticBlocksOf('water').fill)
  const plain = versioned({ methodVersion: LAYERS_METHOD_VERSION, presentation: 'single', point: { shape: 'circle', color: '#123456', sizePx: 8 } })
  assert.equal(resolveSingleSymbol(plain), plain, 'no semantic: same reference')
})

test('the legend reads resolved semantic blocks and narrows to data families', () => {
  const symbol = versioned({ methodVersion: LAYERS_METHOD_VERSION, presentation: 'single', semantic: 'boundary' })
  const full = legendOfSymbol(symbol)
  assert.equal(full.semantic, 'boundary')
  assert.deepEqual(full.rows.map(row => row.geometry), ['point', 'line', 'fill'])
  assert.equal(full.rows[0].shape, 'cross', 'point rows carry the marker shape the map draws')
  const polygons = legendOfSymbol(symbol, new Set(['fill']))
  assert.deepEqual(polygons.rows, [{ geometry: 'fill', color: '#8b6fb3', outline: '#8b6fb3', opacity: 0 }])
})
