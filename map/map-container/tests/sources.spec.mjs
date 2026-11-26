import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  BasemapSourceId,
  ESRI_WORLD_IMAGERY_ATTRIBUTION,
  ESRI_WORLD_REFERENCE_ATTRIBUTION,
} from '../../layers/src/index.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'
import { PUBLIC_SOURCE_PRESETS, SOURCE_NATIVE_QUERY_FIELDS } from '../src/source-render-protocol.ts'
import { apply, resolveSourceCredentialEnv, sourceCredentialRefs } from '../src/plugin.ts'

const presetIds = [
  'esri-world-imagery', 'esri-world-boundaries-places', 'osm-standard',
  'tianditu-img-w', 'tianditu-vec-w', 'tianditu-cia-w', 'tianditu-cva-w',
  'amap-imagery-labels', 'esri-wayback',
]
const custom = (overrides = {}) => ({
  id: 'custom-tiles',
  title: 'Custom Tiles',
  role: 'basemap',
  adapter: 'xyz',
  endpoint: 'https://tiles.example.test/{z}/{x}/{y}.png',
  attribution: 'Custom attribution',
  nativeWkid: 3857,
  supportedModes: ['map'],
  minZoom: 0,
  maxZoom: 20,
  compatibleBasemapIds: [],
  ...overrides,
})
const create = (config = {}, policy = 'unverified', env = {}) => createMapSourceCatalog(config, policy, env)
const throwsCode = (operation, code) => assert.throws(operation, error => {
  assert.ok(error instanceof SourceCatalogError)
  return error.code === code
})

test('all nine presets remain ordered and default selection leaves labels off', () => {
  const catalog = create({}, 'allow')
  const page = catalog.list()
  assert.deepEqual(page.sources.map(source => source.id), presetIds)
  assert.equal(page.canChange, true)
  assert.equal(page.sources[0].screenshot, 'allowed')
  assert.equal(page.sources[1].screenshot, 'unverified')
  assert.equal(catalog.selection('esri-world-imagery').value.labels, null)
  assert.equal(page.sources.some(source => source.id === 'tianditu-img-w'), true)
  assert.equal(page.sources.find(source => source.id === 'tianditu-img-w').availability.reason, 'missing-credential')
  assert.deepEqual(page.sources.find(source => source.id === 'amap-imagery-labels').tileAdjustment, {
    kind: 'gcj02',
    version: 1,
  })
})

test('global capture policy and source grants compose without blanket inheritance', () => {
  assert.equal(create({}, 'deny').list().sources[0].screenshot, 'denied')
  assert.equal(create({}, 'unverified').list().sources[0].screenshot, 'unverified')
  const grants = create({ presets: {
    'esri-world-imagery': { screenshot: 'denied', automatedMapUse: 'allowed' },
    'esri-world-boundaries-places': { screenshot: 'allowed' },
  } }, 'allow').list().sources
  assert.equal(grants[0].screenshot, 'denied')
  assert.equal(grants[0].automatedMapUse, 'allowed')
  assert.equal(grants[1].screenshot, 'allowed')
  assert.equal(grants[1].automatedMapUse, 'unverified')
  assert.equal(create({}, 'allow').list().sources.find(source => source.id === 'osm-standard').automatedMapUse, 'unverified')
  for (const grant of ['allowed', 'denied', 'unverified']) {
    const source = create({ presets: { 'osm-standard': { screenshot: 'allowed', automatedMapUse: grant } } }, 'allow')
      .descriptorOf(BasemapSourceId('osm-standard'))
    assert.equal(source.automatedMapUse, grant)
    assert.equal(source.screenshot, 'allowed')
  }
})

test('Tianditu presets stay visible and credential bindings resolve without leaking values', () => {
  const secret = 'distinct-b1-secret-value'
  const envName = 'TIANDITU_TOKEN_B1'
  const catalog = create({
    credentials: { tianditu: { type: 'query', parameter: 'tk', env: envName } },
  }, 'allow', { [envName]: secret })
  const page = catalog.list()
  for (const id of ['tianditu-img-w', 'tianditu-vec-w', 'tianditu-cia-w', 'tianditu-cva-w']) {
    assert.equal(page.sources.find(source => source.id === id).availability.kind, 'configured')
  }
  const publicJson = JSON.stringify(page)
  assert.equal(publicJson.includes(secret), false)
  assert.equal(publicJson.includes(encodeURIComponent(secret)), false)
  assert.equal(publicJson.includes(Buffer.from(secret).toString('base64')), false)
  assert.equal(publicJson.includes(envName), false)
  assert.equal(publicJson.includes('t0.tianditu.gov.cn'), false)
  assert.equal(catalog.resolvedSource('tianditu-img-w', page.sources.find(source => source.id === 'tianditu-img-w').configDigest).credential.value, secret)
})

