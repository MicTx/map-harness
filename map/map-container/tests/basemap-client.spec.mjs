import test from 'node:test'
import assert from 'node:assert/strict'
import { loadMapSourceDescriptor, mapSourceResourceProvider } from '../src/client/source-client.ts'
import { createMapSourceCatalog } from '../src/sources.ts'

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const page = catalog.list({ provider: 'esri' })

test('the map-source resource provider strictly decodes the catalog page', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return Response.json(page)
  }
  try {
    const provider = mapSourceResourceProvider(10)
    const frames = []
    const controller = new AbortController()
    for await (const frame of provider.open('dsh-resource://map-source/session%2D1?provider=esri', { signal: controller.signal })) {
      frames.push(frame)
    }
    const decodedPage = {
      ...page,
      sources: page.sources.map(source => ({ ...source, tileAdjustment: source.tileAdjustment ?? null })),
    }
    assert.deepEqual(frames, [{ ok: true, value: decodedPage }])
    assert.equal(requests[0].url, '/api/map/sources/catalog?sessionId=session-1&provider=esri')
    assert.equal(requests[0].init.signal instanceof AbortSignal, true)

    globalThis.fetch = async () => Response.json({ ...page, extra: true })
    const invalidController = new AbortController()
    const invalid = provider.open('dsh-resource://map-source/session-1', { signal: invalidController.signal })
    const firstInvalid = await invalid.next()
    invalidController.abort()
    await invalid.next()
    assert.equal(firstInvalid.value.ok, false)
    assert.equal(firstInvalid.value.error.code, 'map-source/read-failed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the render descriptor loader parses only a complete public recipe', async () => {
  const originalFetch = globalThis.fetch
  const selection = catalog.selection('esri-world-imagery', 'esri-world-boundaries-places').value
  const descriptor = {
    schemaVersion: 1,
    sessionId: 'session-1',
    runtimeEpoch: '66666666-5555-4444-8333-222222222222',
    mode: 'map',
    engineWkid: 3857,
    basemap: {
      source: selection.basemap,
      nativeEpoch: '77777777-6666-4555-8444-333333333333',
      layerKind: 'arcgis-tile',
      transport: 'public-preset',
      presetId: selection.basemap.id,
    },
    labels: {
      source: selection.labels,
      nativeEpoch: '88888888-7777-4666-8555-444444444444',
      layerKind: 'arcgis-tile',
      transport: 'public-preset',
      presetId: selection.labels.id,
    },
    earlyImagery: null,
    display: {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
    },
  }
  globalThis.fetch = async () => Response.json(descriptor)
  try {
    assert.deepEqual(await loadMapSourceDescriptor('session-1', new AbortController().signal), descriptor)
    globalThis.fetch = async () => Response.json({ ...descriptor, extra: true })
    await assert.rejects(loadMapSourceDescriptor('session-1', new AbortController().signal), /SOURCE_RESOURCE_DENIED/)
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(loadMapSourceDescriptor('session-1', new AbortController().signal), /HTTP 503/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
