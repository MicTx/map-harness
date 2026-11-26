import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceNetwork } from '../src/source-network.ts'
import { resolveSourceNetworkConfig } from '../src/source-network-config.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

function code(expected) {
  return error => error instanceof SourceCatalogError && error.code === expected
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function closeServer(server, sockets = []) {
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function originFixture(t, handler) {
  const server = createHttpServer(handler)
  const port = await listen(server)
  t.after(() => closeServer(server))
  return { port, server }
}

/**
 * CONNECT proxy fixture. `handler` receives `{ authority, headers, socket }`
 * and owns the response; the default fixture tunnels to `targetPort`.
 */
async function proxyFixture(t, handler) {
  const connections = []
  const sockets = []
  const server = createNetServer(socket => {
    sockets.push(socket)
    const facts = { authority: null, headers: {}, closed: false, bytes: '' }
    connections.push(facts)
    socket.on('error', () => {})
    socket.on('close', () => { facts.closed = true })
    const onData = chunk => {
      facts.bytes += chunk.toString('latin1')
      if (facts.bytes.length > 32_768) {
        socket.destroy()
        return
      }
      const end = facts.bytes.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const lines = facts.bytes.slice(0, end).split('\r\n')
      const requestLine = lines.shift() ?? ''
      const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(requestLine)
      facts.authority = match?.[1] ?? null
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon > 0) facts.headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }
      handler({ ...facts, socket })
    }
    socket.on('data', onData)
  })
  const port = await listen(server)
  t.after(() => closeServer(server, sockets))
  return { port, connections }
}

function tunnel(socket, port, status = 'HTTP/1.1 200 Connection Established') {
  const upstream = netConnect(port, '127.0.0.1')
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.write(`${status}\r\n\r\n`)
  socket.pipe(upstream).pipe(socket)
}

function source(port, {
  hostname = 'source.example.test',
  protocol = 'http:',
  proxyConfig,
  env = {},
  credential,
  secret = 'source-secret-value',
} = {}) {
  const catalog = createMapSourceCatalog({
    ...(proxyConfig === undefined ? {} : { proxy: proxyConfig }),
    ...(credential === undefined ? {} : { credentials: { fixture: credential } }),
    custom: [{
      id: 'fixture-source', title: 'Fixture', role: 'basemap', adapter: 'arcgis-mapserver',
      endpoint: `${protocol}//${hostname}:${port}/MapServer`,
      attribution: 'Fixture owner', nativeWkid: 3857, supportedModes: ['map'],
      minZoom: 0, maxZoom: 23, compatibleBasemapIds: [],
      allowPrivateNetwork: protocol === 'http:',
      allowHttp: protocol === 'http:',
      ...(credential === undefined ? {} : { credentialRef: 'fixture' }),
    }],
  }, 'allow', { FIXTURE_TOKEN: secret, ...env })
  const entry = catalog.list({ provider: 'custom' }).sources[0]
  return { catalog, resolved: catalog.resolvedSource(entry.id, entry.configDigest) }
}

function network(t, limits, dependencies = {}, env = {}) {
  const owner = createSourceNetwork(resolveSourceNetworkConfig(limits, env), {
    createResolver: () => ({ resolve4: async () => ['127.0.0.1'], resolve6: async () => [], cancel() {} }),
    ...dependencies,
  })
  t.after(() => owner.dispose())
  return owner
}

async function waitUntil(predicate) {
  const deadline = process.hrtime.bigint() + 5_000_000_000n
  while (!predicate()) {
    if (process.hrtime.bigint() > deadline) throw new Error('condition was not reached')
    await new Promise(resolve => setImmediate(resolve))
  }
}

function request(owner, resolved, suffix = '?f=json') {
  return owner.request({ source: resolved, url: new URL(`${resolved.endpoint}${suffix}`), payload: 'json' })
}

const proxyOf = (urlEnv, targetResolution = 'local') => ({ outboundProxy: { urlEnv, ...(targetResolution === 'local' ? {} : { targetResolution }) } })

