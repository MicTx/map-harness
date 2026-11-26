/**
 * Map release compilation keeps runtime interfaces and embeds program constants
 * without hiding implementation. Published source is the authority; these
 * helpers only prepare plain compiled modules for bundling.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inlineBrowserDefines, inlineEmbeddedPrograms, stagePreparedFiles } from '../bin/release-protection.mjs'
import { runtimeBytes } from '../bin/release-content.mjs'
import { mapBrowserDefines } from '../bin/browser-defines.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-release-compile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = 'map/example/lib/types/index.js'
  mkdirSync(dirname(join(root, file)), { recursive: true })
  return { root, file }
}

test('browser build constants resolve without a process global', async () => {
  const { runInNewContext } = await import('node:vm')
  const file = 'map/client-ui-brand/lib/types/client/edition-env.js'
  const input = Buffer.from('globalThis.edition = process.env.DSH_CLIENT_MAP_ORG_NAME; globalThis.mode = import.meta.env.MODE; globalThis.env = import.meta.env;')
  const prepared = inlineBrowserDefines(file, input, mapBrowserDefines({ DSH_CLIENT_MAP_ORG_NAME: 'Test edition' }))
  const context = {}
  runInNewContext(prepared.toString(), context)
  assert.equal(context.edition, 'Test edition')
  assert.equal(context.mode, 'production')
  assert.equal(context.env.MODE, 'production')
})

test('prepared compiler modules are written and restored byte-for-byte', t => {
  const { root, file } = fixture(t)
  const source = Buffer.from('export const value = 1;\n')
  const prepared = Buffer.from('export const value = 2;\n')
  writeFileSync(join(root, file), source)
  const restore = stagePreparedFiles(root, new Map([[file, prepared]]))
  assert.deepEqual(readFileSync(join(root, file)), prepared)
  restore()
  assert.deepEqual(readFileSync(join(root, file)), source)
})

test('embedded worker programs keep their source text and execute unchanged', async t => {
  const { root } = fixture(t)
  const program = 'module.exports = function firstPosition(row){ return row[0] }\n'
  const compiled = Buffer.from(`const WORKER_ENTRY_SOURCE=${JSON.stringify(program)}; export const entry=WORKER_ENTRY_SOURCE;`)
  const prepared = inlineEmbeddedPrograms('map/spatial-scale/lib/types/worker.js', compiled, { WORKER_ENTRY_SOURCE: program })
  writeFileSync(join(root, 'owner.mjs'), prepared)
  assert.match(prepared.toString(), /firstPosition/u)
  const exported = await import(new URL(`file://${join(root, 'owner.mjs')}`).href)
  assert.equal(exported.entry, program)
})

test('embedded SDK page keeps the runtime key placeholder and its script', t => {
  const { root } = fixture(t)
  const html = '<html><body><script>window.__sdkDrive = function(){ return "__TIANDITU_SDK_KEY__" }</script></body></html>'
  const compiled = Buffer.from(`export const TIANDITU_SDK_PAGE_HTML=${JSON.stringify(html)};`)
  const prepared = inlineEmbeddedPrograms('map/spatial-accessibility/lib/types/tianditu-sdk.js', compiled, { TIANDITU_SDK_PAGE_HTML: html })
  writeFileSync(join(root, 'owner.mjs'), prepared)
  const match = /TIANDITU_SDK_PAGE_HTML\s*=\s*("(?:[^"\\]|\\.)*")/u.exec(prepared.toString())
  assert.ok(match)
  assert.equal(JSON.parse(match[1]), html)
  assert.match(html, /__TIANDITU_SDK_KEY__/u)
})

test('ambiguous or missing embedded program declarations fail loudly', t => {
  const compiled = Buffer.from('export const OTHER = "x";')
  assert.throws(() => inlineEmbeddedPrograms('map/example/lib/types/x.js', compiled, { WORKER_ENTRY_SOURCE: 'p' }), /missing/u)
})

test('map runtime manifests retain runtime entrypoints and remove development exports', () => {
  const input = { name: '@map-harness/example', scripts: { build: 'tsc' }, types: 'lib/types/index.d.ts', exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './agent': './lib/agent.js', './src/*': './src/*', './lib/*': './lib/*', './package.json': './package.json' }, dependencies: { zod: '4.0.0' } }
  const actual = JSON.parse(runtimeBytes('map/example/package.json', Buffer.from(JSON.stringify(input))))
  assert.equal(actual.scripts, undefined)
  assert.equal(actual.types, undefined)
  assert.deepEqual(actual.exports, { '.': { default: './lib/index.js' }, './agent': './lib/agent.js', './package.json': './package.json' })
  assert.deepEqual(actual.dependencies, input.dependencies)
  assert.deepEqual(runtimeBytes('packages/core/example/package.json', Buffer.from(JSON.stringify(input))), Buffer.from(JSON.stringify(input)))
})
