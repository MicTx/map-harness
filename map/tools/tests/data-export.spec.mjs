/**
 * `data_export` integration fixtures over the REAL catalog service and
 * projection: the three sources (exact ref, loaded layer, whole map) across
 * the four formats, precise inputRefs/digest/byte counts in the durable
 * meta, revoked and path-loaded refusals, the whole-map per-layer success
 * and failure report, and retry_of returning the existing artifact without
 * republishing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/index.ts'
import { dataExport, dataImport } from '../src/data-tools.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { decodeDataExportMeta } from '../src/data-meta.ts'
import { parseShapefileImport } from '../src/import-format/shapefile.ts'

const utf8 = (text) => new TextEncoder().encode(text)
const CSV = 'lon,lat,name\n116.4,39.9,first\n121.47,31.23,second\n'
const LINE_CSV = 'wkt_hint\nignored\n'
const GEOJSON_LINES = { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[116.4, 39.9], [117.0, 40.0]] }, properties: { name: 'road' } },
] }

/** Mount the full rig: map projection + real spatial catalog over a temp store. */
async function chainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `data-export-${label}-`))
  const storeRoot = join(dir, 'store')
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: storeRoot })
  return {
    dir,
    rig,
    put: (name, bytes) => {
      writeFileSync(join(dir, name), bytes)
      return name
    },
    catalog: rig.ctx.get('spatialCatalog').forSession(rig.session(label).id),
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Import the point CSV as a named resource; returns the registered ref. */
async function importPoints(chain, session, callId, name = 'points') {
  chain.rig.call(session, callId, 'data_import', { path: 'points.csv', name })
  const imported = await dataImport.execute({ path: 'points.csv', name }, chain.rig.exec(session, { callId }))
  assert.equal(imported.status, 'succeeded')
  return imported
}

test('the ref source publishes all four formats with precise artifacts and meta', async () => {
  const chain = await chainRig('formats')
  try {
    const path = chain.put('points.csv', utf8(CSV))
    const session = chain.rig.session('formats')
    const imported = await importPoints(chain, session, 'c-imp')
    const refs = []
    for (const [index, format] of ['geojson', 'csv', 'kml', 'shapefile'].entries()) {
      const callId = `c-fmt-${format}`
      chain.rig.call(session, callId, 'data_export', { ref: imported.resource.ref, format })
      const exported = await dataExport.execute({ ref: imported.resource.ref, format }, chain.rig.exec(session, { callId }))
      assert.equal(exported.status, 'succeeded', format)
      assert.equal(exported.source.kind, 'ref')
      assert.match(exported.artifact.ref, /^art-[a-f0-9-]+@v1$/, format)
      assert.equal(exported.artifact.feature_count, 2)
      assert.ok(exported.artifact.byte_count > 0)
      refs.push(exported.artifact.ref)
      const meta = decodeDataExportMeta(dataExport.output.presentationMeta({}, exported))
      assert.equal(meta.status, 'ok')
      assert.equal(meta.meta.format, format)
      assert.equal(meta.meta.artifacts[0].sourceRef, imported.resource.ref)
      assert.equal(meta.meta.artifacts[0].featureCount, 2)
    }
    assert.equal(new Set(refs).size, 4, 'each format publishes its own artifact')

    // The published shapefile bytes re-import through the data admission.
    chain.rig.call(session, 'c-roundtrip', 'data_export', { ref: imported.resource.ref, format: 'shapefile' })
    const shapeArtifact = await dataExport.execute(
      { ref: imported.resource.ref, format: 'shapefile' },
      chain.rig.exec(session, { callId: 'c-roundtrip' }),
    )
    const { artifact: read } = await chain.catalog.readArtifactBytes(shapeArtifact.artifact.ref, chain.catalog.deploymentDomain())
    assert.equal(read.method.algorithm, 'data-export-shapefile')
    assert.deepEqual(read.inputRefs, [imported.resource.ref])
  } finally {
    await chain.dispose()
  }
})

test('the layer source exports projection data; path-loaded layers refuse', async () => {
  const chain = await chainRig('layer')
  try {
    chain.put('points.csv', utf8(CSV))
    const session = chain.rig.session('layer')
    const imported = await importPoints(chain, session, 'c-imp')
    const addCall = chain.rig.call(session, 'c-add', 'map_add_layer', { ref: imported.resource.ref, layer_id: 'pts' })
    const added = await mapAddLayer.execute({ ref: imported.resource.ref, layer_id: 'pts' }, chain.rig.exec(session, { callId: 'c-add' }))
    chain.rig.result(session, addCall, { meta: added.meta })
    chain.rig.call(session, 'c-exp', 'data_export', { layer_id: 'pts', format: 'csv' })
    const exported = await dataExport.execute({ layer_id: 'pts', format: 'csv' }, chain.rig.exec(session, { callId: 'c-exp' }))
    assert.equal(exported.status, 'succeeded')
    assert.equal(exported.source.kind, 'layer')
    assert.equal(exported.source.layer_id, 'pts')
    assert.equal(exported.artifact.feature_count, 2)
    const meta = decodeDataExportMeta(dataExport.output.presentationMeta({}, exported))
    assert.equal(meta.meta.artifacts[0].layerId, 'pts')
    assert.equal(meta.meta.artifacts[0].sourceRef, imported.resource.ref)

    // A path-loaded layer cannot back an export artifact.
    const pathGeojson = chain.put('path.geojson', utf8(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} }] })))
    const pathCall = chain.rig.call(session, 'c-path-add', 'map_add_layer', { path: pathGeojson, layer_id: 'raw' })
    const pathAdded = await mapAddLayer.execute({ path: pathGeojson, layer_id: 'raw' }, chain.rig.exec(session, { callId: 'c-path-add' }))
    chain.rig.result(session, pathCall, { meta: pathAdded.meta })
    chain.rig.call(session, 'c-path-exp', 'data_export', { layer_id: 'raw', format: 'geojson' })
    await assert.rejects(
      dataExport.execute({ layer_id: 'raw', format: 'geojson' }, chain.rig.exec(session, { callId: 'c-path-exp' })),
      /INVALID_ARGUMENT: layer raw was loaded from a workspace path/,
    )
  } finally {
    await chain.dispose()
  }
})

