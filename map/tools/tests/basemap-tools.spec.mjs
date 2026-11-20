import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { MAP_META_SCHEMA_VERSION } from '../../map-container/src/protocol.ts'
import { mapListBasemaps, mapSetBasemap, mapSetImagery, mapGetState } from '../src/map-tools.ts'
import { mapSetView } from '../src/map-tools.ts'
import { waybackDescriptor } from '../../map-container/src/wayback.ts'

const allowedConfig = {
  observation: { capturePolicy: 'allow' },
  sources: {
    presets: {
      'esri-world-imagery': { automatedMapUse: 'allowed' },
      'esri-world-boundaries-places': { automatedMapUse: 'allowed' },
    },
  },
}

test('map_list_basemaps returns the bounded public catalog without network', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  try {
    const session = rig.session('list')
    const page = await mapListBasemaps.execute({ provider: 'esri', page_size: 2 }, rig.exec(session))
    assert.equal(page.catalog_version.length > 0, true)
    assert.equal(page.can_change, true)
    assert.deepEqual(page.context, { provider: 'esri', at: null, zoom: null })
    assert.equal(page.sources.length, 2)
    assert.equal(typeof page.next_cursor, 'string')
    const next = await mapListBasemaps.execute({ provider: 'esri', page_size: 2, cursor: page.next_cursor }, rig.exec(session))
    assert.equal(next.sources.length, 1)
    assert.equal(next.sources[0].id, 'esri-wayback')
    await assert.rejects(mapListBasemaps.execute({ provider: 'wayback' }, rig.exec(session)), /SOURCE_RESOURCE_DENIED/)
    await assert.rejects(mapListBasemaps.execute({ at: [1, 1] }, rig.exec(session)), /at and zoom must be supplied together/)
  } finally {
    await rig.dispose()
  }
})

test('map_set_basemap refuses historical writes before network in read-only deployments', async () => {
  const rig = await mapRig({ mapConfig: { sources: { allowChanges: false } } })
  try {
    const session = rig.session('read-only-wayback')
    const catalog = rig.ctx.get('mapSourceService').catalog
    const resolve = catalog.selection
    const face = {
      ...rig.ctx.get('mapSourceService'),
      catalog: {
        ...catalog,
        selection(sourceId, labels) {
          if (sourceId === 'esri-world-imagery') return { ok: true, value: { schemaVersion: 1, basemap: {}, labels: null } }
          return resolve(sourceId, labels)
        },
      },
      async waybackRelease() { throw new Error('network must not be called') },
    }
    const context = { ...rig.exec(session, { callId: 'read-only-wayback' }), agent: { ctx: { get: name => name === 'mapSourceService' ? face : rig.ctx.get(name) }, session } }
    rig.call(session, 'read-only-wayback', 'map_set_basemap', { source_id: 'esri-wayback', release_id: 10 })
    await assert.rejects(
      mapSetBasemap.execute({ source_id: 'esri-wayback', release_id: 10 }, context),
      /SOURCE_READ_ONLY/,
    )
    assert.equal(rig.state(session).revision, 0)
  } finally {
    await rig.dispose()
  }
})

test('map_set_basemap folds a verified historical release and rejects unavailable ids', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  const source = {
    ...waybackDescriptor({
      releaseId: 10, itemId: '903f0abe9c3b452dafe1ca5b8dd858b9', title: 'World Imagery (Wayback 2014-02-20)',
      publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
    }),
    screenshot: 'allowed', automatedMapUse: 'allowed',
  }
  try {
    const session = rig.session('wayback-tool')
    const actual = rig.ctx.get('mapSourceService')
    const face = {
      ...actual,
      async waybackRelease(id) {
        if (id !== 10) throw Object.assign(new Error('not found'), { code: 'SOURCE_NOT_FOUND' })
        return source
      },
      async prepare(value) { assert.deepEqual(value, source) },
    }
    const context = callId => ({ ...rig.exec(session, { callId }), agent: { ctx: { get: name => name === 'mapSourceService' ? face : rig.ctx.get(name) }, session } })
    const call = rig.call(session, 'wayback-valid', 'map_set_basemap', { source_id: 'esri-wayback', release_id: 10 })
    const result = await mapSetBasemap.execute({ source_id: 'esri-wayback', release_id: 10 }, context('wayback-valid'))
    await rig.result(session, call, { meta: result.meta })
    assert.equal(rig.state(session).basemap.basemap.release.version, '10')
    assert.equal(rig.state(session).basemap.basemap.release.publishedAt, '2014-02-20')
    rig.call(session, 'wayback-unknown', 'map_set_basemap', { source_id: 'esri-wayback', release_id: 999 })
    await assert.rejects(mapSetBasemap.execute({ source_id: 'esri-wayback', release_id: 999 }, context('wayback-unknown')), { code: 'SOURCE_NOT_FOUND' })
    assert.equal(rig.state(session).basemap.basemap.release.version, '10')
  } finally {
    await rig.dispose()
  }
})

