import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import dns from 'node:dns'
import { spawn } from 'node:child_process'
import { createSourceNetwork } from '../src/source-network.ts'
import { resolveSourceNetworkConfig } from '../src/source-network-config.ts'
import { sourceHostAllowed, sourceResolvedAddressAllowed, sourceResolvedAddressIgnorable } from '../src/source-address.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { port: server.address().port, server }
}

function source(port, { hostname = '127.0.0.1', credential, secret = 'fake-fixture-secret', allowPrivateNetwork = true } = {}) {
  const catalog = createMapSourceCatalog({
    credentials: credential === undefined ? {} : { fixture: credential },
    custom: [{
      id: 'fixture-source', title: 'Fixture', role: 'basemap', adapter: 'arcgis-mapserver',
      endpoint: `http://${hostname}:${port}/MapServer`,
      attribution: 'Fixture owner', nativeWkid: 3857, supportedModes: ['map'],
      minZoom: 0, maxZoom: 23, compatibleBasemapIds: [],
      allowPrivateNetwork, allowHttp: true,
      ...(credential === undefined ? {} : { credentialRef: 'fixture' }),
    }],
  }, 'allow', { FIXTURE_TOKEN: secret })
  const entry = catalog.list({ provider: 'custom' }).sources[0]
  return catalog.resolvedSource(entry.id, entry.configDigest)
}

function network(t, config = {}, dependencies = {}) {
  const owner = createSourceNetwork(resolveSourceNetworkConfig({ requestTimeoutMs: 2_000, ...config }), dependencies)
  t.after(() => owner.dispose())
  return owner
}

function request(owner, resolved, suffix = '?f=json', extra = {}) {
  return owner.request({ source: resolved, url: new URL(`${resolved.endpoint}${suffix}`), payload: 'json', ...extra })
}

function code(expected) {
  return error => error instanceof SourceCatalogError && error.code === expected
}

function noData() {
  return Object.assign(new Error('fixture DNS has no records'), { code: 'ENODATA' })
}

test('proxy settings resolve explicit coherent bounds and reject malformed values on activation', () => {
  const limits = resolveSourceNetworkConfig()
  assert.equal(limits.requestTimeoutMs, 15_000)
  assert.equal(limits.maxConcurrentRequests, 16)
  assert.equal(Object.isFrozen(limits), true)
  assert.equal(resolveSourceNetworkConfig({ cacheMaxBytes: 0, cacheMaxEntries: 0, maxQueuedRequests: 0 }).maxQueuedRequests, 0)
  for (const config of [
    null, [], { unknown: 1 }, { requestTimeoutMs: null }, { requestTimeoutMs: 0 },
    { requestTimeoutMs: Infinity }, { maxConcurrentRequests: 65 }, { maxQueuedRequests: -1 },
    { maxMetadataBytes: 33_554_432 }, { maxResponseBytes: 1 },
    { cacheMaxBytes: 0 }, { cacheMaxEntries: 0 }, { cacheMaxEntries: 2_049 },
  ]) {
    assert.throws(() => resolveSourceNetworkConfig(config), code('SOURCE_CONFIG_INVALID'))
    assert.throws(() => createMapSourceCatalog({ proxy: config }, 'allow', {}), code('SOURCE_CONFIG_INVALID'))
  }
  for (const key of ['maxSources', 'maxCatalogBytes', 'defaultPageSize', 'maxPageSize']) {
    assert.throws(() => createMapSourceCatalog({ [key]: null }, 'allow', {}), code('SOURCE_CONFIG_INVALID'))
  }
})

