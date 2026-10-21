/**
 * Contract fixtures for the map-layer presentation vocabulary: symbol
 * validation across the full word list (positive and negative), version
 * tokens refusing to re-derive after edits, override grammar and bounds,
 * imagery template admission (key-free HTTPS, token normalization), group
 * names, and preset expansion equivalence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURE_SEMANTICS,
  HEATMAP_RAMPS,
  LAYERS_METHOD_VERSION,
  LINE_PATTERNS,
  MARKER_SHAPES,
  MAX_GROUP_NAME_CHARS,
  MAX_LABEL_FIELD_CHARS,
  MAX_OVERRIDE_ENTRIES,
  MAX_OVERRIDE_FEATURE_IDS,
  SYMBOL_PRESETS,
  imagerySpecOf,
  legendOfSymbol,
  normalizeImageryTemplate,
  overridesVersionOf,
  resolveSymbolPreset,
  symbolVersionOf,
  validateFeatureOverrides,
  validateGroupName,
  validateImagerySpec,
  validateImageryTemplate,
  validateSymbolStyle,
} from '../src/index.ts'

/** One valid single symbol the negative fixtures mutate. */
const validSingle = {
  methodVersion: LAYERS_METHOD_VERSION,
  presentation: 'single',
  point: { shape: 'circle', color: '#1f77b4', sizePx: 8, opacity: 0.9, outlineColor: '#14405e', outlineWidthPx: 1 },
  line: { color: '#1f77b4', widthPx: 2, pattern: 'dash' },
  fill: { color: '#1f77b4', opacity: 0.5, outlineColor: '#14405e' },
}

