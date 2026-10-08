/**
 * Cross-process replay through the built artifact: a fresh plain-Node child
 * mounts the BUILT `map-container` plugin (the face the Loader actually
 * loads) beside the real upstream SessionStore and projection registry,
 * replays a canonical event log, and reports the authoritative state. The
 * parent folds the same log through the source plane and pins BOTH outcomes
 * to a hand-written expected literal — the expected state is never computed
 * from either implementation, so a drift between source and artifact planes
 * or a silent fold change cannot pass. Includes the negative acceptance path:
 * an unknown-version meta must stay read-only through the built entry too.
 *
 * Requires upstream `pnpm run build` plus `node map/bin/build.mjs`; missing
 * artifacts fail loud with that instruction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createToolResultMessage } from '../../packages/llm/llm/lib/index.js'
import {
  layerDigestOf,
  buildMapChangeMeta,
} from '../map-container/src/protocol.ts'
import { mapContainerProjectionDefinition } from '../map-container/src/projection.ts'
import { withTrackedTmpDir } from './support/reliability.mjs'

const testsRoot = dirname(fileURLToPath(import.meta.url))
const mapRoot = resolve(testsRoot, '..')
const repoRoot = resolve(mapRoot, '..')

const builtEntries = {
  cordis: createRequire(join(mapRoot, 'map-container', 'package.json')).resolve('@deepseek-ai/cordis'),
  session: join(repoRoot, 'packages', 'core', 'session', 'lib', 'index.js'),
  projection: join(repoRoot, 'packages', 'session', 'session-projection', 'lib', 'index.js'),
  llm: join(repoRoot, 'packages', 'llm', 'llm', 'lib', 'index.js'),
  mapContainer: join(mapRoot, 'map-container', 'lib', 'index.js'),
}

function assertBuilt(path, label) {
  assert.ok(
    existsSync(path),
    `${label} is missing at ${path} — run \`pnpm run build\` then \`node map/bin/build.mjs\` first`,
  )
}

const pointCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'sample' } }],
}

const layerA = {
  id: 'a',
  name: 'a',
  data: pointCollection,
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
  sourceCallSeq: 0,
}

/** A P0b versioned layer: its identity fields must survive the built fold. */
const layerBuffer = {
  id: 'poi-buffer',
  name: 'poi-buffer',
  data: pointCollection,
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
  sourceCallSeq: 8,
  displayDigest: 'b'.repeat(64),
  artifactRef: 'art-1a2b-3c4d@v1',
  legend: { title: 'poi-buffer', symbol: { color: '#1f77b4', outline: '#14405e' } },
}

/**
 * The expected authoritative state, written by hand from the protocol
 * contract — including the v6 operation ledger the collaboration plane
 * reads (inverse + post-state per applied change).
 */
const opRecordA = {
  index: 1,
  operationId: null,
  undoOf: null,
  writerId: null,
  callId: 'c1',
  resultSeq: 1,
  revision: 1,
  summary: 'add-layer a (1 features)',
  inverse: { op: 'remove-layer', layerId: 'a' },
  post: { layers: [{ id: 'a', digest: layerDigestOf(layerA) }] },
}
const opRecordView = {
  index: 2,
  operationId: null,
  undoOf: null,
  writerId: null,
  callId: 'c2',
  resultSeq: 3,
  revision: 2,
  summary: 'set-view [117, 39] z8',
  inverse: { op: 'set-view', view: { center: [0, 0], zoom: 0, wkid: 4326 } },
  post: { view: { center: [117, 39], zoom: 8, wkid: 4547 } },
}
const expectedAfterAcceptedLog = {
  stateVersion: 8,
  layers: [layerA],
  view: { center: [117, 39], zoom: 8, wkid: 4547 },
  mode: 'map',
  aoi: null,
  revision: 2,
  lastCallId: 'c2',
  pendingCalls: [],
  diagnostics: [{ seq: 5, code: 'failed-result' }],
  operations: [opRecordA, opRecordView],
}

const expectedAfterUnknownVersion = {
  ...expectedAfterAcceptedLog,
  mode: 'map',
  diagnostics: [{ seq: 5, code: 'failed-result' }, { seq: 7, code: 'unknown-schema-version' }],
}

/** The unknown-version log plus one accepted v2 versioned add-layer. */
const expectedAfterVersionedLayer = {
  ...expectedAfterUnknownVersion,
  layers: [layerA, layerBuffer],
  revision: 3,
  lastCallId: 'c5',
  operations: [opRecordA, opRecordView, {
    index: 3,
    operationId: null,
    undoOf: null,
    writerId: null,
    callId: 'c5',
    resultSeq: 9,
    revision: 3,
    summary: 'add-layer poi-buffer (1 features)',
    inverse: { op: 'remove-layer', layerId: 'poi-buffer' },
    post: { layers: [{ id: 'poi-buffer', digest: layerDigestOf(layerBuffer) }] },
  }],
}

function resultMessage(callId, { isError = false } = {}) {
  return createToolResultMessage({
    callId,
    content: [{ type: 'text', text: isError ? 'Error: refused' : 'ok' }],
    isError,
  })
}

