import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { zipSync } from 'fflate'
import { c as createTarArchive } from 'tar'
import { collectWebServiceRelease } from '../bin/collect-web-service-release.mjs'
import { acceptedWebServiceMatrix, acceptedWebServiceRelease, copyWebServiceArtifacts, copyWebServiceMatrix } from '../bin/web-service-release.mjs'

const repo = join(import.meta.dirname, '../..')
const version = '0.1.13'
const sourceDigest = 'a'.repeat(64)
const digest = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'

function nativeBytes(target) {
  const bytes = Buffer.alloc(128)
  if (target.startsWith('linux-')) {
    bytes.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
    bytes.writeUInt16LE(target.endsWith('arm64') ? 183 : 62, 18)
  } else if (target.startsWith('mac-')) {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4)
  } else {
    bytes.writeUInt16LE(0x5a4d, 0)
    bytes.writeUInt32LE(64, 0x3c)
    bytes.writeUInt32LE(0x4550, 64)
    bytes.writeUInt16LE(0x8664, 68)
  }
  return bytes
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-web-release-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ['.dsh-build', 'map/release/public', 'scripts/primary-runtime']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, '.dsh-build/map-public-release.json'), json({ sources: { sha256: sourceDigest } }))
  writeFileSync(join(root, 'map/release/version.json'), json({ version }))
  copyFileSync(join(repo, 'map/release/web-service.json'), join(root, 'map/release/web-service.json'))
  copyFileSync(join(repo, 'scripts/primary-runtime/lock.json'), join(root, 'scripts/primary-runtime/lock.json'))
  for (const [path, text] of Object.entries({
    'LICENSE': 'License\n', 'THIRD_PARTY_NOTICES.md': 'Notices\n', 'map/release/source-offers.md': 'Source offers\n',
    'map/release/public/README.md': 'Readme\n', 'map/release/public/README.zh.md': 'Readme zh\n',
    'map/release/start-web.cmd': 'cmd\n', 'map/release/start-web.ps1': 'powershell\n', 'map/release/start-web.sh': 'shell\n',
  })) writeFileSync(join(root, path), text)
  return root
}

