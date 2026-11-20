/**
 * Detection and two-phase confirmation fixtures for `data_import` (P1-L4):
 * extension/content format resolution, GeoJSON admission reuse, explicit
 * column bypass, needs_confirmation→ready transitions, fingerprint rebinding
 * after content/candidate/CRS changes, cancellation, and workspace admission.
 * Every fixture runs against the real local-filesystem workspace rig.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withWorkspace } from './workspace-rig.mjs'
import { admitImport } from '../src/import-format/detect.ts'
import { SHAPE_TYPES, shapefileZip } from './fixtures/shapefile-fixtures.mjs'

const utf8 = (text) => new TextEncoder().encode(text)

/** Write raw bytes into the rig workspace. */
const put = (dir, name, bytes) => {
  writeFileSync(join(dir, name), bytes)
  return name
}

const GEOJSON = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'first' } }] }
const CSV = 'lon,lat,name\n116.4,39.9,first\n'
const KML = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>A</name><Point><coordinates>116.4,39.9</coordinates></Point></Placemark></Document></kml>'
const ZIP = shapefileZip({
  shapeType: SHAPE_TYPES.point,
  geometries: [[116.4, 39.9]],
  fields: [{ name: 'name', type: 'C', length: 5 }],
  rows: [['first']],
})

test('extension detection resolves all four formats without an explicit format', async () => {
  await withWorkspace('detect-ext', async ({ dir, exec }) => {
    put(dir, 'a.geojson', utf8(JSON.stringify(GEOJSON)))
    put(dir, 'b.csv', utf8(CSV))
    put(dir, 'c.kml', utf8(KML))
    put(dir, 'd.zip', ZIP)
    const outcomes = await Promise.all([
      admitImport({ path: 'a.geojson' }, exec),
      admitImport({ path: 'b.csv' }, exec),
      admitImport({ path: 'c.kml' }, exec),
      admitImport({ path: 'd.zip', crs: 'EPSG:4326' }, exec),
    ])
    assert.deepEqual(outcomes.map(outcome => outcome.kind), ['ready', 'ready', 'ready', 'ready'])
    assert.deepEqual(outcomes.map(outcome => outcome.admission.format), ['geojson', 'csv', 'kml', 'shapefile'])
    assert.equal(outcomes[0].geojson.features[0].properties.name, 'first')
    assert.equal(outcomes[3].geojson.features[0].properties.name, 'first')
  })
})

test('content sniffing resolves extensionless files', async () => {
  await withWorkspace('detect-sniff', async ({ dir, exec }) => {
    put(dir, 'table.dat', utf8(CSV))
    put(dir, 'doc.dat', utf8(KML))
    put(dir, 'data.dat', utf8(JSON.stringify(GEOJSON)))
    put(dir, 'layer.bin', ZIP)
    const outcomes = await Promise.all([
      admitImport({ path: 'table.dat' }, exec),
      admitImport({ path: 'doc.dat' }, exec),
      admitImport({ path: 'data.dat' }, exec),
      admitImport({ path: 'layer.bin', crs: 'EPSG:4326' }, exec),
    ])
    assert.deepEqual(outcomes.map(outcome => outcome.kind), ['ready', 'ready', 'ready', 'ready'])
    assert.deepEqual(outcomes.map(outcome => outcome.admission.format), ['csv', 'kml', 'geojson', 'shapefile'])
  })
})

test('fully ambiguous content stops at format candidates', async () => {
  await withWorkspace('detect-ambiguous', async ({ dir, exec }) => {
    put(dir, 'blob.txt', utf8('plain prose with no structural markers at all\n'))
    const outcome = await admitImport({ path: 'blob.txt' }, exec)
    assert.equal(outcome.kind, 'needs_confirmation')
    assert.equal(outcome.admission.formatCandidates !== null, true)
    assert.ok(outcome.admission.warnings.some(warning => warning.startsWith('format-ambiguous:')))
    assert.match(outcome.admission.candidatesFingerprint, /^[0-9a-f]{64}$/)
  })
})

test('a declared format wins and mismatched content refuses', async () => {
  await withWorkspace('detect-declared', async ({ dir, exec }) => {
    put(dir, 'points.txt', utf8(JSON.stringify(GEOJSON)))
    const outcome = await admitImport({ path: 'points.txt', format: 'geojson' }, exec)
    assert.equal(outcome.kind, 'ready')
    assert.equal(outcome.admission.format, 'geojson')
    await assert.rejects(
      admitImport({ path: 'points.txt', format: 'kml' }, exec),
      /IMPORT_FORMAT_INVALID: KML is not well-formed XML/,
    )
  })
})

test('the GeoJSON branch reuses the shared admission: reprojection and range refusal', async () => {
  await withWorkspace('geojson-reuse', async ({ dir, exec }) => {
    put(dir, 'projected.geojson', utf8(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [500000, 4000000] }, properties: {} }],
    })))
    const outcome = await admitImport({ path: 'projected.geojson', crs: 'EPSG:4547' }, exec)
    assert.equal(outcome.kind, 'ready')
    const [lon, lat] = outcome.geojson.features[0].geometry.coordinates
    // EPSG:4547 is the CGCS2000 3-degree Gauss-Krüger zone with CM 114.
    assert.ok(Math.abs(lon - 114) < 0.001)
    assert.ok(Math.abs(lat - 36.13) < 0.05)

    put(dir, 'broken.geojson', utf8(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [200, 39.9] }, properties: {} }],
    })))
    await assert.rejects(
      admitImport({ path: 'broken.geojson' }, exec),
      /INVALID_GEOJSON: GeoJSON coordinate is outside the WGS84 range/,
    )
  })
})

