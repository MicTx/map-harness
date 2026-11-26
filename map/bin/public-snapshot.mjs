#!/usr/bin/env node
/**
 * Publish the allowlisted full-source snapshot to the public GitHub repository.
 *
 * The private Gitea repository remains the development source of truth. The public
 * repository receives one orphan commit cut from a clean staging tree: private
 * development history, session recordings, agent state, credentials, worktrees and
 * maintainer paths never enter it. A GitHub Release / web-service archive matrix
 * belongs to map/bin/publish-release.mjs and is intentionally not created here.
 *
 * The staged tree is rewritten before it is committed: links to tracked paths
 * that are not published lose their target and keep their text, and the
 * translation pairs whose documents changed are re-recorded. `--apply` and
 * `--dry-run --verify` then check out that exact commit in a separate directory,
 * install it offline, and run build:artifacts, the map build, build:check,
 * verify-md-links, verify-translation-pairing, and verify-third-party-notices
 * against it; private repository results never stand in for the public tree.
 *
 * Usage:
 *   node map/bin/public-snapshot.mjs --version v0.1.16 --dry-run [--verify]
 *   node map/bin/public-snapshot.mjs --version v0.1.16 --apply --authorization "<who authorized and how>"
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePublicTree, auditPublicTree, treeDigest } from './audit-public-tree.mjs'
import { stripStagedUnpublishedLinks } from './public-links.mjs'
import { PUBLIC_FACADE } from './release-content.mjs'
import { forceWithLease, readProductVersion } from './public-release-privacy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GITHUB = 'https://github.com/MicTx/map-harness-public.git'
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024
/**
 * The public-tree checks run against the verification copy, in order. The
 * map workspace builds after the upstream artifacts and before build:check,
 * the same order a clean private checkout needs.
 */
const PUBLIC_TREE_GATES = [
  { name: 'build:artifacts', command: ['pnpm', 'run', 'build:artifacts'] },
  { name: 'map build', command: ['node', 'map/bin/build.mjs'] },
  { name: 'build:check', command: ['pnpm', 'run', 'build:check'] },
  { name: 'verify-md-links', command: ['pnpm', 'run', 'verify-md-links'] },
  { name: 'verify-translation-pairing', command: ['pnpm', 'run', 'verify-translation-pairing'] },
  { name: 'verify-third-party-notices', command: ['pnpm', 'run', 'verify-third-party-notices'] },
]
const temporaries = []
process.once('exit', () => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }) })

/** The governance receipt path for one version. */
export function receiptPathOf(version) {
  return `.maintainer/public-snapshot-${version}.json`
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: GIT_OUTPUT_BYTES })
  // git writes commit summaries to stderr on success; only the exit status is authoritative.
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function fail(message) { console.error(`public-snapshot: ${message}`); process.exit(1) }

/** The changed documents that belong to an English/Chinese pair in the staged tree. */
function pairedDocuments(stage, documents) {
  return documents.filter(file => file.endsWith('.zh.md')
    || (file.endsWith('.md') && existsSync(join(stage, `${file.slice(0, -'.md'.length)}.zh.md`))))
}

/**
 * Re-record the translation pairs whose documents the link rewrite changed,
 * with the staged tree's own pairing tool so the records hash the published
 * bytes. The tool resolves its dependencies through a temporary
 * `node_modules` link that is removed before the tree is committed.
 * @returns {string[]} the pair documents passed to the recorder.
 */
function recordChangedPairs(stage, changedDocuments) {
  const pairs = pairedDocuments(stage, changedDocuments)
  if (pairs.length === 0) return []
  const link = join(stage, 'node_modules')
  symlinkSync(join(ROOT, 'node_modules'), link, 'dir')
  try {
    const record = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(stage, 'scripts', 'verify-translation-pairing.ts'), '--write', ...pairs],
      { cwd: stage, encoding: 'utf8', maxBuffer: GIT_OUTPUT_BYTES })
    if (record.status !== 0) throw new Error(`translation pairs could not be re-recorded: ${(record.stderr || record.stdout).slice(-2000)}`)
  } finally { rmSync(link, { force: true }) }
  return pairs
}

