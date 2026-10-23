/**
 * Runtime release gates: the shared privacy rule every published artifact
 * uses, the setup script's argument and Node checks, the mirror order, and
 * the Windows launchers' CRLF form. Runs on a clean checkout; no build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrivate } from '../bin/pack-runtime.mjs'
import { MIRRORS, nodeSupported, parseArgs } from '../bin/setup.mjs'

const mapRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the privacy rule drops every .env file at any depth but keeps value-free templates', () => {
  for (const path of ['.env', 'apps/x/.env', '.env.local', 'map/tools/.env.production', '.spec/a.md', '.claude/settings.json', 'user/s.jsonl', 'logs/a.log']) {
    assert.equal(isPrivate(path), true, path)
  }
  for (const path of ['apps/desktop/.env.macos.example', '.env.example', 'map/bin/setup.mjs', 'docs/env.md', 'map/.envoy/readme.md']) {
    assert.equal(isPrivate(path), false, path)
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