test('map_set_basemap admits, folds, preserves labels by omission, and turns labels off explicitly', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  try {
    const session = rig.session('set')
    const call = rig.call(session, 'set-labels', 'map_set_basemap', {
      source_id: 'esri-world-imagery',
      label_source_id: 'esri-world-boundaries-places',
    })
    const proposed = await mapSetBasemap.execute({
      source_id: 'esri-world-imagery',
      label_source_id: 'esri-world-boundaries-places',
    }, rig.exec(session, { callId: 'set-labels' }))
    assert.equal(proposed.meta.schemaVersion, MAP_META_SCHEMA_VERSION)
    assert.equal(proposed.target_revision, 0)
    assert.equal(proposed.selection.basemap.id, 'esri-world-imagery')
    assert.equal(proposed.selection.labels.id, 'esri-world-boundaries-places')
    await rig.result(session, call, { meta: proposed.meta })
    assert.equal(rig.state(session).revision, 1)
    assert.equal(rig.state(session).basemap.labels.id, 'esri-world-boundaries-places')

    const preserveCall = rig.call(session, 'preserve-labels', 'map_set_basemap', { source_id: 'esri-world-imagery' })
    const preserve = await mapSetBasemap.execute({ source_id: 'esri-world-imagery' }, rig.exec(session, { callId: 'preserve-labels' }))
    await rig.result(session, preserveCall, { meta: preserve.meta })
    assert.equal(rig.state(session).basemap.labels.id, 'esri-world-boundaries-places')

    const offCall = rig.call(session, 'off-labels', 'map_set_basemap', { source_id: 'esri-world-imagery', label_source_id: null })
    const off = await mapSetBasemap.execute({ source_id: 'esri-world-imagery', label_source_id: null }, rig.exec(session, { callId: 'off-labels' }))
    await rig.result(session, offCall, { meta: off.meta })
    assert.equal(rig.state(session).basemap.labels, null)
    assert.deepEqual(rig.state(session).view, {
      center: [104.9, 36.4],
      zoom: 4,
      wkid: 4326,
    })
    assert.deepEqual(rig.state(session).layers, [])
  } finally {
    await rig.dispose()
  }
})

test('map_set_basemap selects an OSM source even when automated use is marked denied', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('osm-denied-policy')
  const call = rig.call(session, 'select-osm', 'map_set_basemap', { source_id: 'osm-standard', label_source_id: null })
  const result = await mapSetBasemap.execute({ source_id: 'osm-standard', label_source_id: null }, rig.exec(session, { callId: 'select-osm' }))
  assert.equal(result.selection.basemap.automatedMapUse, 'denied')
  rig.result(session, call, { meta: result.meta })
  assert.equal(rig.state(session).basemap.basemap.id, 'osm-standard')
})

test('map_set_basemap retains current-view compatibility checks', async () => {
  const incompatible = await mapRig({
    mapConfig: {
      sources: {
        custom: [{
          id: 'projected-custom', title: 'Projected custom', role: 'basemap', adapter: 'wmts',
          endpoint: 'https://tiles.example.test/wmts', nativeWkid: 4547,
          attribution: 'Fixture credit',
          wmts: { layer: 'fixture', tileMatrixSet: 'fixture-grid' },
          supportedModes: ['map'], minZoom: 0, maxZoom: 19, compatibleBasemapIds: [],
          automatedMapUse: 'allowed',
        }],
      },
    },
  })
  try {
    const session = incompatible.session('view')
    const call = incompatible.call(session, 'bad-view', 'map_set_basemap', { source_id: 'projected-custom' })
    await assert.rejects(
      mapSetBasemap.execute({ source_id: 'projected-custom' }, incompatible.exec(session, { callId: 'bad-view' })),
      /SOURCE_COMBINATION_UNSUPPORTED/,
    )
    assert.equal(incompatible.state(session).revision, 0)
  } finally {
    await incompatible.dispose()
  }
})

