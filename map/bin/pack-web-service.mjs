#!/usr/bin/env node
/** Build deterministic source-free script-launched Web service release archives. */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTarArchive } from 'tar'
import { zipSync } from 'fflate'
import { acceptedApplications } from './application-assets.mjs'
import { readProductVersion } from './public-release-privacy.mjs'
import { assertRuntimeContent, FACADE_READMES } from './release-content.mjs'
import { readWebServiceContract } from './web-service-contract.mjs'
import runtimeLock from '../../scripts/primary-runtime/lock.json' with { type: 'json' }

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const ALL_TARGETS = Object.keys(runtimeLock.targets).sort()
const ZIP_MTIME = new Date('1980-01-01T00:00:00Z')

/**
 * Ensure all supplied applications belong to one product/source line.
 * @param {object[]} applications Accepted native application rows.
 * @param {string} version Product version.
 * @returns {object[]} The same rows after validation.
 */
export function assertWebServiceApplications(applications, version) {
  if (!Array.isArray(applications) || applications.length === 0) throw new Error('No accepted native Web service applications.')
  const versions = new Set(), digests = new Set(), targets = new Set()
  for (const application of applications) {
    versions.add(application.version)
    digests.add(application.sourceDigest)
    targets.add(application.target)
    if (application.webService?.format !== 1 || application.webService?.mode !== 'web' || application.webService?.profile !== 'map-web') {
      throw new Error(`Native application ${application.target} is not a web-only build.`)
    }
  }
  if (versions.size !== 1 || !versions.has(version)) throw new Error('Web service applications must share the product version.')
  if (digests.size !== 1) throw new Error('Web service applications must share one source digest.')
  if (targets.size !== applications.length) throw new Error('Web service applications contain a duplicate target.')
  return applications
}

/**
 * Refuse a source-requiring license unless the release carries a written offer.
 * @param {string} offers Source-offer document text.
 * @param {string} notices Complete third-party notice text.
 */
export function assertSourceOffers(offers, notices) {
  if (!offers.trim() || !notices.trim()) throw new Error('Web service license offers are empty.')
  const sourceRequired = /GNU (?:General|Lesser|Affero) Public License|Mozilla Public License|Server Side Public License/iu.test(notices)
  if (sourceRequired && !offers.includes('WRITTEN SOURCE OFFER:')) {
    throw new Error('A bundled license requires a written source offer; add it to map/release/source-offers.md.')
  }
}

function filesBelow(root) {
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const file = path ? `${path}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Web service payload contains a symbolic link: ${file}`)
    return entry.isDirectory() ? walk(file) : [file]
  })
  return walk('').sort()
}

function copy(source, target, mode = statSync(source).mode & 0o777) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, mode)
}

function manifestFor(applications, entries) {
  return {
    format: 1,
    product: 'map-harness',
    version: applications[0].version,
    targets: applications.map(application => ({ target: application.target, record: `${application.target}/${basename(application.recordPath)}` })),
    supportedTargets: applications.map(application => application.target).sort(),
    unsupportedTargets: ALL_TARGETS.filter(target => !applications.some(application => application.target === target)).sort(),
    files: entries.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  }
}

/**
 * Stage one deterministic source-free script-launched service package.
 * @param {string} root Repository root.
 * @param {object[]} applications Accepted native applications.
 * @param {string} stage Empty staging root.
 * @returns {{manifestPath: string, files: string[], archiveName: string}} staged manifest and inventory.
 */
