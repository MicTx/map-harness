import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { verifyWebPackage } from '../bin/web-onboarding.mjs'

const repo = join(import.meta.dirname, '../..')
const sha = value => createHash('sha256').update(value).digest('hex')

function fixture(name = 'map-web-launcher') {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  const target = 'mac-arm64'
  const directory = join(root, target)
  mkdirSync(directory)
  copyFileSync(join(repo, 'map/release/start-web.sh'), join(root, 'start-web.sh'))
  chmodSync(join(root, 'start-web.sh'), 0o755)
  const service = join(directory, 'map-harness')
  writeFileSync(service, '#!/bin/sh\nprintf \'service\\n\'\nprintf \'%s\\n\' "$@"\n')
  chmodSync(service, 0o755)
  const helper = join(directory, 'map-harness-rg')
  writeFileSync(helper, 'ripgrep helper\n')
  chmodSync(helper, 0o755)
  const buildRecord = {
    format: 'map-harness-native-1',
    version: '0.1.13',
    target,
    engine: { node: 'v24.21.0', platform: 'darwin', arch: 'arm64' },
    executable: 'map-harness',
    sha256: sha(readFileSync(service)),
    webService: { format: 1, mode: 'web', profile: 'map-web' },
    sourceCoreFiles: 0,
    resources: { rg: { file: 'map-harness-rg', sha256: sha(readFileSync(helper)) } },
  }
  const buildRecordPath = join(directory, 'map-harness.json')
  writeFileSync(buildRecordPath, JSON.stringify(buildRecord, null, 2) + '\n')
  const license = join(root, 'LICENSE')
  writeFileSync(license, 'license\n')
  const entries = [
    { path: 'LICENSE', role: 'license', target: null, executable: false, sha256: sha(readFileSync(license)) },
    { path: `${target}/map-harness`, role: 'service', target, executable: true, sha256: buildRecord.sha256 },
    { path: `${target}/map-harness-rg`, role: 'helper:rg', target, executable: true, sha256: buildRecord.resources.rg.sha256 },
    { path: `${target}/map-harness.json`, role: 'build-record', target, executable: false, sha256: sha(readFileSync(buildRecordPath)) },
  ]
  const writeManifest = overrides => writeFileSync(join(root, 'web-service-manifest.json'), JSON.stringify({
    format: 1,
    product: 'map-harness',
    version: '0.1.13',
    targets: [{ target, record: `${target}/map-harness.json` }],
    supportedTargets: [target],
    unsupportedTargets: [],
    files: entries,
    ...overrides,
  }, null, 2) + '\n')
  writeManifest({})
  return { root, target, service, helper, license, buildRecordPath, writeManifest, entries }
}

function launch(root, args = ['--no-open', '--port', '0'], environment = {}) {
  return spawnSync(join(root, 'start-web.sh'), args, {
    encoding: 'utf8',
    env: { ...environment, PATH: '/usr/bin:/bin', HOME: environment.HOME },
    timeout: 30000,
  })
}

