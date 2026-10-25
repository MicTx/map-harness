/**
 * Publisher release gates: the exact-OID lease that replaces bare `--force`
 * on the public main, the default-deny source allowlist behind public
 * staging, and end-to-end publisher runs against fixture repositories with
 * recording `git`/`gh` stand-ins. The remote-mutation scenarios (unborn and
 * moved remotes, existing releases, failed release writes) run the actual
 * `map/bin/publish-release.mjs` against a local bare remote; the private
 * Gitea API is unreachable by design and asserts its credential guard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPublicSources, publicReleaseInputs } from './pack-runtime.mjs'
import { assertCommunityEnvironment, forceWithLease, recordPublicBuild } from './public-release-privacy.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_ENV = { DSH_CLIENT_MAP_ORG_NAME: '', DSH_CLIENT_TITLE: '探索未至之境 x Map Harness · 社区版' }
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
        'README.md', 'apps/desktop/.env.macos.example', 'docs/user/guide/index.md', 'packages/app/user/guide.md',
        'packages/app/workflows/build.yml', 'map/tools/lib/index.js',
      ].sort(),
      excluded: [
        '.agents/notes/a.md', '.env', '.spec/specs/demo/spec.md', 'logs/run.log',
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

/** Private content the publisher must never stage. */
const PRIVATE_FIXTURES = [
  '.env',
  '.agents/notes/design.md',
  '.github/workflows/ci.yml',
  '.spec/specs/demo/spec.md',
  'logs/run.log',
  'map/docs/github-release.md',
  'packages/app/.env.production',
  'packages/app/.spec/state.json',
  'packages/app/.cursor/rules.md',
  'user/sessions/1.jsonl',
]

/** Allowlisted sources, including the build outputs the runtime pack needs. */
const PUBLIC_FIXTURES = [
  '.editorconfig',
  'apps/desktop/.env.macos.example',
  '.github/ISSUE_TEMPLATE/bug.md',
  'LICENSE',
  'README.md',
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
function publisherFixture(t, { extra = [], unclassified = [] } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'map-publisher-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'src')
  const github = join(parent, 'github.git')
  const bin = join(parent, 'bin')
  const scratch = join(parent, 'tmp')
  const ghLog = join(parent, 'gh.log')
  const gitLog = join(parent, 'git.log')
  mkdirSync(join(root, 'map/bin'), { recursive: true })
  mkdirSync(join(root, 'map/docs'), { recursive: true })
  for (const name of ['publish-release.mjs', 'pack-runtime.mjs', 'public-release-privacy.mjs']) {
    copyFileSync(join(repo, 'map/bin', name), join(root, 'map/bin', name))
  }
  copyFileSync(join(repo, 'map/docs/release-install-guide.md'), join(root, 'map/docs/release-install-guide.md'))
  mkdirSync(join(root, 'map/release'), { recursive: true })
  writeFileSync(join(root, 'map/release/version.json'), '{"version":"0.1.12"}\n')
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\n')
  for (const launcher of LAUNCHER_NAMES) {
    writeFileSync(join(root, 'map/release', launcher), 'launcher fixture\n')
  }
  const content = 'Community fixture\n'
  for (const file of [...PUBLIC_FIXTURES, ...PRIVATE_FIXTURES, ...extra]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), file.endsWith('.json') && file === 'package.json' ? '{"name":"@map-harness/fixture"}\n' : content)
  }
  const run = (args, options = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options })
  assert.equal(run(['init', '-b', 'main']).status, 0)
  assert.equal(run(['remote', 'add', 'origin', 'https://gitea.invalid/owner/name.git']).status, 0)
  assert.equal(run(['add', '-A']).status, 0)
  assert.equal(run(['-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']).status, 0)
  assert.equal(spawnSync('git', ['init', '--bare', '-b', 'main', github]).status, 0)
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 })
  mkdirSync(scratch)
  const listed = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  const { published } = filterPublicSources(listed)
  assertCommunityEnvironment(PUBLIC_ENV)
  recordPublicBuild(root, publicReleaseInputs(root, published), PUBLIC_ENV, published)
  for (const file of unclassified) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  if (unclassified.length > 0) {
    assert.equal(run(['add', '-A']).status, 0)
    assert.equal(run(['-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'unclassified']).status, 0)
  }
  return { parent, root, github, bin, scratch, ghLog, gitLog, published }
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
    FAKE_GIT_LOG: fixture.gitLog,
    FAKE_GH_MODE: mode,
    FAKE_GIT_REAL: REAL_GIT,
  }
  if (raceClone !== undefined) env.FAKE_GIT_RACE_CLONE = raceClone
  return spawnSync(process.execPath, [
    join(fixture.root, 'map/bin/publish-release.mjs'),
    '--version', 'v0.1.12', '--github', fixture.github, '--skip-gitea-check', ...extraArgs,
  ], { cwd: fixture.root, encoding: 'utf8', env })
}

const ghCommands = log => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
const githubTree = fixture => spawnSync('git', ['--git-dir', fixture.github, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
const githubMainOid = fixture => spawnSync('git', ['ls-remote', fixture.github, 'refs/heads/main'], { encoding: 'utf8' }).stdout.split('\t')[0]

test('a clean publish rewrites the unborn public main under a lease and stages only allowlisted files', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture)
  // The Gitea step runs last and stops at its credential guard: the private
  // API host is unreachable from tests, so reaching it proves every earlier step ran.
  assert.match(result.stderr, /no git credential for gitea\.invalid/u)
  assert.match(result.stdout, new RegExp(`staged ${fixture.published.length} files \\(${PRIVATE_FIXTURES.length} excluded by privacy rules\\)`))
  const commands = ghCommands(fixture.ghLog)
  assert.equal(commands.filter(command => command.startsWith('release view')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release create')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release upload')).length, 1)
  const pushes = readFileSync(fixture.gitLog, 'utf8').split('\n').filter(line => line.includes(' push ') || line.startsWith('push '))
  assert.equal(pushes.filter(line => line.includes('--force-with-lease=refs/heads/main:')).length, 1, pushes.join('\n'))
  assert.equal(pushes.some(line => /\spush\s--force(?:\s|$)/u.test(line)), false, pushes.join('\n'))
  const tree = githubTree(fixture)
  for (const published of ['README.md', 'apps/desktop/.env.macos.example', 'docs/user/guide/index.md', 'packages/app/user/guide.md', ...LAUNCHER_NAMES.map(name => `map/release/${name}`)]) {
    assert.equal(tree.includes(published), true, published)
  }
  for (const excluded of [...PRIVATE_FIXTURES, '.dsh-build/map-public-release.json']) {
    assert.equal(tree.some(file => file === excluded || file.startsWith(`${excluded}/`)), false, excluded)
  }
})

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

test('a failed GitHub release create stops the attachment upload and the Gitea release', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture, { mode: 'create-fails' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GitHub release create failed; attachments and the Gitea release were not published/u)
  const commands = ghCommands(fixture.ghLog)
  assert.equal(commands.filter(command => command.startsWith('release create')).length, 1)
  assert.equal(commands.filter(command => command.startsWith('release upload')).length, 0)
  assert.doesNotMatch(result.stderr, /no git credential/u)
})

test('a failed attachment upload stops the Gitea release', (t) => {
  const fixture = publisherFixture(t)
  const result = runPublisher(fixture, { mode: 'upload-fails' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /runtime archive upload to GitHub failed/u)
  assert.doesNotMatch(result.stderr, /no git credential/u)
})
