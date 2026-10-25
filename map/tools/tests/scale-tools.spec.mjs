/**
 * Scale tool integration fixtures over the REAL catalog service, projection,
 * and `spatial-scale` package: register a resource → `scale_ingest` copies it
 * into the immutable chunked scale store (idempotently) → `scale_read` runs
 * bounded range/tile/query reads with cursors and capped samples →
 * `scale_scan` runs the worker-process scan, publishes the fixed conclusion
 * as a digest-pinned artifact through the accepted-call pairing, and rebuilds
 * its scan record from the session-cited parts. Refusals publish nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { decodeSpatialScaleMeta } from '../src/scale-meta.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { scaleIngest, scaleRead, scaleScan, MAX_SCALE_CONTENT_SAMPLE } from '../src/scale-tools.ts'

/** A deterministic point collection: `count` points on a grid, value = index. */
function gridCollection(count) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-5 + (index % 10), -4 + Math.floor(index / 10) * 0.8] },
      properties: { value: index, observed_at: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00Z` },
    })),
  }
}

async function scaleRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-scale-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  let callCounter = 0
  const sessions = new Map()
  function sessionOf_(id) {
    if (!sessions.has(id)) sessions.set(id, rig.session(id))
    return sessions.get(id)
  }
  return {
    dir,
    rig,
    sessionOf: sessionOf_,
    async register(name, collection) {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const session = sessionOf_('scale')
      const callId = `reg-${name}-${callCounter += 1}`
      rig.call(session, callId, 'catalog_register', { path, name })
      const { resource } = await catalogRegister.execute({ path, name }, rig.exec(session, { callId }))
      return resource
    },
    /** Prepare an accepted tool/call and run one scale tool against it. */
    async run(session, tool, args, { callId = `t-${callCounter += 1}`, signal } = {}) {
      const call = rig.call(session, callId, tool.name, args)
      const result = await tool.execute(args, rig.exec(session, { callId, signal }))
      return { result, seq: call.seq }
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const INGEST_ARGS = { resource_id: 'grid' }

test('scale_ingest copies a registered version into the immutable chunked store, idempotently', async () => {
  const env = await scaleRig('ingest')
  try {
    const resource = await env.register('grid-src', gridCollection(10))
    const session = env.sessionOf('scale')
    const { result } = await env.run(session, scaleIngest, { ...INGEST_ARGS, source_ref: resource.ref, chunk_rows: 4, time_field: 'observed_at' })
    assert.match(result.scale_ref, /^scl-grid@[0-9a-f]{12}$/)
    assert.equal(result.source.ref, resource.ref)
    assert.equal(result.deduplicated, false)
    assert.equal(result.chunks, 3, '10 rows at 4 rows per chunk make 3 chunks')
    assert.equal(result.rows, 10)
    assert.equal(result.native_crs, 'EPSG:4326')
    assert.deepEqual(result.schema.geometry_types, ['Point'])
    assert.ok(result.total_bytes > 0)
    assert.deepEqual(result.time_range, { from: '2026-01-01T00:00:00Z', to: '2026-01-09T00:00:00Z' })
    const decoded = decodeSpatialScaleMeta(result.meta)
    assert.equal(decoded.status, 'ok')
    assert.equal(decoded.meta.scaleRef, result.scale_ref)
    assert.equal(decoded.meta.sourceRef, resource.ref)

    // Idempotent re-ingest returns the same version.
    const again = await env.run(session, scaleIngest, { ...INGEST_ARGS, source_ref: resource.ref })
    assert.equal(again.result.deduplicated, true)
    assert.equal(again.result.scale_ref, result.scale_ref)
  } finally {
    await env.dispose()
  }
})

test('scale_ingest refuses unregistered sources and invalid resource ids without storing anything', async () => {
  const env = await scaleRig('ingest-bad')
  try {
    const session = env.sessionOf('scale')
    await assert.rejects(
      env.run(session, scaleIngest, { ...INGEST_ARGS, source_ref: 'res-ghost@v1' }),
      /CATALOG_NOT_FOUND/,
    )
    const resource = await env.register('grid-src', gridCollection(4))
    await assert.rejects(
      env.run(session, scaleIngest, { source_ref: resource.ref, resource_id: 'Bad_Id' }),
      /Bad_Id/,
    )
  } finally {
    await env.dispose()
  }
})

test('scale_read folds a query, caps its sample, and range reads resume by cursor', async () => {
  const env = await scaleRig('read')
  try {
    const resource = await env.register('grid-src', gridCollection(16))
    const session = env.sessionOf('scale')
    const { result: ingested } = await env.run(session, scaleIngest, { source_ref: resource.ref, resource_id: 'grid', chunk_rows: 4 })

    const query = await env.run(session, scaleRead, {
      resource_ref: ingested.scale_ref,
      kind: 'query', field: 'value', op: '>=', value: 8,
    })
    assert.equal(query.result.kind, 'query')
    assert.equal(query.result.matches, 8)
    assert.equal(query.result.aggregate.min, 8)
    assert.equal(query.result.aggregate.max, 15)
    assert.ok(query.result.sample.length <= MAX_SCALE_CONTENT_SAMPLE)
    assert.equal(query.result.sample_truncated, false)

    const range1 = await env.run(session, scaleRead, {
      resource_ref: ingested.scale_ref,
      kind: 'range', from_chunk: 0, chunks: 2,
    })
    assert.equal(range1.result.kind, 'range')
    assert.equal(range1.result.rows_scanned, 8)
    assert.equal(range1.result.cursor.next_chunk, 2)
    assert.equal(range1.result.cursor.exhausted, false)

    const range2 = await env.run(session, scaleRead, {
      resource_ref: ingested.scale_ref,
      kind: 'range', from_chunk: range1.result.cursor.next_chunk, chunks: 9,
    })
    assert.equal(range2.result.rows_scanned, 8)
    assert.equal(range2.result.cursor.exhausted, true)
    assert.equal(range1.result.rows_scanned + range2.result.rows_scanned, 16, 'cursor resume covers the version exactly once')

    // A foreign/unknown scl ref refuses loudly.
    await assert.rejects(
      env.run(session, scaleRead, { resource_ref: 'scl-grid@000000000000', kind: 'query', field: 'value', op: '>=', value: 0 }),
      /not committed/,
    )
  } finally {
    await env.dispose()
  }
})

test('scale_scan runs the worker, publishes the digest-pinned artifact, and rebuilds the scan record on retry', async () => {
  const env = await scaleRig('scan')
  try {
    const resource = await env.register('grid-src', gridCollection(64))
    const session = env.sessionOf('scale')
    const { result: ingested } = await env.run(session, scaleIngest, { source_ref: resource.ref, resource_id: 'grid', chunk_rows: 8 })
    const { result: scan, seq } = await env.run(session, scaleScan, {
      resource_ref: ingested.scale_ref, field: 'value', op: '>=', value: 32,
    })
    assert.equal(scan.job.status, 'succeeded')
    assert.match(scan.artifact.ref, /^art-/, 'the scan published a catalog artifact')
    assert.equal(scan.deduplicated, false)
    assert.equal(scan.job.status, 'succeeded')
    assert.equal(scan.job.chunks_done, 8)
    assert.equal(scan.job.rows_scanned, 64)
    assert.equal(scan.aggregate.count, 32, 'values 32..63 match')
    assert.ok(scan.record_digest.length === 64)
    assert.ok(scan.limitations.some(text => text.includes('never carries the bulk rows')))
    const decoded = decodeSpatialScaleMeta(scan.meta)
    assert.equal(decoded.status, 'ok')
    assert.equal(decoded.meta.artifactRef, scan.artifact.ref)
    assert.equal(decoded.meta.recordDigest, scan.record_digest)

    // retry_of returns the already-published artifact and never recomputes.
    const retry = await env.run(session, scaleScan, {
      resource_ref: ingested.scale_ref, field: 'value', op: '>=', value: 32, retry_of: seq,
    })
    assert.equal(retry.result.deduplicated, true)
    assert.equal(retry.result.artifact_ref, scan.artifact.ref)

    // An unknown retry seq refuses without recomputing.
    await assert.rejects(
      env.run(session, scaleScan, { resource_ref: ingested.scale_ref, field: 'value', op: '>=', value: 1, retry_of: 99999 }),
      /OPERATION_NOT_PUBLISHED/,
    )
  } finally {
    await env.dispose()
  }
})

test('a pre-aborted scale_scan refuses before any fold or publish', async () => {
  const env = await scaleRig('aborted')
  try {
    const resource = await env.register('grid-src', gridCollection(16))
    const session = env.sessionOf('scale')
    const { result: ingested } = await env.run(session, scaleIngest, { source_ref: resource.ref, resource_id: 'grid', chunk_rows: 8 })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      env.run(session, scaleScan, { resource_ref: ingested.scale_ref, field: 'value', op: '>=', value: 1 }, { signal: controller.signal }),
      /abort/i,
    )
  } finally {
    await env.dispose()
  }
})
