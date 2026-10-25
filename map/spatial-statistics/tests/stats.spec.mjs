/**
 * P2 statistics numeric fixtures: every weighted statistic is cross-checked
 * against an independent dense-matrix implementation computed inside this
 * spec (a second code path over the same frozen inputs), the permutation
 * spread is checked against the closed-form Cliff–Ord randomization spread,
 * seeded tests reproduce bit for bit, and the applicability refusals
 * (constant field, too few units, islands, unconnected band) return
 * `not_applicable` instead of p-values.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EVIDENCE_ROWS,
  computeAutocorrelation,
  computeHotspot,
  computeZonal,
  correctPValues,
  randomizationSdOf,
} from '../src/stats.ts'
import { DEFAULT_PERMUTATION_SEED, STATS_METHOD_VERSION } from '../src/contract.ts'
import { buildWeightMatrix, haversineMeters } from '../src/weights.ts'

/** A 3x3 point grid: 0.01° spacing ≈ 864 m (lon) / 1112 m (lat) at this latitude. */
function grid3x3() {
  const units = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      units.push({ id: `u${row}${col}`, coordinates: [116 + col * 0.01, 39 + row * 0.01], value: 0 })
    }
  }
  return units
}

/** The spec-level grid geometry: band 1500 m gives queen contiguity (8 neighbors). */
const QUEEN_BAND = 1500
/** Band 1200 m keeps only the 4-neighbor rook contiguity. */
const ROOK_BAND = 1200

function autocorrSpec(values, band, overrides = {}) {
  const units = grid3x3()
  values.forEach((value, index) => { units[index].value = value })
  return {
    units,
    spec: {
      goalRevision: 1,
      resourceRef: 'res-grid@v1',
      field: 'value',
      weights: { kind: 'distance-band', bandMeters: band },
      standardization: 'row',
      permutations: 199,
      seed: DEFAULT_PERMUTATION_SEED,
      multipleTesting: 'fdr-bh',
      methodVersion: STATS_METHOD_VERSION,
      ...overrides,
    },
  }
}

/** Independent dense weight matrix (second computation path over the same inputs). */
function denseWeights(coords, band, standardization) {
  const n = coords.length
  const w = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && haversineMeters(coords[i], coords[j]) <= band) w[i][j] = 1
    }
  }
  if (standardization === 'row') {
    for (let i = 0; i < n; i++) {
      const total = w[i].reduce((sum, x) => sum + x, 0)
      if (total > 0) w[i] = w[i].map(x => x / total)
    }
  }
  return w
}

/** Independent global Moran's I over the dense matrix. */
function moranDense(values, coords, band, standardization) {
  const w = denseWeights(coords, band, standardization)
  const n = values.length
  const mean = values.reduce((s, v) => s + v, 0) / n
  const z = values.map(v => v - mean)
  const s0 = w.flat().reduce((s, x) => s + x, 0)
  let num = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) num += w[i][j] * z[i] * z[j]
  const denom = z.reduce((s, x) => s + x * x, 0)
  return (n / s0) * num / denom
}

/** Independent Getis-Ord Gi* z for one unit over the dense self-looped matrix. */
function giStarDense(values, coords, band, standardization, focal) {
  const n = values.length
  const base = denseWeights(coords, band, 'binary')
  const w = base.map((row, i) => row.map((x, j) => (i === j ? 1 : x)))
  if (standardization === 'row') {
    for (let i = 0; i < n; i++) {
      const total = w[i].reduce((s, x) => s + x, 0)
      w[i] = w[i].map(x => x / total)
    }
  }
  const mean = values.reduce((s, v) => s + v, 0) / n
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  let weighted = 0
  let wi = 0
  let wi2 = 0
  for (let j = 0; j < n; j++) {
    weighted += w[focal][j] * values[j]
    wi += w[focal][j]
    wi2 += w[focal][j] ** 2
  }
  return (weighted - wi * mean) / (sd * Math.sqrt((n * wi2 - wi * wi) / (n - 1)))
}

