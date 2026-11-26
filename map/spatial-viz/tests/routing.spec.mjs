import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeVisualization } from '../src/routing.ts'
import { profileVisualizationData } from '../src/profile.ts'

const features = Array.from({ length: 8 }, (_, i) => ({ geometry: { type: 'Point', coordinates: [i, 0] },
  properties: { value: i + 1, population: 10, time: `2026-01-0${i + 1}T00:00:00Z`, entity: `entity-${i % 2}` } }))
const observationWindow = { from: '2026-01-01T00:00:00Z', to: '2026-01-09T00:00:00Z' }
const profile = profileVisualizationData(features, ['value', 'population', 'time', 'entity'], { window: observationWindow })
const base = { profile, measure: 'total', field: 'value', unit: 'people', hasResourceRef: true, mode: 'map' }
const route = request => routeVisualization({ ...base, ...request })

test('density, aggregation and significant hotspots remain exclusive choices', () => {
  assert.equal(route({ scenario: 'density' }).primary.id, 'heatmap')
  assert.equal(route({ scenario: 'aggregation' }).primary.id, 'grid')
  const hotspot = route({ scenario: 'hotspot' })
  assert.equal(hotspot.primary.id, 'hotspot')
  assert.ok(hotspot.nextTools.includes('stats_hotspot'))
  assert.ok(!hotspot.nextTools.includes('viz_density'))
  assert.equal(hotspot.analysisExecuted, false)
})

test('area totals route to symbols rather than a misleading unnormalized choropleth', () => {
  const polygons = profileVisualizationData(features.map(feature => ({ ...feature, geometry: { type: 'Polygon' } })), ['value', 'population'], { field: 'value', denominatorField: 'population' })
  const total = route({ scenario: 'magnitude', profile: polygons })
  assert.equal(total.status, 'needs-data')
  assert.ok(total.gaps.includes('point-geometry-for-total-symbols'))
  const rate = route({ scenario: 'magnitude', profile: polygons, measure: 'rate', denominatorField: 'population' })
  assert.equal(rate.primary.id, 'choropleth')
  assert.equal(rate.status, 'recommended')
  assert.equal(route({ scenario: 'magnitude', profile: polygons, measure: 'rate' }).status, 'needs-data')
})

test('preferred unsupported and incompatible types never silently fall back to another method', () => {
  const requested = route({ scenario: 'aggregation', preferredType: 'hexbin' })
  assert.equal(requested.primary.id, 'hexbin')
  assert.equal(requested.status, 'unsupported')
  assert.deepEqual(requested.nextTools, [])
  const wrong = route({ scenario: 'hotspot', preferredType: 'heatmap' })
  assert.equal(wrong.status, 'needs-data')
  assert.ok(wrong.gaps.includes('method-does-not-answer-scenario'))
})

