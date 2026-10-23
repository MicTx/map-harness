/**
 * Deterministic synthetic-data generator for the layer-workbench acceptance
 * fixtures. Every asset here is synthetic (no customer data, credentials, or
 * private paths); regeneration is byte-stable so committed digests stay
 * reproducible: `node generate.mjs` writes the assets, `node generate.mjs
 * --verify` regenerates twice into temporary directories and compares
 * digests, exiting nonzero on drift. The DBF date fields are pinned (unlike
 * `shapefile-fixtures.mjs`, which serves single-run tests) because these
 * files are committed and hashed.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShp, buildShx, SHAPE_TYPES, zipOf } from '../../../../tools/tests/fixtures/shapefile-fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

/** Pinned DBF write date (2026-10-19) so regeneration is byte-stable. */
const DBF_DATE = { year: 126, month: 10, day: 19 }

/**
 * DBF component builder with the header date pinned; mirrors
 * `shapefile-fixtures.mjs` `buildDbf` otherwise.
 * @param {object} options - `fields`, `rows`, `ldid`.
 * @returns {Buffer}
 */
function buildDatedDbf({ fields, rows, ldid = 0 }) {
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
  const headerLength = 32 + 32 * fields.length + 1
  const header = Buffer.alloc(headerLength)
  header.writeUInt8(0x03, 0)
  header.writeUInt8(DBF_DATE.year, 1)
  header.writeUInt8(DBF_DATE.month, 2)
  header.writeUInt8(DBF_DATE.day, 3)
  header.writeUInt32LE(rows.length, 4)
  header.writeUInt16LE(headerLength, 8)
  header.writeUInt16LE(recordLength, 10)
  header.writeUInt8(ldid, 29)
  fields.forEach((field, index) => {
    const at = 32 + index * 32
    const name = Buffer.from(field.name, 'latin1')
    name.copy(header, at, 0, Math.min(11, name.length))
    header.writeUInt8(field.type?.charCodeAt(0) ?? 0x43, at + 11)
    header.writeUInt8(field.length, at + 16)
    header.writeUInt8(field.decimal ?? 0, at + 17)
  })
  header.writeUInt8(0x0D, headerLength - 1)
  const body = Buffer.alloc(rows.length * recordLength + 1)
  rows.forEach((row, rowIndex) => {
    const base = rowIndex * recordLength
    body.writeUInt8(0x20, base)
    let cursor = base + 1
    row.forEach((value, fieldIndex) => {
      const field = fields[fieldIndex]
      const encoded = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), 'latin1')
      encoded.copy(body, cursor, 0, field.length)
      cursor += field.length
    })
  })
  body.writeUInt8(0x1A, rows.length * recordLength)
  return Buffer.concat([header, body])
}

/** Beijing-area hospital points: the ambiguous-CSV family's payload. */
const HOSPITAL_ROWS = [
  ['示例第一医院', 116.397, 39.908, 1200],
  ['示例第二医院', 116.406, 39.913, 800],
  ['示例第三医院', 116.388, 39.921, 350],
]

/** Ambiguous header: `x`/`y` are weak aliases, so import stops at needs_confirmation. */
const AMBIGUOUS_CSV = ['名称,x,y,床位数', ...HOSPITAL_ROWS.map(row => row.join(','))].join('\n') + '\n'

/** Resolved header: strong `lon`/`lat` aliases auto-select. */
const CONFIRMED_CSV = ['名称,lon,lat,床位数', ...HOSPITAL_ROWS.map(row => row.join(','))].join('\n') + '\n'

/** GBK-encoded header carrying strong Chinese aliases. */
function gbkHospitals() {
  const lines = ['名称,经度,纬度,床位数', ...HOSPITAL_ROWS.map(row => row.join(','))]
  return Buffer.from(gbkBytes(lines.join('\n') + '\n'))
}

/** GBK double-byte mappings for every CJK character the fixtures use. */
const GBK_TABLE = {
  '名': 0xC3FB, '称': 0xB3C6, '经': 0xBEAD, '度': 0xB6C8, '纬': 0xCEB3,
  '床': 0xB2B4, '位': 0xCEBB, '数': 0xCAFD, '第': 0xB5DA, '一': 0xD2BB,
  '二': 0xB6FE, '三': 0xC8FD, '医': 0xD2BD, '院': 0xD4BA, '示': 0xCABE,
  '例': 0xC0FD, '道': 0xB5C0, '路': 0xC2B7, '快': 0xBFEC, '速': 0xCBD9,
  '主': 0xD6F7, '干': 0xB8C9, '联': 0xC1AA, '络': 0xC2E7, '线': 0xCFDF,
}

/** PolyLine geometries near the hospital cluster. */
const ROAD_GEOMETRIES = [
  { parts: [[[116.38, 39.90], [116.40, 39.91], [116.42, 39.90]]] },
  { parts: [[[116.37, 39.92], [116.41, 39.93]]] },
]
const ROAD_FIELDS = [{ name: '名称', type: 'C', length: 24 }, { name: '等级', type: 'N', length: 4 }]
/** GBK-encoded attribute rows: a realistic Chinese shapefile carrying .cpg=GBK. */
const gbkBytes = (text) => {
  const bytes = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const gbk = GBK_TABLE[char]
    if (gbk === undefined) throw new Error(`no GBK mapping for U+${code.toString(16)} (${char})`)
    bytes.push((gbk >> 8) & 0xff, gbk & 0xff)
  }
  return Uint8Array.from(bytes)
}
const ROAD_ROWS = [[gbkBytes('示例主干道'), '1'], [gbkBytes('示例联络线'), '2']]
const DBF_LDIS_GBK = 0x7d

