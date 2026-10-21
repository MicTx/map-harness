// Provider suite: immutable versioning, digest-verified range/tile/query
// reads, authorization, resume cursors, and oversize refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SCALE_BUDGETS,
  SCALE_METHOD_VERSION,
  manifestDigestOf,
  scaleRefOf,
  validateScaleRead,
} from '../src/contract.ts'
import {
  ScaleStoreError,
  jobChunksOf,
  openScaleStore,
  workloadFeatures,
} from '../src/store.ts'

/** A small deterministic point collection: `count` points on a grid, value = index. */
function gridFeatures(count) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-5 + (index % 10), -4 + Math.floor(index / 10) * 0.8] },
    properties: { value: index, label: `row-${index}`, flagged: index % 2 === 0 },
  }))
}

function ingestInput(resourceId, features, overrides = {}) {
  return {
    resourceId,
    sourceRef: `res-${resourceId}@v1`,
    sourceDigest: 'a'.repeat(64),
    nativeCrs: 'EPSG:4326',
    authorization: 'local',
    chunkRows: 4,
    features,
    ...overrides,
  }
}

function storeFor(label) {
  const root = mkdtempSync(join(tmpdir(), `scale-store-${label}-`))
  return { root, store: openScaleStore(root), dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('ingest commits an immutable chunked version with schema, CRS, digest, and chunk index', () => {
  const env = storeFor('ingest')
  try {
    const result = env.store.ingest(ingestInput('grid', gridFeatures(10)))
    assert.equal(result.deduplicated, false)
    assert.equal(result.ref, scaleRefOf('grid', result.contentDigest))
    assert.match(result.ref, /^scl-grid@[0-9a-f]{12}$/)
    assert.equal(result.manifest.methodVersion, SCALE_METHOD_VERSION)
    assert.equal(result.manifest.chunkRows, 4)
    assert.equal(result.manifest.chunks.length, 3, '10 rows at 4 rows per chunk make 3 chunks (4/4/2)')
    assert.equal(result.manifest.schema.featureCount, 10)
    assert.deepEqual(result.manifest.schema.geometryTypes, ['Point'])
    assert.deepEqual(result.manifest.schema.fields.map(field => field.name), ['flagged', 'label', 'value'])
    assert.equal(result.manifest.chunks[0].rows, 4)
    assert.equal(result.manifest.chunks[2].rows, 2)
    assert.deepEqual(result.manifest.chunks[0].bbox, [-5, -4, -2, -4], 'chunk 0 covers its own four rows')
    assert.deepEqual(result.manifest.chunks[1].bbox, [-1, -4, 2, -4], 'chunk 1 covers its own four rows')
    assert.deepEqual(result.manifest.chunks[2].bbox, [3, -4, 4, -4], 'chunk 2 covers its two rows')
    assert.equal(result.manifest.totalBytes,
      result.manifest.chunks.reduce((total, chunk) => total + chunk.bytes, 0))
    // The committed bytes on disk digest back to the manifest entries.
    const { dir } = env.store.readVersion(result.ref, 'local')
    for (const chunk of result.manifest.chunks) {
      const bytes = readFileSync(env.store.chunkPath(dir, chunk.index))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.digest)
    }
  } finally {
    env.dispose()
  }
})

test('re-ingesting identical features is idempotent; changed bytes are a new version', () => {
  const env = storeFor('idempotent')
  try {
    const first = env.store.ingest(ingestInput('grid', gridFeatures(10)))
    const again = env.store.ingest(ingestInput('grid', gridFeatures(10)))
    assert.equal(again.deduplicated, true, 'identical bytes return the existing version')
    assert.equal(again.ref, first.ref)
    assert.equal(again.manifestDigest, first.manifestDigest)

    const changed = env.store.ingest(ingestInput('grid', gridFeatures(12)))
    assert.equal(changed.deduplicated, false)
    assert.notEqual(changed.ref, first.ref, 'changed bytes are a different, equally valid version')
    // Both versions stay readable: a new head never invalidates the old one.
    const old = env.store.readVersion(first.ref, 'local')
    assert.equal(old.manifest.schema.featureCount, 10)
  } finally {
    env.dispose()
  }
})

test('reads refuse unknown refs, uncommitted versions, foreign domains, and mismatched prefixes', () => {
  const env = storeFor('refusals')
  try {
    const { store } = env
    store.ingest(ingestInput('grid', gridFeatures(8)))
    assert.throws(() => store.read('res-grid@v1', { kind: 'query', field: 'value', op: '>=', value: 0 }, 'local', SCALE_BUDGETS), error => error.code === 'SCALE_INVALID_REF')
    assert.throws(() => store.read('scl-grid@000000000000', { kind: 'query', field: 'value', op: '>=', value: 0 }, 'local', SCALE_BUDGETS), error => error.code === 'SCALE_NOT_FOUND', 'an unknown digest prefix is not found')
    assert.throws(() => store.readVersion('scl-other@000000000000', 'local'), error => error.code === 'SCALE_NOT_FOUND')
    assert.throws(() => store.readVersion('not-a-ref', 'local'), error => error.code === 'SCALE_INVALID_REF')

    const secret = store.ingest(ingestInput('secret', gridFeatures(4), { authorization: 'partner' }))
    assert.throws(() => store.readVersion(secret.ref, 'local'), error => error.code === 'SCALE_FORBIDDEN', 'a version is unreadable outside its authorization domain')
    assert.throws(() => store.read(secret.ref, { kind: 'query', field: 'value', op: '>=', value: 0 }, 'local', SCALE_BUDGETS), error => error.code === 'SCALE_FORBIDDEN')
    // The authorized domain reads it.
    assert.equal(store.read(secret.ref, { kind: 'query', field: 'value', op: '>=', value: 0 }, 'partner', SCALE_BUDGETS).matches, 4)
  } finally {
    env.dispose()
  }
})

test('range reads verify chunk digests, hand back a resume cursor, and stop at the window end', () => {
  const env = storeFor('range')
  try {
    const { store } = env
    const version = store.ingest(ingestInput('grid', gridFeatures(10)))
    const budgets = { ...SCALE_BUDGETS, chunkRows: 4, maxRowsPerRead: 8, maxBytesPerRead: 1024 * 1024 }

    const first = store.read(version.ref, { kind: 'range', fromChunk: 0, chunks: 1 }, 'local', budgets)
    assert.equal(first.kind, 'range')
    assert.equal(first.rowsScanned, 4)
    assert.equal(first.chunks.length, 1)
    assert.equal(first.nextChunk, 1)
    assert.equal(first.exhausted, false)
    assert.equal(first.sample.length, 4)

    const second = store.read(version.ref, { kind: 'range', fromChunk: first.nextChunk, chunks: 4 }, 'local', budgets)
    assert.equal(second.rowsScanned, 6, 'the window clamps to the version end')
    assert.equal(second.exhausted, true)
    assert.equal(first.rowsScanned + second.rowsScanned, 10, 'cursor resume covers the version exactly once')

    // A corrupted chunk fails its digest check loudly.
    const { dir } = store.readVersion(version.ref, 'local')
    const chunkPath = store.chunkPath(dir, 1)
    const original = readFileSync(chunkPath)
    writeFileSync(chunkPath, Buffer.from(original.toString('utf8').replace('row-4', 'row-X'), 'utf8'))
    assert.throws(
      () => store.read(version.ref, { kind: 'range', fromChunk: 1, chunks: 1 }, 'local', budgets),
      error => error.code === 'SCALE_IO' && /digest check/.test(error.message),
    )
  } finally {
    env.dispose()
  }
})

test('oversized range windows refuse before any I/O against the explicit budgets', () => {
  const env = storeFor('oversize')
  try {
    const { store } = env
    const version = store.ingest(ingestInput('grid', gridFeatures(16)))
    const byteBudget = { ...SCALE_BUDGETS, chunkRows: 4, maxRowsPerRead: 8, maxBytesPerRead: 1 }
    assert.throws(
      () => store.read(version.ref, { kind: 'range', fromChunk: 0, chunks: 2 }, 'local', byteBudget),
      error => error.code === 'SCALE_TOO_LARGE' && /byte read budget/.test(error.message),
    )
    const rowBudget = { ...byteBudget, maxBytesPerRead: 1024 * 1024 }
    assert.throws(
      () => store.read(version.ref, { kind: 'range', fromChunk: 0, chunks: 3 }, 'local', rowBudget),
      error => error.code === 'SCALE_TOO_LARGE' && /row read budget/.test(error.message),
    )
    assert.throws(
      () => store.read(version.ref, { kind: 'range', fromChunk: 99, chunks: 1 }, 'local', rowBudget),
      error => error.code === 'SCALE_INVALID_INPUT',
    )
  } finally {
    env.dispose()
  }
})

test('tile reads prune whole chunks by bbox and cap their sample', () => {
  const env = storeFor('tile')
  try {
    const { store } = env
    // 40 points spanning lon [-5, 5): chunked into 10 chunks of 4, each chunk
    // covering 4 consecutive grid points along one row.
    const version = store.ingest(ingestInput('grid', gridFeatures(40)))
    const budgets = { ...SCALE_BUDGETS, maxRowsPerRead: 4 }

    const result = store.read(version.ref, { kind: 'tile', z: 1, x: 0, y: 0 }, 'local', budgets)
    assert.equal(result.kind, 'tile')
    assert.ok(result.chunksPruned > 0, 'the west/south tile prunes east/north chunks')
    assert.ok(result.chunksRead < 10, `only surviving chunks are read (read ${result.chunksRead})`)
    assert.ok(result.matches >= 1)
    assert.equal(result.truncated, true, 'the tile holds more than the 4-row sample cap')
    assert.equal(result.bbox.length, 4)

    const far = store.read(version.ref, { kind: 'tile', z: 1, x: 1, y: 1 }, 'local', budgets)
    assert.ok(far.chunksPruned > 0)
    assert.throws(
      () => store.read(version.ref, { kind: 'tile', z: 1, x: 2, y: 0 }, 'local', budgets),
      error => error.code === 'SCALE_INVALID_INPUT',
      'a tile beyond the grid refuses',
    )
  } finally {
    env.dispose()
  }
})

test('query scans fold a predicate across chunks with a bounded sample and honest truncation', () => {
  const env = storeFor('query')
  try {
    const { store } = env
    const version = store.ingest(ingestInput('grid', gridFeatures(16)))
    const budgets = { ...SCALE_BUDGETS, scanSampleRows: 6 }

    const result = store.read(version.ref, { kind: 'query', field: 'value', op: '>=', value: 8 }, 'local', budgets)
    assert.equal(result.matches, 8, 'values 8..15 match')
    assert.equal(result.aggregate.count, 8)
    assert.equal(result.aggregate.min, 8)
    assert.equal(result.aggregate.max, 15)
    assert.equal(result.aggregate.sum, (8 + 15) * 8 / 2)
    assert.equal(result.rowsScanned, 16)
    assert.equal(result.chunksRead, 4)
    assert.equal(result.sample.length, 6, 'the sample holds the budget cap')
    assert.equal(result.truncated, true)

    const empty = store.read(version.ref, { kind: 'query', field: 'value', op: '<', value: 0 }, 'local', budgets)
    assert.equal(empty.matches, 0)
    assert.equal(empty.truncated, false)

    // A non-numeric field value is a non-match, never a crash.
    const mixed = store.ingest(ingestInput('mixed', [
      { type: 'Feature', geometry: null, properties: { value: 'high' } },
      { type: 'Feature', geometry: null, properties: { value: 3 } },
    ]))
    const scan = store.read(mixed.ref, { kind: 'query', field: 'value', op: '>=', value: 0 }, 'local', budgets)
    assert.equal(scan.matches, 1)
    assert.equal(scan.rowsScanned, 2)
  } finally {
    env.dispose()
  }
})

test('the ingest time field records an observed ISO range and refuses unparseable rows', () => {
  const env = storeFor('time')
  try {
    const { store } = env
    const features = gridFeatures(4).map((feature, index) => ({
      ...feature,
      properties: { ...feature.properties, observed_at: `2026-01-0${index + 1}T00:00:00Z` },
    }))
    const version = store.ingest(ingestInput('timed', features, { timeField: 'observed_at' }))
    assert.deepEqual(version.manifest.timeRange, { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' })

    assert.throws(
      () => store.ingest(ingestInput('broken-time', [
        { type: 'Feature', geometry: null, properties: { observed_at: 'not-a-time' } },
      ], { timeField: 'observed_at' })),
      error => error.code === 'SCALE_INVALID_INPUT' && /ISO time string/.test(error.message),
    )
  } finally {
    env.dispose()
  }
})

test('a failed ingest leaves no version and no staging residue behind', () => {
  const env = storeFor('orphan')
  try {
    const { root, store } = env
    assert.throws(() => store.ingest(ingestInput('Bad_Id', gridFeatures(4))), error => error.code === 'SCALE_INVALID_INPUT')
    assert.throws(() => store.ingest(ingestInput('empty', [])), error => error.code === 'SCALE_INVALID_INPUT', 'an empty ingest refuses')
    assert.equal(existsSync(join(root, 'versions', 'Bad_Id')), false, 'no version directory was created')
    assert.equal(readdirSync(join(root, 'staging')).length, 0, 'staging is empty after every failure')
    // Manifests never lie about chunk counts: an absent chunk file fails its read.
    const version = store.ingest(ingestInput('grid', gridFeatures(4)))
    const { dir } = store.readVersion(version.ref, 'local')
    rmSync(store.chunkPath(dir, 0))
    assert.throws(
      () => store.read(version.ref, { kind: 'range', fromChunk: 0, chunks: 1 }, 'local', SCALE_BUDGETS),
      error => error.code === 'SCALE_IO',
    )
  } finally {
    env.dispose()
  }
})

test('the workload generator is deterministic and job chunk descriptors cite verified paths', () => {
  const workload = {
    seed: 7,
    rows: 32,
    chunkRows: 8,
    lonSpan: 10,
    latSpan: 8,
    field: 'value',
    predicate: { field: 'value', op: '>=', value: 0.5 },
    concurrency: 2,
    recoveryAfterChunks: 1,
  }
  const first = workloadFeatures(workload)
  const second = workloadFeatures(workload)
  assert.deepEqual(first, second, 'two generations are byte-identical')
  assert.equal(first.length, 32)

  const env = storeFor('jobchunks')
  try {
    const { store } = env
    const version = store.ingest(ingestInput('workload', first, { chunkRows: 8 }))
    const resolved = store.readVersion(version.ref, 'local')
    const chunks = jobChunksOf(store, resolved)
    assert.equal(chunks.length, 4)
    for (const chunk of chunks) {
      assert.ok(existsSync(chunk.path))
      assert.equal(chunk.start, 0)
      assert.ok(chunk.end > 0)
    }
    assert.equal(chunks[0].rows, 8)
    // The manifest digest travels with the version for record pinning.
    assert.equal(resolved.manifestDigest, manifestDigestOf(resolved.manifest))
    // The contract-level range estimate agrees with the store budgets.
    assert.deepEqual(validateScaleRead({ kind: 'range', fromChunk: 0, chunks: 2 }), [])
  } finally {
    env.dispose()
  }
})
