/**
 * Accessibility run gates: durable submit/get/cancel over the versioned
 * SQLite store. Covers the submit-timeout semantics (the durable row exists
 * before any worker; a lost response is recoverable by operation identity),
 * query recovery after restart, the cancel/completion race adjudicated by
 * service terminal states, duplicate operationRef conflict/dedupe, worker
 * quiescence on dispose, and orphan adjudication for dead worker epochs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESSIBILITY_METHOD_VERSION,
  AccessibilityError,
  AccessibilityRunService,
  openRunStore,
  runOperationRefOf,
  sweepOrphans,
} from '../src/index.ts'
import { barrier, trackedTmpDir, waitFor } from '../../tests/support/reliability.mjs'

const SUPPORT = [116.0, 39.6, 116.8, 40.2]
const RETRIEVAL = [116.1, 39.7, 116.7, 40.1]
const STUDY = [116.2, 39.8, 116.6, 40.0]

/** A minimal valid spec. */
function validSpec(goalRevision = 1) {
  return {
    goalRevision,
    studyArea: { bbox: STUDY },
    retrievalExtent: { bbox: RETRIEVAL },
    analysisSupportExtent: { bbox: SUPPORT },
    observationWindow: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
    impedance: { travelMode: 'walk', maxMinutes: 15 },
    timeSlices: ['midday'],
    populationRef: 'res-pop@v1',
    populationField: 'population',
    facilityRefs: ['res-fac@v1'],
    methodVersion: ACCESSIBILITY_METHOD_VERSION,
  }
}

/** Open a store + service over a tracked root; returns a dispose-all handle. */
async function runRig(label) {
  const dir = trackedTmpDir(label)
  const store = openRunStore(dir.path)
  const service = new AccessibilityRunService(store)
  return {
    dir, store, service,
    async dispose() {
      await service.dispose()
      store.close()
      await dir.dispose()
    },
  }
}

/** A compute that finishes immediately with a canned outcome. */
function instantCompute(outcome = { outcome: 'complete', result: { covered: 10 } }) {
  return async () => outcome
}

test('submit persists the durable row before the worker starts and returns identity + estimate', async () => {
  const rig = await runRig('submit-durable')
  try {
    let workerRan = false
    const submitted = rig.service.submit({
      operationRef: runOperationRefOf('session-a', 7),
      spec: validSpec(),
      buildCompute: () => async () => {
        workerRan = true
        return { outcome: 'complete', result: { covered: 1 } }
      },
    })
    assert.equal(submitted.deduplicated, false)
    assert.match(submitted.runId, /^run-[0-9a-f-]+$/)
    assert.match(submitted.operationRef, /^op-[0-9a-f]{24}$/)
    assert.equal(submitted.requestDigest.length, 64)
    assert.equal(submitted.status, 'queued')
    // The row is already queryable before the worker finishes; the estimate
    // is deterministic over the support extent and slices.
    const record = rig.service.get(submitted.runId)
    assert.ok(['queued', 'running', 'succeeded'].includes(record.status))
    assert.equal(submitted.estimate.slices, 1)
    assert.ok(submitted.estimate.latticeNodesUpperBound > 0)
    await rig.service.dispose()
    assert.equal(workerRan, true)
    const settled = rig.service.get(submitted.runId)
    assert.equal(settled.status, 'succeeded')
    assert.deepEqual(settled.result, { covered: 1 })
  } finally {
    await rig.dispose()
  }
})

test('submitting the same operationRef with the same digest dedupes; a different digest conflicts', async () => {
  const rig = await runRig('duplicate-op')
  try {
    const operationRef = runOperationRefOf('session-b', 3)
    const first = rig.service.submit({ operationRef, spec: validSpec(), buildCompute: () => instantCompute() })
    const duplicate = rig.service.submit({ operationRef, spec: validSpec(), buildCompute: () => instantCompute() })
    assert.equal(duplicate.deduplicated, true)
    assert.equal(duplicate.runId, first.runId)
    // Same operation identity + different parameters is a conflict, never a
    // new operation: the digest is the consistency check, not the identity.
    assert.throws(
      () => rig.service.submit({ operationRef, spec: validSpec(2), buildCompute: () => instantCompute() }),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_CONFLICT',
    )
  } finally {
    await rig.dispose()
  }
})

test('an invalid spec is rejected before any row persists', async () => {
  const rig = await runRig('invalid-spec')
  try {
    const spec = validSpec()
    delete spec.impedance
    assert.throws(
      () => rig.service.submit({ operationRef: runOperationRefOf('session-c', 1), spec, buildCompute: () => instantCompute() }),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes('missing-impedance'),
    )
    // No row for the rejected operation: nothing was persisted.
    assert.equal(rig.service.byOperationRef(runOperationRefOf('session-c', 1)), undefined)
  } finally {
    await rig.dispose()
  }
})

