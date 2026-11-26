/**
 * Publisher release gates: the exact-OID lease that replaces bare `--force`
 * on the public main, the default-deny source allowlist behind public
 * staging, and end-to-end publisher runs against fixture repositories with
 * recording `git`/`gh` stand-ins. The remote-mutation scenarios (unborn and
 * moved remotes, existing releases, failed release writes) run the actual
 * `map/bin/publish-release.mjs` against local bare GitHub and Gitea
 * stand-ins; the Gitea stand-in receives only the provenance tag.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPublicSources, publicReleaseInputs } from './pack-runtime.mjs'
import { collectWebServiceRelease } from './collect-web-service-release.mjs'
import { assertCommunityEnvironment, forceWithLease, PUBLIC_BUILD_RECORD, recordPublicBuild as sealPublicBuild, updateNotesOf } from './public-release-privacy.mjs'
import { PUBLIC_FACADE } from './release-content.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_ENV = { DSH_CLIENT_MAP_ORG_NAME: '', DSH_CLIENT_TITLE: 'Map Harness · 社区版' }
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

test('forceWithLease carries the exact remote OID or requires an unborn branch', () => {
  assert.equal(forceWithLease(''), '--force-with-lease=refs/heads/main:')
  const oid = 'd87b6c3acb9189a2c0c6c9ba8ef6679d4425541d'
  assert.equal(forceWithLease(oid), `--force-with-lease=refs/heads/main:${oid}`)
  for (const malformed of [oid.slice(0, 12), oid.toUpperCase(), 'not-an-oid', 'main']) {
    assert.throws(() => forceWithLease(malformed), /full remote OID/u, malformed)
  }
})

test('filterPublicSources keeps nested public paths and rejects unlisted root entries', () => {
  const tracked = [
    'README.md', 'apps/desktop/.env.macos.example', 'docs/user/guide/index.md', 'packages/app/user/guide.md',
    'packages/app/workflows/build.yml', 'map/tools/lib/index.js',
    '.spec/specs/demo/spec.md', 'packages/app/.spec/state.json', '.agents/notes/a.md',
    'packages/deep/.github/workflows/ci.yml', '.env', 'packages/app/.env.production',
    'user/sessions/1.jsonl', 'logs/run.log', 'map/docs/github-release.md',
  ]
  const classified = filterPublicSources(tracked)
  assert.deepEqual(
    { published: classified.published.slice().sort(), excluded: classified.excluded.slice().sort() },
    {
      published: [
        'README.md', 'docs/user/guide/index.md', 'packages/app/user/guide.md',
        'packages/app/workflows/build.yml', 'map/tools/lib/index.js',
      ].sort(),
      excluded: [
        '.agents/notes/a.md', '.env', 'apps/desktop/.env.macos.example', '.spec/specs/demo/spec.md', 'logs/run.log',
        'map/docs/github-release.md', 'packages/app/.env.production', 'packages/app/.spec/state.json',
        'packages/deep/.github/workflows/ci.yml', 'user/sessions/1.jsonl',
      ].sort(),
    },
  )
  for (const unknown of ['SURPRISE.md', 'internal-notes.txt', 'new-area/tool.js']) {
    assert.throws(() => filterPublicSources([...tracked, unknown]), new RegExp(`allowlist does not name ${unknown.replace(/[.]/gu, '\\$&')}`), unknown)
  }
})

test('git rejects the lease once the remote main moves past the read', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'map-lease-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const gitArgs = (args, options = {}) => spawnSync('git', args, { encoding: 'utf8', ...options })
  const remote = join(parent, 'github.git')
  assert.equal(gitArgs(['init', '--bare', '-b', 'main', remote]).status, 0)
  const seed = join(parent, 'seed')
  mkdirSync(seed)
  assert.equal(gitArgs(['-C', seed, 'init', '-b', 'main']).status, 0)
  writeFileSync(join(seed, 'a.txt'), 'seed\n')
  assert.equal(gitArgs(['-C', seed, 'add', 'a.txt']).status, 0)
  assert.equal(gitArgs(['-C', seed, '-c', 'user.email=t@invalid', '-c', 'user.name=t', 'commit', '-qm', 'seed']).status, 0)
  assert.equal(gitArgs(['-C', seed, 'push', '-q', remote, 'main:main']).status, 0)
  const readOid = gitArgs(['ls-remote', remote, 'refs/heads/main']).stdout.split('\t')[0]
  assert.match(readOid, /^[0-9a-f]{40}$/u)

  const stage = join(parent, 'stage')
  mkdirSync(stage)
  assert.equal(gitArgs(['-C', stage, 'init', '-b', 'main']).status, 0)
  writeFileSync(join(stage, 'release.txt'), 'release\n')
  assert.equal(gitArgs(['-C', stage, 'add', 'release.txt']).status, 0)
  assert.equal(gitArgs(['-C', stage, '-c', 'user.email=r@invalid', '-c', 'user.name=r', 'commit', '-qm', 'release']).status, 0)
  // The lease matching the read OID rewrites the remote history.
  const leased = gitArgs(['-C', stage, 'push', forceWithLease(readOid), remote, 'main:main'])
  assert.equal(leased.status, 0, leased.stderr)

  // A concurrent writer advances the remote; the same lease is now rejected.
  writeFileSync(join(seed, 'a.txt'), 'moved\n')
  assert.equal(gitArgs(['-C', seed, 'add', 'a.txt']).status, 0)
  assert.equal(gitArgs(['-C', seed, '-c', 'user.email=t@invalid', '-c', 'user.name=t', 'commit', '-qm', 'moved']).status, 0)
  const movedOid = gitArgs(['ls-remote', remote, 'refs/heads/main']).stdout.split('\t')[0]
  assert.equal(gitArgs(['-C', seed, 'push', forceWithLease(movedOid), remote, 'main:main']).status, 0)
  const stale = gitArgs(['-C', stage, 'push', forceWithLease(readOid), remote, 'main:main'])
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /stale|rejected/iu)
})

test('updateNotesOf skips absent files and enforces the structural floor', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-notes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(updateNotesOf(root, '0.1.12'), undefined)
  const write = text => {
    mkdirSync(join(root, 'map/release/notes'), { recursive: true })
    writeFileSync(join(root, 'map/release/notes/v0.1.12.md'), text)
  }
  write("## What's new\n\n**Fixed**\n- **Rename keeps styling**: one line\n")
  assert.equal(updateNotesOf(root, '0.1.12'), "## What's new\n\n**Fixed**\n- **Rename keeps styling**: one line")
  for (const [label, text] of [
    ['missing heading', "**Fixed**\n- **A**: b\n"],
    ['zero bullets', "## What's new\n\n**Fixed**\nnothing user-visible\n"],
    ['eight bullets', `## What's new\n\n${Array.from({ length: 8 }, (_, at) => `- **Cap ${at}**: effect`).join('\n')}\n`],
    ['overlong bullet', `## What's new\n\n- **Cap**: ${'x'.repeat(220)}`],
    ['placeholder', "## What's new\n\n- **Cap**: fixes {{version}} handling\n"],
    ['internal slug', "## What's new\n\n- **Cap**: shipped 2026-10-26_add-release-update-notes\n"],
  ]) {
    write(text)
    assert.throws(() => updateNotesOf(root, '0.1.12'), /release\/notes\/v0\.1\.12\.md/u, label)
  }
})

/** Private content the publisher must never stage. */
const PRIVATE_FIXTURES = [
  '.env',
  '.agents/notes/design.md',
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.spec/specs/demo/spec.md',
  'logs/run.log',
  'map/docs/github-release.md',
  'packages/app/.env.production',
  'packages/app/.spec/state.json',
  'packages/app/.cursor/rules.md',
  'user/sessions/1.jsonl',
  'map/tests/fixtures/session.v4.jsonl',
  'scripts/snapshots/python-sdk-single-exe/restart/requests.json',
]