test('outbound proxy settings resolve only from the declared environment name', () => {
  assert.equal(resolveSourceNetworkConfig().outboundProxy, null)
  const resolved = resolveSourceNetworkConfig(
    { outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } },
    { DSH_TEST_PROXY: 'http://user:pw@127.0.0.1:3128' },
  )
  assert.equal(resolved.outboundProxy.targetResolution, 'local')
  assert.equal(resolved.outboundProxy.url.href, 'http://127.0.0.1:3128/')
  assert.equal(resolved.outboundProxy.authorization, `Basic ${Buffer.from('user:pw').toString('base64')}`)
  assert.equal(Object.isFrozen(resolved.outboundProxy), true)
  assert.equal(resolveSourceNetworkConfig({ outboundProxy: { urlEnv: 'DSH_TEST_PROXY', targetResolution: 'proxy' } }, { DSH_TEST_PROXY: 'https://127.0.0.1:3128' }).outboundProxy.targetResolution, 'proxy')

  for (const [config, env] of [
    [{ outboundProxy: null }, {}],
    [{ outboundProxy: {} }, {}],
    [{ outboundProxy: { urlEnv: 'missing-lowercase' } }, {}],
    [{ outboundProxy: { urlEnv: 'MISSING' } }, {}],
    // A non-DSH name would survive the model subprocess environment scrub.
    [{ outboundProxy: { urlEnv: 'MAP_OUTBOUND_PROXY_URL' } }, { MAP_OUTBOUND_PROXY_URL: 'http://127.0.0.1:3128' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: '' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: 'ftp://127.0.0.1:3128' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128/path' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128?q=1' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128#fragment' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY' } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128/%ZZ' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY', targetResolution: 'ambient' } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128' }],
    [{ outboundProxy: { urlEnv: 'DSH_TEST_PROXY', extra: true } }, { DSH_TEST_PROXY: 'http://127.0.0.1:3128' }],
  ]) assert.throws(() => resolveSourceNetworkConfig(config, env), code('SOURCE_CONFIG_INVALID'))
})

test('the catalog threads the proxy environment without exposing the value', () => {
  const proxyPassword = 'secret-proxy-value'
  const { catalog } = source(9, {
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://user:${proxyPassword}@127.0.0.1:3128` },
  })
  assert.notEqual(catalog.networkConfig.outboundProxy, null)
  const serialized = JSON.stringify(catalog.list())
  assert.equal(serialized.includes('127.0.0.1:3128'), false)
  assert.equal(serialized.includes(proxyPassword), false)
  assert.equal(serialized.includes('DSH_TEST_PROXY'), false)
})

test('pinned authority uses the vetted address while origin identity comes from the URL', async t => {
  const origin = await originFixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ host: req.headers.host, authorization: req.headers.authorization ?? null }))
  })
  const proxy = await proxyFixture(t, ctx => tunnel(ctx.socket, origin.port))
  const { resolved } = source(origin.port, {
    proxyConfig: proxyOf('DSH_TEST_PROXY'),
    env: { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` },
  })
  const owner = network(t, { requestTimeoutMs: 2_000, ...proxyOf('DSH_TEST_PROXY') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` })
  const response = await request(owner, resolved)
  assert.equal(response.status, 200)
  assert.equal(proxy.connections.length, 1)
  assert.equal(proxy.connections[0].authority, `127.0.0.1:${origin.port}`)
  assert.deepEqual(JSON.parse(response.body.toString()), {
    host: `source.example.test:${origin.port}`,
    authorization: null,
  })
})

test('explicit proxy resolution sends the configured hostname as CONNECT authority', async t => {
  const origin = await originFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  const proxy = await proxyFixture(t, ctx => tunnel(ctx.socket, origin.port))
  const { resolved } = source(origin.port, {
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` },
  })
  const owner = network(t, { requestTimeoutMs: 2_000, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` })
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
  try {
    assert.equal((await request(owner, resolved)).status, 200)
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
  }
  assert.equal(proxy.connections.length, 1)
  assert.equal(proxy.connections[0].authority, `source.example.test:${origin.port}`)
})

