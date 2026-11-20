/** File selection shared by runtime archives and the public source repository. */
import { readFileSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'

/** The complete public Git tree; release tags and automatic source archives use this tree. */
export const PUBLIC_FACADE = ['README.md', 'README.zh.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']

/** Source locations of the two release-only READMEs. */
export const FACADE_READMES = {
  'README.md': 'map/release/public/README.md',
  'README.zh.md': 'map/release/public/README.zh.md',
}

const INSTALL_FILES = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  ...Object.values(FACADE_READMES),
  'map/bin/setup.mjs', 'map/bin/native-prebuilds.mjs', 'map/bin/map-harness.mjs',
  'map/release/native-prebuilds.json', 'map/release/version.json',
  ...['install.cmd', 'install.sh', 'start.cmd', 'start.sh'].map(name => `map/release/${name}`),
  'vendor/cordis/bin.js', 'packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs',
])

/**
 * Remove checkout-only root commands while preserving frozen-lockfile dependency fields.
 * @param {string} file - relative file path.
 * @param {Buffer} bytes - checkout bytes.
 * @returns {Buffer} bytes distributed for that runtime file.
 */
export function runtimeBytes(file, bytes) {
  if (file !== 'package.json' && !/^map\/(?:[^/]+|profiles\/[^/]+)\/package\.json$/u.test(file)) return bytes
  const manifest = JSON.parse(bytes.toString('utf8'))
  delete manifest.scripts
  if (file !== 'package.json') {
    delete manifest.types
    if (manifest.main?.startsWith('src/')) delete manifest.main
    const prune = value => {
      if (typeof value === 'string') return /(?:^|\/)src\/|\.d\.[cm]?ts$/u.test(value) ? undefined : value
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'types' && !key.includes('*')).map(([key, child]) => [key, prune(child)]).filter(([, child]) => child !== undefined))
    }
    if (manifest.exports) manifest.exports = prune(manifest.exports)
  }
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
}

/**
 * Whether a path is development source or debug material, even inside a build directory.
 * @param {string} file - relative payload path.
 * @returns {boolean} whether the runtime must omit it.
 */
export function isDevelopmentFile(file) {
  return /(?:^|\/)(?:src|sources|tests?|__tests__|fixtures)(?:\/|$)/u.test(file)
    || /\.(?:map|ts|tsx|mts|cts|jsx|c|h|cpp|hpp|cs|swift|py|rs|go|java|kt|tsbuildinfo)$/iu.test(file)
    || /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/u.test(file)
}

/**
 * Whether a third-party package ships executable JavaScript from a source-named directory.
 * @param {string} file - relative payload path.
 * @returns {boolean} whether staging must preserve the dependency runtime file.
 */
export function isDependencyRuntimeSource(file) {
  return !file.includes('/@map-harness/') && /(?:^|\/)src\/.*\.[cm]?js$/u.test(file)
}

/**
 * Select install metadata, explicit launchers, and package-declared runtime resources.
 * @param {string} root - checkout root.
 * @param {string[]} tracked - privacy-filtered repository inventory.
 * @returns {string[]} sorted files to copy without compiling.
 */
export function runtimeTrackedFiles(root, tracked) {
  const manifests = runtimePackageManifests(tracked)
  const resources = manifests.map(file => {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'))
    const patches = manifest.dsh?.bundle?.patch ?? []
    return { dir: dirname(file), files: [...(manifest.files ?? []), ...[patches].flat()].filter(pattern => !pattern.startsWith('!')).map(pattern => pattern.replace(/^\.\//u, '')) }
  })
  return tracked.filter(file => {
    if (isDevelopmentFile(file)) return false
    if (INSTALL_FILES.has(file) || manifests.includes(file)) return true
    // pnpm applies these third-party dependency patches during frozen installation.
    if (/^patches\/[^/]+\.patch$/u.test(file)) return true
    if (/^map\/(?:profiles|presets)\/[^/]+\/[^/]+\.(?:yml|yaml)$/u.test(file)) return true
    return resources.some(({ dir, files }) => {
      if (!file.startsWith(`${dir}/`)) return false
      const local = file.slice(dir.length + 1)
      if (/^(?:LICENSE(?:[.-][^/]+)?|prebuilds\.json)$/u.test(local)) return true
      return files.some(pattern => matchesGlob(local, pattern) || local.startsWith(`${pattern.replace(/\/$/u, '')}/`))
    })
  }).sort()
}

/**
 * Select workspace package manifests without descending into examples or snapshot workspaces.
 * @param {string[]} tracked - repository inventory.
 * @returns {string[]} package manifests allowed to contribute runtime output.
 */
export function runtimePackageManifests(tracked) {
  return tracked.filter(file => /^(?:(?:apps|vendor|map)\/[^/]+|packages\/[^/]+\/[^/]+|native\/system(?:\/packages\/[^/]+)?|python\/sdk-runtime|benchmarks|website|map\/profiles\/[^/]+)\/package\.json$/u.test(file))
}

/**
 * Reject sources and embedded source maps in the actual staged runtime.
 * @param {string} root - staged root.
 * @param {string[]} files - every staged regular file.
 */
export function assertRuntimeContent(root, files) {
  for (const file of files) {
    if (isDevelopmentFile(file)) throw new Error(`Runtime release contains development source: ${file}`)
    if (/\.(?:[cm]?js|css|html|json)$/iu.test(file)) {
      const content = readFileSync(join(root, file), 'utf8')
      if (/sourceMappingURL\s*=\s*data:/iu.test(content) || /"sourcesContent"\s*:/u.test(content)) {
        throw new Error(`Runtime release contains embedded source map: ${file}`)
      }
    }
  }
}
