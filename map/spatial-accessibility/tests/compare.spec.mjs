/**
 * Candidate comparison gates: baseline and candidates re-evaluated on the
 * identical input versions, cost/feasibility screening with named reasons,
 * weight-perturbation sensitivity (an unstable ranking is exposed, not
 * hidden), the late-arriving old run that cannot override a newer goal, and
 * the deterministic fixed-revision export.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateComparison,
  projectComparison,
  createControlledNetworkProvider,
} from '../src/index.ts'

const BBOX = [116.0, 39.5, 116.2, 39.7]
const SPACING = 0.01
const NO_CHECKS = { throwIfCancelled() {} }

/** Grid node coordinate on the fixture lattice. */
function node(col, row) {
  return [116.0 + col * SPACING, 39.5 + row * SPACING]
}

/**
 * Comparison input over the analytic fixture. Communities: A=center (100,
 * covered by the baseline facility), B=east (200, only an eastern candidate
 * reaches it), C/E=north (90+80, only a northern candidate reaches them).
 */
function compareInput(overrides = {}) {
  return {
    spec: {
      goalRevision: 4,
      studyArea: { bbox: [116.05, 39.55, 116.15, 39.65] },
      retrievalExtent: { bbox: BBOX },
      analysisSupportExtent: { bbox: BBOX },
      observationWindow: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
      impedance: { travelMode: 'walk', maxMinutes: 15 },
      timeSlices: ['midday'],
      populationRef: 'res-pop@v3',
      populationField: 'population',
      facilityRefs: ['res-fac@v2'],
      methodVersion: 'p1-network-coverage@1',
      candidates: [
        { id: 'opt-east', label: 'eastern site', addFacilities: [{ id: 'fac-new-east', coordinates: node(12, 10), entrance: node(12, 10), capacity: 1000 }], cost: 0.2 },
        { id: 'opt-north', label: 'northern site', addFacilities: [{ id: 'fac-new-north', coordinates: node(10, 12), entrance: node(10, 12), capacity: 1000 }], cost: 0.1 },
      ],
      weights: { coverage: 1, equity: 0, cost: 0 },
      costBudget: 10,
    },
    population: [
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
      { id: 'u-far-east', coordinates: node(12, 10), population: 200, community: 'B' },
      { id: 'u-north', coordinates: node(10, 12), population: 90, community: 'C' },
      { id: 'u-north2', coordinates: node(10, 13), population: 80, community: 'E' },
    ],
    facilities: [{ id: 'fac-base', coordinates: node(10, 10), entrance: node(10, 10), capacity: 1000 }],
    provider: createControlledNetworkProvider({ bbox: BBOX, spacingDeg: SPACING }),
    ...overrides,
  }
}

test('every option is recomputed on the identical input versions with exact numbers', async () => {
  const outcome = await evaluateComparison(NO_CHECKS, compareInput())
  assert.equal(outcome.kind, 'candidate-comparison')
  // The baseline covers only the center unit; each candidate extends the
  // walk shed to its own communities.
  assert.equal(outcome.baseline.coveredPopulation, 100)
  assert.equal(outcome.baseline.coveredPopulation + outcome.baseline.uncoveredPopulation, 470)
  const east = outcome.candidates.find(option => option.optionId === 'opt-east')
  const north = outcome.candidates.find(option => option.optionId === 'opt-north')
  assert.equal(east.coveredPopulation, 300, 'the eastern site adds the 200-person eastern unit')
  assert.equal(north.coveredPopulation, 270, 'the northern site adds the 90+80 northern units')
  assert.equal(outcome.inputVersions.populationRef, 'res-pop@v3')
  assert.match(outcome.inputVersions.networkRef, /^controlled-lattice-[0-9a-f]{16}@1$/)
  assert.equal(outcome.inputVersions.methodVersion, 'p1-network-coverage@1')
  assert.equal(outcome.baseline.cost, 0, 'the status-quo anchor carries no cost')
})

test('the ranking follows the submitted weights', async () => {
  const coverage = await evaluateComparison(NO_CHECKS, compareInput({
    spec: { ...compareInput().spec, weights: { coverage: 1, equity: 0, cost: 0 } },
  }))
  assert.deepEqual(coverage.ranking, ['opt-east', 'opt-north', 'baseline'])

  const costConscious = await evaluateComparison(NO_CHECKS, compareInput({
    spec: { ...compareInput().spec, weights: { coverage: 0.04, equity: 0, cost: 1 } },
  }))
  // 0.04×(300/470) − 0.2 < 0.04×(270/470) − 0.1 < 0.04×(100/470): the
  // status quo wins once cost weighs against the candidates.
  assert.deepEqual(costConscious.ranking, ['baseline', 'opt-north', 'opt-east'])
})