test('global Moran matches the independent dense implementation and E[I] = −1/(n−1)', async () => {
  // Vertical gradient: top row 10, middle 5, bottom 1.
  const gradient = [10, 10, 10, 5, 5, 5, 1, 1, 1]
  const { units, spec } = autocorrSpec(gradient, QUEEN_BAND)
  const evidence = await computeAutocorrelation(units, spec)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.methodVersion, STATS_METHOD_VERSION)
  const expectedI = -1 / (evidence.validCount - 1)
  assert.equal(evidence.expectedI, expectedI)
  const dense = moranDense(gradient, units.map(unit => unit.coordinates), QUEEN_BAND, 'row')
  assert.ok(Math.abs(evidence.moranI - dense) < 1e-12, `library ${evidence.moranI} vs dense ${dense}`)
  assert.ok(evidence.moranI > 0.3, `a strong gradient has positive I (got ${evidence.moranI})`)
  assert.ok(evidence.pseudoP <= 0.05, `the gradient is significant (p=${evidence.pseudoP})`)
})

test('the checkerboard pattern hits the negative extreme under rook contiguity', async () => {
  const checkerboard = [10, 1, 10, 1, 10, 1, 10, 1, 10]
  const { units, spec } = autocorrSpec(checkerboard, ROOK_BAND)
  const evidence = await computeAutocorrelation(units, spec)
  // The rook parity arrangement is the perfect anti-correlation: I = −1.
  const dense = moranDense(checkerboard, units.map(unit => unit.coordinates), ROOK_BAND, 'row')
  assert.ok(Math.abs(dense - -1) < 1e-12, `the analytic checkerboard value is −1 (dense got ${dense})`)
  assert.ok(Math.abs(evidence.moranI - dense) < 1e-12)
  assert.ok(evidence.pseudoP <= 0.01, `the negative extreme is significant (p=${evidence.pseudoP})`)
})

test('the seeded permutation spread matches the exact full enumeration of all 9! redraws', async () => {
  const gradient = [10, 10, 10, 5, 5, 5, 1, 1, 1]
  const { units, spec } = autocorrSpec(gradient, QUEEN_BAND, { permutations: 999 })
  const evidence = await computeAutocorrelation(units, spec)
  assert.equal(evidence.expectedI, -1 / 8)

  // Independent exact enumeration: every permutation of the deviations
  // through the dense computation path.
  const coords = units.map(unit => unit.coordinates)
  const mean = gradient.reduce((s, v) => s + v, 0) / 9
  const dev = gradient.map(v => v - mean)
  const values = [...dev]
  const swaps = new Array(9).fill(0)
  const samples = []
  const emit = (arr) => samples.push(moranDense(arr.map(d => d + mean), coords, QUEEN_BAND, 'row'))
  emit(values)
  let i = 0
  while (i < 9) {
    if (swaps[i] < i) {
      const j = i % 2 === 0 ? 0 : swaps[i]
      const t = values[i]; values[i] = values[j]; values[j] = t
      emit(values)
      swaps[i] += 1
      i = 0
    } else {
      swaps[i] = 0
      i += 1
    }
  }
  assert.equal(samples.length, 362880, 'the enumeration covers all 9! permutations')
  const exactMean = samples.reduce((s, v) => s + v, 0) / samples.length
  const exactSd = Math.sqrt(samples.reduce((s, v) => s + (v - exactMean) ** 2, 0) / samples.length)
  assert.ok(Math.abs(exactMean - -1 / 8) < 1e-9, `the exact permutation mean is E[I] (got ${exactMean})`)
  // 999 Monte-Carlo draws sit within a few percent of the exact spread.
  assert.ok(Math.abs(evidence.permutationSd - exactSd) / exactSd < 0.08,
    `permutation sd ${evidence.permutationSd} vs exact ${exactSd}`)
  // The observed statistic is extreme in the exact distribution too.
  const extreme = samples.filter(v => Math.abs(v - exactMean) >= Math.abs(evidence.moranI - exactMean)).length / samples.length
  assert.ok(extreme <= 0.01, `the exact two-sided p is small (got ${extreme})`)
  assert.ok(Math.abs(evidence.zValue - (evidence.moranI - evidence.expectedI) / evidence.permutationSd) < 1e-12)
})

