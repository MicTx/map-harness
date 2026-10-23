/**
 * Contract gates: the closed vocabulary and validation functions the three
 * connectors and the deployment Config share — id shapes, host and endpoint
 * shapes, timeout bounds, outcome vocabulary closure, and the detail
 * sanitization that keeps credential bytes out of every report.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECTION_OUTCOMES,
  DEFAULT_TIMEOUT_MS,
  HTTP_ROOT_PATTERN,
  MAX_CONNECTIONS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  POSTGRES_DEFAULT_PORT,
  SPATIAL_CONNECT_VERSION,
  bounded,
  cogSpecProblem,
  connectionIdProblem,
  hostProblem,
  objectStoreSpecProblem,
  postgresSpecProblem,
  sanitizeDetail,
  timeoutProblem,
} from '../src/contract.ts'

const VALID_POSTGRES = { id: 'db-main', host: 'db.example.org', database: 'gis', user: 'gis_ro', passwordEnv: 'PG_PW', ssl: 'require' }
const VALID_STORE = { id: 'tiles', endpoint: 'https://s3.example.org', region: 'eu-west-1', bucket: 'tiles', accessKeyIdEnv: 'AK', secretAccessKeyEnv: 'SK', addressing: 'path' }
const VALID_COG = { id: 'ortho', url: 'https://cdn.example.org/ortho.tif' }

test('the contract is versioned and the outcome vocabulary is closed', () => {
  assert.equal(SPATIAL_CONNECT_VERSION, 'spatial-connect@1')
  assert.deepEqual(CONNECTION_OUTCOMES, [
    'connected', 'auth-rejected', 'unreachable', 'timeout', 'server-refused',
    'not-found', 'protocol-violated', 'unsupported-channel', 'invalid-content', 'aborted',
  ])
})

test('connection ids must be kebab-case and short', () => {
  assert.equal(connectionIdProblem('db-main'), undefined)
  assert.equal(connectionIdProblem('ortho-2026'), undefined)
  assert.match(connectionIdProblem(''), /must match/)
  assert.match(connectionIdProblem('DB'), /must match/)
  assert.match(connectionIdProblem('-lead'), /must match/)
  assert.equal(connectionIdProblem('a'.repeat(64)), undefined, '64 characters fit the budget')
  assert.match(connectionIdProblem('a'.repeat(65)), /must match/)
})

test('hosts are lowercase DNS names or IPv4, never paths, schemes, or bracketed IPv6', () => {
  assert.equal(hostProblem('db.internal'), undefined)
  assert.equal(hostProblem('127.0.0.1'), undefined)
  assert.match(hostProblem('[::1]'), /hostname/)
  assert.match(hostProblem('https://db.internal'), /hostname/)
  assert.match(hostProblem('db.internal:5432'), /hostname/)
  assert.match(hostProblem('db.internal/x'), /hostname/)
  assert.match(hostProblem(''), /hostname/)
})

test('timeouts live in the bounded window', () => {
  assert.equal(timeoutProblem(undefined), undefined)
  assert.equal(timeoutProblem(DEFAULT_TIMEOUT_MS), undefined)
  assert.match(timeoutProblem(100), /between/)
  assert.match(timeoutProblem(MAX_TIMEOUT_MS + 1), /between/)
  assert.match(timeoutProblem(1500.5), /between/)
  assert.equal(MIN_TIMEOUT_MS, 1000)
})

test('postgres specs validate shape; the port window and ssl enum are checked', () => {
  assert.equal(postgresSpecProblem(VALID_POSTGRES), undefined)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, id: 'Bad Id' }), /id/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, host: 'nope host' }), /host/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, port: 0 }), /port/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, port: 70000 }), /port/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, database: '' }), /database/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, user: '' }), /user/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, ssl: 'maybe' }), /ssl/)
  assert.match(postgresSpecProblem({ ...VALID_POSTGRES, timeoutMs: 10 }), /timeout/)
  assert.equal(POSTGRES_DEFAULT_PORT, 5432)
})

test('object-store endpoints are scheme-host roots without path, query, or userinfo', () => {
  assert.equal(objectStoreSpecProblem(VALID_STORE), undefined)
  assert.equal(objectStoreSpecProblem({ ...VALID_STORE, endpoint: 'https://s3.example.org:8443' }), undefined)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, endpoint: 'https://s3.example.org/prefix' }), /endpoint/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, endpoint: 'https://s3.example.org?x=1' }), /endpoint/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, endpoint: 'https://key:secret@s3.example.org' }), /endpoint/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, endpoint: 'ftp://s3.example.org' }), /endpoint/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, region: '' }), /region/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, bucket: 'Bucket' }), /bucket/)
  assert.match(objectStoreSpecProblem({ ...VALID_STORE, addressing: 'subdomain' }), /addressing/)
  assert.ok(HTTP_ROOT_PATTERN.test('http://minio.internal:9000'))
})

test('cog specs are plain http(s) URLs', () => {
  assert.equal(cogSpecProblem(VALID_COG), undefined)
  assert.equal(cogSpecProblem({ ...VALID_COG, tokenEnv: 'COG_TOKEN' }), undefined)
  assert.match(cogSpecProblem({ ...VALID_COG, url: 'file:///data/ortho.tif' }), /url/)
  assert.match(cogSpecProblem({ ...VALID_COG, url: '' }), /url/)
})

test('bounded clamps oversized detail strings with an explicit marker', () => {
  const long = 'x'.repeat(400)
  const clipped = bounded(long)
  assert.equal(clipped.length, 200 + 1)
  assert.ok(clipped.endsWith('…'))
  assert.equal(bounded('short'), 'short')
  assert.equal(bounded('line\u0000break'), 'line break')
})

test('sanitizeDetail passes clean detail through and redacts wholesale on any leak', () => {
  const clean = sanitizeDetail('auth failed for role gis_ro at db.example.org', ['hunter2', 'tok_ABC123', undefined])
  assert.equal(clean, 'auth failed for role gis_ro at db.example.org')
  const leaked = sanitizeDetail('auth failed for hunter2 via token tok_ABC123 at db', ['hunter2', 'tok_ABC123'])
  assert.equal(leaked, '[redacted]')
})

test('the connection budget is sixteen', () => {
  assert.equal(MAX_CONNECTIONS, 16)
})
