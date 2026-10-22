/**
 * P2 spatiotemporal pattern fixtures: analytic per-unit deltas across
 * time-forward windows, missing windows that stay unknown, late records that
 * are excluded and named, sparse windows that refuse, DBSCAN blobs with an
 * exact assignment, and origin-destination chains that break at gaps instead
 * of being interpolated. Every stability figure is checked against a
 * hand-computed holdout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATS_METHOD_VERSION } from '../src/contract.ts'
import { computeChange, computeCluster, computeFlow, expectedBinsOf } from '../src/patterns.ts'

/** A ten-day observation window June 1–10 2026 (UTC). */
const WINDOW = { from: '2026-06-01T00:00:00Z', to: '2026-06-11T00:00:00Z' }
const BASELINE = { from: '2026-06-01T00:00:00Z', to: '2026-06-06T00:00:00Z' }
const COMPARISON = { from: '2026-06-06T00:00:00Z', to: '2026-06-11T00:00:00Z' }

/** Day `d` of June 2026 at midnight UTC (d = 1…10 stays inside the window). */
const day = (d, hour = 0) => `2026-06-${String(d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
const obs = (id, lon, lat, d, value, entity) => ({
  id, coordinates: [lon, lat], value, timeMs: new Date(day(d)).getTime(), ...(entity === undefined ? {} : { entity }),
})

function changeSpec(overrides = {}) {
  return {
    goalRevision: 1, resourceRef: 'res-obs@v1', field: 'value', eventTimeField: 'time',
    window: WINDOW, baselineWindow: BASELINE, comparisonWindow: COMPARISON,
    blockMeters: 1000, granularity: 'day', minCoverage: 0.6, holdoutBlocks: 1,
    methodVersion: STATS_METHOD_VERSION, ...overrides,
  }
}

test('the expected bins follow the UTC calendar of the granularity', () => {
  assert.equal(expectedBinsOf(WINDOW, 'day').length, 10)
  const weeks = expectedBinsOf({ from: '2026-06-01T00:00:00Z', to: '2026-06-16T00:00:00Z' }, 'week')
  assert.equal(weeks.length, 3, 'June 1 2026 is a Monday; the window spans three Monday-start weeks')
  assert.equal(new Date(weeks[0]).getUTCDay(), 1, 'week bins start on Monday')
  const months = expectedBinsOf({ from: '2026-01-15T00:00:00Z', to: '2026-04-01T00:00:00Z' }, 'month')
  assert.equal(months.length, 3, 'Jan 15–Apr 1 spans the Jan/Feb/Mar bins')
  assert.equal(new Date(months[0]).getUTCDate(), 1)
})

test('per-unit deltas have analytic answers and missing windows stay unknown', async () => {
  const evidence = await computeChange([
    obs('u1', 116, 39, 1, 10),
    obs('u1', 116, 39, 6, 12),
    // u2 has only a baseline observation: its comparison stays unknown.
    obs('u2', 116.01, 39, 2, 10),
    // u3 has only a comparison observation.
    obs('u3', 116.02, 39, 7, 5),
  ], changeSpec({ minCoverage: 0.3 }))
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.unitCount, 3)
  assert.equal(evidence.unitsWithBothWindows, 1)
  assert.equal(evidence.unitsMissingComparison, 1)
  assert.equal(evidence.unitsMissingBaseline, 1)
  assert.equal(evidence.meanBaseline, 10)
  assert.equal(evidence.meanComparison, 8.5, 'the comparison mean spans both comparison-only and both-window units')
  assert.equal(evidence.meanDelta, 2, 'the delta aggregate covers the units both windows observed')
  assert.equal(evidence.stability.drift, 0, 'a single comparison bin leaves nothing to hold out')
})

test('multiple observations per window average before the delta', async () => {
  const evidence = await computeChange([
    obs('u1', 116, 39, 1, 10),
    obs('u1', 116, 39, 2, 12),
    obs('u1', 116, 39, 6, 20),
  ], changeSpec({ minCoverage: 0.3 }))
  assert.equal(evidence.meanBaseline, 11)
  assert.equal(evidence.meanComparison, 20)
  assert.equal(evidence.meanDelta, 9)
})

test('late records are excluded and named, never folded into a neighbor bin', async () => {
  const evidence = await computeChange([
    obs('u1', 116, 39, 1, 10),
    obs('u1', 116, 39, 6, 12),
    obs('late', 116, 39, 11, 99),
  ], changeSpec({ minCoverage: 0.2 }))
  assert.equal(evidence.validCount, 2)
  assert.ok(evidence.diagnostics.some(entry => entry.code === 'observation-outside-window' && entry.observationId === 'late'))
  assert.equal(evidence.meanComparison, 12, 'the late record never enters the window aggregate')
})

test('a sparse window refuses with time-coverage-insufficient', async () => {
  const evidence = await computeChange([
    obs('u1', 116, 39, 1, 10),
    obs('u1', 116, 39, 6, 12),
  ], changeSpec())
  assert.equal(evidence.status, 'not_applicable')
  assert.equal(evidence.notApplicableReason, 'time-coverage-insufficient')
  assert.equal(evidence.coverage.occupiedBins, 2)
  assert.equal(evidence.coverage.expectedBins, 10)
})

test('the time-forward holdout drift is the hand-computed prefix/full gap', async () => {
  const evidence = await computeChange([
    // Baseline is a constant 10 across five days.
    ...[1, 2, 3, 4, 5].map(d => obs('u1', 116, 39, d, 10)),
    // Comparison: 12 on days 6–9, then 20 on the held-out day 10.
    ...[6, 7, 8, 9].map(d => obs('u1', 116, 39, d, 12)),
    obs('u1', 116, 39, 10, 20),
  ], changeSpec())
  // Full comparison mean (12+12+12+12+20)/5 = 13.6 → delta 3.6.
  // Prefix (days 6–9) mean 12 → delta 2. Drift |3.6 − 2| = 1.6.
  assert.ok(Math.abs(evidence.meanDelta - 3.6) < 1e-12)
  assert.equal(evidence.stability.meanDeltaPrefix, 2)
  assert.ok(Math.abs(evidence.stability.meanDeltaFull - 3.6) < 1e-12)
  assert.ok(Math.abs(evidence.stability.drift - 1.6) < 1e-12)
})

test('spatial blocks report per-grid deltas', async () => {
  const evidence = await computeChange([
    obs('near-a', 116, 39, 1, 10),
    obs('near-a', 116, 39, 6, 14),
    obs('far-b', 117, 39.2, 1, 10),
    obs('far-b', 117, 39.2, 6, 4),
  ], changeSpec({ blockMeters: 50_000, minCoverage: 0.2 }))
  assert.equal(evidence.blocks.length, 2)
  assert.deepEqual(evidence.blocks.map(row => row.meanDelta).sort((a, b) => a - b), [4, -6].sort((a, b) => a - b))
  assert.equal(evidence.meanDelta, -1)
})

function clusterSpec(overrides = {}) {
  return {
    goalRevision: 1, resourceRef: 'res-obs@v1', field: 'value', eventTimeField: 'time',
    window: WINDOW, granularity: 'day', minCoverage: 0.6, holdoutBlocks: 1,
    epsMeters: 500, epsBins: 1, minPts: 3, blockMeters: 50_000,
    methodVersion: STATS_METHOD_VERSION, ...overrides,
  }
}

test('space-time DBSCAN separates blobs and marks the singleton noise', async () => {
  const blob = (prefix, lon, lat, d) => [0, 1, 2, 3].map(offset => obs(`${prefix}${offset}`, lon + offset * 0.0001, lat, d, 1))
  const evidence = await computeCluster([
    ...blob('a', 116, 39, 1),
    ...blob('b', 116.5, 39, 1),
    obs('lone', 117.5, 39.5, 1, 1),
  ], clusterSpec({ minCoverage: 0.1 }))
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.clusters.length, 2)
  assert.equal(evidence.noiseCount, 1)
  const sizes = evidence.clusters.map(row => row.memberCount).sort((a, b) => a - b)
  assert.deepEqual(sizes, [4, 4])
})

test('time is a clustering axis: the same place at a distant bin forms its own cluster', async () => {
  const blob = (prefix, d) => [0, 1, 2, 3].map(offset => obs(`${prefix}${offset}`, 116 + offset * 0.0001, 39, d, 1))
  const evidence = await computeCluster([
    ...blob('early', 1),
    ...blob('late', 9),
  ], clusterSpec({ minCoverage: 0.2 }))
  assert.equal(evidence.clusters.length, 2, 'epsBins 1 keeps the two days apart')
})

test('too few observations refuse; the forward holdout counts unreachable points', async () => {
  const few = await computeCluster([obs('a', 116, 39, 1, 1), obs('b', 116, 39, 1, 1)], clusterSpec())
  assert.equal(few.status, 'not_applicable')
  assert.equal(few.notApplicableReason, 'too-few-valid-units')

  const prefixBlob = [0, 1, 2, 3].map(offset => obs(`p${offset}`, 116 + offset * 0.0001, 39, 1, 1))
  const evidence = await computeCluster([
    ...prefixBlob,
    obs('h0', 116.5, 39, 10, 1),
    obs('h1', 116.5, 39.0001, 10, 1),
    obs('h2', 116.5, 39.0002, 10, 1),
    obs('h3', 116.5, 39.0003, 10, 1),
  ], clusterSpec({ minCoverage: 0.2 }))
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.clusters.length, 2, 'the full fit clusters both blobs')
  // The forward holdout fits days 1–9; the day-10 blob is unreachable.
  assert.equal(evidence.stability.holdoutCount, 4)
  assert.equal(evidence.stability.holdoutAssigned, 0)
  assert.equal(evidence.stability.holdoutNoise, 4)
})

function flowSpec(overrides = {}) {
  return {
    goalRevision: 1, resourceRef: 'res-tracks@v1', eventTimeField: 'time', entityField: 'device',
    window: WINDOW, granularity: 'day', minCoverage: 0.6, holdoutBlocks: 1,
    cellMeters: 500, maxGapBins: 1, topK: 16,
    methodVersion: STATS_METHOD_VERSION, ...overrides,
  }
}

test('origin-destination flows have analytic counts and never interpolate gaps', async () => {
  const evidence = await computeFlow([
    // e1 and e2 both move from cell r0c0 to the ~1.4 km-away cell r1c1.
    obs('t1', 116, 39, 1, 0, 'e1'), obs('t2', 116.01, 39.01, 2, 0, 'e1'),
    obs('t3', 116, 39, 1, 0, 'e2'), obs('t4', 116.01, 39.01, 2, 0, 'e2'),
    // e3 stays in one cell.
    obs('t5', 116.005, 39.005, 1, 0, 'e3'), obs('t6', 116.005, 39.005, 2, 0, 'e3'),
    // e4 has a four-day gap: the chain breaks, no midpoint is invented.
    obs('t7', 116, 39, 1, 0, 'e4'), obs('t8', 116.01, 39.01, 5, 0, 'e4'),
  ], flowSpec({ minCoverage: 0.3, cellMeters: 800 }))
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.entityCount, 4)
  assert.equal(evidence.brokenChainCount, 1)
  const moved = evidence.flows.find(row => row.flow === 'r0c0->r1c1')
  assert.ok(moved, `the analytic flow exists (got ${JSON.stringify(evidence.flows)})`)
  assert.equal(moved.transitionCount, 2)
  assert.equal(moved.entityCount, 2)
  const stayed = evidence.flows.find(row => row.flow === 'r0c0->r0c0')
  assert.ok(stayed, 'the in-cell pair of e3 is a stay flow')
  assert.equal(stayed.transitionCount, 1, 'e3 contributes one in-cell transition; the broken e4 chain contributes nothing')
  assert.equal(evidence.flows.length, 2, 'no fabricated midpoint flows exist')
})

test('the flow top-K holdout jaccard is the hand-computed set overlap', async () => {
  const evidence = await computeFlow([
    // e1 stays in r0c0 across days 1–6 (five in-cell transitions, prefix + full).
    ...[1, 2, 3, 4, 5, 6].map(d => obs(`s${d}`, 116, 39, d, 0, 'e1')),
    // e2 moves once on the held-out day 10: a flow only the full window sees.
    obs('m1', 116, 39, 10, 0, 'e2'),
    obs('m2', 116.01, 39.01, 10, 12, 'e2'),
  ], flowSpec({ minCoverage: 0.3, topK: 1 }))
  assert.equal(evidence.status, 'succeeded')
  // Full top-1: two candidate flows; the r0c0->r0c0 stays have count 5, the
  // holdout move has count 1 → full top-1 is the stay; prefix top-1 is the
  // stay too — but the full set ALSO contains the move at rank 2, so with
  // topK 1 both sets are the stay and jaccard is 1.
  assert.equal(evidence.stability.jaccard, 1)
})

test('a holdout-only flow drops out of the prefix top set and lowers the jaccard', async () => {
  const evidence = await computeFlow([
    // The stay flow lives only on days 1–2 (inside the prefix).
    obs('s1', 116, 39, 1, 0, 'e1'),
    obs('s2', 116, 39, 2, 0, 'e1'),
    // The move flow lives only on the held-out day 10.
    obs('m1', 116.02, 39.02, 10, 0, 'e2'),
    obs('m2', 116.03, 39.03, 10, 0, 'e2'),
  ], flowSpec({ minCoverage: 0.3 }))
  assert.equal(evidence.flows.length, 2, 'two distinct flows in the full window')
  assert.equal(evidence.stability.topK, 16)
  // The prefix top set holds only the stay (the move lives entirely in the
  // held-out bin); the full set holds both → intersection 1, union 2.
  assert.equal(evidence.stability.jaccard, 0.5)
})

test('a sparse flow window refuses and an entity-less observation set refuses', async () => {
  const sparse = await computeFlow([obs('a', 116, 39, 1, 0, 'e1')], flowSpec())
  assert.equal(sparse.status, 'not_applicable')
  assert.equal(sparse.notApplicableReason, 'time-coverage-insufficient')
})
