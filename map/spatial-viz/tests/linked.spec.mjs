/**
 * Linked-view fixtures: the histogram sharing the legend's own bins, the one
 * selection filter whose digest pins brush + frame + style + data identity,
 * feature selection semantics (missing matches nothing, half-open brush,
 * top-bound inclusive at the domain top), bounded attribute rows, and the
 * fixed-revision export manifest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attributeRowsOf,
  buildStyle,
  classifyValue,
  countClasses,
  dataRefOf,
  exportManifestOf,
  featureIdOf,
  filterRevisionOf,
  histogramOf,
  legendOf,
  manifestDigestOf,
  measureValueOf,
  selectFeatureIds,
  selectionFilterOf,
} from '../src/index.ts'

const style = buildStyle({
  field: 'score', unit: '分', measure: 'total', encoding: 'fill',
  classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
})
const legend = legendOf(style)

/** Features covering every class plus the specials. */
function features() {
  return [
    { id: 'a', properties: { score: 5 } },
    { id: 'b', properties: { score: 15 } },
    { id: 'c', properties: { score: 25 } },
    { id: 'd', properties: {} },            // missing value
    { id: 'e', properties: { score: -1 } }, // underflow
    { id: 'f', properties: { score: 31 } }, // overflow
  ]
}

test('the histogram reuses the legend bins; the chart never re-bins', () => {
  const bins = histogramOf(legend, style, [5, 15, 25, Number.NaN, -1, 31])
  assert.equal(bins.length, legend.rows.length)
  assert.deepEqual(bins.map(bin => bin.count), [1, 1, 1, 1, 1, 1])
  assert.deepEqual(bins.map(bin => bin.color), legend.rows.map(row => row.color))
  assert.deepEqual(bins[0], { kind: 'class', classIndex: 0, color: legend.rows[0].color, from: 0, to: 10, toInclusive: false, count: 1 })
  assert.deepEqual(bins[5], { kind: 'missing', color: legend.rows[5].color, count: 1 })
  const empty = histogramOf(legend, style, [])
  assert.equal(empty.every(bin => bin.count === 0), true)
})

test('dataRefOf prefers the resource, then the artifact, then the display digest', () => {
  assert.equal(dataRefOf({ resourceRef: 'res-a@v1', artifactRef: 'art-b@v1', displayDigest: 'dd' }), 'res-a@v1')
  assert.equal(dataRefOf({ artifactRef: 'art-b@v1', displayDigest: 'dd' }), 'art-b@v1')
  assert.equal(dataRefOf({ displayDigest: 'dd' }), 'display:dd')
  assert.equal(dataRefOf({}), null)
})

test('the selection filter pins style, data, frame, and brush with a stable revision', () => {
  const frame = { index: 2, startMs: 1000, endMs: 2000, occupied: true }
  const filter = selectionFilterOf({ style, dataRef: 'res-a@v1', frame, brush: { min: 0, max: 10 } })
  assert.equal(filter.styleVersion, style.styleVersion)
  assert.deepEqual(filter.frame, { index: 2, fromMs: 1000, toMs: 2000 })
  const revision = filterRevisionOf(filter)
  assert.match(revision, /^sel-[0-9a-f]{12}$/u)
  // The same selection always pins to the same revision; any change repins it.
  assert.equal(filterRevisionOf(selectionFilterOf({ style, dataRef: 'res-a@v1', frame, brush: { min: 0, max: 10 } })), revision)
  assert.notEqual(filterRevisionOf(selectionFilterOf({ style, dataRef: 'res-a@v1', frame, brush: { min: 0, max: 20 } })), revision)
  assert.notEqual(filterRevisionOf(selectionFilterOf({ style: null, dataRef: 'res-a@v1', frame, brush: { min: 0, max: 10 } })), revision)
})

