/** Legacy import fixtures use real JSONL, content-addressed bytes, and owner-created SQLite stores. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { applyLegacyImport, IMPORT_PLAN_FORMAT, MapImportError, planLegacyImport, runImportCommand } from '../bin/instance-import.mjs'
import { prepareMapInstance, resolveMapInstance } from '../bin/instance-home.mjs'
import { migrateStore, openStoreDatabase, verifyStore } from '../spatial-storage/src/index.ts'
import { openScaleStore } from '../spatial-scale/src/store.ts'
import { parseScaleRef, SCALE_METHOD_VERSION } from '../spatial-scale/src/contract.ts'
import { SPATIAL_TOOL_CATALOG } from '../tools/src/spatial-catalog.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { trackedTmpDir } from './support/reliability.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const text = value => `${JSON.stringify(value)}\n`
const planBytes = value => Buffer.from(text(value))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lNMssAAAAABJRU5ErkJggg==', 'base64')
const toolsRequire = createRequire(import.meta.resolve('../tools/src/spatial-catalog.ts'))
const sharpEntry = toolsRequire.resolve('sharp')
const OWNER_CONTEXT = {
  dataCompatibility: { sessionFormat: 4, spatialStore: { min: 6, max: 6 }, accessibilityStore: { min: 1, max: 1 }, storageSqlite: 1, migration: 'none' },
  owners: {
    storage: await import('../spatial-storage/src/index.ts'),
    scale: { parseScaleRef, SCALE_METHOD_VERSION },
    toolNames: SPATIAL_TOOL_CATALOG.map(row => row.name),
    compatibility: { sessionFormat: 4, spatialStore: { min: 6, max: 6 }, accessibilityStore: { min: 1, max: 1 }, storageSqlite: 1, migration: 'none' },
    require: createRequire(pathToFileURL(sharpEntry)),
  },
}

function fixture(t) {
  const temporary = trackedTmpDir('legacy-import')
  t.after(() => temporary.dispose())
  const root = realpathSync(temporary.path)
  const from = join(root, '旧 快照')
  const to = join(root, '新 Map 实例')
  const user = join(root, 'user')
  for (const path of [from, user]) mkdirSync(path, { mode: 0o700 })
  const context = { homedir: user, env: {}, installRoots: [join(root, 'program')], ...OWNER_CONTEXT }
  return { root, from, to, user, context, options: { from, to, ...context } }
}
function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, path), bytes, { mode: 0o600 })
}
function generation(item, id, events = [], options = {}) {
  const version = options.version ?? 4
  const path = `sessions/_no-cwd/${id}/session${version ? `.v${version}` : ''}.jsonl${options.zstd ? '.zstd' : ''}`
  const header = { type: 'session', version, id, createdAt: 1000, isSeeded: false, delegationDepth: 0, ...options.header }
  const bytes = Buffer.from([header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n')
  put(item.from, path, options.zstd ? zstdCompressSync(bytes) : bytes)
  return path
}
function tool(name, args = {}) { return { type: 'tool/call', data: { callId: `call-${name}`, name, arguments: JSON.stringify(args) } } }
function result(meta) { return { type: 'tool/result', data: { meta } } }
function image(item, bytes = png) {
  const digest = hash(bytes)
  const path = `attachments/v1/objects/${digest.slice(0, 2)}/${digest}`
  put(item.from, path, bytes)
  return { path, ref: { attachmentId: `sha256:${digest}`, bytes: bytes.length, width: 1, height: 1, mediaType: 'image/png' } }
}
function file(item, name = '地图 数据.bin', bytes = Buffer.from([0, 255, 32, 13, 10, 129])) {
  const digest = hash(bytes)
  const paths = [`attachments/v1/file-objects/${digest.slice(0, 2)}/${digest}`, `attachments/v1/files/${digest.slice(0, 2)}/${digest}/${name}`]
  for (const path of paths) put(item.from, path, bytes)
  return { paths, ref: { attachmentId: `sha256:${digest}`, bytes: bytes.length, name } }
}
function attachment(ref, type = 'image') { return { type: 'user/message', data: { content: [{ type, attachment: ref }] } } }
function inventory(root) {
  if (!existsSync(root)) return null
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const child = path ? `${path}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) return [[child, 'link']]
    if (entry.isDirectory()) return [[child, 'directory'], ...walk(child)]
    return [[child, hash(readFileSync(join(root, child))), statSync(join(root, child)).mode & 0o777]]
  })
  return walk('')
}
function failure(code) {
  return error => {
    assert.ok(error instanceof MapImportError, error.stack)
    assert.equal(error.code, code, JSON.stringify(error.details))
    assert.equal(error.details.operation, 'import')
    return true
  }
}
function resource(item, id = 'map', parent) {
  const root = join(item.from, 'spatial-store/sessions', id)
  migrateStore(root)
  const db = openStoreDatabase(join(root, 'store.db'))
  const bytes = Buffer.from('{"type":"FeatureCollection","features":[]}')
  const path = 'files/resources/terrain.json'
  put(root, path, bytes)
  db.prepare('INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at, logical_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('res-terrain-v1', 1, 'available', path, hash(bytes), bytes.length, 'schema', '2026-01-01T00:00:00Z', 'res-terrain')
  db.prepare('INSERT INTO session_refs (session_id, parent_session_id) VALUES (?, ?)').run(id, parent ?? null)
  db.prepare('INSERT INTO map_refs (session_id, layer_id, target_kind, target_id) VALUES (?, ?, ?, ?)').run(id, 'layer', 'resource', 'res-terrain-v1')
  db.close()
  return { root, path: `spatial-store/sessions/${id}/${path}`, bytes }
}
function accessStore(item, runs) {
  const path = 'accessibility-store/accessibility-runs.db'
  mkdirSync(dirname(join(item.from, path)), { recursive: true })
  const db = new DatabaseSync(join(item.from, path))
  db.exec(`PRAGMA user_version = 1;
    CREATE TABLE accessibility_runs (run_id TEXT PRIMARY KEY, operation_ref TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL, goal_revision INTEGER NOT NULL, spec_json TEXT NOT NULL, status TEXT NOT NULL,
      result_json TEXT, diagnostics_json TEXT NOT NULL, worker_epoch INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE accessibility_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  for (const run of runs) db.prepare('INSERT INTO accessibility_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(run.id, run.operation, 'digest', 1, JSON.stringify(run.spec ?? {}), run.status ?? 'succeeded', JSON.stringify(run.result ?? {}), '[]', 1, '2026-01-01', '2026-01-01')
  db.prepare('INSERT INTO accessibility_meta VALUES (?, ?)').run('epoch', '1')
  db.close()
  return path
}
async function ready(item, sessions = ['map'], extra = {}) {
  return planLegacyImport({ ...item.options, sessions, snapshot: 'backup', ...extra })
}

test('default discovery uses all candidate evidence without auto-selecting unmarked or other-preset sessions', async t => {
  const item = fixture(t)
  generation(item, 'analyst', [], { header: { agentPreset: 'map-analyst' } })
  generation(item, 'event', [result({ kind: 'map-change', schemaVersion: 8, change: { op: 'set-mode', mode: 'map' } })])
  generation(item, 'tool', [tool('catalog_resolve')], { header: { agentPreset: 'general' } })
  generation(item, 'spatial')
  resource(item, 'spatial')
  generation(item, 'plain', [{ type: 'session/title', data: { title: 'Map analyst map_add_layer' } }])
  const before = inventory(item.root)
  const plan = await planLegacyImport(item.options)
  assert.equal(plan.format, IMPORT_PLAN_FORMAT)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.status, 'needs-selection', JSON.stringify(plan.unresolved))
  assert.deepEqual(plan.selection, [])
  assert.deepEqual(plan.files, [])
  assert.deepEqual(plan.candidates.filter(candidate => candidate.classification === 'map-candidate').map(candidate => candidate.id), ['analyst', 'event', 'spatial', 'tool'])
  assert.equal(plan.candidates.find(candidate => candidate.id === 'plain').classification, 'needs-selection')
  assert.deepEqual(inventory(item.root), before)
  assert.equal(existsSync(item.to), false)
})

test('dry-run is read-only even with SQLite stores and explicitly excludes stock state', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  resource(item)
  for (const path of ['.env', '.credentials.yaml', 'settings.yaml', 'storages/schedule.json', 'storages/goals.json',
    'cache/attachments/file', 'logs/private.log', 'agents/skills/secret', 'skills/private/SKILL.md', 'profiles/map-web/cordis.patch.yml']) put(item.from, path, 'sensitive-sentinel\n')
  const before = inventory(item.root)
  const plan = await ready(item)
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved))
  assert.ok(plan.files.every(file => file.path.startsWith('sessions/') || file.path.startsWith('spatial-store/sessions/map/')))
  assert.ok(!JSON.stringify(plan).includes('sensitive-sentinel'))
  assert.equal(plan.byteBudget.copyBytes, plan.files.reduce((total, file) => total + file.bytes, 0))
  assert.deepEqual(inventory(item.root), before)
})

test('parent, fork and subagent references require an explicit complete selection', async t => {
  const item = fixture(t)
  generation(item, 'parent', [tool('map_get_state'), { type: 'subagent/catalog', data: { version: 0, mode: 'continuable', childId: 'child', childCreatedAt: 1001 } }])
  generation(item, 'child', [], { header: { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 } })
  generation(item, 'fork', [], { header: { parentSession: 'parent', isSeeded: true } })
  generation(item, 'stock', [])
  const incomplete = await ready(item, ['parent'])
  assert.equal(incomplete.status, 'blocked')
  assert.deepEqual(incomplete.unresolved.filter(issue => issue.code === 'related-session-needs-selection').map(issue => issue.sessionId).sort(), ['child', 'fork'])
  await assert.rejects(applyLegacyImport({ ...item.context, plan: incomplete }), failure('MAP_IMPORT_INCOMPLETE'))
  assert.equal(existsSync(item.to), false)
  const complete = await ready(item, ['parent', 'child', 'fork'])
  assert.equal(complete.status, 'ready', JSON.stringify(complete.unresolved))
  assert.ok(complete.dependencies.some(edge => edge.kind === 'fork'))
  assert.ok(complete.files.every(file => !file.path.includes('/stock/')))
})

test('a missing attachment in any historical generation stops the entire selected closure', async t => {
  const item = fixture(t)
  const missing = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 1, height: 1, bytes: 42 }
  generation(item, 'map', [attachment(missing), tool('map_get_state')], { version: 3 })
  generation(item, 'map', [tool('map_get_state')])
  const before = inventory(item.root)
  const plan = await ready(item)
  assert.equal(plan.status, 'blocked')
  assert.ok(plan.unresolved.some(issue => issue.code === 'MAP_IMPORT_MISSING'))
  assert.equal(plan.files.filter(file => file.kind === 'session-generation').length, 2)
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_INCOMPLETE'))
  assert.deepEqual(inventory(item.root), before)
})

test('apply preserves every JSONL generation, attachment bytes, owner-verified resources and the complete source', async t => {
  const item = fixture(t)
  const img = image(item)
  const doc = file(item)
  const store = resource(item)
  const histories = [generation(item, 'map', [tool('map_get_state'), attachment(img.ref)], { version: 3 }),
    generation(item, 'map', [tool('map_add_layer', { ref: 'res-terrain@v1' }), attachment(doc.ref, 'file')])]
  generation(item, 'stock', [{ type: 'user/message', data: { content: [{ type: 'text', text: 'unrelated private text' }] } }])
  const unused = image(item, Buffer.from('not-referenced'))
  for (const path of ['.env', '.credentials.yaml', 'storages/settings.json', 'storages/schedule.json', 'logs/x', 'cache/y', 'identity.json']) put(item.from, path, 'do-not-import\n')
  const sourceBefore = inventory(item.from)
  const plan = await ready(item)
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved))
  const receipt = await applyLegacyImport({ ...item.context, plan })
  assert.equal(receipt.state, 'committed')
  assert.deepEqual(inventory(item.from), sourceBefore)
  for (const path of [...histories, img.path, ...doc.paths, store.path]) {
    assert.deepEqual(readFileSync(join(item.to, path)), readFileSync(join(item.from, path)), path)
    const source = statSync(join(item.from, path)), target = statSync(join(item.to, path))
    if (source.dev === target.dev) assert.notEqual(source.ino, target.ino, 'copied files do not share source hardlinks')
  }
  assert.equal(existsSync(join(item.to, unused.path)), false)
  assert.equal(existsSync(join(item.to, 'sessions/_no-cwd/stock')), false)
  for (const path of ['.env', '.credentials.yaml', 'storages', 'logs', 'identity.json']) assert.equal(existsSync(join(item.to, path)), false, path)
  const profile = JSON.parse(readFileSync(join(item.to, 'profiles/map-web/package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@map-harness/map-web'])
  assert.match(readFileSync(join(item.to, 'profiles/map-web/cordis.patch.yml'), 'utf8'), /compression: none/u)
  const verification = verifyStore(join(item.to, 'spatial-store/sessions/map'))
  assert.equal(verification.store, 'ok')
  assert.equal(verification.summary.unavailable, 0)
  assert.deepEqual(receipt.stores, [{ sessionId: 'map', database: 'restored', resources: 1, integrity: 'ok' }])
  const instance = prepareMapInstance(resolveMapInstance({ ...item.context, env: { MAPHARNESS_HOME: item.to } }))
  assert.equal(instance.instanceId, receipt.instanceId)
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_INCOMPLETE'))
})

test('zstd generations are scanned and copied without converting their encoding', async t => {
  const item = fixture(t)
  const paths = [generation(item, 'map', [tool('map_get_state')], { version: 3, zstd: true }), generation(item, 'map', [tool('map_get_state')], { zstd: true })]
  const plan = await ready(item)
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved))
  await applyLegacyImport({ ...item.context, plan })
  assert.equal(readFileSync(join(item.to, 'profiles/map-web/cordis.patch.yml'), 'utf8'), '[]\n')
  for (const path of paths) assert.deepEqual(readFileSync(join(item.to, path)), readFileSync(join(item.from, path)))
})

test('target conflicts and edited or stale snapshot plans never create an output instance', async t => {
  const item = fixture(t)
  const path = generation(item, 'map', [tool('map_get_state')])
  const plan = await ready(item)
  put(item.to, 'unowned', 'retain me')
  const collision = await ready(item)
  assert.deepEqual(collision.conflicts, [{ code: 'target-not-empty' }])
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_INCOMPLETE'))
  assert.equal(readFileSync(join(item.to, 'unowned'), 'utf8'), 'retain me')
  rmSync(item.to, { recursive: true })
  const edited = structuredClone(plan)
  edited.files[0].path = '.credentials.yaml'
  await assert.rejects(applyLegacyImport({ ...item.context, plan: edited }), failure('MAP_IMPORT_PLAN'))
  writeFileSync(join(item.from, path), `${readFileSync(join(item.from, path), 'utf8')}${text({ type: 'session/title', data: { title: 'changed' } })}`)
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_SOURCE_CHANGED'))
  assert.equal(existsSync(item.to), false)
})

test('an explicit source snapshot declaration is required before apply and SQLite sidecars stay unresolved', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  resource(item)
  const unconfirmed = await planLegacyImport({ ...item.options, sessions: ['map'] })
  assert.ok(unconfirmed.unresolved.some(issue => issue.code === 'source-snapshot-unconfirmed'))
  await assert.rejects(applyLegacyImport({ ...item.context, plan: unconfirmed }), failure('MAP_IMPORT_INCOMPLETE'))
  put(item.from, 'spatial-store/sessions/map/store.db-wal', Buffer.alloc(0))
  const active = await ready(item)
  assert.equal(active.status, 'blocked')
  assert.ok(active.unresolved.some(issue => issue.code === 'inconsistent-sqlite-snapshot'))
  assert.equal(existsSync(item.to), false)
})

test('unknown generations and future Map metadata stay unresolved rather than selecting a supported predecessor', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')], { version: 3 })
  generation(item, 'map', [result({ kind: 'map-change', schemaVersion: 999 })], { version: 99 })
  const plan = await ready(item)
  assert.equal(plan.status, 'blocked')
  assert.ok(plan.unresolved.some(issue => issue.code === 'unsupported-session-generation'))
  assert.equal(plan.files.filter(file => file.kind === 'session-generation').length, 2)
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_INCOMPLETE'))
})

test('read-only SQLite scanning parks mixed ownership without copying the accessibility database', async t => {
  const item = fixture(t)
  generation(item, 'map', [result({ kind: 'accessibility-run', schemaVersion: 1, runId: 'run-selected', operationRef: 'op-selected' })])
  accessStore(item, [{ id: 'run-selected', operation: 'op-selected' }, { id: 'run-foreign', operation: 'op-foreign' }])
  const before = inventory(item.root)
  const plan = await ready(item)
  assert.equal(plan.status, 'blocked')
  assert.ok(plan.unresolved.some(issue => issue.code === 'mixed-accessibility-ownership'))
  assert.ok(!plan.files.some(file => file.kind === 'accessibility-database'))
  assert.deepEqual(inventory(item.root), before)
})

test('fully identified terminal accessibility runs preserve their resource closure and bytes', async t => {
  const item = fixture(t)
  resource(item)
  generation(item, 'map', [result({ kind: 'accessibility-run', schemaVersion: 1, runId: 'run-selected', operationRef: 'op-selected' })])
  const path = accessStore(item, [{ id: 'run-selected', operation: 'op-selected', spec: { sourceRef: 'res-terrain@v1' } }])
  const before = inventory(item.from)
  const plan = await ready(item)
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved))
  assert.deepEqual(plan.accessibilityStore.runIds, ['run-selected'])
  await applyLegacyImport({ ...item.context, plan })
  assert.deepEqual(readFileSync(join(item.to, path)), readFileSync(join(item.from, path)))
  assert.deepEqual(inventory(item.from), before)
})

test('scale manifests and every content-digested chunk are copied only for referenced versions', async t => {
  const item = fixture(t)
  const store = resource(item)
  const scale = openScaleStore(join(store.root, 'scale'))
  const version = scale.ingest({ resourceId: 'terrain', sourceRef: 'res-terrain@v1', sourceDigest: hash(store.bytes), nativeCrs: 'EPSG:4326',
    authorization: 'fixture', chunkRows: 1, features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { value: 1 } }] })
  scale.ingest({ resourceId: 'unused', sourceRef: 'res-terrain@v1', sourceDigest: hash(store.bytes), nativeCrs: 'EPSG:4326',
    authorization: 'fixture', chunkRows: 1, features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { value: 2 } }] })
  generation(item, 'map', [tool('scale_read', { ref: version.ref })])
  const plan = await ready(item)
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved))
  const scaleFiles = plan.files.filter(file => file.kind.startsWith('scale-'))
  assert.equal(scaleFiles.length, 2)
  assert.ok(scaleFiles.every(file => !file.path.includes('/unused/')))
  await applyLegacyImport({ ...item.context, plan })
  for (const file of scaleFiles) assert.deepEqual(readFileSync(join(item.to, file.path)), readFileSync(join(item.from, file.path)))
})

test('cancelled copies retain owned staging and a same-plan retry verifies and finishes', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  const plan = await ready(item)
  const before = inventory(item.from)
  const controller = new AbortController()
  let copied = 0
  await assert.rejects(applyLegacyImport({ ...item.context, plan, signal: controller.signal, onProgress: ({ phase }) => {
    if (phase === 'copy' && ++copied === 1) controller.abort()
  } }), failure('MAP_IMPORT_CANCELLED'))
  assert.equal(existsSync(item.to), false)
  assert.deepEqual(inventory(item.from), before)
  const result = await applyLegacyImport({ ...item.context, plan })
  assert.equal(result.state, 'committed')
  assert.deepEqual(inventory(item.from), before)
})

test('link-shaped sources and traversal references never read outside the source snapshot', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  const ref = file(item)
  generation(item, 'map', [tool('map_get_state'), attachment(ref.ref, 'file')])
  const outside = join(item.root, 'outside')
  put(item.root, 'outside/sentinel', 'not an attachment')
  unlinkSync(join(item.from, ref.paths[0]))
  symlinkSync(join(outside, 'sentinel'), join(item.from, ref.paths[0]))
  const plan = await ready(item)
  assert.equal(plan.status, 'blocked')
  assert.ok(plan.unresolved.some(issue => issue.code === 'MAP_IMPORT_PATH'))
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'not an attachment')
  const malformed = { ...ref.ref, name: '../.env' }
  generation(item, 'map', [tool('map_get_state'), attachment(malformed, 'file')])
  const traversal = await ready(item)
  assert.ok(traversal.unresolved.some(issue => issue.code === 'unsupported-attachment-metadata'))
})

test('explicit byte budgets and mixed encodings block before target creation', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  const byteLimited = await ready(item, ['map'], { maxBytes: 1 })
  assert.equal(byteLimited.status, 'blocked')
  assert.ok(byteLimited.unresolved.some(issue => issue.code === 'MAP_IMPORT_BUDGET'))
  assert.equal(byteLimited.byteBudget.copyBytes, 0)
  generation(item, 'map', [tool('map_get_state')], { version: 3, zstd: true })
  const mixed = await ready(item)
  assert.ok(mixed.unresolved.some(issue => issue.code === 'mixed-session-encodings'))
  assert.equal(existsSync(item.to), false)
})

test('the import CLI requires --from, returns JSON plans and applies only --plan inputs', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  await assert.rejects(runImportCommand(['--to', item.to], item.context), failure('MAP_IMPORT_INPUT'))
  const plan = await runImportCommand(['--from', item.from, '--to', item.to, '--session', 'map', '--snapshot=backup', '--json'], item.context)
  assert.equal(plan.status, 'ready')
  const path = join(item.root, 'plan.json')
  writeFileSync(path, planBytes(plan))
  await assert.rejects(runImportCommand(['--apply', '--plan', path, '--from', item.from], item.context), failure('MAP_IMPORT_INPUT'))
  const applied = await runImportCommand(['--apply', '--plan', path], item.context)
  assert.equal(applied.state, 'committed')
})

test('without injected owners the import command refuses to guess a host or checkout', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  await assert.rejects(planLegacyImport({ from: item.from, to: item.to, sessions: [], snapshot: 'backup', homedir: item.user, env: {} }), failure('MAP_IMPORT_BUILD'))
  await assert.rejects(runImportCommand(['--from', item.from, '--to', item.to], { homedir: item.user, env: {} }), failure('MAP_IMPORT_BUILD'))
  const partial = { ...item.context, owners: { ...OWNER_CONTEXT.owners, storage: { verifyStore: OWNER_CONTEXT.owners.storage.verifyStore } } }
  await assert.rejects(planLegacyImport({ ...item.options, ...partial, sessions: [] }), failure('MAP_IMPORT_BUILD'))
  assert.equal(existsSync(item.to), false)
})

test('an explicitly held legacy session write lock blocks the selection as an active source', async t => {
  const item = fixture(t)
  const path = generation(item, 'map', [tool('map_get_state')])
  const lockPath = join(item.from, dirname(path), 'session.lock')
  let release
  if (process.platform === 'win32') {
    const koffi = (await import('koffi')).default
    const library = koffi.load('kernel32.dll')
    const create = library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16'])
    const wait = library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint'])
    const unlock = library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*'])
    const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
    const handle = create(null, 1, 1, `Local\\dsh-session-lock-${hash(lockPath.toLowerCase())}`)
    assert.notEqual(handle, 0)
    release = async () => { unlock(handle, 1, null); close(handle); library.unload() }
    assert.equal(wait(handle, 0), 0)
  } else {
    writeFileSync(lockPath, '', { mode: 0o600 })
    const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
    const { open } = await import('node:fs/promises')
    const handle = await open(lockPath, 'r')
    release = () => handle.close()
    await tryLockExclusive(handle.fd)
  }
  try {
    const before = inventory(item.from)
    const plan = await planLegacyImport({ ...item.options, sessions: ['map'], snapshot: 'backup' })
    assert.equal(plan.status, 'blocked')
    assert.ok(plan.unresolved.some(issue => issue.code === 'active-source-session'))
    await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_INCOMPLETE'))
    assert.deepEqual(inventory(item.from), before)
  } finally { await release() }
  assert.equal(existsSync(item.to), false)
})

test('a cancellation after spatial restore resumes verified bytes without creating another backup', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  resource(item)
  const plan = await ready(item)
  const controller = new AbortController()
  await assert.rejects(applyLegacyImport({ ...item.context, plan, signal: controller.signal,
    onProgress: ({ phase }) => { if (phase === 'verified') controller.abort() },
  }), failure('MAP_IMPORT_CANCELLED'))
  assert.equal(existsSync(item.to), false)
  const stage = join(item.root, `.map-import-${plan.operationId}`)
  const backups = join(stage, 'input/spatial-store/sessions/map/backups')
  const before = inventory(backups)
  const result = await applyLegacyImport({ ...item.context, plan })
  assert.equal(result.state, 'committed')
  assert.deepEqual(inventory(backups), before)
  assert.equal(verifyStore(join(item.to, 'spatial-store/sessions/map')).summary.unavailable, 0)
})

test('source mutation at the final staging checkpoint fails the fingerprint check before publication', async t => {
  const item = fixture(t)
  const path = generation(item, 'map', [tool('map_get_state')])
  const plan = await ready(item)
  await assert.rejects(applyLegacyImport({ ...item.context, plan, onProgress: ({ phase }) => {
    if (phase === 'verified') writeFileSync(join(item.from, path), `${readFileSync(join(item.from, path), 'utf8')}${text({ type: 'session/title', data: { title: 'new' } })}`)
  } }), failure('MAP_IMPORT_SOURCE_CHANGED'))
  assert.equal(existsSync(item.to), false)
})

test('same-target imports serialize at an atomic reservation while independent targets proceed', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  const plan = await ready(item)
  let allow, reached
  const barrier = new Promise(resolve => { allow = resolve })
  const entered = new Promise(resolve => { reached = resolve })
  const first = applyLegacyImport({ ...item.context, plan, onProgress: async ({ phase }) => {
    if (phase === 'copy') { reached(); await barrier }
  } })
  try {
    await entered
    await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_OPERATION_UNKNOWN'))
    const independent = await ready(item, ['map'], { to: join(item.root, 'independent') })
    assert.equal((await applyLegacyImport({ ...item.context, plan: independent })).state, 'committed')
  } finally { allow() }
  assert.equal((await first).state, 'committed')
})

test('unknown attachment formats and forged image metadata are unresolved rather than skipped', async t => {
  const item = fixture(t)
  const img = image(item)
  generation(item, 'map', [tool('map_get_state'), attachment({ ...img.ref, width: 5 })])
  const mismatch = await ready(item)
  assert.ok(mismatch.unresolved.some(issue => issue.code === 'attachment-metadata-mismatch'))
  generation(item, 'map', [tool('map_get_state'), { type: 'user/message', data: { content: [{ type: 'image', attachment: { url: 'file:///outside' } }] } }])
  const unsupported = await ready(item)
  assert.ok(unsupported.unresolved.some(issue => issue.code === 'unsupported-attachment-reference'))
  assert.equal(existsSync(item.to), false)
})

test('only a matching unfinished publication is reusable and tampered bytes remain untouched', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  mkdirSync(item.to)
  const plan = await ready(item)
  await applyLegacyImport({ ...item.context, plan })
  const receiptPath = join(item.to, 'map-maintenance/import-receipt.json')
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  writeFileSync(receiptPath, text({ ...receipt, state: 'publishing' }))
  assert.equal((await applyLegacyImport({ ...item.context, plan })).state, 'committed')
  writeFileSync(receiptPath, text({ ...receipt, state: 'publishing' }))
  const log = join(item.to, plan.files.find(file => file.kind === 'session-generation').path)
  writeFileSync(log, 'tampered target bytes')
  await assert.rejects(applyLegacyImport({ ...item.context, plan }), failure('MAP_IMPORT_CONFLICT'))
  assert.equal(readFileSync(log, 'utf8'), 'tampered target bytes')
})

test('the import command reports plan JSON for dispatcher rendering without side effects', async t => {
  const item = fixture(t)
  generation(item, 'map', [tool('map_get_state')])
  const before = inventory(item.root)
  const plan = await runImportCommand(['--from', item.from, '--to', item.to, '--json'], item.context)
  assert.equal(plan.format, IMPORT_PLAN_FORMAT)
  assert.equal(plan.status, 'needs-selection')
  assert.deepEqual(inventory(item.root), before)
  assert.equal(existsSync(item.to), false)
})