/** The canonical accepted log, then one unknown-version result appended by `extend`. */
function canonicalLog({ extend = false } = {}) {
  const events = [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'map_add_layer', arguments: '{"path":"a.geojson"}' } },
    {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: resultMessage('c1'), meta: buildMapChangeMeta(0, 0, { op: 'add-layer', layer: layerA }) },
      sourceEventSeqs: [0],
    },
    { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'map_set_view', arguments: '{"center":[117,39],"zoom":8}' } },
    {
      type: 'tool/result',
      data: { turn: 1, step: 2, message: resultMessage('c2'), meta: buildMapChangeMeta(2, 1, { op: 'set-view', view: { center: [117, 39], zoom: 8, wkid: 4547 } }) },
      sourceEventSeqs: [2],
    },
    { type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'map_set_mode', arguments: '{"mode":"scene"}' } },
    {
      type: 'tool/result',
      data: { turn: 1, step: 3, message: resultMessage('c3', { isError: true }), meta: buildMapChangeMeta(4, 2, { op: 'set-mode', mode: 'scene' }) },
      sourceEventSeqs: [4],
    },
  ]
  if (extend) {
    events.push(
      { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c4', name: 'map_set_mode', arguments: '{"mode":"scene"}' } },
      {
        type: 'tool/result',
        data: {
          turn: 2,
          step: 1,
          message: resultMessage('c4'),
          meta: { schemaVersion: 99, kind: 'map-change', sourceCallSeq: 6, targetRevision: 2, change: { op: 'set-mode', mode: 'scene' } },
        },
        sourceEventSeqs: [6],
      },
    )
  }
  return events
}

/** Fold one canonical log through the source plane, assigning seqs by position. */
function sourceFold(events) {
  let state = mapContainerProjectionDefinition.init({}, 0)
  events.forEach((event, seq) => {
    state = mapContainerProjectionDefinition.apply(state, { ...event, seq })
  })
  return JSON.parse(JSON.stringify(state))
}

const childScript = [
  'const [pathsJson, eventsPath] = process.argv.slice(2)',
  'const paths = JSON.parse(pathsJson)',
  'const { readFile } = await import("node:fs/promises")',
  'const { pathToFileURL } = await import("node:url")',
  'const [{ Context }, sessionModule, registryModule, llmModule, mapPlugin] = await Promise.all([',
  '  import(pathToFileURL(paths.cordis)),',
  '  import(pathToFileURL(paths.session)),',
  '  import(pathToFileURL(paths.projection)),',
  '  import(pathToFileURL(paths.llm)),',
  '  import(pathToFileURL(paths.mapContainer)),',
  '])',
  'const ctx = new Context()',
  'await ctx.plugin(sessionModule.default)',
  'await ctx.plugin(registryModule.default)',
  'await ctx.plugin(mapPlugin)',
  'const session = ctx.sessions.create(sessionModule.SessionId("built-replay"), {})',
  'const events = JSON.parse(await readFile(eventsPath, "utf8"))',
  'for (const event of events) {',
  '  const options = event.sourceEventSeqs === undefined ? {} : { surfaceOp: "append", sourceEventSeqs: event.sourceEventSeqs }',
  '  session.append(event.type, event.data, options)',
  '}',
  'const state = ctx.sessionProjections.stateOf(session, "mapContainer")',
  'await new Promise(resolve => process.stdout.write(JSON.stringify(state), resolve))',
  'await ctx.fiber.dispose()',
  'process.exit(0)',
].join('\n')

test('the canonical log folds to the hand-written state on the source plane', () => {
  assert.deepEqual(sourceFold(canonicalLog()), expectedAfterAcceptedLog)
  assert.deepEqual(sourceFold(canonicalLog({ extend: true })), expectedAfterUnknownVersion)
  // The versioned log's last state carries the catalog layer past the
  // unknown-version diagnostic — identity fields survive the source fold.
  assert.deepEqual(sourceFold(canonicalLogWithVersionedLayer()), expectedAfterVersionedLayer)
})

/** The unknown-version log plus the accepted v2 versioned add-layer. */
function canonicalLogWithVersionedLayer() {
  const events = canonicalLog({ extend: true })
  events.push(
    { type: 'tool/call', data: { turn: 2, step: 2, callId: 'c5', name: 'map_add_layer', arguments: '{"ref":"art-1a2b-3c4d@v1"}' } },
    {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 2,
        message: resultMessage('c5'),
        meta: buildMapChangeMeta(8, 2, { op: 'add-layer', layer: layerBuffer }),
      },
      sourceEventSeqs: [8],
    },
  )
  return events
}

test('a fresh process replays the same log through the built plugin to the same state', async () => {
  for (const [label, path] of Object.entries(builtEntries)) assertBuilt(path, label)
  await withTrackedTmpDir('built-replay', async cwd => {
    const eventsPath = join(cwd.path, 'events.json')
    writeFileSync(eventsPath, JSON.stringify(canonicalLogWithVersionedLayer()))
    const script = join(cwd.path, 'replay-child.mjs')
    writeFileSync(script, childScript)
    const child = spawnSync(
      process.execPath,
      [script, JSON.stringify(builtEntries), eventsPath],
      { encoding: 'utf8', cwd: cwd.path },
    )
    assert.equal(child.status, 0, `built replay child failed: ${child.stderr}`)
    assert.deepEqual(JSON.parse(child.stdout), expectedAfterVersionedLayer)
  })
})
