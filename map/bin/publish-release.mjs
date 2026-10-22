#!/usr/bin/env node
/**
 * Release publisher: GitHub carries RELEASE STATES ONLY — one squashed commit
 * per release on an orphan history, never the Gitea development history
 * (Gitea stays the full-history source of truth).
 *
 * Staging is allowlist-driven: the privacy excludes below strip task packages,
 * agent state, credentials, logs, and session stores from the release tree.
 * Author identity is the repo-configured MicTx noreply; no real-name email
 * ever reaches the public repository.
 *
 * Every GitHub release also attaches the prebuilt runtime archive
 * (`pack-runtime.mjs`: the same privacy-filtered tree plus build outputs, no
 * dependencies). The Gitea release on the same tag carries the notes only:
 * the Gitea proxy drops large uploads, so runtime archives live on GitHub.
 *
 * Usage: node map/bin/publish-release.mjs --version v0.1.0 [--github <url>] [--skip-gitea-check]
 * Requires: clean tree, main pushed to Gitea (the release cites its SHA), and
 * a fresh `pnpm run build:lib && node map/bin/build-web.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrivate, packRuntime } from './pack-runtime.mjs'

const DEFAULT_GITHUB = 'https://github.com/MicTx/map-harness.git'

/** The LLM install guide every release body carries (`{{version}}` substituted). */
const INSTALL_GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'release-install-guide.md')

/**
 * Compose the release body: the version line, then the LLM install guide.
 * Fails loud when the guide is missing or still carries an unknown placeholder.
 * @param releaseVersion - the release tag.
 * @returns the release notes text.
 */
function releaseNotesOf(releaseVersion) {
  const guide = readFileSync(INSTALL_GUIDE, 'utf8').replaceAll('{{version}}', releaseVersion)
  if (/\{\{[^}]*\}\}/.test(guide)) fail(`unresolved placeholder in ${INSTALL_GUIDE}`)
  if (!guide.includes('## Install guide for LLM agents')) fail(`${INSTALL_GUIDE} lost its install-guide heading`)
  return `Release ${releaseVersion}.\n\n${guide}`
}

