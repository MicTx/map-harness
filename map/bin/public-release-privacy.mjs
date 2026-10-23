/** Community-release checks shared by the builder, packer, and publisher. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Private build evidence is never part of the published tree. */
export const PUBLIC_BUILD_RECORD = '.dsh-build/map-public-release.json'

/** Repository-relative path of the product version source. */
export const PRODUCT_VERSION_PATH = 'map/release/version.json'

/** Product versions: X.Y.Z with an optional prerelease segment. */
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** The only deployment title accepted for public releases. */
export const COMMUNITY_TITLE = '探索未至之境 x Map Harness · 社区版'

const PUBLIC_VALUES = {
  DSH_CLIENT_MAP_ORG_NAME: /^\s*$/u,
  DSH_CLIENT_TITLE: /^(?:探索未至之境 x Map Harness · 社区版)$/u,
  DSH_CLIENT_BUILD_PROFILE: /^(?:official)$/u,
  DSH_CLIENT_COMMIT_HASH: /^[a-f\d]{7,40}$/u,
  DSH_CLIENT_GIT_DIRTY: /^(?:true|false)$/u,
  DSH_CLIENT_VERSION: /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u,
}

/**
 * Refuse private or unknown client branding without reproducing its value.
 * @param {Record<string, string | undefined>} environment - build or publish environment.
 */
export function assertCommunityEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith('DSH_CLIENT_') && value !== undefined && !PUBLIC_VALUES[name]?.test(value)) {
      throw new Error('Public releases require the community client environment; remove private or custom client values.')
    }
  }
}

/**
 * Read the product version every client build embeds and every release cites.
 * The repository manifest keeps the upstream baseline; this file owns the
 * fork's release line, so both editions of the product report one version.
 * @param {string} root - repository root.
 * @returns {string} the committed product version.
 */
export function readProductVersion(root) {
  let record
  try {
    record = JSON.parse(readFileSync(join(root, PRODUCT_VERSION_PATH), 'utf8'))
  } catch (error) {
    throw new Error(`product version source ${PRODUCT_VERSION_PATH} is missing or unreadable; client builds and releases need it.`)
  }
  if (typeof record?.version !== 'string' || !PRODUCT_VERSION_PATTERN.test(record.version)) {
    throw new Error(`${PRODUCT_VERSION_PATH} must carry {"version": "X.Y.Z"}; the version field does not name one.`)
  }
  return record.version
}

/**
 * Require a release request to cite the committed product version, so the
 * tag, the runtime archive name, and the version users see cannot diverge.
 * @param {string} root - repository root.
 * @param {string} requested - release tag requested on the command line (vX.Y.Z).
 */
export function assertReleaseVersion(root, requested) {
  const product = readProductVersion(root)
  if (requested !== `v${product}`) {
    throw new Error(`release ${requested} does not match the product version ${product} in ${PRODUCT_VERSION_PATH}; bump the version source first.`)
  }
}

/**
 * Invalidate the previous public record before any build starts.
 * @param {string} root - repository root.
 */
export function invalidatePublicBuild(root) {
  rmSync(join(root, PUBLIC_BUILD_RECORD), { force: true })
}

function payloadDigest(root, files) {
  const base = realpathSync(root)
  const digest = createHash('sha256')
  const sorted = [...new Set(files)].sort()
  for (const file of sorted) {
    if (isAbsolute(file) || file.split(/[\\/]/u).some(part => part === '..' || part === '') || file === PUBLIC_BUILD_RECORD) {
      throw new Error('Invalid public release input path.')
    }
    const target = realpathSync(resolve(base, file))
    const within = relative(base, target)
    if (within.startsWith('..') || isAbsolute(within) || !statSync(target).isFile()) {
      throw new Error('Public release inputs must be regular files within the repository.')
    }
    const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
    digest.update(JSON.stringify([file, sha256]) + '\n')
  }
  return { fileCount: sorted.length, sha256: digest.digest('hex') }
}

/**
 * Bind a successful community build to every source and runtime file it publishes.
 * Call only after the complete client build succeeds with the validated environment.
 * @param {string} root - repository root.
 * @param {string[]} files - complete published input list, including source maps.
 * @param {Record<string, string | undefined>} environment - actual build environment.
 * @param {string[]} sources - the source-only snapshot published to GitHub.
 */
export function recordPublicBuild(root, files, environment, sources = files) {
  invalidatePublicBuild(root)
  assertCommunityEnvironment(environment)
  const record = { formatVersion: 1, edition: 'community', artifacts: payloadDigest(root, files), sources: payloadDigest(root, sources) }
  const path = join(root, PUBLIC_BUILD_RECORD)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record) + '\n')
}

/**
 * Refuse missing, private, or stale public build evidence before distribution.
 * @param {string} root - repository root containing the build record.
 * @param {string[]} files - complete current published input list.
 * @param {Record<string, string | undefined>} environment - publisher environment.
 * @param {string} payloadRoot - staged copy to verify, or the repository root.
 */
export function assertPublicBuild(root, files, environment = process.env, payloadRoot = root) {
  assertCommunityEnvironment(environment)
  const record = readPublicBuildRecord(root)
  assertDigest(payloadDigest(payloadRoot, files), record.artifacts)
}

/**
 * Enumerate every staged file; no caller-provided list can hide an extra file.
 * @param {string} root - isolated staging directory.
 * @returns {string[]} sorted relative file paths.
 */
export function stagedFiles(root) {
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const child = path === '' ? entry.name : `${path}/${entry.name}`
    return entry.isDirectory() ? walk(child) : [child]
  })
  return walk('').sort()
}

/**
 * Validate the actual source snapshot before creating a public commit.
 * @param {string} root - repository containing the public build record.
 * @param {string} stage - isolated public source directory.
 */
export function assertPublicSources(root, stage) {
  assertDigest(payloadDigest(stage, stagedFiles(stage)), readPublicBuildRecord(root).sources)
}

function assertDigest(current, expected) {
  if (current.fileCount !== expected?.fileCount || current.sha256 !== expected?.sha256) {
    throw new Error('Public build inputs changed; rebuild the community edition before publishing.')
  }
}

function readPublicBuildRecord(root) {
  let record
  try {
    record = JSON.parse(readFileSync(join(root, PUBLIC_BUILD_RECORD), 'utf8'))
  } catch (error) {
    // The parser may quote private bytes from a malformed record; do not echo it.
    throw new Error('Public build record is missing or invalid; rebuild the community edition.')
  }
  if (record?.formatVersion !== 1 || record.edition !== 'community' || !record.artifacts) {
    throw new Error('Public build record does not identify a community build.')
  }
  return record
}
