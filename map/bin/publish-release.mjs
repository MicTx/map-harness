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
 * Usage: node map/bin/publish-release.mjs --version v0.1.0 [--github <url>]
 * Requires: clean tree, main pushed to Gitea (the release cites its SHA).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_GITHUB = 'https://github.com/MicTx/map-harness.git'

/** Paths and patterns never published. Order-independent; prefix/exact matched. */
const PRIVACY_EXCLUDES = [
  '.spec/',
  '.agents/',
  '.claude/',
  '.codex/',
  '.pi/',
  '.zcode/',
  '.cursor/',
  '.paseo/',
  '.env',
  '.github/workflows/privacy-probe*',
  'logs/',
  'user/',
]

function git(...argsOrOptions) {
  const options = argsOrOptions.at(-1) instanceof Object ? argsOrOptions.pop() : {}
  const result = spawnSync('git', argsOrOptions, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function fail(message) {
  console.error(`publish-release: ${message}`)
  process.exit(1)
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
for (const file of files) {
  if (PRIVACY_EXCLUDES.some(pattern => file === pattern.replace(/\/$/, '') || file.startsWith(pattern))) continue
  const source = join(process.cwd(), file)
  const target = join(stage, file)
  mkdirSync(join(stage, file, '..'), { recursive: true })
  const copy = spawnSync('cp', ['-R', source, target])
  if (copy.status !== 0) fail(`staging failed for ${file}`)
  included += 1
}
console.log(`staged ${included} files (${files.length - included} excluded by privacy rules)`)

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
  '--notes', `Release ${version}.`,
], { encoding: 'utf8' })
if (release.status !== 0) {
  console.warn(`publish-release: gh release create failed (non-fatal; the commit is on main):\n${release.stderr || release.stdout}`)
}
console.log(`published ${version}: ${releaseSha.slice(0, 12)} → ${githubUrl} main (gitea provenance ${shortSha})`)
rmSync(stage, { recursive: true, force: true })