export function stageWebService(root, applications, stage) {
  const contract = readWebServiceContract(root)
  assertWebServiceApplications(applications, applications[0].version)
  const entries = []
  const add = (source, path, role, target, mode = undefined) => {
    if (lstatSync(source).isSymbolicLink()) throw new Error(`Web service input is a symbolic link: ${source}`)
    copy(source, join(stage, path), mode)
    const executable = (mode ?? (statSync(source).mode & 0o777)) & 0o111
    entries.push({ path, role, target, executable: executable !== 0, sha256: sha(readFileSync(join(stage, path))) })
  }

  const rootFiles = [
    { path: 'LICENSE', source: 'LICENSE', role: 'license', mode: 0o644 },
    { path: 'THIRD_PARTY_NOTICES.md', source: 'THIRD_PARTY_NOTICES.md', role: 'third-party-notices', mode: 0o644 },
    { path: 'THIRD_PARTY_SOURCE_OFFERS.md', source: 'map/release/source-offers.md', role: 'source-offer', mode: 0o644 },
  ]
  for (const item of rootFiles) add(join(root, item.source), item.path, item.role, null, item.mode)
  for (const [name, source] of Object.entries(FACADE_READMES)) add(join(root, source), name, 'readme', null, 0o644)
  for (const application of applications) {
    const windows = application.target.startsWith('win-')
    if (windows) {
      add(join(root, 'map/release/start-web.cmd'), 'start-web.cmd', 'launcher', null, 0o755)
      add(join(root, 'map/release/start-web.ps1'), 'start-web.ps1', 'launcher', null, 0o644)
    } else {
      add(join(root, 'map/release/start-web.sh'), 'start-web.sh', 'launcher', null, 0o755)
    }
    const directory = application.target
    add(application.path, `${directory}/${application.executable}`, 'service', application.target, 0o755)
    add(application.recordPath, `${directory}/${basename(application.recordPath)}`, 'build-record', application.target, 0o644)
    add(application.noticesPath, `${directory}/${basename(application.noticesPath)}`, 'third-party-licenses', application.target, 0o644)
    for (const [role, item] of Object.entries(application.resourcePaths ?? {})) {
      add(item, `${directory}/${basename(item)}`, `helper:${role}`, application.target, 0o755)
    }
  }

  const manifest = manifestFor(applications, entries)
  const manifestPath = join(stage, contract.manifest.file)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 })
  const files = filesBelow(stage)
  if (files.some(file => file.split('/').some(part => part === '.spec' || part === '.agents' || part === '.env' || part.startsWith('.env.')))) {
    throw new Error('Web service payload contains private state.')
  }
  assertRuntimeContent(stage, files)
  const checkout = Buffer.from(ROOT)
  for (const file of files) {
    const bytes = readFileSync(join(stage, file))
    if (bytes.includes(checkout)) throw new Error(`Web service payload contains a checkout path: ${file}`)
    const textual = /\.(?:[cm]?js|css|html|json|md|cmd|ps1|sh|txt)$/iu.test(file)
    if (textual && (bytes.includes(Buffer.from('sourceMappingURL=data:')) || bytes.includes(Buffer.from('"sourcesContent":')))) {
      throw new Error(`Web service payload contains an embedded source map: ${file}`)
    }
  }
  assertSourceOffers(readFileSync(join(stage, 'THIRD_PARTY_SOURCE_OFFERS.md'), 'utf8'),
    applications.map(application => readFileSync(application.noticesPath, 'utf8')).join('\n\n'))
  const archiveName = `map-harness-v${manifest.version}-web-${applications.length === 1 ? applications[0].target : 'combined'}`
  return { manifestPath, files, manifest, archiveName }
}

function createTar(source, file, root) {
  createTarArchive({
    file, cwd: source, prefix: root, portable: true, noMtime: true, mtime: new Date(0),
    gzip: { level: 9, mtime: 0 }, uid: 0, gid: 0, sync: true,
  }, filesBelow(source))
}

function createZip(source, file, archiveRoot) {
  const entries = {}
  for (const path of filesBelow(source)) {
    const mode = statSync(join(source, path)).mode & 0o777
    entries[`${archiveRoot}/${path}`] = [readFileSync(join(source, path)), { mtime: ZIP_MTIME, os: 0, attrs: mode << 16 }]
  }
  writeFileSync(file, zipSync(entries, { level: 9, mtime: ZIP_MTIME }))
}

/**
 * Pack accepted applications into one source-free script Release.
 * @param {object} options Root, application directories, output and combined mode.
 * @returns {Promise<object>} Archive and manifest paths with digest metadata.
 */
export async function packWebService({ root = ROOT, applicationDirectories, out, combined = false }) {
  if (!Array.isArray(applicationDirectories) || applicationDirectories.length === 0) throw new Error('No native application directory supplied.')
  const version = readProductVersion(root)
  const applications = applicationDirectories.flatMap(directory => acceptedApplications(root, resolve(directory), version))
  assertWebServiceApplications(applications, version)
  if (combined && applications.length < 2) throw new Error('Combined Web service archives require multiple targets.')
  mkdirSync(out, { recursive: true })
  const parent = mkdtempSync(join(out, '.web-service-'))
  try {
    const stage = join(parent, 'stage')
    mkdirSync(stage)
    const staged = stageWebService(root, applications, stage)
    const windowsOnly = applications.length === 1 && applications[0].target.startsWith('win-')
    const archive = join(out, staged.archiveName + (windowsOnly ? '.zip' : '.tar.gz'))
    rmSync(archive, { force: true })
    if (windowsOnly) createZip(stage, archive, staged.archiveName)
    else createTar(stage, archive, staged.archiveName)
    const manifest = join(out, 'web-service-manifest.json')
    copyFileSync(staged.manifestPath, manifest)
    chmodSync(manifest, 0o644)
    return { archive, manifest, archiveSha256: sha(readFileSync(archive)),
      manifestSha256: sha(readFileSync(manifest)), supportedTargets: staged.manifest.supportedTargets,
      unsupportedTargets: staged.manifest.unsupportedTargets, version }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const value = name => { const at = argv.indexOf(name); return at >= 0 ? resolve(argv[at + 1]) : undefined }
  const out = value('--out')
  const applicationDirectories = []
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--application') applicationDirectories.push(resolve(argv[++at]))
  }
  if (out === undefined || applicationDirectories.length === 0) {
    console.error('pack-web-service: usage: --application <dir> [--application <dir>] [--combined] --out <dir>')
    process.exit(1)
  }
  const result = await packWebService({ applicationDirectories, out, combined: argv.includes('--combined') })
  console.log(JSON.stringify(result))
}