test('source DNS policy distinguishes public, explicit private and never-allowed addresses', () => {
  for (const address of ['8.8.8.8', '2606:4700::1111']) assert.equal(sourceResolvedAddressAllowed(address, false), true)
  for (const address of ['127.0.0.1', '10.1.2.3', '::1', 'fd12::1', '::ffff:127.0.0.1']) {
    assert.equal(sourceResolvedAddressAllowed(address, false), false)
    assert.equal(sourceResolvedAddressAllowed(address, true), true)
  }
  for (const address of ['source.example', 'not an IP', '0.0.0.0', '169.254.169.254', '100.100.100.200', 'fd00:ec2::254', '::ffff:100.100.100.200', '224.0.0.1', '::', 'ff02::1']) {
    assert.equal(sourceResolvedAddressAllowed(address, true), false)
  }
  // A public Teredo record is not dialable but also not a private-network signal.
  const teredo = [0x2001, 0, 0x4136, 0xe378, 0x8000, 0x63bf, 0x3fff, 0xfdd2].map(part => part.toString(16)).join(':')
  assert.equal(sourceResolvedAddressAllowed(teredo, true), false)
  assert.equal(sourceResolvedAddressIgnorable(teredo), true)
  assert.equal(sourceResolvedAddressIgnorable('127.0.0.1'), false)
  assert.equal(sourceResolvedAddressIgnorable('not an IP'), false)
  assert.equal(sourceHostAllowed('tiles.example.test', false), true)
  assert.equal(sourceHostAllowed('localhost', false), false)
})

test('real local GET preserves compiled path, Host, identity encoding and private credential binding', async t => {
  const received = []
  const target = await fixture(t, (req, res) => {
    received.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization, encoding: req.headers['accept-encoding'] })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', etag: '"private-tag"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT', 'cache-control': 'max-age=60', 'set-cookie': 'not-a-public-header' })
    res.end('{"ok":true}')
  })
  const owner = network(t)
  const bearer = source(target.port, { credential: { type: 'bearer', env: 'FIXTURE_TOKEN' } })
  const result = await request(owner, bearer)
  assert.equal(result.body.toString(), '{"ok":true}')
  assert.equal(result.status, 200)
  assert.equal(result.contentType, 'application/json')
  assert.equal(result.cache.etag, '"private-tag"')
  assert.deepEqual(Object.keys(result.cache).sort(), ['age', 'cacheControl', 'date', 'etag', 'expires', 'lastModified', 'vary'])
  assert.equal(received[0].url, '/MapServer?f=json')
  assert.equal(received[0].host, `127.0.0.1:${target.port}`)
  assert.equal(received[0].authorization === 'Bearer fake-fixture-secret', true)
  assert.equal(received[0].encoding, 'identity')
  const query = source(target.port, { credential: { type: 'query', parameter: 'tk', env: 'FIXTURE_TOKEN' } })
  await request(owner, query)
  assert.equal(new URL(received[1].url, query.endpoint).searchParams.get('tk') === 'fake-fixture-secret', true)
  assert.equal(Object.hasOwn(result, 'set-cookie'), false)
})

