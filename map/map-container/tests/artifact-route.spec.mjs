/**
 * Artifact download route: authorized exact-version reads stream the
 * catalog bytes with fixed headers, and every uncertain path — unknown
 * session, unknown or loose ref, denied authorization, digest-corrupted
 * bytes — refuses with its fixed code and no storage detail. Without a host
 * Connection the route stays unmounted without throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerArtifactRoute, serveArtifactRequest, MAP_ARTIFACT_ROUTE } from '../src/artifact-route.ts'
import { MAX_ARTIFACT_BYTES } from '../../spatial-catalog/src/index.ts'

function catalogError(code) {
  return Object.assign(new Error(`${code}: test`), { code })
}

function fakeCatalog(overrides = {}) {
  const calls = []
  return {
    calls,
    forSession(sessionId) {
      return {
        async readResourceBytes(ref, authorization, maxBytes) {
          calls.push({ kind: 'resource', sessionId, ref, authorization, maxBytes })
          if (overrides.resourceError !== undefined) throw overrides.resourceError
          return { resource: { ref, version: 2 }, bytes: overrides.resourceBytes ?? new Uint8Array([1, 2, 3]) }
        },
        async readArtifactBytes(ref, authorization) {
          calls.push({ kind: 'artifact', sessionId, ref, authorization })
          if (overrides.artifactError !== undefined) throw overrides.artifactError
          return { artifact: { ref, version: 1 }, bytes: overrides.artifactBytes ?? new Uint8Array([9, 8]) }
        },
      }
    },
    deploymentDomain() {
      return 'domain-test'
    },
  }
}

function requestOf(query) {
  return new Request(`http://host${MAP_ARTIFACT_ROUTE}?${query}`)
}

test('an authorized resource read streams the exact version bytes', async () => {
  const catalog = fakeCatalog()
  const response = await serveArtifactRequest(requestOf('session=s1&ref=res-abc@v2'), catalog)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-length'), '3')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="res-abc@v2"')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3])
  assert.deepEqual(catalog.calls, [{ kind: 'resource', sessionId: 's1', ref: 'res-abc@v2', authorization: 'domain-test', maxBytes: MAX_ARTIFACT_BYTES }])
})

test('an authorized artifact read streams the artifact bytes', async () => {
  const catalog = fakeCatalog()
  const response = await serveArtifactRequest(requestOf('session=s1&ref=art-xyz@v1'), catalog)
  assert.equal(response.status, 200)
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8])
  assert.deepEqual(catalog.calls, [{ kind: 'artifact', sessionId: 's1', ref: 'art-xyz@v1', authorization: 'domain-test' }])
})

test('an absent or malformed session refuses as unknown-session without opening the catalog', async () => {
  const catalog = fakeCatalog()
  for (const query of ['ref=res-abc@v2', 'session=&ref=res-abc@v2', `session=${'x'.repeat(200)}&ref=res-abc@v2`, 'session=bad%20session&ref=res-abc@v2']) {
    const response = await serveArtifactRequest(requestOf(query), catalog)
    assert.equal(response.status, 400, query)
    assert.deepEqual(await response.json(), { ok: false, code: 'unknown-session' })
  }
  assert.equal(catalog.calls.length, 0)
})

test('unknown, loose, and non-whitelisted refs refuse as unknown-ref', async () => {
  const catalog = fakeCatalog()
  for (const query of ['session=s1', 'session=s1&ref=', 'session=s1&ref=res-abc', 'session=s1&ref=res-abc@v0', 'session=s1&ref=res-abc@v2&extra=1']) {
    const response = await serveArtifactRequest(requestOf(query), catalog)
    assert.equal(response.status, 404, query)
    assert.deepEqual(await response.json(), { ok: false, code: 'unknown-ref' })
  }
  assert.equal(catalog.calls.length, 0)
})

test('the catalog not-found answer refuses as unknown-ref', async () => {
  const catalog = fakeCatalog({ resourceError: catalogError('CATALOG_NOT_FOUND') })
  const response = await serveArtifactRequest(requestOf('session=s1&ref=res-abc@v2'), catalog)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { ok: false, code: 'unknown-ref' })
})

test('denied and revoked authorization refuse as unauthorized', async () => {
  for (const code of ['GOVERNANCE_DENIED', 'CATALOG_REVOKED']) {
    const catalog = fakeCatalog({ artifactError: catalogError(code) })
    const response = await serveArtifactRequest(requestOf('session=s1&ref=art-xyz@v1'), catalog)
    assert.equal(response.status, 403, code)
    assert.deepEqual(await response.json(), { ok: false, code: 'unauthorized' })
  }
})

test('digest-corrupted bytes refuse as digest-mismatch', async () => {
  const catalog = fakeCatalog({ resourceError: catalogError('CATALOG_DIGEST_MISMATCH') })
  const response = await serveArtifactRequest(requestOf('session=s1&ref=res-abc@v2'), catalog)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { ok: false, code: 'digest-mismatch' })
})

test('a host without a Connection mounts no route and never throws', () => {
  const ctx = { get: () => undefined }
  assert.equal(registerArtifactRoute(ctx, fakeCatalog()), undefined)
})

test('registration binds the exact GET route and its disposer releases it', async () => {
  const registered = []
  let disposed = 0
  const ctx = {
    get(name) {
      return name === 'connection'
        ? { fetch: { register(route) { registered.push(route); return async () => { disposed += 1 } } } }
        : undefined
    },
  }
  const dispose = registerArtifactRoute(ctx, fakeCatalog())
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, MAP_ARTIFACT_ROUTE)
  assert.deepEqual(registered[0].methods, ['GET'])
  assert.equal(registered[0].requestBody, 'buffered')
  const response = await registered[0].fetch(requestOf('session=s1&ref=res-abc@v2'))
  assert.equal(response.status, 200)
  await dispose()
  assert.equal(disposed, 1)
})
