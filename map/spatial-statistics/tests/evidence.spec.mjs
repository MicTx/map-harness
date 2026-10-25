/**
 * P2 evidence-projection fixtures: same-source products collapse into one
 * lineage group (never double-counted as independent evidence), the
 * multi-scale ladder reruns the real statistic at each declared band and
 * records their disagreement, and the legend domain derives once from a
 * frozen result so layer, legend, attribute summary, and evidence stay on
 * one classification and version.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATS_METHOD_VERSION } from '../src/contract.ts'
import { computeAutocorrelation } from '../src/stats.ts'
import { compareScales, groupEvidenceByLineage, legendDomainOf } from '../src/evidence.ts'

function gridUnits(values) {
  const units = []
  let i = 0
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      units.push({ id: `u${row}${col}`, coordinates: [116 + col * 0.01, 39 + row * 0.01], value: values[i++] })
    }
  }
  return units
}

const spec = (band) => ({
  goalRevision: 1, resourceRef: 'res-grid@v1', field: 'value',
  weights: { kind: 'distance-band', bandMeters: band },
  standardization: 'row', permutations: 99, seed: 7, multipleTesting: 'none',
  methodVersion: STATS_METHOD_VERSION,
})

test('same-source products collapse into one lineage group', () => {
  const { groups, independentEvidenceCount } = groupEvidenceByLineage([
    { resultRef: 'art-a@v1', inputRefs: ['res-x@v2', 'res-y@v1'], methodVersion: STATS_METHOD_VERSION },
    { resultRef: 'art-b@v1', inputRefs: ['res-y@v1', 'res-x@v2'], methodVersion: STATS_METHOD_VERSION },
    { resultRef: 'art-c@v1', inputRefs: ['res-x@v3'], methodVersion: STATS_METHOD_VERSION },
    { resultRef: 'art-d@v1', inputRefs: ['res-x@v2', 'res-y@v1'], methodVersion: 'p2-spatial-statistics@0' },
  ])
  assert.equal(independentEvidenceCount, 3, 'a and b share inputs and version; c differs by input; d differs by method version')
  const main = groups.find(group => group.resultRefs.includes('art-a@v1'))
  assert.deepEqual(main.inputRefs, ['res-x@v2', 'res-y@v1'])
  assert.deepEqual([...main.resultRefs].sort(), ['art-a@v1', 'art-b@v1'])
  assert.equal(main.lineageId, `${STATS_METHOD_VERSION}|res-x@v2+res-y@v1`)
})

test('empty lineage input groups to zero independent evidence', () => {
  const { groups, independentEvidenceCount } = groupEvidenceByLineage([])
  assert.deepEqual(groups, [])
  assert.equal(independentEvidenceCount, 0)
})

test('the multi-scale ladder reruns the real statistic per band and reports scale sensitivity', async () => {
  const gradient = gridUnits([10, 10, 10, 5, 5, 5, 1, 1, 1])
  // Two tight bands agree; widening to 3000 m mixes the level structure and
  // flips the sign — the ladder records exactly that scale sensitivity.
  const ladder = await compareScales(gradient, 'value', [
    { kind: 'distance-band', bandMeters: 1200 },
    { kind: 'distance-band', bandMeters: 1500 },
    { kind: 'distance-band', bandMeters: 3000 },
  ], { standardization: 'row', permutations: 99, seed: 7, multipleTesting: 'none' })
  assert.equal(ladder.methodVersion, STATS_METHOD_VERSION)
  assert.equal(ladder.rows.length, 3)
  for (const row of ladder.rows) {
    assert.equal(row.status, 'succeeded')
    assert.equal(row.islandCount, 0)
    assert.ok(row.moranI !== null)
  }
  // Every rung is a different weight matrix, so each carries its own statistic.
  assert.equal(new Set(ladder.rows.map(row => row.moranI)).size, 3, 'the three scales produce three different statistics')
  assert.ok(ladder.rows[0].moranI > 0 && ladder.rows[1].moranI > 0, 'the tight bands see the gradient')
  assert.ok(ladder.rows[2].moranI < 0, `the wide band flips the sign (got ${ladder.rows[2].moranI})`)
  assert.equal(ladder.signAgreement, false, 'the sign flip is recorded as scale sensitivity, never averaged away')

  const agree = await compareScales(gradient, 'value', [
    { kind: 'distance-band', bandMeters: 1200 },
    { kind: 'distance-band', bandMeters: 1500 },
  ], { standardization: 'row', permutations: 99, seed: 7, multipleTesting: 'none' })
  assert.equal(agree.signAgreement, true)

  // A band that isolates every unit refuses per rung instead of inventing an I.
  const isolated = await compareScales(gradient, 'value', [{ kind: 'distance-band', bandMeters: 1 }], { standardization: 'row', permutations: 99, seed: 7, multipleTesting: 'none' })
  assert.equal(isolated.rows[0].status, 'not_applicable')
  assert.equal(isolated.rows[0].notApplicableReason, 'no-weight-neighbors')

  // The fully-connected degenerate scale: every lag excludes only the focal
  // deviation, so I collapses to its expectation −1/(n−1) — the statistic
  // carries no spatial information. A single uninformative rung trivially
  // agrees with itself.
  const complete = await compareScales(gradient, 'value', [{ kind: 'distance-band', bandMeters: 50_000_000 }], { standardization: 'row', permutations: 99, seed: 7, multipleTesting: 'none' })
  assert.ok(Math.abs(complete.rows[0].moranI - -1 / 8) < 1e-12, `a complete graph has I = E[I] = −1/8 (got ${complete.rows[0].moranI})`)
  assert.equal(complete.signAgreement, true, 'one rung cannot disagree with itself')
})

test('the legend domain derives once from the frozen result values', async () => {
  const values = [10, 10, 10, 5, 5, 5, 1, 1, 1]
  const evidence = await computeAutocorrelation(gridUnits(values), spec(1500))
  // The legend consumes the result's own local statistics — never a re-render.
  const legend = legendDomainOf({ kind: 'spatial-autocorrelation', field: 'value', values: evidence.local.map(row => row.localI) })
  assert.equal(legend.methodVersion, STATS_METHOD_VERSION)
  assert.equal(legend.classification, 'quantile-5')
  assert.equal(legend.unit, 'statistic')
  assert.equal(legend.breaks.length, 4)
  // n=9, quantile-5 ranks at 9k/5 = 1.8, 3.6, 5.4, 7.2 → interpolations.
  const sorted = [...evidence.local.map(row => row.localI)].sort((a, b) => a - b)
  for (const [rank, breakValue] of legend.breaks.entries()) {
    const position = (9 * (rank + 1)) / 5
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const expected = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
    assert.ok(Math.abs(breakValue - expected) < 1e-9, `break ${rank}: ${breakValue} vs ${expected}`)
  }
})

test('the legend refuses constant or tiny families instead of inventing breaks', () => {
  assert.equal(legendDomainOf({ kind: 'zonal-summary', field: 'f', values: [2, 2, 2, 2, 2, 2, 2, 2] }), undefined)
  assert.equal(legendDomainOf({ kind: 'hotspot', field: 'f', values: [1, 2, 3] }), undefined)
  const fine = legendDomainOf({ kind: 'zonal-summary', field: 'f', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
  assert.deepEqual(fine.breaks, [3, 5, 7, 9])
  const seven = legendDomainOf({ kind: 'zonal-summary', field: 'f', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }, 'quantile-7')
  assert.equal(seven.breaks.length, 6)
})
