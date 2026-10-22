/**
 * Causal-effect fixtures: an assigned-treatment table recovers the true
 * effect inside its interval and reaches the causal claim level; an
 * unbalanced (confounded) table, an overlap violation, an interference
 * fixture, an undeclared design, and a no-variation table each return the
 * correct honest label (`association` / `unknown`); the two-period
 * difference-in-differences recovers its hand-computed delta with the Welch
 * interval.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BALANCE_SMD_LIMIT, DECISION_METHOD_VERSION, OVERLAP_SHARE_MIN } from '../src/contract.ts'
import { computeEffect } from '../src/causal.ts'

const publish = async (label) => ({ ref: `art-${label}@v1` })
const METHOD = DECISION_METHOD_VERSION

/** Build a covariate-adjustment table: outcome = 10 + 5·treatment + 2·covariate (no noise). */
function adjustmentRows({ effect = 5, unbalanced = false, overlapBreak = false, interference = false }) {
  const rows = []
  for (let index = 0; index < 20; index++) {
    const treated = index % 2 === 0
    const covariate = unbalanced
      ? (treated ? 8 + (index % 3) : index % 3)
      : overlapBreak && treated ? 10 + index : Math.floor(index / 2)
    const treatmentEffect = treated ? effect : 0
    rows.push({
      id: `r${index}`,
      coordinates: interference && treated
        ? [116.000 + (index % 4) * 0.0005, 39.0]
        : [116 + (treated ? 0.5 : 0) + index * 0.001, 39 + index * 0.001],
      values: {
        outcome: 10 + treatmentEffect + 2 * covariate,
        income: covariate,
      },
      marks: { policy: treated },
    })
  }
  return rows
}

const baseSpec = {
  goalRevision: 1, resourceRef: 'res-units@v1', outcomeField: 'outcome',
  factorFields: ['income'], treatmentField: 'policy', treatedValue: true,
  intervalLevel: 0.95, methodVersion: METHOD,
}

