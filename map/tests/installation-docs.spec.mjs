/**
 * Installation-documentation gate: `map/docs/installation.md` is the single
 * authoritative installation reference, every synchronized page agrees with
 * it, the old `~/.dsh` default appears only in migration material, and the
 * documented commands exist in the shipping scripts. Validator functions are
 * exported and negative-tested so a drift cannot pass because a probe matched
 * nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(mapRoot, '..')

const AUTHORITATIVE = 'map/docs/installation.md'
// The guide lives under the root package version at the time of the break, per the upgrade-guide contract.
const GUIDE_DIR = `docs/upgrade-guide/v${JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version}/map-standalone-home`
const GUIDE = `${GUIDE_DIR}/guide.md`
const GUIDE_ZH = `${GUIDE_DIR}/guide.zh.md`
const GUIDE_PAIR = `${GUIDE_DIR}/guide.i18n.yaml`

const REQUIRED_FILES = [
  AUTHORITATIVE,
  'map/docs/directory-layout.md',
  'map/docs/engineering.md',
  'map/docs/release-install-guide.md',
  'map/docs/github-release.md',
  'map/docs/verification-matrix.md',
  'map/README.md',
  'map/README.zh.md',
  'map/README.i18n.yaml',
  'map/release/public/README.md',
  'map/release/public/README.zh.md',
  'map/release/public/README.i18n.yaml',
  'map/release/notes/v0.1.16.md',
  'map/UPSTREAM.md',
  GUIDE,
  GUIDE_ZH,
  GUIDE_PAIR,
]

/** Pages whose current-state text must never carry the retired default. */
const STALE_SCAN_FILES = [
  'map/README.md',
  'map/release/public/README.md',
  'map/release/public/README.zh.md',
  'map/docs/release-install-guide.md',
  'map/docs/github-release.md',
  'map/docs/engineering.md',
  'map/docs/directory-layout.md',
  'map/docs/verification-matrix.md',
  'map/release/notes/v0.1.16.md',
]

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8')
}

/**
 * Return every line-level occurrence of `~/.dsh` that sits outside a heading
 * allowed to describe the old default. The heading line itself is not content.
 * @param {string} text Markdown source.
 * @param {RegExp} [allowHeading] heading titles allowed to mention the old default.
 * @returns {{ line: number, heading: string, text: string }[]} violations
 */
export function staleHomeViolations(text, allowHeading) {
  const violations = []
  let heading = ''
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s/u.test(line)) {
      heading = line.replace(/^#{1,6}\s+/u, '')
      continue
    }
    if (line.includes('~/.dsh') && !(allowHeading !== undefined && allowHeading.test(heading))) {
      violations.push({ line: index + 1, heading, text: line.trim() })
    }
  }
  return violations
}

/**
 * Report required fact patterns missing from one document.
 * @param {string} text document body.
 * @param {RegExp[]} patterns required patterns.
 * @returns {string[]} pattern sources with no match
 */
export function missingFacts(text, patterns) {
  return patterns.filter(pattern => !pattern.test(text)).map(pattern => String(pattern))
}

/**
 * Compare the documented whitespace-normalized command surface against the
 * command lines declared by the shipping dispatcher.
 * @param {string} docText installation reference.
 * @param {string} manageSource `map/bin/manage.mjs` source.
 * @returns {string[]} dispatcher command lines absent from the document
 */
export function missingManageCommands(docText, manageSource) {
  const block = manageSource.slice(manageSource.indexOf('export const MANAGE_USAGE = ['))
  const lines = [...block.slice(0, block.indexOf('].join')).matchAll(/'  (install|status|doctor|update|rollback|uninstall)\s{2,}([^']+)'/gu)]
    .map(match => `map-harness manage ${match[1]} ${match[2]}`)
  const normalized = docText.replace(/\s+/gu, ' ')
  return lines.filter(command => !normalized.includes(command.replace(/\s+/gu, ' ')))
}

/**
 * Scan one Markdown pair for physical line-count equality, the pairing gate's
 * first structural invariant.
 * @param {string} english English path.
 * @param {string} chinese Chinese path.
 * @returns {[number, number]} both line counts
 */
export function pairLineCounts(english, chinese) {
  const count = path => read(path).split('\n').length
  return [count(english), count(chinese)]
}

const installation = read(AUTHORITATIVE)

test('authoritative installation documents exist and every pair is line-aligned', () => {
  const missing = REQUIRED_FILES.filter(path => !existsSync(join(repoRoot, path)))
  assert.deepEqual(missing, [], 'every authoritative installation document must exist')
  for (const [english, chinese] of [
    ['map/README.md', 'map/README.zh.md'],
    ['map/release/public/README.md', 'map/release/public/README.zh.md'],
    [GUIDE, GUIDE_ZH],
  ]) {
    const [enLines, zhLines] = pairLineCounts(english, chinese)
    assert.equal(enLines, zhLines, `${english} and ${chinese} must stay on the same physical line count`)
  }
  assert.match(read('map/release/version.json'), /"version":\s*"\d+\.\d+\.\d+"/u, 'product version file must carry a semantic version')
})