test('the whole-map source reports per-layer success and failure honestly', async () => {
  const chain = await chainRig('whole')
  try {
    chain.put('points.csv', utf8(CSV))
    chain.put('lines.geojson', utf8(JSON.stringify(GEOJSON_LINES)))
    const session = chain.rig.session('whole')
    const imported = await importPoints(chain, session, 'c-imp')
    // A second ref-loaded layer: one whole-map call must publish one artifact
    // per layer under distinct within-call operation slots (regression: the
    // single-operation identity refused the second publication).
    const linesCall = chain.rig.call(session, 'c-reg-lines', 'catalog_register', { path: 'lines.geojson', name: 'lines' })
    const lines = await catalogRegister.execute({ path: 'lines.geojson', name: 'lines' }, chain.rig.exec(session, { callId: 'c-reg-lines' }))
    chain.rig.result(session, linesCall, { meta: lines.meta })
    for (const [callId, args] of [
      ['c-add1', { ref: imported.resource.ref, layer_id: 'ref-layer' }],
      ['c-add2', { path: 'lines.geojson', layer_id: 'path-layer' }],
      ['c-add3', { ref: lines.resource.ref, layer_id: 'lines-layer' }],
    ]) {
      const call = chain.rig.call(session, callId, 'map_add_layer', args)
      const added = await mapAddLayer.execute(args, chain.rig.exec(session, { callId }))
      chain.rig.result(session, call, { meta: added.meta })
    }
    const mapCall = chain.rig.call(session, 'c-map', 'data_export', { map: true, format: 'geojson' })
    const exported = await dataExport.execute({ map: true, format: 'geojson' }, chain.rig.exec(session, { callId: 'c-map' }))
    assert.equal(exported.status, 'succeeded')
    assert.equal(exported.source.kind, 'map')
    assert.equal(exported.exported.length, 2)
    assert.deepEqual(exported.exported.map(entry => entry.layer_id).sort(), ['lines-layer', 'ref-layer'])
    assert.equal(new Set(exported.exported.map(entry => entry.artifact.ref)).size, 2, 'each layer publishes its own artifact ref')
    assert.equal(exported.failed.length, 1)
    assert.equal(exported.failed[0].layer_id, 'path-layer')
    assert.match(exported.failed[0].reason, /loaded from a workspace path/)
    const meta = decodeDataExportMeta(dataExport.output.presentationMeta({}, exported))
    assert.equal(meta.status, 'ok')
    assert.equal(meta.meta.artifacts.length, 2)
    // retry_of replays the call's first slot without re-reading any source.
    chain.rig.call(session, 'c-map-retry', 'data_export', { retry_of: mapCall.seq })
    const retried = await dataExport.execute({ retry_of: mapCall.seq }, chain.rig.exec(session, { callId: 'c-map-retry' }))
    assert.equal(retried.artifact.ref, exported.exported[0].artifact.ref)
  } finally {
    await chain.dispose()
  }
})

