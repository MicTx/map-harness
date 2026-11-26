/** Semantic definition versions, alias retrieval, authorization filtering, and binding gates. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindResource,
  CatalogError,
  openCatalogStore,
  registerResource,
  registerSemanticDefinition,
  searchSemanticDefinitions,
  transitionGrant,
} from '../src/index.ts'
import { trackedTmpDir } from '../../spatial-storage/tests/support.mjs'
import { migrateStore } from '../../spatial-storage/src/migrate.ts'
import { openStoreDatabase, STORE_MIGRATION_STEPS, storeDbPath } from '../../spatial-storage/src/schema.ts'

const POINTS = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] })

function resource(store) {
  return registerResource(store.db, store.root, {
    name: 'points', bytes: Buffer.from(POINTS), sourceLabel: 'points.geojson',
    nativeCrs: 'EPSG:4326', enforceWgs84Range: true, authorization: 'local', sessionId: 's', sourceCallSeq: 1,
  }).resource
}

test('semantic definitions publish immutable versions and retrieve exact aliases with applicability', () => {
  const dir = trackedTmpDir('semantic-retrieve')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const first = registerSemanticDefinition(store.db, {
        sessionId: 's', definitionId: 'clinic-count', canonicalName: 'Clinic count', aliases: ['clinics', '医疗点'],
        definition: { unit: 'count', numerator: 'clinic' }, applicability: 'health facilities', sourceRef: 'doc:health', reviewStatus: 'reviewed', authorization: 'local',
      })
      const second = registerSemanticDefinition(store.db, {
        sessionId: 's', definitionId: 'clinic-count', canonicalName: 'Clinic count', aliases: ['clinics', '医疗点', 'clinics-v2'],
        definition: { unit: 'count', numerator: 'clinic_v2' }, applicability: 'health facilities', sourceRef: 'doc:health-v2', reviewStatus: 'reviewed', authorization: 'local',
      })
      assert.equal(first.version, 1)
      assert.equal(second.version, 2)
      const result = searchSemanticDefinitions(store.db, { query: '医疗点', authorization: 'local', applicability: 'health' })
      assert.equal(result.total, 1)
      assert.equal(result.candidates[0].exact, true)
      assert.equal(result.candidates[0].definition.version, 2)
      assert.deepEqual(result.candidates[0].definition.definition, { unit: 'count', numerator: 'clinic_v2' })
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('semantic search is bounded and filters revoked definitions before candidates are emitted', () => {
  const dir = trackedTmpDir('semantic-governance')
  try {
    const store = openCatalogStore(dir.path)
    try {
      for (const id of ['a', 'b', 'c']) registerSemanticDefinition(store.db, {
        sessionId: 's', definitionId: id, canonicalName: `facility ${id}`, definition: 'facility',
        applicability: 'urban', sourceRef: `doc:${id}`, reviewStatus: 'reviewed', authorization: 'local',
      })
      transitionGrant(store.db, 'semantic', 'def-b@v1', 'local', 'revoked')
      const result = searchSemanticDefinitions(store.db, { query: 'facility', authorization: 'local', limit: 2 })
      assert.equal(result.total, 2)
      assert.deepEqual(result.candidates.map(candidate => candidate.definition.definitionId), ['a', 'c'])
      assert.throws(
        () => searchSemanticDefinitions(store.db, { query: 'facility', authorization: 'local', limit: 33 }),
        error => error instanceof CatalogError && error.code === 'CATALOG_INVALID_INPUT',
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('resource bindings reject unknown definition versions before writing a binding', () => {
  const dir = trackedTmpDir('semantic-binding')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const version = resource(store)
      assert.throws(
        () => bindResource(store.db, version.ref, { definitionId: 'missing', definitionVersion: 1, mappingVersion: 1, transformVersion: 'identity' }),
        error => error instanceof CatalogError && error.code === 'CATALOG_NOT_FOUND',
      )
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM semantic_bindings').get().count, 0)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('v3 semantic bindings receive a legacy definition during the v4 migration', () => {
  const dir = trackedTmpDir('semantic-legacy-migration')
  try {
    migrateStore(dir.path, { steps: STORE_MIGRATION_STEPS.slice(0, 3) })
    const old = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 3 })
    try {
      old.prepare(
        'INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at, logical_id, media_type, feature_count, geometry_types, schema_fields, native_crs, source_digest, authorization, registered_by) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('res-legacy-v1', 1, 'available', 'files/legacy.geojson', '0'.repeat(64), 1, '0'.repeat(64), '2026-10-01T00:00:00Z', 'res-legacy', 'application/geo+json', 0, '[]', '[]', 'EPSG:4326', '0'.repeat(64), 'local', 's')
      old.prepare(
        'INSERT INTO semantic_bindings (resource_id, definition_id, definition_version, mapping_version, transform_version, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('res-legacy-v1', 'legacy-def', 2, 1, 'identity', '2026-10-01T00:00:00Z')
      old.prepare(
        'INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('semantic', 'def-legacy-def@v2', 'local', 'granted', 1, '2026-10-01T00:00:00Z')
    } finally {
      old.close()
    }
    migrateStore(dir.path)
    const current = openCatalogStore(dir.path)
    try {
      const row = current.db.prepare('SELECT review_status, source_ref, definition FROM semantic_definitions WHERE definition_id = ? AND version = ?').get('legacy-def', 2)
      assert.equal(row.review_status, 'legacy-binding')
      assert.equal(row.source_ref, 'legacy:semantic_bindings')
      assert.equal(row.definition, '{"legacyBinding":true}')
    } finally {
      current.close()
    }
  } finally {
    dir.dispose()
  }
})