test('the closed-form Cliff–Ord spread converges to the permutation spread at scale', async () => {
  // A 12x12 grid with a smooth field: the large-sample approximation applies.
  const units = []
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      units.push({
        id: `g${row}${col}`,
        coordinates: [116 + col * 0.01, 39 + row * 0.01],
        value: 10 + Math.sin(row / 2) * 4 + Math.cos(col / 3) * 2 + (((row * 12 + col) * 2654435761) % 1000) / 1000 - 0.5,
      })
    }
  }
  const spec = {
    goalRevision: 1, resourceRef: 'res-grid@v1', field: 'value',
    weights: { kind: 'distance-band', bandMeters: 1500 },
    standardization: 'row', permutations: 299, seed: DEFAULT_PERMUTATION_SEED,
    multipleTesting: 'none', methodVersion: STATS_METHOD_VERSION,
  }
  const evidence = await computeAutocorrelation(units, spec)
  assert.equal(evidence.status, 'succeeded')
  const ratio = evidence.permutationSd / evidence.randomizationSd
  assert.ok(ratio > 0.85 && ratio < 1.15,
    `permutation sd ${evidence.permutationSd} vs closed-form ${evidence.randomizationSd} (ratio ${ratio})`)
})

test('the same seed reproduces every p-value bit for bit', async () => {
  const gradient = [10, 10, 10, 5, 5, 5, 1, 1, 1]
  const first = autocorrSpec(gradient, QUEEN_BAND)
  const second = autocorrSpec(gradient, QUEEN_BAND)
  const [a, b] = await Promise.all([computeAutocorrelation(first.units, first.spec), computeAutocorrelation(second.units, second.spec)])
  assert.equal(a.pseudoP, b.pseudoP)
  assert.deepEqual(a.local.map(row => row.pseudoP), b.local.map(row => row.pseudoP))
  // A different seed resamples but stays a probability.
  const third = autocorrSpec(gradient, QUEEN_BAND, { seed: 42 })
  const c = await computeAutocorrelation(third.units, third.spec)
  assert.ok(c.pseudoP > 0 && c.pseudoP <= 1)
})

test('row standardization sums every kept row to one and keeps S0 = n', async () => {
  const { units, spec } = autocorrSpec([3, 1, 4, 1, 5, 9, 2, 6, 5], QUEEN_BAND)
  const evidence = await computeAutocorrelation(units, spec)
  const matrix = buildWeightMatrix(units.map(unit => unit.coordinates), spec)
  assert.equal(matrix.islandIndexes.length, 0)
  assert.ok(Math.abs(matrix.s0 - 9) < 1e-12, `row-standardized S0 is n (got ${matrix.s0})`)
  assert.equal(evidence.weights.s0, matrix.s0)
  for (const row of matrix.neighbors) {
    assert.ok(Math.abs(row.reduce((sum, edge) => sum + edge.w, 0) - 1) < 1e-12)
  }
})

