/** Community-release checks shared by the builder, packer, and publisher. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { runtimeBytes } from './release-content.mjs'

/** Path segments that never enter a published tree, at any depth. */
const PRIVATE_STATE_SEGMENTS = new Set(['.spec', '.agents', '.claude', '.codex', '.pi', '.zcode', '.cursor', '.paseo'])

/** Whether one staged path is outside the public source tree. */
function isExcludedPublicPath(file) {
  const parts = file.split('/')
  return parts.some((part, at) => PRIVATE_STATE_SEGMENTS.has(part) || (part === '.github' && parts[at + 1] === 'workflows'))
    || /^logs\//u.test(file) || /^user\//u.test(file) || file === 'map/docs/github-release.md'
    || (/(?:^|\/)\.env(?:\.[^/]*)?$/u.test(file) && !file.endsWith('.example'))
}

/** Private build evidence is never part of the published tree. */
export const PUBLIC_BUILD_RECORD = '.dsh-build/map-public-release.json'

/** Repository-relative path of the product version source. */
export const PRODUCT_VERSION_PATH = 'map/release/version.json'

/** Repository-relative directory of per-version update notes (map/docs/release-notes.md owns the writing contract). */
export const RELEASE_NOTES_DIR = 'map/release/notes'

/** Bounded output capacity for inventories of the complete upstream source tree. */
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024

/** One capability bullet: `- **capability**: effect`, single line. */
const NOTES_BULLET = /^- \*\*[^*\n]+\*\*: \S.*$/u

/** Product versions: X.Y.Z with an optional prerelease segment. */
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** The only deployment title accepted for public releases. */
export const COMMUNITY_TITLE = 'Map Harness · 社区版'

/** Allowed checkout input roots; their source files stay private. */
export const PUBLIC_SOURCE_ROOTS = [
  '.github/',
  'apps/',
  'benchmarks/',
  'docs/',
  'map/',
  'native/',
  'packages/',
  'patches/',
  'python/',
  'scripts/',
  'snapshots/',
  'vendor/',
  'website/',
]

/** Allowed root checkout inputs; publication selects a smaller runtime or documentation tree. */
export const PUBLIC_SOURCE_FILES = [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitlab-ci.yml',
  '.jscpd.json',
  '.oxlintrc.json',
  '.oxlintrc.staged.json',
  '.rgignore',
  'AGENTS.md',
  'BENCHMARK.md',
  'BRAND_GUIDELINES.i18n.yaml',
  'BRAND_GUIDELINES.md',
  'BRAND_GUIDELINES.zh.md',
  'CLAUDE.md',
  'CODE_OF_CONDUCT.i18n.yaml',
  'CODE_OF_CONDUCT.md',
  'CODE_OF_CONDUCT.zh.md',
  'CONTRIBUTING.i18n.yaml',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh.md',
  'LICENSE',
  'Makefile',
  'README.i18n.yaml',
  'README.md',
  'README.upstream.md',
  'README.upstream.zh.md',
  'README.zh.md',
  'SAFETY.i18n.yaml',
  'SAFETY.md',
  'SAFETY.zh.md',
  'SECURITY.i18n.yaml',
  'SECURITY.md',
  'SECURITY.zh.md',
  'THIRD_PARTY_NOTICES.md',
  'lefthook.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pytest.ini',
  'tsconfig.base.client.json',
  'tsconfig.base.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsconfig.json',
  'tsconfig.node.base.json',
  'tsdown.config.ts',
  'vitest.bench.config.ts',
  'vitest.config.ts',
  'vitest.e2e.config.ts',
  'vitest.expected.config.ts',
  'vitest.shared.ts',
  'vitest.snapshot.config.ts',
  'vitest.web-stress.config.ts',
  'vitest.web.config.ts',
  'vitest.web.perf.config.ts',
]