test('map_set_basemap refuses a revision that changed while native preparation was blocked', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const server = createServer(async (_req, res) => {
    entered.resolve()
    await release.promise
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      currentVersion: 11.5,
      capabilities: 'Map,Query',
      singleFusedMapCache: true,
      spatialReference: { wkid: 3857 },
      fullExtent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      supportedImageFormatTypes: 'PNG32,PNG,JPG',
      tileInfo: {
        rows: 2, cols: 2, dpi: 96, format: 'PNG32', origin: { x: 0, y: 0 },
        spatialReference: { wkid: 3857 }, lods: [{ level: 0, resolution: 1, scale: 1 }],
      },
      layers: [],
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const port = server.address().port
  const rig = await mapRig({
    mapConfig: {
      observation: { capturePolicy: 'allow' },
      sources: {
        custom: [{
          id: 'blocked-native', title: 'Blocked native', role: 'basemap', adapter: 'arcgis-mapserver',
          endpoint: `http://127.0.0.1:${port}/MapServer`, nativeWkid: 3857,
          attribution: 'Fixture credit', supportedModes: ['map'], minZoom: 0, maxZoom: 20,
          compatibleBasemapIds: [], allowPrivateNetwork: true, allowHttp: true,
          automatedMapUse: 'allowed',
        }],
      },
    },
  })
  try {
    const session = rig.session('concurrent')
    rig.call(session, 'blocked-base', 'map_set_basemap', { source_id: 'blocked-native' })
    const viewCall = rig.call(session, 'concurrent-view', 'map_set_view', { center: [1, 1], zoom: 2 })
    const blocked = mapSetBasemap.execute({ source_id: 'blocked-native' }, rig.exec(session, { callId: 'blocked-base' }))
    await entered.promise
    const view = await mapSetView.execute({ center: [1, 1], zoom: 2 }, rig.exec(session, { callId: 'concurrent-view' }))
    await rig.result(session, viewCall, { meta: view.meta })
    assert.equal(rig.state(session).revision, 1)
    release.resolve()
    await assert.rejects(blocked, /SOURCE_CHANGED: the map changed while the map source was verified/)
    assert.equal(rig.state(session).basemap, null)
  } finally {
    await rig.dispose()
  }
})

const waybackReleaseSource = id => ({
  ...waybackDescriptor({
    releaseId: id, itemId: '903f0abe9c3b452dafe1ca5b8dd858b9', title: 'World Imagery (Wayback 2014-02-20)',
    publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
  }),
  screenshot: 'allowed', automatedMapUse: 'allowed',
})

test('map_set_imagery folds visibility and opacity changes that omission preserves', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  try {
    const session = rig.session('imagery-display')
    const initial = rig.state(session).imageryDisplay
    assert.deepEqual(initial, {
      labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null,
    })
    const unchangedCall = rig.call(session, 'imagery-unchanged', 'map_set_imagery', {})
    const unchanged = await mapSetImagery.execute({}, rig.exec(session, { callId: 'imagery-unchanged' }))
    assert.equal(unchanged.meta.schemaVersion, MAP_META_SCHEMA_VERSION)
    assert.equal(unchanged.meta.change.op, 'set-imagery-display')
    assert.equal(unchanged.target_revision, 0)
    await rig.result(session, unchangedCall, { meta: unchanged.meta })
    assert.deepEqual(rig.state(session).imageryDisplay, initial)
    assert.equal(rig.state(session).revision, 1)

    const blendCall = rig.call(session, 'imagery-blend', 'map_set_imagery', { recent_opacity: 0.3 })
    const blend = await mapSetImagery.execute({ recent_opacity: 0.3 }, rig.exec(session, { callId: 'imagery-blend' }))
    await rig.result(session, blendCall, { meta: blend.meta })
    assert.deepEqual(rig.state(session).imageryDisplay, {
      labelsVisible: true, recentVisible: true, recentOpacity: 0.3, earlyVisible: false, earlySource: null,
    })

    const toggleCall = rig.call(session, 'imagery-toggle', 'map_set_imagery', { labels_visible: false, recent_visible: false })
    const toggle = await mapSetImagery.execute({ labels_visible: false, recent_visible: false }, rig.exec(session, { callId: 'imagery-toggle' }))
    await rig.result(session, toggleCall, { meta: toggle.meta })
    assert.deepEqual(rig.state(session).imageryDisplay, {
      labelsVisible: false, recentVisible: false, recentOpacity: 0.3, earlyVisible: false, earlySource: null,
    })

    const read = await mapGetState.execute({}, rig.exec(session, { callId: 'imagery-read' }))
    assert.deepEqual(read.imagery_display, {
      labelsVisible: false, recentVisible: false, recentOpacity: 0.3, earlyVisible: false, earlySource: null,
    })
  } finally {
    await rig.dispose()
  }
})