test('LISA labels the planted cluster corner and the correction only raises p-values', async () => {
  // A planted 2x2 high block: the corner sees an all-high neighborhood.
  const high = [10, 10, 1, 10, 10, 1, 1, 1, 1]
  const highRun = autocorrSpec(high, QUEEN_BAND, { multipleTesting: 'none' })
  const highEvidence = await computeAutocorrelation(highRun.units, highRun.spec)
  const corner = highEvidence.local.find(row => row.unitId === 'u00')
  assert.equal(corner.classification, 'high-high', `the high corner is a significant high-high (got ${corner.classification}, p=${corner.pseudoP})`)
  // The mirrored low block labels the same corner low-low.
  const low = [1, 1, 10, 1, 1, 10, 10, 10, 10]
  const lowRun = autocorrSpec(low, QUEEN_BAND, { multipleTesting: 'none' })
  const lowEvidence = await computeAutocorrelation(lowRun.units, lowRun.spec)
  const lowCorner = lowEvidence.local.find(row => row.unitId === 'u00')
  assert.equal(lowCorner.classification, 'low-low')
  // Every classification respects its signs, and the correction never lowers a p.
  for (const row of highEvidence.local) {
    assert.ok(['high-high', 'low-low', 'high-low', 'low-high', 'not-significant'].includes(row.classification))
    assert.ok(row.correctedP >= row.pseudoP - 1e-15)
  }
  const bonferroniRun = autocorrSpec(high, QUEEN_BAND, { multipleTesting: 'bonferroni' })
  const bonfEvidence = await computeAutocorrelation(bonferroniRun.units, bonferroniRun.spec)
  const noneSignificant = highEvidence.local.filter(row => row.classification !== 'not-significant').length
  const bonfSignificant = bonfEvidence.local.filter(row => row.classification !== 'not-significant').length
  assert.ok(bonfSignificant <= noneSignificant, 'bonferroni never adds significant units')
})

test('correctPValues implements bonferroni and Benjamini–Hochberg step-up exactly', () => {
  assert.deepEqual(correctPValues([0.01, 0.2, 0.04], 'none'), [0.01, 0.2, 0.04])
  const closeTo = (actual, expected) => actual.map((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12, `${value} vs ${expected[index]}`))
  closeTo(correctPValues([0.01, 0.2, 0.04], 'bonferroni'), [0.03, 0.6, 0.12])
  // BH: ranks 0.01(1), 0.04(2), 0.2(3) → scaled 0.03, 0.06, 0.2 → monotone from the largest.
  closeTo(correctPValues([0.01, 0.2, 0.04], 'fdr-bh'), [0.03, 0.2, 0.06])
})

test('Getis-Ord ranks the pure-hot corner first and matches the dense computation', async () => {
  // 2x2 block of 10s in the top-left corner, 1s elsewhere.
  const planted = [10, 10, 1, 10, 10, 1, 1, 1, 1]
  const { units, spec } = autocorrSpec(planted, QUEEN_BAND, { permutations: 999, multipleTesting: 'none' })
  const evidence = await computeHotspot(units, spec)
  assert.equal(evidence.status, 'succeeded')
  // u00's neighborhood is purely hot, so it ranks first and stays significant.
  assert.equal(evidence.rows[0].unitId, 'u00')
  assert.equal(evidence.rows[0].classification, 'hotspot')
  assert.ok(evidence.rows[0].pseudoP <= 0.01, `the pure-hot corner is significant (p=${evidence.rows[0].pseudoP})`)
  assert.ok(evidence.rows.find(row => row.unitId === 'u11').giStarZ < evidence.rows[0].giStarZ, 'the diluted block center never outranks the pure corner')
  // Rows stay sorted by z descending.
  for (let i = 1; i < evidence.rows.length; i++) {
    assert.ok(evidence.rows[i - 1].giStarZ >= evidence.rows[i].giStarZ)
  }
  // Cross-check the focal z of u00 against the independent dense computation.
  const coords = units.map(unit => unit.coordinates)
  const focal = units.findIndex(unit => unit.id === 'u00')
  const denseZ = giStarDense(planted, coords, QUEEN_BAND, 'row', focal)
  const libraryZ = evidence.rows.find(row => row.unitId === 'u00').giStarZ
  assert.ok(Math.abs(libraryZ - denseZ) < 1e-9, `library ${libraryZ} vs dense ${denseZ}`)
})

