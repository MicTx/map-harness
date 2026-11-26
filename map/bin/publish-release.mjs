#!/usr/bin/env node
/**
 * Publish an orphan Git tree carrying the allowlisted full source and native
 * application assets. Gitea retains development source and history; each
 * GitHub release and tag references the public source snapshot of that version.
 *
 * A moved public main, existing release, or failed release create stops
 * dependent writes. Public main uses an exact-OID lease. GitHub alone
 * hosts the release; Gitea receives only the matching annotated tag and
 * no release object.
 *
 * Usage: node map/bin/publish-release.mjs --version vX.Y.Z
 *   [--github <url>] [--web-service <directory>]
 * Requires clean, pushed main and a fresh community build.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPublicSources, publicReleaseInputs } from './pack-runtime.mjs'
import { acceptedWebServiceMatrix, copyWebServiceMatrix } from './web-service-release.mjs'
import { assertCommunityEnvironment, assertPublicBuild, assertPublicSources, assertReleaseVersion, forceWithLease, MAX_GIT_OUTPUT_BYTES, updateNotesOf } from './public-release-privacy.mjs'
import { PUBLIC_FACADE } from './release-content.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_GITHUB = 'https://github.com/MicTx/map-harness-public.git'

/** The LLM install guide every release body carries (`{{version}}` substituted). */
const INSTALL_GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'release-install-guide.md')

/**
 * Compose the release body: the version line, this version's update notes
 * when `map/release/notes/` carries them (validated by `updateNotesOf`,
 * absent files are skipped), then the LLM install guide. Fails loud when
 * the guide is missing or still carries an unknown placeholder.
 * @param releaseVersion - the release tag.
 * @returns the release notes text.
 */
function releaseNotesOf(releaseVersion) {
  const guide = readFileSync(INSTALL_GUIDE, 'utf8').replaceAll('{{version}}', releaseVersion)
  if (/\{\{[^}]*\}\}/.test(guide)) fail(`unresolved placeholder in ${INSTALL_GUIDE}`)
  if (!guide.includes('## Install guide for LLM agents')) fail(`${INSTALL_GUIDE} lost its install-guide heading`)
  const updates = updateNotesOf(ROOT, releaseVersion.slice(1))
  const header = updates === undefined ? `Release ${releaseVersion}.` : `Release ${releaseVersion}.\n\n${updates}`
  return `${header}\n\n${guide}`
}

