/**
 * Workload suite: every workload replays against the REAL production planes
 * (session projection rig, transactional catalog store, spatial-scale
 * worker) with reduced parameters, and its deterministic aggregate repeats
 * identically. A budget that refuses mid-workload keeps the accepted map
 * state — the refusal happens before the commit, never as a rollback.
 *
 * Requires the upstream `pnpm run build` and the map package build (the rig
 * resolves upstream built libs; sibling packages resolve through src).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { perfDigestOf, PERF_WORKLOAD_FIXTURE, validatePerfWorkload } from '../src/contract.ts'
import { generatePerfFixtures } from '../src/fixtures.ts'
import { PerfSampler } from '../src/instrument.ts'
import { PerfBudgetLedger } from '../src/budgets.ts'
import {
  runLocateVisibilityWorkload,
  runParseRegisterWorkload,
  runRecoveryWorkload,
  runSpatialOpWorkload,
  runTwoPointChain,
} from '../src/workloads.ts'
import { perfPortsOf } from './perf-rig.mjs'

const root = mkdtempSync(join(tmpdir(), 'perf-workloads-'))
const wired = await perfPortsOf(root)

test.after(async () => {
  await wired.dispose()
  rmSync(root, { recursive: true, force: true })
})

function reduced(overrides = {}) {
  const workload = {
    ...PERF_WORKLOAD_FIXTURE,
    repetitions: 2,
    locateLayerCount: 4,
    locateLayerFeatures: 40,
    parseFeatureCount: 200,
    spatialOpRepeats: 4,
    recoveryMutations: 6,
    ...overrides,
  }
  const issues = validatePerfWorkload(workload)
  assert.deepEqual(issues, [], 'the reduced workload must still validate')
  return workload
}

test('locate/visibility folds every add/hide/show through the real projection and repeats', async () => {
  const workload = reduced()
  const fixtures = generatePerfFixtures(workload)
  const ledger = new PerfBudgetLedger((await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS)
  const first = await runLocateVisibilityWorkload(wired.ports.main, new PerfSampler(), ledger, workload, fixtures)
  assert.equal(first.aggregate.folds, workload.repetitions * workload.locateLayerCount * 3)
  assert.equal(first.aggregate.layerCount, workload.locateLayerCount)
  assert.equal(first.aggregate.allVisible, true, 'every layer ends visible after the show fold')
  assert.equal(first.aggregate.foldedRevisionDelta, first.aggregate.folds, 'every fold applied — none refused, none duplicated')
  assert.equal(first.values.length, workload.repetitions)
  assert.ok(first.values.every(value => value > 0), 'folds per second is positive')
  const second = await runLocateVisibilityWorkload(wired.ports.main, new PerfSampler(), ledger, workload, fixtures)
  assert.equal(
    perfDigestOf(second.aggregate), perfDigestOf(first.aggregate),
    'the fold count/revision identity repeats identically across runs',
  )
})

test('parse/register admits, publishes, and reads back the frozen fixture through the real catalog', async () => {
  const workload = reduced()
  const fixtures = generatePerfFixtures(workload)
  const ledger = new PerfBudgetLedger((await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS)
  const raw = await runParseRegisterWorkload(wired.ports.catalog, new PerfSampler(), ledger, workload, fixtures, 'workload-spec', 1_000)
  assert.equal(raw.aggregate.featureCount, workload.parseFeatureCount)
  assert.ok(raw.aggregate.coordinateSum >= workload.parseFeatureCount, 'the admission walk counted every coordinate')
  assert.ok(raw.values.every(value => value > 0), 'features per second is positive')
})

test('spatial-op buffers the frozen polygon with identical area sums across runs', async () => {
  const workload = reduced()
  const fixtures = generatePerfFixtures(workload)
  const ledger = new PerfBudgetLedger((await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS)
  const sampler = new PerfSampler()
  const first = await runSpatialOpWorkload(sampler, ledger, workload, fixtures, 0.5)
  const second = await runSpatialOpWorkload(new PerfSampler(), ledger, workload, fixtures, 0.5)
  assert.equal(
    perfDigestOf(first.aggregate), perfDigestOf(second.aggregate),
    'the buffer+area aggregate is deterministic across runs',
  )
  assert.ok(first.aggregate.areaSum > 0)
  assert.ok(sampler.records.some(record => record.segment === 'mcp'), 'the codec segment is observed beside the compute segment')
})

test('recovery cold-replays a recorded session into the identical projection state', async () => {
  const workload = reduced()
  const ledger = new PerfBudgetLedger((await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS)
  const raw = await runRecoveryWorkload(wired.ports.recovery, new PerfSampler(), ledger, workload)
  assert.equal(raw.aggregate.mutations, workload.recoveryMutations)
  const revision = wired.ports.recovery.acceptedState().revision
  assert.equal(revision, workload.recoveryMutations, 'the live session folded every mutation')
  assert.ok(raw.values[0] >= 0)
})

test('the two-point chain selects the SECOND point, publishes, and folds the identified layer', async () => {
  const workload = reduced()
  const fixtures = generatePerfFixtures(workload)
  const ledger = new PerfBudgetLedger((await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS)
  const raw = await runTwoPointChain(wired.ports.main, wired.ports.catalog, new PerfSampler(), ledger, workload, fixtures, 'workload-spec', 2_000, 0.3)
  assert.equal(raw.aggregate.selectedFeatureIndex, 1, 'the audit scenario selects feature index 1')
  assert.ok(raw.aggregate.bufferLonMin > 9.9, 'the buffered geometry sits on the [10, 0] point, not the first')
  assert.match(raw.identity.artifactRef, /^art-/, 'the chain publishes a real artifact ref')
  const view = wired.ports.main.displayView()
  const folded = view.layers.find(layer => layer.id === 'two-point-chain')
  assert.ok(folded !== undefined && folded.visible, 'the chain layer folded visible')
  assert.equal(folded.resourceRef !== undefined, true, 'the folded layer carries its resource identity')
})

test('a mid-workload budget refusal happens before the commit and keeps the accepted map', async () => {
  const workload = reduced({ locateLayerCount: 2, locateLayerFeatures: 20, repetitions: 1 })
  const fixtures = generatePerfFixtures(workload)
  const before = wired.ports.main.acceptedState()
  const beforeRevision = before.revision
  const beforeJson = JSON.stringify(before)
  // A meta budget smaller than one layer's meta: the FIRST fold must refuse pre-commit.
  const ledger = new PerfBudgetLedger({
    ...(await import('../src/contract.ts')).PERF_DEPLOYMENT_BUDGETS,
    maxMetaBytes: 50,
  })
  await assert.rejects(
    () => runLocateVisibilityWorkload(wired.ports.main, new PerfSampler(), ledger, workload, fixtures),
    /maxMetaBytes/,
    'the workload surfaces the refusal instead of folding an over-budget mutation',
  )
  const after = wired.ports.main.acceptedState()
  assert.equal(after.revision, beforeRevision, 'the revision did not move — nothing folded')
  assert.equal(JSON.stringify(after), beforeJson, 'the accepted map state is byte-identical after the refusal')
})
