import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { unzipSync } from 'fflate'
import { assertSourceOffers, assertWebServiceApplications, packWebService } from '../bin/pack-web-service.mjs'

const repo = join(import.meta.dirname, '../..')
const sha = value => createHash('sha256').update(value).digest('hex')

function nativeBytes(target) {
  const bytes = Buffer.alloc(256)
  if (target.startsWith('linux-')) {
    bytes.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
    bytes.writeUInt16LE(62, 18)
  } else if (target.startsWith('win-')) {
    bytes.writeUInt16LE(0x5a4d, 0)
    bytes.writeUInt32LE(0x80, 0x3c)
    bytes.writeUInt32LE(0x4550, 0x80)
    bytes.writeUInt16LE(0x8664, 0x84)
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
  }
  return bytes
}

function executableFixture(directory, target) {
  mkdirSync(directory, { recursive: true })
  const stem = `map-harness-v0.1.13-${target}`
  const suffix = target.startsWith('win-') ? '.exe' : ''
  const executable = join(directory, stem + suffix)
  const bytes = nativeBytes(target)
  writeFileSync(executable, bytes)
  chmodSync(executable, 0o755)
  const helperRoles = target.startsWith('mac-') ? ['rg', 'spawn-helper'] : ['rg']
  const resources = {}, resourcePaths = {}
  for (const role of helperRoles) {
    const helper = join(directory, `${stem}-${role}${suffix}`)
    writeFileSync(helper, `${target} ${role} helper\n`)
    chmodSync(helper, 0o755)
    resources[role] = { file: `${stem}-${role}${suffix}`, sha256: sha(readFileSync(helper)) }
    resourcePaths[role] = helper
  }
  const notices = `${stem}.licenses.txt`
  writeFileSync(join(directory, notices), 'MIT license notice\n')
  const recordPath = join(directory, `${stem}.json`)
  const record = {
    format: 'map-harness-native-1', version: '0.1.13', target,
    engine: { node: 'v24.21.0', platform: target.startsWith('mac-') ? 'darwin' : target.startsWith('win-') ? 'win32' : 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64' },
    executable: basename(executable), sha256: sha(bytes), webService: { format: 1, mode: 'web', profile: 'map-web' },
    coreModules: 1, sourceCoreFiles: 0, notices, noticesSha256: sha(readFileSync(join(directory, notices))),
    resources, sourceDigest: 'a'.repeat(64), smokes: { config: true, worker: true, system: true, terminal: true },
  }
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  return { executable, recordPath, noticesPath: join(directory, notices), resourcePaths, ...record }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-web-service-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'map/release'), { recursive: true })
  mkdirSync(join(root, '.dsh-build'), { recursive: true })
  mkdirSync(join(root, 'scripts/primary-runtime'), { recursive: true })
  writeFileSync(join(root, 'map/release/version.json'), '{"version":"0.1.13"}\n')
  writeFileSync(join(root, '.dsh-build/map-public-release.json'), JSON.stringify({ sources: { sha256: 'a'.repeat(64) } }))
  copyFileSync(join(repo, 'map/release/web-service.json'), join(root, 'map/release/web-service.json'))
  copyFileSync(join(repo, 'map/release/source-offers.md'), join(root, 'map/release/source-offers.md'))
  for (const name of ['start-web.sh', 'start-web.cmd', 'start-web.ps1']) {
    copyFileSync(join(repo, 'map/release', name), join(root, 'map/release', name))
  }
  mkdirSync(join(root, 'map/release/public'), { recursive: true })
  copyFileSync(join(repo, 'map/release/public/README.md'), join(root, 'map/release/public/README.md'))
  copyFileSync(join(repo, 'map/release/public/README.zh.md'), join(root, 'map/release/public/README.zh.md'))
  copyFileSync(join(repo, 'scripts/primary-runtime/lock.json'), join(root, 'scripts/primary-runtime/lock.json'))
  writeFileSync(join(root, 'LICENSE'), 'Map license\n')
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'Third-party notices\n')
  const macDirectory = join(root, 'mac')
  const mac = executableFixture(macDirectory, 'mac-arm64')
  return { root, macDirectory, mac }
}

function pack(item, out = join(item.root, 'out')) {
  return packWebService({ root: item.root, applicationDirectories: [item.macDirectory], out })
}

test('the script package carries a full manifest and accepted target payload', async t => {
  const item = fixture(t)
  const result = await pack(item)
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'))
  assert.equal(manifest.format, 1)
  assert.equal(manifest.product, 'map-harness')
  assert.equal(manifest.version, '0.1.13')
  assert.deepEqual(manifest.supportedTargets, ['mac-arm64'])
  assert.ok(manifest.unsupportedTargets.includes('win-x64'))
  assert.deepEqual(manifest.targets, [{ target: 'mac-arm64', record: 'mac-arm64/map-harness-v0.1.13-mac-arm64.json' }])
  assert.ok(manifest.files.every(row => new Set(['path', 'role', 'target', 'executable', 'sha256']).size === Object.keys(row).length))
  assert.equal(manifest.files.some(row => row.path === 'web-service-manifest.json'), false)
  assert.equal(manifest.files.filter(row => row.role === 'service').length, 1)
  const roles = Object.fromEntries(manifest.files.map(row => [row.path, row.role]))
  assert.equal(roles.LICENSE, 'license')
  assert.equal(roles['THIRD_PARTY_NOTICES.md'], 'third-party-notices')
  assert.equal(roles['THIRD_PARTY_SOURCE_OFFERS.md'], 'source-offer')
})