function git(...argsOrOptions) {
  const options = argsOrOptions.at(-1) instanceof Object ? argsOrOptions.pop() : {}
  const result = spawnSync('git', argsOrOptions, { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, ...options })
  if (result.status !== 0) {
    throw new Error(`git ${argsOrOptions.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function fail(message) {
  console.error(`publish-release: ${message}`)
  process.exit(1)
}

/**
 * Tag the Gitea main at the release provenance. Gitea keeps development
 * source, history, and this annotated tag only; it hosts no release object
 * or notes, and the release with its attachments exists only on GitHub.
 * @param tag - the release tag.
 * @param sha - the Gitea commit the release cites.
 */
function tagGiteaProvenance(tag, sha) {
  if (spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status !== 0) git('tag', '-a', tag, '-m', `map-harness ${tag}`, sha)
  const pushTag = spawnSync('git', ['push', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' })
  if (pushTag.status !== 0 && !/already exists|up-to-date/u.test(pushTag.stderr)) fail(`tag push to Gitea failed:\n${pushTag.stderr}`)
  console.log(`tagged the Gitea provenance ${tag} at ${sha.slice(0, 12)}; Gitea hosts no release`)
}

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let version
let githubUrl = DEFAULT_GITHUB
let webServiceDirectory = resolve(ROOT, '.dsh-build/map-web-service-release')
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === '--version') version = argv[++at]
  else if (argv[at] === '--github') githubUrl = argv[++at]
  else if (argv[at] === '--web-service') webServiceDirectory = resolve(argv[++at])
  else fail(`unknown argument ${argv[at]}; use --version vX.Y.Z [--web-service <directory>] [--github <url>]`)
}
if (version === undefined || !/^v\d+\.\d+\.\d+/.test(version)) {
  fail('--version vX.Y.Z is required (semver tag published to the GitHub release history)')
}

// ── preflight ────────────────────────────────────────────────────────────────
assertCommunityEnvironment(process.env)
const notes = releaseNotesOf(version)
const dirty = git('status', '--porcelain')
  if (dirty.length > 0) {
    console.error('porcelain output:', JSON.stringify(dirty.slice(0, 400)))
  fail('working tree is dirty; commit or stash first — the release must cite a pushed Gitea SHA')
}
const branch = git('branch', '--show-current')
if (branch !== 'main') fail(`release runs from main (got ${branch}); the Gitea main is the release source`)
const giteaSha = git('rev-parse', 'HEAD')
const repo = git('rev-parse', '--show-toplevel')
const shortSha = giteaSha.slice(0, 12)
let classified
try {
  classified = filterPublicSources(
    git('-c', 'core.quotepath=false', 'ls-files').split('\n').filter(file => file.length > 0),
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const { published } = classified
assertPublicBuild(repo, publicReleaseInputs(repo, published), process.env, repo, published)
try {
  assertReleaseVersion(repo, version)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const webService = acceptedWebServiceMatrix(repo, webServiceDirectory, version.slice(1))

// An existing GitHub release means the version line already shipped; this
// publisher never rewrites one, and no remote state is touched before the check.
const ghRepoName = githubUrl.replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '')
const existingRelease = spawnSync('gh', ['release', 'view', version, '--repo', ghRepoName], { encoding: 'utf8' })
if (existingRelease.status === 0) {
  fail(`GitHub release ${version} already exists; this publisher never rewrites an existing release`)
}
if (!/not found|404/i.test(existingRelease.stderr ?? '')) {
  fail(`GitHub release check for ${version} failed:\n${existingRelease.stderr || existingRelease.stdout || 'gh is unavailable'}`)
}

// main must be pushed: the release commit cites this SHA as its provenance.
git('fetch', 'origin', 'main')
const remoteMain = git('rev-parse', 'origin/main')
if (remoteMain !== giteaSha) {
  fail(`Gitea main (${remoteMain.slice(0, 12)}) is not the local HEAD (${shortSha}); push the development source first`)
}

// ── stage the allowlisted full source tree ─────────────────────────────────
// The public repository is a clean snapshot of the published source allowlist:
// private paths, agent state and build records never enter this tree, and the
// private development history is never mirrored. fail() exits the process, so
// cleanup is bound to process exit rather than the success path.
const temporaries = []
process.once('exit', () => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }) })
const stage = mkdtempSync(join(tmpdir(), 'map-release-stage-'))
temporaries.push(stage)
for (const file of published) {
  const source = join(repo, file)
  const target = join(stage, file)
  mkdirSync(dirname(target), { recursive: true })
  const copy = spawnSync('cp', ['-R', source, target])
  if (copy.status !== 0) fail(`staging failed for ${file}`)
}
for (const file of PUBLIC_FACADE) if (!published.includes(file)) fail(`public source tree is missing ${file}`)
console.log(`staged ${published.length} files of the allowlisted full source tree`)

// ── copy accepted script Web service artifacts ──────────────────────────────
assertPublicSources(repo, stage, published)
const assetDir = mkdtempSync(join(tmpdir(), 'map-release-assets-'))
temporaries.push(assetDir)
const assets = copyWebServiceMatrix(webService, assetDir)
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const destination = join(assetDir, file)
  const copy = spawnSync('cp', [join(stage, file), destination])
  if (copy.status !== 0) fail('Cannot copy the validated release licenses.')
  assets.push(destination)
}

// ── build the orphan release commit ─────────────────────────────────────────
process.chdir(stage)
git('init', '-b', 'main', '.')
git('add', '-A')
const commitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'MicTx',
  GIT_AUTHOR_EMAIL: '39692970+MicTx@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'MicTx',
  GIT_COMMITTER_EMAIL: '39692970+MicTx@users.noreply.github.com',
}
const commit = spawnSync('git', ['commit', '-m',
  `release: map-harness ${version}\n\nPublic source snapshot of the allowlisted tree; private development history is not published.`, ], {
  encoding: 'utf8',
  maxBuffer: MAX_GIT_OUTPUT_BYTES,
  env: commitEnv,
})
if (commit.status !== 0) fail(`release commit failed:\n${commit.stderr}`)
const releaseSha = git('rev-parse', 'HEAD')
process.chdir(repo)

// ── publish: rewrite the public main under an exact-OID lease ──────────────
// The lease carries the object id read from the remote right here: any
// concurrent writer moves the remote first and git rejects the push before
// the new history lands.
const remoteOid = git('ls-remote', githubUrl, 'refs/heads/main').split('\t')[0] ?? ''
const push = spawnSync('git', ['-C', stage, 'push', forceWithLease(remoteOid), githubUrl, 'main:main'], { encoding: 'utf8' })
if (push.status !== 0) {
  fail(`release push failed (the remote main moved or rejected the push):\n${push.stderr || push.stdout}`)
}
console.log(`replaced remote main ${remoteOid.slice(0, 12) || '(empty)'} with the ${version} release state`)
// The release object is the point of the public repository: one tagged,
// downloadable state per version, cut from the squashed release commit.
const release = spawnSync('gh', ['release', 'create', version,
  '--repo', ghRepoName,
  '--target', 'main',
  '--title', `map-harness ${version}`,
  '--notes', notes,
], { encoding: 'utf8' })
if (release.status !== 0) {
  fail(`GitHub release create failed; attachments and the Gitea provenance tag were not published:\n${release.stderr || release.stdout}`)
}
const upload = spawnSync('gh', ['release', 'upload', version, ...assets,
  '--repo', ghRepoName], { encoding: 'utf8' })
if (upload.status !== 0) fail(`runtime archive upload to GitHub failed:\n${upload.stderr || upload.stdout}`)
console.log(`attached ${assets.map(file => file.split('/').at(-1)).join(', ')} to the GitHub release`)
tagGiteaProvenance(version, giteaSha)
console.log(`published ${version}: ${releaseSha.slice(0, 12)} → ${githubUrl} main (gitea provenance ${shortSha})`)
