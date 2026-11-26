import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VISUALIZATION_TYPES, VISUALIZATION_SPEC_SCHEMA, validateVisualizationSpec, validTimeBinding } from '../src/schema.ts'
import { VISUALIZATION_CATALOG, visualizationOf } from '../src/catalog.ts'

test('the independent schema and sourced catalog cover exactly the same types', () => {
  assert.ok(VISUALIZATION_TYPES.length >= 35)
  assert.deepEqual(VISUALIZATION_CATALOG.map(entry => entry.id).sort(), [...VISUALIZATION_TYPES].sort())
  assert.equal(new Set(VISUALIZATION_TYPES).size, VISUALIZATION_TYPES.length)
  assert.deepEqual(VISUALIZATION_SPEC_SCHEMA.properties.type.enum, VISUALIZATION_TYPES)
  assert.deepEqual(JSON.parse(readFileSync(new URL('../visualization.schema.json', import.meta.url), 'utf8')), VISUALIZATION_SPEC_SCHEMA)
  assert.equal(VISUALIZATION_SPEC_SCHEMA.additionalProperties, false)
  assert.equal(VISUALIZATION_SPEC_SCHEMA.properties.timeBinding.properties.window.properties.from.format, 'date-time')
  assert.match(VISUALIZATION_SPEC_SCHEMA.description, /must also run validateVisualizationSpec/)
  for (const entry of VISUALIZATION_CATALOG) {
    assert.ok(entry.label.en && entry.label.zh && entry.purpose)
    assert.ok(entry.geometry.length && entry.limitations.length && entry.sources.length)
    assert.ok(entry.sources.every(url => url.startsWith('https://github.com/')))
    assert.equal(entry.support === 'unsupported', entry.tools.length === 0, entry.id)
  }
  assert.equal(visualizationOf('hexbin').support, 'unsupported')
  assert.equal(visualizationOf('heatmap').support, 'native')
  assert.equal(visualizationOf('hotspot').support, 'analysis')
  assert.equal(visualizationOf('not-a-type'), undefined)
})

test('time intent refuses ambiguous, impossible, reversed and excessive bindings', () => {
  const binding = { timeField: 'time', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } }
  assert.equal(validTimeBinding(binding), true)
  for (const value of [
    { ...binding, timezone: 'not-a-zone' },
    { ...binding, window: { from: '2026-02-30T00:00:00Z', to: '2026-03-03T00:00:00Z' } },
    { ...binding, window: { ...binding.window, from: '2026-01-01T00:00:00' } },
    { ...binding, window: { from: binding.window.to, to: binding.window.from } },
    { ...binding, extra: true },
  ]) assert.equal(validTimeBinding(value), false)
})

test('schema refuses unknown versions, methods, properties and denominator-free rates', () => {
  assert.deepEqual(validateVisualizationSpec({ schemaVersion: 1, type: 'choropleth', field: 'count', unit: 'people', measure: 'total' }), [])
  for (const input of [null, [], {}, { schemaVersion: 2, type: 'heatmap' }, { schemaVersion: 1, type: 'rainbow' },
    { schemaVersion: 1, type: 'heatmap', script: 'x' },
    { schemaVersion: 1, type: 'choropleth', measure: 'rate', field: 'count', unit: 'people' },
    { schemaVersion: 1, type: 'choropleth', measure: 'total', denominatorField: 'population' }]) {
    assert.ok(validateVisualizationSpec(input).length, JSON.stringify(input))
  }
})