/** Allowlisted sources, including the build outputs the runtime pack needs. */
const PUBLIC_FIXTURES = [
  '.editorconfig',
  'apps/desktop/.env.macos.example',
  '.github/ISSUE_TEMPLATE/bug.md',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'THIRD_PARTY_NOTICES.md',
  'apps/cli/lib/bin.js',
  'apps/web/dist/index.html',
  'docs/user/guide/index.md',
  'map/client-ui-brand/lib/client.js',
  'map/client-ui-brand/package.json',
  'map/docs/design.md',
  'map/map-container/lib/client.js',
  'map/tools/lib/index.js',
  'native/system/packages/entry/lib/index.js',
  'package.json',
  'packages/app/user/guide.md',
  'packages/app/workflows/build.yml',
  'patches/dep.patch',
  'scripts/tool.ts',
]

const LAUNCHER_NAMES = ['install.cmd', 'install.sh', 'start.cmd', 'start.sh']

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_GH_LOG"
if [ "$1 $2" = "release upload" ]; then
  for asset in "$@"; do case "$asset" in */LICENSE) cp "$asset" "$FAKE_ASSET_LICENSE" || exit 97 ;; esac; done
fi
case "$1 $2" in
  'release view')
    if [ "\${FAKE_GH_MODE:-}" = "exists" ]; then exit 0; fi
    echo "release not found: HTTP 404" >&2
    exit 1
    ;;