test('selectFeatureIds: one predicate for brush and frame, missing matches nothing', () => {
  const rows = features()
  const brushOnly = selectionFilterOf({ style, dataRef: 'res-a@v1', frame: null, brush: { min: 0, max: 10 } })
  assert.deepEqual(selectFeatureIds(rows, brushOnly, style, null), ['a'])
  // Top-bound inclusive at the domain top: the brush [20, 30] keeps score 30.
  const top = selectionFilterOf({ style, dataRef: 'res-a@v1', frame: null, brush: { min: 20, max: 30 } })
  assert.deepEqual(selectFeatureIds([...rows, { id: 'g', properties: { score: 30 } }], top, style, null), ['c', 'g'])
  const missingStyle = selectionFilterOf({ style: null, dataRef: 'res-a@v1', frame: null, brush: { min: 0, max: 10 } })
  assert.deepEqual(selectFeatureIds(rows, missingStyle, null, null), [])
  // Conjunction: the frame filter intersects the brush.
  const binding = { timeField: 'at', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' } }
  const frame = { index: 0, startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: Date.parse('2026-01-02T00:00:00Z'), occupied: true }
  const both = selectionFilterOf({ style, dataRef: 'res-a@v1', frame, brush: null })
  const timed = [
    { id: 'a', properties: { score: 5, at: '2026-01-01T10:00:00Z' } },
    { id: 'b', properties: { score: 15, at: '2026-01-01T11:00:00Z' } },
    { id: 'c', properties: { score: 25, at: '2026-01-02T09:00:00Z' } },
    { id: 'd', properties: { score: 25 } },                       // no time: matches no frame
    { id: 'e', properties: { score: 25, at: 'nonsense' } },       // unparsable time
  ]
  assert.deepEqual(selectFeatureIds(timed, both, style, binding), ['a', 'b'])
  const frameBrush = selectionFilterOf({ style, dataRef: 'res-a@v1', frame, brush: { min: 0, max: 10 } })
  assert.deepEqual(selectFeatureIds(timed, frameBrush, style, binding), ['a'])
})

test('feature ids fall back to stable positions when the GeoJSON id is absent', () => {
  assert.deepEqual([
    featureIdOf({ id: 'named' }, 0),
    featureIdOf({ id: 7 }, 0),
    featureIdOf({}, 2),
  ], ['named', 'f-7', 'f-3'])
})

test('attribute rows keep column order, null for missing, and the honest truncation count', () => {
  const { rows, truncated } = attributeRowsOf(features(), ['score', 'name'])
  assert.equal(rows.length, 6)
  assert.equal(truncated, 0)
  assert.deepEqual(rows[3].values, [null, null])
  assert.deepEqual(rows[0].id, 'a')
})

test('the export manifest freezes the revisions it was given and digests stably', () => {
  const frame = { index: 1, startMs: 500, endMs: 600, occupied: true, timezone: 'UTC', granularity: 'day' }
  const manifest = exportManifestOf({
    mapRevision: 7,
    frame,
    filterRevision: 'sel-aaaaaaaaaaaa',
    layers: [
      { layerId: 'zones', name: 'Zones', styleVersion: style.styleVersion, dataRef: 'res-a@v1', displayDigest: 'dd1', featureCount: 6 },
      { layerId: 'basemap-points', name: 'Points', styleVersion: null, dataRef: null, displayDigest: 'dd2', featureCount: 2 },
    ],
    failures: [{ kind: 'render', layerId: null, detail: 'the 3D scene is still initializing' }],
  })
  assert.equal(manifest.methodVersion, 'spatial-viz@1')
  assert.equal(manifest.mapRevision, 7)
  assert.deepEqual(manifest.frame, { index: 1, fromMs: 500, toMs: 600, timezone: 'UTC', granularity: 'day', label: '1970-01-01' })
  assert.equal(manifest.layers[0].styleVersion, style.styleVersion)
  assert.equal(manifest.layers[1].styleVersion, null)
  assert.equal(manifest.failures.length, 1)
  // Mutating the inputs after the fact cannot reach into the manifest.
  frame.index = 99
  assert.equal(manifest.frame.index, 1)
  assert.match(manifestDigestOf(manifest), /^[0-9a-f]{12}$/u)
  // classifyValue and measureValueOf are re-exported behaviors the selection relies on.
  assert.equal(classifyValue(style, 10), 1)
  assert.equal(measureValueOf({ score: 3 }, style), 3)
  assert.equal(countClasses(style, [3]).counts[0], 1)
})