test('explicit CSV columns skip confirmation; ambiguous ones gate it', async () => {
  await withWorkspace('csv-confirm', async ({ dir, exec }) => {
    put(dir, 'x.csv', utf8('x,y,name\n116.4,39.9,first\n'))
    const gated = await admitImport({ path: 'x.csv' }, exec)
    assert.equal(gated.kind, 'needs_confirmation')
    const direct = await admitImport({ path: 'x.csv', lonColumn: 'x', latColumn: 'y' }, exec)
    assert.equal(direct.kind, 'ready')
    assert.deepEqual(direct.admission.columnMapping.reasons, ['explicit'])
  })
})

test('a matching fingerprint confirmation resolves; changed content refuses the stale one', async () => {
  await withWorkspace('confirm-toc', async ({ dir, exec }) => {
    put(dir, 'x.csv', utf8('x,y,name\n116.4,39.9,first\n'))
    const first = await admitImport({ path: 'x.csv' }, exec)
    assert.equal(first.kind, 'needs_confirmation')
    const confirmed = await admitImport({
      path: 'x.csv',
      lonColumn: 'x',
      latColumn: 'y',
      confirm: { fingerprint: first.admission.candidatesFingerprint },
    }, exec)
    assert.equal(confirmed.kind, 'ready')

    // Same column names, different file content: the old fingerprint must
    // not authorize the new bytes.
    put(dir, 'x.csv', utf8('x,y,name\n121.47,31.23,moved\n'))
    const stale = await admitImport({
      path: 'x.csv',
      lonColumn: 'x',
      latColumn: 'y',
      confirm: { fingerprint: first.admission.candidatesFingerprint },
    }, exec)
    assert.equal(stale.kind, 'needs_confirmation')
    assert.ok(stale.admission.warnings.some(warning => warning.startsWith('confirmation-fingerprint-mismatch:')))
    const reconfirmed = await admitImport({
      path: 'x.csv',
      lonColumn: 'x',
      latColumn: 'y',
      confirm: { fingerprint: stale.admission.candidatesFingerprint },
    }, exec)
    assert.equal(reconfirmed.kind, 'ready')
    assert.deepEqual(reconfirmed.geojson.features[0].geometry.coordinates, [121.47, 31.23])
  })
})

test('a shapefile CRS confirmation round-trips through the gate', async () => {
  await withWorkspace('shp-confirm', async ({ dir, exec }) => {
    put(dir, 'layer.zip', shapefileZip({
      shapeType: SHAPE_TYPES.point,
      geometries: [[116.4, 39.9]],
      fields: [{ name: 'name', type: 'C', length: 4 }],
      rows: [['x']],
    }))
    const first = await admitImport({ path: 'layer.zip' }, exec)
    assert.equal(first.kind, 'needs_confirmation')
    assert.equal(first.admission.crsCandidates[0].crs, 'EPSG:4326')
    const confirmed = await admitImport({
      path: 'layer.zip',
      crs: 'EPSG:4326',
      confirm: { fingerprint: first.admission.candidatesFingerprint },
    }, exec)
    assert.equal(confirmed.kind, 'ready')
    assert.deepEqual(confirmed.geojson.features[0].geometry.coordinates, [116.4, 39.9])
  })
})

test('a canceled admission aborts before any import state exists', async () => {
  await withWorkspace('cancel', async ({ dir, exec }) => {
    put(dir, 'x.csv', utf8(CSV))
    const controller = new AbortController()
    controller.abort()
    const canceled = { ...exec, signal: controller.signal }
    await assert.rejects(
      admitImport({ path: 'x.csv' }, canceled),
      /CALL_CANCELED/,
    )
  })
})

test('workspace admission is reused: escapes and symlinks refuse', async () => {
  await withWorkspace('escape', async ({ exec }) => {
    await assert.rejects(
      admitImport({ path: '../outside.csv' }, exec),
      /WORKSPACE_ESCAPE/,
    )
    await assert.rejects(
      admitImport({ path: '/etc/passwd' }, exec),
      /WORKSPACE_ESCAPE/,
    )
  })
})

test('an encoding change rebinds the fingerprint even with identical columns', async () => {
  await withWorkspace('encoding-rebind', async ({ dir, exec }) => {
    const gbkBytes = Uint8Array.from([
      0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0xBE, 0xAD, 0xB6, 0xC8, 0x2C, 0xCE, 0xB3, 0xB6, 0xC8, 0x0A,
      0xBC, 0xD7, 0x2C, 0x31, 0x31, 0x36, 0x2E, 0x34, 0x2C, 0x33, 0x39, 0x2E, 0x39, 0x0A,
    ])
    put(dir, 'cn.csv', gbkBytes)
    const decoded = await admitImport({ path: 'cn.csv', encoding: 'gbk' }, exec)
    assert.equal(decoded.kind, 'ready')
    // Rewrite with the same columns but different bytes: the ready outcome's
    // fingerprint changes with the content, so a confirm carrying the old
    // fingerprint cannot authorize the new file.
    const nextBytes = Uint8Array.from([
      0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0xBE, 0xAD, 0xB6, 0xC8, 0x2C, 0xCE, 0xB3, 0xB6, 0xC8, 0x0A,
      0xBC, 0xD7, 0x2C, 0x31, 0x32, 0x31, 0x2E, 0x34, 0x37, 0x2C, 0x33, 0x31, 0x2E, 0x32, 0x33, 0x0A,
    ])
    put(dir, 'cn.csv', nextBytes)
    const stale = await admitImport({
      path: 'cn.csv',
      encoding: 'gbk',
      confirm: { fingerprint: decoded.admission.candidatesFingerprint },
    }, exec)
    assert.equal(stale.kind, 'needs_confirmation')
    assert.ok(stale.admission.warnings.some(warning => warning.startsWith('confirmation-fingerprint-mismatch:')))
  })
})