esac
case "\${FAKE_GH_MODE:-}" in
  create-fails) if [ "$1 $2" = "release create" ]; then echo "gh: create failed" >&2; exit 1; fi ;;
  upload-fails) if [ "$1 $2" = "release upload" ]; then echo "gh: upload failed" >&2; exit 1; fi ;;
esac
exit 0
`

// Wraps git for the publisher subprocess: logs every invocation and, when a
// race clone is configured, advances the remote right after the publisher's
// ls-remote read returns — the exact window the lease must close.
const FAKE_GIT = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_GIT_LOG"
if [ "$1" = "ls-remote" ] && [ -n "\${FAKE_GIT_RACE_CLONE:-}" ]; then
  "\${FAKE_GIT_REAL}" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    "\${FAKE_GIT_REAL}" -C "\${FAKE_GIT_RACE_CLONE}" -c user.email=race@invalid -c user.name=race commit --allow-empty -qm "concurrent writer"
    "\${FAKE_GIT_REAL}" -C "\${FAKE_GIT_RACE_CLONE}" push -q origin main
  fi
  exit "$status"
fi
if [ "$1 $2" = "fetch origin" ]; then exit 0; fi
exec "\${FAKE_GIT_REAL}" "$@"
`

/**
 * Build a committed fixture repository with the real publisher scripts, a
 * local bare GitHub stand-in, recording git/gh stand-ins, and a sealed
 * community build record covering exactly the fixture's public inputs.
 * @param {import('node:test').TestContext} t - test context owning the temp dir.
 * @param {object} options - extra committed files and files committed only
 *   after the record is sealed (the publisher must reject those itself).
 * @returns the fixture paths, stand-in logs, and the published file list.
 */
