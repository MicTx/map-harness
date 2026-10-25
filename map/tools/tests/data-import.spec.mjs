/**
 * `data_import` integration fixtures over the REAL catalog service and
 * projection: accepted `tool/call` → import → register → resolve →
 * `map_add_layer`, the confirmation round trip with zero catalog writes
 * before a decision, the two new error codes, same-name versioning,
 * zero-residue failures, retry_of idempotence, and the authorization-domain
 * refusal. The `catalog_register` verbatim-copy contract is asserted
 * unchanged alongside.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { dataImport } from '../src/data-tools.ts'
import { catalogResolve } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { SHAPE_TYPES, shapefileZip } from './fixtures/shapefile-fixtures.mjs'
import { decodeCatalogResultMeta } from '../src/catalog-meta.ts'

/** Mount the full rig: map projection + real spatial catalog over a temp store. */
async function chainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `data-import-${label}-`))
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

const utf8 = (text) => new TextEncoder().encode(text)
const CSV = 'lon,lat,name,score\n116.4,39.9,first,1.5\n121.47,31.23,second,2\n'
const AMBIGUOUS_CSV = 'x,y,name\n116.4,39.9,first\n'
const GBK_CSV = Uint8Array.from([
  0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0xBE, 0xAD, 0xB6, 0xC8, 0x2C, 0xCE, 0xB3, 0xB6, 0xC8, 0x0A,
  0xBC, 0xD7, 0x2C, 0x31, 0x31, 0x36, 0x2E, 0x34, 0x2C, 0x33, 0x39, 0x2E, 0x39, 0x0A,
])

test('the full chain: import CSV → register → resolve → map_add_layer ref', async () => {
  const chain = await chainRig('full')
  try {
    const path = chain.put('points.csv', utf8(CSV))
    const session = chain.rig.session('full')
    const call = chain.rig.call(session, 'c-import', 'data_import', { path, name: 'points' })
    const imported = await dataImport.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c-import' }))
    chain.rig.result(session, call, { meta: imported.meta })
    assert.equal(imported.status, 'succeeded')
    assert.match(imported.resource.ref, /^res-[a-f0-9]{24}@v1$/)
    assert.equal(imported.resource.featureCount, 2)
    assert.equal(imported.resource.nativeCrs, 'EPSG:4326')
    assert.equal(imported.total_feature_refs, 2)
    assert.deepEqual(imported.import, { format: 'csv', encoding: 'utf-8', source_digest: imported.import.source_digest })
    assert.match(imported.import.source_digest, /^[0-9a-f]{64}$/)
    assert.ok(imported.limitations.some(line => line.includes('normalized to WGS84')))
    const meta = decodeCatalogResultMeta(dataImport.output.presentationMeta({}, imported))
    assert.equal(meta.operation, 'register')
    assert.equal(meta.resources[0].ref, imported.resource.ref)
    assert.equal(dataImport.output.render({}, imported)[0].text.includes('"meta"'), false)

    const resolved = await catalogResolve.execute({ resource: imported.resource.ref }, chain.rig.exec(session, { callId: 'c-res' }))
    assert.deepEqual(resolved.schema.fields.map(field => field.name).sort(), ['name', 'score'])

    const addCall = chain.rig.call(session, 'c-add', 'map_add_layer', { ref: imported.resource.ref, layer_id: 'pts' })
    const added = await mapAddLayer.execute({ ref: imported.resource.ref, layer_id: 'pts' }, chain.rig.exec(session, { callId: 'c-add' }))
    chain.rig.result(session, addCall, { meta: added.meta })
    assert.equal(added.layer.id, 'pts')
    assert.equal(chain.rig.state(session).layers[0].resourceRef, imported.resource.ref)
  } finally {
    await chain.dispose()
  }
})

