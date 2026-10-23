/**
 * Scenario-optimization fixtures: hand-computed objectives with the status
 * quo as the implicit zero point, infeasible candidates kept with named
 * reasons and no rank, the recorded default scenario flagged, the documented
 * weight-sweep set flipping exactly the constructed ranking, greedy
 * allocation respecting capacity and budget with the honest partial state,
 * the deterministic tie-break, and the no-feasible-candidate refusal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SCENARIO_WEIGHTS, DECISION_METHOD_VERSION } from '../src/contract.ts'
import { allocateLocations, compareScenarios } from '../src/optimize.ts'

const publish = async (label) => ({ ref: `art-${label}@v1` })
const METHOD = DECISION_METHOD_VERSION

const compareSpec = {
  goalRevision: 1,
  groups: [{ id: 'north', demand: 100 }, { id: 'south', demand: 100 }],
  candidates: [
    { id: 'X', cost: 50, servedByGroup: { north: 100, south: 0 } },
    { id: 'Y', cost: 50, servedByGroup: { north: 50, south: 50 } },
    { id: 'Z', cost: 200, servedByGroup: { north: 100, south: 100 } },
  ],
  budget: 100,
  weights: { coverage: 0.5, equity: 0.3, cost: 0.2 },
  methodVersion: METHOD,
}

test('the comparison ranks hand-computed objectives and keeps the infeasible candidate named', async () => {
  const evidence = await compareScenarios(compareSpec, publish)
  assert.equal(evidence.status, 'succeeded')
  // X: coverage 0.5, worst 0, cost/budget 0.5 → 0.25 + 0 − 0.1 = 0.15.
  // Y: coverage 0.5, worst 0.5, cost/budget 0.5 → 0.25 + 0.15 − 0.1 = 0.30.
  // Z: cost 200 > budget 100 → infeasible, kept with its reason and no rank.
  const x = evidence.rows.find(row => row.id === 'X')
  const y = evidence.rows.find(row => row.id === 'Y')
  const z = evidence.rows.find(row => row.id === 'Z')
  assert.ok(x && y && z)
  assert.ok(Math.abs(x.objective - 0.15) < 1e-12, `X objective (got ${x.objective})`)
  assert.ok(Math.abs(y.objective - 0.30) < 1e-12, `Y objective (got ${y.objective})`)
  assert.equal(evidence.topId, 'Y')
  assert.equal(x.rank, 2)
  assert.equal(y.rank, 1)
  assert.equal(z.feasible, false)
  assert.deepEqual(z.infeasibleReasons, ['over-budget'])
  assert.equal(z.rank, null)
  assert.equal(z.beatsStatusQuo, false)
  assert.ok(y.beatsStatusQuo, 'the status quo is the implicit zero point')
  // Sensitivity: every scenario picks a feasible candidate; the ranking here is stable.
  assert.equal(evidence.sensitivity.length, 6, 'the fixed sweep set is 3 weights × 2 multipliers')
  assert.equal(evidence.rankStable, true)
})

test('overpromising a group is an infeasible candidate, not a clamped winner', async () => {
  const evidence = await compareScenarios({
    ...compareSpec,
    candidates: [
      ...compareSpec.candidates,
      { id: 'W', cost: 10, servedByGroup: { north: 150 } },
    ],
  }, publish)
  const w = evidence.rows.find(row => row.id === 'W')
  assert.ok(w)
  assert.equal(w.feasible, false)
  assert.deepEqual(w.infeasibleReasons, ['overpromise:north'])
  assert.ok(evidence.limitations.some(line => line.includes('not a global optimum')))
})

test('an absent weight block selects the recorded default scenario and says so', async () => {
  const evidence = await compareScenarios({ ...compareSpec, weights: undefined }, publish)
  assert.equal(evidence.defaultScenario, true)
  const y = evidence.rows.find(row => row.id === 'Y')
  // Recomputed with DEFAULT_SCENARIO_WEIGHTS — the same values, but now flagged as a default.
  assert.ok(Math.abs(y.objective - 0.3) < 1e-12)
  const declared = await compareScenarios({ ...compareSpec, weights: DEFAULT_SCENARIO_WEIGHTS }, publish)
  assert.equal(declared.defaultScenario, false, 'explicitly declared defaults are caller values')
})

test('the weight sweep flips exactly the constructed ranking (equity vs coverage+cost)', async () => {
  const spec = {
    goalRevision: 1,
    groups: [{ id: 'a', demand: 100 }, { id: 'b', demand: 100 }],
    candidates: [
      { id: 'P', cost: 0, servedByGroup: { a: 100, b: 0 } },
      { id: 'Q', cost: 60, servedByGroup: { a: 50, b: 50 } },
    ],
    budget: 100,
    weights: { coverage: 0.8, equity: 0.1, cost: 0.1 },
    methodVersion: METHOD,
  }
  const evidence = await compareScenarios(spec, publish)
  assert.equal(evidence.topId, 'P', 'P wins under the declared weights (0.4 vs 0.39)')
  const equityDouble = evidence.sensitivity.find(row => row.label === 'equity×2')
  assert.ok(equityDouble)
  assert.equal(equityDouble.topId, 'Q', 'doubling equity flips the ranking to Q')
  assert.equal(evidence.rankStable, false, 'the flip is reported, never smoothed away')
})

test('allocation respects capacity and budget and reports the honest partial state', async () => {
  const spec = {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    groupField: 'group',
    sites: [
      { id: 's1', lon: 116.0, lat: 39.0, capacity: 15, cost: 5 },
      { id: 's2', lon: 116.04, lat: 39.0, capacity: 15, cost: 5 },
    ],
    coverageRadiusMeters: 2000,
    budget: 20,
    methodVersion: METHOD,
  }
  const rows = [
    { id: 'd1', coordinates: [116.0, 39.0], demand: 10, group: 'g1' },
    { id: 'd2', coordinates: [116.005, 39.0], demand: 10, group: 'g1' },
    { id: 'd3', coordinates: [116.04, 39.0], demand: 10, group: 'g2' },
    { id: 'd4', coordinates: [116.045, 39.0], demand: 10, group: 'g2' },
  ]
  const evidence = await allocateLocations(rows, spec, publish)
  // Total demand 40, openable capacity 15+15=30 → shortfall 10; two demand rows cannot be fully served.
  assert.equal(evidence.status, 'partial')
  assert.equal(evidence.capacityShortfall, 10)
  assert.equal(evidence.totalDemand, 40)
  assert.equal(evidence.coveredDemand, 30)
  assert.equal(evidence.uncoveredRows, 2, 'partially served rows count as uncovered, not silently filled')
  const opened = evidence.sites.filter(site => site.opened)
  assert.equal(opened.length, 2)
  assert.ok(Math.abs(opened.reduce((s, site) => s + site.assignedDemand, 0) - 30) < 1e-12)
  // Equity groups report their own coverage shares.
  for (const group of evidence.groups) {
    assert.ok(Math.abs(group.share - 0.75) < 1e-12, `group ${group.group} covered 15/20 (got ${group.share})`)
  }
  assert.equal(evidence.defaultScenario, true)
})

test('sites above the budget stay closed and named; an empty affordable set refuses honestly', async () => {
  const spec = {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites: [
      { id: 'cheap', lon: 116.0, lat: 39.0, capacity: 20, cost: 5 },
      { id: 'pricey', lon: 116.01, lat: 39.0, capacity: 20, cost: 6 },
    ],
    coverageRadiusMeters: 2000,
    budget: 5,
    methodVersion: METHOD,
  }
  const rows = [
    { id: 'd1', coordinates: [116.0, 39.0], demand: 10, group: 'g' },
    { id: 'd2', coordinates: [116.01, 39.0], demand: 10, group: 'g' },
  ]
  const evidence = await allocateLocations(rows, spec, publish)
  assert.ok(evidence.limitations.some(line => line.includes('pricey')), 'the unaffordable site is named')
  const pricey = evidence.sites.find(site => site.id === 'pricey')
  assert.equal(pricey?.opened, false)

  const refused = await allocateLocations(rows, { ...spec, budget: 1 }, publish)
  assert.equal(refused.status, 'not_applicable')
  assert.equal(refused.notApplicableReason, 'no-feasible-candidate')
})

test('the greedy rule is deterministic with its documented id tie-break', async () => {
  const spec = {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites: [
      { id: 'twin-b', lon: 116.0, lat: 39.0, capacity: 20, cost: 5 },
      { id: 'twin-a', lon: 116.0, lat: 39.0, capacity: 20, cost: 5 },
    ],
    coverageRadiusMeters: 2000,
    budget: 5,
    methodVersion: METHOD,
  }
  const rows = [{ id: 'd1', coordinates: [116.0, 39.0], demand: 10, group: 'g' }]
  const first = await allocateLocations(rows, spec, publish)
  const second = await allocateLocations(rows, spec, publish)
  assert.deepEqual(first.sites, second.sites, 'same inputs reproduce the same allocation')
  const opened = first.sites.filter(site => site.opened).map(site => site.id)
  assert.deepEqual(opened, ['twin-a'], 'a perfect tie opens the lexicographically smaller id')
  assert.equal(first.rankStable, true, 'no budget headroom means no scenario can change the set')
})

test('global mode enumerates the declared domain and reports its greedy delta', async () => {
  const base = {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites: [
      { id: 'A', lon: 116.00, lat: 39, capacity: 13, cost: 1 },
      { id: 'B', lon: 116.05, lat: 39, capacity: 14, cost: 3 },
      { id: 'C', lon: 116.03, lat: 39, capacity: 5, cost: 2 },
      { id: 'D', lon: 116.03, lat: 39, capacity: 7, cost: 1 },
    ],
    coverageRadiusMeters: 3000,
    budget: 8,
    methodVersion: METHOD,
  }
  const rows = [
    { id: 'd0', coordinates: [116.03, 39], demand: 15, group: 'g0' },
    { id: 'd1', coordinates: [116.07, 39], demand: 7, group: 'g1' },
    { id: 'd2', coordinates: [116.07, 39], demand: 9, group: 'g0' },
    { id: 'd3', coordinates: [116.06, 39], demand: 15, group: 'g1' },
  ]
  const greedy = await allocateLocations(rows, { ...base, mode: 'greedy' }, publish)
  const global = await allocateLocations(rows, { ...base, mode: 'global' }, publish)
  assert.deepEqual(greedy.openedSiteIds, ['A'])
  assert.deepEqual(global.openedSiteIds, ['B', 'D'])
  assert.equal(global.mode, 'global')
  assert.equal(global.enumeration.domain, 'declared-affordable-sites')
  assert.equal(global.enumeration.totalSubsets, 16)
  assert.equal(global.enumeration.evaluatedSubsets, 16)
  assert.ok(global.objective > greedy.objective)
  assert.ok(global.objectiveDeltaVsGreedy > 0)
  assert.equal(global.greedyObjective, greedy.objective)
  assert.ok(global.limitations.some(line => line.includes('optimal only over the declared affordable site set')))
})

test('global mode refuses an oversized subset domain and points to greedy or partitioning', async () => {
  const sites = Array.from({ length: 13 }, (_, index) => ({
    id: `s${String(index).padStart(2, '0')}`,
    lon: 116,
    lat: 39,
    capacity: 10,
    cost: 1,
  }))
  const evidence = await allocateLocations([
    { id: 'd1', coordinates: [116, 39], demand: 1, group: 'g' },
  ], {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites,
    coverageRadiusMeters: 1000,
    budget: 13,
    mode: 'global',
    methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'not_applicable')
  assert.equal(evidence.notApplicableReason, 'combination-domain-too-large')
  assert.equal(evidence.enumeration.totalSubsets, 8192)
  assert.ok(evidence.limitations.some(line => line.includes('mode=greedy')))
})

test('global mode handles a zero budget without producing NaN for free sites', async () => {
  const evidence = await allocateLocations([
    { id: 'd1', coordinates: [116, 39], demand: 10, group: 'g' },
  ], {
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites: [
      { id: 'free', lon: 116, lat: 39, capacity: 10, cost: 0 },
      { id: 'paid', lon: 116, lat: 39, capacity: 10, cost: 1 },
    ],
    coverageRadiusMeters: 1000,
    budget: 0,
    mode: 'global',
    methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.deepEqual(evidence.openedSiteIds, ['free'])
  assert.ok(Number.isFinite(evidence.objective))
  assert.ok(Number.isFinite(evidence.greedyObjective))
})