test('proxy credentials stay on CONNECT and source credentials reach the origin', async t => {
  const proxyPassword = 'proxy-pass'
  const sourceSecret = 'source-bearer-value'
  let seen = null
  const origin = await originFixture(t, (req, res) => {
    seen = req.headers
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  const proxy = await proxyFixture(t, ctx => tunnel(ctx.socket, origin.port))
  const { resolved } = source(origin.port, {
    credential: { type: 'bearer', env: 'FIXTURE_TOKEN' },
    secret: sourceSecret,
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://proxy-user:${proxyPassword}@127.0.0.1:${proxy.port}` },
  })
  const owner = network(t, { requestTimeoutMs: 2_000, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://proxy-user:${proxyPassword}@127.0.0.1:${proxy.port}` })
  await request(owner, resolved)
  assert.equal(proxy.connections[0].headers['proxy-authorization'], `Basic ${Buffer.from(`proxy-user:${proxyPassword}`).toString('base64')}`)
  assert.equal(seen.authorization, `Bearer ${sourceSecret}`)
  assert.equal(seen['proxy-authorization'], undefined)
})

test('proxy rejection fails closed with no direct fallback', async t => {
  let originHits = 0
  const origin = await originFixture(t, (_req, res) => {
    originHits += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  for (const [status, expected] of [
    ['HTTP/1.1 407 Proxy Authentication Required', 'SOURCE_CREDENTIAL_REJECTED'],
    ['HTTP/1.1 403 Forbidden', 'SOURCE_CREDENTIAL_REJECTED'],
    ['HTTP/1.1 502 Bad Gateway', 'SOURCE_UNAVAILABLE'],
    ['not-http', 'SOURCE_UNAVAILABLE'],
  ]) {
    const proxy = await proxyFixture(t, ctx => {
      if (status === 'not-http') ctx.socket.end('garbage\r\n\r\n')
      else tunnel(ctx.socket, origin.port, status)
    })
    const { resolved } = source(origin.port, {
      proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
      env: { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` },
    })
    const owner = network(t, { requestTimeoutMs: 2_000, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` })
    await assert.rejects(request(owner, resolved), code(expected))
    assert.equal(originHits, 0)
  }
  assert.equal(originHits, 0)

  const oversize = await proxyFixture(t, ctx => {
    ctx.socket.end(`HTTP/1.1 200 Connection Established\r\nX-Fill: ${'a'.repeat(16_384)}\r\n\r\n`)
  })
  const { resolved } = source(origin.port, {
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://127.0.0.1:${oversize.port}` },
  })
  await assert.rejects(
    request(network(t, { requestTimeoutMs: 2_000, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${oversize.port}` }), resolved),
    code('SOURCE_UNAVAILABLE'),
  )
  assert.equal(originHits, 0)
})

test('a stalled CONNECT respects the deadline, closes its socket, and leaves the owner reusable', async t => {
  let stalled = true
  const origin = await originFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  const proxy = await proxyFixture(t, ctx => {
    if (stalled) return
    tunnel(ctx.socket, origin.port)
  })
  const { resolved } = source(origin.port, {
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` },
  })
  const owner = network(t, { requestTimeoutMs: 250, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` })
  await assert.rejects(request(owner, resolved), code('SOURCE_TIMEOUT'))
  stalled = false
  assert.equal((await request(owner, resolved)).status, 200)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(proxy.connections[0].closed, true)
})

test('caller abort and dispose close a CONNECT still waiting for its response', async t => {
  const origin = await originFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  const proxy = await proxyFixture(t, () => {})
  const { resolved } = source(origin.port, {
    proxyConfig: proxyOf('DSH_TEST_PROXY', 'proxy'),
    env: { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` },
  })
  const owner = network(t, { requestTimeoutMs: 10_000, ...proxyOf('DSH_TEST_PROXY', 'proxy') }, {}, { DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}` })
  const controller = new AbortController()
  const pending = owner.request({ source: resolved, url: new URL(`${resolved.endpoint}?f=json`), payload: 'json', signal: controller.signal })
  await waitUntil(() => proxy.connections.length === 1)
  controller.abort()
  await assert.rejects(pending, code('SOURCE_CANCELLED'))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(proxy.connections[0].closed, true)

  const disposing = owner.request({ source: resolved, url: new URL(`${resolved.endpoint}?f=json`), payload: 'json' })
  await waitUntil(() => proxy.connections.length === 2)
  owner.dispose()
  await assert.rejects(disposing, code('SOURCE_CANCELLED'))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(proxy.connections[1].closed, true)
})

function certificates() {
  const directory = mkdtempSync(join(tmpdir(), 'map-proxy-tls-'))
  const caKey = join(directory, 'ca-key.pem')
  const ca = join(directory, 'ca.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '2', '-subj', '/CN=Map Harness Proxy Test CA'])
  const issue = (name, san) => {
    const key = join(directory, `${name}.key.pem`)
    const csr = join(directory, `${name}.csr.pem`)
    const cert = join(directory, `${name}.cert.pem`)
    const extension = join(directory, `${name}.ext`)
    writeFileSync(extension, `subjectAltName=${san}\n`)
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`])
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '2', '-extfile', extension])
    return { key: readFileSync(key), cert: readFileSync(cert) }
  }
  return {
    directory,
    ca,
    matching: issue('source.example.test', 'DNS:source.example.test'),
    wrong: issue('other.example.test', 'DNS:other.example.test'),
  }
}

async function tlsOrigin(t, pair) {
  const state = { servername: null, hits: 0, requestLine: null, buffered: '' }
  const sockets = []
  const server = createTlsServer({ key: pair.key, cert: pair.cert }, socket => {
    sockets.push(socket)
    state.servername = socket.servername
    socket.on('error', () => {})
    socket.on('data', chunk => {
      if (state.requestLine !== null) return
      state.buffered += chunk.toString('latin1')
      const end = state.buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      state.hits += 1
      state.requestLine = state.buffered.slice(0, state.buffered.indexOf('\r\n'))
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}')
    })
  })
  const port = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  t.after(() => closeServer(server, sockets))
  return { port, state }
}

function runChild(script, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8_192) child.kill() })
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8_192) child.kill() })
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function tlsChildScript({ port, proxyPort, allowPrivateNetwork }) {
  const modules = {
    network: new URL('../src/source-network.ts', import.meta.url).href,
    config: new URL('../src/source-network-config.ts', import.meta.url).href,
    catalog: new URL('../src/sources.ts', import.meta.url).href,
  }
  return `
import {createSourceNetwork} from ${JSON.stringify(modules.network)};
import {resolveSourceNetworkConfig} from ${JSON.stringify(modules.config)};
import {createMapSourceCatalog} from ${JSON.stringify(modules.catalog)};
const catalog=createMapSourceCatalog({proxy:{outboundProxy:{urlEnv:'DSH_TEST_PROXY',targetResolution:'proxy'}},custom:[{
  id:'fixture',title:'Fixture',role:'basemap',adapter:'arcgis-mapserver',
  endpoint:'https://source.example.test:${port}/MapServer',
  attribution:'Fixture',nativeWkid:3857,supportedModes:['map'],minZoom:0,maxZoom:23,
  compatibleBasemapIds:[],allowPrivateNetwork:${allowPrivateNetwork},allowHttp:false
}]},'allow',process.env);
const entry=catalog.list({provider:'custom'}).sources[0];
const source=catalog.resolvedSource(entry.id,entry.configDigest);
const owner=createSourceNetwork(resolveSourceNetworkConfig({requestTimeoutMs:3000,outboundProxy:{urlEnv:'DSH_TEST_PROXY',targetResolution:'proxy'}},process.env),{
  createResolver:()=>({resolve4:async()=>['1.1.1.1'],resolve6:async()=>[],cancel(){}})
});
try {
  const response=await owner.request({source,url:new URL(source.endpoint+'?f=json'),payload:'json'});
  console.log(JSON.stringify({status:response.status,body:JSON.parse(response.body.toString())}));
} catch (error) {
  console.log(JSON.stringify({error:error.code ?? error.name}));
} finally {owner.dispose();}
`
}

