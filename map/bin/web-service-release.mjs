/** Validate and copy qualified script-launched Web service releases. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { acceptedApplications } from './application-assets.mjs'
import { assertSourceOffers } from './pack-web-service.mjs'
import { PUBLIC_BUILD_RECORD } from './public-release-privacy.mjs'
import { assertRuntimeContent } from './release-content.mjs'
import { readWebServiceContract } from './web-service-contract.mjs'
import runtimeLock from '../../scripts/primary-runtime/lock.json' with { type: 'json' }

const sha256 = value => createHash('sha256').update(value).digest('hex')
const knownTargets = Object.keys(runtimeLock.targets).sort()
const digestPattern = /^[0-9a-f]{64}$/u

function regularFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Script Web service file is missing or not regular: ${basename(path)}`)
  }
  return path
}

function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/u.test(name) && name !== '.' && name !== '..'
}

function safePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9._/-]+$/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function sameFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort())
}

function assetName(template, version, target) {
  if (typeof template !== 'string' || !template.includes('{version}') || !template.includes('{target}')) {
    throw new Error('Script Web release asset template is invalid.')
  }
  const name = template.replace('{version}', version).replace('{target}', target)
  if (!safeName(name)) throw new Error('Script Web release asset name is invalid.')
  return name
}

function targetMetadata(target) {
  if (!Object.hasOwn(runtimeLock.targets, target)) throw new Error(`Script Web release target is unknown: ${target}`)
  const [os, architecture] = target.split('-')
  return { platform: { mac: 'darwin', linux: 'linux', win: 'win32' }[os], architecture,
    abi: runtimeLock.targets[target].pythonTarget.split('-').at(-1) }
}

function extractPackage(archive, packageName, files, destination) {
  const windows = archive.endsWith('.zip')
  const paths = ['web-service-manifest.json', ...files.map(file => file.path)]
  if (windows) {
    const staging = join(destination, '.zip-extracted')
    const helper = new URL('./web-service-qualification-platform.mjs', import.meta.url).href
    const script = `import { extractQualificationArchive } from ${JSON.stringify(helper)}; await extractQualificationArchive(process.argv[1], process.argv[2], 'win32', JSON.parse(process.argv[3]))`
    const expected = JSON.stringify(paths.map(path => `${packageName}/${path}`))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, archive, staging, expected], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Cannot extract script Web service ZIP: ${result.stderr || result.error?.message}`)
    for (const path of paths) {
      const output = join(destination, path)
      mkdirSync(dirname(output), { recursive: true })
      renameSync(join(staging, packageName, path), output)
    }
    return
  }
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (listing.status !== 0) throw new Error(`Cannot list script Web service archive: ${listing.stderr || listing.error?.message}`)
  const details = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (details.status !== 0) throw new Error(`Cannot inspect script Web service archive: ${details.stderr || details.error?.message}`)
  const entries = listing.stdout.split('\n').filter(Boolean)
  const modes = details.stdout.split('\n').filter(line => /^[?dlbcs-][rwxstST-]{1,9}\s/u.test(line))
  if (modes.length !== entries.length || modes.some((mode, index) => {
    const kind = mode[0], directory = entries[index].endsWith('/')
    return directory ? kind !== 'd' : kind !== '-'
  })) throw new Error('Script Web service archive entry type is invalid or contains a link.')
  const expected = new Set(paths.map(path => `${packageName}/${path}`)), seen = new Set()
  for (const entry of entries) {
    const directory = entry.endsWith('/')
    const normalized = directory ? entry.slice(0, -1) : entry
    if (!safePath(normalized) || (directory
      ? ![...expected].some(path => path.startsWith(`${normalized}/`))
      : !expected.has(normalized) || seen.has(normalized))) {
      throw new Error(`Script Web service archive contains an unexpected entry: ${entry}`)
    }
    if (!directory) seen.add(normalized)
  }
  if (seen.size !== expected.size) throw new Error('Script Web service archive is missing manifest files.')
  const modesByName = new Map(entries.map((entry, index) => [entry, modes[index]]))
  for (const file of files.filter(item => item.executable)) {
    const mode = modesByName.get(`${packageName}/${file.path}`)
    if (mode === undefined || !/[xs]/u.test(mode[3])) throw new Error(`Script Web service executable permission is missing: ${file.path}`)
  }
  for (const path of paths) {
    const output = join(destination, path)
    mkdirSync(dirname(output), { recursive: true })
    const fd = openSync(output, 'wx')
    try {
      const entry = `${packageName}/${path}`
      const result = spawnSync('tar', ['-xOzf', archive, entry], { stdio: ['ignore', fd, 'pipe'] })
      if (result.status !== 0) throw new Error(`Cannot extract script Web service file ${path}: ${result.stderr?.toString() || result.error?.message}`)
    } finally {
      closeSync(fd)
    }
  }
}

/**
 * Validate a single-target archive, manifest, qualification, and native build record.
 * @param {string} root Private development checkout.
 * @param {string} directory Directory carrying the archive and evidence.
 * @param {string} version Product version without `v`.
 * @param {object} names Optional target-specific manifest and qualification names.
 * @returns {object} Accepted release metadata.
 */