function createTarget(root, target, { extraFile = false, linkReadme = false, noLauncherExec = false, webServiceFormat = 1 } = {}) {
  const output = join(root, `input-${target}`)
  const packageName = `map-harness-v${version}-web-${target}`
  const stage = join(root, `stage-${target}`)
  const windows = target.startsWith('win-')
  const platform = target.startsWith('mac-') ? 'darwin' : windows ? 'win32' : 'linux'
  const architecture = target.split('-')[1]
  const stem = `map-harness-v${version}-${target}`
  const executable = `${stem}${windows ? '.exe' : ''}`
  const service = `${target}/${executable}`
  const recordFile = `${target}/${stem}.json`
  const notices = `${stem}.licenses.txt`
  const helperRoles = target.startsWith('mac-') ? ['rg', 'spawn-helper'] : ['rg']
  const resources = {}
  const files = []
  mkdirSync(join(stage, target), { recursive: true })
  mkdirSync(output)
  const add = (path, content, role, fileTarget, executableFile = false) => {
    writeFileSync(join(stage, path), content)
    if (executableFile) chmodSync(join(stage, path), 0o755)
    files.push({ path, role, target: fileTarget, executable: executableFile, sha256: digest(content) })
  }
  const serviceBytes = nativeBytes(target)
  add(service, serviceBytes, 'service', target, true)
  for (const role of helperRoles) {
    const file = `${stem}-${role}${windows ? '.exe' : ''}`
    const content = Buffer.from(`${target} ${role}\n`)
    add(`${target}/${file}`, content, `helper:${role}`, target, true)
    resources[role] = { file, sha256: digest(content) }
  }
  const noticesBytes = Buffer.from('MIT license notice\n')
  add(`${target}/${notices}`, noticesBytes, 'third-party-licenses', target)
  add('THIRD_PARTY_SOURCE_OFFERS.md', Buffer.from('Source offers\n'), 'source-offer', null)
  add('LICENSE', Buffer.from('License\n'), 'license', null)
  add('THIRD_PARTY_NOTICES.md', Buffer.from('Notices\n'), 'third-party-notices', null)
  add('README.md', Buffer.from(linkReadme ? '' : 'Readme\n'), 'readme', null)
  add('README.zh.md', Buffer.from('Readme zh\n'), 'readme', null)
  if (windows) {
    add('start-web.cmd', Buffer.from('cmd\n'), 'launcher', null, true)
    add('start-web.ps1', Buffer.from('powershell\n'), 'launcher', null)
  } else add('start-web.sh', Buffer.from('shell\n'), 'launcher', null, true)
  if (noLauncherExec && !windows) chmodSync(join(stage, 'start-web.sh'), 0o644)
  if (extraFile) add(`${target}/customer.txt`, Buffer.from('private\n'), 'readme', target)
  if (linkReadme && !windows) {
    rmSync(join(stage, 'README.md'))
    symlinkSync('../../outside', join(stage, 'README.md'))
  }
  const record = {
    format: 'map-harness-native-1', version, target, executable, sha256: digest(serviceBytes),
    engine: { node: 'v24.21.0', v8: 'test', platform, arch: architecture },
    webService: { format: webServiceFormat, mode: 'web', profile: 'map-web' },
    coreModules: 1, sourceCoreFiles: 0, notices, noticesSha256: digest(noticesBytes), resources, sourceDigest,
    smokes: { config: true, worker: true, system: true, terminal: true, mapBrowser: true },
  }
  const recordBytes = Buffer.from(json(record))
  add(recordFile, recordBytes, 'build-record', target)
  const lock = JSON.parse(readFileSync(join(root, 'scripts/primary-runtime/lock.json'), 'utf8'))
  const manifest = {
    format: 1, product: 'map-harness', version, targets: [{ target, record: recordFile }],
    supportedTargets: [target], unsupportedTargets: Object.keys(lock.targets).filter(item => item !== target).sort(), files,
  }
  const manifestBytes = Buffer.from(json(manifest))
  writeFileSync(join(stage, 'web-service-manifest.json'), manifestBytes)
  const archiveName = `${packageName}${windows ? '.zip' : '.tar.gz'}`
  const archive = join(output, archiveName)
  const paths = ['web-service-manifest.json', ...files.map(row => row.path)]
  if (windows) {
    writeFileSync(archive, zipSync(Object.fromEntries(paths.map(path => [`${packageName}/${path}`,
      linkReadme && path === 'README.md' ? [Buffer.alloc(0), { os: linkReadme === 'fat' ? 0 : 3, attrs: 0o120777 << 16 }] : readFileSync(join(stage, path))]))))
  } else {
    createTarArchive({ file: archive, cwd: stage, prefix: packageName, gzip: true, sync: true }, paths)
  }
  const qualification = {
    format: 'map-harness-web-qualification-1', product: 'map-harness', version, target, archive: archiveName,
    archiveSha256: digest(readFileSync(archive)), manifestSha256: digest(manifestBytes), buildRecordSha256: digest(recordBytes), sourceDigest,
    runtime: { platform, arch: architecture, node: 'v24.21.0', v8: 'test', cwdOutsideCheckout: true },
    checks: { browserScenario: { passed: true }, restartDataPreservation: { passed: true },
      cleanExit: { passed: true }, noResidualProcesses: { passed: true } },
  }
  writeFileSync(join(output, 'web-service-manifest.json'), manifestBytes)
  writeFileSync(join(output, 'web-service-qualification.json'), json(qualification))
  return { output, archive, manifest, qualification }
}

test('publisher accepts and copies a qualified script release chain', t => {
  const root = fixture(t)
  const input = createTarget(root, 'mac-arm64')
  const accepted = acceptedWebServiceRelease(root, input.output, version)
  assert.equal(accepted.qualification.target, 'mac-arm64')
  const files = copyWebServiceArtifacts(accepted, join(root, 'upload'))
  assert.deepEqual(files.map(file => basename(file)).sort(),
    [accepted.qualification.archive, 'web-service-manifest.json', 'web-service-qualification.json'].sort())
})

test('publisher rejects a failed runtime check and changed archive bytes', t => {
  const root = fixture(t)
  const clean = createTarget(root, 'mac-arm64')
  const stale = createTarget(root, 'linux-x64')
  clean.qualification.checks.cleanExit.passed = false
  writeFileSync(join(clean.output, 'web-service-qualification.json'), json(clean.qualification))
  assert.throws(() => acceptedWebServiceRelease(root, clean.output, version), /runtime qualification is incomplete/u)
  writeFileSync(stale.archive, 'changed')
  assert.throws(() => acceptedWebServiceRelease(root, stale.output, version), /hashes do not match/u)
})

test('publisher refuses an archive with an extra file even when every hash matches', t => {
  const root = fixture(t)
  const input = createTarget(root, 'mac-arm64', { extraFile: true })
  assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /unexpected|inventory/iu)
})

