/** Public source snapshot: allowlist, facade, privacy audit, orphan commit, dry-run isolation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, buildSnapshot, dryRun, receiptPathOf } from './public-snapshot.mjs'
import { PUBLIC_FACADE } from './release-content.mjs'
import { filterPublicSources } from './pack-runtime.mjs'
import { isPrivate, PUBLIC_SNAPSHOT_FIXTURES } from './public-release-privacy.mjs'
import * as auditModule from './audit-public-tree.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const version = 'v0.1.16'

test('the tool refuses a version that does not match the product version source', () => {
  assert.throws(() => buildSnapshot('v0.1.15'), /does not match the product version/u)
})

test('dry-run stages the allowlisted tree, audits it, and never writes a remote or a receipt', () => {
  const before = spawnSync('git', ['ls-remote', 'https://github.com/MicTx/map-harness-public.git', 'refs/heads/main'], { encoding: 'utf8' })
  const receiptPath = join(ROOT, receiptPathOf(version))
  const beforeReceipt = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null
  const report = dryRun(version)
  assert.equal(report.dryRun, true)
  assert.equal(report.audit.violations.length, 0)
  assert.equal(report.fileCount, report.published.length)
  assert.ok(report.fileCount > 10000)
  assert.ok(report.excludedCount > 1000)
  for (const file of PUBLIC_FACADE) assert.ok(report.published.includes(file), `facade ${file}`)
  assert.deepEqual(report.published.filter(file => file.startsWith('snapshots/')).sort(), [...PUBLIC_SNAPSHOT_FIXTURES].sort(), 'only the source fixtures of the recorded-session tree are published')
  assert.equal(report.published.some(isPrivate), false, 'the committed snapshot contains no private path')
  assert.ok(report.links.removed > 0 && report.links.changedDocuments > 0, 'links to unpublished paths were stripped')
  assert.equal(report.verification, undefined, 'a plain dry-run does not run the public-tree gates')
  assert.match(report.orphanSha, /^[0-9a-f]{40}$/u)
  const afterReceipt = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null
  assert.equal(afterReceipt, beforeReceipt, 'dry-run leaves the receipt untouched')
  const after = spawnSync('git', ['ls-remote', 'https://github.com/MicTx/map-harness-public.git', 'refs/heads/main'], { encoding: 'utf8' })
  assert.equal(after.stdout, before.stdout, 'dry-run leaves the public main OID untouched')
})

test('apply refuses before any staging or remote read when no authorization is named', () => {
  assert.throws(() => apply(version, undefined), /requires --authorization/u)
  assert.throws(() => apply(version, '   '), /requires --authorization/u)
})

test('a published symlink into an unpublished tree is excluded with its target', t => {
  const root = mkdtempSync(join(tmpdir(), 'map-public-symlink-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/a'), { recursive: true })
  mkdirSync(join(root, 'snapshots/s'), { recursive: true })
  writeFileSync(join(root, 'snapshots/s/cordis.yml'), 'x: 1\n')
  writeFileSync(join(root, 'apps/a/kept.yml'), 'y: 1\n')
  symlinkSync('../../snapshots/s/cordis.yml', join(root, 'apps/a/cordis.yml'))
  symlinkSync('cordis.yml', join(root, 'apps/a/chained.yml'))
  symlinkSync('kept.yml', join(root, 'apps/a/alias.yml'))
  const { published, excluded } = auditModule.excludeUnpublishedSymlinks(
    ['apps/a/alias.yml', 'apps/a/chained.yml', 'apps/a/cordis.yml', 'apps/a/kept.yml'], ['snapshots/s/cordis.yml'], root)
  assert.deepEqual(published, ['apps/a/alias.yml', 'apps/a/kept.yml'], 'a link to a published file stays')
  assert.deepEqual(excluded, ['apps/a/chained.yml', 'apps/a/cordis.yml', 'snapshots/s/cordis.yml'], 'a chain into the private tree is followed')
})

test('the public tree excludes private development state and includes the new refined-source code', () => {
  const { published, excluded } = (() => {
    const listing = spawnSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return filterPublicSources(listing.stdout.split('\n').filter(Boolean))
  })()
  for (const file of ['map/tools/src/refine-tools.ts', 'map/spatial-connect/src/footprints.ts', 'map/spatial-connect/src/footprints-contract.ts']) {
    assert.ok(published.includes(file), `new source ${file} must be public`)
  }
  for (const prefix of ['.spec/', '.agents/', '.env']) {
    assert.equal(published.some(file => file.startsWith(prefix) || file.includes(`/${prefix}`)), false, `${prefix} must be excluded`)
  }
  assert.ok(published.includes('map/docs/github-release.md') === false, 'maintainer release procedure is not published')
  assert.ok(excluded.length > 0)
})

test('a staged private content marker fails the audit', () => {
  // auditPublicTree owns the private-content marker set; inject a marker into a
  // staged public file and prove the audit reports it instead of publishing it.
  const snap = buildSnapshot(version)
  const staged = join(snap.stage, 'README.md')
  // Build the marker at runtime so this source file never contains a credential-shaped literal
  // (auditPublicTree would refuse its own test file as private content).
  const marker = `sk-${'a1b2c3d4'.repeat(4)}`
  writeFileSync(staged, `${readFileSync(staged, 'utf8')}\nBearer ${marker}\n`)
  const { auditPublicTree } = auditModule
  const violations = auditPublicTree(snap.stage, { published: snap.published, excluded: snap.excluded }).violations
  assert.ok(violations.some(line => /private content marker/u.test(line)), `expected a privacy violation, got ${JSON.stringify(violations.slice(0, 4))}`)
})

test('the public facade carries linked bilingual READMEs and the PolyForm Noncommercial licence', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const zh = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
  const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
  assert.match(readme, /README\.zh\.md/u, 'English README links the Chinese README')
  assert.match(zh, /README\.md/u, 'Chinese README links the English README')
  assert.match(licence, /PolyForm Noncommercial|noncommercial/iu)
})