/** The same symbol carrying its derived version (the mutator edits in place). */
function versionedSingle(mutate = () => {}) {
  const draft = structuredClone(validSingle)
  mutate(draft)
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

test('a complete single symbol validates across every vocabulary axis', () => {
  const symbol = versionedSingle()
  assert.deepEqual(validateSymbolStyle(symbol), [])
  for (const shape of MARKER_SHAPES) {
    const draft = structuredClone(validSingle)
    draft.point.shape = shape
    assert.deepEqual(validateSymbolStyle({ ...draft, symbolVersion: symbolVersionOf(draft) }).filter(issue => issue.field === 'point.shape'), [])
  }
  for (const pattern of LINE_PATTERNS) {
    const draft = structuredClone(validSingle)
    draft.line.pattern = pattern
    assert.deepEqual(validateSymbolStyle({ ...draft, symbolVersion: symbolVersionOf(draft) }).filter(issue => issue.field === 'line.pattern'), [])
  }
})

test('the symbol version is key-order independent and refuses edits', () => {
  const symbol = versionedSingle()
  const reordered = {
    fill: symbol.fill,
    point: symbol.point,
    presentation: symbol.presentation,
    methodVersion: symbol.methodVersion,
    line: symbol.line,
    symbolVersion: symbol.symbolVersion,
  }
  assert.deepEqual(validateSymbolStyle(reordered), [])
  const edited = structuredClone(symbol)
  edited.point.color = '#ff0000'
  const issues = validateSymbolStyle(edited)
  assert.deepEqual(issues, [{ field: 'symbolVersion', code: 'version-mismatch' }])
})

test('single presentation rejects emptiness and heatmap rejects geometry blocks', () => {
  const empty = versionedSingle(draft => {
    delete draft.point
    delete draft.line
    delete draft.fill
    return draft
  })
  assert.deepEqual(validateSymbolStyle(empty), [{ field: 'symbol', code: 'single-requires-one-block' }])

  const mixed = versionedSingle(draft => {
    draft.heatmap = { radiusPx: 20, ramp: 'viridis' }
    return draft
  })
  assert.ok(validateSymbolStyle(mixed).some(issue => issue.field === 'heatmap' && issue.code === 'heatmap-block-on-single'))

  const heatmapWithBlock = {
    methodVersion: LAYERS_METHOD_VERSION,
    presentation: 'heatmap',
    symbolVersion: 'pending',
    heatmap: { radiusPx: 20, ramp: 'viridis' },
    point: { shape: 'circle', color: '#1f77b4', sizePx: 8 },
  }
  const issues = validateSymbolStyle(heatmapWithBlock)
  assert.ok(issues.some(issue => issue.field === 'point' && issue.code === 'geometry-block-on-heatmap'))
})

test('bounds violations refuse: colors, sizes, widths, radius, opacity', () => {
  const expectations = [
    [draft => { draft.point.color = '#12345' }, 'point.color'],
    [draft => { draft.point.color = 'red' }, 'point.color'],
    [draft => { draft.point.sizePx = 2 }, 'point.sizePx'],
    [draft => { draft.point.sizePx = 41 }, 'point.sizePx'],
    [draft => { draft.point.opacity = 1.5 }, 'point.opacity'],
    [draft => { draft.point.opacity = -0.1 }, 'point.opacity'],
    [draft => { draft.point.outlineWidthPx = 12.5 }, 'point.outlineWidthPx'],
    [draft => { draft.line.widthPx = 0.2 }, 'line.widthPx'],
    [draft => { draft.line.color = '#zzzzzz' }, 'line.color'],
    [draft => { draft.line.opacity = 2 }, 'line.opacity'],
    [draft => { draft.fill.opacity = -1 }, 'fill.opacity'],
    [draft => { draft.fill.outlineColor = 'none' }, 'fill.outlineColor'],
  ]
  for (const [mutate, field] of expectations) {
    const issues = validateSymbolStyle(versionedSingle(mutate))
    assert.ok(issues.some(issue => issue.field === field), `${field} violation not reported: ${JSON.stringify(issues)}`)
  }
})

test('heatmap blocks validate their own vocabulary and bounds', () => {
  const validHeatmap = () => {
    const draft = { methodVersion: LAYERS_METHOD_VERSION, presentation: 'heatmap', heatmap: { field: 'weight', radiusPx: 24, ramp: 'viridis' } }
    return { ...draft, symbolVersion: symbolVersionOf(draft) }
  }
  assert.deepEqual(validateSymbolStyle(validHeatmap()), [])
  for (const ramp of HEATMAP_RAMPS) {
    const draft = validHeatmap()
    draft.heatmap.ramp = ramp
    draft.symbolVersion = symbolVersionOf(draft)
    assert.deepEqual(validateSymbolStyle(draft).filter(issue => issue.field === 'heatmap.ramp'), [])
  }
  const expectations = [
    [draft => { draft.heatmap.radiusPx = 7 }, 'heatmap.radiusPx'],
    [draft => { draft.heatmap.radiusPx = 61 }, 'heatmap.radiusPx'],
    [draft => { draft.heatmap.ramp = 'turbo' }, 'heatmap.ramp'],
    [draft => { draft.heatmap.field = '' }, 'heatmap.field'],
    [draft => { draft.heatmap.minIntensity = 5; draft.heatmap.maxIntensity = 1 }, 'heatmap.minIntensity'],
  ]
  for (const [mutate, field] of expectations) {
    const symbol = validHeatmap()
    mutate(symbol)
    const issues = validateSymbolStyle(symbol)
    assert.ok(issues.some(issue => issue.field === field), `${field} violation not reported: ${JSON.stringify(issues)}`)
  }
})

test('override grammar validates bounds, patches, and the version token', () => {
  const entries = [
    { featureIds: ['f-1', 'f-2'], patch: { color: '#1e88e5' } },
    { featureIds: ['f-3'], patch: { opacity: 0.4, outlineColor: '#0d47a1' } },
  ]
  const valid = { overridesVersion: overridesVersionOf(entries), entries }
  assert.deepEqual(validateFeatureOverrides(valid), [])

  const edited = structuredClone(valid)
  edited.entries[0].patch.color = '#ff0000'
  assert.deepEqual(validateFeatureOverrides(edited), [{ field: 'overrides.overridesVersion', code: 'version-mismatch' }])

  const emptyIds = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: [], patch: { color: '#1e88e5' } }] }
  assert.ok(validateFeatureOverrides(emptyIds).some(issue => issue.code === 'required'))
  const duplicateIds = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1', 'f-1'], patch: { color: '#1e88e5' } }] }
  assert.ok(validateFeatureOverrides(duplicateIds).some(issue => issue.code === 'duplicate-id'))
  const emptyPatch = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1'], patch: {} }] }
  assert.ok(validateFeatureOverrides(emptyPatch).some(issue => issue.code === 'empty-patch'))
  const unknownPatchField = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1'], patch: { weight: 3 } }] }
  assert.ok(validateFeatureOverrides(unknownPatchField).some(issue => issue.code === 'unknown-field'))
  const badOpacity = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1'], patch: { opacity: 1.2 } }] }
  assert.ok(validateFeatureOverrides(badOpacity).some(issue => issue.field === 'overrides.entries[0].patch.opacity'))
  const badShape = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1'], patch: { shape: 'star' } }] }
  assert.ok(validateFeatureOverrides(badShape).some(issue => issue.code === 'unknown-vocabulary'))
  const badPattern = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: ['f-1'], patch: { pattern: 'wave' } }] }
  assert.ok(validateFeatureOverrides(badPattern).some(issue => issue.code === 'unknown-vocabulary'))

  const tooManyEntries = { overridesVersion: 'ovr-x@v1', entries: Array.from({ length: MAX_OVERRIDE_ENTRIES + 1 }, (_, at) => ({ featureIds: [`f-${at}`], patch: { color: '#1e88e5' } })) }
  assert.ok(validateFeatureOverrides(tooManyEntries).some(issue => issue.code === 'too-many-entries'))
  const tooManyIds = { overridesVersion: 'ovr-x@v1', entries: [{ featureIds: Array.from({ length: MAX_OVERRIDE_FEATURE_IDS + 1 }, (_, at) => `f-${at}`), patch: { color: '#1e88e5' } }] }
  assert.ok(validateFeatureOverrides(tooManyIds).some(issue => issue.code === 'too-many-ids'))
})