function git(...argsOrOptions) {
  const options = argsOrOptions.at(-1) instanceof Object ? argsOrOptions.pop() : {}
  const result = spawnSync('git', argsOrOptions, { encoding: 'utf8', ...options })
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
 * Tag the Gitea main at the release provenance and create (or update) the
 * Gitea release with the same notes; no archives are attached there. Credentials come
 * from the git credential helper for the origin host; they are never printed.
 * @param tag - the release tag.
 * @param body - the release notes.
 * @param sha - the Gitea commit the release cites.
 */
async function publishGiteaRelease(tag, body, sha) {
  const origin = git('remote', 'get-url', 'origin')
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(origin)
  if (match === null) fail(`origin ${origin} is not an https Gitea remote`)
  const [, host, owner, name] = match
  const credential = spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8' })
  const fields = Object.fromEntries(credential.stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  if (fields.username === undefined || fields.password === undefined) fail(`no git credential for ${host}; the Gitea release needs one`)
  const auth = `Basic ${Buffer.from(`${fields.username}:${fields.password}`).toString('base64')}`
  const api = `https://${host}/api/v1/repos/${owner}/${name}`
  if (spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status !== 0) git('tag', '-a', tag, '-m', `map-harness ${tag}`, sha)
  const pushTag = spawnSync('git', ['push', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' })
  if (pushTag.status !== 0 && !/already exists|up-to-date/u.test(pushTag.stderr)) fail(`tag push to Gitea failed:\n${pushTag.stderr}`)
  const call = async (method, path, init = {}) => {
    const response = await fetch(`${api}${path}`, { method, ...init, headers: { authorization: auth, ...(init.headers ?? {}) } })
    const text = await response.text()
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null }
  }
  let release = await call('GET', `/releases/tags/${tag}`)
  const payload = JSON.stringify({ tag_name: tag, name: `map-harness ${tag}`, body, draft: false, prerelease: false })
  release = release.status === 200
    ? await call('PATCH', `/releases/${release.json.id}`, { body: payload, headers: { 'content-type': 'application/json' } })
    : await call('POST', '/releases', { body: payload, headers: { 'content-type': 'application/json' } })
  // Gitea 1.27 keeps a hidden tag-only release row after a tag push: the tag
  // lookup above misses it and the first create collides on the unique name.
  // Creating again with only tag/name/body converts that row in place.
  if (release.status === 500 && /UQE_release_n|duplicate key/u.test(release.json?.message ?? '')) {
    release = await call('POST', '/releases', { body: JSON.stringify({ tag_name: tag, name: `map-harness ${tag}`, body }), headers: { 'content-type': 'application/json' } })
  }
  if (release.status >= 300) fail(`Gitea release write failed (HTTP ${release.status}): ${release.json?.message ?? ''}`)
  console.log(`published the Gitea release ${tag} (notes only; runtime archives are on GitHub)`)
}

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let version
let githubUrl = DEFAULT_GITHUB
let skipGiteaCheck = false
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === '--version') version = argv[++at]
  else if (argv[at] === '--github') githubUrl = argv[++at]
  else if (argv[at] === '--skip-gitea-check') skipGiteaCheck = true
  else fail(`unknown argument ${argv[at]}; use --version vX.Y.Z [--skip-gitea-check] [--github <url>]`)
}
if (version === undefined || !/^v\d+\.\d+\.\d+/.test(version)) {
  fail('--version vX.Y.Z is required (semver tag published to the GitHub release history)')
}

// ── preflight ────────────────────────────────────────────────────────────────
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

// main must be pushed: the release commit cites this SHA as its provenance.
// --skip-gitea-check is the documented outage fallback: the Gitea host is
// unreachable, so the release cites the local SHA and must be pushed there
// once the host recovers (network recovery checklist in map/docs/github-release.md).
if (skipGiteaCheck) {
  console.warn(`publish-release: Gitea check skipped (outage fallback); push ${shortSha} to Gitea when the host recovers`)
} else {
  git('fetch', 'origin', 'main')
  const remoteMain = git('rev-parse', 'origin/main')
  if (remoteMain !== giteaSha) {
    fail(`Gitea main (${remoteMain.slice(0, 12)}) is not the local HEAD (${shortSha}); push the development source first`)
  }
}

// ── stage the allowlisted tree ───────────────────────────────────────────────
const stage = mkdtempSync(join(tmpdir(), 'map-release-stage-'))
const files = git('-c', 'core.quotepath=false', 'ls-files').split('\n').filter(file => file.length > 0)
let included = 0
const published = []
for (const file of files) {
  if (isPrivate(file)) continue
  const source = join(process.cwd(), file)
  const target = join(stage, file)
  mkdirSync(join(stage, file, '..'), { recursive: true })
  const copy = spawnSync('cp', ['-R', source, target])
  if (copy.status !== 0) fail(`staging failed for ${file}`)
  published.push(file)
  included += 1
}
console.log(`staged ${included} files (${files.length - included} excluded by privacy rules)`)

// ── pack the prebuilt runtime archive from the same published file list ──────
const assetDir = mkdtempSync(join(tmpdir(), 'map-release-assets-'))
const runtime = packRuntime({ version, out: assetDir, tracked: published })

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
  `release: map-harness ${version}\n\nRelease state ${shortSha}. This repository carries release states only.`, ], {
  encoding: 'utf8',
  env: commitEnv,
})
if (commit.status !== 0) fail(`release commit failed:\n${commit.stderr}`)
const releaseSha = git('rev-parse', 'HEAD')
process.chdir(process.env.OLDPWD || repo)

// ── publish: force-push the release history + GitHub release object ─────────
// Each release replaces the published history BY DESIGN (orphan release
// commits) — a lease would always read as stale. The previous remote value
// is audited here instead: the operator sees exactly what was replaced.
const remoteBefore = (git('ls-remote', githubUrl, 'main').split('\t')[0] ?? '').slice(0, 12)
const push = spawnSync('git', ['-C', stage, 'push', '--force', githubUrl, 'main:main'], { encoding: 'utf8' })
if (push.status !== 0) {
  fail(`release push failed:\n${push.stderr || push.stdout}`)
}
console.log(`replaced remote main ${remoteBefore || '(empty)'} with the ${version} release state`)
// The release object is the point of the public repository: one tagged,
// downloadable state per version, cut from the squashed release commit.
const release = spawnSync('gh', ['release', 'create', version,
  '--repo', githubUrl.replace(/^https:\/\//, '').replace(/\.git$/, '').replace('github.com/', 'github.com/'),
  '--target', 'main',
  '--title', `map-harness ${version}`,
  '--notes', notes,
], { encoding: 'utf8' })
if (release.status !== 0) {
  console.warn(`publish-release: gh release create failed (non-fatal; the commit is on main):\n${release.stderr || release.stdout}`)
}
const upload = spawnSync('gh', ['release', 'upload', version, runtime.zip, runtime.tgz, '--clobber',
  '--repo', githubUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')], { encoding: 'utf8' })
if (upload.status !== 0) fail(`runtime archive upload to GitHub failed:\n${upload.stderr || upload.stdout}`)
console.log(`attached ${runtime.zip.split('/').at(-1)} and ${runtime.tgz.split('/').at(-1)} to the GitHub release`)
await publishGiteaRelease(version, notes, giteaSha)
console.log(`published ${version}: ${releaseSha.slice(0, 12)} → ${githubUrl} main (gitea provenance ${shortSha})`)
rmSync(stage, { recursive: true, force: true })
rmSync(assetDir, { recursive: true, force: true })