function publisherFixture(t, { extra = [], unclassified = [], notes } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'map-publisher-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'src')
  const github = join(parent, 'github.git')
  const gitea = join(parent, 'gitea.git')
  const bin = join(parent, 'bin')
  const scratch = join(parent, 'tmp')
  const ghLog = join(parent, 'gh.log')
  const gitLog = join(parent, 'git.log')
  mkdirSync(join(root, 'map/bin'), { recursive: true })
  mkdirSync(join(root, 'map/docs'), { recursive: true })
  for (const name of ['publish-release.mjs', 'web-service-release.mjs', 'web-service-qualification-platform.mjs', 'web-service-contract.mjs', 'application-assets.mjs', 'pack-web-service.mjs', 'install-manifest.mjs', 'instance-home.mjs', 'pack-runtime.mjs', 'public-release-privacy.mjs', 'release-content.mjs']) {
    copyFileSync(join(repo, 'map/bin', name), join(root, 'map/bin', name))
  }
  copyFileSync(join(repo, 'map/docs/release-install-guide.md'), join(root, 'map/docs/release-install-guide.md'))
  mkdirSync(join(root, 'scripts/primary-runtime'), { recursive: true })
  copyFileSync(join(repo, 'scripts/primary-runtime/lock.json'), join(root, 'scripts/primary-runtime/lock.json'))
  mkdirSync(join(root, 'map/release'), { recursive: true })
  writeFileSync(join(root, 'map/release/version.json'), '{"version":"0.1.12"}\n')
  copyFileSync(join(repo, 'map/release/web-service.json'), join(root, 'map/release/web-service.json'))
  writeFileSync(join(root, 'map/release/source-offers.md'), 'WRITTEN SOURCE OFFER: fixture\n')
  writeFileSync(join(root, 'map/release/start-web.sh'), '#!/bin/sh\nexit 87\n', { mode: 0o755 })
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\nnode_modules\n')
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  if (notes !== undefined) {
    mkdirSync(join(root, 'map/release/notes'), { recursive: true })
    writeFileSync(join(root, 'map/release/notes/v0.1.12.md'), notes)
  }
  for (const launcher of LAUNCHER_NAMES) {
    writeFileSync(join(root, 'map/release', launcher), 'launcher fixture\n')
  }
  const content = '// Community fixture\n'
  for (const file of [...PUBLIC_FIXTURES, ...PRIVATE_FIXTURES, ...extra]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), file.endsWith('package.json') ? '{"name":"@map-harness/fixture"}\n' : content)
  }
  for (const file of ['README.md', 'README.zh.md']) {
    mkdirSync(join(root, 'map/release/public'), { recursive: true })
    writeFileSync(join(root, 'map/release/public', file), `Release-only ${file}\n`)
  }
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'MIT notices\n')
  const run = (args, options = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options })
  assert.equal(run(['init', '-b', 'main']).status, 0)
  assert.equal(run(['config', 'user.email', 'fixture@invalid']).status, 0)
  assert.equal(run(['config', 'user.name', 'fixture']).status, 0)
  assert.equal(spawnSync('git', ['init', '--bare', '-b', 'main', gitea]).status, 0)
  assert.equal(run(['remote', 'add', 'origin', gitea]).status, 0)
  assert.equal(run(['add', '-A']).status, 0)
  assert.equal(run(['-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']).status, 0)
  assert.equal(run(['update-ref', 'refs/remotes/origin/main', 'HEAD']).status, 0)
  assert.equal(spawnSync('git', ['init', '--bare', '-b', 'main', github]).status, 0)
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 })
  mkdirSync(scratch)
  const listed = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  const { published } = filterPublicSources(listed)
  assertCommunityEnvironment(PUBLIC_ENV)
  const inputs = publicReleaseInputs(root, published)
  sealPublicBuild(root, inputs, PUBLIC_ENV, published)
  const singleWebService = join(root, '.dsh-build/map-web-service')
  const webService = join(root, '.dsh-build/map-web-service-release')
  const packageStage = join(root, '.dsh-build/web-service-stage')
  const packageRootName = 'map-harness-v0.1.12-web-mac-arm64'
  const packageRoot = join(packageStage, packageRootName)
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(singleWebService, { recursive: true })
  const executable = 'map-harness-v0.1.12-mac-arm64', bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(0x0100000c, 4)
  const digest = value => createHash('sha256').update(value).digest('hex')
  const lock = JSON.parse(readFileSync(join(root, 'scripts/primary-runtime/lock.json')))
  const helperNames = ['rg', 'spawn-helper']
  const notices = `${executable}.licenses.txt`, noticesBytes = Buffer.from('MIT license notice\n')
  const resources = Object.fromEntries(helperNames.map(role => {
    const file = `${executable}-${role}`, bytes = Buffer.from(`fixture ${role}\n`)
    return [role, { file, sha256: digest(bytes) }]
  }))
  const application = { format: 'map-harness-native-1', version: '0.1.12', target: 'mac-arm64', executable,
    engine: { node: `v${lock.nodeVersion}`, v8: 'fixture-v8', arch: 'arm64', platform: 'darwin' }, coreModules: 1, sourceCoreFiles: 0,
    sourceDigest: JSON.parse(readFileSync(join(root, PUBLIC_BUILD_RECORD))).sources.sha256,
    sha256: digest(bytes), notices, noticesSha256: digest(noticesBytes), resources,
    webService: { format: 1, mode: 'web', profile: 'map-web' }, smokes: { config: true, worker: true, system: true } }
  const packageFiles = [
    { path: 'LICENSE', bytes: readFileSync(join(root, 'LICENSE')), role: 'license', target: null, mode: 0o644 },
    { path: 'THIRD_PARTY_NOTICES.md', bytes: readFileSync(join(root, 'THIRD_PARTY_NOTICES.md')), role: 'third-party-notices', target: null, mode: 0o644 },
    { path: 'THIRD_PARTY_SOURCE_OFFERS.md', bytes: readFileSync(join(root, 'map/release/source-offers.md')), role: 'source-offer', target: null, mode: 0o644 },
    { path: 'README.md', bytes: readFileSync(join(root, 'map/release/public/README.md')), role: 'readme', target: null, mode: 0o644 },
    { path: 'README.zh.md', bytes: readFileSync(join(root, 'map/release/public/README.zh.md')), role: 'readme', target: null, mode: 0o644 },
    { path: 'start-web.sh', bytes: readFileSync(join(root, 'map/release/start-web.sh')), role: 'launcher', target: null, mode: 0o755 },
    { path: `mac-arm64/${executable}`, bytes, role: 'service', target: 'mac-arm64', mode: 0o755 },
    { path: `mac-arm64/${notices}`, bytes: noticesBytes, role: 'third-party-licenses', target: 'mac-arm64', mode: 0o644 },
    ...helperNames.map(role => ({ path: `mac-arm64/${resources[role].file}`, bytes: Buffer.from(`fixture ${role}\n`),
      role: `helper:${role}`, target: 'mac-arm64', mode: 0o755 })),
    { path: `mac-arm64/${executable}.json`, bytes: Buffer.from(JSON.stringify(application, null, 2) + '\n'), role: 'build-record', target: 'mac-arm64', mode: 0o644 },
  ]
  const manifest = {
    format: 1, product: 'map-harness', version: '0.1.12',
    targets: [{ target: 'mac-arm64', record: `mac-arm64/${executable}.json` }],
    supportedTargets: ['mac-arm64'], unsupportedTargets: Object.keys(lock.targets).filter(target => target !== 'mac-arm64').sort(),
    files: packageFiles.map(item => ({ path: item.path, role: item.role, target: item.target,
      executable: (item.mode & 0o111) !== 0, sha256: digest(item.bytes) })),
  }
  for (const item of packageFiles) {
    mkdirSync(dirname(join(packageRoot, item.path)), { recursive: true })
    writeFileSync(join(packageRoot, item.path), item.bytes, { mode: item.mode })
  }
  writeFileSync(join(packageRoot, 'web-service-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const archive = join(singleWebService, `${packageRootName}.tar.gz`)
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', packageStage, packageRootName]).status, 0)
  writeFileSync(join(singleWebService, 'web-service-manifest.json'), readFileSync(join(packageRoot, 'web-service-manifest.json')))
  const qualification = { format: 'map-harness-web-qualification-1', product: 'map-harness', version: '0.1.12',
    target: 'mac-arm64', archive: basename(archive), archiveSha256: digest(readFileSync(archive)),
    manifestSha256: digest(readFileSync(join(singleWebService, 'web-service-manifest.json'))),
    buildRecordSha256: digest(packageFiles.find(item => item.role === 'build-record').bytes),
    sourceDigest: application.sourceDigest,
    runtime: { platform: 'darwin', arch: 'arm64', node: `v${lock.nodeVersion}`, v8: 'fixture-v8', cwdOutsideCheckout: true }, checks: {
      browserScenario: { passed: true }, restartDataPreservation: { passed: true },
      cleanExit: { passed: true }, noResidualProcesses: { passed: true },
    } }
  writeFileSync(join(singleWebService, 'web-service-qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
  collectWebServiceRelease({ root, inputs: [singleWebService], out: webService })
  for (const file of unclassified) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  if (unclassified.length > 0) {
    assert.equal(run(['add', '-A']).status, 0)
    assert.equal(run(['-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'unclassified']).status, 0)
  }
  return { parent, root, github, gitea, bin, scratch, ghLog, gitLog, published, webService, application, packageFiles }
}

/** Publisher-owned temporary directories left behind in the fixture's TMPDIR. */
function releaseTemporaries(fixture) {
  return readdirSync(fixture.scratch).filter(name => name.startsWith('map-release-'))
}

/**
 * Run the fixture's publisher copy with the recording stand-ins on PATH.
 * @param {object} fixture - a publisherFixture result.
 * @param {object} options - gh mode, race clone, and extra arguments.
 * @returns the subprocess result.
 */
function runPublisher(fixture, { mode = 'ok', raceClone, extraArgs = [] } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
  const env = {
    ...inherited,
    PATH: `${fixture.bin}:${inherited.PATH}`,
    TMPDIR: fixture.scratch,
    FAKE_GH_LOG: fixture.ghLog,
    FAKE_ASSET_LICENSE: join(fixture.parent, 'asset-license.txt'),
    FAKE_GIT_LOG: fixture.gitLog,
    FAKE_GH_MODE: mode,
    FAKE_GIT_REAL: REAL_GIT,
  }
  if (raceClone !== undefined) env.FAKE_GIT_RACE_CLONE = raceClone
  return spawnSync(process.execPath, [
    join(fixture.root, 'map/bin/publish-release.mjs'),
    '--version', 'v0.1.12', '--github', fixture.github, ...extraArgs,
  ], { cwd: fixture.root, encoding: 'utf8', env })
}

const ghCommands = log => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
const githubTree = fixture => spawnSync('git', ['--git-dir', fixture.github, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
const githubMainOid = fixture => spawnSync('git', ['ls-remote', fixture.github, 'refs/heads/main'], { encoding: 'utf8' }).stdout.split('\t')[0]
const giteaTagCommit = fixture => spawnSync('git', ['--git-dir', fixture.gitea, 'rev-parse', '-q', '--verify', 'refs/tags/v0.1.12^{commit}'], { encoding: 'utf8' }).stdout.trim()

function refreshMatrixChecksums(directory) {
  const path = join(directory, 'web-service-release.json')
  const matrix = JSON.parse(readFileSync(path, 'utf8'))
  const digest = file => createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')
  for (const row of matrix.targets) {
    for (const [name, hash] of [['archive', 'archiveSha256'], ['manifest', 'manifestSha256'], ['qualification', 'qualificationSha256']]) {
      row[hash] = digest(row[name])
    }
  }
  writeFileSync(path, JSON.stringify(matrix, null, 2) + '\n')
  const files = ['web-service-release.json', ...matrix.targets.flatMap(row => [row.archive, row.manifest, row.qualification])].sort()
  writeFileSync(join(directory, 'SHASUMS256.txt'), files.map(file => `${digest(file)}  ${file}\n`).join(''))
}

test('a clean publish rewrites the unborn public main under a lease and stages the allowlisted full source tree', (t) => {
  const fixture = publisherFixture(t)
  writeFileSync(join(fixture.webService, 'map-harness-v0.1.11-web-mac-arm64.tar.gz'), 'old version archive is irrelevant\n')
  const result = runPublisher(fixture)
  assert.deepEqual(releaseTemporaries(fixture), [], 'every exit path removes the staged tree and archives')
  assert.equal(result.status, 0, result.stderr)
  const sourceHead = spawnSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(giteaTagCommit(fixture), sourceHead, 'the Gitea tag cites the released source commit')
  assert.equal(spawnSync('git', ['--git-dir', fixture.gitea, 'cat-file', '-t', 'refs/tags/v0.1.12'], { encoding: 'utf8' }).stdout.trim(), 'tag')
  assert.deepEqual(spawnSync('git', ['--git-dir', fixture.gitea, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean), ['refs/tags/v0.1.12'], 'Gitea receives no branch or release state')
  assert.match(result.stdout, /staged \d+ files of the allowlisted full source tree/u)
  const commands = ghCommands(fixture.ghLog)
  assert.equal(commands.filter(command => command.startsWith('release view')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release create')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release upload')).length, 1)
  assert.match(commands.find(command => command.startsWith('release upload')), /map-harness-v0\.1\.12-web-mac-arm64\.tar\.gz/u)
  assert.match(commands.find(command => command.startsWith('release upload')), /web-mac-arm64\.manifest\.json/u)
  assert.match(commands.find(command => command.startsWith('release upload')), /web-mac-arm64\.qualification\.json/u)
  assert.match(commands.find(command => command.startsWith('release upload')), /web-service-release\.json/u)
  assert.match(commands.find(command => command.startsWith('release upload')), /SHASUMS256\.txt/u)
  assert.doesNotMatch(commands.find(command => command.startsWith('release upload')), /-runtime\.(?:zip|tar)/u)
  const pushes = readFileSync(fixture.gitLog, 'utf8').split('\n').filter(line => line.includes(' push ') || line.startsWith('push '))
  assert.equal(pushes.filter(line => line.includes('--force-with-lease=refs/heads/main:')).length, 1, pushes.join('\n'))
  assert.equal(pushes.some(line => /\spush\s--force(?:\s|$)/u.test(line)), false, pushes.join('\n'))
  const tree = githubTree(fixture)
  assert.deepEqual(tree.sort(), [...fixture.published].sort())
  for (const file of PUBLIC_FACADE) assert.ok(tree.includes(file), `public source tree must carry ${file}`)
  assert.equal(spawnSync('git', ['--git-dir', fixture.github, 'tag', 'v0.1.12', 'main']).status, 0)
  const snapshot = spawnSync('git', ['--git-dir', fixture.github, 'archive', '--format=tar', 'v0.1.12'])
  assert.equal(snapshot.status, 0)
  const archive = spawnSync('tar', ['-tf', '-'], { input: snapshot.stdout, encoding: 'utf8' })
  assert.equal(archive.status, 0)
  assert.deepEqual(archive.stdout.trim().split('\n').filter(line => line.length > 0 && !line.endsWith('/')).sort(), [...fixture.published].sort())
  for (const excluded of [...PRIVATE_FIXTURES, '.dsh-build/map-public-release.json']) {
    assert.equal(tree.some(file => file === excluded || file.startsWith(`${excluded}/`)), false, excluded)
  }
})

test('the uploaded license comes from the validated snapshot when the worktree changes after staging', t => {
  const fixture = publisherFixture(t)
  const expected = readFileSync(join(fixture.root, 'LICENSE'), 'utf8')
  const privateText = 'Fictional private license content written after public staging\n'
  writeFileSync(join(fixture.bin, 'cp'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [source, target] = process.argv.slice(-2);
fs.copyFileSync(source, target);
if (path.basename(source) === 'LICENSE') fs.writeFileSync(source, ${JSON.stringify(privateText)});
`, { mode: 0o755 })
  const result = runPublisher(fixture)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(fixture.root, 'LICENSE'), 'utf8'), privateText, 'the mutation happened after its public copy was taken')
  assert.equal(readFileSync(join(fixture.parent, 'asset-license.txt'), 'utf8'), expected)
})

for (const problem of ['missing-manifest', 'missing-qualification', 'stale', 'changed-archive', 'target-mismatch']) {
  test(`script Web service ${problem} evidence stops the actual publisher before remote commands`, t => {
    const fixture = publisherFixture(t)
    const matrix = JSON.parse(readFileSync(join(fixture.webService, 'web-service-release.json'), 'utf8'))
    const row = matrix.targets[0]
    const qualificationPath = join(fixture.webService, row.qualification)
    const qualification = JSON.parse(readFileSync(qualificationPath, 'utf8'))
    if (problem === 'missing-manifest') rmSync(join(fixture.webService, row.manifest))
    if (problem === 'missing-qualification') rmSync(qualificationPath)
    if (problem === 'stale') {
      qualification.sourceDigest = '0'.repeat(64)
      writeFileSync(qualificationPath, JSON.stringify(qualification, null, 2) + '\n')
    }
    if (problem === 'changed-archive') writeFileSync(join(fixture.webService, qualification.archive), 'changed bytes')
    if (problem === 'target-mismatch') {
      qualification.target = 'win-x64'
      writeFileSync(qualificationPath, JSON.stringify(qualification, null, 2) + '\n')
    }
    if (problem === 'stale' || problem === 'target-mismatch') refreshMatrixChecksums(fixture.webService)
    const result = runPublisher(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Script Web (?:service|release)/u)
    if (problem === 'stale') assert.match(result.stderr, /stale/u)
    assert.deepEqual(ghCommands(fixture.ghLog), [])
    assert.equal(githubMainOid(fixture), '')
  })
}

for (const problem of ['manifest-changed', 'qualification-check-failed']) {
  test(`script Web service ${problem} stops publication before remote commands`, t => {
    const fixture = publisherFixture(t)
    if (problem === 'manifest-changed') {
      const row = JSON.parse(readFileSync(join(fixture.webService, 'web-service-release.json'), 'utf8')).targets[0]
      const path = join(fixture.webService, row.manifest)
      writeFileSync(path, readFileSync(path).toString() + '\n')
    } else {
      const row = JSON.parse(readFileSync(join(fixture.webService, 'web-service-release.json'), 'utf8')).targets[0]
      const path = join(fixture.webService, row.qualification)
      const qualification = JSON.parse(readFileSync(path, 'utf8'))
      qualification.checks.cleanExit.passed = false
      writeFileSync(path, JSON.stringify(qualification, null, 2) + '\n')
    }
    refreshMatrixChecksums(fixture.webService)
    const result = runPublisher(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Script Web (?:service|release)/u)
    assert.deepEqual(ghCommands(fixture.ghLog), [])
    assert.equal(githubMainOid(fixture), '')
  })
}

test('a tracked file outside the allowlist fails the publish before any remote command', (t) => {
  const fixture = publisherFixture(t, { unclassified: ['SURPRISE.md'] })
  const result = runPublisher(fixture)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /allowlist does not name SURPRISE\.md/u)
  assert.deepEqual(ghCommands(fixture.ghLog), [])
  assert.equal(githubMainOid(fixture), '')
})

test('an existing GitHub release for the version refuses before any mutation', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture, { mode: 'exists' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /already exists; this publisher never rewrites/u)
  assert.deepEqual(ghCommands(fixture.ghLog).filter(command => !command.startsWith('release view')), [])
  assert.equal(githubMainOid(fixture), '')
})

test('a remote main that moved after the OID read is rejected by the lease', (t) => {
  const fixture = publisherFixture(t)
  // Seed the public main, then let the recording git stand-in advance it from
  // a clone right after the publisher's ls-remote read returns.
  const seed = join(fixture.parent, 'seed')
  mkdirSync(seed)
  const run = (args, options = {}) => spawnSync('git', args, { encoding: 'utf8', ...options })
  assert.equal(run(['-C', seed, 'init', '-b', 'main']).status, 0)
  writeFileSync(join(seed, 'a.txt'), 'seed\n')
  assert.equal(run(['-C', seed, 'add', 'a.txt']).status, 0)
  assert.equal(run(['-C', seed, '-c', 'user.email=s@invalid', '-c', 'user.name=s', 'commit', '-qm', 'seed']).status, 0)
  assert.equal(run(['-C', seed, 'push', '-q', fixture.github, 'main:main']).status, 0)
  const race = join(fixture.parent, 'race')
  assert.equal(run(['clone', '-q', fixture.github, race]).status, 0)

  const result = runPublisher(fixture, { raceClone: race })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release push failed \(the remote main moved or rejected the push\)/u)
  assert.match(result.stderr, /stale|rejected/iu)
  assert.deepEqual(ghCommands(fixture.ghLog).filter(command => !command.startsWith('release view')), [])
  const advanced = run(['-C', race, 'rev-parse', 'HEAD']).stdout.trim()
  assert.equal(githubMainOid(fixture), advanced)
})

test('a failed GitHub release create stops the attachment upload and the Gitea provenance tag', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture, { mode: 'create-fails' })
  assert.deepEqual(releaseTemporaries(fixture), [], 'every exit path removes the staged tree and archives')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GitHub release create failed; attachments and the Gitea provenance tag were not published/u)
  const commands = ghCommands(fixture.ghLog)
  assert.equal(commands.filter(command => command.startsWith('release create')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release upload')).length, 0)
  assert.equal(giteaTagCommit(fixture), '')
})

test('a failed attachment upload stops the Gitea provenance tag', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture, { mode: 'upload-fails' })
  assert.deepEqual(releaseTemporaries(fixture), [], 'every exit path removes the staged tree and archives')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /runtime archive upload to GitHub failed/u)
  assert.equal(giteaTagCommit(fixture), '')
})

test('a present update-notes file is validated and spliced into the release body', (t) => {
  const fixture = publisherFixture(t, { notes: "## What's new\n\n**Fixed**\n- **Layer styling after rename**: renaming keeps its styling\n" })
  const result = runPublisher(fixture)
  assert.equal(result.status, 0, result.stderr)
  const log = readFileSync(fixture.ghLog, 'utf8')
  assert.match(log, /release create/)
  assert.match(log, /What's new/)
  assert.match(log, /Layer styling after rename/)
})

test('a rule-violating update-notes file fails the publish before any remote command', (t) => {
  const fixture = publisherFixture(t, { notes: "## Notes\n\n- **Cap**: effect\n" })
  const result = runPublisher(fixture)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /map\/release\/notes\/v0\.1\.12\.md must start with "## What's new"/u)
  assert.deepEqual(ghCommands(fixture.ghLog), [])
  assert.equal(githubMainOid(fixture), '')
})