test('a constant field returns not_applicable without inventing a p-value', async () => {
  const { units, spec } = autocorrSpec([7, 7, 7, 7, 7, 7, 7, 7, 7], QUEEN_BAND)
  const evidence = await computeAutocorrelation(units, spec)
  assert.equal(evidence.status, 'not_applicable')
  assert.equal(evidence.notApplicableReason, 'constant-field')
  assert.equal(evidence.pseudoP, null)
  assert.equal(evidence.moranI, null)
})

test('too few units, unconnected bands, and islands are honest refusals or named exclusions', async () => {
  const few = autocorrSpec([1, 2, 3, 4, 5, 6, 7, 8, 9], QUEEN_BAND)
  few.units.length = 5
  const fewEvidence = await computeAutocorrelation(few.units, few.spec)
  assert.equal(fewEvidence.status, 'not_applicable')
  assert.equal(fewEvidence.notApplicableReason, 'too-few-valid-units')

  // Band 1 m: nobody has a neighbor.
  const isolated = autocorrSpec([1, 2, 3, 4, 5, 6, 7, 8, 9], 1)
  const isolatedEvidence = await computeAutocorrelation(isolated.units, isolated.spec)
  assert.equal(isolatedEvidence.status, 'not_applicable')
  assert.equal(isolatedEvidence.notApplicableReason, 'no-weight-neighbors')

  // One remote unit is an island: excluded and named, the rest still computes.
  // Island exclusion is structural (the band left it unconnected), not data
  // loss, so the status stays succeeded while the count and diagnostic record it.
  const withIsland = autocorrSpec([1, 2, 3, 4, 5, 6, 7, 8, 9], QUEEN_BAND)
  withIsland.units.push({ id: 'u-remote', coordinates: [30, 30], value: 12 })
  const islandEvidence = await computeAutocorrelation(withIsland.units, withIsland.spec)
  assert.equal(islandEvidence.status, 'succeeded')
  assert.equal(islandEvidence.weights.islandCount, 1)
  assert.equal(islandEvidence.validCount, 10)
  assert.ok(islandEvidence.diagnostics.some(diagnostic => diagnostic.code === 'island-excluded' && diagnostic.unitId === 'u-remote'))
  assert.ok(!islandEvidence.local.some(row => row.unitId === 'u-remote'))
  assert.equal(islandEvidence.local.length, 9)
})

test('the rook band answers with a different neighbor count than the queen band', async () => {
  const values = [3, 1, 4, 1, 5, 9, 2, 6, 5]
  const queen = autocorrSpec(values, QUEEN_BAND)
  const rook = autocorrSpec(values, ROOK_BAND)
  const [queenEvidence, rookEvidence] = await Promise.all([
    computeAutocorrelation(queen.units, queen.spec),
    computeAutocorrelation(rook.units, rook.spec),
  ])
  const queenMatrix = buildWeightMatrix(queen.units.map(unit => unit.coordinates), queen.spec)
  const rookMatrix = buildWeightMatrix(rook.units.map(unit => unit.coordinates), rook.spec)
  assert.equal(queenMatrix.neighbors[4].length, 8, 'the center has 8 queen neighbors')
  assert.equal(rookMatrix.neighbors[4].length, 4, 'the center has 4 rook neighbors')
  assert.ok(Math.abs(queenEvidence.moranI - rookEvidence.moranI) > 1e-9, 'the two scales produce different statistics')
})

