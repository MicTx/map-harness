/** Select only native application builds tied to the current verified community inputs. */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zipSync } from 'fflate'
import { PUBLIC_BUILD_RECORD } from './public-release-privacy.mjs'
import runtimeLock from '../../scripts/primary-runtime/lock.json' with { type: 'json' }

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const TARGETS = new Set(Object.keys(runtimeLock.targets))
const ZIP_MTIME = new Date('1980-01-01T00:00:00Z')

function filesBelow(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return filesBelow(join(root, entry.name)).map(file => `${entry.name}/${file}`)
    return [entry.name]
  }).sort()
}

function nativeTarget(bytes, target) {
  if (bytes.length < 64) return false
  const arm = target.endsWith('arm64')
  if (target.startsWith('mac-')) return bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arm ? 0x0100000c : 0x01000007)
  if (target.startsWith('linux-')) return bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (arm ? 183 : 62)
  const offset = bytes.readUInt32LE(0x3c)
  return bytes.readUInt16LE(0) === 0x5a4d && offset <= bytes.length - 6
    && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === (arm ? 0xaa64 : 0x8664)
}

/**
 * Refuse missing builds, source archives, stale builds, and changed executables before remote writes.
 * @param {string} root - private development checkout with fresh community build evidence.
 * @param {string} directory - native applications and their generated acceptance records.
 * @param {string} version - product version without the v prefix.
 * @returns {object[]} accepted platform applications.
 */
export function acceptedApplications(root, directory, version) {
  const build = JSON.parse(readFileSync(join(root, PUBLIC_BUILD_RECORD), 'utf8'))
  const expectedRecords = new Set([...TARGETS].map(target => `map-harness-v${version}-${target}.json`))
  const records = readdirSync(directory).filter(file => expectedRecords.has(file))
  if (records.length === 0) throw new Error('No accepted native applications; workspace runtime archives cannot be released.')
  const targets = new Set()
  return records.map(file => {
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    const expected = `map-harness-v${version}-${record.target}${record.target?.startsWith('win-') ? '.exe' : ''}`
    if (record.format !== 'map-harness-native-1' || record.version !== version || !TARGETS.has(record.target)
      || record.sourceDigest !== build.sources.sha256 || record.sourceCoreFiles !== 0 || !(record.coreModules > 0)
      || record.executable !== expected || basename(record.executable) !== record.executable
      || record.engine?.node !== `v${runtimeLock.nodeVersion}` || record.engine?.arch !== record.target.split('-')[1]
      || record.engine?.platform !== (record.target.startsWith('mac-') ? 'darwin' : record.target.startsWith('win-') ? 'win32' : 'linux')
      || record.smokes?.config !== true || record.smokes?.worker !== true || record.smokes?.system !== true || targets.has(record.target)) {
      throw new Error(`Native application acceptance is missing or stale: ${file}`)
    }
    if (record.target.startsWith('win-') && (record.smokes?.terminal !== true
      || (record.smokes?.mapBrowser !== true && record.deferredBrowserCheck !== true))) {
      throw new Error(`Native application acceptance requires Windows terminal and browser acceptance: ${file}`)
    }
    const executable = join(directory, record.executable)
    const bytes = readFileSync(executable)
    if (!lstatSync(executable).isFile() || lstatSync(executable).isSymbolicLink()
      || !nativeTarget(bytes, record.target) || sha(bytes) !== record.sha256) throw new Error(`Native application changed or has the wrong platform: ${file}`)
    const notices = record.executable.replace(/\.exe$/u, '') + '.licenses.txt'
    if (record.notices !== notices || !lstatSync(join(directory, notices)).isFile()
      || lstatSync(join(directory, notices)).isSymbolicLink()
      || sha(readFileSync(join(directory, notices))) !== record.noticesSha256) throw new Error(`Native license notices changed: ${file}`)
    const roles = record.target.startsWith('mac-') ? ['rg', 'spawn-helper'] : ['rg']
    if (JSON.stringify(Object.keys(record.resources ?? {}).sort()) !== JSON.stringify(roles.sort())) throw new Error(`Native application helpers are missing: ${file}`)
    const resourcePaths = {}
    for (const role of roles) {
      const item = record.resources[role]
      const expectedFile = record.executable.replace(/\.exe$/u, '') + '-' + role + (record.target.startsWith('win-') ? '.exe' : '')
      if (item.file !== expectedFile) throw new Error(`Native application helper filename is invalid: ${file}`)
      const path = join(directory, item.file)
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || sha(readFileSync(path)) !== item.sha256) throw new Error(`Native application helper changed: ${file}`)
      resourcePaths[role] = path
    }
    targets.add(record.target)
    return { ...record, path: executable, recordPath: join(directory, file), noticesPath: join(directory, notices), resourcePaths }
  })
}

/**
 * Archive accepted executables with licenses; never copy a workspace tree or its JavaScript.
 * @param {string} documents - isolated release documents already validated against the community build.
 * @param {object[]} applications - acceptedApplications result.
 * @param {string} out - private directory receiving archives.
 * @returns {string[]} uploadable native application archives.
 */
export function packApplications(documents, applications, out) {
  mkdirSync(out, { recursive: true })
  return applications.map(application => {
    const name = application.executable.replace(/\.exe$/u, '')
    const parent = mkdtempSync(join(out, '.application-')), stage = join(parent, name)
    mkdirSync(stage)
    try {
      const program = join(stage, application.target.startsWith('win-') ? 'map-harness.exe' : 'map-harness')
      copyFileSync(application.path, program)
      if (!application.target.startsWith('win-')) chmodSync(program, 0o755)
      for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(join(documents, file), join(stage, file))
      copyFileSync(application.noticesPath, join(stage, 'THIRD_PARTY_LICENSES.txt'))
      if (!lstatSync(program).isFile() || sha(readFileSync(program)) !== application.sha256
        || sha(readFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'))) !== application.noticesSha256) {
        throw new Error('Native application changed before archiving; rebuild and revalidate it.')
      }
      for (const [role, source] of Object.entries(application.resourcePaths ?? {})) {
        const destination = join(stage, 'map-harness-' + role + (application.target.startsWith('win-') ? '.exe' : ''))
        copyFileSync(source, destination)
        if (!application.target.startsWith('win-')) chmodSync(destination, 0o755)
        if (!lstatSync(destination).isFile() || sha(readFileSync(destination)) !== application.resources[role].sha256) throw new Error('Native application helper changed before archiving.')
      }
      const windows = application.target.startsWith('win-')
      const archive = join(out, name + (windows ? '.zip' : '.tar.gz'))
      rmSync(archive, { force: true })
      if (windows) {
        const entries = {}
        for (const file of filesBelow(stage)) {
          const mode = statSync(join(stage, file)).mode & 0o777
          entries[`${name}/${file}`] = [readFileSync(join(stage, file)), { mtime: ZIP_MTIME, os: 0, attrs: mode << 16 }]
        }
        writeFileSync(archive, zipSync(entries, { level: 9, mtime: ZIP_MTIME }))
      } else {
        const packed = spawnSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', archive, name], { cwd: parent, encoding: 'utf8' })
        if (packed.status !== 0) throw new Error(`Cannot archive native application: ${packed.stderr}`)
      }
      return archive
    } finally { rmSync(parent, { recursive: true, force: true }) }
  })
}