/** ESRI WKT for a plain WGS84 geographic CRS (from shapefile-fixtures.mjs). */
const WGS84_WKT = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'

/** 1×1 PNG matching the composition lane's fixture basemap tile. */
const TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')

/** Produce every fixture asset into one target directory. */
function writeAssets(dir) {
  writeFileSync(join(dir, 'hospitals.csv'), AMBIGUOUS_CSV, 'utf8')
  writeFileSync(join(dir, 'hospitals.confirmed.csv'), CONFIRMED_CSV, 'utf8')
  writeFileSync(join(dir, 'hospitals-gbk.csv'), gbkHospitals())
  const roads = buildShp(SHAPE_TYPES.polyline, ROAD_GEOMETRIES)
  writeFileSync(join(dir, 'roads.shp.zip'), zipOf([
    { name: 'roads.shp', data: roads.bytes },
    { name: 'roads.shx', data: buildShx(roads.recordOffsets) },
    { name: 'roads.dbf', data: buildDatedDbf({ fields: ROAD_FIELDS, rows: ROAD_ROWS, ldid: DBF_LDIS_GBK }) },
    { name: 'roads.prj', data: Buffer.from(WGS84_WKT, 'latin1') },
    { name: 'roads.cpg', data: Buffer.from('GBK', 'latin1') },
  ]))
  // The truncated negative: cut the last record's tail so the record walk
  // cannot reach the declared end — a stable `.shp record chain` refusal.
  const truncatedShp = roads.bytes.subarray(0, roads.bytes.length - 12)
  writeFileSync(join(dir, 'truncated.shp.zip'), zipOf([
    { name: 'roads.shp', data: truncatedShp },
    { name: 'roads.shx', data: buildShx(roads.recordOffsets) },
    { name: 'roads.dbf', data: buildDatedDbf({ fields: ROAD_FIELDS, rows: ROAD_ROWS, ldid: DBF_LDIS_GBK }) },
    { name: 'roads.prj', data: Buffer.from(WGS84_WKT, 'latin1') },
  ]))
  writeFileSync(join(dir, 'tile.png'), TILE_PNG)
  writeFileSync(join(dir, 'imagery-template.json'), JSON.stringify({
    template: 'https://tiles.layer-workbench.invalid/{z}/{y}/{x}',
    note: 'key-free template intercepted by the composition lane via page.route; never fetched for real',
  }, null, 2) + '\n')
}

/** The generated binary/text assets (hand-written files in this directory are excluded). */
const ASSET_NAMES = [
  'hospitals.csv',
  'hospitals.confirmed.csv',
  'hospitals-gbk.csv',
  'roads.shp.zip',
  'truncated.shp.zip',
  'tile.png',
  'imagery-template.json',
]

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Sorted asset name → sha256 digest map of one generated directory. */
function digestMap(dir) {
  const map = {}
  for (const name of ASSET_NAMES) {
    map[name] = digestOf(readFileSync(join(dir, name)))
  }
  return map
}

if (process.argv.includes('--verify')) {
  const runs = []
  for (let run = 0; run < 2; run += 1) {
    const dir = mkdtempSync(join(tmpdir(), `layer-workbench-fixture-verify-${run}-`))
    writeAssets(dir)
    runs.push({ dir, map: digestMap(dir) })
  }
  try {
    const first = JSON.stringify(runs[0].map, null, 2)
    const second = JSON.stringify(runs[1].map, null, 2)
    if (first !== second) {
      process.stderr.write(`fixture generation is not deterministic:\n${first}\nvs\n${second}\n`)
      process.exit(1)
    }
    const committed = digestMap(here)
    const drift = []
    for (const [name, digest] of Object.entries(runs[0].map)) {
      if (committed[name] !== digest) {
        drift.push(name)
      }
    }
    if (drift.length > 0) {
      process.stderr.write(`committed fixtures drifted from regeneration: ${drift.join(', ')}; run: node generate.mjs\n`)
      process.exit(1)
    }
    process.stdout.write(`fixture determinism verified: ${Object.keys(runs[0].map).length} assets byte-stable across two runs\n`)
  } finally {
    for (const run of runs) rmSync(run.dir, { recursive: true, force: true })
  }
} else {
  writeAssets(here)
  // The business-level spec keeps its ambiguous-CSV variant under the tools
  // fixtures dir (its own package's test assets); one canonical generator
  // keeps both copies in lockstep.
  writeFileSync(join(here, '..', '..', '..', '..', 'tools', 'tests', 'fixtures', 'layer-workbench-hospitals.csv'), AMBIGUOUS_CSV, 'utf8')
  process.stdout.write(`layer-workbench fixtures written to ${here}\n`)
}