test('disabled presets remain listed; deployment read-only catalog refuses selection', () => {
  const disabled = create({ presets: { 'osm-standard': { enabled: false } } })
  assert.equal(disabled.list().sources.find(source => source.id === 'osm-standard').availability.reason, 'disabled')
  assert.deepEqual(disabled.selection('osm-standard'), { ok: false, code: 'SOURCE_UNAVAILABLE' })
  const readOnly = create({ allowChanges: false })
  assert.equal(readOnly.list().canChange, false)
  assert.deepEqual(readOnly.selection('esri-world-imagery'), { ok: false, code: 'SOURCE_READ_ONLY' })
})

test('custom XYZ, native MapServer, and WMTS sources use validated host-only endpoints', () => {
  const catalog = create({ custom: [
    custom(),
    custom({
      id: 'custom-mapserver', adapter: 'arcgis-mapserver',
      endpoint: 'https://maps.example.test/ArcGIS/rest/services/One/MapServer',
      supportsDynamicExport: true,
    }),
    custom({
      id: 'custom-wmts', adapter: 'wmts', endpoint: 'https://maps.example.test/wmts',
      wmts: { layer: 'roads', tileMatrixSet: 'w' },
    }),
  ] })
  const page = catalog.list({ provider: 'custom' })
  assert.deepEqual(page.sources.map(source => source.id), ['custom-tiles', 'custom-mapserver', 'custom-wmts'])
  assert.equal(JSON.stringify(page).includes('maps.example.test'), false)
  assert.equal(catalog.resolvedSource('custom-wmts', page.sources[2].configDigest).wmts.tileMatrixSet, 'w')
})

test('reserved ids, duplicate ids, unknown keys/references, and malformed bindings fail safely', async () => {
  for (const config of [
    { presets: { 'custom-id': {} } },
    { custom: [custom({ id: 'osm-standard' })] },
    { custom: [custom(), custom()] },
    { unknown: true },
    { presets: { 'osm-standard': { endpoint: 'https://example.test' } } },
    { credentials: { 'bad name': { type: 'bearer', env: 'TOKEN' } } },
    { credentials: { ref: { type: 'query', parameter: 'tk', env: 'TOKEN' } }, custom: [custom({ credentialRef: 'absent' })] },
    { credentials: { ref: { type: 'query', parameter: '', env: 'TOKEN' } } },
    { custom: [custom({ tileAdjustment: { kind: 'wgs84', version: 1 } })] },
    { custom: [custom({ tileAdjustment: { kind: 'gcj02', version: 2 } })] },
  ]) throwsCode(() => create(config), 'SOURCE_CONFIG_INVALID')
  const contextWithoutCredentials = { get: () => undefined }
  await assert.rejects(apply(contextWithoutCredentials, { sources: { unknown: true } }), error => error.code === 'SOURCE_CONFIG_INVALID')
})

test('credential refs name env variables, never catalog-local binding names', () => {
  const sources = {
    credentials: { tianditu: { type: 'query', parameter: 'tk', env: 'TIANDITU_API_KEY' } },
    presets: { 'tianditu-img-w': { credentialRef: 'tianditu' } },
  }
  assert.deepEqual([...sourceCredentialRefs(sources)], ['TIANDITU_API_KEY'])
})