export function acceptedWebServiceRelease(root, directory, version, names = {}) {
  const manifestName = names.manifest ?? 'web-service-manifest.json'
  const qualificationName = names.qualification ?? 'web-service-qualification.json'
  if (!safeName(manifestName) || !safeName(qualificationName)) throw new Error('Script Web service evidence names are invalid.')
  const manifestPath = join(directory, manifestName), qualificationPath = join(directory, qualificationName)
  if (!existsSync(manifestPath) || !existsSync(qualificationPath)) throw new Error('Script Web service manifest and qualification are both required.')
  const manifestBytes = readFileSync(regularFile(manifestPath)), qualificationBytes = readFileSync(regularFile(qualificationPath))
  const manifest = JSON.parse(manifestBytes), qualification = JSON.parse(qualificationBytes)
  if (manifest.format !== 1 || manifest.product !== 'map-harness' || manifest.version !== version) throw new Error('Script Web service manifest version or identity is invalid.')
  const targets = qualification.targets ?? [qualification.target]
  if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') throw new Error('Script Web service qualification must name one target.')
  const target = targets[0], metadata = targetMetadata(target)
  if (qualification.target !== undefined && qualification.target !== target) throw new Error('Script Web service qualification target is inconsistent.')
  const packageName = `map-harness-v${version}-web-${target}`
  const archiveName = `${packageName}${target.startsWith('win-') ? '.zip' : '.tar.gz'}`
  if (qualification.archive !== archiveName || !safeName(archiveName)) throw new Error('Script Web service archive name is invalid.')
  const archive = regularFile(join(directory, archiveName))
  if (qualification.format !== 'map-harness-web-qualification-1' || qualification.product !== 'map-harness'
    || qualification.version !== version || qualification.archiveSha256 !== sha256(readFileSync(archive))
    || qualification.manifestSha256 !== sha256(manifestBytes)) throw new Error('Script Web service qualification hashes do not match its files.')
  if (qualification.runtime?.platform !== metadata.platform || qualification.runtime?.arch !== metadata.architecture
    || qualification.runtime?.cwdOutsideCheckout !== true) throw new Error('Script Web service qualification runtime does not match its target.')
  for (const check of [qualification.checks?.browserScenario, qualification.checks?.restartDataPreservation,
    qualification.checks?.cleanExit, qualification.checks?.noResidualProcesses]) {
    if (check?.passed !== true) throw new Error('Script Web service runtime qualification is incomplete.')
  }
  const unsupported = knownTargets.filter(item => item !== target)
  if (!Array.isArray(manifest.supportedTargets) || JSON.stringify(manifest.supportedTargets) !== JSON.stringify([target])
    || !Array.isArray(manifest.unsupportedTargets) || JSON.stringify([...manifest.unsupportedTargets].sort()) !== JSON.stringify(unsupported)
    || !Array.isArray(manifest.targets) || manifest.targets.length !== 1 || manifest.targets[0].target !== target) {
    throw new Error('Script Web service qualification target set does not match its manifest.')
  }
  const publicBuild = JSON.parse(readFileSync(join(root, PUBLIC_BUILD_RECORD), 'utf8'))
  if (qualification.sourceDigest !== publicBuild.sources.sha256) throw new Error('Script Web service qualification is stale for the community build.')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Script Web service manifest files are missing.')
  const paths = new Set()
  for (const row of manifest.files) {
    if (!sameFields(row, ['path', 'role', 'target', 'executable', 'sha256']) || !safePath(row.path)
      || paths.has(row.path) || row.path === 'web-service-manifest.json' || typeof row.role !== 'string' || !row.role
      || (row.target !== null && row.target !== target) || typeof row.executable !== 'boolean' || !digestPattern.test(row.sha256)) {
      throw new Error('Script Web service manifest file entry is invalid.')
    }
    paths.add(row.path)
  }
  const services = manifest.files.filter(row => row.role === 'service' && row.target === target)
  if (services.length !== 1 || services[0].executable !== true) throw new Error(`Script Web service target ${target} has no executable service.`)
  if (!manifest.files.some(row => row.role === 'source-offer')) throw new Error('Script Web service source offers are missing.')
  const extracted = mkdtempSync(join(tmpdir(), 'map-web-release-'))
  try {
    extractPackage(archive, packageName, manifest.files, extracted)
    if (!readFileSync(join(extracted, 'web-service-manifest.json')).equals(manifestBytes)) throw new Error('External and packaged Web service manifests differ.')
    for (const row of manifest.files) {
      if (sha256(readFileSync(join(extracted, row.path))) !== row.sha256) throw new Error(`Script Web service archive file changed: ${row.path}`)
    }
    const recordPath = manifest.targets[0].record
    if (!safePath(recordPath) || !paths.has(recordPath) || sha256(readFileSync(join(extracted, recordPath))) !== qualification.buildRecordSha256) {
      throw new Error('Script Web service build-record hashes do not match qualification.')
    }
    const applications = acceptedApplications(root, join(extracted, target), version)
    if (applications.length !== 1 || applications[0].target !== target || applications[0].recordPath !== join(extracted, recordPath)
      || applications[0].sourceDigest !== qualification.sourceDigest || applications[0].webService?.format !== 1 || applications[0].webService?.mode !== 'web'
      || applications[0].webService?.profile !== 'map-web' || applications[0].sha256 !== services[0].sha256) {
      throw new Error('Script Web service build record is invalid.')
    }
    const application = applications[0]
    if (qualification.runtime.node !== application.engine.node || qualification.runtime.v8 !== application.engine.v8) {
      throw new Error('Script Web service qualification engine does not match its build record.')
    }
    const common = [
      ['LICENSE', 'license', false, 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'third-party-notices', false, 'THIRD_PARTY_NOTICES.md'],
      ['THIRD_PARTY_SOURCE_OFFERS.md', 'source-offer', false, 'map/release/source-offers.md'],
      ['README.md', 'readme', false, 'map/release/public/README.md'], ['README.zh.md', 'readme', false, 'map/release/public/README.zh.md'],
      ...(target.startsWith('win-') ? [['start-web.cmd', 'launcher', true, 'map/release/start-web.cmd'],
        ['start-web.ps1', 'launcher', false, 'map/release/start-web.ps1']] : [['start-web.sh', 'launcher', true, 'map/release/start-web.sh']]),
    ]
    const expected = new Map(common.map(([path, role, executable]) => [path, { role, target: null, executable }]))
    expected.set(`${target}/${application.executable}`, { role: 'service', target, executable: true })
    expected.set(recordPath, { role: 'build-record', target, executable: false })
    expected.set(`${target}/${application.notices}`, { role: 'third-party-licenses', target, executable: false })
    for (const [role, resource] of Object.entries(application.resources)) {
      expected.set(`${target}/${resource.file}`, { role: `helper:${role}`, target, executable: true })
    }
    if (expected.size !== manifest.files.length || manifest.files.some(row => {
      const item = expected.get(row.path)
      return !item || item.role !== row.role || item.target !== row.target || item.executable !== row.executable
    })) throw new Error('Script Web service archive inventory contains an unexpected file.')
    for (const [path, , , source] of common) {
      if (!readFileSync(join(extracted, path)).equals(readFileSync(join(root, source)))) {
        throw new Error(`Script Web service package file differs from the checkout: ${path}`)
      }
    }
    assertRuntimeContent(extracted, [...paths])
    assertSourceOffers(readFileSync(join(extracted, 'THIRD_PARTY_SOURCE_OFFERS.md'), 'utf8'),
      readFileSync(join(extracted, target, application.notices), 'utf8'))
    return { archive, archiveSha256: qualification.archiveSha256, manifestPath, manifestSha256: qualification.manifestSha256,
      qualificationPath, qualificationSha256: sha256(qualificationBytes), manifest, qualification }
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}

/**
 * Copy single-target release files after checking the copied bytes.
 * @param {object} accepted Result from acceptedWebServiceRelease.
 * @param {string} directory Destination directory.
 * @returns {string[]} Absolute upload paths.
 */
export function copyWebServiceArtifacts(accepted, directory) {
  mkdirSync(directory, { recursive: true })
  return [[accepted.archive, accepted.archiveSha256], [accepted.manifestPath, accepted.manifestSha256],
    [accepted.qualificationPath, accepted.qualificationSha256]].map(([source, expected]) => {
    const target = join(directory, basename(source))
    copyFileSync(source, target, constants.COPYFILE_EXCL)
    if (sha256(readFileSync(target)) !== expected) throw new Error('Script Web service files changed before upload.')
    return target
  })
}

/**
 * Validate every declared matrix asset and its qualification before publication.
 * @param {string} root Private development checkout.
 * @param {string} directory Collected release directory.
 * @param {string} version Product version without `v`.
 * @returns {object} Validated manifest and upload file digests.
 */
export function acceptedWebServiceMatrix(root, directory, version) {
  const settings = readWebServiceContract(root).manifest.releaseMatrix
  if (settings?.format !== 'map-harness-web-release-1' || settings.file !== 'web-service-release.json'
    || settings.checksums !== 'SHASUMS256.txt' || settings.targetSource !== 'scripts/primary-runtime/lock.json') {
    throw new Error('Script Web release matrix settings are invalid.')
  }
  const matrixPath = join(directory, settings.file), checksumPath = join(directory, settings.checksums)
  if (!existsSync(matrixPath) || !existsSync(checksumPath)) throw new Error('Script Web release matrix and checksums are required.')
  const matrixBytes = readFileSync(regularFile(matrixPath)), manifest = JSON.parse(matrixBytes)
  if (!sameFields(manifest, settings.requiredTopLevelFields) || manifest.format !== settings.format
    || manifest.product !== 'map-harness' || manifest.version !== version || !digestPattern.test(manifest.sourceDigest)
    || !Array.isArray(manifest.targets) || manifest.targets.length === 0 || !Array.isArray(manifest.unsupportedTargets)) {
    throw new Error('Script Web release matrix fields are invalid.')
  }
  const sourceDigest = JSON.parse(readFileSync(join(root, PUBLIC_BUILD_RECORD), 'utf8')).sources.sha256
  if (manifest.sourceDigest !== sourceDigest) throw new Error('Script Web release matrix source digest is stale.')
  const files = new Map([[settings.file, sha256(matrixBytes)]])
  const targets = new Set()
  for (const row of manifest.targets) {
    if (!sameFields(row, settings.requiredTargetFields) || typeof row.target !== 'string' || targets.has(row.target)) {
      throw new Error('Script Web release matrix has an invalid or duplicate target.')
    }
    targets.add(row.target)
    const metadata = targetMetadata(row.target)
    if (row.platform !== metadata.platform || row.architecture !== metadata.architecture || row.abi !== metadata.abi) {
      throw new Error('Script Web release matrix target metadata is invalid.')
    }
    const expectedNames = {
      archive: assetName(row.target.startsWith('win-') ? settings.archiveNames.windows : settings.archiveNames.unix, version, row.target),
      manifest: assetName(settings.manifestName, version, row.target), qualification: assetName(settings.qualificationName, version, row.target),
    }
    for (const [field, hash] of [['archive', 'archiveSha256'], ['manifest', 'manifestSha256'], ['qualification', 'qualificationSha256']]) {
      const name = row[field]
      if (name !== expectedNames[field] || files.has(name) || !digestPattern.test(row[hash])) throw new Error('Script Web release matrix asset metadata is invalid.')
      if (sha256(readFileSync(regularFile(join(directory, name)))) !== row[hash]) throw new Error(`Script Web release matrix asset changed: ${name}`)
      files.set(name, row[hash])
    }
    const accepted = acceptedWebServiceRelease(root, directory, version, { manifest: row.manifest, qualification: row.qualification })
    if (accepted.qualification.sourceDigest !== manifest.sourceDigest || accepted.qualification.archive !== row.archive
      || accepted.qualification.target !== row.target) throw new Error('Script Web release matrix qualification is inconsistent.')
  }
  if (JSON.stringify([...manifest.unsupportedTargets].sort()) !== JSON.stringify(knownTargets.filter(target => !targets.has(target)))) {
    throw new Error('Script Web release matrix unsupported targets are invalid.')
  }
  const checksumBytes = readFileSync(regularFile(checksumPath))
  const expected = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, hash]) => `${hash}  ${name}\n`).join('')
  if (checksumBytes.toString('utf8') !== expected) throw new Error('Script Web release checksums do not match its assets.')
  files.set(settings.checksums, sha256(checksumBytes))
  return { directory, manifest, files }
}

/**
 * Copy all admitted matrix assets and reject bytes changed after admission.
 * @param {object} accepted Result from acceptedWebServiceMatrix.
 * @param {string} directory Destination directory.
 * @returns {string[]} Absolute upload paths.
 */
export function copyWebServiceMatrix(accepted, directory) {
  mkdirSync(directory, { recursive: true })
  return [...accepted.files].map(([name, expected]) => {
    const destination = join(directory, name)
    copyFileSync(regularFile(join(accepted.directory, name)), destination, constants.COPYFILE_EXCL)
    if (sha256(readFileSync(destination)) !== expected) throw new Error(`Script Web release asset changed before upload: ${name}`)
    return destination
  })
}
