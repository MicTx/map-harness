/**
 * Resource-reliability gate for map-owned suites: proves the shared helper
 * contract in `tests/support/reliability.mjs` — tracked roots survive thrown
 * bodies, concurrent roots stay isolated, waits observe external state instead
 * of fixed sleeps, and cross-process children leave exactly the roots they
 * report (verified against the real tmpdir, never a self-report). POSIX is the
 * verified platform here; Windows semantics belong to the upstream CI matrix
 * (map/docs/verification-matrix.md, out-of-scope table).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  barrier,
  leakedRoots,
  removeTmpRoot,
  tmpRoots,
  trackedTmpDir,
  waitFor,
  withTrackedTmpDir,
} from './support/reliability.mjs'

const supportPath = fileURLToPath(new URL('./support/reliability.mjs', import.meta.url))

test('withTrackedTmpDir removes the root on success and on a thrown body', async () => {
  let seenPath
  await withTrackedTmpDir('cleanup-success', async dir => {
    seenPath = dir.path
    assert.ok(existsSync(dir.path), 'the root must exist inside the body')
  })
  assert.equal(existsSync(seenPath), false, 'a successful body still loses its root')
  assert.deepEqual(tmpRoots('map-test-cleanup-success-'), [], 'no tmpdir leftovers after success')

  await assert.rejects(
    withTrackedTmpDir('cleanup-failure', async () => {
      throw new Error('body failed on purpose')
    }),
    /body failed on purpose/,
  )
  assert.deepEqual(tmpRoots('map-test-cleanup-failure-'), [], 'a thrown body must not leak its root')
})

test('concurrent tracked roots are unique, coexist, and all clean up', async () => {
  const first = trackedTmpDir('concurrent')
  const second = trackedTmpDir('concurrent')
  try {
    assert.notEqual(first.path, second.path, 'two live roots never share a path')
    assert.ok(existsSync(first.path) && existsSync(second.path), 'both roots exist while held')
  } finally {
    await first.dispose()
    await second.dispose()
  }
  assert.deepEqual(tmpRoots('map-test-concurrent-'), [], 'concurrent roots leave no leftovers')
  assert.deepEqual(leakedRoots(), [], 'the live-root registry matches the real filesystem')
})

test('waitFor resolves on an externally-released barrier and names its label on deadline', async () => {
  const gate = barrier()
  let released = false
  const waiting = waitFor(() => released, { timeoutMs: 2000, label: 'barrier flips' })
  const deadline = waitFor(() => false, { timeoutMs: 25, intervalMs: 5, label: 'impossible condition' })
  await assert.rejects(deadline, /waitFor timed out after 25ms: impossible condition/, 'the deadline error must carry the label')
  assert.equal((await Promise.race([waiting.then(() => 'done'), Promise.resolve('pending')])), 'pending', 'an unreleased barrier keeps the wait pending')
  released = true
  gate.release()
  await waiting
})

test('dispose-style quiescence: an in-flight op settles only after the barrier releases', async () => {
  const gate = barrier()
  let inFlightSettled = false
  const inFlight = (async () => {
    await gate.promise
    inFlightSettled = true
  })()
  await assert.rejects(
    waitFor(() => inFlightSettled, { timeoutMs: 25, intervalMs: 5, label: 'blocked op must not settle' }),
    /blocked op must not settle/,
    'the deadline proves the unreleased op is still in flight',
  )
  gate.release()
  await inFlight
  assert.equal(inFlightSettled, true)
})

test('a cross-process child leaves exactly the roots it reports, on the real filesystem', async () => {
  await withTrackedTmpDir('leak-check-cwd', async cwd => {
    // The per-run label makes the count exact even when an earlier crashed
    // run of this suite left residue under the shared prefix.
    const label = `leak-probe-${process.pid}`
    const prefix = `map-test-${label}-`
    const script = join(cwd.path, 'leak-child.mjs')
    writeFileSync(script, [
      'const helper = await import(process.argv[2])',
      'const label = process.argv[3]',
      'const roots = []',
      'for (let at = 0; at < 3; at += 1) roots.push(await helper.trackedTmpDir(label))',
      'await roots[0].dispose()',
      'await roots[1].dispose()',
      'process.stdout.write(JSON.stringify({ kept: roots[2].path }))',
      'process.exit(0)',
    ].join('\n'))
    const child = spawnSync(process.execPath, [script, supportPath, label], { encoding: 'utf8', cwd: cwd.path })
    assert.equal(child.status, 0, `child failed: ${child.stderr}`)
    const { kept } = JSON.parse(child.stdout)
    // The child reported one kept root; the real tmpdir must agree exactly.
    const leftovers = tmpRoots(prefix)
    assert.deepEqual(leftovers, [basename(kept)], 'the tmpdir must hold exactly the child-reported root')
    removeTmpRoot(leftovers[0])
    assert.deepEqual(tmpRoots(prefix), [], 'cleanup of the observed leftover must land')
  })
})