test('time visualization requires actual timestamps, a zone and an explicit nonempty window', () => {
  assert.equal(route({ scenario: 'change' }).status, 'needs-data')
  const timeBinding = { timeField: 'time', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-09T00:00:00Z' } }
  const changed = route({ scenario: 'change', timeBinding })
  assert.equal(changed.primary.id, 'temporal-change')
  assert.equal(changed.status, 'recommended')
  assert.ok(changed.nextTools.includes('pattern_change'))
  const untimed = profileVisualizationData(features.map(feature => ({ ...feature, properties: { ...feature.properties, time: 'invalid' } })), ['value', 'time'])
  assert.equal(route({ scenario: 'change', timeBinding, profile: untimed }).status, 'needs-data')
})

test('field data, positive denominators, catalogue identity and compare inputs are real prerequisites', () => {
  assert.equal(route({ scenario: 'magnitude', field: 'absent' }).status, 'needs-data')
  assert.equal(route({ scenario: 'hotspot', hasResourceRef: false }).status, 'needs-data')
  assert.equal(route({ scenario: 'compare' }).status, 'needs-data')
  assert.equal(route({ scenario: 'flow' }).status, 'needs-data')
  assert.equal(route({ scenario: 'locate', profile: null }).status, 'needs-data')
  const constant = profileVisualizationData(features.map(feature => ({ ...feature, properties: { value: 1 } })), ['value'])
  assert.equal(route({ scenario: 'magnitude', profile: constant }).status, 'needs-data')
})

test('heatmap conflicts, constant ratios and unverified windows cannot become runnable recommendations', () => {
  const classified = route({ scenario: 'density', hasClassification: true })
  assert.ok(classified.gaps.includes('heatmap-conflicts-with-classification'))
  const mixed = profileVisualizationData([...features, { geometry: { type: 'Polygon' }, properties: { value: 2 } }], ['value'])
  assert.equal(route({ scenario: 'density', profile: mixed }).status, 'needs-data')
  assert.equal(route({ scenario: 'aggregation', profile: mixed }).status, 'needs-data')
  const constantRatio = profileVisualizationData(features.map(feature => ({ ...feature, properties: { value: 2, population: 2 } })),
    ['value', 'population'], { field: 'value', denominatorField: 'population' })
  assert.equal(route({ scenario: 'magnitude', profile: constantRatio, measure: 'rate', denominatorField: 'population' }).status, 'needs-data')
  const countsOnly = profileVisualizationData(features, ['time', 'value'])
  const timeBinding = { timeField: 'time', timezone: 'UTC', granularity: 'day', window: observationWindow }
  assert.ok(route({ scenario: 'change', profile: countsOnly, timeBinding }).gaps.includes('observations-inside-time-window'))
})

test('derived artifacts cannot impersonate the resource-backed density input', () => {
  const result = route({ scenario: 'density', preferredType: 'kernel-density', hasResourceRef: false, hasCatalogRef: true })
  assert.equal(result.status, 'needs-data')
  assert.ok(result.gaps.includes('versioned-resource-ref'))
  const raster = route({ scenario: 'surface', profile: { featureCount: 0, geometry: ['raster'], fields: [] }, hasRasterTiles: true })
  assert.equal(raster.primary.id, 'raster')
  assert.equal(raster.status, 'recommended')
})

test('time display and statistical time bins keep their separate timezone and granularity rules', () => {
  const timeBinding = { timeField: 'time', timezone: 'Asia/Shanghai', granularity: 'hour', window: observationWindow }
  const animation = route({ scenario: 'change', preferredType: 'time-animation', timeBinding })
  assert.equal(animation.status, 'recommended')
  const statistical = route({ scenario: 'change', timeBinding })
  assert.ok(statistical.gaps.includes('utc-statistical-bins'))
  assert.ok(statistical.gaps.includes('day-week-month-statistical-granularity'))
})

test('flow identity uses nonempty strings rather than accepting numeric or object values', () => {
  const timeBinding = { timeField: 'time', timezone: 'UTC', granularity: 'day', window: observationWindow }
  assert.equal(route({ scenario: 'flow', entityField: 'entity', timeBinding }).status, 'recommended')
  const numericIds = profileVisualizationData(features.map(feature => ({ ...feature, properties: { ...feature.properties, entity: 1 } })),
    ['time', 'entity'], { window: observationWindow })
  const refused = route({ scenario: 'flow', entityField: 'entity', timeBinding, profile: numericIds })
  assert.equal(refused.status, 'needs-data')
  assert.ok(refused.gaps.includes('entity-string-on-every-observation'))
})

test('3D heatmap and missing network/terrain inputs refuse substitutions', () => {
  assert.equal(route({ scenario: 'density', mode: 'scene' }).status, 'needs-data')
  const network = route({ scenario: 'accessibility' })
  assert.equal(network.primary.id, 'network-accessibility')
  assert.ok(network.nextTools.includes('run_submit'))
  assert.ok(!network.nextTools.includes('geo_buffer'))
  assert.ok(network.preconditions.length)
  const terrain = route({ scenario: 'visibility' })
  assert.equal(terrain.primary.id, 'viewshed')
  assert.ok(terrain.nextTools.includes('terrain_viewshed'))
  assert.equal(terrain.status, 'needs-data')
})
