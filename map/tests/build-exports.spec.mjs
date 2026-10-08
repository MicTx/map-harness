/**
 * Source-plane package manifest gates for the map layer: every declared
 * export path must exist in the source tree, every runtime package must keep
 * the Node/browser entry split the wrapper links, and map tests must stay on
 * the source plane (no `lib/` or bare `@map-harness/*` imports) so a stale
 * built artifact can never load a second module copy beside `src/`.
 * Runs on a clean checkout; no build required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const runtimePackages = [
  'client-ui-brand',
  'map-container',
  'tools',
  'arcgis-mcp',
  'spatial-storage',
  'spatial-catalog',
  'spatial-context',
  'spatial-accessibility',
  'spatial-statistics',
  'spatial-decision',
  'spatial-viz',
  'spatial-collab',
  'spatial-realtime',
  'spatial-scale',
  'spatial-perf',
  'spatial-observability',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Flatten one exports entry value to its default-less target list. */
function exportTargets(entry) {
  if (typeof entry === 'string') return [entry]
  if (typeof entry === 'object' && entry !== null) {
    return [entry.default, entry.types].filter(target => typeof target === 'string')
  }
  return []
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'lib') continue
      yield* walk(full)
    } else {
      yield full
    }
  }
}

test('every map package export path resolves inside the package', () => {
  const packages = [...runtimePackages, 'profiles/map-web']
  for (const dir of packages) {
    const manifest = readJson(join(mapRoot, dir, 'package.json'))
    assert.ok(manifest.type === 'module', `${dir} must stay ESM`)
    for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
      for (const target of exportTargets(entry)) {
        const clean = target.replace(/^\.\//, '')
        if (subpath.endsWith('*')) {
          // Wildcard source-plane export: the prefix directory must exist.
          const prefix = clean.replace(/\*$/, '')
          assert.ok(
            existsSync(join(mapRoot, dir, prefix)),
            `${dir} exports "${subpath}" but "${prefix}" does not exist`,
          )
        } else {
          assert.ok(
            existsSync(join(mapRoot, dir, clean)),
            `${dir} exports "${subpath}" but "${clean}" does not exist`,
          )
        }
      }
    }
    // Every built entry maps into lib/ and ships a types twin.
    if (dir !== 'profiles/map-web') {
      for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
        if (subpath === './src/*' || subpath === './package.json') continue
        const targets = exportTargets(entry)
        assert.ok(targets.some(target => target.startsWith('./lib/')), `${dir} export "${subpath}" must point into lib/`)
        if (subpath === '.' || subpath === './client' || subpath === './mcp') {
          assert.ok(targets.some(target => target.includes('/types/')), `${dir} export "${subpath}" must publish its tsc types twin`)
        }
      }
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, `${dir} must declare its published files[]`)
      assert.equal(manifest.private, true, `${dir} stays a private workspace package`)
    }
  }
})

test('the browser half is a distinct export of every client-bearing package', () => {
  const clientPackages = ['client-ui-brand', 'map-container']
  for (const dir of clientPackages) {
    const manifest = readJson(join(mapRoot, dir, 'package.json'))
    assert.ok('./client' in (manifest.exports ?? {}), `${dir} must keep the ./client browser entry`)
    assert.deepEqual(manifest.dsh?.client?.platform, 'web', `${dir} dsh.client must declare the web platform`)
    assert.ok(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0, `${dir} dsh.client must list its injected browser services`)
  }
  // Packages without browser halves must not claim a client face.
  for (const dir of ['tools', 'arcgis-mcp']) {
    const manifest = readJson(join(mapRoot, dir, 'package.json'))
    assert.equal('./client' in (manifest.exports ?? {}), false, `${dir} has no browser half`)
    assert.equal(manifest.dsh?.client, undefined, `${dir} must not declare a dsh.client face`)
  }
})

test('map tests import source, never built artifacts or bare map specifiers', () => {
  const offenders = []
  for (const file of walk(mapRoot)) {
    if (!file.includes('/tests/')) continue
    if (!/\.(mjs|ts|tsx)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
    for (const specifier of specifiers) {
      if (specifier.startsWith('@map-harness/')) {
        offenders.push(`${file.replace(`${mapRoot}/`, '')}: bare @map-harness import "${specifier}"`)
      }
      // Relative imports that leave a map package for a sibling map package's
      // lib/ would load the built artifact plane beside src/.
      if (/\/lib\//.test(specifier) && /(\.\.\/)+(map-container|tools|arcgis-mcp|client-ui-brand|profiles|presets|bin)\//.test(specifier)) {
        offenders.push(`${file.replace(`${mapRoot}/`, '')}: imports map built artifact "${specifier}"`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'map tests must stay on the source plane')
})