const PUBLIC_VALUES = {
  DSH_CLIENT_MAP_ORG_NAME: /^\s*$/u,
  DSH_CLIENT_TITLE: /^(?:Map Harness · 社区版)$/u,
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
 * Whether one repository-relative path is on the explicit public source
 * allowlist; privacy rules are layered on top and may still exclude it.
 * @param {string} file - repository-relative path.
 * @returns {boolean} `true` when the path is an allowed source location.
 */
export function isPublicSourcePath(file) {
  if (PUBLIC_SOURCE_FILES.includes(file)) return true
  return PUBLIC_SOURCE_ROOTS.some(root => file.startsWith(root))
}

/**
 * The exact-OID lease for rewriting the public main: an empty remote read
 * requires the branch to be absent, any other value must be the full object
 * id `git ls-remote` returned for `refs/heads/main` immediately before the
 * push.
 * @param {string} remoteOid - remote object id ('' when the branch is unborn).
 * @returns {string} the `--force-with-lease` argument for the push.
 */
export function forceWithLease(remoteOid) {
  if (remoteOid === '') return '--force-with-lease=refs/heads/main:'
  if (!/^[0-9a-f]{40}$/u.test(remoteOid)) {
    throw new Error('force-with-lease needs the full remote OID of refs/heads/main; re-read git ls-remote.')
  }
  return `--force-with-lease=refs/heads/main:${remoteOid}`
}

/**
 * Read one version's update notes for the release body: an absent file is
 * skipped, a present file must carry the `## What's new` heading and 1..7
 * single-line capability bullets within 220 characters, with no template
 * placeholders or internal record slugs. The writing contract lives in
 * map/docs/release-notes.md; this is only its structural floor.
 * @param {string} root - repository root.
 * @param {string} version - product version (X.Y.Z, without the leading v).
 * @returns {string | undefined} the validated notes text, or `undefined` when the version ships none.
 */
export function updateNotesOf(root, version) {
  const path = join(root, RELEASE_NOTES_DIR, `v${version}.md`)
  if (!existsSync(path)) return undefined
  const notes = readFileSync(path, 'utf8').replace(/\s+$/u, '')
  if (!notes.startsWith("## What's new\n")) {
    throw new Error(`${RELEASE_NOTES_DIR}/v${version}.md must start with "## What's new"; see map/docs/release-notes.md.`)
  }
  if (notes.includes('{{')) {
    throw new Error(`${RELEASE_NOTES_DIR}/v${version}.md carries an unresolved {{...}} placeholder.`)
  }
  if (/\d{4}-\d{2}-\d{2}_/u.test(notes)) {
    throw new Error(`${RELEASE_NOTES_DIR}/v${version}.md carries an internal record slug; write user-facing bullets only.`)
  }
  let bullets = 0
  for (const line of notes.split('\n')) {
    if (!NOTES_BULLET.test(line)) continue
    if (line.length > 220) {
      throw new Error(`${RELEASE_NOTES_DIR}/v${version}.md has a bullet over 220 characters; keep one sentence per capability.`)
    }
    bullets += 1
  }
  if (bullets < 1 || bullets > 7) {
    throw new Error(`${RELEASE_NOTES_DIR}/v${version}.md must carry 1..7 "- **capability**: effect" bullets.`)
  }
  return notes
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

function payloadDigest(root, files, checkoutRoot = root, aliases = {}, runtime = false) {
  const base = realpathSync(root)
  const checkoutPaths = [...new Set([resolve(checkoutRoot), realpathSync(checkoutRoot)].flatMap(path => [
    path,
    path.replaceAll('\\', '/'),
    JSON.stringify(path).slice(1, -1),
  ]))]
  const digest = createHash('sha256')
  const sorted = [...new Set(files)].sort()
  for (const file of sorted) {
    if (isAbsolute(file) || file.split(/[\\/]/u).some(part => part === '..' || part === '') || file === PUBLIC_BUILD_RECORD) {
      throw new Error('Invalid public release input path.')
    }
    const target = realpathSync(resolve(base, aliases[file] ?? file))
    const within = relative(base, target)
    if (within.startsWith('..') || isAbsolute(within) || !statSync(target).isFile()) {
      throw new Error('Public release inputs must be regular files within the repository.')
    }
    const original = readFileSync(target)
    const content = runtime ? runtimeBytes(file, original) : original
    if (checkoutPaths.some(path => content.includes(path))) {
      throw new Error('Public release input contains a checkout path; rebuild with portable source locations.')
    }
    const sha256 = createHash('sha256').update(content).digest('hex')
    digest.update(JSON.stringify([file, sha256]) + '\n')
  }
  return { fileCount: sorted.length, sha256: digest.digest('hex') }
}

/**
 * Bind a successful community build to published files that do not embed the checkout path.
 * Call only after the complete client build succeeds with the validated environment.
 * @param {string} root - repository root.
 * @param {string[]} files - complete runtime input list, excluding source maps.
 * @param {Record<string, string | undefined>} environment - actual build environment.
 * @param {string[]} sources - private source inventory that invalidates the record when changed.
 */
export function recordPublicBuild(root, files, environment, sources = files) {
  invalidatePublicBuild(root)
  assertCommunityEnvironment(environment)
  const record = { formatVersion: 2, edition: 'community', artifacts: payloadDigest(root, files, root, {}, true), sourceFiles: sources, sources: payloadDigest(root, sources), facade: payloadDigest(root, sources) }
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
 * @param {string[]} sourceFiles - current private checkout inventory, when available.
 */
export function assertPublicBuild(root, files, environment = process.env, payloadRoot = root, sourceFiles) {
  assertCommunityEnvironment(environment)
  const record = readPublicBuildRecord(root)
  assertDigest(payloadDigest(root, sourceFiles ?? record.sourceFiles), record.sources)
  assertDigest(payloadDigest(payloadRoot, files, root, {}, payloadRoot === root), record.artifacts)
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
 * Validate the full public source tree before creating a public commit.
 * @param {string} root - repository containing the public build record.
 * @param {string} stage - isolated public source directory.
 * @param {string[]} [published] - allowlisted source inventory expected in the stage.
 */
export function assertPublicSources(root, stage, published) {
  const record = readPublicBuildRecord(root)
  const expected = published ?? record.sourceFiles
  const files = stagedFiles(stage)
  assertDigest(payloadDigest(stage, files, root), record.facade)
  const allowed = new Set(expected)
  if (files.length !== allowed.size || files.some(file => !allowed.has(file))) {
    throw new Error('Public source tree must contain exactly the allowlisted source files.')
  }
  for (const file of files) {
    if (isExcludedPublicPath(file) || !isPublicSourcePath(file)) throw new Error(`Public source tree contains an excluded path: ${file}`)
  }
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
  if (record?.formatVersion !== 2 || record.edition !== 'community' || !record.artifacts || !Array.isArray(record.sourceFiles) || !record.facade) {
    throw new Error('Public build record does not identify a community build.')
  }
  return record
}
