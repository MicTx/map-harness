/**
 * Budget ledger units: preflight refusals before expensive actions, the
 * charge model, remediation accounting, and config validation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkBudget,
  checkGapRetry,
  foldConsumption,
  foldContextBytes,
  foldGapRetry,
  foldStep,
  initialBudgetLedger,
  resolveBudgetConfig,
  DEFAULT_BUDGET_CONFIG,
} from '../src/budget.ts'

const CONFIG = {
  maxModelSteps: 3,
  maxMetaBytes: 100,
  maxContextBytes: 200,
  maxScanFeatures: 10,
  maxElapsedMs: 60_000,
  maxGapRetries: 2,
}

test('preflight refuses before an action spends, covering every counter', () => {
  const zero = initialBudgetLedger()
  assert.equal(checkBudget(zero, CONFIG, 0, undefined), undefined, 'a fresh ledger admits actions')

  assert.equal(
    checkBudget({ ...zero, stepsUsed: 3 }, CONFIG, 0, undefined)?.code,
    'steps-exhausted',
    'step budget exhausted',
  )
  assert.equal(
    checkBudget({ ...zero, metaBytes: 90 }, CONFIG, 0, undefined, { metaBytes: 20 })?.code,
    'meta-bytes-exhausted',
    'a charge that does not fit refuses instead of half-spending',
  )
  assert.equal(
    checkBudget({ ...zero, metaBytes: 90 }, CONFIG, 0, undefined, { metaBytes: 10 }),
    undefined,
    'an exact fit is allowed',
  )
  assert.equal(
    checkBudget({ ...zero, contextBytes: 200 }, CONFIG, 0, undefined, { contextBytes: 1 })?.code,
    'context-bytes-exhausted',
    'context bytes exhausted',
  )
  assert.equal(
    checkBudget({ ...zero, scanFeatures: 10 }, CONFIG, 0, undefined)?.code,
    'scan-exhausted',
    'scan budget exhausted',
  )
  assert.equal(
    checkBudget(zero, CONFIG, 61_000, 1_000)?.code,
    'time-exhausted',
    'elapsed time since the goal exceeds the bound',
  )
  assert.equal(
    checkBudget(zero, CONFIG, 61_000, undefined),
    undefined,
    'no goal accepted yet: no time bound to check',
  )
})

test('folds are additive and never reset', () => {
  let ledger = initialBudgetLedger()
  ledger = foldStep(ledger)
  ledger = foldStep(ledger)
  ledger = foldConsumption(ledger, 50, 4)
  ledger = foldContextBytes(ledger, 80)
  ledger = foldGapRetry(ledger, 'gap-a', 'open')
  ledger = foldGapRetry(ledger, 'gap-a', 'open')
  ledger = foldGapRetry(ledger, 'gap-a', 'resolved')
  ledger = foldGapRetry(ledger, 'gap-b', 'blocked')
  assert.equal(ledger.stepsUsed, 2)
  assert.equal(ledger.metaBytes, 50)
  assert.equal(ledger.scanFeatures, 4)
  assert.equal(ledger.contextBytes, 80)
  assert.equal(ledger.gapRetries['gap-a'], 2, 'only re-opens count toward remediation')
  assert.equal(ledger.gapRetries['gap-b'], undefined, 'marking blocked never increments')

  // A plan revision cycle cannot reset anything: folds only add.
  ledger = foldStep(ledger)
  assert.equal(ledger.stepsUsed, 3)
  assert.equal(ledger.metaBytes, 50)
})

test('gap remediation stops repeated re-opens', () => {
  let ledger = initialBudgetLedger()
  assert.equal(checkGapRetry(ledger, CONFIG, 'gap-a'), undefined)
  ledger = foldGapRetry(ledger, 'gap-a', 'open')
  ledger = foldGapRetry(ledger, 'gap-a', 'open')
  const refusal = checkGapRetry(ledger, CONFIG, 'gap-a')
  assert.equal(refusal?.code, 'gap-retries-exhausted')
  assert.equal(refusal.used, 2)
  assert.equal(refusal.limit, CONFIG.maxGapRetries)
})

test('budget config resolves validated overrides over defaults and fails loud', () => {
  const resolved = resolveBudgetConfig({ maxModelSteps: 10 })
  assert.equal(resolved.maxModelSteps, 10)
  assert.equal(resolved.maxMetaBytes, DEFAULT_BUDGET_CONFIG.maxMetaBytes)
  assert.throws(() => resolveBudgetConfig({ maxModelSteps: 0 }), /budget\.maxModelSteps/)
  assert.throws(() => resolveBudgetConfig({ maxContextBytes: 1.5 }), /budget\.maxContextBytes/)
})
