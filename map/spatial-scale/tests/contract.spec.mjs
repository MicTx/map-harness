// Contract suite: the recorded budgets/read/workload validation, the fixed
// workload fixture, the version ref form, and the manifest digest identity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INGEST_ROWS,
  MAX_JOB_SLOTS,
  SCALE_BUDGETS,
  SCALE_METHOD_VERSION,
  SCALE_OPS,
  SCALE_RECORDED_THRESHOLDS,
  SCALE_WORKLOAD_FIXTURE,
  manifestDigestOf,
  parseScaleRef,
  scaleRefOf,
  validateScaleBudgets,
  validateScaleRead,
  validateScaleWorkload,
} from '../src/contract.ts'

/** One complete valid manifest used as the digest identity fixture. */
function fixtureManifest() {
  return {
    methodVersion: SCALE_METHOD_VERSION,
    resourceId: 'bench-grid',
    sourceRef: 'res-bench@v1',
    sourceDigest: 'a'.repeat(64),
    contentDigest: 'b'.repeat(64),
    nativeCrs: 'EPSG:4326',
    schema: { fields: [{ name: 'value', type: 'number' }], geometryTypes: ['Point'], featureCount: 2 },
    timeRange: null,
    authorization: 'local',
    chunkRows: 2,
    chunks: [
      { index: 0, rows: 2, bytes: 120, digest: 'c'.repeat(64), bbox: [0, 0, 1, 1] },
    ],
    totalBytes: 120,
    ingestedAt: '2026-09-25T00:00:00.000Z',
  }
}

test('the recorded budgets validate clean and every budget defect is listed at once', () => {
  assert.deepEqual(validateScaleBudgets(SCALE_BUDGETS), [], 'the recorded deployment budgets are valid')
  const issues = validateScaleBudgets({
    chunkRows: 0,
    maxRowsPerRead: 2 ** 40,
    maxBytesPerRead: 1.5,
    scanSampleRows: -1,
    jobSlots: MAX_JOB_SLOTS + 1,
    queueDepth: -2,
    jobTimeoutMs: Number.POSITIVE_INFINITY,
  })
  assert.equal(issues.length, 7, 'each violating field is named once')
  for (const field of ['chunkRows', 'maxRowsPerRead', 'maxBytesPerRead', 'scanSampleRows', 'jobSlots', 'queueDepth', 'jobTimeoutMs']) {
    assert.ok(issues.some(issue => issue.field === field), `missing issue for ${field}`)
  }
  assert.deepEqual(validateScaleBudgets(null), [{ field: 'budgets', code: 'budgets-required', message: 'the budgets must be an object' }])
})

test('read validation refuses unknown kinds and malformed windows before any I/O', () => {
  assert.deepEqual(validateScaleRead({ kind: 'range', fromChunk: 0, chunks: 2 }), [])
  assert.deepEqual(validateScaleRead({ kind: 'tile', z: 4, x: 9, y: 5 }), [])
  assert.deepEqual(validateScaleRead({ kind: 'query', field: 'value', op: '>=', value: 0.5 }), [])

  const malformed = validateScaleRead({ kind: 'range', fromChunk: -1, chunks: 0 })
  assert.equal(malformed.length, 2)
  for (const issue of malformed) assert.equal(issue.code, 'range-bounds')
  // Budget-vs-window checks belong to the provider against the version's
  // real manifest; the contract check stays shape-only.
  assert.deepEqual(validateScaleRead({ kind: 'range', fromChunk: 0, chunks: 8 }), [])

  const badKind = validateScaleRead({ kind: 'spatial' }, SCALE_BUDGETS)
  assert.equal(badKind[0].code, 'read-kind')
  assert.deepEqual(validateScaleRead(undefined), [{ field: 'read', code: 'read-required', message: 'a read request is required' }])

  const badQuery = validateScaleRead({ kind: 'query', field: '', op: '~=', value: 'x' })
  assert.equal(badQuery.length, 3)
  for (const issue of badQuery) assert.equal(issue.code, 'predicate-bound')

  const badTile = validateScaleRead({ kind: 'tile', z: 40, x: -1, y: 2 ** 23 })
  assert.equal(badTile.length, 3)
  for (const issue of badTile) assert.equal(issue.code, 'tile-bounds')
})

test('the fixed workload fixture validates clean and the workload bounds refuse bad inputs', () => {
  assert.deepEqual(validateScaleWorkload(SCALE_WORKLOAD_FIXTURE), [])
  const issues = validateScaleWorkload({
    seed: -1,
    rows: MAX_INGEST_ROWS + 1,
    chunkRows: 0,
    lonSpan: 400,
    latSpan: 0,
    field: '',
    predicate: { field: 'value', op: 'between', value: Number.NaN },
    concurrency: MAX_JOB_SLOTS + 1,
    recoveryAfterChunks: 1.5,
  })
  assert.equal(issues.length, 10, 'each violating workload field is named once')
  assert.deepEqual(validateScaleWorkload('no'), [{ field: 'workload', code: 'workload-required', message: 'the workload must be an object' }])
})

test('the recorded thresholds carry every measured gate and the operator set is fixed', () => {
  for (const key of ['minScanRowsPerSecond', 'maxScanHeapGrowthBytes', 'minIngestRowsPerSecond', 'maxConcurrencyWallRatio', 'maxRecoveryResumeMs']) {
    assert.equal(typeof SCALE_RECORDED_THRESHOLDS[key], 'number', `threshold ${key} is a number`)
  }
  assert.ok(SCALE_RECORDED_THRESHOLDS.minScanRowsPerSecond > 0)
  assert.deepEqual([...SCALE_OPS], ['>', '>=', '<', '<=', '==', '!='])
  assert.equal(SCALE_METHOD_VERSION, 'spatial-scale@1')
})

test('scale refs round-trip and foreign forms parse to null', () => {
  const ref = scaleRefOf('bench-grid', `${'b'.repeat(64)}`)
  assert.equal(ref, `scl-bench-grid@${'b'.repeat(12)}`)
  assert.deepEqual(parseScaleRef(ref), { resourceId: 'bench-grid', digestPrefix: 'b'.repeat(12) })
  assert.equal(parseScaleRef('res-bench@v1'), null, 'catalog refs are not scale refs')
  assert.equal(parseScaleRef('scl-Bad@Idaaaaaaaaaaaa'), null, 'uppercase ids and long digests refuse')
  assert.equal(parseScaleRef('scl-bench-grid@short'), null)
})

test('the manifest digest pins the whole manifest: any chunk or metadata change is a different identity', () => {
  const base = fixtureManifest()
  const same = fixtureManifest()
  assert.equal(manifestDigestOf(base), manifestDigestOf(same), 'identical manifests digest identically')
  const differentChunk = fixtureManifest()
  differentChunk.chunks[0] = { ...differentChunk.chunks[0], rows: 3 }
  assert.notEqual(manifestDigestOf(base), manifestDigestOf(differentChunk), 'a chunk change is a different manifest identity')
  const differentMeta = fixtureManifest()
  differentMeta.nativeCrs = 'EPSG:3857'
  assert.notEqual(manifestDigestOf(base), manifestDigestOf(differentMeta), 'a metadata change is a different manifest identity')
})
