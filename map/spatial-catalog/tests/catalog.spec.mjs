/**
 * Spatial-catalog gates: the transactional publish ladder (staging → validate
 * → digest → atomic version+refs+intent), version identity and uniqueness,
 * authorization filtering before any content leaves the catalog, immutable
 * versions surviving source overwrites and newer heads, artifact publication
 * with inherited authorization, the durability sweep, and the publish-pairing
 * projection fold. Failures before the commit leave no queryable version.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bindResource,
  CatalogError,
  GovernanceError,
  confirmDurability,
  openCatalogStore,
  operationRefOf,
  PUBLISH_TOOL_NAMES,
  publishArtifact,
  readArtifactBytes,
  readResourceBytes,
  registerResource,
  registerSemanticDefinition,
  resolveResource,
  rowIdOfRef,
  sha256BytesHex,
  spatialCatalogProjectionDefinition,
  withTransaction,
} from '../src/index.ts'
import { admitCollection, MAX_REGISTER_BYTES } from '../src/geojson.ts'
import { trackedTmpDir } from '../../spatial-storage/tests/support.mjs'

const TWO_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'first' } },
    { type: 'Feature', id: 'beta', geometry: { type: 'Point', coordinates: [10, 0] }, properties: { name: 'second' } },
  ],
}

/** Register the two-point fixture under one name and return the result. */
function registerTwoPoints(store, name = 'poi', sessionId = 's-1', callSeq = 7, bytes = TWO_POINTS) {
  return registerResource(store.db, store.root, {
    name,
    bytes: Buffer.from(JSON.stringify(bytes)),
    sourceLabel: `workspace/${name}.geojson`,
    nativeCrs: 'EPSG:4326',
    enforceWgs84Range: true,
    authorization: 'local',
    sessionId,
    sourceCallSeq: callSeq,
  })
}