test('an over-budget or invalid candidate is listed infeasible with its reason, never computed', async () => {
  const outcome = await evaluateComparison(NO_CHECKS, compareInput({
    spec: {
      ...compareInput().spec,
      costBudget: 4,
      candidates: [
        { id: 'opt-expensive', label: 'over budget', addFacilities: [{ id: 'fac-x', coordinates: node(12, 10) }], cost: 5 },
        { id: 'opt-zero-cap', label: 'dead capacity', addFacilities: [{ id: 'fac-y', coordinates: node(11, 10), capacity: 0 }], cost: 1 },
        { id: 'opt-cheap', label: 'within budget', addFacilities: [{ id: 'fac-z', coordinates: node(10, 12), entrance: node(10, 12) }], cost: 2 },
      ],
    },
  }))
  const expensive = outcome.candidates.find(option => option.optionId === 'opt-expensive')
  const zeroCap = outcome.candidates.find(option => option.optionId === 'opt-zero-cap')
  const cheap = outcome.candidates.find(option => option.optionId === 'opt-cheap')
  assert.equal(expensive.feasible, false)
  assert.equal(expensive.infeasibleReason, 'cost-over-budget')
  assert.equal(zeroCap.feasible, false)
  assert.equal(zeroCap.infeasibleReason, 'non-positive-capacity')
  assert.equal(zeroCap.evidence, null, 'an infeasible candidate is never computed')
  assert.equal(cheap.feasible, true)
  assert.equal(cheap.coveredPopulation, 270)
  assert.ok(!outcome.ranking.includes('opt-expensive'))
  assert.ok(!outcome.ranking.includes('opt-zero-cap'))
})

test('the weight perturbation exposes an unstable ranking instead of hiding it', async () => {
  // Coverage-heavy weights favor the eastern site; swapping coverage and
  // equity flips the ranking because the northern site serves more
  // communities: the comparison must report the instability.
  const outcome = await evaluateComparison(NO_CHECKS, compareInput({
    spec: {
      ...compareInput().spec,
      weights: { coverage: 2, equity: 0, cost: 1 },
    },
  }))
  assert.deepEqual(outcome.sensitivity.rankingBefore, ['opt-east', 'opt-north', 'baseline'])
  assert.deepEqual(outcome.sensitivity.rankingAfter, ['opt-north', 'opt-east', 'baseline'])
  assert.equal(outcome.sensitivity.rankingStable, false)
  assert.deepEqual(outcome.sensitivity.perturbedWeights, { coverage: 0, equity: 2, cost: 1 })
  assert.deepEqual(outcome.sensitivity.rankingBefore, outcome.ranking, 'the reported ranking keeps the submitted weights')

  // Equal coverage/equity weights keep the swap an identity: the ranking
  // holds and the comparison reports it stable.
  const stable = await evaluateComparison(NO_CHECKS, compareInput({
    spec: { ...compareInput().spec, weights: { coverage: 1, equity: 1, cost: 1 } },
  }))
  assert.deepEqual(stable.ranking, ['opt-north', 'opt-east', 'baseline'])
  assert.equal(stable.sensitivity.rankingStable, true)
})

test('a late-arriving old run cannot override the current goal revision', async () => {
  const outcome = await evaluateComparison(NO_CHECKS, compareInput())
  assert.equal(outcome.goalRevision, 4)
  const current = projectComparison(outcome, 4)
  assert.equal(current.applied, true)
  assert.equal(current.refusal, undefined)

  // The user changed the goal (revision 5) while the old run was in flight.
  const stale = projectComparison(outcome, 5)
  assert.equal(stale.applied, false)
  assert.equal(stale.refusal, 'goal-revision-stale')
  assert.equal(stale.projection, undefined, 'a stale comparison produces no applicable projection')
})

test('the export is a fixed revision: identical inputs re-export identical records', async () => {
  const outcomeA = await evaluateComparison(NO_CHECKS, compareInput())
  const outcomeB = await evaluateComparison(NO_CHECKS, compareInput())
  assert.equal(outcomeA.comparisonDigest, outcomeB.comparisonDigest, 'the comparison digest is deterministic over the same inputs')

  const exportA = projectComparison(outcomeA, 4).projection
  const exportB = projectComparison(outcomeB, 4).projection
  assert.deepEqual(exportB, exportA, 're-export of the same outcome is identical')
  assert.match(exportA.contentRevision, /^[0-9a-f]{24}$/)

  // The projection carries map layers in ranking order and the fixed report.
  assert.deepEqual(exportA.mapLayers.map(layer => layer.optionId), exportA.ranking)
  assert.equal(exportA.report.baselineOptionId, 'baseline')
  assert.ok(exportA.report.limitations.some(line => line.includes('not a global facility-location optimum')))
  assert.equal(exportA.report.sensitivityStable, outcomeA.sensitivity.rankingStable)
  const baselineLayer = exportA.mapLayers.find(layer => layer.optionId === 'baseline')
  assert.equal(baselineLayer.coveredPopulation, 100)

  // A different input (weights) yields a different fixed revision.
  const other = await evaluateComparison(NO_CHECKS, compareInput({
    spec: { ...compareInput().spec, weights: { coverage: 0.9, equity: 0.1, cost: 0 } },
  }))
  assert.notEqual(other.comparisonDigest, outcomeA.comparisonDigest)
  assert.notEqual(projectComparison(other, 4).projection.contentRevision, exportA.contentRevision)
})