test('a revoked source refuses before any publication', async () => {
  const chain = await chainRig('revoked')
  try {
    chain.put('points.csv', utf8(CSV))
    const session = chain.rig.session('revoked')
    const imported = await importPoints(chain, session, 'c-imp')
    await chain.catalog.setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: imported.resource.ref, state: 'revoked',
    })
    chain.rig.call(session, 'c-exp', 'data_export', { ref: imported.resource.ref, format: 'geojson' })
    await assert.rejects(
      dataExport.execute({ ref: imported.resource.ref, format: 'geojson' }, chain.rig.exec(session, { callId: 'c-exp' })),
      /GOVERNANCE_REVOKED/,
    )
  } finally {
    await chain.dispose()
  }
})

test('retry_of returns the existing artifact; unknown seq refuses; selectors validate', async () => {
  const chain = await chainRig('retry')
  try {
    chain.put('points.csv', utf8(CSV))
    const session = chain.rig.session('retry')
    const imported = await importPoints(chain, session, 'c-imp')
    const firstCall = chain.rig.call(session, 'c-exp', 'data_export', { ref: imported.resource.ref, format: 'kml' })
    const first = await dataExport.execute({ ref: imported.resource.ref, format: 'kml' }, chain.rig.exec(session, { callId: 'c-exp' }))
    chain.rig.result(session, firstCall, { meta: first.meta })
    const replayCall = chain.rig.call(session, 'c-replay', 'data_export', { retry_of: firstCall.seq })
    const replay = await dataExport.execute({ retry_of: firstCall.seq }, chain.rig.exec(session, { callId: 'c-replay' }))
    chain.rig.result(session, replayCall, { meta: replay.meta })
    assert.equal(replay.artifact.ref, first.artifact.ref)
    assert.equal(replay.artifact.content_digest, first.artifact.content_digest)
    assert.equal(replay.retry_of, firstCall.seq)

    chain.rig.call(session, 'c-unknown', 'data_export', { retry_of: 9999 })
    await assert.rejects(
      dataExport.execute({ retry_of: 9999 }, chain.rig.exec(session, { callId: 'c-unknown' })),
      /CATALOG_OPERATION_NOT_PUBLISHED/,
    )

    chain.rig.call(session, 'c-mutex', 'data_export', { ref: imported.resource.ref, layer_id: 'x', format: 'csv' })
    await assert.rejects(
      dataExport.execute({ ref: imported.resource.ref, layer_id: 'x', format: 'csv' }, chain.rig.exec(session, { callId: 'c-mutex' })),
      /INVALID_ARGUMENT: data_export requires exactly one of ref, layer_id, or map/,
    )
    chain.rig.call(session, 'c-fmt', 'data_export', { ref: imported.resource.ref, format: 'xlsx' })
    await assert.rejects(
      dataExport.execute({ ref: imported.resource.ref, format: 'xlsx' }, chain.rig.exec(session, { callId: 'c-fmt' })),
      /INVALID_ARGUMENT: format "xlsx"/,
    )
  } finally {
    await chain.dispose()
  }
})

test('a CSV export of a line layer refuses; the model can pivot to geojson', async () => {
  const chain = await chainRig('lines')
  try {
    chain.put('lines.geojson', utf8(JSON.stringify(GEOJSON_LINES)))
    const session = chain.rig.session('lines')
    chain.rig.call(session, 'c-imp', 'data_import', { path: 'lines.geojson', name: 'lines' })
    const imported = await dataImport.execute({ path: 'lines.geojson', name: 'lines' }, chain.rig.exec(session, { callId: 'c-imp' }))
    assert.equal(imported.status, 'succeeded')
    chain.rig.call(session, 'c-exp', 'data_export', { ref: imported.resource.ref, format: 'csv' })
    await assert.rejects(
      dataExport.execute({ ref: imported.resource.ref, format: 'csv' }, chain.rig.exec(session, { callId: 'c-exp' })),
      /GEOMETRY_UNSUPPORTED: CSV export carries point data only/,
    )
  } finally {
    await chain.dispose()
  }
})