test('queued conditional validators are snapshotted, prioritized and kept in private cache facts', async t => {
  const entered = deferred()
  const release = deferred()
  const received = []
  const target = await fixture(t, async (req, res) => {
    received.push({ etag: req.headers['if-none-match'], modified: req.headers['if-modified-since'] })
    if (received.length === 1) {
      entered.resolve()
      await release.promise
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    res.writeHead(304, {
      etag: '"fixture-v1"', age: '7', date: 'Tue, 03 Nov 2026 12:00:00 GMT',
      expires: 'Tue, 03 Nov 2026 12:01:00 GMT', vary: 'Accept', 'cache-control': 'max-age=60',
    }).end()
  })
  const owner = network(t, { maxConcurrentRequests: 1 })
  const resolved = source(target.port)
  const first = request(owner, resolved)
  await entered.promise
  const validators = { etag: '"fixture-v1"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' }
  const second = request(owner, resolved, '?f=json', { validators })
  validators.etag = '"changed-after-queue"'
  validators.lastModified = 'changed-after-queue'
  release.resolve()
  await first
  const result = await second
  assert.deepEqual(received[1], { etag: '"fixture-v1"', modified: undefined })
  assert.equal(result.status, 304)
  assert.equal(result.body.byteLength, 0)
  assert.deepEqual(result.cache, {
    etag: '"fixture-v1"', lastModified: null, cacheControl: 'max-age=60',
    age: '7', date: 'Tue, 03 Nov 2026 12:00:00 GMT',
    expires: 'Tue, 03 Nov 2026 12:01:00 GMT', vary: 'Accept',
  })
})

test('invalid conditional values never send and oversized private cache headers prohibit retention', async t => {
  let hits = 0
  const target = await fixture(t, (_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json', etag: `"${'x'.repeat(2_500)}"`, 'cache-control': 'max-age=60' }).end('{}')
  })
  const owner = network(t)
  const resolved = source(target.port)
  await assert.rejects(request(owner, resolved, '?f=json', {
    validators: { etag: '"bad\r\nInjected: value"', lastModified: null },
  }), code('SOURCE_RESOURCE_DENIED'))
  assert.equal(hits, 0)
  const result = await request(owner, resolved)
  assert.equal(hits, 1)
  assert.equal(result.cache.cacheControl, 'no-store')
  assert.equal(result.cache.etag, null)
})

test('actual connection uses the frozen DNS address and never a second system lookup', async t => {
  const hosts = []
  const target = await fixture(t, (req, res) => {
    hosts.push(req.headers.host)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  const calls = { ipv4: 0, ipv6: 0, cancelled: 0 }
  const systemLookup = t.mock.method(dns, 'lookup', () => { throw new Error('unexpected system lookup') })
  const owner = network(t, {}, { createResolver: () => ({
    resolve4: async () => { calls.ipv4 += 1; return [calls.ipv4 === 1 ? '127.0.0.1' : '169.254.169.254'] },
    resolve6: async () => { calls.ipv6 += 1; throw noData() },
    cancel() { calls.cancelled += 1 },
  }) })
  await request(owner, source(target.port, { hostname: 'localhost' }))
  assert.deepEqual(hosts, [`localhost:${target.port}`])
  assert.equal(calls.ipv4, 1)
  assert.equal(calls.ipv6, 1)
  assert.equal(calls.cancelled, 1)
  assert.equal(systemLookup.mock.callCount(), 0)
})

test('every DNS answer is checked before connecting, with bounded answer retention', async t => {
  let hits = 0
  const target = await fixture(t, (_req, res) => { hits += 1; res.setHeader('content-type', 'application/json'); res.end('{}') })
  const resolved = source(target.port, { hostname: 'localhost' })
  // A Teredo record in a public answer is not dialable and not private: it is
  // dropped, and the permitted IPv4 literal still carries the request.
  const teredo = [0x2001, 0, 0x4136, 0xe378, 0x8000, 0x63bf, 0x3fff, 0xfdd2].map(part => part.toString(16)).join(':')
  const mixed = network(t, {}, { createResolver: () => ({
    resolve4: async () => ['127.0.0.1', teredo], resolve6: async () => [],
    cancel() {},
  }) })
  await request(mixed, resolved)
  assert.equal(hits, 1)
  for (const [addresses, expected] of [
    [['127.0.0.1', '169.254.169.254'], 'SOURCE_RESOURCE_DENIED'],
    [['127.0.0.1', 'ff02::1'], 'SOURCE_RESOURCE_DENIED'],
    [['source.example.test'], 'SOURCE_RESOURCE_DENIED'],
    [Array(65).fill('127.0.0.1'), 'SOURCE_LIMIT_EXCEEDED'],
    [[], 'SOURCE_UNAVAILABLE'],
  ]) {
    const owner = network(t, {}, { createResolver: () => ({
      resolve4: async () => addresses, resolve6: async () => [],
      cancel() {},
    }) })
    await assert.rejects(request(owner, resolved), code(expected))
  }
  const failed = network(t, {}, { createResolver: () => ({
    resolve4() { throw Object.assign(new Error('private resolver address'), { code: 'ETIMEOUT' }) },
    resolve6: async () => ['127.0.0.1'],
    cancel() {},
  }) })
  await assert.rejects(request(failed, resolved), code('SOURCE_UNAVAILABLE'))
  assert.equal(hits, 1)
})

test('transient resolver failures retry with a fresh resolver before failing', async t => {
  let hits = 0
  const target = await fixture(t, (_req, res) => { hits += 1; res.setHeader('content-type', 'application/json'); res.end('{}') })
  const resolved = source(target.port, { hostname: 'localhost' })
  let attempts = 0
  const owner = network(t, {}, { createResolver: () => {
    attempts += 1
    const fail = attempts === 1
    return {
      resolve4: fail
        ? async () => { throw Object.assign(new Error('temporary resolver failure'), { code: 'ESERVFAIL' }) }
        : async () => ['127.0.0.1'],
      resolve6: async () => [],
      cancel() {},
    }
  } })
  await request(owner, resolved)
  assert.equal(hits, 1)
  assert.equal(attempts, 2)
  // A persistent transient failure stays a named DNS failure and never connects.
  const persistent = network(t, {}, { createResolver: () => ({
    resolve4: async () => { throw Object.assign(new Error('resolver down'), { code: 'ESERVFAIL' }) },
    resolve6: async () => [],
    cancel() {},
  }) })
  await assert.rejects(request(persistent, resolved), code('SOURCE_UNAVAILABLE'))
  assert.equal(hits, 1)
})

test('redirects and authentication failures contain upstream bodies and never visit Location', async t => {
  let redirectHits = 0
  const trap = await fixture(t, (_req, res) => { redirectHits += 1; res.end() })
  const target = await fixture(t, (req, res) => {
    const status = Number(new URL(req.url, 'http://localhost').searchParams.get('status'))
    res.writeHead(status, { location: `http://127.0.0.1:${trap.port}/private`, 'content-type': 'text/plain' })
    res.end('fake-fixture-secret http://10.0.0.5/private')
  })
  const owner = network(t)
  const resolved = source(target.port)
  for (const status of [302, 401, 403, 500]) {
    let failure
    try { await request(owner, resolved, `?status=${status}`) } catch (error) { failure = error }
    const expected = status === 302 ? 'SOURCE_RESOURCE_DENIED' : status === 500 ? 'SOURCE_UNAVAILABLE' : 'SOURCE_CREDENTIAL_REJECTED'
    assert.equal(failure.code, expected)
    const output = JSON.stringify({ ...failure, message: failure.message, cause: failure.cause })
    for (const forbidden of ['10.0.0.5', 'fake-fixture-secret', String(trap.port)]) assert.equal(output.includes(forbidden), false)
  }
  assert.equal(redirectHits, 0)
})

test('DNS private access is not enabled by a public hostname or a second resolver', async t => {
  let hits = 0
  const target = await fixture(t, (_req, res) => { hits += 1; res.end() })
  const resolved = source(target.port, { hostname: 'source.example.test', allowPrivateNetwork: false })
  t.mock.method(dns, 'lookup', () => { throw new Error('unexpected system lookup') })
  const owner = network(t, {}, { createResolver: () => ({
    resolve4: async () => ['127.0.0.1'], resolve6: async () => [], cancel() {},
  }) })
  await assert.rejects(request(owner, resolved), code('SOURCE_RESOURCE_DENIED'))
  assert.equal(hits, 0)
})

test('metadata MIME, encoding and declared or streamed byte bounds refuse before output', async t => {
  const target = await fixture(t, (req, res) => {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode')
    const headers = { 'content-type': mode === 'mime' ? 'text/html' : 'application/json' }
    if (mode === 'encoding') headers['content-encoding'] = 'gzip'
    if (mode === 'declared') headers['content-length'] = '1000'
    res.writeHead(200, headers)
    if (mode === 'streamed') {
      res.write('12345')
      res.end('67890')
    } else res.end('{}')
  })
  const owner = network(t, { maxResponseBytes: 32, maxMetadataBytes: 8 })
  for (const mode of ['mime', 'encoding', 'declared', 'streamed']) {
    await assert.rejects(request(owner, source(target.port), `?mode=${mode}`),
      code(mode === 'mime' || mode === 'encoding' ? 'SOURCE_RESOURCE_DENIED' : 'SOURCE_LIMIT_EXCEEDED'))
  }
})

test('an incomplete response never returns the admitted prefix as a complete body', async t => {
  const target = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 20 })
    res.write('{}', () => res.destroy())
  })
  await assert.rejects(request(network(t), source(target.port)), code('SOURCE_UNAVAILABLE'))
})