test('run_get never re-executes and an unknown run fails loud', async () => {
  const rig = await runRig('get-noexec')
  try {
    let executions = 0
    const submitted = rig.service.submit({
      operationRef: runOperationRefOf('session-d', 2),
      spec: validSpec(),
      buildCompute: () => async () => {
        executions += 1
        return { outcome: 'complete', result: {} }
      },
    })
    await rig.service.dispose()
    assert.equal(executions, 1)
    for (let read = 0; read < 3; read++) {
      assert.equal(rig.service.get(submitted.runId).status, 'succeeded')
    }
    assert.equal(executions, 1, 'queries must not re-execute the run')
    assert.throws(
      () => rig.service.get('run-missing'),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND',
    )
  } finally {
    await rig.dispose()
  }
})

test('cancel before a checkpoint lands cancelled; a completed run keeps its outcome and records the request', async () => {
  const rig = await runRig('cancel-checkpoint')
  try {
    const firstStep = barrier()
    const submitted = rig.service.submit({
      operationRef: runOperationRefOf('session-e', 5),
      spec: validSpec(),
      buildCompute: () => async (checkpoints) => {
        await firstStep.promise
        checkpoints.throwIfCancelled()
        return { outcome: 'complete', result: { served: 42 } }
      },
    })
    // Wait until the worker is parked on the barrier, then cancel first.
    await waitFor(() => rig.service.get(submitted.runId).status === 'running', { label: 'worker running' })
    const requested = rig.service.cancel(submitted.runId)
    assert.equal(requested.status, 'cancelRequested')
    firstStep.release()
    await rig.service.dispose()
    const settled = rig.service.get(submitted.runId)
    assert.equal(settled.status, 'cancelled', 'the worker stopped at its checkpoint')
    assert.ok(settled.diagnostics.some(entry => entry.code === 'CANCEL_REQUESTED'))
    assert.equal(settled.result, null, 'a cancelled run publishes no outcome payload')
  } finally {
    await rig.dispose()
  }

  // The completion race: the compute finishes all work despite the request —
  // the service records the real terminal outcome + the cancel request.
  const rig2 = await runRig('cancel-race')
  try {
    const finishFirst = barrier()
    const submitted = rig2.service.submit({
      operationRef: runOperationRefOf('session-f', 6),
      spec: validSpec(),
      buildCompute: () => async () => {
        await finishFirst.promise
        // No checkpoint between the release and the outcome: the work completes.
        return { outcome: 'complete', result: { served: 99 } }
      },
    })
    await waitFor(() => rig2.service.get(submitted.runId).status === 'running', { label: 'worker running' })
    rig2.service.cancel(submitted.runId)
    finishFirst.release()
    await rig2.service.dispose()
    const settled = rig2.service.get(submitted.runId)
    assert.equal(settled.status, 'succeeded', 'the worker finished: the terminal state is the service adjudication')
    assert.deepEqual(settled.result, { served: 99 })
    assert.ok(settled.diagnostics.some(entry => entry.code === 'CANCEL_REQUESTED'), 'the cancel request stays recorded beside the completion')
    // Cancelling a terminal run is a no-op that reports the real state.
    assert.equal(rig2.service.cancel(submitted.runId).status, 'succeeded')
  } finally {
    await rig2.dispose()
  }
})

test('a failed compute records a failed terminal state with the stable code', async () => {
  const rig = await runRig('failed')
  try {
    const submitted = rig.service.submit({
      operationRef: runOperationRefOf('session-g', 8),
      spec: validSpec(),
      buildCompute: () => async () => {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', 'no walk-priced network covers the support extent')
      },
    })
    await rig.service.dispose()
    const settled = rig.service.get(submitted.runId)
    assert.equal(settled.status, 'failed')
    assert.ok(settled.diagnostics.some(entry => entry.code === 'METHOD_NOT_APPLICABLE'))
    assert.equal(settled.result, null, 'a failed run carries no outcome payload')
  } finally {
    await rig.dispose()
  }
})