test('publisher refuses package documents that differ from the current checkout', t => {
  const root = fixture(t)
  const input = createTarget(root, 'mac-arm64')
  writeFileSync(join(root, 'map/release/public/README.md'), 'Different public README\n')
  assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /differs from the checkout/iu)
})

for (const target of ['mac-arm64', 'win-x64']) {
  test(`publisher refuses a symbolic link in a ${target} archive`, t => {
    const root = fixture(t)
    const input = createTarget(root, target, { linkReadme: true })
    assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /link|entry type/iu)
  })
}

test('publisher refuses ZIP symlink attributes even when the archive declares a FAT origin', t => {
  const root = fixture(t)
  const input = createTarget(root, 'win-x64', { linkReadme: 'fat' })
  writeFileSync(join(root, 'map/release/public/README.md'), '')
  assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /link|entry type/iu)
})

test('publisher refuses a non-executable Unix launcher even when its hash matches', t => {
  const root = fixture(t)
  const input = createTarget(root, 'mac-arm64', { noLauncherExec: true })
  assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /executable|permission/iu)
})

test('publisher refuses a build record with the wrong web service format', t => {
  const root = fixture(t)
  const input = createTarget(root, 'mac-arm64', { webServiceFormat: 2 })
  assert.throws(() => acceptedWebServiceRelease(root, input.output, version), /build record/iu)
})

test('collector emits reproducible target-specific files and checksums', t => {
  const root = fixture(t)
  const inputs = ['mac-arm64', 'linux-x64', 'linux-arm64'].map(target => createTarget(root, target).output)
  const first = collectWebServiceRelease({ root, inputs, out: join(root, 'release-a') })
  const second = collectWebServiceRelease({ root, inputs: [...inputs].reverse(), out: join(root, 'release-b') })
  const matrix = JSON.parse(readFileSync(join(first.directory, 'web-service-release.json'), 'utf8'))
  assert.deepEqual(matrix.targets.map(item => item.target), ['linux-arm64', 'linux-x64', 'mac-arm64'])
  assert.deepEqual(matrix.unsupportedTargets, ['mac-x64', 'win-x64'])
  assert.equal(matrix.sourceDigest, sourceDigest)
  assert.deepEqual(matrix.targets.map(({ target, platform, architecture, abi }) => ({ target, platform, architecture, abi })), [
    { target: 'linux-arm64', platform: 'linux', architecture: 'arm64', abi: 'gnu' },
    { target: 'linux-x64', platform: 'linux', architecture: 'x64', abi: 'gnu' },
    { target: 'mac-arm64', platform: 'darwin', architecture: 'arm64', abi: 'darwin' },
  ])
  for (const item of matrix.targets) {
    for (const [key, hash] of [['archive', 'archiveSha256'], ['manifest', 'manifestSha256'], ['qualification', 'qualificationSha256']]) {
      assert.ok(item[key].includes(item.target))
      assert.equal(digest(readFileSync(join(first.directory, item[key]))), item[hash])
    }
  }
  const names = readdirSync(first.directory).sort()
  assert.deepEqual(names, readdirSync(second.directory).sort())
  for (const name of names) assert.deepEqual(readFileSync(join(first.directory, name)), readFileSync(join(second.directory, name)))
  const sums = readFileSync(join(first.directory, 'SHASUMS256.txt'), 'utf8').trim().split('\n')
  assert.equal(sums.length, names.length - 1)
  assert.deepEqual(sums.map(line => line.slice(66)), names.filter(name => name !== 'SHASUMS256.txt'))
  for (const line of sums) assert.equal(line.slice(0, 64), digest(readFileSync(join(first.directory, line.slice(66)))))
})

test('collector rejects duplicate, missing, changed and mixed inputs without creating an output', t => {
  const root = fixture(t)
  const mac = createTarget(root, 'mac-arm64')
  const linux = createTarget(root, 'linux-x64')
  let count = 0
  const reject = (inputs, pattern) => {
    const out = join(root, `rejected-${count++}`)
    assert.throws(() => collectWebServiceRelease({ root, inputs, out }), pattern)
    assert.equal(existsSync(out), false)
  }
  reject([mac.output, mac.output], /duplicate target/iu)
  const manifest = join(linux.output, 'web-service-manifest.json')
  rmSync(manifest)
  reject([mac.output, linux.output], /manifest and qualification/iu)
  writeFileSync(manifest, json(linux.manifest))
  const qualification = join(linux.output, 'web-service-qualification.json')
  rmSync(qualification)
  reject([mac.output, linux.output], /manifest and qualification/iu)
  writeFileSync(qualification, json({ ...linux.qualification, version: '0.1.12' }))
  reject([mac.output, linux.output], /qualification hashes/iu)
  writeFileSync(qualification, json({ ...linux.qualification, sourceDigest: 'b'.repeat(64) }))
  reject([mac.output, linux.output], /stale/iu)
  writeFileSync(qualification, json(linux.qualification))
  writeFileSync(linux.archive, 'changed')
  reject([mac.output, linux.output], /hashes do not match/iu)
})