test('XML and raster response limits are independent of metadata and 304 has no body', async t => {
  const target = await fixture(t, (req, res) => {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode')
    if (mode === 'cached') return res.writeHead(304, { etag: '"opaque"' }).end()
    res.writeHead(200, { 'content-type': mode === 'xml' ? 'text/xml' : 'image/png' })
    res.end(mode === 'xml' ? '<x/>' : Buffer.alloc(16))
  })
  const owner = network(t, { maxMetadataBytes: 4, maxResponseBytes: 16 })
  const resolved = source(target.port)
  const xml = await request(owner, resolved, '?mode=xml', { payload: 'xml' })
  assert.equal(xml.body.toString(), '<x/>')
  assert.equal((await request(owner, resolved, '?mode=image', { payload: 'image' })).body.byteLength, 16)
  const cached = await request(owner, resolved, '?mode=cached')
  assert.equal(cached.status, 304)
  assert.equal(cached.body.byteLength, 0)
  assert.equal(cached.cache.etag, '"opaque"')
})

test('caller abort destroys the waiting response and leaves the transport reusable', async t => {
  const received = deferred()
  const closed = deferred()
  const target = await fixture(t, (req, res) => {
    if (new URL(req.url, 'http://localhost').searchParams.has('hold')) {
      res.once('close', () => closed.resolve())
      received.resolve(res)
    } else res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  const owner = network(t)
  const resolved = source(target.port)
  const controller = new AbortController()
  const pending = request(owner, resolved, '?hold=1', { signal: controller.signal })
  const rejected = assert.rejects(pending, code('SOURCE_CANCELLED'))
  const response = await received.promise
  controller.abort('not a public cancellation reason')
  await rejected
  await closed.promise
  response.end('late data')
  assert.equal((await request(owner, resolved)).body.toString(), '{}')
})

test('queue promotion is FIFO, queued cancellation frees capacity and URLs are copied at entry', async t => {
  const requests = []
  const received = deferred()
  const target = await fixture(t, (req, res) => {
    const job = new URL(req.url, 'http://localhost').searchParams.get('job')
    requests.push(job)
    if (job === 'first') received.resolve(res)
    else res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  const owner = network(t, { maxConcurrentRequests: 1, maxQueuedRequests: 2 })
  const resolved = source(target.port)
  const first = request(owner, resolved, '?job=first')
  const held = await received.promise
  const controller = new AbortController()
  const cancelled = request(owner, resolved, '?job=cancelled', { signal: controller.signal })
  const rejected = assert.rejects(cancelled, code('SOURCE_CANCELLED'))
  const url = new URL(`${resolved.endpoint}?job=second`)
  const second = owner.request({ source: resolved, url, payload: 'json' })
  url.hostname = '169.254.169.254'
  await assert.rejects(request(owner, resolved, '?job=overflow'), code('SOURCE_LIMIT_EXCEEDED'))
  controller.abort()
  await rejected
  const third = request(owner, resolved, '?job=third')
  held.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  await Promise.all([first, second, third])
  assert.deepEqual(requests, ['first', 'second', 'third'])
})

test('the operation deadline includes time already spent waiting in the queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = network(t, { requestTimeoutMs: 1_000, maxConcurrentRequests: 1 }, {
    createResolver: () => {
      const pending = []
      return {
        resolve4: () => new Promise((_resolve, reject) => pending.push(reject)),
        resolve6: () => new Promise((_resolve, reject) => pending.push(reject)),
        cancel() {
          for (const reject of pending) reject(Object.assign(new Error('cancelled DNS'), { code: 'ECANCELLED' }))
          pending.length = 0
        },
      }
    },
  })
  const resolved = source(1, { hostname: 'localhost' })
  const first = request(owner, resolved).then(() => 'success', error => error.code)
  t.mock.timers.tick(500)
  let secondSettled = false
  const second = request(owner, resolved).then(() => 'success', error => error.code)
  second.then(() => { secondSettled = true })
  t.mock.timers.tick(500)
  assert.equal(await first, 'SOURCE_TIMEOUT')
  t.mock.timers.tick(499)
  await Promise.resolve()
  assert.equal(secondSettled, false)
  t.mock.timers.tick(1)
  assert.equal(await second, 'SOURCE_TIMEOUT')
})

test('dispose cancels active and queued operations, closes sockets, and never revives', async t => {
  const received = deferred()
  const closed = deferred()
  let hits = 0
  const target = await fixture(t, (_req, res) => {
    hits += 1
    res.once('close', () => closed.resolve())
    received.resolve()
  })
  const owner = network(t, { maxConcurrentRequests: 1 })
  const resolved = source(target.port)
  const first = request(owner, resolved)
  const rejectedFirst = assert.rejects(first, code('SOURCE_CANCELLED'))
  await received.promise
  const second = request(owner, resolved)
  const rejectedSecond = assert.rejects(second, code('SOURCE_CANCELLED'))
  owner.dispose()
  owner.dispose()
  await Promise.all([rejectedFirst, rejectedSecond, closed.promise])
  await assert.rejects(request(owner, resolved), code('SOURCE_CANCELLED'))
  assert.equal(hits, 1)
})

test('a stalled real response times out and closes its connection', async t => {
  const closed = deferred()
  const target = await fixture(t, (_req, res) => res.once('close', () => closed.resolve()))
  const owner = network(t, { requestTimeoutMs: 500 })
  await assert.rejects(request(owner, source(target.port)), code('SOURCE_TIMEOUT'))
  await closed.promise
})

test('credential controls and query collisions fail safely rather than leaking native errors', async t => {
  assert.throws(() => source(1, {
    credential: { type: 'bearer', env: 'FIXTURE_TOKEN' }, secret: 'fake\r\nunsafe',
  }), code('SOURCE_CONFIG_INVALID'))
  assert.throws(() => source(1, { credential: { type: 'query', parameter: 'f', env: 'FIXTURE_TOKEN' } }), code('SOURCE_CONFIG_INVALID'))
})

test('an explicitly owned agent ignores active Node environment proxy routing', async t => {
  let trapHits = 0
  let sourceHits = 0
  const trap = await fixture(t, (_req, res) => {
    trapHits += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"kind":"proxy"}')
  })
  const target = await fixture(t, (_req, res) => {
    sourceHits += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"kind":"source"}')
  })
  const modules = {
    network: new URL('../src/source-network.ts', import.meta.url).href,
    config: new URL('../src/source-network-config.ts', import.meta.url).href,
    catalog: new URL('../src/sources.ts', import.meta.url).href,
  }
  const script = `
import http from 'node:http';
import {createSourceNetwork} from ${JSON.stringify(modules.network)};
import {resolveSourceNetworkConfig} from ${JSON.stringify(modules.config)};
import {createMapSourceCatalog} from ${JSON.stringify(modules.catalog)};
const control = await new Promise((resolve,reject) => {
  http.get('http://127.0.0.1:${target.port}/MapServer?control=1', response => {
    let data=''; response.on('data',chunk=>data+=chunk); response.on('end',()=>resolve(JSON.parse(data)));
  }).on('error',reject);
});
const catalog=createMapSourceCatalog({custom:[{
  id:'fixture',title:'Fixture',role:'basemap',adapter:'arcgis-mapserver',
  endpoint:'http://source.example.test:${target.port}/MapServer',
  attribution:'Fixture',nativeWkid:3857,supportedModes:['map'],minZoom:0,maxZoom:23,
  compatibleBasemapIds:[],allowPrivateNetwork:true,allowHttp:true
}]},'allow',{});
const entry=catalog.list({provider:'custom'}).sources[0];
const source=catalog.resolvedSource(entry.id,entry.configDigest);
const owner=createSourceNetwork(resolveSourceNetworkConfig({requestTimeoutMs:2000}),{
  createResolver:()=>({resolve4:async()=>['127.0.0.1'],resolve6:async()=>[],cancel(){}})
});
try {
  const direct=await owner.request({source,url:new URL(source.endpoint+'?f=json'),payload:'json'});
  console.log(JSON.stringify({control,direct:JSON.parse(direct.body.toString())}));
} finally {owner.dispose();}
`
  const proxy = `http://127.0.0.1:${trap.port}`
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
      NO_PROXY: '', no_proxy: '',
    },
  })
  const timer = setTimeout(() => child.kill(), 5_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8_192) child.kill() })
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8_192) child.kill() })
  const [status, signal] = await once(child, 'close')
  clearTimeout(timer)
  assert.equal(signal, null, stderr)
  assert.equal(status, 0, stderr)
  assert.deepEqual(JSON.parse(stdout), { control: { kind: 'proxy' }, direct: { kind: 'source' } })
  assert.equal(trapHits, 1)
  assert.equal(sourceHits, 1)
})