test('the POSIX launcher verifies every package file and forwards Web arguments without Node', () => {
  const item = fixture()
  const result = launch(item.root, ['--no-onboarding', '--no-open', '--port', '0'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['service', '--web-onboarding', '--no-onboarding', '--no-open', '--port', '0'])
  const source = readFileSync(join(repo, 'map/release/start-web.sh'), 'utf8')
  assert.equal(source.includes('\r'), false)
  assert.doesNotMatch(source, /python|node|npm|pnpm/iu)
})

test('the POSIX wrapper only selects a native service and leaves validation to it', () => {
  const item = fixture('map-web-launcher-bad-json')
  writeFileSync(join(item.root, 'web-service-manifest.json'), '{broken\n')
  assert.equal(launch(item.root).status, 0)

  const missing = fixture('map-web-launcher-missing-manifest')
  rmSync(join(missing.root, 'web-service-manifest.json'))
  assert.equal(launch(missing.root).status, 0)
})

test('the POSIX wrapper never invokes Python, including missing manifests', () => {
  const item = fixture('map-web-launcher-no-python')
  rmSync(join(item.root, 'web-service-manifest.json'))
  writeFileSync(item.service, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
  chmodSync(item.service, 0o755)
  assert.equal(launch(item.root, []).stdout.trim(), '--web-onboarding')
})

test('native verification rejects missing or malformed manifests', async () => {
  const item = fixture('map-web-launcher-bad-json')
  writeFileSync(join(item.root, 'web-service-manifest.json'), '{broken\n')
  await assert.rejects(() => verifyWebPackage(item.root), /invalid web-service manifest/u)
  rmSync(join(item.root, 'web-service-manifest.json'))
  await assert.rejects(() => verifyWebPackage(item.root), /No such file|invalid web-service manifest/u)
})

test('native verification rejects wrong targets, versions, files and digests', async () => {
  const wrongTarget = fixture('map-web-launcher-target')
  wrongTarget.writeManifest({ supportedTargets: ['win-x64'], unsupportedTargets: [] })
  await assert.rejects(() => verifyWebPackage(wrongTarget.root), /does not support mac-arm64/u)
  const wrongVersion = fixture('map-web-launcher-version')
  const record = JSON.parse(readFileSync(wrongVersion.buildRecordPath, 'utf8'))
  record.version = '0.1.12'
  writeFileSync(wrongVersion.buildRecordPath, JSON.stringify(record, null, 2) + '\n')
  await assert.rejects(() => verifyWebPackage(wrongVersion.root), /build record does not match/u)
  const missing = fixture('map-web-launcher-missing-file')
  rmSync(missing.license)
  await assert.rejects(() => verifyWebPackage(missing.root), /missing package file/u)
  const changed = fixture('map-web-launcher-changed')
  writeFileSync(changed.license, 'changed license\n')
  await assert.rejects(() => verifyWebPackage(changed.root), /verification failed for LICENSE/u)
})

test('native verification rejects duplicates, helpers and lost executable bits', async () => {
  const duplicate = fixture('map-web-launcher-duplicate')
  duplicate.writeManifest({ files: [...duplicate.entries, duplicate.entries.find(row => row.role === 'service')] })
  await assert.rejects(() => verifyWebPackage(duplicate.root), /duplicate manifest file/u)
  const helper = fixture('map-web-launcher-helper')
  const record = JSON.parse(readFileSync(helper.buildRecordPath, 'utf8'))
  record.resources.rg.sha256 = '0'.repeat(64)
  writeFileSync(helper.buildRecordPath, JSON.stringify(record, null, 2) + '\n')
  await assert.rejects(() => verifyWebPackage(helper.root), /build record does not match|helper rg does not match|verification failed/u)
  const permission = fixture('map-web-launcher-permission')
  chmodSync(permission.helper, 0o644)
  await assert.rejects(() => verifyWebPackage(permission.root), /not executable/u)
})

test('the POSIX wrapper does not duplicate native validation', () => {
  const wrongTarget = fixture('map-web-launcher-target')
  wrongTarget.writeManifest({ supportedTargets: ['win-x64'], unsupportedTargets: [] })
  assert.equal(launch(wrongTarget.root).status, 0)

  const wrongVersion = fixture('map-web-launcher-version')
  const record = JSON.parse(readFileSync(wrongVersion.buildRecordPath, 'utf8'))
  record.version = '0.1.12'
  writeFileSync(wrongVersion.buildRecordPath, JSON.stringify(record, null, 2) + '\n')
  assert.equal(launch(wrongVersion.root).status, 0)

  const missingFile = fixture('map-web-launcher-missing-file')
  rmSync(missingFile.license)
  assert.equal(launch(missingFile.root).status, 0)

  const changed = fixture('map-web-launcher-changed')
  writeFileSync(changed.license, 'changed license\n')
  assert.equal(launch(changed.root).status, 0)
})

test('the POSIX wrapper leaves duplicate and helper checks to the native verifier', () => {
  const duplicate = fixture('map-web-launcher-duplicate')
  duplicate.writeManifest({ files: [...duplicate.entries, duplicate.entries.find(row => row.role === 'service')] })
  assert.equal(launch(duplicate.root).status, 0)

  const helperMismatch = fixture('map-web-launcher-helper')
  const record = JSON.parse(readFileSync(helperMismatch.buildRecordPath, 'utf8'))
  record.resources.rg.sha256 = '0'.repeat(64)
  writeFileSync(helperMismatch.buildRecordPath, JSON.stringify(record, null, 2) + '\n')
  assert.equal(launch(helperMismatch.root).status, 0)
})

test('Windows launchers use PowerShell and preserve CRLF or LF conventions', () => {
  const cmd = readFileSync(join(repo, 'map/release/start-web.cmd'), 'utf8')
  const ps1 = readFileSync(join(repo, 'map/release/start-web.ps1'), 'utf8')
  assert.equal(cmd.split('\n').slice(0, -1).every(line => line.endsWith('\r')), true)
  assert.equal(ps1.includes('\r'), false)
  assert.match(cmd, /-NoProfile -ExecutionPolicy Bypass/u)
  assert.match(ps1, /& \$service --web-onboarding @args/u)
  assert.doesNotMatch(ps1, /python|node|npm|pnpm/iu)
})