test('a balanced design recovers the true effect and reaches the causal level', async () => {
  const evidence = await computeEffect(adjustmentRows({}), {
    ...baseSpec,
    design: 'covariate-adjustment',
    interferenceBandMeters: 500,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.claimLevel, 'causal', JSON.stringify(evidence.downgradeReasons))
  assert.deepEqual(evidence.downgradeReasons, [])
  const interval = evidence.interval
  assert.ok(interval)
  // The exact linear fit recovers the true effect 5; zero residual sigma collapses the interval onto it.
  assert.ok(Math.abs(interval.estimate - 5) < 1e-6, `effect (got ${interval.estimate})`)
  assert.ok(Math.abs(interval.low - 5) < 1e-6 && Math.abs(interval.high - 5) < 1e-6, `interval [${interval.low}, ${interval.high}]`)
  // df = n − p = 20 − 3 (intercept, treatment, income).
  assert.equal(interval.df, 17)
  assert.ok(Math.abs(evidence.maxAbsSmd - 0) < 1e-9, `balanced SMD 0 (got ${evidence.maxAbsSmd})`)
  assert.ok((evidence.minOverlapShare ?? 0) >= OVERLAP_SHARE_MIN)
  assert.ok(evidence.assumptions.length >= 3, 'the causal level states its assumptions')
})

test('an unbalanced (confounded) table downgrades to association with the named reason', async () => {
  // Treated rows sit at income 8–10, controls at 0–2: the covariate distributions barely overlap.
  const evidence = await computeEffect(adjustmentRows({ unbalanced: true }), {
    ...baseSpec,
    design: 'covariate-adjustment',
    interferenceBandMeters: 500,
  }, publish)
  assert.equal(evidence.claimLevel, 'association', 'imbalance never reports causal')
  assert.ok(evidence.downgradeReasons.includes('imbalance-above-limit'))
  assert.ok((evidence.maxAbsSmd ?? 0) > BALANCE_SMD_LIMIT)
  // The interval still exists — the label carries the epistemics, not the absence of numbers.
  assert.ok(evidence.interval !== null)
})

test('an overlap violation downgrades with its named reason', async () => {
  const evidence = await computeEffect(adjustmentRows({ overlapBreak: true }), {
    ...baseSpec,
    design: 'covariate-adjustment',
    interferenceBandMeters: 500,
  }, publish)
  assert.equal(evidence.claimLevel, 'association')
  assert.ok(evidence.downgradeReasons.includes('overlap-below-limit'))
  assert.ok((evidence.minOverlapShare ?? 1) < OVERLAP_SHARE_MIN)
})

test('undeclared designs and unassessed interference stay at association', async () => {
  const noDesign = await computeEffect(adjustmentRows({}), baseSpec, publish)
  assert.equal(noDesign.claimLevel, 'association')
  assert.deepEqual(noDesign.downgradeReasons, ['no-identification-design', 'interference-not-assessed'])
  assert.equal(noDesign.design, 'none')

  const noBand = await computeEffect(adjustmentRows({}), {
    ...baseSpec,
    design: 'covariate-adjustment',
  }, publish)
  assert.equal(noBand.claimLevel, 'association')
  assert.deepEqual(noBand.downgradeReasons, ['interference-not-assessed'])

  const interference = await computeEffect(adjustmentRows({ interference: true }), {
    ...baseSpec,
    design: 'covariate-adjustment',
    interferenceBandMeters: 500,
  }, publish)
  assert.equal(interference.claimLevel, 'association')
  assert.ok(interference.downgradeReasons.includes('interference-suspected'))
  assert.ok((interference.interference.controlsWithTreatedNeighborShare ?? 0) > 0, 'treated neighbors of controls are counted')
})

test('all-treated or thin tables are honest unknowns, not effects', async () => {
  const uniform = adjustmentRows({}).map(row => ({ ...row, marks: { ...row.marks, policy: true } }))
  const evidence = await computeEffect(uniform, { ...baseSpec, design: 'covariate-adjustment', interferenceBandMeters: 500 }, publish)
  assert.equal(evidence.status, 'not_applicable')
  assert.equal(evidence.notApplicableReason, 'no-treatment-variation')
  assert.equal(evidence.claimLevel, 'unknown')
  assert.equal(evidence.interval, null)
})

test('difference-in-differences recovers the hand-computed delta with the Welch interval', async () => {
  // Six treated units move +10, six controls move +2 → effect 8.
  const rows = []
  for (let unit = 0; unit < 12; unit++) {
    const treated = unit % 2 === 0
    const baseline = 100 + unit
    for (const period of ['pre', 'post']) {
      const delta = treated ? 10 : 2
      rows.push({
        id: `${unit}-${period}`,
        coordinates: [116 + unit * 0.01, 39],
        values: {
          outcome: period === 'pre' ? baseline : baseline + delta,
          income: unit % 3,
        },
        marks: { policy: treated, period, district: `d${unit}` },
      })
    }
  }
  const evidence = await computeEffect(rows, {
    ...baseSpec,
    design: 'difference-in-differences',
    periodField: 'period',
    preValue: 'pre',
    postValue: 'post',
    unitField: 'district',
    interferenceBandMeters: 500,
    intervalLevel: 0.9,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.design, 'difference-in-differences')
  assert.equal(evidence.claimLevel, 'causal', JSON.stringify(evidence.downgradeReasons))
  const detail = evidence.did
  assert.ok(detail)
  assert.equal(detail.unitsUsed, 12)
  assert.equal(detail.treatedDeltaMean, 10)
  assert.equal(detail.controlDeltaMean, 2)
  const interval = evidence.interval
  assert.ok(interval)
  assert.ok(Math.abs(interval.estimate - 8) < 1e-12, `DiD estimate 8 (got ${interval.estimate})`)
  assert.equal(interval.level, 0.9)
  // Exact deltas → zero variance → the interval collapses onto the point.
  assert.ok(Math.abs(interval.low - 8) < 1e-9 && Math.abs(interval.high - 8) < 1e-9)
  // Incomplete panel units are named, never silently filled.
  assert.equal(detail.unitsDropped, 0)
})
