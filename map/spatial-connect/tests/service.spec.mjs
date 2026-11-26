/**
 * Config and service gates: the deployment surface the host mounts — schema
 * defaults (credential references are environment-variable names, never
 * values), load-time validation (id namespace, endpoint shapes, the
 * sixteen-connection budget, credential references resolving to non-empty
 * environment values), and the service face (listings carry names not
 * secrets; unknown ids and pre-aborted verifications fail loud with the
 * documented codes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  ConnectError,
  DEFAULT_COG_TOKEN_ENV,
  DEFAULT_POSTGRES_PASSWORD_ENV,
  DEFAULT_S3_ACCESS_KEY_ID_ENV,
  DEFAULT_S3_SECRET_ACCESS_KEY_ENV,
  buildSpatialConnectService,
  resolveConnections,
} from '../src/index.ts'

const ENV = {
  PG_PW: 'pg-secret-value',
  AK: 'ak-value',
  SK: 'sk-value',
  SESSION: 'session-value',
  COG_TOKEN: 'cog-token-value',
}

// Declarations carry explicit environment references so the fixture
// environment below resolves them (the default names stay covered by the
// schema-defaults test).
const POSTGIS = { id: 'db-main', host: 'db.example.org', database: 'gis', user: 'gis_ro', passwordEnv: 'PG_PW' }
const STORE = { id: 'tiles', endpoint: 'https://s3.example.org', region: 'eu-west-1', bucket: 'tiles', accessKeyIdEnv: 'AK', secretAccessKeyEnv: 'SK' }
const COG = { id: 'ortho', url: 'https://cdn.example.org/ortho.tif', tokenEnv: 'COG_TOKEN' }

test('the config schema materializes credential-reference defaults, never values', () => {
  // Declarations without explicit references exercise the defaults.
  const configured = Config({
    postgis: [{ id: 'db-main', host: 'db.example.org', database: 'gis', user: 'gis_ro' }],
    objectStores: [{ id: 'tiles', endpoint: 'https://s3.example.org', region: 'eu-west-1', bucket: 'tiles' }],
    cogs: [{ id: 'ortho', url: 'https://cdn.example.org/ortho.tif' }],
  })
  assert.equal(configured.postgis[0].passwordEnv, DEFAULT_POSTGRES_PASSWORD_ENV)
  assert.equal(configured.postgis[0].ssl, 'prefer')
  assert.equal(configured.objectStores[0].accessKeyIdEnv, DEFAULT_S3_ACCESS_KEY_ID_ENV)
  assert.equal(configured.objectStores[0].secretAccessKeyEnv, DEFAULT_S3_SECRET_ACCESS_KEY_ENV)
  assert.equal(configured.objectStores[0].sessionTokenEnv, undefined)
  assert.equal(configured.objectStores[0].addressing, 'path')
  assert.equal(configured.cogs[0].tokenEnv, undefined)
  assert.equal(JSON.stringify(configured).includes('pg-secret-value'), false, 'config never carries values')
})

test('resolveConnections resolves every referenced credential at load', () => {
  const registry = resolveConnections({ postgis: [POSTGIS], objectStores: [STORE], cogs: [COG] }, ENV)
  assert.equal(registry.size, 3)
  assert.deepEqual([...registry.keys()], ['db-main', 'tiles', 'ortho'])
  const postgis = registry.get('db-main')
  assert.equal(postgis.kind, 'postgis')
  assert.equal(postgis.credentials.password, 'pg-secret-value')
  const store = registry.get('tiles')
  assert.equal(store.kind, 'object-storage')
  assert.equal(store.credentials.accessKeyId, 'ak-value')
  assert.equal(store.credentials.secretAccessKey, 'sk-value')
  const cog = registry.get('ortho')
  assert.equal(cog.kind, 'cog')
})

test('a missing credential reference fails the load loud with the variable named', () => {
  assert.throws(
    () => resolveConnections({ postgis: [POSTGIS] }, {}),
    error => {
      assert.ok(error instanceof ConnectError)
      assert.match(error.message, /PG_PW/)
      assert.match(error.message, /db-main/)
      assert.match(error.message, /environment/)
      return true
    },
  )
  assert.throws(
    () => resolveConnections({ objectStores: [{ ...STORE, sessionTokenEnv: 'SESSION' }] }, { AK: 'x', SK: 'y' }),
    error => {
      assert.match(error.message, /SESSION/)
      return true
    },
  )
})

test('ids are one namespace across kinds; collisions fail the load', () => {
  assert.throws(
    () => resolveConnections({ postgis: [POSTGIS], cogs: [{ ...COG, id: 'db-main' }] }, ENV),
    error => {
      assert.match(error.message, /more than once/)
      return true
    },
  )
})

test('invalid declarations fail the load with the connection named', () => {
  assert.throws(() => resolveConnections({ postgis: [{ ...POSTGIS, id: 'Bad Id' }] }, ENV), /postgis connection Bad Id/)
  assert.throws(() => resolveConnections({ objectStores: [{ ...STORE, endpoint: 'https://host/prefix' }] }, ENV), /object-store connection tiles/)
  assert.throws(() => resolveConnections({ cogs: [{ ...COG, url: 'ftp://x/y.tif' }] }, ENV), /cog connection ortho/)
})

test('the sixteen-connection budget fails loud on the seventeenth', () => {
  const sixteen = Array.from({ length: 16 }, (_, index) => ({ ...POSTGIS, id: `db-${String(index)}` }))
  assert.doesNotThrow(() => resolveConnections({ postgis: sixteen }, ENV))
  const seventeen = [...sixteen, { ...POSTGIS, id: 'db-extra' }]
  assert.throws(() => resolveConnections({ postgis: seventeen }, ENV), /at most 16/)
})

test('listings carry endpoint identities and reference names, never secret values', () => {
  const service = buildSpatialConnectService(resolveConnections({
    postgis: [POSTGIS],
    objectStores: [{ ...STORE, sessionTokenEnv: 'SESSION' }],
    cogs: [{ ...COG, tokenEnv: 'COG_TOKEN' }],
  }, ENV))
  const summaries = service.listConnections()
  assert.equal(summaries.length, 3)
  for (const summary of summaries) {
    const text = JSON.stringify(summary)
    assert.equal(text.includes('pg-secret-value'), false)
    assert.equal(text.includes('ak-value'), false)
    assert.equal(text.includes('sk-value'), false)
    assert.equal(text.includes('session-value'), false)
    assert.equal(text.includes('cog-token-value'), false)
  }
  const postgis = summaries.find(summary => summary.id === 'db-main')
  assert.match(postgis.endpoint, /postgres:\/\/gis_ro@db\.example\.org:5432\/gis/)
  assert.match(postgis.endpoint, /passwordEnv PG_PW/)
  const store = summaries.find(summary => summary.id === 'tiles')
  assert.match(store.endpoint, /s3\.example\.org\/tiles\//)
  assert.match(store.endpoint, /keys AK\/SK\/SESSION/)
  const cog = summaries.find(summary => summary.id === 'ortho')
  assert.match(cog.endpoint, /cdn\.example\.org\/ortho\.tif/)
  assert.match(cog.endpoint, /tokenEnv COG_TOKEN/)
  // Specs list ids and kinds for consumers; no credential values ride along.
  assert.deepEqual(service.specs.map(spec => spec.id), ['db-main', 'tiles', 'ortho'])
  assert.equal(JSON.stringify(service.specs).includes('pg-secret-value'), false)
})

test('verifyConnection fails loud on unknown ids and pre-aborted signals', async () => {
  const service = buildSpatialConnectService(resolveConnections({ postgis: [POSTGIS] }, ENV))
  await assert.rejects(
    () => service.verifyConnection('nope'),
    error => {
      assert.ok(error instanceof ConnectError)
      assert.match(error.message, /no declared connection carries id nope/)
      return true
    },
  )
  const aborted = AbortSignal.abort()
  await assert.rejects(
    () => service.verifyConnection('db-main', { signal: aborted }),
    error => {
      assert.ok(error instanceof ConnectError)
      assert.match(error.message, /aborted before the exchange started/)
      return true
    },
  )
})

test('an empty config resolves to an empty registry and an empty listing', () => {
  const service = buildSpatialConnectService(resolveConnections({}, ENV))
  assert.deepEqual(service.listConnections(), [])
  assert.deepEqual(service.specs, [])
})
