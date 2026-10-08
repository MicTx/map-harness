/**
 * Attribution fixtures: association with seeded permutation p-values that
 * reproduce bit for bit and honest refusals (constant outcome, too few rows),
 * and model explanation with hand-computed standardized contributions, VIF
 * collinearity flags, and the fixed non-causal claim levels.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECISION_METHOD_VERSION } from '../src/contract.ts'
import { computeAssociation, computeExplain } from '../src/attribution.ts'

/** A no-op publish seam capturing the labels (tests need no artifacts). */
const publish = async (label, bytes) => ({ ref: `art-${label}@v1` })

/** @param cells - [outcome, transit, green] triples. */
function rowsOf(cells) {
  return cells.map(([x, y, z], index) => ({
    id: `r${index}`,
    coordinates: [116 + index * 0.01, 39],
    values: { outcome: x, transit: y, green: z },
  }))
}

const METHOD = DECISION_METHOD_VERSION

test('association reports the analytic correlation with a seeded permutation p', async () => {
  // Perfect monotone relation on 8 rows: r = 1, permutation p at its floor 1/(count+1).
  const rows = rowsOf([
    [1, 1, 5], [2, 2, 5], [3, 3, 5], [4, 4, 5],
    [5, 5, 5], [6, 6, 5], [7, 7, 5], [8, 8, 5],
  ])
  const evidence = await computeAssociation(rows, {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit', 'green'], methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.claimLevel, 'association', 'association never upgrades its label')
  const transit = evidence.factors[0]
  assert.ok(transit)
  assert.ok(Math.abs((transit.pearson ?? 0) - 1) < 1e-12)
  assert.equal(transit.permutationP, 1 / 200, 'a perfect r is never p=0: the floor is 1/(count+1)')
  const green = evidence.factors[1]
  assert.ok(green)
  assert.equal(green.pearson, null, 'a constant factor reports no correlation instead of inventing one')
  // Same seed reproduces the p-value bit for bit.
  const again = await computeAssociation(rowsOf([
    [1, 2, 1], [2, 3, 2], [3, 5, 3], [4, 4, 4], [5, 6, 5], [6, 8, 9], [7, 9, 7], [8, 10, 8],
  ]), {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit'], methodVersion: METHOD,
  }, publish)
  const first = await computeAssociation(rowsOf([
    [1, 2, 1], [2, 3, 2], [3, 5, 3], [4, 4, 4], [5, 6, 5], [6, 8, 9], [7, 9, 7], [8, 10, 8],
  ]), {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit'], methodVersion: METHOD,
  }, publish)
  assert.equal(again.factors[0]?.permutationP, first.factors[0]?.permutationP)
  assert.ok(again.limitations.some(line => line.includes('causal effect')))
})

test('association refuses honestly on constant outcomes and thin tables', async () => {
  const constant = await computeAssociation(rowsOf([
    [5, 1, 1], [5, 2, 2], [5, 3, 3], [5, 4, 4], [5, 5, 5], [5, 6, 6], [5, 7, 7], [5, 8, 8],
  ]), {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit'], methodVersion: METHOD,
  }, publish)
  assert.equal(constant.status, 'not_applicable')
  assert.equal(constant.notApplicableReason, 'constant-outcome')
  assert.equal(constant.factors.length, 0)
  const thin = await computeAssociation(rowsOf([
    [1, 1, 1], [2, 2, 2], [3, 3, 3],
  ]), {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit'], methodVersion: METHOD,
  }, publish)
  assert.equal(thin.status, 'not_applicable')
  assert.equal(thin.notApplicableReason, 'too-few-valid-rows')
})

test('explain splits hand-computed standardized contributions and flags collinear factors', async () => {
  // Orthogonal design: transit = 0/1 balanced, green = −2/2 balanced, outcome = 2·transit + 3·green.
  const rows = []
  const transitValues = [0, 1, 0, 1, 0, 1, 0, 1]
  const greenValues = [2, 2, 2, 2, -2, -2, -2, -2]
  transitValues.forEach((t, index) => {
    const g = greenValues[index] ?? 0
    rows.push({
      id: `r${index}`,
      coordinates: [116 + index * 0.01, 39],
      values: { outcome: 2 * t + 3 * g, transit: t, green: g },
    })
  })
  const evidence = await computeExplain(rows, {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit', 'green'], methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.claimLevel, 'model-explanation', 'explanation never upgrades its label')
  assert.ok(Math.abs(evidence.rSquared - 1) < 1e-12, 'the outcome is exactly linear in the factors')
  const transit = evidence.contributions.find(row => row.field === 'transit')
  const green = evidence.contributions.find(row => row.field === 'green')
  assert.ok(transit && green)
  // beta_std = beta × sd. Both factors are balanced ± designs: sd(green)/sd(transit) = √16 = 4,
  // so the share ratio is exactly (3·4)/(2·1) = 6.
  const shareRatio = (green.share ?? 0) / (transit.share ?? 0)
  assert.ok(Math.abs(shareRatio - 6) < 1e-9, `share ratio (got ${shareRatio})`)
  assert.ok(Math.abs((transit.share ?? 0) + (green.share ?? 0) - 1) < 1e-12, 'shares sum to one')
  // VIF: orthogonal factors both have VIF 1.
  for (const row of evidence.vif) {
    assert.ok(Math.abs((row.vif ?? 99) - 1) < 1e-9, `orthogonal VIF 1 (got ${row.vif})`)
    assert.equal(row.collinear, false)
  }
})

test('explain flags near-collinear factors through the VIF table and refuses a singular design', async () => {
  const rows = []
  for (let index = 0; index < 12; index++) {
    const x = index % 4
    const noise = index % 2 === 0 ? 1e-6 : -1e-6
    rows.push({
      id: `r${index}`,
      coordinates: [116 + index * 0.01, 39],
      values: { outcome: 2 * x + (index % 3), transit: x, twin: x + noise },
    })
  }
  const evidence = await computeExplain(rows, {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit', 'twin'], methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'succeeded', 'a near-collinear design still reports — the VIF table carries the diagnosis')
  for (const row of evidence.vif) {
    assert.equal(row.collinear, true, `near-duplicated factor ${row.field} is collinear (vif ${row.vif})`)
  }
  assert.ok(evidence.limitations.some(line => line.includes('collinear')))
  // An exactly duplicated column is singular: the honest refusal, not invented coefficients.
  const singular = rows.map(row => ({ ...row, values: { ...row.values, twin: row.values.transit } }))
  const refused = await computeExplain(singular, {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit', 'twin'], methodVersion: METHOD,
  }, publish)
  assert.equal(refused.status, 'not_applicable')
  assert.equal(refused.notApplicableReason, 'no-factor-variation')
})

test('explain refuses honestly on a constant outcome', async () => {
  const rows = rowsOf([
    [7, 1, 1], [7, 2, 2], [7, 3, 3], [7, 4, 4], [7, 5, 5], [7, 6, 6], [7, 7, 7], [7, 8, 8],
  ])
  const evidence = await computeExplain(rows, {
    goalRevision: 1, resourceRef: 'res-u@v1', outcomeField: 'outcome',
    factorFields: ['transit'], methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'not_applicable')
  assert.equal(evidence.notApplicableReason, 'constant-outcome')
})