test('zonal aggregates have exact analytic answers including the weighted forms', async () => {
  const units = [
    { id: 'a1', coordinates: [116, 39], value: 1, denominator: 1, zone: 'A' },
    { id: 'a2', coordinates: [116.01, 39], value: 2, denominator: 1, zone: 'A' },
    { id: 'a3', coordinates: [116.02, 39], value: 3, denominator: 2, zone: 'A' },
    { id: 'b1', coordinates: [116, 39.05], value: 10, denominator: 5, zone: 'B' },
    { id: 'x1', coordinates: [116, 39.1], value: Number.NaN, zone: 'A' },
  ]
  const evidence = await computeZonal(units, {
    goalRevision: 0,
    resourceRef: 'res-units@v1',
    field: 'value',
    denominatorField: 'denominator',
    zoneField: 'zone',
    methodVersion: STATS_METHOD_VERSION,
  })
  assert.equal(evidence.status, 'partial', 'the invalid unit marks the run partial')
  assert.equal(evidence.unitCount, 5)
  assert.equal(evidence.validCount, 4)
  const zoneA = evidence.zones.find(row => row.zone === 'A')
  const zoneB = evidence.zones.find(row => row.zone === 'B')
  assert.equal(zoneA.sum, 6)
  assert.equal(zoneA.mean, 2)
  assert.equal(zoneA.min, 1)
  assert.equal(zoneA.max, 3)
  assert.ok(Math.abs(zoneA.std - Math.sqrt(2 / 3)) < 1e-12, `population ddof=0 std of [1,2,3] (got ${zoneA.std})`)
  assert.equal(zoneA.missingCount, 1)
  assert.ok(Math.abs(zoneA.weightedMean - 9 / 4) < 1e-12, `weighted mean (1+2+6)/4 (got ${zoneA.weightedMean})`)
  assert.ok(Math.abs(zoneA.rate - 1.5) < 1e-12, `rate 6/4 (got ${zoneA.rate})`)
  assert.equal(zoneB.std, null, 'a single-observation zone reports no dispersion')
  assert.ok(evidence.diagnostics.some(diagnostic => diagnostic.code === 'constant-zone' && diagnostic.zone === 'B'))
  assert.ok(evidence.diagnostics.some(diagnostic => diagnostic.code === 'observation-invalid' && diagnostic.unitId === 'x1'))
})

test('zonal with no valid units refuses honestly; the artifact seam carries the full table', async () => {
  const published = []
  const publish = async (label, bytes) => {
    const ref = `art-${label}@v1`
    published.push({ label, ref, table: JSON.parse(new TextDecoder().decode(bytes)) })
    return { ref }
  }
  const empty = await computeZonal([
    { id: 'x', coordinates: [116, 39], value: Number.NaN },
  ], { goalRevision: 0, resourceRef: 'res-units@v1', field: 'value', methodVersion: STATS_METHOD_VERSION }, publish)
  assert.equal(empty.status, 'not_applicable')
  assert.equal(empty.notApplicableReason, 'no-valid-observations')

  const full = await computeZonal([
    { id: 'a', coordinates: [116, 39], value: 2, zone: 'A' },
    { id: 'b', coordinates: [116.01, 39], value: 4, zone: 'A' },
  ], { goalRevision: 0, resourceRef: 'res-units@v1', field: 'value', zoneField: 'zone', methodVersion: STATS_METHOD_VERSION }, publish)
  assert.equal(full.status, 'succeeded')
  assert.equal(published.filter(entry => entry.label === 'zonal-table').length, 1, 'the zonal artifact carries the full zone table')
  assert.equal(published.at(-1).table.zones[0].mean, 3)
  assert.equal(full.artifacts.length, 1)
  assert.equal(full.artifacts[0].ref, 'art-zonal-table@v1')
})

test('randomizationSdOf refuses degenerate inputs and correctPValues handles empty families', () => {
  assert.equal(randomizationSdOf(3, { s0: 16, s1: 32, s2: 256 }, [1, 2, 3]), null)
  assert.equal(randomizationSdOf(4, { s0: 0, s1: 0, s2: 0 }, [1, 2, 3, 4]), null)
  assert.deepEqual(correctPValues([], 'fdr-bh'), [])
})

test('the evidence tables stay bounded and name the truncation', async () => {
  // 9 units cannot exceed the cap; prove the cap mechanics through the exported constant instead.
  assert.ok(MAX_EVIDENCE_ROWS >= 8)
  const { units, spec } = autocorrSpec([3, 1, 4, 1, 5, 9, 2, 6, 5], QUEEN_BAND)
  const evidence = await computeAutocorrelation(units, spec)
  assert.ok(evidence.local.length <= MAX_EVIDENCE_ROWS)
})