test('imagery admission: https, zero-key, complete tile tokens, normalization', () => {
  const admissible = 'https://tiles.example.org/base/{z}/{y}/{x}.png'
  const spec = imagerySpecOf(admissible, 'Example tiles')
  assert.equal(spec.methodVersion, LAYERS_METHOD_VERSION)
  assert.equal(spec.urlTemplate, 'https://tiles.example.org/base/{level}/{row}/{col}.png')
  assert.equal(spec.attribution, 'Example tiles')
  assert.deepEqual(validateImagerySpec(spec), [])

  const arcgisForm = 'https://tiles.example.org/base/{level}/{row}/{col}.png'
  assert.equal(imagerySpecOf(arcgisForm).urlTemplate, arcgisForm)
  assert.equal(normalizeImageryTemplate(admissible), arcgisForm)

  const refusals = [
    'http://tiles.example.org/{z}/{y}/{x}.png',
    'https://user:pass@tiles.example.org/{z}/{y}/{x}.png',
    'https://tiles.example.org/{z}/{y}/{x}.png?token=secret',
    'https://tiles.example.org/{z}/{y}/{x}.png#frag',
    'https://tiles.example.org/tiles.png',
    'https://tiles.example.org/{z}/{x}.png',
    'https://tiles.example.org/{level}/{row}/{col}/{z}/{y}/{x}.png',
    'not a url',
    `https://tiles.example.org/${'a'.repeat(600)}/{z}/{y}/{x}.png`,
  ]
  for (const template of refusals) {
    assert.ok(validateImageryTemplate(template).length > 0, `template "${template.slice(0, 40)}…" should refuse`)
  }
  assert.throws(() => imagerySpecOf('https://tiles.example.org/{z}/{y}/{x}.png?token=secret'), /query-present/)
  assert.throws(() => imagerySpecOf('https://tiles.example.org/{z}/{y}/{x}.png', 'x'.repeat(300)), /attribution/)

  const storedXyz = { methodVersion: LAYERS_METHOD_VERSION, urlTemplate: 'https://tiles.example.org/{z}/{y}/{x}.png' }
  assert.ok(validateImagerySpec(storedXyz).some(issue => issue.code === 'not-normalized'))
  const badVersion = { methodVersion: 'other@1', urlTemplate: 'https://tiles.example.org/{level}/{row}/{col}.png' }
  assert.ok(validateImagerySpec(badVersion).some(issue => issue.code === 'unknown-method-version'))
})

test('group names validate length and control characters', () => {
  assert.equal(validateGroupName('路网'), null)
  assert.equal(validateGroupName(' '.repeat(0) + 'a'.repeat(MAX_GROUP_NAME_CHARS)), null)
  assert.equal(validateGroupName(''), 'required')
  assert.equal(validateGroupName('a'.repeat(MAX_GROUP_NAME_CHARS + 1)), 'too-long')
  assert.equal(validateGroupName('bad\nname'), 'control-characters')
  assert.equal(validateGroupName(42), 'required')
})

