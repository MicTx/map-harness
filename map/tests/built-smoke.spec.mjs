/**
 * Built-artifact smoke for the map layer: loads every runtime entry the
 * wrapper links under plain Node (never tsx), proving the shipped plugin
 * contract survives bundling — named exports only, no default that would
 * silently drop them at Loader time — and checks the browser halves keep the
 * closure-factory banner the Web module loader requires. Also gates generated
 * declaration JSDoc, the map layer's stand-in for the upstream
 * verify-export-jsdoc gate (which scans only upstream package sources).
 *
 * Requires `node map/bin/build.mjs` (and upstream `pnpm run build`) first;
 * on a clean checkout this spec fails loud with that instruction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Node-plane plugin entries the wrapper's MAP_BUILD_ARTIFACTS links. */
const nodeEntries = [
  ['@map-harness/map-container', 'map-container/lib/index.js'],
  ['@map-harness/map-tools', 'tools/lib/index.js'],
  ['@map-harness/map-tools/mcp', 'tools/lib/mcp.js'],
  ['@map-harness/arcgis-mcp', 'arcgis-mcp/lib/index.js'],
  ['@map-harness/client-ui-brand', 'client-ui-brand/lib/index.js'],
  ['@map-harness/spatial-context', 'spatial-context/lib/index.js'],
  ['@map-harness/spatial-context/agent', 'spatial-context/lib/agent.js'],
]

/** Browser-plane closure artifacts consumed by the Web module loader. */
const clientEntries = [
  ['@map-harness/map-container', 'map-container/lib/client.js'],
  ['@map-harness/client-ui-brand', 'client-ui-brand/lib/client.js'],
]

function assertBuilt(path) {
  assert.ok(
    existsSync(join(mapRoot, path)),
    `${path} is missing — run \`pnpm run build\` then \`node map/bin/build.mjs\` at the repository root first`,
  )
}

test('every built Node entry loads under plain Node with named plugin exports', async () => {
  // client-ui-brand's host half is a browser-only stub: it carries just the
  // empty apply that keeps the Loader row alive; name/inject live on the row.
  const hostStubs = new Set(['@map-harness/client-ui-brand'])
  for (const [id, path] of nodeEntries) {
    assertBuilt(path)
    const namespace = await import(join(mapRoot, path))
    assert.equal('default' in namespace, false, `${id} must not grow a default export (Loader would mount it instead of the named plugin face)`)
    assert.equal(typeof namespace.apply, 'function', `${id} must export apply()`)
    if (hostStubs.has(id)) continue
    assert.equal(typeof namespace.name, 'string', `${id} must export its plugin name`)
    assert.ok(Array.isArray(namespace.inject), `${id} must export its inject array`)
    assert.equal(namespace.name, id, `${id} name export must equal the package id`)
  }
})

test('browser halves stay closure-factory artifacts for the Web module loader', () => {
  for (const [id, path] of clientEntries) {
    assertBuilt(path)
    const text = readFileSync(join(mapRoot, path), 'utf8')
    const idPattern = JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(
      text,
      new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{\\s*id: ${idPattern}`),
      `${id} client artifact must open with its loader registration`,
    )
    assert.match(text, /factory: \(require\) =>/, `${id} client artifact must keep the closure factory`)
  }
})

test('generated declarations document every map-layer export', () => {
  const typeRoots = [
    'map-container/lib/types',
    'tools/lib/types',
    'arcgis-mcp/lib/types',
    'client-ui-brand/lib/types',
    'spatial-context/lib/types',
    'spatial-perf/lib/types',
  ]
  const missing = []
  for (const root of typeRoots) {
    const abs = join(mapRoot, root)
    assert.ok(existsSync(abs), `${root} is missing — run \`node map/bin/build.mjs\` first`)
    for (const file of walkDeclarations(abs)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!/^export (declare )?(function|const|class|interface|type|enum)\b/.test(line)) continue
        // typedef one-liners like `export type X = ...` keep their doc above.
        let j = i - 1
        while (j >= 0 && lines[j].trim() === '') j--
        const above = j >= 0 ? lines[j].trim() : ''
        if (!above.startsWith('/**') && !above.endsWith('*/')) {
          missing.push(`${file.replace(`${mapRoot}/`, '')}:${i + 1} ${line.trim().slice(0, 60)}`)
        }
      }
    }
  }
  assert.deepEqual(missing, [], 'every map-layer export needs preceding JSDoc in its emitted declaration')
})

function* walkDeclarations(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walkDeclarations(full)
    else if (entry.endsWith('.d.ts')) yield full
  }
}
