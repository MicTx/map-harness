/** Managed maintenance: update, rollback, uninstall, maintenance locks, and receipts on real trees. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createInstallDescriptor, createInstallManifest, INSTALL_MANIFEST_FILE, MapInstallError } from '../bin/install-manifest.mjs'
import { MAP_IDENTITY_REVISION, prepareMapInstance, resolveMapInstance } from '../bin/instance-home.mjs'
import {
  ACTIVE_SLOT, INSTALLATION_MARKER, RECEIPTS_DIRECTORY, SLOTS_DIRECTORY, VERSIONS_DIRECTORY,
  detectHostTarget, inspectManagedInstall,
} from '../bin/install-layout.mjs'
import {
  compareCompatibility, runManagedInstall, runManagedRollback, runManagedUninstall, runManagedUpdate,
  verifyManagedInstallation, withMaintenanceLease,
} from '../bin/install-transaction.mjs'
import { buildWindowsTransactionRequest, executeTransactionWorker, runWindowsTransactionWorker } from '../bin/windows-transaction.mjs'
import { mainManage, MANAGE_EXIT } from '../bin/manage.mjs'

const repo = join(import.meta.dirname, '../..')
const hostTarget = detectHostTarget()
const targets = ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const otherTarget = targets.find(target => target !== hostTarget)
const compatibility = {
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
  const root = mkdtempSync(join(tmpdir(), 'map-managed-maintenance-'))
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
  const target = options.target ?? hostTarget
  const sourceDigest = options.sourceDigest ?? 'a'.repeat(64)
  const dataCompatibility = options.compatibility ?? compatibility
  const buildRoot = buildBuildRoot(t, version)
  const windows = target.startsWith('win-')
  const executable = windows ? 'map-harness.exe' : 'map-harness'
  const serviceBytes = windows ? Buffer.from('native fixture\n')
    : Buffer.from(`#!/bin/sh\nif [ "\${1:-}" = "--application-info" ]; then printf '{"version":"${version}"}\\n'; exit 0; fi\nexit 1\n`)
  const licenseBytes = Buffer.from(`license fixture ${version}\n`)
  const record = {
    format: 'map-harness-native-1', version, target, sourceDigest,
    engine: { node: 'v24.21.0', platform: { mac: 'darwin', linux: 'linux', win: 'win32' }[target.split('-')[0]], arch: target.split('-')[1] },
    executable, sha256: sha256(serviceBytes), sourceCoreFiles: 0,
    webService: { format: 1, mode: 'web', profile: 'map-web' },
    install: createInstallDescriptor({ distribution: 'managed', channel: 'stable', dataCompatibility }),
  }
  const recordBytes = json(record)
  const files = [
    { path: 'LICENSE', role: 'license', target: null, executable: false, sha256: sha256(licenseBytes) },
    { path: `${target}/${executable}`, role: 'service', target, executable: true, sha256: sha256(serviceBytes) },
    { path: `${target}/application.json`, role: 'build-record', target, executable: false, sha256: sha256(recordBytes) },
  ]
  const payload = {
    format: 1, product: 'map-harness', version, targets: [{ target, record: `${target}/application.json` }],
    supportedTargets: [target], unsupportedTargets: targets.filter(item => item !== target), files,
  }
  const payloadBytes = json(payload)
  const manifest = await createInstallManifest({
    root: buildRoot, distribution: 'managed', channel: 'stable', target, sourceDigest,
    payloadManifestBytes: payloadBytes, buildRecordBytes: { [target]: recordBytes },
  })
  const packageRoot = join(temp(t), 'package')
  write(packageRoot, 'LICENSE', licenseBytes)
  write(packageRoot, `${target}/${executable}`, serviceBytes)
  write(packageRoot, `${target}/application.json`, recordBytes)
  write(packageRoot, 'web-service-manifest.json', payloadBytes)
  write(packageRoot, INSTALL_MANIFEST_FILE, json(manifest))
  return {
    packageRoot, manifest, payload, version, target, sourceDigest, serviceBytes,
    expected: { product: 'map-harness', distribution: 'managed', channel: 'stable', target, version,
      identityRevision: MAP_IDENTITY_REVISION, sourceDigest, payloadSha256: sha256(payloadBytes) },
  }
}

function fakeHome(t) {
  const home = join(temp(t), 'home')
  mkdirSync(home, { recursive: true })
  return home
}

function prepareDataHome(t, home, options = {}) {
  const dataHome = options.dataHome ?? join(temp(t), 'data home')
  const spec = resolveMapInstance({
    env: { MAPHARNESS_HOME: dataHome }, homedir: home, mode: 'release', channel: 'stable',
    distribution: 'managed', installRoots: options.installRoots ?? [],
  })
  if (options.initialize === false) {
    if (options.createDirectory === true) mkdirSync(dataHome, { recursive: true })
    return { dataHome, spec: null }
  }
  return { dataHome, spec: prepareMapInstance(spec) }
}

async function installBase(t, pkg, options = {}) {
  const home = options.home ?? fakeHome(t)
  const base = temp(t)
  const installRoot = options.installRoot ?? join(base, 'Map Harness')
  const data = prepareDataHome(t, home, { installRoots: [installRoot], dataHome: options.dataHome })
  const receipt = await runManagedInstall({
    packageRoot: pkg.packageRoot, installRoot, expected: pkg.expected, dataHome: data.dataHome,
    homedir: home, env: { MAPHARNESS_HOME: data.dataHome },
  }, options.installDeps ?? {})
  return { installRoot, home, dataHome: data.dataHome, receipt }
}

async function installAndUpdate(t, options = {}) {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: options.firstDigest ?? 'a'.repeat(64) })
  const installed = await installBase(t, first, options)
  const second = await makePackage(t, { version: '1.2.4', sourceDigest: 'b'.repeat(64), compatibility: options.compatibility })
  const update = await runManagedUpdate({
    packageRoot: second.packageRoot, installRoot: installed.installRoot, expected: second.expected,
    homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome },
  }, options.deps ?? {})
  return { ...installed, first, second, update }
}

function fails(code) {
  return error => {
    assert.ok(error instanceof MapInstallError, `expected MapInstallError, got ${error}`)
    assert.equal(error.code, code)
    return true
  }
}

function receipts(installRoot) {
  return readdirSync(join(installRoot, RECEIPTS_DIRECTORY)).filter(name => name.endsWith('.json'))
}

test('update publishes a new immutable payload, flips the slot, and keeps the previous version', async t => {
  const { installRoot, first, second, update } = await installAndUpdate(t)
  assert.equal(update.state, 'committed')
  assert.equal(update.result, 'updated')
  assert.equal(update.previousVersion, '1.2.3')
  assert.equal(update.targetVersion, '1.2.4')
  const layout = inspectManagedInstall(installRoot)
  assert.equal(layout.state, 'ready')
  assert.equal(layout.marker.version, '1.2.4')
  assert.equal(layout.activeSlot, 'B')
  assert.deepEqual(layout.versions.sort(), [`1.2.3-${first.sourceDigest}`, `1.2.4-${second.sourceDigest}`].sort())
  const health = await verifyManagedInstallation(installRoot)
  assert.equal(health.ok, true)
  assert.equal(health.version, '1.2.4')
  assert.equal(receipts(installRoot).length, 2)
})

test('repeating the same update is a no-op and rewrites no payload', async t => {
  const { installRoot, second } = await installAndUpdate(t)
  const before = readdirSync(join(installRoot, VERSIONS_DIRECTORY)).sort()
  const again = await runManagedUpdate({
    packageRoot: second.packageRoot, installRoot, expected: second.expected,
    homedir: fakeHome(t), env: {},
  })
  assert.equal(again.state, 'committed')
  assert.equal(again.result, 'no-op')
  assert.deepEqual(readdirSync(join(installRoot, VERSIONS_DIRECTORY)).sort(), before)
})

test('update refuses downgrade, changed compatibility, and same-version different bytes', async t => {
  const { installRoot, first, second, home } = await installAndUpdate(t)
  assert.throws(() => compareCompatibility({ dataCompatibility: compatibility }, { dataCompatibility: { ...compatibility, sessionFormat: 5 } }), fails('MAP_DATA_INCOMPATIBLE'))
  const lower = await makePackage(t, { version: '1.2.2', sourceDigest: 'd'.repeat(64) })
  await assert.rejects(runManagedUpdate({ packageRoot: lower.packageRoot, installRoot, expected: lower.expected, homedir: home, env: {} }), fails('MAP_INSTALL_INPUT'))
  const sameVersion = await makePackage(t, { version: '1.2.4', sourceDigest: 'e'.repeat(64) })
  await assert.rejects(runManagedUpdate({ packageRoot: sameVersion.packageRoot, installRoot, expected: sameVersion.expected, homedir: home, env: {} }), fails('MAP_VERSION_CONFLICT'))
  assert.equal(inspectManagedInstall(installRoot).marker.version, '1.2.4')
})

test('a busy data-root kernel lock blocks update without touching the program', async t => {
  const { installRoot, second, home, dataHome } = await installAndUpdate(t)
  const before = readdirSync(join(installRoot, VERSIONS_DIRECTORY)).sort()
  const holder = spawn(process.execPath, ['-e', `
    import { resolveMapInstance, prepareMapInstance } from ${JSON.stringify(join(repo, 'map/bin/instance-home.mjs'))}
    import { acquireInstanceLock } from ${JSON.stringify(join(repo, 'map/bin/instance-lock.mjs'))}
    const spec = resolveMapInstance({ env: { MAPHARNESS_HOME: ${JSON.stringify(dataHome)} }, homedir: ${JSON.stringify(home)}, mode: 'release', channel: 'stable', distribution: 'managed', installRoots: [${JSON.stringify(installRoot)}] })
    const instance = prepareMapInstance(spec)
    const lease = await acquireInstanceLock(instance, { version: '0.0.0-test' })
    console.log('locked')
    setTimeout(() => process.exit(0), 60000)
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', value => String(value).includes('locked') ? resolve() : reject(new Error('lock holder did not start')))
      holder.once('error', reject)
      holder.stderr.on('data', value => reject(new Error(String(value))))
      setTimeout(() => reject(new Error('lock holder timed out')), 10000)
    })
    const third = await makePackage(t, { version: '1.2.5', sourceDigest: 'f'.repeat(64) })
    await assert.rejects(runManagedUpdate({ packageRoot: third.packageRoot, installRoot, expected: third.expected, homedir: home, env: {} }), fails('MAP_INSTANCE_BUSY'))
    assert.deepEqual(readdirSync(join(installRoot, VERSIONS_DIRECTORY)).sort(), before)
  } finally {
    holder.kill()
    await new Promise(resolve => { holder.once('exit', resolve); setTimeout(resolve, 10000).unref?.() })
  }
})

test('an uninitialized data home is visible to dry-run and refused for apply', async t => {
  const { installRoot, second, home, dataHome } = await installAndUpdate(t)
  rmSync(dataHome, { recursive: true, force: true })
  mkdirSync(dataHome)
  const third = await makePackage(t, { version: '1.2.5', sourceDigest: '3'.repeat(64) })
  const dry = await runManagedUpdate({ packageRoot: third.packageRoot, installRoot, expected: third.expected, homedir: home, env: {}, dryRun: true })
  assert.equal(dry.result, 'dry-run')
  assert.equal(dry.uninitializedDataHome, true)
  await assert.rejects(runManagedUpdate({ packageRoot: third.packageRoot, installRoot, expected: third.expected, homedir: home, env: {} }), fails('MAP_DATA_UNKNOWN'))
})

test('a failed health check reverts the slot and keeps the old payload active', async t => {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: 'a'.repeat(64) })
  const installed = await installBase(t, first)
  const second = await makePackage(t, { version: '1.2.4', sourceDigest: 'b'.repeat(64) })
  const receipt = await runManagedUpdate({
    packageRoot: second.packageRoot, installRoot: installed.installRoot, expected: second.expected,
    homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome },
  }, { health: async () => ({ ok: false, detail: { reason: 'fixture' } }) })
  assert.equal(receipt.state, 'health-failed')
  const layout = inspectManagedInstall(installed.installRoot)
  assert.equal(layout.state, 'ready')
  assert.equal(layout.marker.version, '1.2.3')
  assert.equal(layout.activeSlot, 'A')
})

test('rollback reselects a registered older payload and refuses unknown targets', async t => {
  const { installRoot, first, second, home, dataHome } = await installAndUpdate(t)
  const rollback = await runManagedRollback({ installRoot, version: '1.2.3', homedir: home, env: { MAPHARNESS_HOME: dataHome } })
  assert.equal(rollback.state, 'committed')
  assert.equal(rollback.result, 'rolled-back')
  const layout = inspectManagedInstall(installRoot)
  assert.equal(layout.marker.version, '1.2.3')
  assert.equal(layout.activeSlot, 'A')
  const noop = await runManagedRollback({ installRoot, version: '1.2.3', homedir: home, env: { MAPHARNESS_HOME: dataHome } })
  assert.equal(noop.result, 'no-op')
  await assert.rejects(runManagedRollback({ installRoot, version: '9.9.9', homedir: home, env: {} }), fails('MAP_INSTALL_INPUT'))
  await assert.rejects(runManagedRollback({ installRoot, version: '1.2.4', homedir: home, env: {} }), fails('MAP_INSTALL_INPUT'))
})

test('update garbage-collects versions beyond active and previous, reporting cleanup', async t => {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: 'a'.repeat(64) })
  const installed = await installBase(t, first)
  for (const version of ['1.2.4', '1.2.5']) {
    const pkg = await makePackage(t, { version, sourceDigest: version === '1.2.4' ? 'b'.repeat(64) : 'c'.repeat(64) })
    await runManagedUpdate({ packageRoot: pkg.packageRoot, installRoot: installed.installRoot, expected: pkg.expected,
      homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome } })
  }
  const versions = readdirSync(join(installed.installRoot, VERSIONS_DIRECTORY)).sort()
  assert.equal(versions.length, 2)
  assert.ok(versions.some(name => name.startsWith('1.2.5-')))
  assert.ok(versions.some(name => name.startsWith('1.2.4-')))
})

test('maintenance lease is kernel-held and a second holder is busy', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await installBase(t, pkg)
  const release = await withMaintenanceLease(installRoot)
  await assert.rejects(withMaintenanceLease(installRoot), fails('MAP_INSTALL_BUSY'))
  await release()
  const again = await withMaintenanceLease(installRoot)
  await again()
})

test('uninstall preserves unknown content and never touches the data home', async t => {
  const pkg = await makePackage(t)
  const { installRoot, dataHome } = await installBase(t, pkg)
  writeFileSync(join(installRoot, 'user-notes.txt'), 'keep me\n')
  await assert.rejects(runManagedUninstall({ installRoot, homedir: fakeHome(t), env: {} }), fails('MAP_INSTALL_REFUSED'))
  assert.equal(readFileSync(join(installRoot, 'user-notes.txt'), 'utf8'), 'keep me\n')
  rmSync(join(installRoot, 'user-notes.txt'))
  const receipt = await runManagedUninstall({ installRoot, homedir: fakeHome(t), env: {} })
  assert.equal(receipt.state, 'committed')
  assert.equal(receipt.result, 'uninstalled')
  assert.equal(inspectManagedInstall(installRoot).state, 'uninstalled')
  assert.ok(existsSync(join(installRoot, 'receipts')))
  assert.ok(existsSync(dataHome))
})

test('uninstall dry-run lists preserved entries without deleting anything', async t => {
  const pkg = await makePackage(t)
  const { installRoot } = await installBase(t, pkg)
  writeFileSync(join(installRoot, 'keep.txt'), 'x')
  const before = readdirSync(installRoot).sort()
  const receipt = await runManagedUninstall({ installRoot, dryRun: true, homedir: fakeHome(t), env: {} })
  assert.equal(receipt.result, 'dry-run')
  assert.deepEqual(receipt.preserved, ['keep.txt'])
  assert.deepEqual(readdirSync(installRoot).sort(), before)
})

test('uninstall of an absent or empty root is a structured refusal without a receipt', async t => {
  const home = fakeHome(t)
  const absent = join(temp(t), 'absent root')
  await assert.rejects(runManagedUninstall({ installRoot: absent, dryRun: true, homedir: home, env: {} }), fails('MAP_INSTALL_STATE'))
  const empty = join(temp(t), 'empty root')
  mkdirSync(empty)
  await assert.rejects(runManagedUninstall({ installRoot: empty, dryRun: true, homedir: home, env: {} }), fails('MAP_INSTALL_STATE'))
  const context = { homedir: home, cwd: repo, env: { MAPHARNESS_INSTALL_ROOT: empty } }
  const result = await mainManage(['uninstall', '--dry-run', '--json'], context)
  assert.equal(result.exitCode, MANAGE_EXIT.conflict)
  assert.equal(result.json.error.code, 'MAP_INSTALL_STATE')
})

test('uninstall is blocked by a locked data home', async t => {
  const pkg = await makePackage(t)
  const { installRoot, dataHome, home } = await installBase(t, pkg)
  const release = await (async () => {
    const { spec } = prepareDataHome(t, home, { installRoots: [installRoot], dataHome })
    const { acquireInstanceLock } = await import('../bin/instance-lock.mjs')
    return acquireInstanceLock({ ...spec, instanceId: spec.instanceId }, { version: '0.0.0-test' })
  })()
  try {
    await assert.rejects(runManagedUninstall({ installRoot, homedir: home, env: { MAPHARNESS_HOME: dataHome } }), fails('MAP_INSTANCE_BUSY'))
  } finally {
    await release.release()
  }
})

test('windows transaction worker waits for the out-of-tree result and rejects mismatches', async t => {
  const { EventEmitter } = await import('node:events')
  const envelope = buildWindowsTransactionRequest({ operation: 'uninstall', installRoot: join(temp(t), 'root'), payload: {} })
  const fakeWorker = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = 0
    child.killed = false
    child.kill = () => { child.exitCode = 1 }
    return child
  }
  const result = await runWindowsTransactionWorker({ executable: process.execPath, envelope }, {
    spawn: fakeWorker,
    waitForResult: async (path) => {
      writeFileSync(path, JSON.stringify({ format: 'map-harness-windows-transaction-1', requestId: envelope.requestId, error: null, workerExit: { code: 0, signal: null } }))
      return JSON.parse(readFileSync(path, 'utf8'))
    },
  })
  assert.equal(result.requestId, envelope.requestId)
  await assert.rejects(runWindowsTransactionWorker({ executable: process.execPath, envelope }, {
    spawn: fakeWorker,
    waitForResult: async (path) => {
      writeFileSync(path, JSON.stringify({ format: 'map-harness-windows-transaction-1', requestId: '00000000-0000-4000-8000-000000000000', error: null }))
      return JSON.parse(readFileSync(path, 'utf8'))
    },
  }), fails('MAP_INSTALL_STATE'))
})

test('update from a checksum-verified archive extracts into a temporary root', async t => {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: 'a'.repeat(64) })
  const installed = await installBase(t, first)
  const pkg = await makePackage(t, { version: '1.2.5', sourceDigest: '7'.repeat(64) })
  const parent = temp(t)
  const packageName = `map-harness-v${pkg.version}-web-${pkg.target}`
  const tree = join(parent, packageName)
  mkdirSync(tree, { recursive: true })
  for (const path of ['LICENSE', `${pkg.target}/map-harness`, `${pkg.target}/application.json`, 'web-service-manifest.json', INSTALL_MANIFEST_FILE]) {
    mkdirSync(dirname(join(tree, path)), { recursive: true })
    copyFileSync(join(pkg.packageRoot, path), join(tree, path))
  }
  const archive = join(parent, `${packageName}.tar.gz`)
  const tar = spawnSync('tar', ['-czf', archive, '-C', parent, packageName], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const checksums = join(parent, 'checksums.json')
  writeFileSync(checksums, JSON.stringify({
    format: 'map-harness-update-checksums-1', archiveSha256: sha256(readFileSync(archive)), packageName,
    maxBytes: 8 * 1024 * 1024,
    files: ['LICENSE', `${pkg.target}/map-harness`, `${pkg.target}/application.json`],
    expected: pkg.expected,
  }))
  const receipt = await runManagedUpdate({ archive, checksums, installRoot: installed.installRoot,
    homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome } })
  assert.equal(receipt.state, 'committed')
  assert.equal(receipt.targetVersion, '1.2.5')
  assert.equal(inspectManagedInstall(installed.installRoot).marker.version, '1.2.5')
})

test('garbage collection failure reports cleanup-pending without failing the update', async t => {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: 'a'.repeat(64) })
  const installed = await installBase(t, first)
  for (const version of ['1.2.4']) {
    const pkg = await makePackage(t, { version, sourceDigest: 'b'.repeat(64) })
    await runManagedUpdate({ packageRoot: pkg.packageRoot, installRoot: installed.installRoot, expected: pkg.expected,
      homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome } })
  }
  const stale = join(installed.installRoot, VERSIONS_DIRECTORY, `1.2.2-${'9'.repeat(64)}`)
  mkdirSync(stale)
  writeFileSync(join(stale, 'file'), 'x')
  chmodSync(stale, 0o500)
  try {
    const third = await makePackage(t, { version: '1.2.6', sourceDigest: 'c'.repeat(64) })
    const receipt = await runManagedUpdate({ packageRoot: third.packageRoot, installRoot: installed.installRoot,
      expected: third.expected, homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome } })
    assert.equal(receipt.state, 'cleanup-pending')
    assert.ok(receipt.cleanupEntries.some(entry => entry.name === `1.2.2-${'9'.repeat(64)}`))
  } finally {
    chmodSync(stale, 0o700)
  }
})

test('a post-switch failure records outcome-unknown instead of claiming success', async t => {
  const first = await makePackage(t, { version: '1.2.3', sourceDigest: 'a'.repeat(64) })
  const installed = await installBase(t, first)
  const second = await makePackage(t, { version: '1.2.4', sourceDigest: 'b'.repeat(64) })
  await assert.rejects(runManagedUpdate({
    packageRoot: second.packageRoot, installRoot: installed.installRoot, expected: second.expected,
    homedir: installed.home, env: { MAPHARNESS_HOME: installed.dataHome },
  }, { health: async () => { throw new Error('health probe crashed') } }), fails('MAP_INSTALL_IO'))
  const receiptsNow = receipts(installed.installRoot).map(file => JSON.parse(readFileSync(join(installed.installRoot, RECEIPTS_DIRECTORY, file))))
  assert.ok(receiptsNow.some(receipt => receipt.state === 'outcome-unknown'))
})

test('the external transaction worker executes a request envelope end to end', async t => {
  const { installRoot, second, home, dataHome } = await installAndUpdate(t)
  const third = await makePackage(t, { version: '1.2.6', sourceDigest: '5'.repeat(64) })
  const work = temp(t)
  const envelope = buildWindowsTransactionRequest({ operation: 'update', installRoot,
    request: { installRoot, packageRoot: third.packageRoot, expected: third.expected, homedir: home,
      env: { MAPHARNESS_HOME: dataHome } } })
  const requestPath = join(work, 'request.json')
  const resultPath = join(work, 'result.json')
  writeFileSync(requestPath, JSON.stringify(envelope))
  const result = await executeTransactionWorker(requestPath, resultPath, {
    waitForOwnedExit: async () => {},
    platform: process.platform,
  })
  assert.equal(result.requestId, envelope.requestId)
  assert.equal(result.receipt.state, 'committed')
  assert.equal(inspectManagedInstall(installRoot).marker.version, '1.2.6')
  assert.equal(inspectManagedInstall(installRoot).state, 'ready')
  const failure = buildWindowsTransactionRequest({ operation: 'rollback', installRoot,
    request: { installRoot, version: '9.9.9', homedir: home, env: {} } })
  const failurePath = join(work, 'failure.json')
  writeFileSync(failurePath, JSON.stringify(failure))
  await assert.rejects(executeTransactionWorker(failurePath, join(work, 'failure-result.json'), {
    waitForOwnedExit: async () => {}, platform: process.platform,
  }), fails('MAP_INSTALL_INPUT'))
})

test('Windows operations delegate to the external worker instead of replacing files in place', async t => {
  const { installRoot, second, home, dataHome } = await installAndUpdate(t)
  const third = await makePackage(t, { version: '1.2.7', sourceDigest: '4'.repeat(64) })
  let envelope
  const delegated = await runManagedUpdate({
    packageRoot: third.packageRoot, installRoot, expected: third.expected,
    homedir: home, env: { MAPHARNESS_HOME: dataHome },
  }, { platform: 'win32', worker: async request => {
    envelope = request
    return { state: 'committed', result: 'worker', operationId: request.requestId }
  } })
  assert.equal(delegated.result, 'worker')
  assert.equal(envelope.request.operation, 'update')
  assert.equal(envelope.request.installRoot, installRoot)
  assert.equal(inspectManagedInstall(installRoot).marker.version, '1.2.4')
})

test('manage wires update, rollback, and uninstall as structured results', async t => {
  const { installRoot, first, second, home, dataHome } = await installAndUpdate(t)
  const context = { homedir: home, cwd: repo, env: { MAPHARNESS_INSTALL_ROOT: installRoot } }
  const status = await mainManage(['status', '--json'], context)
  assert.equal(status.json.state, 'ready')
  const rollback = await mainManage(['rollback', '--to', '1.2.3', '--json'], context)
  assert.equal(rollback.exitCode, 0)
  assert.equal(rollback.json.result, 'rolled-back')
  const uninstallDry = await mainManage(['uninstall', '--dry-run', '--json'], context)
  assert.equal(uninstallDry.json.result, 'dry-run')
  const updateMissing = await mainManage(['update', '--json'], context)
  assert.equal(updateMissing.json.error.code, 'MAP_INSTALL_INPUT')
})