test('a seam-stored key reaches the Tianditu presets with no process-env value', async () => {
  const sources = { credentials: { tianditu: { type: 'query', parameter: 'tk', env: 'TIANDITU_API_KEY' } } }
  const store = new Map([['TIANDITU_API_KEY', 'stored-in-credentials-seam']])
  const calls = []
  const credentials = {
    resolve: async (ref) => {
      calls.push(ref)
      const value = store.get(ref)
      return value === undefined ? undefined : { value }
    },
  }
  const env = await resolveSourceCredentialEnv(sources, {}, credentials)
  assert.deepEqual(calls, ['TIANDITU_API_KEY'])
  assert.equal(env.TIANDITU_API_KEY, 'stored-in-credentials-seam')
  const page = createMapSourceCatalog(sources, 'allow', env).list()
  assert.equal(page.sources.find(source => source.id === 'tianditu-img-w').availability.kind, 'configured')
  assert.equal(JSON.stringify(page).includes('stored-in-credentials-seam'), false)
})

test('unset seam refs fall through to the ambient environment', async () => {
  const sources = { credentials: { tianditu: { type: 'query', parameter: 'tk', env: 'TIANDITU_API_KEY' } } }
  const credentials = { resolve: async () => undefined }
  const env = await resolveSourceCredentialEnv(sources, { TIANDITU_API_KEY: 'from-launch-env' }, credentials)
  assert.equal(env.TIANDITU_API_KEY, 'from-launch-env')
})

test('unsafe custom URLs and credential-bearing endpoint keys fail activation', () => {
  for (const entry of [
    custom({ endpoint: 'https://user@tiles.example.test/{z}/{x}/{y}.png' }),
    custom({ endpoint: 'https://tiles.example.test/{z}/{x}/{y}.png#frag' }),
    custom({ endpoint: 'https://tiles.example.test/{z}/{x}/{y}.png?access_token=embedded' }),
    ...['tk', 'TK', '%74%6b', '%2574%256b'].map(key => custom({
      endpoint: `https://tiles.example.test/{z}/{x}/{y}.png?${key}=embedded`,
    })),
    custom({ endpoint: 'https://tiles.example.test/{z}/{x}/{y}/{unknown}.png' }),
    custom({ endpoint: 'https://tiles.example.test/{z}/{x}/{y}/{broken.png' }),
    custom({ endpoint: 'https://{z}.example.test/{x}/{y}.png' }),
    custom({ endpoint: 'https://tiles.example.test/MapServer/tile/{z}/{y}/{x}' }),
    custom({ endpoint: 'https://tiles.example.test/ImageServer/tile/{z}/{y}/{x}' }),
    custom({ endpoint: 'http://tiles.example.test/{z}/{x}/{y}.png' }),
    custom({ endpoint: 'https://10.0.0.5/{z}/{x}/{y}.png' }),
    custom({ endpoint: 'https://tiles.example.test/{z}/{x}/{y}.png', adapter: 'xyz', supportsDynamicExport: true }),
  ]) throwsCode(() => create({ custom: [entry] }), 'SOURCE_CONFIG_INVALID')
  assert.equal(create({ custom: [custom({
    endpoint: 'http://tiles.example.test/{z}/{x}/{y}.png', allowHttp: true,
  })] }).list({ provider: 'custom' }).sources.length, 1)
  assert.equal(create({ custom: [custom({
    endpoint: 'https://10.0.0.5/{z}/{x}/{y}.png', allowPrivateNetwork: true,
  })] }).list({ provider: 'custom' }).sources.length, 1)
})

test('authorized OSM host aliases accept explicit automation grants', () => {
  for (const host of ['tile.openstreetmap.org', 'TILE.openstreetmap.org.', 'a.tile.openstreetmap.org']) {
    const source = create({ custom: [custom({
      id: 'osm-alias', endpoint: `https://${host}/{z}/{x}/{y}.png`,
      screenshot: 'allowed', automatedMapUse: 'allowed',
    })] }, 'allow').descriptorOf(BasemapSourceId('osm-alias'))
    assert.equal(source.screenshot, 'allowed')
    assert.equal(source.automatedMapUse, 'allowed')
  }
})