test('an ambiguous CSV stops at needs_confirmation with zero catalog rows, then confirms', async () => {
  const chain = await chainRig('confirm')
  try {
    const path = chain.put('xy.csv', utf8(AMBIGUOUS_CSV))
    const session = chain.rig.session('confirm')
    const gateCall = chain.rig.call(session, 'c-gate', 'data_import', { path })
    const gated = await dataImport.execute({ path }, chain.rig.exec(session, { callId: 'c-gate' }))
    chain.rig.result(session, gateCall, { text: 'needs confirmation' })
    assert.equal(gated.status, 'needs_confirmation')
    assert.ok(gated.admission.column_candidates.lon.some(entry => entry.column === 'x'))
    assert.match(gated.candidates_fingerprint, /^[0-9a-f]{64}$/)
    const listing = await chain.catalog.searchResources({ search: {}, authorization: chain.catalog.deploymentDomain() })
    assert.equal(listing.resources.length, 0, 'no catalog row may exist before the confirmation')

    const confirmCall = chain.rig.call(session, 'c-confirm', 'data_import', {
      path,
      lon_column: 'x',
      lat_column: 'y',
      confirm: { fingerprint: gated.candidates_fingerprint },
    })
    const confirmed = await dataImport.execute({
      path,
      lon_column: 'x',
      lat_column: 'y',
      confirm: { fingerprint: gated.candidates_fingerprint },
    }, chain.rig.exec(session, { callId: 'c-confirm' }))
    chain.rig.result(session, confirmCall, { meta: confirmed.meta })
    assert.equal(confirmed.status, 'succeeded')
    assert.deepEqual(confirmed.admission ?? undefined, undefined)
  } finally {
    await chain.dispose()
  }
})

test('the two new error codes surface through the tool', async () => {
  const chain = await chainRig('codes')
  try {
    const csvPath = chain.put('notkml.kml', utf8(CSV))
    const session = chain.rig.session('codes')
    chain.rig.call(session, 'c-fmt', 'data_import', { path: csvPath })
    await assert.rejects(
      dataImport.execute({ path: csvPath }, chain.rig.exec(session, { callId: 'c-fmt' })),
      /IMPORT_FORMAT_INVALID/,
    )
    const gbkPath = chain.put('cn.csv', GBK_CSV)
    chain.rig.call(session, 'c-enc', 'data_import', { path: gbkPath })
    await assert.rejects(
      dataImport.execute({ path: gbkPath }, chain.rig.exec(session, { callId: 'c-enc' })),
      /IMPORT_ENCODING_INVALID/,
    )
  } finally {
    await chain.dispose()
  }
})

test('re-importing one name with changed content publishes the next version', async () => {
  const chain = await chainRig('version')
  try {
    const path = chain.put('v.csv', utf8('lon,lat\n116.4,39.9\n'))
    const session = chain.rig.session('version')
    chain.rig.call(session, 'c-v1', 'data_import', { path, name: 'series' })
    const first = await dataImport.execute({ path, name: 'series' }, chain.rig.exec(session, { callId: 'c-v1' }))
    assert.match(first.resource.ref, /@v1$/)
    chain.put('v.csv', utf8('lon,lat\n121.47,31.23\n'))
    chain.rig.call(session, 'c-v2', 'data_import', { path, name: 'series' })
    const second = await dataImport.execute({ path, name: 'series' }, chain.rig.exec(session, { callId: 'c-v2' }))
    assert.match(second.resource.ref, /@v2$/)
    assert.equal(second.resource.ref.replace(/@v2$/, ''), first.resource.ref.replace(/@v1$/, ''))
    assert.notEqual(second.resource.contentDigest, first.resource.contentDigest)
  } finally {
    await chain.dispose()
  }
})

test('a failing import leaves zero catalog residue', async () => {
  const chain = await chainRig('residue')
  try {
    const session = chain.rig.session('residue')
    const badZip = chain.put('broken.zip', utf8('this is not a zip at all'))
    chain.rig.call(session, 'c-bad', 'data_import', { path: badZip })
    await assert.rejects(
      dataImport.execute({ path: badZip }, chain.rig.exec(session, { callId: 'c-bad' })),
      /IMPORT_FORMAT_INVALID/,
    )
    const listing = await chain.catalog.searchResources({ search: {}, authorization: chain.catalog.deploymentDomain() })
    assert.equal(listing.resources.length, 0)
  } finally {
    await chain.dispose()
  }
})

