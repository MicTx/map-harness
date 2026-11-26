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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPublicSources } from './pack-runtime.mjs'
import { remainingUnpublishedLinks } from './public-links.mjs'
import { isPrivate, isPublicSourcePath } from './public-release-privacy.mjs'

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
      if (!existsSync(join(root, resolved))) throw new Error(`Public source symlink dangles: ${child} -> ${resolved}`)
      return [child]
    }
    if (!entry.isFile()) throw new Error(`Public source tree contains a non-regular file: ${child}`)
    return [child]
  })
  return walk('').sort()
}
const isAbsolutePath = path => path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)

/**
 * Move every published symlink whose in-repository target is not published
 * to the excluded list, following chains until no such link remains: a link
 * into an excluded tree would dangle on GitHub and name private material.
 * @param {string[]} published - allowlisted paths.
 * @param {string[]} excluded - privacy exclusions.
 * @returns {{ published: string[], excluded: string[] }} the corrected classification.
 */
export function excludeUnpublishedSymlinks(published, excluded, root = ROOT) {
  let kept = published
  const dropped = []
  for (;;) {
    const files = new Set(kept)
    const dirs = new Set()
    for (const file of kept) {
      for (let dir = posix.dirname(file); dir !== '.' && !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir)
    }
    const dangling = kept.filter(file => {
      if (!lstatSync(join(root, file)).isSymbolicLink()) return false
      const target = posix.normalize(posix.join(posix.dirname(file), readlinkSync(join(root, file)).split('\\').join('/')))
      return !files.has(target) && !dirs.has(target)
    })
    if (dangling.length === 0) return { published: kept, excluded: [...excluded, ...dropped].sort() }
    dropped.push(...dangling)
    kept = kept.filter(file => !dangling.includes(file))
  }
}

/**
 * Classify and copy the allowlisted source tree into an isolated staging dir.
 * @param {string} stage - empty staging directory.
 * @returns {{ published: string[], excluded: string[], sha256: string }}
 */
export function stagePublicTree(stage) {
  const listing = spawnSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (listing.status !== 0) throw new Error('Cannot enumerate tracked source files.')
  const tracked = listing.stdout.split('\n').filter(file => file.length > 0)
  const classified = filterPublicSources(tracked)
  const { published, excluded } = excludeUnpublishedSymlinks(classified.published, classified.excluded)
  for (const file of published) {
    const source = join(ROOT, file)
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    const copy = spawnSync('cp', ['-R', source, target])
    if (copy.status !== 0) throw new Error(`staging failed for ${file}`)
  }
  return { published, excluded, sha256: treeDigest(stage, published) }
}

/**
 * Digest one staged tree as the ordered list of `[path, sha256]` pairs, so a
 * receipt names the exact bytes that were published.
 * @param {string} stage - staged public source tree.
 * @param {string[]} files - the published paths, in classification order.
 * @returns {string} the hex digest.
 */
export function treeDigest(stage, files) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(JSON.stringify([file, createHash('sha256').update(readFileSync(join(stage, file))).digest('hex')]) + '\n')
  }
  return digest.digest('hex')
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
    if (isPrivate(file)) violations.push(`private path: ${file}`)
    if (!isPublicSourcePath(file)) violations.push(`outside public source allowlist: ${file}`)
  }
  const actual = new Set(files)
  for (const missing of expected.published) {
    if (!actual.has(missing)) violations.push(`missing allowlisted file: ${missing}`)
  }
  for (const link of remainingUnpublishedLinks(stage, expected)) violations.push(`link to an unpublished path: ${link}`)
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
    writeFileSync(join(stage, 'map/bin/tool.mjs'), 'export const ok = true\n')
    const recording = 'map/bin/session.v4.jsonl'
    writeFileSync(join(stage, recording), '{}\n')
    writeFileSync(join(stage, 'README.md'), 'See [the plan](.spec/specs/p/spec.md).\n')
    const leaked = auditPublicTree(stage, {
      published: ['README.md', 'map/bin/tool.mjs', recording],
      excluded: ['.spec/specs/p/spec.md'],
    }).violations
    if (!leaked.includes(`private path: ${recording}`)) throw new Error('a staged session recording was missed')
    if (!leaked.some(line => line.startsWith('link to an unpublished path'))) throw new Error('a link to an unpublished path was missed')
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