test('map_set_imagery selects a fixed official release, then clears it', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  const requested = []
  try {
    const session = rig.session('imagery-release')
    const actual = rig.ctx.get('mapSourceService')
    const face = {
      ...actual,
      async waybackRelease(id) {
        requested.push(id)
        return waybackReleaseSource(id)
      },
    }
    const exec = callId => ({ ...rig.exec(session, { callId }), agent: { ctx: { get: name => name === 'mapSourceService' ? face : rig.ctx.get(name) }, session } })
    const selectCall = rig.call(session, 'imagery-select', 'map_set_imagery', { early_release_id: 10 })
    const select = await mapSetImagery.execute({ early_release_id: 10 }, exec('imagery-select'))
    assert.deepEqual(requested, [10])
    await rig.result(session, selectCall, { meta: select.meta })
    assert.equal(rig.state(session).imageryDisplay.earlySource.release.version, '10')
    assert.equal(rig.state(session).imageryDisplay.earlyVisible, false)

    const showCall = rig.call(session, 'imagery-show', 'map_set_imagery', { early_visible: true })
    const show = await mapSetImagery.execute({ early_visible: true }, exec('imagery-show'))
    await rig.result(session, showCall, { meta: show.meta })
    assert.equal(rig.state(session).imageryDisplay.earlyVisible, true)
    assert.deepEqual(rig.state(session).imageryDisplay.earlySource, select.imagery_display.earlySource)

    const clearCall = rig.call(session, 'imagery-clear', 'map_set_imagery', { early_release_id: null })
    const clear = await mapSetImagery.execute({ early_release_id: null }, exec('imagery-clear'))
    await rig.result(session, clearCall, { meta: clear.meta })
    assert.deepEqual(rig.state(session).imageryDisplay, {
      labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null,
    })
    assert.deepEqual(requested, [10])
  } finally {
    await rig.dispose()
  }
})

test('map_set_imagery admits unverified releases and refuses invalid arguments', async () => {
  const rig = await mapRig({ mapConfig: allowedConfig })
  try {
    const session = rig.session('imagery-refusals')
    const actual = rig.ctx.get('mapSourceService')
    const unverified = {
      ...actual,
      async waybackRelease(id) {
        return { ...waybackReleaseSource(id), automatedMapUse: 'unverified' }
      },
    }
    const unverifiedExec = { ...rig.exec(session, { callId: 'imagery-policy' }), agent: { ctx: { get: name => name === 'mapSourceService' ? unverified : rig.ctx.get(name) }, session } }
    rig.call(session, 'imagery-policy', 'map_set_imagery', { early_release_id: 10 })
    const selected = await mapSetImagery.execute({ early_release_id: 10 }, unverifiedExec)
    assert.equal(selected.imagery_display.earlySource.automatedMapUse, 'unverified')

    rig.call(session, 'imagery-no-release', 'map_set_imagery', { early_visible: true })
    await assert.rejects(
      mapSetImagery.execute({ early_visible: true }, rig.exec(session, { callId: 'imagery-no-release' })),
      /SOURCE_COMBINATION_UNSUPPORTED: Visible early imagery requires a fixed Wayback release/,
    )

    rig.call(session, 'imagery-bad-opacity', 'map_set_imagery', { recent_opacity: 1.5 })
    await assert.rejects(
      mapSetImagery.execute({ recent_opacity: 1.5 }, rig.exec(session, { callId: 'imagery-bad-opacity' })),
      /INVALID_ARGUMENT: recent_opacity/,
    )
    rig.call(session, 'imagery-bad-release', 'map_set_imagery', { early_release_id: -2 })
    await assert.rejects(
      mapSetImagery.execute({ early_release_id: -2 }, rig.exec(session, { callId: 'imagery-bad-release' })),
      /SOURCE_RESOURCE_DENIED: early_release_id/,
    )
    assert.equal(rig.state(session).revision, 0)
    assert.equal(rig.state(session).imageryDisplay.earlySource, null)
  } finally {
    await rig.dispose()
  }
})