/** Stage, audit and commit the allowlisted tree in an isolated temporary staging directory. */
export function buildSnapshot(version, { commit = false } = {}) {
  const product = readProductVersion(ROOT)
  if (version !== `v${product}`) throw new Error(`release ${version} does not match the product version ${product}`)
  const stage = mkdtempSync(join(tmpdir(), 'map-public-snapshot-'))
  temporaries.push(stage)
  const { published, excluded } = stagePublicTree(stage)
  const links = stripStagedUnpublishedLinks(stage, { published, excluded })
  const audit = auditPublicTree(stage, { published, excluded })
  if (audit.violations.length > 0) throw new Error(`public tree audit failed: ${audit.violations.slice(0, 8).join('; ')}`)
  const missingFacade = PUBLIC_FACADE.filter(file => !published.includes(file))
  if (missingFacade.length > 0) throw new Error(`public facade missing: ${missingFacade.join(', ')}`)
  const licence = readFileSync(join(stage, 'LICENSE'), 'utf8')
  if (!/PolyForm Noncommercial|polyform|noncommercial/i.test(licence)) throw new Error('public LICENSE is not PolyForm Noncommercial 1.0.0')
  const readme = readFileSync(join(stage, 'README.md'), 'utf8')
  if (!/README\.zh\.md|中文|Chinese|\[.*\]\(README\.zh\.md\)/u.test(readme)) throw new Error('English README does not link the Chinese README')

  let orphanSha = null
  let recordedPairs = []
  if (commit) {
    git('-C', stage, 'init', '-b', 'main', '.')
    // The pairing tool reads the index, so the rewritten tree is staged before it records.
    git('-C', stage, 'add', '-A')
    recordedPairs = recordChangedPairs(stage, links.changedDocuments)
    git('-C', stage, 'add', '-A')
    const env = { ...process.env, GIT_AUTHOR_NAME: 'MicTx', GIT_AUTHOR_EMAIL: '39692970+MicTx@users.noreply.github.com', GIT_COMMITTER_NAME: 'MicTx', GIT_COMMITTER_EMAIL: '39692970+MicTx@users.noreply.github.com' }
    // 18k create-mode lines exceed spawnSync's default maxBuffer; a truncated
    // commit reports a non-zero status even though the commit succeeded.
    const made = spawnSync('git', ['-C', stage, 'commit', '-q', '-m', `release: map-harness ${version}\n\nPublic source snapshot of the allowlisted tree; private development history is not published.`], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 })
    if (made.status !== 0) throw new Error(`orphan commit failed: ${made.stderr || made.stdout}`)
    orphanSha = git('-C', stage, 'rev-parse', 'HEAD')
    if (!/^[0-9a-f]{40}$/u.test(orphanSha)) throw new Error('orphan commit has no valid SHA')
    // A lone commit with no parents: the private development history is never mirrored.
    const parents = git('-C', stage, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length
    if (parents !== 1) throw new Error('orphan commit must have no parents')
  }
  return {
    version, stage, published, excluded, sha256: treeDigest(stage, published), audit, facade: PUBLIC_FACADE, orphanSha,
    fileCount: published.length, excludedCount: excluded.length,
    removedLinks: links.removedLinks, changedDocuments: links.changedDocuments, recordedPairs,
  }
}

/**
 * Check out the committed snapshot in a separate directory and run the
 * public-tree gates against it. The copy is installed offline from the local
 * pnpm store without lifecycle scripts, so build outputs never touch the
 * commit and no network fetch can change what is checked.
 * @param {{ stage: string, orphanSha: string }} snap - the committed snapshot.
 * @returns {{ commit: string, gates: { name: string, status: 'passed' }[] }} the passed gates.
 * @throws {Error} naming the first failing step with the tail of its output.
 */
