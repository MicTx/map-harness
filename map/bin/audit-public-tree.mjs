#!/usr/bin/env node
/**
 * Stage and audit the public source tree before a GitHub snapshot is published.
 * The inventory comes from the release chain's own default-deny allowlist, so
 * this tool can never drift into a different notion of "public source".
 *
 * Usage: node map/bin/audit-public-tree.mjs --evidence <package evidence dir>
 *        node map/bin/audit-public-tree.mjs --self-test
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPublicSources } from './pack-runtime.mjs'
import { isPublicSourcePath } from './public-release-privacy.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * Content markers that fail the public gate closed, independent of path rules.
 * The Gitea key name is assembled so this auditor does not match its own rule.
 */
const PRIVATE_CONTENT = [
  new RegExp(`gitea_${'ed25519'}`, 'u'),
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /ssh:\/\/git@[^ ]+:10022/u,
  /sk-[a-f0-9]{32}/u,
]

/** Directories whose entire subtree is excluded from the public snapshot. */
const PRIVATE_SEGMENTS = new Set(['.spec', '.agents', '.claude', '.codex', '.pi', '.zcode', '.cursor', '.paseo'])

/** Enumerate every entry in a staging tree. Symlinks are allowed when their
 * target stays inside the tree; anything else fails the gate closed. */
function stagedFiles(root) {
  const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const child = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) return walk(child)
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(join(root, child))
      const resolved = relative(root, resolve(dirname(join(root, child)), target))
      if (resolved.startsWith('..') || isAbsolutePath(resolved)) throw new Error(`Public source symlink escapes the tree: ${child}`)
      return [child]
    }
    if (!entry.isFile()) throw new Error(`Public source tree contains a non-regular file: ${child}`)
    return [child]
  })
  return walk('').sort()
}
const isAbsolutePath = path => path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)

/**
 * Classify and copy the allowlisted source tree into an isolated staging dir.
 * @param {string} stage - empty staging directory.
 * @returns {{ published: string[], excluded: string[], sha256: string }}
 */
export function stagePublicTree(stage) {
  const listing = spawnSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (listing.status !== 0) throw new Error('Cannot enumerate tracked source files.')
  const tracked = listing.stdout.split('\n').filter(file => file.length > 0)
  const { published, excluded } = filterPublicSources(tracked)
  for (const file of published) {
    const source = join(ROOT, file)
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    const copy = spawnSync('cp', ['-R', source, target])
    if (copy.status !== 0) throw new Error(`staging failed for ${file}`)
  }
  const digest = createHash('sha256')
  for (const file of published) {
    digest.update(JSON.stringify([file, createHash('sha256').update(readFileSync(join(stage, file))).digest('hex')]) + '\n')
  }
  return { published, excluded, sha256: digest.digest('hex') }
}

/**
 * Audit one staged tree: exact allowlist equality, path exclusions, and content markers.
 * @param {string} stage - staged public source tree.
 * @param {{ published: string[], excluded: string[] }} expected - classification from stagePublicTree.
 * @returns {{ files: string[], violations: string[] }}
 */
export function auditPublicTree(stage, expected) {
  const files = stagedFiles(stage)
  const violations = []
  const allowed = new Set(expected.published)
  for (const file of files) {
    if (!allowed.has(file)) violations.push(`unlisted path: ${file}`)
    if (file.split('/').some(part => PRIVATE_SEGMENTS.has(part))) violations.push(`private state path: ${file}`)
    if (/(?:^|\/)\.env|\.env(?:\.[^/]*)?$/u.test(file)) violations.push(`environment file: ${file}`)
    if (!isPublicSourcePath(file)) violations.push(`outside public source allowlist: ${file}`)
    if (file === 'map/docs/github-release.md') violations.push('maintainer release procedure: ' + file)
  }
  for (const missing of expected.published) {
    if (!files.includes(missing)) violations.push(`missing allowlisted file: ${missing}`)
  }
  for (const file of files) {
    const bytes = readFileSync(join(stage, file))
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    for (const marker of PRIVATE_CONTENT) {
      if (marker.test(text)) violations.push(`private content marker in ${file}: ${marker.source}`)
    }
  }
  return { files, violations }
}

/** Verify the auditor's own path/content rules without touching the network. */
export function selfTest() {
  const stage = mkdtempSync(join(tmpdir(), 'map-audit-'))
  try {
    mkdirSync(join(stage, 'map/bin'), { recursive: true })
    writeFileSync(join(stage, 'README.md'), 'Map Harness\n')
    writeFileSync(join(stage, 'map/bin/tool.mjs'), 'export const ok = true\n')
    const classification = { published: ['README.md', 'map/bin/tool.mjs'], excluded: [] }
    if (auditPublicTree(stage, classification).violations.length !== 0) throw new Error('clean tree was rejected')
    writeFileSync(join(stage, 'map/bin/tool.mjs'), `const host = ${JSON.stringify(`gitea_${'ed25519'}`)}\n`)
    const dirty = auditPublicTree(stage, classification).violations
    if (!dirty.some(line => line.includes('private content marker'))) throw new Error('private content marker was missed')
    return true
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    selfTest()
    console.log('audit-public-tree: self-test passed')
    return
  }
  const at = argv.indexOf('--evidence')
  if (at < 0 || argv[at + 1] === undefined) throw new Error('--evidence <directory> is required')
  const evidence = resolve(ROOT, argv[at + 1])
  mkdirSync(evidence, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), 'map-public-tree-'))
  try {
    const classification = stagePublicTree(stage)
    const { files, violations } = auditPublicTree(stage, classification)
    const audit = [
      `published ${classification.published.length}`,
      `excluded ${classification.excluded.length}`,
      `staged ${files.length}`,
      `sha256 ${classification.sha256}`,
      `violations ${violations.length}`,
      ...violations.map(line => `violation ${line}`),
      `self-test ${selfTest() ? 'passed' : 'failed'}`,
    ].join('\n') + '\n'
    writeFileSync(join(evidence, 'public-tree-audit.txt'), audit)
    writeFileSync(join(evidence, 'public-tree-manifest.txt'), files.join('\n') + '\n')
    console.log(`audit-public-tree: ${classification.published.length} published, ${classification.excluded.length} excluded, ${violations.length} violations`)
    if (violations.length > 0) {
      console.error(violations.slice(0, 20).join('\n'))
      process.exitCode = 1
    }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