test('installation reference covers the isolation contract', () => {
  const required = [
    /~\/\.map-harness/u,
    /~\/\.map-harness-preview/u,
    /~\/\.map-harness-dev\/<checkout-key>/u,
    /MAPHARNESS_HOME/u,
    /MAP_HOME_CONFLICT/u,
    /MAP_INSTANCE_BUSY/u,
    /MAP_HOME_UNCLAIMED/u,
    /MAP_HOME_MARKER_INVALID/u,
    /MAP_INSTALL_STATE/u,
    /MAP_DATA_UNKNOWN/u,
    /MAP_IMPORT_SOURCE_CHANGED/u,
    /portable/u,
    /managed/u,
    /manage import/u,
    /--apply --plan/u,
    /install-map\.sh/u,
    /start-web\.sh/u,
    /start-web\.cmd/u,
    /~/u,
  ]
  assert.deepEqual(missingFacts(installation, required), [], 'installation.md must state every required isolation fact')
  const layout = read('map/docs/directory-layout.md')
  assert.ok(layout.includes('installation.md'), 'directory layout must link the authoritative installation reference')
  const engineering = read('map/docs/engineering.md')
  assert.ok(engineering.includes('installation.md'), 'engineering skeleton must link the authoritative installation reference')
})

test('the retired ~/.dsh default appears only in migration material', () => {
  const installationViolations = staleHomeViolations(installation, /迁移/u)
  assert.deepEqual(installationViolations, [], 'installation.md may mention ~/.dsh only under a migration heading')
  assert.ok(installation.includes('## 迁移：从共享 `~/.dsh` 升级'), 'installation.md must own a migration section for the retired default')
  for (const file of STALE_SCAN_FILES) {
    const violations = staleHomeViolations(read(file))
    assert.deepEqual(violations, [], `${file} must not state the retired ~/.dsh default`)
  }
  for (const path of [GUIDE, GUIDE_ZH]) {
    const guide = read(path)
    assert.ok(guide.includes('~/.dsh'), 'the upgrade guide must describe the old shared root')
    assert.ok(guide.includes('~/.map-harness'), 'the upgrade guide must state the new independent root')
    assert.ok(guide.includes('MAP_INSTANCE_BUSY'), 'the upgrade guide must name the second-writer failure')
    assert.ok(guide.includes('--apply --plan'), 'the upgrade guide must describe the explicit import apply step')
  }
})

test('documented management commands match the shipping dispatcher', () => {
  const manageSource = readFileSync(join(mapRoot, 'bin', 'manage.mjs'), 'utf8')
  assert.deepEqual(missingManageCommands(installation, manageSource), [], 'every dispatcher command must appear in installation.md')
  for (const command of ['update', 'rollback', 'uninstall']) {
    assert.match(manageSource, new RegExp(`if \\(command === '${command}'\\)`, 'u'), `manage.mjs must dispatch ${command}`)
    assert.ok(installation.includes(`map-harness manage ${command}`), `installation.md must document manage ${command}`)
  }
  const checksums = manageSource + readFileSync(join(mapRoot, 'bin', 'install-transaction.mjs'), 'utf8')
  for (const token of ['map-harness-update-checksums-1', 'archiveSha256', 'packageName', 'maxBytes']) {
    assert.ok(checksums.includes(token), `the update checksums contract must carry ${token}`)
    assert.ok(installation.includes(token), `installation.md must document the checksums field ${token}`)
  }

  const importSource = readFileSync(join(mapRoot, 'bin', 'instance-import.mjs'), 'utf8')
  for (const flag of ['--from', '--to', '--session', '--snapshot', '--max-bytes', '--apply', '--plan']) {
    assert.ok(importSource.includes(flag), `instance-import.mjs must accept ${flag}`)
    assert.ok(installation.includes(flag), `installation.md must document the import flag ${flag}`)
  }

  const posixInstaller = readFileSync(join(mapRoot, 'release', 'install-map.sh'), 'utf8')
  for (const flag of ['--expected', '--manager-sha256']) {
    assert.ok(posixInstaller.includes(flag), `install-map.sh must require ${flag}`)
    assert.ok(installation.includes(flag), `installation.md must document the installer flag ${flag}`)
  }
  for (const launcher of ['map-harness', 'map-harness.cmd', 'map-harness.ps1']) {
    assert.ok(readFileSync(join(mapRoot, 'bin', 'install-layout.mjs'), 'utf8').includes(`'${launcher}'`)
      || readFileSync(join(mapRoot, 'bin', 'install-layout.mjs'), 'utf8').includes(`"${launcher}"`), `install layout must generate ${launcher}`)
  }
  const layout = readFileSync(join(mapRoot, 'bin', 'install-layout.mjs'), 'utf8')
  assert.ok(layout.includes("join(home, 'Applications', name)"), 'macOS managed root must stay ~/Applications/<name>')
  assert.ok(installation.includes('~/Applications/Map Harness'), 'installation.md must state the macOS managed root')
  assert.ok(installation.includes('%LOCALAPPDATA%\\Programs\\Map Harness'), 'installation.md must state the Windows managed root')
  assert.ok(installation.includes('~/.local/opt/map-harness'), 'installation.md must state the Linux managed root')

  const contract = JSON.parse(read('map/release/web-service.json'))
  assert.deepEqual(contract.dataHome.environment, ['MAPHARNESS_HOME'], 'release contract must expose exactly the MAPHARNESS_HOME override')
  assert.equal(contract.dataHome.default, '~/.map-harness', 'release contract default must be the independent Map data root')
})