test('publisher validates and copies a matrix containing a Windows ZIP', t => {
  const root = fixture(t)
  const mac = createTarget(root, 'mac-arm64')
  const win = createTarget(root, 'win-x64')
  const release = collectWebServiceRelease({ root, inputs: [mac.output, win.output], out: join(root, 'release') })
  const accepted = acceptedWebServiceMatrix(root, release.directory, version)
  assert.deepEqual(accepted.manifest.targets.map(row => row.target), ['mac-arm64', 'win-x64'])
  const files = copyWebServiceMatrix(accepted, join(root, 'upload'))
  assert.deepEqual(files.map(file => basename(file)).sort(), readdirSync(release.directory).sort())
  for (const file of files) assert.deepEqual(readFileSync(file), readFileSync(join(release.directory, basename(file))))
})

for (const problem of ['missing-asset', 'changed-archive', 'changed-manifest', 'changed-qualification', 'missing-checksum',
  'wrong-checksum', 'duplicate-target', 'unknown-target', 'wrong-unsupported', 'wrong-runtime', 'wrong-engine', 'combined']) {
  test(`publisher rejects ${problem} before accepting a release matrix`, t => {
    const root = fixture(t)
    const mac = createTarget(root, 'mac-arm64')
    const release = collectWebServiceRelease({ root, inputs: [mac.output], out: join(root, 'release') })
    const matrixPath = join(release.directory, 'web-service-release.json')
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
    const row = matrix.targets[0]
    const checksumPath = join(release.directory, 'SHASUMS256.txt')
    if (problem === 'missing-asset') rmSync(join(release.directory, row.qualification))
    if (problem === 'changed-archive') writeFileSync(join(release.directory, row.archive), 'changed')
    if (problem === 'changed-manifest') writeFileSync(join(release.directory, row.manifest), 'changed')
    if (problem === 'changed-qualification') writeFileSync(join(release.directory, row.qualification), 'changed')
    if (problem === 'missing-checksum') rmSync(checksumPath)
    if (problem === 'wrong-checksum') writeFileSync(checksumPath, '0'.repeat(64) + '  wrong\n')
    if (problem === 'duplicate-target') matrix.targets.push({ ...row })
    if (problem === 'unknown-target') matrix.targets[0].target = 'unknown-arm64'
    if (problem === 'wrong-unsupported') matrix.unsupportedTargets = []
    if (['duplicate-target', 'unknown-target', 'wrong-unsupported'].includes(problem)) writeFileSync(matrixPath, json(matrix))
    if (problem === 'wrong-runtime' || problem === 'wrong-engine' || problem === 'combined') {
      const path = join(release.directory, row.qualification)
      const qualification = JSON.parse(readFileSync(path, 'utf8'))
      if (problem === 'wrong-runtime') qualification.runtime.arch = 'x64'
      else if (problem === 'wrong-engine') qualification.runtime.v8 = 'wrong-v8'
      else qualification.targets = ['mac-arm64', 'linux-x64']
      writeFileSync(path, json(qualification))
      row.qualificationSha256 = digest(readFileSync(path))
      writeFileSync(matrixPath, json(matrix))
      const names = readdirSync(release.directory).filter(name => name !== 'SHASUMS256.txt').sort()
      writeFileSync(checksumPath, names.map(name => `${digest(readFileSync(join(release.directory, name)))}  ${name}\n`).join(''))
    }
    assert.throws(() => acceptedWebServiceMatrix(root, release.directory, version))
  })
}

test('publisher refuses a single-target legacy directory and detects changes after admission', t => {
  const root = fixture(t)
  const mac = createTarget(root, 'mac-arm64')
  assert.throws(() => acceptedWebServiceMatrix(root, mac.output, version), /matrix|release/iu)
  const release = collectWebServiceRelease({ root, inputs: [mac.output], out: join(root, 'release') })
  const accepted = acceptedWebServiceMatrix(root, release.directory, version)
  writeFileSync(join(release.directory, accepted.manifest.targets[0].archive), 'changed after admission')
  assert.throws(() => copyWebServiceMatrix(accepted, join(root, 'upload')), /changed/iu)
})