export function verifySnapshot(snap) {
  if (snap.orphanSha === null) throw new Error('only a committed snapshot can be verified')
  const copy = mkdtempSync(join(tmpdir(), 'map-public-verify-'))
  temporaries.push(copy)
  git('clone', '-q', '--no-hardlinks', snap.stage, copy)
  if (git('-C', copy, 'rev-parse', 'HEAD') !== snap.orphanSha) throw new Error('the verification copy is not the snapshot commit')
  const run = (name, [command, ...args]) => {
    const result = spawnSync(command, args, { cwd: copy, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`public tree ${name} failed: ${`${result.stdout}\n${result.stderr}`.trim().slice(-3000)}`)
  }
  run('install', ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'])
  const gates = []
  for (const gate of PUBLIC_TREE_GATES) {
    run(gate.name, gate.command)
    gates.push({ name: gate.name, status: 'passed' })
  }
  return { commit: snap.orphanSha, gates }
}

/**
 * Read-only report: classification, audit result, link rewrite, facade, and the
 * would-be orphan SHA; with `verify`, also the public-tree gate results. Nothing
 * outside the temporary directories is written and no remote is contacted.
 */
export function dryRun(version, { verify = false } = {}) {
  const snap = buildSnapshot(version, { commit: true })
  return {
    version, published: snap.published, facade: snap.facade,
    audit: { violations: snap.audit.violations, files: snap.audit.files.length },
    links: { removed: snap.removedLinks, changedDocuments: snap.changedDocuments.length, recordedPairs: snap.recordedPairs.length },
    sha256: snap.sha256, orphanSha: snap.orphanSha, fileCount: snap.fileCount, excludedCount: snap.excludedCount,
    ...(verify ? { verification: verifySnapshot(snap) } : {}),
    github: GITHUB, dryRun: true,
  }
}

/**
 * Verify the committed snapshot, push it under an exact-OID lease, and write
 * the governance receipt. A failed gate publishes nothing.
 * @param {string} version - the product version tag, `vX.Y.Z`.
 * @param {string} authorization - who authorized this publish and how, recorded verbatim.
 */
export function apply(version, authorization) {
  if (typeof authorization !== 'string' || authorization.trim().length === 0) throw new Error('--apply requires --authorization naming who authorized the publish')
  const snap = buildSnapshot(version, { commit: true })
  const verification = verifySnapshot(snap)
  const remoteOid = git('ls-remote', GITHUB, 'refs/heads/main').split('\t')[0] ?? ''
  if (!/^[0-9a-f]{40}$/u.test(remoteOid)) throw new Error('cannot read the public main OID; refusing to push')
  const push = spawnSync('git', ['-C', snap.stage, 'push', forceWithLease(remoteOid), GITHUB, 'main:main'], { encoding: 'utf8' })
  if (push.status !== 0) throw new Error(`public main push failed: ${push.stderr || push.stdout}`)
  const pushedOid = git('ls-remote', GITHUB, 'refs/heads/main').split('\t')[0]
  if (pushedOid !== snap.orphanSha) throw new Error(`public main ${pushedOid.slice(0, 12)} is not the snapshot ${snap.orphanSha.slice(0, 12)}`)

  const giteaSha = git('rev-parse', 'HEAD')
  const receipt = {
    format: 'map-harness-public-snapshot-1',
    version, authorization,
    stagingPath: snap.stage,
    gate: {
      allowlist: 'map/bin/pack-runtime.mjs:filterPublicSources + map/bin/public-release-privacy.mjs:isPrivate',
      audit: 'map/bin/audit-public-tree.mjs:auditPublicTree',
      violations: snap.audit.violations.length,
      removedPrivateLinks: snap.removedLinks,
      changedDocuments: snap.changedDocuments.length,
      bilingualPairsRecorded: snap.recordedPairs.length,
      publicTreeGates: verification.gates,
      facade: snap.facade, treeSha256: snap.sha256, fileCount: snap.fileCount, excludedCount: snap.excludedCount,
    },
    giteaSha, githubSha: snap.orphanSha, githubMainBefore: remoteOid,
    releaseObject: 'not created (web-service archive matrix belongs to publish-release.mjs)',
    generatedAt: new Date().toISOString(),
  }
  const receiptPath = join(ROOT, receiptPathOf(version))
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receipt
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const valueOf = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
  const version = valueOf('--version')
  if (version === undefined || !/^v\d+\.\d+\.\d+$/u.test(version)) fail('usage: --version vX.Y.Z (--dry-run [--verify] | --apply --authorization "<text>")')
  if (args.includes('--dry-run') === args.includes('--apply')) fail('give exactly one of --dry-run or --apply')
  try {
    if (args.includes('--dry-run')) {
      const report = dryRun(version, { verify: args.includes('--verify') })
      console.error(`audit: PASS (${report.audit.violations.length} violations, ${report.fileCount} files, ${report.excludedCount} excluded, ${report.links.removed} links removed from ${report.links.changedDocuments} documents)`)
      console.log(JSON.stringify(report, null, 2))
    } else {
      const receipt = apply(version, valueOf('--authorization'))
      console.error(`public main updated: ${receipt.githubMainBefore.slice(0, 12)} -> ${receipt.githubSha.slice(0, 12)}`)
      console.log(JSON.stringify(receipt, null, 2))
    }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
}