test('preset expansion resolves to valid, version-consistent symbols', () => {
  assert.ok(SYMBOL_PRESETS.length >= 10)
  for (const preset of SYMBOL_PRESETS) {
    assert.match(preset.id, /^preset:[a-z0-9-]+$/)
    assert.ok(preset.label.length > 0)
    assert.deepEqual(validateSymbolStyle(preset.symbol), [], `${preset.id} must be valid`)
    assert.equal(preset.symbol.symbolVersion, symbolVersionOf(preset.symbol), `${preset.id} version must re-derive`)
  }
  assert.equal(resolveSymbolPreset('preset:marker-circle-blue'), SYMBOL_PRESETS.find(preset => preset.id === 'preset:marker-circle-blue'))
  assert.equal(resolveSymbolPreset('marker-circle-blue')?.id, 'preset:marker-circle-blue')
  assert.equal(resolveSymbolPreset('preset:no-such-preset'), undefined)

  const translucent = resolveSymbolPreset('fill-translucent-orange').symbol
  assert.equal(translucent.fill.opacity, 0.45)
  const legend = legendOfSymbol(translucent)
  assert.equal(legend.rows.length, 1)
  assert.equal(legend.rows[0].opacity, 0.45)
  assert.equal(legend.symbolVersion, translucent.symbolVersion)
})

test('the single-symbol legend derives one row per block with explicit opacity', () => {
  const symbol = versionedSingle()
  const legend = legendOfSymbol(symbol)
  assert.deepEqual(legend.rows.map(row => row.geometry), ['point', 'line', 'fill'])
  assert.equal(legend.rows[0].opacity, 0.9)
  assert.equal(legend.rows[0].outline, '#14405e')
  assert.equal(legend.rows[1].opacity, 1)
  assert.equal(legend.rows[2].opacity, 0.5)
  assert.equal(legend.methodVersion, LAYERS_METHOD_VERSION)
})

test('single symbols accept the optional semantic and label fields', () => {
  for (const semantic of FEATURE_SEMANTICS) {
    assert.deepEqual(validateSymbolStyle(versionedSingle(draft => { draft.semantic = semantic })), [], semantic)
  }
  const labeled = versionedSingle(draft => { draft.semantic = 'poi'; draft.label = { field: 'name', minZoom: 10, maxZoom: 18 } })
  assert.deepEqual(validateSymbolStyle(labeled), [])
  // A semantic alone is a complete single symbol: the semantic table supplies the blocks.
  const bare = { methodVersion: LAYERS_METHOD_VERSION, presentation: 'single', semantic: 'water' }
  assert.deepEqual(validateSymbolStyle({ ...bare, symbolVersion: symbolVersionOf(bare) }), [])
})

test('invalid semantic and label values are rejected with stable codes', () => {
  const codes = mutate => validateSymbolStyle(versionedSingle(mutate)).map(issue => `${issue.field}:${issue.code}`)
  assert.deepEqual(codes(draft => { draft.semantic = 'castle' }), ['semantic:unknown-vocabulary'])
  assert.deepEqual(codes(draft => { draft.label = 'name' }), ['label:not-an-object'])
  assert.deepEqual(codes(draft => { draft.label = { field: '' } }), ['label.field:required'])
  assert.deepEqual(codes(draft => { draft.label = { field: 'a\nb' } }), ['label.field:invalid'])
  assert.deepEqual(codes(draft => { draft.label = { field: 'x'.repeat(MAX_LABEL_FIELD_CHARS + 1) } }), ['label.field:invalid'])
  assert.deepEqual(codes(draft => { draft.label = { field: 'name', expression: '$feature.x' } }), ['label:unknown-field'])
  assert.deepEqual(codes(draft => { draft.label = { field: 'name', minZoom: 30 } }), ['label.minZoom:out-of-range'])
  assert.deepEqual(codes(draft => { draft.label = { field: 'name', minZoom: 14, maxZoom: 10 } }), ['label.minZoom:exceeds-max'])
  const heat = { methodVersion: LAYERS_METHOD_VERSION, presentation: 'heatmap', semantic: 'hotspot', label: { field: 'n' }, heatmap: { radiusPx: 24, ramp: 'viridis' } }
  assert.deepEqual(
    validateSymbolStyle({ ...heat, symbolVersion: symbolVersionOf(heat) }).map(issue => `${issue.field}:${issue.code}`),
    ['semantic:semantic-on-heatmap', 'label:label-on-heatmap'],
  )
})

test('records without the new fields keep their version token; adding one moves it', () => {
  const legacy = versionedSingle()
  const stored = JSON.parse(JSON.stringify(legacy))
  assert.deepEqual(validateSymbolStyle(stored), [], 'a persisted @1 record stays valid')
  assert.equal(symbolVersionOf(validSingle), legacy.symbolVersion)
  const withLabel = versionedSingle(draft => { draft.label = { field: 'name' } })
  assert.notEqual(withLabel.symbolVersion, legacy.symbolVersion)
  assert.deepEqual(validateSymbolStyle({ ...withLabel, label: { field: 'title' } }).map(issue => issue.code), ['version-mismatch'])
})