test('release public documents stay consistent with the installation authority', () => {
  const publicReadme = read('map/release/public/README.md')
  const publicReadmeZh = read('map/release/public/README.zh.md')
  const releaseGuide = read('map/docs/release-install-guide.md')
  for (const [label, text] of [['public README', publicReadme], ['public README zh', publicReadmeZh], ['release install guide', releaseGuide]]) {
    assert.ok(text.includes('~/.map-harness'), `${label} must state the default Map data root`)
  }
  for (const token of ['SHASUMS256.txt', 'start-web.cmd', 'start-web.sh']) {
    assert.ok(publicReadme.includes(token), `public README must keep the release install token ${token}`)
  }
  assert.ok(publicReadmeZh.includes('SHASUMS256.txt') && publicReadmeZh.includes('start-web.cmd'), 'public README zh must keep the release install tokens')
  assert.ok(publicReadme.includes('No Node.js'), 'public README must keep the no-runtime requirement')
  const notes = read('map/release/notes/v0.1.16.md')
  assert.ok(notes.startsWith("## What's new"), 'release note must follow the existing release-note shape')
  assert.ok(notes.includes('~/.map-harness') && notes.includes('managed'), 'release note must announce the independent root and managed install')
})

test('upgrade guide satisfies the upgrade-guide contract', () => {
  const guide = read(GUIDE)
  assert.match(guide, /^---\nkind: upgrade-guide\ndescription: ".*"\n---/u, 'guide frontmatter must carry exactly kind and description')
  assert.match(guide, /^# .+$/mu, 'guide needs one H1 title')
  assert.match(guide, /^## Change$/mu, 'guide needs the Change section')
  assert.match(guide, /^## Migration$/mu, 'guide needs the Migration section')
  const guideZh = read(GUIDE_ZH)
  assert.match(guideZh, /^## 变更$/mu, 'Chinese guide needs the 变更 section')
  assert.match(guideZh, /^## 迁移$/mu, 'Chinese guide needs the 迁移 section')
  assert.ok(guide.split(/\s+/u).filter(Boolean).length <= 500, 'guide.md must stay within 500 words')
})

test('negative controls reject stale defaults, missing facts, and drifted commands', () => {
  assert.equal(staleHomeViolations('## Install\n\nUse `~/.dsh` for state.').length, 1, 'a stale default outside migration must be rejected')
  assert.deepEqual(staleHomeViolations('## 迁移\n\n旧 `~/.dsh` 保持原样。', /迁移/u), [], 'a migration mention must be allowed')
  assert.deepEqual(missingFacts('only MAPHARNESS_HOME', [/MAPHARNESS_HOME/u, /~\/\.map-harness/u]), ['/~\\/\\.map-harness/u'], 'a missing fact must be reported')
  assert.deepEqual(missingFacts('MAPHARNESS_HOME and ~/.map-harness', [/MAPHARNESS_HOME/u, /~\/\.map-harness/u]), [], 'complete facts must pass')
  const manageSource = "export const MANAGE_USAGE = [\n  '  status    --install-root <dir> [--json]',\n].join('\\n')"
  assert.deepEqual(missingManageCommands('map-harness manage status --install-root <dir> [--json]', manageSource), [], 'a matching command must pass')
  assert.deepEqual(missingManageCommands('map-harness manage status', manageSource), ['map-harness manage status --install-root <dir> [--json]'], 'a drifted command must be reported')
  assert.deepEqual(missingFacts('', [/anything/u]), ['/anything/u'], 'an empty document must report every fact')
})
