/**
 * Coverage computation gates over an analytic lattice: exact population
 * answers hand-derived from the grid arithmetic (vertical edges are
 * 111.19 km/° × 0.01° at walk speed), conservation and double-count
 * structural rules, entrance/barrier/capacity semantics, cross-boundary
 * retention, partial and empty outcomes, and the method-not-applicable
 * refusal that keeps a missing network from ever becoming a buffer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  computeCoverage,
  createControlledNetworkProvider,
} from '../src/index.ts'

const BBOX = [116.0, 39.5, 116.2, 39.7]
const SPACING = 0.01
/** Walk minutes for one vertical 0.01° edge at midday: 111.19 × 0.01 / 4.5 × 60. */
const VERTICAL_MINUTES = 111.19 * SPACING / 4.5 * 60

const NO_CHECKS = { throwIfCancelled() {} }

/** Node coordinate at grid position (col, row) of the fixture lattice. */
function node(col, row) {
  return [116.0 + col * SPACING, 39.5 + row * SPACING]
}

/** Default compute input over the fixture lattice. */
function input(overrides = {}) {
  return {
    spec: {
      goalRevision: 1,
      studyArea: { bbox: [116.05, 39.55, 116.15, 39.65] },
      retrievalExtent: { bbox: BBOX },
      analysisSupportExtent: { bbox: BBOX },
      observationWindow: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
      impedance: { travelMode: 'walk', maxMinutes: 15 },
      timeSlices: ['midday'],
      populationRef: 'res-pop@v1',
      populationField: 'population',
      facilityRefs: ['res-fac@v1'],
      methodVersion: 'p1-network-coverage@1',
    },
    provider: createControlledNetworkProvider({ bbox: BBOX, spacingDeg: SPACING }),
    population: [],
    facilities: [],
    ...overrides,
  }
}

test('the analytic fixture answers coverage with exact numbers (walk network, not a buffer)', async () => {
  // Budget 15 walk minutes reaches the origin node plus its four lattice
  // neighbours (vertical edges ≈14.83 min, horizontal ≈11.43 min) and
  // nothing two edges out. The units sit exactly on grid nodes.
  const compute = input({
    population: [
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
      { id: 'u-east', coordinates: node(11, 10), population: 50, community: 'A' },
      { id: 'u-north', coordinates: node(10, 11), population: 30, community: 'B' },
      { id: 'u-far', coordinates: node(12, 10), population: 200, community: 'B' },
    ],
    facilities: [{ id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) }],
  })
  assert.ok(VERTICAL_MINUTES > 14 && VERTICAL_MINUTES < 15, `the fixture arithmetic must keep the vertical edge inside the budget (${VERTICAL_MINUTES.toFixed(2)})`)
  const { outcome, evidence } = await computeCoverage(NO_CHECKS, compute)
  assert.equal(outcome, 'complete')
  assert.equal(evidence.denominator.totalPopulation, 380)
  assert.equal(evidence.coveredPopulation, 180, 'center + east + north are within 15 walk minutes')
  assert.equal(evidence.uncoveredPopulation, 200, 'the two-edge unit is outside the budget')
  assert.ok(Math.abs(evidence.coverageRatio - 180 / 380) < 1e-12)
  // Conservation and no-double-counting hold structurally.
  assert.equal(evidence.coveredPopulation + evidence.uncoveredPopulation, evidence.denominator.totalPopulation)
  assert.equal(evidence.perCommunity.reduce((sum, row) => sum + row.covered, 0), evidence.coveredPopulation)
  assert.equal(evidence.consumedFeatureCount, 5)
  assert.equal(evidence.kind, 'network-coverage')
})

test('two facilities reaching one unit still count its population exactly once', async () => {
  const compute = input({
    population: [
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
      { id: 'u-west', coordinates: node(9, 10), population: 20, community: 'A' },
    ],
    facilities: [
      { id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) },
      { id: 'fac-2', coordinates: node(10, 9), entrance: node(10, 9) },
    ],
  })
  const { evidence } = await computeCoverage(NO_CHECKS, compute)
  assert.equal(evidence.coveredPopulation, 120, 'the shared center unit is assigned to exactly one facility')
  assert.equal(evidence.coveredPopulation + evidence.uncoveredPopulation, evidence.denominator.totalPopulation)
  const communityA = evidence.perCommunity.find(row => row.community === 'A')
  assert.equal(communityA.covered, 120)
})