test('public IPs are not private hostnames; explicit private access preserves transport flags', () => {
  for (const host of ['8.8.8.8', '[2606:4700::1111]']) {
    assert.equal(create({ custom: [custom({
      endpoint: `https://${host}/{z}/{x}/{y}.png`,
    })] }).selection('custom-tiles').ok, true)
  }
  for (const host of ['10.0.0.5', '127.0.0.1', '[::1]', '[fd12::1]', '[::ffff:127.0.0.1]']) {
    const entry = custom({ endpoint: `http://${host}/{z}/{x}/{y}.png`, allowHttp: true })
    throwsCode(() => create({ custom: [entry] }), 'SOURCE_CONFIG_INVALID')
    const catalog = create({ custom: [{ ...entry, allowPrivateNetwork: true }] })
    const publicRecord = catalog.selection('custom-tiles').value.basemap
    const resolved = catalog.resolvedSource(publicRecord.id, publicRecord.configDigest)
    assert.equal(resolved.allowPrivateNetwork, true)
    assert.equal(resolved.allowHttp, true)
    assert.equal(JSON.stringify(publicRecord).includes(host), false)
    assert.equal(Object.hasOwn(publicRecord, 'allowPrivateNetwork'), false)
  }
  for (const host of [
    '0.0.0.0', '224.0.0.1', '169.254.169.254', '100.100.100.200',
    '[::]', '[ff02::1]', '[fe80::1]', '[fd00:ec2::254]', '[::ffff:100.100.100.200]',
    'metadata.google.internal.',
  ]) throwsCode(() => create({ custom: [custom({
    endpoint: `https://${host}/{z}/{x}/{y}.png`, allowPrivateNetwork: true,
  })] }), 'SOURCE_CONFIG_INVALID')
})

test('fixed providers reject credential bindings they cannot use', () => {
  for (const binding of [
    { type: 'bearer', env: 'TOKEN' },
    { type: 'query', parameter: 'token', env: 'TOKEN' },
  ]) throwsCode(() => create({ credentials: { tianditu: binding } }, 'allow', { TOKEN: 'present' }), 'SOURCE_CONFIG_INVALID')
  throwsCode(() => create({
    presets: { 'osm-standard': { credentialRef: 'osm' } },
    credentials: { osm: { type: 'bearer', env: 'TOKEN' } },
  }, 'allow', { TOKEN: 'present' }), 'SOURCE_CONFIG_INVALID')
})

test('configured labels require a real compatible base without requiring live credentials', () => {
  const labels = overrides => custom({
    id: 'custom-labels', role: 'labels', compatibleBasemapIds: ['custom-tiles'], ...overrides,
  })
  for (const pair of [
    [labels({ compatibleBasemapIds: ['absent'] })],
    [custom(), labels({ compatibleBasemapIds: ['other-labels'] }), labels({ id: 'other-labels' })],
    [custom(), labels({ supportedModes: ['scene'] })],
    [custom(), labels({ minZoom: 21, maxZoom: 30 })],
    [custom(), labels({ nativeWkid: 4547 })],
  ]) throwsCode(() => create({ custom: pair }), 'SOURCE_CONFIG_INVALID')
  const dynamic = create({ custom: [custom(), labels({
    adapter: 'arcgis-mapserver', nativeWkid: 4547, supportsDynamicExport: true,
    endpoint: 'https://maps.example.test/ArcGIS/rest/services/Labels/MapServer',
  })] })
  assert.equal(dynamic.selection('custom-tiles', 'custom-labels').ok, true)
  const missing = create({ custom: [custom({ credentialRef: 'private' }), labels()], credentials: {
    private: { type: 'bearer', env: 'MISSING' },
  } })
  assert.equal(missing.list({ provider: 'custom' }).sources.length, 2)
  assert.deepEqual(missing.selection('custom-tiles', 'custom-labels'), { ok: false, code: 'SOURCE_NOT_CONFIGURED' })
})

test('preset limits and credits come from source facts, never server software versions', () => {
  const records = create().list().sources
  assert.deepEqual(records.map(source => [source.minZoom, source.maxZoom]), [
    [0, 23], [0, 23], [0, 19], [1, 18], [1, 18], [1, 18], [1, 18], [0, 23], [0, 23],
  ])
  assert.equal(records[0].attribution, ESRI_WORLD_IMAGERY_ATTRIBUTION)
  assert.equal(records[1].attribution, ESRI_WORLD_REFERENCE_ATTRIBUTION)
  for (const source of records) assert.deepEqual(source.release, { version: null, publishedAt: null, acquiredAt: null })
})

