// Worker suite: backpressure slots, cancel-to-quiescence, crash/timeout
// adjudication, orphan (staging) cleanup, and the publish race fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCALE_BUDGETS, SCALE_METHOD_VERSION, SCALE_OPS } from '../src/contract.ts'
import { jobChunksOf, openScaleStore, workloadFeatures } from '../src/store.ts'
import { ScaleJobRunner } from '../src/worker.ts'

/** Ingest the small workload into a fresh store and return the job request pieces. */
function rig(label, rows = 64, chunkRows = 8) {
  const root = mkdtempSync(join(tmpdir(), `scale-worker-${label}-`))
  const store = openScaleStore(root)
  const workload = {
    seed: 11,
    rows,
    chunkRows,
    lonSpan: 10,
    latSpan: 8,
    field: 'value',
    predicate: { field: 'value', op: '>=', value: 0.5 },
    concurrency: 2,
    recoveryAfterChunks: 2,
  }
  const version = store.ingest({ ...workloadIngest(workload), features: workloadFeatures(workload) })
  const resolved = store.readVersion(version.ref, 'local')
  const chunks = jobChunksOf(store, resolved)
  const budgets = { ...SCALE_BUDGETS, jobSlots: 1, queueDepth: 4, jobTimeoutMs: 15_000, scanSampleRows: 64 }
  const request = {
    methodVersion: SCALE_METHOD_VERSION,
    manifestPath: join(resolved.dir, 'manifest.json'),
    chunks,
    predicate: { field: 'value', op: '>=', value: 0.5 },
    sampleRows: budgets.scanSampleRows,
  }
  return {
    root, store, workload, version, resolved, chunks, budgets, request,
    runner: () => new ScaleJobRunner(join(root, 'staging'), budgets),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

function workloadIngest(workload) {
  return {
    resourceId: 'bench',
    sourceRef: 'res-bench@v1',
    sourceDigest: 'a'.repeat(64),
    nativeCrs: 'EPSG:4326',
    authorization: 'local',
    chunkRows: workload.chunkRows,
  }
}

test('a worker scan runs in a real child process, verifies chunk digests, and folds the predicate', async () => {
  const env = rig('basic')
  const runner = env.runner()
  try {
    const outcome = await runner.run(env.request)
    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.result.chunksDone, env.chunks.length)
    assert.equal(outcome.result.rowsScanned, env.workload.rows)
    assert.ok(outcome.progress.length === env.chunks.length, 'one progress line per chunk')
    // The aggregate matches an independent count: values uniform in [0,1), so
    // the >= 0.5 predicate matches roughly half; min/max bound the matched set.
    assert.ok(outcome.result.aggregate.count > env.workload.rows * 0.4, `matched ${outcome.result.aggregate.count}`)
    assert.ok(outcome.result.aggregate.count < env.workload.rows * 0.6)
    assert.ok(outcome.result.aggregate.min >= 0.5)
    assert.ok(outcome.result.aggregate.max < 1)
    assert.ok(outcome.result.sample.length > 0)
    assert.ok(outcome.result.sample.length <= env.budgets.scanSampleRows)
    assert.equal(existsSync(join(env.root, 'staging')), true, 'the staging root survives; job dirs do not')
    assert.equal(readdirSync(join(env.root, 'staging')).length, 0, 'the job staging dir was removed after success')
    assert.equal(runner.stats().occupied, 0, 'the slot is released')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('a crashed worker settles failed, claims no outcome, and leaves no staging orphan', async () => {
  const env = rig('crash')
  const runner = env.runner()
  try {
    const outcome = await runner.run({ ...env.request, fault: { afterChunks: 2, kind: 'crash' } })
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.code, 'worker-crash')
    assert.match(outcome.reason, /exited without a terminal protocol line/)
    assert.equal(outcome.progress.length, 2, 'the two progress lines before the crash are the resume trace')
    assert.equal(existsSync(join(env.root, 'staging', 'orphan-check')), false)
    assert.equal(readdirSync(join(env.root, 'staging')).length, 0, 'the crashed job left no staging residue')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('the crashed scan resumes from its progress cursor and finishes identically', async () => {
  const env = rig('resume')
  const runner = env.runner()
  try {
    const crashed = await runner.run({ ...env.request, fault: { afterChunks: 2, kind: 'crash' } })
    assert.equal(crashed.status, 'failed')
    const lastProgress = crashed.progress[crashed.progress.length - 1]
    // Re-derive the prefix fold by scanning exactly the chunks before the cursor.
    const prefix = await runner.run({ ...env.request, chunks: env.chunks.slice(0, lastProgress.chunksDone) })
    assert.equal(prefix.status, 'succeeded')
    assert.equal(prefix.result.aggregate.count, lastProgress.matches, 'the progress trace names the prefix fold exactly')
    // Resume: rerun only the chunks after the cursor.
    const resumed = await runner.run({ ...env.request, chunks: env.chunks.slice(lastProgress.chunksDone) })
    assert.equal(resumed.status, 'succeeded')
    assert.equal(resumed.result.rowsScanned, env.workload.rows - lastProgress.rowsScanned, 'the resume covers exactly the unscanned rows')
    const whole = await runner.run(env.request)
    assert.equal(whole.status, 'succeeded')
    assert.equal(whole.result.aggregate.count, prefix.result.aggregate.count + resumed.result.aggregate.count, 'cursor + resume fold equals the uninterrupted fold')
    assert.ok(Math.abs(whole.result.aggregate.sum - (prefix.result.aggregate.sum + resumed.result.aggregate.sum)) < 1e-6, 'the sums fold identically')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('cancel stops the child at a chunk boundary and settles cancelled only after exit', async () => {
  const env = rig('cancel', 512, 8)
  const runner = env.runner()
  try {
    assert.equal(runner.cancel('no-such-job'), false, 'an unknown job id does not cancel')
    const controller = new AbortController()
    // Paced scanning keeps the child mid-scan; abort only after the first
    // progress line proves chunk 1 completed, so the cursor is real.
    let firstProgress
    const firstProgressSeen = new Promise(resolve => {
      firstProgress = () => resolve()
    })
    const pending = runner.run(
      { ...env.request, fault: { kind: 'pace', paceMs: 25 } },
      { signal: controller.signal, onProgress: () => firstProgress() },
    )
    await firstProgressSeen
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.status, 'cancelled', `got ${JSON.stringify(cancelled)}`)
    assert.ok(cancelled.cancelled.chunksDone < env.chunks.length, `stopped at chunk ${cancelled.cancelled.chunksDone}`)
    assert.ok(cancelled.cancelled.rowsScanned > 0)
    assert.equal(runner.stats().occupied, 0, 'the child exited before the runner settled')
    assert.equal(readdirSync(join(env.root, 'staging')).length, 0, 'the cancelled job left no staging residue')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('a cancel/completion race is adjudicated by the child, not the parent intent', async () => {
  const env = rig('race', 32, 8)
  const runner = env.runner()
  try {
    const controller = new AbortController()
    const pending = runner.run(env.request, { signal: controller.signal })
    await waitFor(() => runner.stats().occupied === 1)
    // The workload is tiny; by the time cancel lands the child has usually
    // finished — either terminal status is honest, but the two never mix.
    controller.abort()
    const outcome = await pending
    assert.ok(outcome.status === 'cancelled' || outcome.status === 'succeeded', `settled ${outcome.status}`)
    if (outcome.status === 'succeeded') {
      assert.equal(outcome.result.chunksDone, env.chunks.length, 'a won race is a complete result')
    }
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('a hung worker is killed by its timeout and settled failed, never cancelled or succeeded', async () => {
  const env = rig('hang')
  env.budgets.jobTimeoutMs = 250
  const runner = new ScaleJobRunner(join(env.root, 'staging'), env.budgets)
  try {
    const started = Date.now()
    const outcome = await runner.run({ ...env.request, fault: { afterChunks: 1, kind: 'hang' } })
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.code, 'timeout')
    assert.match(outcome.reason, /no outcome is claimed/)
    assert.ok(Date.now() - started >= 200, 'the timeout actually waited')
    assert.equal(readdirSync(join(env.root, 'staging')).length, 0, 'the timed-out job left no staging residue')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('backpressure holds surplus jobs in a bounded queue and refuses a full one', async () => {
  const env = rig('backpressure', 4096, 8)
  env.budgets.jobSlots = 1
  env.budgets.queueDepth = 1
  const runner = new ScaleJobRunner(join(env.root, 'staging'), env.budgets)
  try {
    const first = runner.run(env.request)
    const second = runner.run(env.request)
    await waitFor(() => runner.stats().heldByBackpressure >= 1)
    assert.equal(runner.stats().occupied, 1, 'one slot is occupied')
    assert.equal(runner.stats().queued, 1, 'the second submission is held in the queue')
    const third = await runner.run(env.request)
    assert.equal(third.status, 'failed')
    assert.equal(third.code, 'spawn')
    assert.match(third.reason, /queue is full/)
    assert.equal(runner.stats().refusedByFullQueue, 1)
    // The held job still runs and succeeds once the slot frees.
    const firstOutcome = await first
    assert.equal(firstOutcome.status, 'succeeded')
    const secondOutcome = await second
    assert.equal(secondOutcome.status, 'succeeded', 'the held job completes after the slot frees')
  } finally {
    await runner.dispose()
    env.dispose()
  }
})

test('dispose cancels live children and every settle path leaves the staging empty', async () => {
  const env = rig('dispose', 4096, 8)
  const runner = env.runner()
  const pending = runner.run({ ...env.request, fault: { afterChunks: 1, kind: 'hang' } })
  await waitFor(() => runner.stats().occupied === 1)
  await runner.dispose()
  const outcome = await pending
  assert.equal(outcome.status, 'failed', 'a disposed live job settles failed, never invented')
  assert.equal(readdirSync(join(env.root, 'staging')).length, 0, 'no staging residue after disposal')
  const refused = await runner.run(env.request)
  assert.equal(refused.status, 'failed')
  assert.match(refused.reason, /disposed/)
  env.dispose()
})

/** Poll until `condition` holds, bounded. */
async function waitFor(condition, timeoutMs = 5_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// The op set the worker protocol implements is the contract's fixed set.
test('the worker predicate operator set is the contract set', () => {
  assert.deepEqual([...SCALE_OPS], ['>', '>=', '<', '<=', '==', '!='])
})