test('tunneled TLS verifies the configured hostname and keeps SNI', async t => {
  const pairs = certificates()
  t.after(() => rmSync(pairs.directory, { recursive: true, force: true }))
  const origin = await tlsOrigin(t, pairs.matching)
  const proxy = await proxyFixture(t, ctx => tunnel(ctx.socket, origin.port))
  const result = await runChild(tlsChildScript({ port: origin.port, proxyPort: proxy.port, allowPrivateNetwork: false }), {
    DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}`,
    NODE_EXTRA_CA_CERTS: pairs.ca,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { status: 200, body: { ok: true } })
  assert.equal(origin.state.servername, 'source.example.test')
  assert.equal(proxy.connections[0].authority, `source.example.test:${origin.port}`)
})

test('tunneled TLS rejects a certificate for a different hostname', async t => {
  const pairs = certificates()
  t.after(() => rmSync(pairs.directory, { recursive: true, force: true }))
  const origin = await tlsOrigin(t, pairs.wrong)
  const proxy = await proxyFixture(t, ctx => tunnel(ctx.socket, origin.port))
  const result = await runChild(tlsChildScript({ port: origin.port, proxyPort: proxy.port, allowPrivateNetwork: false }), {
    DSH_TEST_PROXY: `http://127.0.0.1:${proxy.port}`,
    NODE_EXTRA_CA_CERTS: pairs.ca,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { error: 'SOURCE_UNAVAILABLE' })
  assert.equal(origin.state.hits, 0)
})