test('a facility without an entrance cannot join the network and degrades the run to partial', async () => {
  const compute = input({
    population: [
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
      { id: 'u-north', coordinates: node(10, 11), population: 30, community: 'B' },
    ],
    facilities: [
      { id: 'fac-good', coordinates: node(10, 10), entrance: node(10, 10) },
      { id: 'fac-no-entrance', coordinates: node(11, 11) },
    ],
  })
  const { outcome, evidence } = await computeCoverage(NO_CHECKS, compute)
  assert.equal(outcome, 'partial')
  assert.ok(evidence.diagnostics.some(entry => entry.code === 'entrance-missing' && entry.facilityId === 'fac-no-entrance'))
  assert.equal(evidence.coveredPopulation, 130)
  assert.equal(evidence.consumedFeatureCount, 3, 'the excluded facility left the consumed count')
})

test('a spec entrance rescues a facility; a blocked barrier severs it again', async () => {
  const entrances = [{ facilityId: 'fac-2', coordinates: node(10, 11) }]
  const rescued = await computeCoverage(NO_CHECKS, input({
    facilities: [{ id: 'fac-2', coordinates: node(10, 11) }],
    population: [{ id: 'u-at-11', coordinates: node(10, 11), population: 40, community: 'A' }],
    spec: { ...input().spec, entrances },
  }))
  assert.equal(rescued.evidence.coveredPopulation, 40, 'the spec-level entrance puts the facility on the network')

  // A wall across the vertical edge between the facility and its only unit.
  const wall = { from: [116.1, 39.605], to: [116.1, 39.606], kind: 'blocked' }
  const severed = await computeCoverage(NO_CHECKS, input({
    facilities: [{ id: 'fac-2', coordinates: node(10, 10), entrance: node(10, 10) }],
    population: [{ id: 'u-at-11', coordinates: node(10, 11), population: 40, community: 'A' }],
    spec: { ...input().spec, barriers: [wall] },
  }))
  assert.equal(severed.evidence.coveredPopulation, 0, 'the blocked edge leaves the unit with no walk path')
  assert.equal(severed.evidence.uncoveredPopulation, 40)
})

test('capacity is a hard cap: overflow stays uncovered with exact numbers', async () => {
  const spec = {
    ...input().spec,
    capacity: { perFacility: { 'fac-1': 125 }, assignment: 'nearest-first' },
  }
  const { evidence } = await computeCoverage(NO_CHECKS, input({
    spec,
    population: [
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
      { id: 'u-east', coordinates: node(11, 10), population: 50, community: 'A' },
    ],
    facilities: [{ id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) }],
  }))
  assert.equal(evidence.coveredPopulation, 100, 'the first 100 fit; the next unit (50) exceeds the remaining 25')
  assert.equal(evidence.uncoveredPopulation, 50)
  assert.ok(evidence.limitations.some(line => line.includes('capacity')))
})