test('catalog bounds and query context are validated without claiming local availability', () => {
  throwsCode(() => create({ maxSources: 0 }), 'SOURCE_CONFIG_INVALID')
  throwsCode(() => create({ maxPageSize: 65 }), 'SOURCE_CONFIG_INVALID')
  throwsCode(() => create({ defaultPageSize: 33, maxPageSize: 32 }), 'SOURCE_CONFIG_INVALID')
  throwsCode(() => create({ maxSources: 1 }).list(), 'SOURCE_LIMIT_EXCEEDED')
  const catalog = create()
  assert.equal(catalog.list().context.at, null)
  assert.equal(catalog.list({ at: { lon: 116, lat: 40 }, zoom: 9 }).context.at.lon, 116)
  for (const query of [
    { at: { lon: 0, lat: 0 } }, { zoom: 1 },
    { at: { lon: 181, lat: 0 }, zoom: 1 }, { at: { lon: 0, lat: Number.NaN }, zoom: 1 },
    { at: { lon: 0, lat: 0 }, zoom: Number.POSITIVE_INFINITY },
  ]) assert.throws(() => catalog.list(query), error => error.code === 'SOURCE_RESOURCE_DENIED')
})

test('pagination filters before offsets and rejects malformed, stale, and out-of-range cursors', () => {
  const items = Array.from({ length: 5 }, (_, index) => custom({
    id: `custom-${index}`, title: `Custom ${index}`,
  }))
  const catalog = create({ custom: items, defaultPageSize: 2, maxPageSize: 3 })
  const first = catalog.list({ provider: 'custom' })
  assert.deepEqual(first.sources.map(source => source.id), ['custom-0', 'custom-1'])
  const second = catalog.list({ provider: 'custom', cursor: first.nextCursor })
  assert.deepEqual(second.sources.map(source => source.id), ['custom-2', 'custom-3'])
  assert.equal(catalog.list({ provider: 'custom', cursor: second.nextCursor }).sources[0].id, 'custom-4')
  assert.throws(() => catalog.list({ cursor: '%%%bad' }), error => error.code === 'SOURCE_RESOURCE_DENIED')
  const cursorData = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
  const encodeCursor = data => Buffer.from(JSON.stringify(data), 'utf8').toString('base64url')
  const outOfRange = encodeCursor({ ...cursorData, o: 999 })
  assert.throws(() => catalog.list({ provider: 'custom', cursor: outOfRange }), error => error.code === 'SOURCE_RESOURCE_DENIED')
  assert.throws(() => catalog.list({ provider: 'custom', cursor: encodeCursor({ ...cursorData, v: 2 }) }), error => error.code === 'SOURCE_VERSION_UNSUPPORTED')
  assert.throws(() => catalog.list({ cursor: 'a'.repeat(257) }), error => error.code === 'SOURCE_RESOURCE_DENIED')
  const changed = create({ custom: [...items, custom({ id: 'custom-5' })], defaultPageSize: 2 })
  assert.throws(() => changed.list({ provider: 'custom', cursor: first.nextCursor }), error => error.code === 'SOURCE_CHANGED')
  assert.throws(() => catalog.list({ provider: 'esri', cursor: first.nextCursor }), error => error.code === 'SOURCE_RESOURCE_DENIED')
  assert.ok(first.nextCursor.length <= 256)
  const smaller = catalog.list({ provider: 'custom', cursor: first.nextCursor, pageSize: 1 })
  const rest = catalog.list({ provider: 'custom', cursor: smaller.nextCursor })
  assert.deepEqual([...first.sources, ...smaller.sources, ...rest.sources].map(source => source.id), items.map(item => item.id))
})

test('descriptorOf bypasses page byte limits and returns frozen public records for unavailable sources', () => {
  const catalog = create({ maxCatalogBytes: 1, presets: {
    'osm-standard': { enabled: false },
  } }, 'allow')
  assert.throws(() => catalog.list(), error => error.code === 'SOURCE_LIMIT_EXCEEDED')
  const id = BasemapSourceId('esri-world-imagery')
  const descriptor = catalog.descriptorOf(id)
  assert.equal(descriptor.id, 'esri-world-imagery')
  assert.equal(Object.isFrozen(descriptor), true)
  assert.equal(Object.isFrozen(descriptor.supportedModes), true)
  assert.equal(Object.isFrozen(descriptor.release), true)
  assert.equal(Object.hasOwn(descriptor, 'endpoint'), false)
  assert.equal(Object.hasOwn(descriptor, 'credentialRef'), false)
  assert.equal(Object.hasOwn(descriptor, 'env'), false)
  assert.throws(() => catalog.descriptorOf(BasemapSourceId('missing-source')),
    error => error instanceof SourceCatalogError && error.code === 'SOURCE_NOT_FOUND')

  assert.equal(catalog.descriptorOf(BasemapSourceId('osm-standard')).availability.reason, 'disabled')
  assert.equal(catalog.descriptorOf(BasemapSourceId('tianditu-img-w')).availability.reason, 'missing-credential')
})