test('a submitted-but-response-lost run is recoverable by operation identity and across restart', async () => {
  // Timeout semantics: the client never saw the submit response, so it
  // re-derives the same operationRef — the durable row answers, not a resubmit.
  const rig = await runRig('timeout-recovery')
  try {
    const operationRef = runOperationRefOf('session-h', 11)
    const first = rig.service.submit({ operationRef, spec: validSpec(), buildCompute: () => instantCompute({ outcome: 'complete', result: { recovered: true } }) })
    await rig.service.dispose()
    const retry = rig.service.submit({ operationRef, spec: validSpec(), buildCompute: () => instantCompute() })
    assert.equal(retry.deduplicated, true)
    assert.equal(retry.runId, first.runId)
    assert.equal(rig.service.get(first.runId).result.recovered, true)
  } finally {
    await rig.dispose()
  }

  // Process restart: a fresh store instance recovers terminal rows intact.
  const dir = trackedTmpDir('restart-recovery')
  try {
    const store1 = openRunStore(dir.path)
    const service1 = new AccessibilityRunService(store1)
    const submitted = service1.submit({ operationRef: runOperationRefOf('session-i', 4), spec: validSpec(), buildCompute: () => instantCompute({ outcome: 'partial', result: { half: true } }) })
    await service1.dispose()
    store1.close()
    const store2 = openRunStore(dir.path)
    try {
      const service2 = new AccessibilityRunService(store2)
      const recovered = service2.get(submitted.runId)
      assert.equal(recovered.status, 'partial')
      assert.deepEqual(recovered.result, { half: true })
      assert.equal(recovered.goalRevision, 1)
      await service2.dispose()
    } finally {
      store2.close()
    }
  } finally {
    await dir.dispose()
  }
})

test('a worker that died mid-run is adjudicated outcomeUnknown, never failed or succeeded', async () => {
  const dir = trackedTmpDir('orphan-adjudication')
  try {
    // Epoch 1: start a run that never finishes (the "process" dies right after).
    const store1 = openRunStore(dir.path)
    const service1 = new AccessibilityRunService(store1)
    const parked = barrier()
    const submitted = service1.submit({
      operationRef: runOperationRefOf('session-j', 9),
      spec: validSpec(),
      buildCompute: () => async () => {
        await parked.promise
        return { outcome: 'complete', result: {} }
      },
    })
    await waitFor(() => service1.get(submitted.runId).status === 'running', { label: 'worker running' })
    // Simulate the crash: no dispose, no quiescence — the worker stays parked
    // (a promise never awaited again does not hold the process) and the db
    // closes under it, exactly like a dead process.
    store1.close()

    // Epoch 2: the new process adjudicates the dead worker's run.
    const store2 = openRunStore(dir.path)
    try {
      const service2 = new AccessibilityRunService(store2)
      const record = service2.get(submitted.runId)
      assert.equal(record.status, 'outcomeUnknown')
      assert.ok(record.diagnostics.some(entry => entry.code === 'OUTCOME_UNKNOWN'), 'the adjudication names the dead epoch')
      await service2.dispose()
    } finally {
      store2.close()
    }
  } finally {
    await dir.dispose()
  }
})

test('sweepOrphans settles rows that reach the store dead without an open-time pass', async () => {
  const dir = trackedTmpDir('sweep-orphans')
  try {
    // Open-time adjudication settles rows that were already dead at open
    // (covered by the outcomeUnknown fixture); sweepOrphans is the explicit
    // pass for rows that reach a live store another way — for example a
    // backup restored mid-flight. Seed exactly that state by hand.
    const store = openRunStore(dir.path)
    try {
      const service = new AccessibilityRunService(store)
      const spec = validSpec()
      const now = new Date().toISOString()
      store.db.prepare(
        'INSERT INTO accessibility_runs (run_id, operation_ref, request_digest, goal_revision, spec_json, status, result_json, diagnostics_json, worker_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, \'running\', NULL, \'[]\', NULL, ?, ?)',
      ).run('run-restored', 'op-restored', '0'.repeat(64), JSON.stringify(spec), now, now)
      const swept = sweepOrphans(store)
      assert.deepEqual(swept, ['run-restored'], 'the restored dead-epoch run is named by the sweep')
      assert.equal(service.get('run-restored').status, 'outcomeUnknown')
      assert.ok(service.get('run-restored').diagnostics.some(entry => entry.code === 'OUTCOME_UNKNOWN'))
      assert.deepEqual(sweepOrphans(store), [], 'the second sweep has nothing left to adjudicate')
      await service.dispose()
    } finally {
      store.close()
    }
  } finally {
    await dir.dispose()
  }
})

test('dispose waits for real worker quiescence', async () => {
  const rig = await runRig('quiescence')
  try {
    const done = barrier()
    let finished = false
    rig.service.submit({
      operationRef: runOperationRefOf('session-l', 1),
      spec: validSpec(),
      buildCompute: () => async () => {
        await done.promise
        finished = true
        return { outcome: 'complete', result: {} }
      },
    })
    const disposal = rig.service.dispose()
    let settled = false
    void disposal.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(settled, false, 'dispose must not resolve while the worker is parked')
    done.release()
    await disposal
    assert.equal(finished, true, 'the worker finished inside dispose, not after')
  } finally {
    await rig.dispose()
  }
})