test('retry_of returns the original publication; unknown seq refuses; authorization domain refuses', async () => {
  const chain = await chainRig('retry')
  try {
    const path = chain.put('r.csv', utf8(CSV))
    const session = chain.rig.session('retry')
    const firstCall = chain.rig.call(session, 'c-r1', 'data_import', { path, name: 'retry-series' })
    const first = await dataImport.execute({ path, name: 'retry-series' }, chain.rig.exec(session, { callId: 'c-r1' }))
    chain.rig.result(session, firstCall, { meta: first.meta })
    chain.put('r.csv', utf8('lon,lat,name,score\n0,0,changed,9\n'))
    const replayCall = chain.rig.call(session, 'c-r2', 'data_import', { retry_of: firstCall.seq })
    const replay = await dataImport.execute({ retry_of: firstCall.seq }, chain.rig.exec(session, { callId: 'c-r2' }))
    chain.rig.result(session, replayCall, { meta: replay.meta })
    assert.equal(replay.resource.ref, first.resource.ref)
    assert.equal(replay.resource.contentDigest, first.resource.contentDigest)
    assert.equal(replay.deduplicated, true)
    assert.equal(replay.retry_of, firstCall.seq)

    chain.rig.call(session, 'c-r3', 'data_import', { retry_of: 9999 })
    await assert.rejects(
      dataImport.execute({ retry_of: 9999 }, chain.rig.exec(session, { callId: 'c-r3' })),
      /CATALOG_OPERATION_NOT_PUBLISHED/,
    )

    chain.rig.call(session, 'c-r4', 'data_import', { path, authorization: 'not-this-deployment' })
    await assert.rejects(
      dataImport.execute({ path, authorization: 'not-this-deployment' }, chain.rig.exec(session, { callId: 'c-r4' })),
      /INVALID_ARGUMENT.*not this deployment's domain/,
    )
  } finally {
    await chain.dispose()
  }
})

test('a shapefile rides the same chain through its CRS confirmation', async () => {
  const chain = await chainRig('shp')
  try {
    const path = chain.put('layer.zip', shapefileZip({
      shapeType: SHAPE_TYPES.point,
      geometries: [[116.4, 39.9], [121.47, 31.23]],
      fields: [{ name: 'name', type: 'C', length: 8 }],
      rows: [['first'], ['second']],
    }))
    const session = chain.rig.session('shp')
    chain.rig.call(session, 'c-s1', 'data_import', { path, name: 'shp' })
    const gate = await dataImport.execute({ path, name: 'shp' }, chain.rig.exec(session, { callId: 'c-s1' }))
    assert.equal(gate.status, 'needs_confirmation')
    assert.equal(gate.admission.crs_candidates[0].crs, 'EPSG:4326')
    chain.rig.call(session, 'c-s2', 'data_import', { path, name: 'shp', crs: 'EPSG:4326' })
    const confirmed = await dataImport.execute({
      path,
      name: 'shp',
      crs: 'EPSG:4326',
      confirm: { fingerprint: gate.candidates_fingerprint },
    }, chain.rig.exec(session, { callId: 'c-s2' }))
    assert.equal(confirmed.status, 'succeeded')
    assert.equal(confirmed.import.format, 'shapefile')
    assert.equal(confirmed.resource.featureCount, 2)
    assert.equal(confirmed.resource.geometryTypes[0], 'Point')
  } finally {
    await chain.dispose()
  }
})

test('CSV-only parameters refuse on other formats; catalog_register keeps its verbatim-copy path', async () => {
  const chain = await chainRig('mutex')
  try {
    const session = chain.rig.session('mutex')
    const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'first' } }] }
    const geojsonPath = chain.put('p.geojson', utf8(JSON.stringify(geojson)))
    chain.rig.call(session, 'c-m1', 'data_import', { path: geojsonPath, encoding: 'gbk' })
    await assert.rejects(
      dataImport.execute({ path: geojsonPath, encoding: 'gbk' }, chain.rig.exec(session, { callId: 'c-m1' })),
      /INVALID_ARGUMENT: encoding and column parameters apply to CSV imports only/,
    )

    // The sibling catalog_register path is untouched by the import surface.
    const registerCall = chain.rig.call(session, 'c-reg', 'catalog_register', { path: geojsonPath, name: 'raw' })
    const registered = await catalogRegister.execute({ path: geojsonPath, name: 'raw' }, chain.rig.exec(session, { callId: 'c-reg' }))
    chain.rig.result(session, registerCall, { meta: registered.meta })
    assert.equal(registered.status, 'succeeded')
    assert.equal(registered.resource.featureCount, 1)
  } finally {
    await chain.dispose()
  }
})
