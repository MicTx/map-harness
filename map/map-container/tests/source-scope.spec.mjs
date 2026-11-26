import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMapSourceCatalog } from '../src/sources.ts'
import { parseMapServerMetadata } from '../src/source-mapserver.ts'
import { nativeSourceFingerprint, sourceImageEtag, sourceImageScopeKey } from '../src/source-scope.ts'

const runtime = '11111111-1111-4111-8111-111111111111'
const nativeEpoch = '22222222-2222-4222-8222-222222222222'
const otherEpoch = '33333333-3333-4333-8333-333333333333'

function native(endpoint = 'https://private.example.test/MapServer', secret = 'fixture-secret') {
  const catalog = createMapSourceCatalog({
    credentials: { fixture: { type: 'bearer', env: 'SCOPE_TOKEN' } },
    custom: [{
      id: 'scope-fixture', title: 'Scope fixture', role: 'basemap', adapter: 'arcgis-mapserver',
      endpoint, credentialRef: 'fixture', attribution: 'Public fixture attribution',
      nativeWkid: 3857, supportsDynamicExport: true, supportedModes: ['map'],
      minZoom: 0, maxZoom: 23, compatibleBasemapIds: [],
    }],
  }, 'allow', { SCOPE_TOKEN: secret })
  const source = catalog.list({ provider: 'custom' }).sources[0]
  const resolved = catalog.resolvedSource(source.id, source.configDigest)
  const metadata = parseMapServerMetadata(source, Buffer.from(JSON.stringify({
    currentVersion: 11.5, capabilities: 'Map', singleFusedMapCache: false,
    spatialReference: { wkid: 3857 },
    fullExtent: { xmin: 0, ymin: 0, xmax: 100, ymax: 100 },
    supportedImageFormatTypes: 'PNG32,JPG', layers: [], maxImageWidth: 512, maxImageHeight: 512,
  })))
  return { adapter: 'arcgis-mapserver', resolved, metadata }
}

test('source representation keys include every exact private scope component with unambiguous encoding', () => {
  const source = native().resolved.source
  const plan = {
    kind: 'image', width: 256, height: 256,
    url: new URL('https://private.example.test/MapServer/tile/0/0/0?tenant=fixture'),
    cacheKey: 'https://private.example.test/MapServer/tile/0/0/0?tenant=fixture',
  }
  const key = sourceImageScopeKey(runtime, nativeEpoch, source, plan)
  assert.deepEqual(JSON.parse(key), ['map-source-image-v1', runtime, nativeEpoch, source.id, source.configDigest, plan.cacheKey])
  const keys = [
    key,
    sourceImageScopeKey(otherEpoch, nativeEpoch, source, plan),
    sourceImageScopeKey(runtime, otherEpoch, source, plan),
    sourceImageScopeKey(runtime, nativeEpoch, { ...source, id: 'other-source' }, plan),
    sourceImageScopeKey(runtime, nativeEpoch, { ...source, configDigest: '0'.repeat(64) }, plan),
    sourceImageScopeKey(runtime, nativeEpoch, source, { ...plan, cacheKey: `${plan.cacheKey}&other=1` }),
  ]
  assert.equal(new Set(keys).size, keys.length)
  const body = Buffer.from('opaque fixture representation')
  const tags = keys.map(scope => sourceImageEtag(scope, body))
  assert.equal(new Set(tags).size, tags.length)
  assert.notEqual(sourceImageEtag(key, Buffer.from('different representation')), tags[0])
  const expected = createHash('sha256').update(Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0]), body])).digest('hex')
  assert.equal(tags[0], `"${expected}"`)
  assert.match(tags[0], /^"[a-f0-9]{64}"$/)
  for (const value of ['fixture-secret', 'SCOPE_TOKEN', 'private.example.test', 'tenant']) assert.equal(tags[0].includes(value), false)
})

test('native geometry fingerprints exclude resolved endpoints and credentials but detect semantic changes', () => {
  const first = native()
  const moved = native('https://different-private.example.test/MapServer', 'other-fixture-secret')
  assert.notDeepEqual(first.resolved, moved.resolved)
  assert.equal(nativeSourceFingerprint(first), nativeSourceFingerprint(moved))
  const changed = structuredClone(first)
  changed.metadata.service.fullExtent.xmax = 101
  assert.notEqual(nativeSourceFingerprint(first), nativeSourceFingerprint(changed))
  assert.equal(nativeSourceFingerprint({ adapter: 'xyz', resolved: first.resolved }), nativeSourceFingerprint({ adapter: 'xyz', resolved: moved.resolved }))
  assert.notEqual(nativeSourceFingerprint({ adapter: 'xyz', resolved: first.resolved }), nativeSourceFingerprint(first))
})
