/**
 * Runtime release gates: the shared privacy rule every published artifact
 * uses, the product version source behind client builds and release tags,
 * the setup script's argument and Node checks, the mirror order, and
 * the Windows launchers' CRLF form. Runs on a clean checkout; no build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrivate } from '../bin/pack-runtime.mjs'
import { assertCommunityEnvironment, assertReleaseVersion, readProductVersion } from '../bin/public-release-privacy.mjs'
import { MIRRORS, nodeSupported, parseArgs } from '../bin/setup.mjs'

const mapRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the privacy rule drops every .env file at any depth but keeps value-free templates', () => {
  for (const path of ['.env', 'apps/x/.env', '.env.local', 'map/tools/.env.production', '.spec/a.md', '.claude/settings.json', 'user/s.jsonl', 'logs/a.log', '.github/workflows/ci.yml', '.github/workflows/privacy-probe.yml', 'map/docs/github-release.md']) {
    assert.equal(isPrivate(path), true, path)
  }
  for (const path of ['apps/desktop/.env.macos.example', '.env.example', 'map/bin/setup.mjs', 'docs/env.md', 'map/.envoy/readme.md', '.github/review-ownership/README.md', 'map/docs/engineering.md', 'map/docs/release-install-guide.md']) {
    assert.equal(isPrivate(path), false, path)
  }
})

test('the product version source is public environment and feeds the build entry', () => {
  const product = readProductVersion(join(mapRoot, '..'))
  assert.match(product, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'committed version.json names a release version')
  assertCommunityEnvironment({ DSH_CLIENT_VERSION: product })
  const buildWeb = readFileSync(join(mapRoot, 'bin', 'build-web.mjs'), 'utf8')
  assert.ok(buildWeb.includes('DSH_CLIENT_VERSION: readProductVersion(root)'), 'build-web injects the product version')
  const publisher = readFileSync(join(mapRoot, 'bin', 'publish-release.mjs'), 'utf8')
  assert.ok(publisher.includes('assertReleaseVersion('), 'publisher validates the requested tag against the version source')
})

test('release requests must cite the committed product version', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'map-product-version-'))
  try {
    mkdirSync(join(fixture, 'map', 'release'), { recursive: true })
    writeFileSync(join(fixture, 'map', 'release', 'version.json'), '{"version":"0.1.10"}\n')
    assert.equal(readProductVersion(fixture), '0.1.10')
    assertReleaseVersion(fixture, 'v0.1.10')
    assert.throws(() => assertReleaseVersion(fixture, 'v0.1.11'), /does not match the product version/)
    writeFileSync(join(fixture, 'map', 'release', 'version.json'), '{"version":"0.1"}\n')
    assert.throws(() => readProductVersion(fixture), /must carry/)
    writeFileSync(join(fixture, 'map', 'release', 'version.json'), 'not json')
    assert.throws(() => readProductVersion(fixture), /missing or unreadable/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('setup accepts only http(s) registries and reads MAPHARNESS_REGISTRY', () => {
  assert.deepEqual(parseArgs(['--registry', 'https://r.example/npm'], {}), { registry: 'https://r.example/npm', check: false })
  assert.deepEqual(parseArgs(['--check'], { MAPHARNESS_REGISTRY: ' https://m.example ' }), { registry: 'https://m.example', check: true })
  assert.deepEqual(parseArgs([], {}), { registry: undefined, check: false })
})

test('setup supports exactly the workspace Node engines range', () => {
  for (const version of ['22.19.0', '22.20.1', '24.0.0', '25.2.1']) assert.equal(nodeSupported(version), true, version)
  for (const version of ['20.18.0', '22.18.9', '23.5.0']) assert.equal(nodeSupported(version), false, version)
})

test('the mirror order tries mainland China mirrors before the official registry', () => {
  assert.deepEqual(MIRRORS.map(mirror => mirror.url), [
    'https://registry.npmmirror.com',
    'https://mirrors.cloud.tencent.com/npm',
    'https://registry.npmjs.org',
  ])
})

test('Windows launchers keep CRLF line endings and the shell launchers are LF', () => {
  for (const name of ['install.cmd', 'start.cmd']) {
    const text = readFileSync(join(mapRoot, 'release', name), 'utf8')
    assert.equal(text.split('\n').slice(0, -1).every(line => line.endsWith('\r')), true, name)
  }
  for (const name of ['install.sh', 'start.sh']) {
    assert.equal(readFileSync(join(mapRoot, 'release', name), 'utf8').includes('\r'), false, name)
  }
})