test('an out-of-study facility inside the support extent keeps serving; outside support is excluded', async () => {
  const compute = input({
    population: [
      { id: 'u-near-west', coordinates: node(5, 10), population: 40, community: 'A' },
      { id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' },
    ],
    facilities: [
      { id: 'fac-in', coordinates: node(10, 10), entrance: node(10, 10) },
      // At 116.04: outside the study area (west of 116.05) but inside the
      // support extent — the method's cross-boundary retention.
      { id: 'fac-cross', coordinates: node(4, 10), entrance: node(4, 10) },
      // Outside the support extent entirely.
      { id: 'fac-far', coordinates: [116.21, 39.6], entrance: [116.21, 39.6] },
    ],
  })
  const { evidence } = await computeCoverage(NO_CHECKS, compute)
  assert.equal(evidence.coveredPopulation, 140, 'the cross-boundary facility still serves its neighbourhood')
  assert.ok(evidence.diagnostics.some(entry => entry.message.includes('retained') && entry.message.includes('fac-cross')), 'the retention note names the cross-boundary facility')
  assert.ok(evidence.diagnostics.some(entry => entry.code === 'outside-support' && entry.facilityId === 'fac-far'))
})

test('a provider fault mid-computation yields partial coverage, never a silent full answer', async () => {
  const provider = createControlledNetworkProvider({
    bbox: BBOX,
    spacingDeg: SPACING,
    faults: [{ op: 'serviceArea', nth: 2, code: 'RATE_LIMITED' }],
  })
  const { outcome, evidence } = await computeCoverage(NO_CHECKS, input({
    provider,
    population: [{ id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' }],
    facilities: [
      { id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) },
      { id: 'fac-2', coordinates: node(10, 11), entrance: node(10, 11) },
    ],
  }))
  assert.equal(outcome, 'partial')
  assert.ok(evidence.diagnostics.some(entry => entry.code === 'provider-read-partial' && entry.facilityId === 'fac-2'))
  assert.equal(evidence.coveredPopulation, 100, 'the surviving facility still reports its real coverage')
})

test('zero facilities is empty, a lost denominator is empty, and artifacts publish through the seam', async () => {
  const published = []
  const empty = await computeCoverage(NO_CHECKS, input({
    population: [{ id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' }],
    facilities: [],
    publishArtifact: async (label, bytes) => {
      published.push({ label, bytes })
      return { ref: `art-${label}@v1` }
    },
  }))
  assert.equal(empty.outcome, 'empty')
  assert.equal(empty.evidence.coveredPopulation, 0)
  assert.equal(empty.evidence.uncoveredPopulation, 100)
  assert.deepEqual(empty.evidence.artifacts, [{ label: 'coverage-empty', ref: 'art-coverage-empty@v1' }])
  assert.equal(published.length, 1)

  // A population table with no valid unit has no denominator: empty, with
  // the invalid unit named.
  const noDenominator = await computeCoverage(NO_CHECKS, input({
    population: [{ id: 'u-bad', coordinates: node(10, 10), population: Number.NaN, community: 'A' }],
    facilities: [{ id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) }],
  }))
  assert.equal(noDenominator.outcome, 'empty')
  assert.equal(noDenominator.evidence.denominator.invalidUnitCount, 1)
  assert.ok(noDenominator.evidence.diagnostics.some(entry => entry.code === 'population-invalid'))
})

test('a walk target over a network without walk pricing is method_not_applicable', async () => {
  const driveOnly = createControlledNetworkProvider({ bbox: BBOX, spacingDeg: SPACING, speedKmhPerMode: { walk: undefined } })
  await assert.rejects(
    () => computeCoverage(NO_CHECKS, input({
      provider: driveOnly,
      population: [{ id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' }],
      facilities: [{ id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) }],
    })),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
  )
})

test('the evidence record carries the full denominator and input identity', async () => {
  const { evidence } = await computeCoverage(NO_CHECKS, input({
    population: [{ id: 'u-center', coordinates: node(10, 10), population: 100, community: 'A' }],
    facilities: [{ id: 'fac-1', coordinates: node(10, 10), entrance: node(10, 10) }],
  }))
  assert.deepEqual(evidence.denominator.observationWindow, { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' })
  assert.equal(evidence.denominator.doubleCountingRule, 'assign-nearest-once')
  assert.equal(evidence.denominator.unitCount, 1)
  assert.equal(evidence.methodVersion, 'p1-network-coverage@1')
  assert.match(evidence.inputRefs.networkRef, /^controlled-lattice-[0-9a-f]{16}@1$/)
  assert.deepEqual(evidence.inputRefs.facilityRefs, ['res-fac@v1'])
  assert.ok(evidence.limitations.some(line => line.includes('never substituted')))
  assert.deepEqual(evidence.perSlice.map(row => row.slice), ['midday'])
})