test('macOS tar preserves launchers, service and helper execution bits', async t => {
  const item = fixture(t)
  const result = await pack(item)
  const extracted = join(item.root, 'extracted')
  mkdirSync(extracted)
  const extractedRun = spawnSync('tar', ['-xzf', result.archive, '-C', extracted], { encoding: 'utf8' })
  assert.equal(extractedRun.status, 0, extractedRun.stderr)
  const root = join(extracted, 'map-harness-v0.1.13-web-mac-arm64')
  for (const file of ['start-web.sh', 'mac-arm64/map-harness-v0.1.13-mac-arm64', 'mac-arm64/map-harness-v0.1.13-mac-arm64-rg']) {
    assert.equal((readFileSync(join(root, file)) && statMode(join(root, file))) & 0o111, 0o111, file)
  }
})

function statMode(path) {
  return parseInt(spawnSync('/usr/bin/stat', ['-f', '%p', path], { encoding: 'utf8' }).stdout.trim(), 8)
}

test('repeated packing produces identical archive and manifest bytes', async t => {
  const item = fixture(t)
  const first = await pack(item, join(item.root, 'first'))
  const second = await pack(item, join(item.root, 'second'))
  assert.equal(first.archiveSha256, second.archiveSha256)
  assert.equal(first.manifestSha256, second.manifestSha256)
})

test('changed native bytes, mixed builds, and non-web records reject', async t => {
  const changed = fixture(t)
  const changedBytes = nativeBytes('mac-arm64')
  changedBytes[120] = 1
  writeFileSync(join(changed.macDirectory, changed.mac.executable), changedBytes)
  await assert.rejects(() => pack(changed), /Native application changed/u)

  const mixed = fixture(t)
  const other = executableFixture(join(mixed.root, 'other'), 'mac-arm64')
  other.version = '0.1.12'
  assert.throws(() => assertWebServiceApplications([mixed.mac, other], '0.1.13'), /share the product version/u)
  const nonWeb = fixture(t)
  nonWeb.mac.webService = { format: 1, mode: 'desktop', profile: 'map-desktop' }
  assert.throws(() => assertWebServiceApplications([nonWeb.mac], '0.1.13'), /not a web-only build/u)
})

test('package staging rejects development source and source-requiring licenses without offers', async t => {
  const source = fixture(t)
  writeFileSync(join(source.root, 'map/release/public/README.md'), 'sourceMappingURL=data:text/plain,source\n')
  await assert.rejects(() => pack(source), /embedded source map/u)
  assert.throws(() => assertSourceOffers('No offer', 'GNU General Public License'), /written source offer/u)
  assertSourceOffers('WRITTEN SOURCE OFFER: exact terms', 'GNU General Public License')
})

test('explicit multi-target packing records supported and unsupported targets', async t => {
  const item = fixture(t)
  const linuxDirectory = join(item.root, 'linux')
  const linux = executableFixture(linuxDirectory, 'linux-x64')
  const result = await packWebService({ root: item.root, applicationDirectories: [item.macDirectory, linuxDirectory], out: join(item.root, 'combined'), combined: true })
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'))
  assert.deepEqual(manifest.supportedTargets, ['linux-x64', 'mac-arm64'])
  assert.ok(!manifest.unsupportedTargets.includes('linux-x64'))
  assert.ok(linux.resourcePaths.rg)
})

test('Windows browser acceptance may be deferred to clean release qualification', async t => {
  const item = fixture(t)
  const windowsDirectory = join(item.root, 'windows')
  const windows = executableFixture(windowsDirectory, 'win-x64')
  chmodSync(join(windowsDirectory, windows.executable), 0o644)
  chmodSync(windows.resourcePaths.rg, 0o644)
  writeFileSync(windows.recordPath, JSON.stringify({
    ...windows,
    deferredBrowserCheck: true,
    resourcePaths: undefined,
    path: undefined,
  }, null, 2) + '\n')
  const result = await packWebService({
    root: item.root,
    applicationDirectories: [windowsDirectory],
    out: join(item.root, 'windows-release'),
  })
  assert.match(result.archive, /-win-x64\.zip$/u)
  assert.deepEqual(result.supportedTargets, ['win-x64'])
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'))
  for (const role of ['service', 'helper:rg']) {
    assert.equal(manifest.files.find(row => row.role === role)?.executable, true, role)
  }
})