test('catalog accessors expose the existing version and resolved network config without changing list defaults', () => {
  const catalog = create({ proxy: { maxConcurrentRequests: 2, cacheMaxEntries: 3 } })
  const first = catalog.list()
  assert.equal(catalog.catalogVersion, first.catalogVersion)
  assert.deepEqual(catalog.networkConfig, {
    requestTimeoutMs: 15_000,
    maxResponseBytes: 8_388_608,
    maxConcurrentRequests: 2,
    maxQueuedRequests: 64,
    maxMetadataBytes: 1_048_576,
    cacheMaxBytes: 33_554_432,
    cacheMaxEntries: 3,
    outboundProxy: null,
  })
  catalog.descriptorOf(BasemapSourceId('esri-world-imagery'))
  assert.deepEqual(catalog.list(), first)
  throwsCode(() => create({ proxy: { maxConcurrentRequests: 0 } }), 'SOURCE_CONFIG_INVALID')
})

test('shared public preset constants match resolved endpoints and freeze nested protocol fields', () => {
  const catalog = create()
  for (const [id, preset] of Object.entries(PUBLIC_SOURCE_PRESETS)) {
    const descriptor = catalog.descriptorOf(BasemapSourceId(id))
    const resolved = catalog.resolvedSource(descriptor.id, descriptor.configDigest)
    assert.equal(resolved.endpoint, preset.url)
    assert.equal(resolved.source.adapter, preset.adapter)
    assert.equal(Object.isFrozen(preset), true)
  }
  assert.equal(Object.isFrozen(PUBLIC_SOURCE_PRESETS), true)
  assert.equal(Object.isFrozen(SOURCE_NATIVE_QUERY_FIELDS), true)
  for (const fields of Object.values(SOURCE_NATIVE_QUERY_FIELDS)) assert.equal(Object.isFrozen(fields), true)
})

test('continuation binds location and zoom as well as provider, not page size', () => {
  const catalog = create({ defaultPageSize: 1 })
  const context = { at: { lon: 116, lat: 40 }, zoom: 10 }
  const first = catalog.list(context)
  for (const changed of [
    { at: { lon: 117, lat: 40 }, zoom: 10 },
    { at: { lon: 116, lat: 40 }, zoom: 11 },
    {},
  ]) assert.throws(() => catalog.list({ ...changed, cursor: first.nextCursor }), error => error.code === 'SOURCE_RESOURCE_DENIED')
  assert.equal(catalog.list({ ...context, cursor: first.nextCursor }).sources[0].id, presetIds[1])
})

test('source identity is stable across processes and does not fingerprint credential values', () => {
  const sourceUrl = new URL('../src/sources.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {createMapSourceCatalog} from ${JSON.stringify(sourceUrl)}; console.log(createMapSourceCatalog({},'allow',{}).list().catalogVersion)`,
  ], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), create({}, 'allow').list().catalogVersion)
  const base = { custom: [custom({ credentialRef: 'private' })], credentials: {
    private: { type: 'bearer', env: 'TOKEN' },
  } }
  const initial = create(base, 'allow', { TOKEN: 'first-secret' }).list({ provider: 'custom' })
  assert.deepEqual(initial, create(base, 'allow', { TOKEN: 'second-secret' }).list({ provider: 'custom' }))
  for (const overrides of [
    { screenshot: 'allowed' },
    { endpoint: 'https://different.example.test/{z}/{x}/{y}.png' },
    { release: { version: 'release-2', publishedAt: '2024-02-29' } },
    { allowPrivateNetwork: true },
  ]) {
    const changed = create({ ...base, custom: [{ ...base.custom[0], ...overrides }] }, 'allow', { TOKEN: 'first-secret' })
    assert.notEqual(changed.list({ provider: 'custom' }).sources[0].configDigest, initial.sources[0].configDigest)
  }
})

