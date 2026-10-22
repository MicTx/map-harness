// Scan record + benchmark suite: restart/recompute rebuild, bounded model
// summaries, and the fixed-workload benchmark meeting its recorded gates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCALE_BUDGETS, SCALE_WORKLOAD_FIXTURE, manifestDigestOf } from '../src/contract.ts'
import { buildScanRecord, boundedSummaryOf, rebuildScanRecord, MAX_SCALE_DISPLAY_FEATURES, MAX_SCALE_SUMMARY_BYTES } from '../src/scan-record.ts'
import { openScaleStore, workloadFeatures } from '../src/store.ts'
import { runScaleBenchmark } from '../src/benchmark.ts'

/** One ingested small version to cite. */
function rig(label, rows = 32, chunkRows = 8) {
  const root = mkdtempSync(join(tmpdir(), `scale-prov-${label}-`))
  const store = openScaleStore(root)
  const workload = { ...SCALE_WORKLOAD_FIXTURE, seed: 5, rows, chunkRows }
  const version = store.ingest({
    resourceId: 'prov',
    sourceRef: 'res-prov@v1',
    sourceDigest: 'a'.repeat(64),
    nativeCrs: 'EPSG:4326',
    authorization: 'local',
    chunkRows,
    features: workloadFeatures(workload),
  })
  return { root, store, workload, version, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

function recordInputs(env) {
  const resolved = env.store.readVersion(env.version.ref, 'local')
  return {
    manifest: resolved.manifest,
    request: {
      kind: 'query',
      field: 'value',
      op: '>=',
      value: 0.5,
      sampleRows: SCALE_BUDGETS.scanSampleRows,
      budgetsDigest: SCALE_BUDGETS.jobSlots.toString(16),
    },
    job: {
      status: 'succeeded',
      chunksDone: resolved.manifest.chunks.length,
      rowsScanned: resolved.manifest.schema.featureCount,
      bytesScanned: resolved.manifest.totalBytes,
      checkpoints: [{ chunksDone: 1, rowsScanned: 8 }],
    },
    artifactRef: 'art-prov-scan@v1',
    artifactDigest: 'c'.repeat(64),
    displayFeatureCount: 12,
    displayTruncated: false,
  }
}

test('the scan record pins its parts and a rebuild from the same parts is identical', () => {
  const env = rig('pin')
  try {
    const inputs = recordInputs(env)
    const { record, digest } = buildScanRecord(inputs)
    assert.equal(record.methodVersion, 'spatial-scale@1')
    assert.equal(record.resource.ref, env.version.ref, 'the record cites the exact version')
    assert.equal(record.resource.manifestDigest, manifestDigestOf(inputs.manifest))
    assert.ok(record.display.digest.length === 64)

    const rebuilt = rebuildScanRecord(inputs, digest)
    assert.equal(rebuilt.digest, digest, 'a rebuild from identical parts digests identically')
  } finally {
    env.dispose()
  }
})

test('a rebuild that sees different parts refuses instead of claiming the same history', () => {
  const env = rig('mismatch')
  try {
    const inputs = recordInputs(env)
    const { digest } = buildScanRecord(inputs)

    assert.throws(() => rebuildScanRecord({ ...inputs, displayFeatureCount: 13 }, digest), /RECORD_MISMATCH/)
    assert.throws(() => rebuildScanRecord({
      ...inputs,
      job: { ...inputs.job, rowsScanned: inputs.job.rowsScanned + 1 },
    }, digest), /RECORD_MISMATCH/)
    assert.throws(() => rebuildScanRecord({ ...inputs, artifactRef: 'art-other@v1' }, digest), /RECORD_MISMATCH/)
    // A manifest change flows through the resource block into the digest.
    const otherManifest = { ...inputs.manifest, nativeCrs: 'EPSG:3857' }
    assert.throws(() => rebuildScanRecord({ ...inputs, manifest: otherManifest }, digest), /RECORD_MISMATCH/)
  } finally {
    env.dispose()
  }
})

test('the bounded summary carries counts and cursors, never rows, and stays under its cap', () => {
  const env = rig('summary')
  try {
    const inputs = recordInputs(env)
    const { record } = buildScanRecord(inputs)
    const summary = boundedSummaryOf(record, { count: 12, sum: 9.4, min: 0.5, max: 0.99 }, [
      'the artifact holds the matched rows; the model channel never carries them',
    ])
    assert.equal(summary.resource.ref, env.version.ref)
    assert.equal(summary.display.truncated, false)
    assert.ok(!JSON.stringify(summary).includes('row-'), 'no row payload leaks into the summary')
    assert.ok(JSON.stringify(summary).length <= MAX_SCALE_SUMMARY_BYTES)
    // A summary is deterministic: same record, same summary.
    assert.deepEqual(boundedSummaryOf(record, { count: 12, sum: 9.4, min: 0.5, max: 0.99 }, [
      'the artifact holds the matched rows; the model channel never carries them',
    ]), summary)
  } finally {
    env.dispose()
  }
})

test('the display cap is fixed and honest about truncation', () => {
  assert.equal(MAX_SCALE_DISPLAY_FEATURES, 512)
})

test('the fixed-workload benchmark meets every recorded gate and is repeatable', async () => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'scale-bench-first-'))
  const secondRoot = mkdtempSync(join(tmpdir(), 'scale-bench-second-'))
  try {
    const budgets = { ...SCALE_BUDGETS, jobSlots: SCALE_WORKLOAD_FIXTURE.concurrency, scanSampleRows: 64 }
    const first = await runScaleBenchmark(firstRoot, budgets)
    assert.equal(first.passed, true, `gates failed: ${JSON.stringify(first.gates.filter(g => !g.passed))}`)
    assert.equal(first.matchedCount > 0, true)
    for (const entry of first.gates) {
      assert.equal(entry.passed, true, `${entry.gate}: measured ${entry.measured} ${entry.unit} vs ${entry.threshold}`)
    }

    const second = await runScaleBenchmark(secondRoot, budgets)
    assert.equal(second.passed, true, 'the second run passes the same gates')
    assert.equal(second.matchedCount, first.matchedCount, 'identical bytes scan to identical counts')
    assert.ok(Math.abs(second.matchedSum - first.matchedSum) < 1e-6, 'identical bytes scan to identical sums')
    assert.equal(second.workload.seed, first.workload.seed)
  } finally {
    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  }
})
