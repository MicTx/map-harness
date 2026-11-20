import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileVisualizationData } from '../src/profile.ts'

const point = properties => ({ geometry: { type: 'Point', coordinates: [0, 0] }, properties })

test('profiles actual values without coercion, dropped rows or prototype-key collisions', () => {
  const features = [point({ value: 2, population: 10, time: '2026-01-01T00:00:00Z' }),
    point({ value: '3', population: 0, time: 'bad' }), point({ value: null, population: -2 }),
    point(JSON.parse('{"constructor": 4, "__proto__": 2}'))]
  const before = JSON.stringify(features)
  const profile = profileVisualizationData(features, ['value', 'population', 'time', 'missing', 'constructor'])
  assert.equal(profile.featureCount, 4)
  assert.deepEqual(profile.geometry, ['point'])
  assert.deepEqual(profile.fields.find(field => field.name === 'value'), {
    name: 'value', present: 2, numeric: 1, positive: 1, nonnegative: 1, timestamps: 0, identities: 1, distinct: 2, numericDistinct: 1,
  })
  assert.equal(profile.fields.find(field => field.name === 'population').positive, 1)
  assert.equal(profile.fields.find(field => field.name === 'time').timestamps, 1)
  assert.equal(profile.fields.find(field => field.name === 'missing').present, 0)
  assert.equal(profile.fields.find(field => field.name === 'constructor').numeric, 1)
  assert.equal(JSON.stringify(features), before)
})

test('ratio facts require finite values on the same row and time facts use an explicit half-open window', () => {
  const window = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }
  const profile = profileVisualizationData([
    point({ value: 1, population: null, time: window.from }),
    point({ value: null, population: 1, time: window.to }),
    point({ value: 2, population: 2, time: '2026-02-30T00:00:00Z' }),
    point({ value: 4, population: 4, time: '2026-01-02T00:00:00' }),
  ], ['value', 'population', 'time'], { field: 'value', denominatorField: 'population', window })
  assert.deepEqual(profile.ratio, { field: 'value', denominatorField: 'population', valid: 2, distinct: 1 })
  const time = profile.fields.find(field => field.name === 'time')
  assert.equal(time.timestamps, 2)
  assert.equal(time.inWindow, 1)
})

test('capped distinct counts explicitly mean lower bounds, not exact cardinalities', () => {
  const profile = profileVisualizationData(Array.from({ length: 24 }, (_, index) => point({ value: index + 1, population: 1 })),
    ['value', 'population'], { field: 'value', denominatorField: 'population' })
  assert.equal(profile.fields[0].numericDistinct, 2)
  assert.equal(profile.ratio.distinct, 2)
  assert.equal(profile.fields[1].numericDistinct, 1)
  assert.match(profile.distinctCountSemantics, /0 and 1 are exact/)
  assert.match(profile.distinctCountSemantics, /2 means at least 2/)
  assert.match(profile.distinctCountSemantics, /not an exact count/)
  assert.match(profile.distinctCountSemantics, /ratio\.distinct/)
})

test('mixed geometries and empty/null geometry are not reported as all-point data', () => {
  const profile = profileVisualizationData([point({}), { geometry: { type: 'Polygon' }, properties: {} }, { geometry: null }], [])
  assert.deepEqual(profile.geometry, ['point', 'polygon', 'unknown'])
  assert.equal(profileVisualizationData([], []).featureCount, 0)
})
