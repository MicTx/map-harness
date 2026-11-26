/** Managed per-user installation transactions use real temporary trees and no mocked filesystem. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createInstallDescriptor, createInstallManifest, INSTALL_MANIFEST_FILE, MapInstallError } from '../bin/install-manifest.mjs'
import { MAP_IDENTITY_REVISION } from '../bin/instance-home.mjs'
import {
  ACTIVE_SLOT, INSTALLATION_MARKER, LAUNCHER, MANAGED_LAYOUT_FORMAT, SLOTS_DIRECTORY, VERSIONS_DIRECTORY,
  detectHostTarget, defaultInstallRoot, inspectManagedInstall,
} from '../bin/install-layout.mjs'
import { runManagedInstall, verifyManagedInstallation } from '../bin/install-transaction.mjs'
import { mainManage } from '../bin/manage.mjs'

const repo = join(import.meta.dirname, '../..')
const hostTarget = detectHostTarget()
const targets = ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const otherTarget = targets.find(target => target !== hostTarget)
const initialCompatibility = {
  sessionFormat: 4, spatialStore: { min: 6, max: 6 }, accessibilityStore: { min: 1, max: 1 }, storageSqlite: 1, migration: 'none',
}
const ownerFiles = [
  ['packages/core/session/src/types.ts', 'SESSION_FORMAT_VERSION', 4],
  ['map/spatial-storage/src/schema.ts', 'SPATIAL_STORE_SCHEMA_VERSION', 6],
  ['map/spatial-accessibility/src/runs.ts', 'ACCESSIBILITY_RUN_SCHEMA_VERSION', 1],
  ['packages/storage/storage-sqlite/src/schema.ts', 'STORAGE_SQLITE_SCHEMA_VERSION', 1],
]
const sha256 = value => createHash('sha256').update(value).digest('hex')
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-managed-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), bytes)
}

function writeOwner(root, index, value) {
  const [path, symbol] = ownerFiles[index]
  const ladder = index === 1 ? `\nexport const STORE_MIGRATION_STEPS: readonly unknown[] = [\n${Array.from({ length: value }, (_, from) => `  { from: ${from}, to: ${from + 1}, name: 'v${from + 1}', up: () => {} },`).join('\n')}\n]\n` : ''
  write(root, path, `export const ${symbol}: number = ${value} as const;\n${ladder}`)
}

function buildBuildRoot(t, version) {
  const root = temp(t)
  mkdirSync(join(root, 'map/release'), { recursive: true })
  copyFileSync(join(repo, 'map/release/install.json'), join(root, 'map/release/install.json'))
  write(root, 'map/release/version.json', json({ version }))
  write(root, 'scripts/primary-runtime/lock.json', json({ targets: Object.fromEntries(targets.map(target => [target, {}])) }))
  for (const [index, [, , value]] of ownerFiles.entries()) writeOwner(root, index, value)
  return root
}

async function makePackage(t, options = {}) {
  const version = options.version ?? '1.2.3'
  const channel = options.channel ?? 'stable'
  const target = options.target ?? hostTarget
  const sourceDigest = options.sourceDigest ?? 'a'.repeat(64)
  const buildRoot = buildBuildRoot(t, version)
  const windows = target.startsWith('win-')
  const executable = windows ? 'map-harness.exe' : 'map-harness'
  const serviceBytes = Buffer.from(`native fixture ${version} ${target}\n`)
  const licenseBytes = Buffer.from(`license fixture ${version}\n`)
  const launcherName = windows ? 'start-web.cmd' : 'start-web.sh'
  const launcherBytes = windows ? Buffer.from('@echo off\r\necho start-web %CD% %*\r\n')
    : Buffer.from('#!/bin/sh\necho "start-web $(CDPATH= cd -- "$(dirname -- "$0")" && pwd) $*"\n')
  const record = {
    format: 'map-harness-native-1', version, target, sourceDigest,
    engine: { node: 'v24.21.0', platform: { mac: 'darwin', linux: 'linux', win: 'win32' }[target.split('-')[0]], arch: target.split('-')[1] },
    executable, sha256: sha256(serviceBytes), sourceCoreFiles: 0,
    webService: { format: 1, mode: 'web', profile: 'map-web' },
    install: createInstallDescriptor({ distribution: 'managed', channel, dataCompatibility: initialCompatibility }),
  }
  const recordBytes = json(record)
  const files = [
    { path: 'LICENSE', role: 'license', target: null, executable: false, sha256: sha256(licenseBytes) },
    { path: launcherName, role: 'launcher', target: null, executable: !windows, sha256: sha256(launcherBytes) },
    { path: `${target}/${executable}`, role: 'service', target, executable: true, sha256: sha256(serviceBytes) },
    { path: `${target}/application.json`, role: 'build-record', target, executable: false, sha256: sha256(recordBytes) },
  ]
  const payload = {
    format: 1, product: 'map-harness', version, targets: [{ target, record: `${target}/application.json` }],
    supportedTargets: [target], unsupportedTargets: targets.filter(item => item !== target), files,
  }
  const payloadBytes = json(payload)
  const manifest = await createInstallManifest({
    root: buildRoot, distribution: 'managed', channel, target, sourceDigest,
    payloadManifestBytes: payloadBytes, buildRecordBytes: { [target]: recordBytes },
  })
  const packageRoot = join(temp(t), 'package')
  write(packageRoot, 'LICENSE', options.corrupt === true ? Buffer.from('corrupted license\n') : licenseBytes)
  write(packageRoot, launcherName, launcherBytes)
  write(packageRoot, `${target}/${executable}`, serviceBytes)
  write(packageRoot, `${target}/application.json`, recordBytes)
  write(packageRoot, 'web-service-manifest.json', payloadBytes)
  write(packageRoot, INSTALL_MANIFEST_FILE, json(manifest))
  return {
    packageRoot, manifest, payload, licenseBytes, serviceBytes, launcherName, executable, target, version, channel, sourceDigest,
    expected: {
      product: 'map-harness', distribution: 'managed', channel, target, version,
      identityRevision: MAP_IDENTITY_REVISION, sourceDigest, payloadSha256: sha256(payloadBytes),
    },
  }
}

function fakeHome(t) {
  const home = join(temp(t), 'home')
  mkdirSync(home, { recursive: true })
  return home
}

async function install(t, pkg, options = {}) {
  const base = temp(t)
  const installRoot = options.installRoot ?? join(base, 'Map Harness')
  const home = options.homedir ?? join(base, 'home')
  mkdirSync(home, { recursive: true })
  const receipt = await runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected,
    dataHome: options.dataHome ?? null, homedir: home,
  }, options.deps ?? {})
  return { installRoot, home, receipt }
}

function inventory(root) {
  const walk = relative => readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(path) : [[path, sha256(readFileSync(join(root, path)))]]
  })
  return walk('').sort(([a], [b]) => a.localeCompare(b))
}

function fails(code) {
  return error => {
    assert.ok(error instanceof MapInstallError, `expected MapInstallError, got ${error}`)
    assert.equal(error.code, code)
    assert.equal(typeof error.details, 'object')
    return true
  }
}

function receipts(installRoot) {
  return readdirSync(join(installRoot, 'receipts')).filter(name => name.endsWith('.json'))
}

test('installer commits an immutable payload, slot pointer, marker, launcher, and receipt', async t => {
  const pkg = await makePackage(t)
  const before = inventory(pkg.packageRoot)
  const { installRoot, home, receipt } = await install(t, pkg)
  assert.equal(receipt.state, 'committed')
  assert.equal(receipt.result, 'installed')
  assert.equal(receipt.version, pkg.version)
  assert.equal(receipt.sourceDigest, pkg.sourceDigest)
  assert.equal(receipt.target, hostTarget)
  const layout = inspectManagedInstall(installRoot)
  assert.equal(layout.state, 'ready')
  assert.equal(layout.activeSlot, 'A')
  assert.equal(layout.activeVersion, `${pkg.version}-${pkg.sourceDigest}`)
  assert.equal(readFileSync(join(installRoot, ACTIVE_SLOT), 'utf8'), 'A\n')
  assert.equal(readFileSync(join(installRoot, SLOTS_DIRECTORY, 'A'), 'utf8'), `versions/${pkg.version}-${pkg.sourceDigest}\n`)
  const versionDir = join(installRoot, VERSIONS_DIRECTORY, `${pkg.version}-${pkg.sourceDigest}`)
  for (const row of pkg.payload.files) {
    assert.ok(readFileSync(join(versionDir, row.path)).equals(readFileSync(join(pkg.packageRoot, row.path))), row.path)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(versionDir, INSTALL_MANIFEST_FILE))).version, pkg.version)
  const marker = JSON.parse(readFileSync(join(installRoot, INSTALLATION_MARKER), 'utf8'))
  assert.equal(marker.format, MANAGED_LAYOUT_FORMAT)
  assert.equal(marker.distribution, 'managed')
  assert.equal(marker.channel, pkg.channel)
  assert.equal(marker.target, pkg.target)
  assert.equal(marker.dataHome, join(home, '.map-harness'))
  assert.equal(existsSync(marker.dataHome), false)
  assert.match(marker.installationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
  const launcher = lstatSync(join(installRoot, LAUNCHER))
  assert.ok(launcher.isFile())
  if (process.platform !== 'win32') assert.notEqual(launcher.mode & 0o111, 0)
  assert.equal(receipts(installRoot).length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(installRoot, 'receipts', `${receipt.operationId}.json`))).state, 'committed')
  assert.deepEqual(readdirSync(installRoot).filter(name => name.startsWith('.staging')), [])
  assert.deepEqual(inventory(pkg.packageRoot), before, 'the release package is never modified')
})

test('reinstalling the same package is an idempotent no-op that rewrites no payload', async t => {
  const pkg = await makePackage(t)
  const { installRoot, receipt } = await install(t, pkg)
  const versionSnapshot = inventory(join(installRoot, VERSIONS_DIRECTORY))
  const pointerSnapshot = readFileSync(join(installRoot, ACTIVE_SLOT), 'utf8')
  const again = await runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  })
  assert.equal(again.state, 'committed')
  assert.equal(again.result, 'no-op')
  assert.notEqual(again.operationId, receipt.operationId)
  assert.deepEqual(inventory(join(installRoot, VERSIONS_DIRECTORY)), versionSnapshot)
  assert.equal(readFileSync(join(installRoot, ACTIVE_SLOT), 'utf8'), pointerSnapshot)
  assert.equal(receipts(installRoot).length, 2)
})

test('a corrupted package file fails before commit and leaves the root clean', async t => {
  const pkg = await makePackage(t, { corrupt: true })
  const packageBefore = inventory(pkg.packageRoot)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_DIGEST'))
  assert.equal(existsSync(join(installRoot, VERSIONS_DIRECTORY)), false)
  assert.equal(existsSync(join(installRoot, INSTALLATION_MARKER)), false)
  assert.equal(existsSync(installRoot), false)
  assert.deepEqual(inventory(pkg.packageRoot), packageBefore)
})

test('a missing package file fails with a typed I/O error before commit', async t => {
  const pkg = await makePackage(t)
  rmSync(join(pkg.packageRoot, 'LICENSE'))
  const installRoot = join(temp(t), 'root')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_IO'))
})

test('a non-product directory is refused without touching its files', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'existing')
  mkdirSync(installRoot)
  writeFileSync(join(installRoot, 'user-notes.txt'), 'keep these bytes\n')
  const before = inventory(installRoot)
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_REFUSED'))
  assert.deepEqual(inventory(installRoot), before)
  assert.deepEqual(readdirSync(installRoot), ['user-notes.txt'])
})

test('the same version with different content is a version conflict', async t => {
  const first = await makePackage(t)
  const { installRoot } = await install(t, first)
  const second = await makePackage(t, { sourceDigest: 'b'.repeat(64) })
  await assert.rejects(runManagedInstall({
    packageRoot: second.packageRoot, installRoot, expected: second.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_VERSION_CONFLICT'))
  const marker = JSON.parse(readFileSync(join(installRoot, INSTALLATION_MARKER), 'utf8'))
  assert.equal(marker.sourceDigest, first.sourceDigest)
})

test('a different installed version requires the managed update entry', async t => {
  const first = await makePackage(t, { version: '1.2.3' })
  const { installRoot } = await install(t, first)
  const before = inventory(installRoot)
  const second = await makePackage(t, { version: '1.2.4' })
  await assert.rejects(runManagedInstall({
    packageRoot: second.packageRoot, installRoot, expected: second.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_EXISTS'))
  assert.deepEqual(inventory(installRoot), before)
})

test('a package built for another target is rejected by identity', async t => {
  const pkg = await makePackage(t, { target: otherTarget })
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot: join(temp(t), 'root'), expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_IDENTITY'))
})

test('insufficient space fails before creating the install root', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }, { statfs: () => ({ bavail: 1, bsize: 1 }) }), fails('MAP_INSTALL_SPACE'))
  assert.equal(existsSync(installRoot), false)
})

test('a read-only installation root fails before commit', { skip: process.platform === 'win32' ? 'POSIX permission semantics are required' : false }, async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  mkdirSync(installRoot)
  chmodSync(installRoot, 0o500)
  try {
    await assert.rejects(runManagedInstall({
      packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
    }), fails('MAP_INSTALL_IO'))
  } finally {
    chmodSync(installRoot, 0o700)
  }
  assert.deepEqual(readdirSync(installRoot), [])
})

test('a crashed reservation blocks a second installer until it is inspected', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  mkdirSync(installRoot)
  writeFileSync(join(installRoot, '.map-installing'), '', { mode: 0o600 })
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_BUSY'))
  rmSync(join(installRoot, '.map-installing'))
  const receipt = await runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  })
  assert.equal(receipt.state, 'committed')
})

test('unknown staging-like content blocks a fresh install and is never deleted', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  mkdirSync(join(installRoot, '.staging-deadbeef'), { recursive: true })
  writeFileSync(join(installRoot, '.staging-deadbeef', 'leftover'), 'junk')
  const before = inventory(installRoot)
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_REFUSED'))
  assert.deepEqual(inventory(installRoot), before)
})

test('a no-op needs a committed receipt that binds the installed payload', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  rmSync(join(installRoot, 'receipts'), { recursive: true, force: true })
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_STATE'))
})

test('an interrupted slot write stays visible and preserves the immutable payload', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const versionSnapshot = inventory(join(installRoot, VERSIONS_DIRECTORY))
  rmSync(join(installRoot, ACTIVE_SLOT))
  assert.equal(inspectManagedInstall(installRoot).state, 'incomplete')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_STATE'))
  assert.deepEqual(inventory(join(installRoot, VERSIONS_DIRECTORY)), versionSnapshot)
  assert.equal(existsSync(join(installRoot, ACTIVE_SLOT)), false)
})

test('a tampered version payload is refused instead of overwritten', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const versionDir = join(installRoot, VERSIONS_DIRECTORY, `${pkg.version}-${pkg.sourceDigest}`)
  const target = join(versionDir, 'LICENSE')
  writeFileSync(target, 'tampered\n')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_DIGEST'))
  assert.equal(readFileSync(target, 'utf8'), 'tampered\n')
})

test('a damaged slot pointer is reported instead of executed', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  writeFileSync(join(installRoot, SLOTS_DIRECTORY, 'A'), '../escape\n')
  const layout = inspectManagedInstall(installRoot)
  assert.equal(layout.state, 'damaged')
  assert.equal(layout.reason, 'slot-pointer')
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: null, homedir: fakeHome(t),
  }), fails('MAP_INSTALL_STATE'))
})

test('the data home must stay outside the program root and the stock DSH roots', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  const home = fakeHome(t)
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: join(installRoot, 'data'), homedir: home,
  }), fails('MAP_INSTALL_INPUT'))
  await assert.rejects(runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: join(home, '.dsh'), homedir: home,
  }), fails('MAP_INSTALL_REFUSED'))
})

test('the stable launcher resolves the active slot without a runtime and refuses a bad pointer', async t => {
  if (process.platform === 'win32') return t.skip('POSIX launcher execution')
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const result = spawnSync(join(installRoot, LAUNCHER), ['--probe'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`start-web .*${pkg.version.replaceAll('.', '\\.')}.* --probe`, 'u'))
  writeFileSync(join(installRoot, ACTIVE_SLOT), 'C\n')
  const refused = spawnSync(join(installRoot, LAUNCHER), [], { encoding: 'utf8' })
  assert.equal(refused.status, 90)
  assert.match(refused.stderr, /invalid managed slot pointer/u)
})

test('doctor verifies committed payload digests and reports tampering', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const healthy = await verifyManagedInstallation(installRoot)
  assert.equal(healthy.ok, true)
  assert.equal(healthy.version, pkg.version)
  writeFileSync(join(installRoot, VERSIONS_DIRECTORY, `${pkg.version}-${pkg.sourceDigest}`, 'LICENSE'), 'tampered\n')
  const broken = await verifyManagedInstallation(installRoot)
  assert.equal(broken.ok, false)
  const payloadCheck = broken.checks.find(check => check.name === 'payload')
  assert.equal(payloadCheck.ok, false)
  assert.ok(payloadCheck.detail.some(item => item.reason === 'digest'))
})

test('manage status reports absent, ready, and foreign roots', async t => {
  const pkg = await makePackage(t)
  const context = { homedir: fakeHome(t), cwd: repo, env: {} }
  const absentRoot = join(temp(t), 'missing')
  const absent = await mainManage(['status', '--install-root', absentRoot, '--json'], context)
  assert.equal(absent.exitCode, 0)
  assert.equal(absent.json.state, 'absent')
  const { installRoot } = await install(t, pkg)
  const ready = await mainManage(['status', '--install-root', installRoot, '--json'], context)
  assert.equal(ready.exitCode, 0)
  assert.equal(ready.json.state, 'ready')
  assert.equal(ready.json.version, pkg.version)
  assert.equal(ready.json.activeSlot, 'A')
  const foreignRoot = join(temp(t), 'foreign')
  mkdirSync(foreignRoot)
  writeFileSync(join(foreignRoot, 'other.txt'), 'x')
  const foreign = await mainManage(['status', '--install-root', foreignRoot, '--json'], context)
  assert.equal(foreign.json.state, 'foreign')
})

test('manage install requires an independently selected release identity', async t => {
  const pkg = await makePackage(t)
  const context = { homedir: fakeHome(t), cwd: repo, env: {} }
  const missing = await mainManage(['install', '--package-root', pkg.packageRoot, '--install-root', join(temp(t), 'root'), '--json'], context)
  assert.equal(missing.exitCode, 2)
  assert.equal(missing.json.error.code, 'MAP_INSTALL_INPUT')
  assert.match(missing.output, /--expected/u)
  const missingFile = await mainManage(['install', '--package-root', pkg.packageRoot, '--install-root', join(temp(t), 'root2'),
    '--expected', join(temp(t), 'nope.json'), '--json'], context)
  assert.equal(missingFile.json.error.code, 'MAP_INSTALL_IO')
})

test('manage install consumes an expected identity file and records the data home', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const home = fakeHome(t)
  const installRoot = join(base, 'Map Harness')
  const dataHome = join(base, 'data home')
  const expectedPath = join(base, 'expected.json')
  writeFileSync(expectedPath, `${JSON.stringify({ format: 'map-harness-install-identity-1', ...pkg.expected }, null, 2)}\n`)
  const result = await mainManage(['install', '--package-root', pkg.packageRoot, '--install-root', installRoot,
    '--data-home', dataHome, '--expected', expectedPath, '--json'], { homedir: home, cwd: repo, env: {} })
  assert.equal(result.exitCode, 0, result.output)
  assert.equal(result.json.state, 'committed')
  assert.equal(result.json.result, 'installed')
  const marker = JSON.parse(readFileSync(join(installRoot, INSTALLATION_MARKER), 'utf8'))
  assert.equal(marker.dataHome, dataHome)
  assert.equal(existsSync(dataHome), false, 'the installer never creates the data home')
})

test('MAPHARNESS_INSTALL_ROOT selects only the program root and explicit flags win', async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const home = fakeHome(t)
  const expectedPath = join(base, 'expected.json')
  writeFileSync(expectedPath, `${JSON.stringify(pkg.expected)}\n`)
  const envRoot = join(base, 'env root')
  const flagRoot = join(base, 'flag root')
  const fromEnv = await mainManage(['install', '--package-root', pkg.packageRoot, '--expected', expectedPath, '--json'],
    { homedir: home, cwd: repo, env: { MAPHARNESS_INSTALL_ROOT: envRoot } })
  assert.equal(fromEnv.exitCode, 0, fromEnv.output)
  assert.equal(inspectManagedInstall(envRoot).state, 'ready')
  const fromFlag = await mainManage(['install', '--package-root', pkg.packageRoot, '--expected', expectedPath,
    '--install-root', flagRoot, '--json'], { homedir: home, cwd: repo, env: { MAPHARNESS_INSTALL_ROOT: join(base, 'unused') } })
  assert.equal(fromFlag.exitCode, 0, fromFlag.output)
  assert.equal(inspectManagedInstall(flagRoot).state, 'ready')
  assert.equal(existsSync(join(base, 'unused')), false)
  assert.deepEqual(readdirSync(home), [], 'installation never creates data-home entries')
})

test('manage update, rollback, and uninstall reject incomplete arguments without touching the root', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const before = inventory(installRoot)
  const context = { homedir: fakeHome(t), cwd: repo, env: {} }
  const update = await mainManage(['update', '--install-root', installRoot, '--json'], context)
  assert.equal(update.exitCode, 2)
  assert.equal(update.json.error.code, 'MAP_INSTALL_INPUT')
  const rollback = await mainManage(['rollback', '--install-root', installRoot, '--json'], context)
  assert.equal(rollback.exitCode, 2)
  assert.equal(rollback.json.error.code, 'MAP_INSTALL_INPUT')
  const uninstallDry = await mainManage(['uninstall', '--install-root', installRoot, '--dry-run', '--json'], context)
  assert.equal(uninstallDry.json.result, 'dry-run')
  assert.deepEqual(inventory(installRoot), before)
})

test('manage import adapts the import module result and maps blocked plans', async t => {
  const context = { homedir: fakeHome(t), cwd: repo, env: {} }
  const ready = await mainManage(['import', '--from', '/legacy', '--to', '/target', '--json'], {
    ...context,
    importModule: async () => ({ runImportCommand: async () => ({ format: 'map-harness-import-plan-1', dryRun: true, status: 'ready', unresolved: [], conflicts: [], byteBudget: {} }) }),
  })
  assert.equal(ready.exitCode, 0)
  assert.equal(ready.json.format, 'map-harness-import-plan-1')
  const blocked = await mainManage(['import', '--json'], {
    ...context,
    importModule: async () => ({ runImportCommand: async () => ({ format: 'map-harness-import-plan-1', dryRun: true, status: 'blocked' }) }),
  })
  assert.equal(blocked.exitCode, 1)
  const typed = await mainManage(['import', '--json'], {
    ...context,
    importModule: async () => ({ runImportCommand: async () => { throw Object.assign(new Error('source is active'), { code: 'MAP_IMPORT_INCOMPLETE', details: { source: '/legacy' } }) } }),
  })
  assert.equal(typed.json.error.code, 'MAP_IMPORT_INCOMPLETE')
})

test('default install roots are per-user and channel-separated', () => {
  const home = '/Users/example'
  assert.equal(defaultInstallRoot({ platform: 'darwin', channel: 'stable', homedir: home, env: {} }), join(home, 'Applications', 'Map Harness'))
  assert.equal(defaultInstallRoot({ platform: 'darwin', channel: 'preview', homedir: home, env: {} }), join(home, 'Applications', 'Map Harness Preview'))
  assert.equal(defaultInstallRoot({ platform: 'win32', channel: 'stable', homedir: home, env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' } }),
    'C:\\Users\\example\\AppData\\Local\\Programs\\Map Harness')
  assert.equal(defaultInstallRoot({ platform: 'linux', channel: 'stable', homedir: home, env: {} }), join(home, '.local', 'opt', 'map-harness'))
  assert.throws(() => defaultInstallRoot({ platform: 'aix', homedir: home, env: {} }), fails('MAP_INSTALL_INPUT'))
})

function archiveFixture(t, pkg) {
  const archive = join(temp(t), `map-harness-v${pkg.version}-web-${pkg.target}`)
  const copyTree = relative => {
    for (const entry of readdirSync(join(pkg.packageRoot, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        mkdirSync(join(archive, path), { recursive: true })
        copyTree(path)
      } else {
        mkdirSync(dirname(join(archive, path)), { recursive: true })
        copyFileSync(join(pkg.packageRoot, path), join(archive, path))
      }
    }
  }
  mkdirSync(join(archive, pkg.target), { recursive: true })
  copyTree('')
  copyFileSync(join(repo, 'map/release/install-map.sh'), join(archive, 'install-map.sh'))
  copyFileSync(join(repo, 'map/release/uninstall-map.sh'), join(archive, 'uninstall-map.sh'))
  const service = join(archive, pkg.target, `map-harness-v${pkg.version}-${pkg.target}`)
  writeFileSync(service, `#!/bin/sh\nshift\nexec "${process.execPath}" "${join(repo, 'map/bin/manage.mjs')}" "$@"\n`, { mode: 0o755 })
  writeFileSync(`${service}.json`, '{}\n')
  return archive
}

test('install-map.sh forwards to the package native service without a system runtime', { skip: process.platform === 'win32' ? 'POSIX shell entry' : false }, async t => {
  const pkg = await makePackage(t)
  const archive = archiveFixture(t, pkg)
  const base = temp(t)
  const installRoot = join(base, 'Map Harness')
  const home = fakeHome(t)
  const expectedPath = join(base, 'expected.json')
  writeFileSync(expectedPath, `${JSON.stringify(pkg.expected)}\n`)
  const service = join(archive, pkg.target, `map-harness-v${pkg.version}-${pkg.target}`)
  const digest = sha256(readFileSync(service))
  const forward = extra => spawnSync('sh', [join(archive, 'install-map.sh'), ...extra], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, MAPHARNESS_INSTALL_ROOT: installRoot, MAPHARNESS_HOME: join(base, 'data') },
  })
  const refused = forward(['--expected', expectedPath, '--manager-sha256', 'b'.repeat(64), '--install-root', installRoot, '--json'])
  assert.equal(refused.status, 89)
  assert.match(refused.stderr, /checksum differs/u)
  const missing = forward(['--install-root', installRoot, '--json'])
  assert.equal(missing.status, 2)
  const result = forward(['--expected', expectedPath, '--manager-sha256', digest, '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.state, 'committed')
  assert.equal(inspectManagedInstall(installRoot).state, 'ready')
})

test('managed payload reads reject linked directories and preserve the external tree', { skip: process.platform === 'win32' ? 'POSIX symbolic-link fixture' : false }, async t => {
  const pkg = await makePackage(t)
  const outside = join(temp(t), 'external-native')
  renameSync(join(pkg.packageRoot, pkg.target), outside)
  symlinkSync(outside, join(pkg.packageRoot, pkg.target), 'dir')
  const before = inventory(outside)
  const installRoot = join(temp(t), 'root')
  await assert.rejects(runManagedInstall({ packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, homedir: fakeHome(t) }), fails('MAP_INSTALL_INPUT'))
  assert.equal(existsSync(installRoot), false)
  assert.deepEqual(inventory(outside), before)
})

test('inactive slot and receipt links are rejected without reading external data', { skip: process.platform === 'win32' ? 'POSIX symbolic-link fixture' : false }, async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const outside = join(temp(t), 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'A'), 'secret-sentinel')
  rmSync(join(installRoot, 'slots'), { recursive: true })
  symlinkSync(outside, join(installRoot, 'slots'), 'dir')
  const before = inventory(outside)
  await assert.rejects(runManagedInstall({ packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, homedir: fakeHome(t) }), fails('MAP_INSTALL_STATE'))
  assert.deepEqual(inventory(outside), before)
})

test('installed payload inventory and manifest hashes prevent a forged no-op', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const versionRoot = join(installRoot, 'versions', `${pkg.version}-${pkg.sourceDigest}`)
  writeFileSync(join(versionRoot, 'user-content'), 'retain me')
  await assert.rejects(runManagedInstall({ packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, homedir: fakeHome(t) }), fails('MAP_INSTALL_STATE'))
  assert.equal(readFileSync(join(versionRoot, 'user-content'), 'utf8'), 'retain me')
  rmSync(join(versionRoot, 'user-content'))
  const payload = JSON.parse(readFileSync(join(versionRoot, 'web-service-manifest.json')))
  payload.files = payload.files.filter(row => row.path !== 'LICENSE')
  writeFileSync(join(versionRoot, 'web-service-manifest.json'), json(payload))
  await assert.rejects(runManagedInstall({ packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, homedir: fakeHome(t) }), fails('MAP_INSTALL_DIGEST'))
})

test('stable launchers preserve the data home independently of program placement and reject traversal', { skip: process.platform === 'win32' ? 'POSIX launcher fixture' : false }, async t => {
  const pkg = await makePackage(t)
  const base = temp(t)
  const dataHome = join(base, "资料 data ' home")
  const { installRoot } = await install(t, pkg, { installRoot: join(base, '程序 files'), dataHome })
  const root = join(installRoot, 'versions', `${pkg.version}-${pkg.sourceDigest}`)
  writeFileSync(join(root, pkg.launcherName), '#!/bin/sh\nprintf "%s\\n%s\\n" "$MAPHARNESS_HOME" "$MAPHARNESS_INSTALL_ROOT"\n')
  const run = env => spawnSync(join(installRoot, LAUNCHER), [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env }, timeout: 30000 })
  const result = run({})
  assert.equal(result.signal, null)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const actualRoot = result.stdout.trimEnd().split('\n')
  assert.equal(actualRoot[0], dataHome)
  assert.equal(actualRoot[1].endsWith('/程序 files'), true)
  const override = join(base, 'alternate-home')
  assert.equal(run({ MAPHARNESS_HOME: override }).stdout.split('\n')[0], override)
  writeFileSync(join(installRoot, 'slots/A'), `versions/../../outside-${'a'.repeat(64)}\n`)
  assert.equal(run({}).status, 90)
  assert.equal(existsSync(dataHome), false)
})

test('two initial installation requests converge to one immutable payload', async t => {
  const pkg = await makePackage(t)
  const installRoot = join(temp(t), 'shared-install')
  const request = { packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, homedir: fakeHome(t) }
  const results = await Promise.allSettled([runManagedInstall(request), runManagedInstall(request)])
  const successes = results.filter(result => result.status === 'fulfilled')
  assert.equal(successes.filter(result => result.value.result === 'installed').length, 1)
  for (const outcome of results) {
    if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'MAP_INSTALL_BUSY')
    else assert.ok(['installed', 'no-op'].includes(outcome.value.result))
  }
  assert.equal((await verifyManagedInstallation(installRoot)).ok, true)
  assert.equal(receipts(installRoot).length, successes.length)
  assert.equal(readdirSync(join(installRoot, 'versions')).length, 1)
  assert.equal(existsSync(join(installRoot, '.map-installing')), false)
})

test('target-local install sidecars retain root-relative payload paths', async t => {
  const pkg = await makePackage(t)
  renameSync(join(pkg.packageRoot, INSTALL_MANIFEST_FILE), join(pkg.packageRoot, pkg.target, INSTALL_MANIFEST_FILE))
  const { installRoot } = await install(t, pkg)
  assert.equal((await verifyManagedInstallation(installRoot)).ok, true)
})

test('malformed independent identity, duplicate flags, and empty roots fail without writes', async t => {
  const pkg = await makePackage(t)
  const context = { homedir: fakeHome(t), cwd: repo, env: {} }
  const expectedPath = join(temp(t), 'expected.json')
  writeFileSync(expectedPath, JSON.stringify(pkg.expected))
  const inputs = [
    ['--install-root', ''],
    ['--install-root', join(temp(t), 'one'), '--install-root', join(temp(t), 'two')],
    ['--expected', expectedPath],
  ]
  for (const flags of inputs) {
    const result = await mainManage(['install', '--package-root', pkg.packageRoot, '--expected', expectedPath, ...flags], context)
    assert.equal(result.json.error.code, 'MAP_INSTALL_INPUT')
  }
  const candidateIdentity = join(pkg.packageRoot, 'expected.json')
  writeFileSync(candidateIdentity, JSON.stringify(pkg.expected))
  const result = await mainManage(['install', '--package-root', pkg.packageRoot, '--expected', candidateIdentity], context)
  assert.equal(result.json.error.code, 'MAP_INSTALL_INPUT')
})

test('uninstall-map.sh forwards to the maintenance entry without deleting the installation', { skip: process.platform === 'win32' ? 'POSIX shell entry' : false }, async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await install(t, pkg)
  const archive = archiveFixture(t, pkg)
  const before = inventory(installRoot)
  const dry = spawnSync('sh', [join(archive, 'uninstall-map.sh'), '--install-root', installRoot, '--dry-run'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  })
  assert.equal(dry.status, 0, dry.stderr || dry.stdout)
  assert.match(dry.stdout, /dry-run/u)
  assert.deepEqual(inventory(installRoot), before)
})