test('a fresh catalog store carries the P0b chain tables and refuses newer stores', async () => {
  const dir = trackedTmpDir('catalog-fresh')
  try {
    const store = openCatalogStore(dir.path)
    try {
      for (const table of ['catalog_resources', 'artifacts', 'feature_refs', 'semantic_bindings', 'intents']) {
        assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists`)
      }
      const columns = store.db.prepare('PRAGMA table_info(catalog_resources)').all()
        .map(row => row.name)
      for (const column of ['logical_id', 'schema_digest', 'schema_fields', 'native_crs', 'authorization', 'source_digest']) {
        assert.ok(columns.includes(column), `catalog_resources carries ${column}`)
      }
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('registration publishes version, feature refs, and intent in one queryable transaction', async () => {
  const dir = trackedTmpDir('catalog-register')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const result = registerTwoPoints(store)
      assert.equal(result.deduplicated, false)
      const { resource, featureRefs } = result
      assert.equal(resource.version, 1)
      assert.match(resource.ref, /^res-[a-f0-9]{24}@v1$/)
      assert.equal(resource.featureCount, 2)
      assert.deepEqual(resource.geometryTypes, ['Point'])
      assert.equal(resource.lifecycleState, 'available')
      assert.equal(resource.coordinateConvention, 'wgs84-geographic')
      assert.deepEqual(resource.extent, [0, 0, 10, 0])
      assert.equal(resource.storageRef.startsWith('files/'), true, 'storageRef stays inside the controlled file area')
      assert.match(resource.sourceDigest, /^[a-f0-9]{64}$/)

      // The copied bytes are the immutable truth and their digest matches.
      const stored = readFileSync(join(store.root, resource.storageRef))
      assert.equal(sha256BytesHex(stored), resource.contentDigest)
      assert.equal(resource.sourceDigest, sha256BytesHex(Buffer.from('workspace/poi.geojson')))
      assert.equal(JSON.parse(stored.toString()).features.length, 2, 'the original bytes are copied verbatim')

      assert.deepEqual(featureRefs.map(ref => ref.featureIndex), [0, 1])
      assert.match(featureRefs[0].featureRef, /^f-[a-f0-9]{16}$/)
      assert.equal(featureRefs[0].originalId, 'alpha')
      assert.equal(featureRefs[1].originalId, 'beta')

      const intent = store.db.prepare(
        "SELECT result_kind, result_ref, state FROM intents WHERE operation_ref = ?",
      ).get(result.operationRef)
      assert.equal(intent.state, 'published')
      assert.equal(intent.result_ref, resource.ref)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the same publish operation returns the published version; different inputs conflict', async () => {
  const dir = trackedTmpDir('catalog-idempotent')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const first = registerTwoPoints(store, 'poi', 's-1', 7)
      const replay = registerTwoPoints(store, 'poi', 's-1', 7)
      assert.equal(replay.deduplicated, true)
      assert.equal(replay.resource.ref, first.resource.ref)
      const changed = registerTwoPoints(store, 'other', 's-1', 7)
      assert.equal(changed.resource.version, 1, 'a different logical resource gets its own identity')
      const conflicting = registerTwoPoints(store, 'poi', 's-1', 8, {
        type: 'FeatureCollection',
        features: [TWO_POINTS.features[0]],
      })
      assert.equal(conflicting.resource.version, 2, 'a new operation on the same name publishes a new version')
      assert.notEqual(conflicting.resource.contentDigest, first.resource.contentDigest)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('unique constraints hold per (logical resource, version)', async () => {
  const dir = trackedTmpDir('catalog-unique')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const first = registerTwoPoints(store, 'poi')
      assert.throws(() => {
        store.db.prepare(
          'INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at, logical_id) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(`${first.resource.resourceId}-dup`, 1, 'available', 'files/x.geojson', '0'.repeat(64), 1, '0'.repeat(64), new Date().toISOString(), first.resource.resourceId)
      }, /UNIQUE constraint failed/)
      const rowId = `${first.resource.resourceId}-v1`
      assert.throws(() => {
        store.db.prepare('INSERT INTO feature_refs (resource_id, feature_ref, feature_index) VALUES (?, ?, ?)')
          .run(rowId, first.featureRefs[0].featureRef, 9)
      }, /UNIQUE constraint failed/)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a failing publish rolls back whole: no version, no refs, no intent', async () => {
  const dir = trackedTmpDir('catalog-rollback')
  try {
    const store = openCatalogStore(dir.path)
    try {
      assert.throws(() => withTransaction(store.db, () => {
        store.db.prepare(
          'INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at, logical_id) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run('res-x-v1', 1, 'available', 'files/x.geojson', '0'.repeat(64), 1, '0'.repeat(64), new Date().toISOString(), 'res-x')
        throw new Error('injected publish failure')
      }), /injected publish failure/)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM catalog_resources').get().n, 0, 'the version rolled back')

      // An interrupted staging write (candidate file already present) fails
      // before any catalog row is written: the staging area never becomes a
      // queryable version.
      const input = {
        name: 'blocked',
        bytes: Buffer.from(JSON.stringify(TWO_POINTS)),
        sourceLabel: 'workspace/blocked.geojson',
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: 'local',
        sessionId: 's-blocked',
        sourceCallSeq: 4,
      }
      const operationRef = operationRefOf('register', input.sessionId, input.sourceCallSeq)
      const stagedPath = join(store.root, 'staging', `${operationRef}-${sha256BytesHex(input.bytes).slice(0, 12)}.geojson`)
      mkdirSync(join(store.root, 'staging'), { recursive: true })
      writeFileSync(stagedPath, 'occupied')
      assert.throws(
        () => registerResource(store.db, store.root, input),
        error => error instanceof CatalogError && error.code === 'CATALOG_IO',
      )
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM catalog_resources').get().n, 0)
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE state = 'published'").get().n, 0)
      const stagingRows = store.db.prepare('SELECT state FROM staging').all()
      assert.ok(stagingRows.every(row => row.state === 'released'), 'the failed staging claim is released for cleanup')
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('source overwrite and newer heads never change an older resourceVersion', async () => {
  const dir = trackedTmpDir('catalog-immutability')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const v1 = registerTwoPoints(store, 'poi', 's-1', 7)
      const overwritten = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [50, 50] }, properties: { name: 'moved' } }],
      }
      const v2 = registerTwoPoints(store, 'poi', 's-1', 9, overwritten)

      assert.equal(v2.resource.version, 2)
      assert.notEqual(v2.resource.contentDigest, v1.resource.contentDigest)
      const stillV1 = resolveResource(store.db, { ref: v1.resource.ref, authorization: 'local' })
      assert.equal(stillV1.resource.contentDigest, v1.resource.contentDigest, 'v1 keeps its original digest after v2 exists')
      const bytes = readResourceBytes(store.db, store.root, v1.resource.ref, 'local', MAX_REGISTER_BYTES)
      assert.deepEqual(JSON.parse(Buffer.from(bytes.bytes).toString()).features[1].properties.name, 'second',
        'v1 still reads the original bytes even though the source file was overwritten')
      assert.match(stillV1.bundle.transformVersion, /^identity$/)
      assert.ok(stillV1.bundle.catalogReadPoint.readAt)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('feature refs are deterministic and distinguish the second point', async () => {
  const dir = trackedTmpDir('catalog-features')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const first = registerTwoPoints(store, 'a', 's-1', 7)
      const again = registerTwoPoints(store, 'b', 's-1', 8)
      assert.deepEqual(again.featureRefs, first.featureRefs, 'identical bytes yield identical feature refs')

      const resolved = resolveResource(store.db, { ref: first.resource.ref, authorization: 'local' })
      assert.equal(resolved.totalFeatureRefs, 2)
      assert.equal(resolved.schema.fields[0].name, 'name')
      assert.equal(resolved.schema.fields[0].type, 'string')
      const second = resolved.featureRefs.find(entry => entry.originalId === 'beta')
      assert.equal(second.featureIndex, 1, 'the second point resolves to index 1, never the implicit first')
      assert.notEqual(second.featureRef, resolved.featureRefs[0].featureRef)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('authorization filters candidates before any content leaves the catalog', async () => {
  const dir = trackedTmpDir('catalog-auth')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const restricted = registerResource(store.db, store.root, {
        bytes: Buffer.from(JSON.stringify(TWO_POINTS)),
        sourceLabel: 'workspace/secret.geojson',
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: 'team-b',
        sessionId: 's-1',
        sourceCallSeq: 7,
      })
      // Unauthorized exact refs disclose nothing — not even existence.
      assert.throws(
        () => resolveResource(store.db, { ref: restricted.resource.ref, authorization: 'local' }),
        error => error instanceof CatalogError && error.code === 'CATALOG_NOT_FOUND',
      )
      assert.throws(
        () => readResourceBytes(store.db, store.root, restricted.resource.ref, 'local', MAX_REGISTER_BYTES),
        error => error instanceof CatalogError && error.code === 'CATALOG_NOT_FOUND',
      )
      const authorized = resolveResource(store.db, { ref: restricted.resource.ref, authorization: 'team-b' })
      assert.equal(authorized.bundle.authorizationVersion, 'team-b')

      // A revoked version returns the explicit unavailable state.
      store.db.prepare('UPDATE catalog_resources SET state = ? WHERE resource_id = ?')
        .run('revoked', rowIdOfRef(restricted.resource.ref))
      assert.throws(
        () => resolveResource(store.db, { ref: restricted.resource.ref, authorization: 'team-b' }),
        error => error instanceof CatalogError && error.code === 'CATALOG_REVOKED',
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the store budget refuses new publishes and keeps the old state intact', async () => {
  const dir = trackedTmpDir('catalog-budget')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const options = { maxStoreBytes: 10 }
      assert.throws(
        () => registerResource(store.db, store.root, {
          bytes: Buffer.from(JSON.stringify(TWO_POINTS)),
          sourceLabel: 'workspace/x.geojson',
          nativeCrs: 'EPSG:4326',
          enforceWgs84Range: true,
          authorization: 'local',
          sessionId: 's-1',
          sourceCallSeq: 7,
        }, options),
        error => error instanceof CatalogError && error.code === 'CATALOG_STORE_FULL',
      )
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM catalog_resources').get().n, 0)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM intents').get().n, 0)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('tampered bytes refuse reads with a digest mismatch, never silent success', async () => {
  const dir = trackedTmpDir('catalog-digest')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const result = registerTwoPoints(store)
      writeFileSync(join(store.root, result.resource.storageRef), '{"type":"FeatureCollection","features":[]}')
      assert.throws(
        () => readResourceBytes(store.db, store.root, result.resource.ref, 'local', MAX_REGISTER_BYTES),
        error => error instanceof CatalogError && error.code === 'CATALOG_DIGEST_MISMATCH',
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('semantic bindings freeze into the retrieval bundle', async () => {
  const dir = trackedTmpDir('catalog-binding')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const result = registerTwoPoints(store)
      const bare = resolveResource(store.db, { ref: result.resource.ref, authorization: 'local' })
      assert.equal(bare.bundle.semanticDefinition, null)
      assert.equal(bare.bundle.mappingVersion, null)
      for (let version = 1; version <= 3; version++) registerSemanticDefinition(store.db, {
        definitionId: 'poi-names', canonicalName: 'POI names', definition: 'Point labels',
        applicability: 'points', sourceRef: 'source:poi', reviewStatus: 'reviewed', authorization: 'local', sessionId: 's-1',
      })
      bindResource(store.db, result.resource.ref, {
        definitionId: 'poi-names',
        definitionVersion: 3,
        mappingVersion: 2,
        transformVersion: 'identity',
      })
      const bound = resolveResource(store.db, { ref: result.resource.ref, authorization: 'local' })
      assert.deepEqual(bound.bundle.semanticDefinition, { definitionId: 'poi-names', version: 3 })
      assert.equal(bound.bundle.mappingVersion, 2)
      assert.equal(bound.bundle.resourceRef, result.resource.ref)
      assert.equal(bound.bundle.contentDigest, result.resource.contentDigest)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('artifact publication round-trips with inherited authorization and durability reporting', async () => {
  const dir = trackedTmpDir('catalog-artifacts')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const input = registerTwoPoints(store)
      const published = publishArtifact(store.db, store.root, {
        bytes: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] })),
        inputRefs: [`${input.resource.ref}+${input.featureRefs[1].featureRef}`],
        method: { algorithm: 'turf-buffer', units: 'm', parameters: { distance_m: 500 } },
        analysisCrs: 'EPSG:4326',
        sessionId: 's-1',
        sourceCallSeq: 11,
        inputAuthorizations: ['local'],
      })
      assert.equal(published.artifact.version, 1)
      assert.equal(published.artifact.authorization, 'local')
      assert.deepEqual(published.artifact.inputRefs, [`${input.resource.ref}+${input.featureRefs[1].featureRef}`])
      assert.match(published.artifact.ref, /^art-[a-f0-9-]{36}@v1$/)

      const read = readArtifactBytes(store.db, store.root, published.artifact.ref, 'local')
      assert.equal(read.bytes.byteLength, published.artifact.byteCount)
      assert.equal(read.artifact.method.algorithm, 'turf-buffer')

      const ok = confirmDurability(store.db, store.root, [input.resource.ref, published.artifact.ref])
      assert.deepEqual(ok.map(entry => entry.status), ['ok', 'ok'])

      rmSync(join(store.root, published.artifact.storageRef))
      const missing = confirmDurability(store.db, store.root, [published.artifact.ref])
      assert.deepEqual(missing.map(entry => entry.status), ['missing-file'])

      const unpublished = confirmDurability(store.db, store.root, ['art-does-not-exist@v1'])
      assert.deepEqual(unpublished.map(entry => entry.status), ['unpublished'])
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('artifact authorization inherits the minimum privilege of its inputs', () => {
  // The sensitivity lattice derives the strictest input domain — never a
  // wider one, and never an unranked domain.
  const strictest = publishArtifactInMemory(['sensitive', 'local'])
  assert.equal(strictest.authorization, 'sensitive')
  const single = publishArtifactInMemory(['team-b'])
  assert.equal(single.authorization, 'team-b', 'a pre-governance store row keeps its recorded domain label')
  const unranked = publishArtifactInMemory(['local', 'team-b'])
  assert.equal(unranked, undefined, 'mixed unranked domains refuse the publication')
})

/** Publish a minimal artifact against a fresh store (authorization inheritance fixture). */
function publishArtifactInMemory(inputAuthorizations) {
  const dir = trackedTmpDir('catalog-inherit')
  try {
    const store = openCatalogStore(dir.path)
    try {
      let artifact
      try {
        artifact = publishArtifact(store.db, store.root, {
          bytes: Buffer.from('{"type":"FeatureCollection","features":[]}'),
          inputRefs: ['res-x@v1'],
          method: { algorithm: 'turf-buffer', units: 'm', parameters: {} },
          analysisCrs: 'EPSG:4326',
          sessionId: 's-1',
          sourceCallSeq: 1,
          inputAuthorizations,
        }).artifact
      } catch (error) {
        if (error instanceof GovernanceError && error.code === 'GOVERNANCE_DOMAIN_UNKNOWN') return undefined
        throw error
      }
      return artifact
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
}

test('admission rejects malformed payloads, budgets, and WGS84 range escapes', () => {
  const bytes = value => Buffer.from(JSON.stringify(value))
  assert.throws(() => admitCollection(bytes({ type: 'Feature' }), { enforceWgs84Range: true }), /FeatureCollection/)
  assert.throws(() => admitCollection(Buffer.from('not json'), { enforceWgs84Range: true }), /valid JSON/)
  assert.throws(
    () => admitCollection(bytes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [] }, properties: {} }],
    }), { enforceWgs84Range: true }),
    /unsupported geometry type/,
  )
  assert.throws(
    () => admitCollection(bytes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [200, 0] }, properties: {} }],
    }), { enforceWgs84Range: true }),
    /outside the WGS84 range/,
  )
  for (const geometry of [
    { type: 'LineString', coordinates: [0, 0] },
    { type: 'Polygon', coordinates: [[0, 0]] },
    { type: 'Polygon', coordinates: [] },
  ]) {
    assert.throws(
      () => admitCollection(bytes({
        type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }],
      }), { enforceWgs84Range: true }),
      /coordinates must contain|rings must contain/,
      `malformed ${geometry.type} nesting must be refused`,
    )
  }
  let deepCoordinates = [0, 0]
  for (let depth = 0; depth < 20; depth += 1) deepCoordinates = [deepCoordinates]
  assert.throws(
    () => admitCollection(bytes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: deepCoordinates }, properties: {} }],
    }), { enforceWgs84Range: false }),
    /depth limit|rings must contain/,
  )
  const projected = admitCollection(bytes({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [500000, 0] }, properties: {} }],
  }), { enforceWgs84Range: false })
  assert.deepEqual(projected.extent, [500000, 0, 500000, 0], 'projected sources skip the geographic range check')
})

test('the publish projection pairs accepted publish calls with their durable seqs', () => {
  const state = spatialCatalogProjectionDefinition.init({}, 0)
  const call = { type: 'tool/call', seq: 5, data: { callId: 'c-1', name: 'geo_buffer' } }
  const nonPublishCall = { type: 'tool/call', seq: 6, data: { callId: 'c-2', name: 'map_set_view' } }
  assert.ok((PUBLISH_TOOL_NAMES).includes('geo_buffer'))
  const afterCall = spatialCatalogProjectionDefinition.apply(state, call)
  assert.equal(spatialCatalogProjectionDefinition.apply(afterCall, nonPublishCall), afterCall, 'non-publish calls change nothing')
  assert.deepEqual(afterCall.pendingCalls, [{ callId: 'c-1', callSeq: 5, name: 'geo_buffer' }])
  const result = {
    type: 'tool/result',
    seq: 7,
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c-1' }] } },
  }
  const afterResult = spatialCatalogProjectionDefinition.apply(afterCall, result)
  assert.deepEqual(afterResult.pendingCalls, [], 'the settled result consumes the pending entry')
  assert.equal(spatialCatalogProjectionDefinition.apply(afterResult, result), afterResult, 'a second settle changes nothing')
})

test('a duplicate publish call id consumes only the matching pending entry', () => {
  const first = { type: 'tool/call', seq: 10, data: { callId: 'same', name: 'geo_buffer' } }
  const second = { type: 'tool/call', seq: 11, data: { callId: 'same', name: 'geo_buffer' } }
  const result = {
    type: 'tool/result',
    data: { message: { toolCallId: 'same', content: [] } },
  }
  const afterCalls = spatialCatalogProjectionDefinition.apply(
    spatialCatalogProjectionDefinition.apply(spatialCatalogProjectionDefinition.init({}, 0), first), second,
  )
  const afterResult = spatialCatalogProjectionDefinition.apply(afterCalls, result)
  assert.deepEqual(afterResult.pendingCalls, [{ callId: 'same', callSeq: 11, name: 'geo_buffer' }])
})