test('release calendar errors fail activation and safe failures never echo private transport data', () => {
  throwsCode(() => create({ custom: [custom({
    release: { acquiredAt: '2024-02-30' },
  })] }), 'SOURCE_CONFIG_INVALID')
  const secret = 'unique-private-secret'
  const config = {
    custom: [custom({ endpoint: 'https://10.0.0.5/{z}/{x}/{y}.png', allowPrivateNetwork: true, credentialRef: 'private' })],
    credentials: { private: { type: 'bearer', env: 'PRIVATE_SOURCE_ENV' } },
  }
  const catalog = create(config, 'allow', { PRIVATE_SOURCE_ENV: secret })
  let safeError
  try {
    catalog.resolvedSource('custom-tiles', '0'.repeat(64))
  } catch (error) {
    safeError = { code: error.code, message: error.message }
  }
  assert.equal(safeError.code, 'SOURCE_CHANGED')
  const outputs = JSON.stringify([catalog.list(), catalog.selection('custom-tiles'), safeError])
  for (const needle of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'PRIVATE_SOURCE_ENV', '10.0.0.5']) {
    assert.equal(outputs.includes(needle), false)
  }
})

test('final UTF-8 page limits refuse wrappers and one oversized multibyte source', () => {
  throwsCode(() => create({ maxCatalogBytes: 1 }).list(), 'SOURCE_LIMIT_EXCEEDED')
  throwsCode(() => create({
    custom: [custom({ id: 'wide-attribution', attribution: '界'.repeat(1024) })],
    maxCatalogBytes: 700,
  }).list({ provider: 'custom', pageSize: 1 }), 'SOURCE_LIMIT_EXCEEDED')
  const exact = Buffer.byteLength(JSON.stringify(create({ defaultPageSize: 2 }).list()), 'utf8')
  const page = create({ defaultPageSize: 2, maxCatalogBytes: exact }).list()
  assert.equal(Buffer.byteLength(JSON.stringify(page), 'utf8'), exact)
  assert.equal(page.sources.length, 2)
  assert.ok(page.nextCursor)
})

test('XYZ admits only its declared Web Mercator profile; native adapters own other coordinate grids', () => {
  throwsCode(() => create({ custom: [custom({ nativeWkid: 4547 })] }), 'SOURCE_CONFIG_INVALID')
  for (const nativeWkid of [3857, 102100, 102113, 900913]) {
    assert.equal(create({ custom: [custom({ nativeWkid })] }).list({ provider: 'custom' }).sources[0].nativeWkid, nativeWkid)
  }
})

test('native protocol fields cannot be replaced by configured static parameters or credential bindings', () => {
  const mapserver = custom({ adapter: 'arcgis-mapserver', endpoint: 'https://maps.example.test/MapServer' })
  const wmts = custom({
    adapter: 'wmts', endpoint: 'https://maps.example.test/wmts',
    wmts: { layer: 'base', tileMatrixSet: 'grid' },
  })
  for (const entry of [
    { ...mapserver, endpoint: `${mapserver.endpoint}?f=json` },
    { ...mapserver, endpoint: `${mapserver.endpoint}?rotation=1` },
    { ...wmts, endpoint: `${wmts.endpoint}?SERVICE=WMTS` },
  ]) throwsCode(() => create({ custom: [entry] }), 'SOURCE_CONFIG_INVALID')
  for (const [entry, parameters] of [
    [mapserver, ['rotation', 'gdbVersion', 'blankTile', 'layerDefs', 'bboxSR', 'level']],
    [wmts, ['LAYER', 'TILEMATRIXSET', 'REQUEST']],
    [custom(), ['x', 'y', 'z']],
  ]) {
    for (const parameter of parameters) {
      throwsCode(() => create({
        credentials: { ref: { type: 'query', parameter, env: 'SOURCE_TEST_KEY' } },
        custom: [{ ...entry, credentialRef: 'ref' }],
      }, 'allow', { SOURCE_TEST_KEY: 'fake-private-value' }), 'SOURCE_CONFIG_INVALID')
    }
  }
})
