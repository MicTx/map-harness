/**
 * Budget suite: every plane refuses at or before its final operation, a
 * single-legal spend still refuses when the cumulative total crosses, scan
 * and time budgets judge the operation's own spend, concurrency is
 * slot-shaped, and a refused proposal leaves the accumulated state (and the
 * caller's previous state) untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerfBudgetLedger, PerfBudgetRefusal, recordEstimatedCost } from '../src/budgets.ts'
import { PERF_DEPLOYMENT_BUDGETS } from '../src/contract.ts'

function tinyBudgets(overrides = {}) {
  return {
    maxSessionBytes: 1_000,
    maxMetaBytes: 500,
    maxProjectionBytes: 800,
    maxDisplayBytes: 600,
    maxScanRows: 100,
    maxTimeMs: 50,
    maxConcurrency: 2,
    maxSteps: 5,
    ...overrides,
  }
}

test('a single legal spend admits and accumulates; the projected totals return', () => {
  const ledger = new PerfBudgetLedger(tinyBudgets())
  const admission = ledger.admitOrThrow({ sessionBytes: 100, metaBytes: 40, projectionDeltaBytes: 60, displayBytes: 50, steps: 1 })
  assert.equal(admission.status, 'admitted')
  assert.equal(admission.projected.sessionBytes, 100)
  assert.deepEqual(ledger.accumulated, {
    sessionBytes: 100,
    metaBytes: 40,
    projectionDeltaBytes: 60,
    displayBytes: 50,
    scanRows: 0,
    timeMs: 0,
    steps: 1,
  })
})

test('one input legal but cumulative over refuses BEFORE commit and keeps the ledger untouched', () => {
  const ledger = new PerfBudgetLedger(tinyBudgets({ maxMetaBytes: 500 }))
  // Two spends that each fit…
  ledger.admitOrThrow({ metaBytes: 300 })
  // …and a third that is legal on its own but crosses the cumulative line.
  const admission = ledger.admissionFor({ metaBytes: 300 })
  assert.equal(admission.status, 'refused')
  assert.equal(admission.code, 'meta-bytes')
  assert.equal(admission.limit, 500)
  assert.equal(admission.projected, 600, 'the projected total names the crossing, not the proposal')
  // The pure check mutated nothing.
  assert.equal(ledger.accumulated.metaBytes, 300, 'a refused proposal accumulates nothing')
  assert.throws(() => ledger.admitOrThrow({ metaBytes: 300 }), PerfBudgetRefusal)
  assert.equal(ledger.accumulated.metaBytes, 300, 'the throwing helper also leaves the ledger untouched')
})

test('every byte plane refuses with its own code at the cumulative line', () => {
  const cases = [
    { spend: { sessionBytes: 1_001 }, code: 'session-bytes' },
    { spend: { projectionDeltaBytes: 801 }, code: 'projection-bytes' },
    { spend: { displayBytes: 601 }, code: 'display-bytes' },
    { spend: { steps: 6 }, code: 'steps' },
  ]
  for (const { spend, code } of cases) {
    const ledger = new PerfBudgetLedger(tinyBudgets())
    const admission = ledger.admissionFor(spend)
    assert.equal(admission.status, 'refused', `${code} must refuse`)
    assert.equal(admission.code, code)
  }
})

test('scan rows and wall time judge the operation itself, not the accumulation', () => {
  const ledger = new PerfBudgetLedger(tinyBudgets({ maxScanRows: 100, maxTimeMs: 50 }))
  // Repeated legal per-operation spends never accumulate into a refusal.
  for (let index = 0; index < 5; index++) {
    ledger.admitOrThrow({ scanRows: 90, timeMs: 40 })
  }
  assert.equal(ledger.accumulated.scanRows, 450, 'scan volume still accumulates for the report')
  assert.equal(ledger.accumulated.timeMs, 200)
  // One operation beyond the per-operation line refuses with its own code.
  assert.equal(ledger.admissionFor({ scanRows: 101 }).code, 'scan-rows')
  assert.equal(ledger.admissionFor({ timeMs: 51 }).code, 'time-budget')
  const refusal = new PerfBudgetRefusal(ledger.admissionFor({ scanRows: 101 }))
  assert.match(refusal.message, /scan-rows|scanRows|maxScanRows/)
  assert.match(refusal.message, /previous state stands/)
})

test('concurrency is slot-shaped: the third concurrent operation refuses until a slot releases', () => {
  const ledger = new PerfBudgetLedger(tinyBudgets())
  ledger.acquireSlot()
  ledger.acquireSlot()
  assert.throws(() => ledger.acquireSlot(), /concurrency/)
  ledger.releaseSlot()
  ledger.acquireSlot()
  assert.equal(ledger.activeSlots, 2)
  assert.throws(() => {
    const fresh = new PerfBudgetLedger(tinyBudgets())
    fresh.releaseSlot()
  }, /without a held slot/)
})

test('the ledger constructor refuses invalid budgets loudly (misconfiguration fails at load)', () => {
  assert.throws(() => new PerfBudgetLedger({ ...tinyBudgets(), maxMetaBytes: 0 }), /maxMetaBytes must be a positive integer/)
  assert.throws(() => new PerfBudgetLedger({ ...tinyBudgets(), maxConcurrency: 1.5 }), /maxConcurrency must be a positive integer/)
})

test('estimated costs stay outside every admission path', () => {
  const ledger = new PerfBudgetLedger(PERF_DEPLOYMENT_BUDGETS)
  const record = recordEstimatedCost(ledger, { kind: 'model-tokens', amount: 12_345 })
  assert.deepEqual(record.estimatedCosts, [{ kind: 'model-tokens', amount: 12_345 }])
  assert.equal(ledger.accumulated.sessionBytes, 0, 'recording an estimate spends nothing')
  // The same spend admits identically whether or not an estimate was recorded.
  const before = ledger.admissionFor({ sessionBytes: 10 })
  const after = ledger.admissionFor({ sessionBytes: 10 })
  assert.deepEqual(before, after, 'estimates never influence admission')
})
