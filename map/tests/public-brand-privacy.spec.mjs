/** Public releases accept only unchanged, verified community build inputs. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertCommunityEnvironment, assertPublicBuild, assertPublicSources, recordPublicBuild } from '../bin/public-release-privacy.mjs'
import { publicReleaseInputs } from '../bin/pack-runtime.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_ENV = { DSH_CLIENT_MAP_ORG_NAME: '', DSH_CLIENT_TITLE: '探索未至之境 x Map Harness · 社区版' }

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-public-brand-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = ['README.md', 'map/client-ui-brand/lib/client.js', 'apps/web/dist/index.html']
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'Community fixture\n')
  }
  return { root, files }
}

test('community environment rejects private identity without echoing it', () => {
  assert.doesNotThrow(() => assertCommunityEnvironment(PUBLIC_ENV))
  const name = 'Fictional Deployment Organization'
  for (const env of [
    { ...PUBLIC_ENV, DSH_CLIENT_MAP_ORG_NAME: ` ${name} ` },
    { ...PUBLIC_ENV, DSH_CLIENT_TITLE: name },
    { ...PUBLIC_ENV, DSH_CLIENT_CUSTOM_BRAND: name },
  ]) {
    assert.throws(() => assertCommunityEnvironment(env), (error) => {
      assert.doesNotMatch(error.message, /Fictional Deployment/)
      return /public|community/i.test(error.message)
    })
  }
})

test('an unchanged community payload passes with the organization environment cleared', (t) => {
  const { root, files } = fixture(t)
  recordPublicBuild(root, files, PUBLIC_ENV)
  assert.doesNotThrow(() => assertPublicBuild(root, files, {}))
})

test('private builds cannot produce a public release record', (t) => {
  const { root, files } = fixture(t)
  assert.throws(() => recordPublicBuild(root, files, { ...PUBLIC_ENV, DSH_CLIENT_MAP_ORG_NAME: 'Fictional Org' }))
  assert.throws(() => assertPublicBuild(root, files, {}), /record|build/i)
})

test('clearing the environment does not allow changed private output or source maps', (t) => {
  const { root, files } = fixture(t)
  recordPublicBuild(root, files, PUBLIC_ENV)
  writeFileSync(join(root, files[1]), 'Fictional private organization\n')
  assert.throws(() => assertPublicBuild(root, files, {}), /changed|match|stale/i)
})

test('new, deleted, and changed source inputs invalidate the public build', (t) => {
  const { root, files } = fixture(t)
  recordPublicBuild(root, files, PUBLIC_ENV)
  writeFileSync(join(root, 'new.js.map'), 'Fictional private organization\n')
  assert.throws(() => assertPublicBuild(root, [...files, 'new.js.map'], {}), /changed|match|stale/i)
  assert.throws(() => assertPublicBuild(root, files.slice(1), {}), /changed|match|stale/i)
  writeFileSync(join(root, files[0]), 'Changed README\n')
  assert.throws(() => assertPublicBuild(root, files, {}), /changed|match|stale/i)
})

test('unreadable and escaping inputs fail closed', (t) => {
  const { root, files } = fixture(t)
  assert.throws(() => recordPublicBuild(root, [...files, 'absent.txt'], PUBLIC_ENV))
  assert.throws(() => recordPublicBuild(root, [...files, '../outside.txt'], PUBLIC_ENV))
  symlinkSync(tmpdir(), join(root, 'outside'))
  assert.throws(() => recordPublicBuild(root, [...files, 'outside'], PUBLIC_ENV))
})

function packerFixture(t) {
  const { root } = fixture(t)
  const tracked = ['README.md', 'map/client-ui-brand/package.json']
  for (const file of ['apps/cli/lib/bin.js', 'map/tools/lib/index.js', 'map/map-container/lib/client.js', 'native/system/packages/entry/lib/index.js', 'map/client-ui-brand/package.json']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '{}\n')
  }
  mkdirSync(join(root, 'map/bin'), { recursive: true })
  for (const name of ['pack-runtime.mjs', 'public-release-privacy.mjs']) {
    copyFileSync(join(repo, 'map/bin', name), join(root, 'map/bin', name))
  }
  mkdirSync(join(root, 'map/release'), { recursive: true })
  for (const name of ['install.cmd', 'install.sh', 'start.cmd', 'start.sh']) writeFileSync(join(root, 'map/release', name), 'fixture\n')
  writeFileSync(join(root, 'include.txt'), tracked.join('\n'))
  return { root, tracked }
}

function pack(root, env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
  return spawnSync(process.execPath, [join(root, 'map/bin/pack-runtime.mjs'), '--version', 'v0.0.0', '--out', join(root, 'out'), '--include', join(root, 'include.txt')], {
    cwd: root, encoding: 'utf8', env: { ...inherited, ...env },
  })
}

test('the actual packer refuses a private environment before creating an archive', (t) => {
  const { root } = packerFixture(t)
  const result = pack(root, { DSH_CLIENT_MAP_ORG_NAME: 'Fictional Org' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /public|community/i)
  assert.doesNotMatch(result.stderr, /Fictional Org/)
  assert.equal(existsSync(join(root, 'out')), false)
})

test('the actual packer refuses missing public build evidence even with an empty environment', (t) => {
  const { root } = packerFixture(t)
  const result = pack(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /record|build/i)
  assert.equal(existsSync(join(root, 'out')), false)
})

test('the actual packer accepts a sealed community build and excludes build records', (t) => {
  const { root, tracked } = packerFixture(t)
  recordPublicBuild(root, publicReleaseInputs(root, tracked), PUBLIC_ENV, tracked)
  const result = pack(root)
  assert.equal(result.status, 0, result.stderr)
  const archive = join(root, 'out/map-harness-v0.0.0-runtime.tar.gz')
  assert.equal(existsSync(archive), true)
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /client-ui-brand\/lib\/client\.js/)
  assert.doesNotMatch(listing.stdout, /\.dsh-build/)
  for (const launcher of ['install.cmd', 'install.sh', 'start.cmd', 'start.sh']) {
    for (const source of [launcher, `map/release/${launcher}`]) {
      const path = `map-harness-v0.0.0-runtime/${source}`
      const tar = spawnSync('tar', ['-xOf', archive, path], { encoding: 'utf8' })
      const zip = spawnSync('unzip', ['-p', archive.replace('.tar.gz', '.zip'), path], { encoding: 'utf8' })
      assert.equal(tar.status, 0, tar.stderr)
      assert.equal(zip.status, 0, zip.stderr)
      assert.equal(tar.stdout, readFileSync(join(root, 'map/release', launcher), 'utf8'))
      assert.equal(zip.stdout, tar.stdout)
    }
  }
})

for (const changed of ['map/client-ui-brand/lib/old.js.map', 'map/release/install.sh']) {
  test(`the actual packer refuses changed copied inputs: ${changed}`, (t) => {
    const { root, tracked } = packerFixture(t)
    recordPublicBuild(root, publicReleaseInputs(root, tracked), PUBLIC_ENV, tracked)
    writeFileSync(join(root, changed), 'Fictional private organization\n')
    const result = pack(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /changed|match|stale/i)
    assert.equal(existsSync(join(root, 'out')), false)
  })
}

test('the actual packer rejects a chunk added after preflight but copied into staging', (t) => {
  const { root, tracked } = packerFixture(t)
  recordPublicBuild(root, publicReleaseInputs(root, tracked), PUBLIC_ENV, tracked)
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const original = fs.cpSync;
    fs.cpSync = (source, target, options) => {
      if (source.endsWith('map/client-ui-brand/lib')) fs.writeFileSync(source + '/late-private.js.map', 'Fictional Org');
      return original(source, target, options);
    };
    syncBuiltinESMExports();
    const {packRuntime} = await import(pathToFileURL(${JSON.stringify(join(root, 'map/bin/pack-runtime.mjs'))}));
    packRuntime({version:'v0.0.0',out:${JSON.stringify(join(root, 'out'))},tracked:${JSON.stringify(tracked)}});
  `
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8', env })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /changed/i)
  assert.equal(existsSync(join(root, 'out')), false)
})

test('source-only staging is checked against the build record, not the live worktree', (t) => {
  const { root, files } = fixture(t)
  recordPublicBuild(root, files, PUBLIC_ENV, [files[0]])
  const stage = join(root, 'stage')
  mkdirSync(stage)
  copyFileSync(join(root, files[0]), join(stage, files[0]))
  assert.doesNotThrow(() => assertPublicSources(root, stage))
  writeFileSync(join(stage, 'unexpected.txt'), 'Fictional private organization\n')
  assert.throws(() => assertPublicSources(root, stage), /changed/i)
  rmSync(join(stage, 'unexpected.txt'))
  writeFileSync(join(stage, files[0]), 'Fictional private organization\n')
  assert.throws(() => assertPublicSources(root, stage), /changed/i)
})

function buildFixture(t) {
  const { root, tracked: base } = packerFixture(t)
  const manifest = 'packages/client/example/package.json'
  mkdirSync(dirname(join(root, manifest)), { recursive: true })
  writeFileSync(join(root, manifest), '{}\n')
  for (const name of ['build-web.mjs', 'build.mjs']) copyFileSync(join(repo, 'map/bin', name), join(root, 'map/bin', name))
  copyFileSync(join(repo, 'map/release/version.json'), join(root, 'map/release/version.json'))
  const tracked = [...base, manifest]
  writeFileSync(join(root, 'include.txt'), tracked.join('\n'))
  const bin = join(root, 'fake-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(tracked.join('\0') + '\0')});\n`, { mode: 0o755 })
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync('build-steps.txt', args.join(' ') + '\\n');
if (args.includes('clean')) process.exit(0);
if (process.env.FIXTURE_FAIL_BUILD === '1') process.exit(42);
const files = args.includes('build:artifacts')
  ? ['apps/cli/lib/bin.js', 'native/system/packages/entry/lib/index.js', 'apps/web/dist/index.html', 'packages/client/example/lib/client.js']
  : ['map/client-ui-brand/lib/client.js', 'map/map-container/lib/client.js', 'map/tools/lib/index.js'];
for (const file of files) {
  mkdirSync(dirname(file), {recursive:true});
  writeFileSync(file, process.env.DSH_CLIENT_MAP_ORG_NAME || 'Community build');
}
`, { mode: 0o755 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
  const build = extra => spawnSync(process.execPath, [join(root, 'map/bin/build-web.mjs')], {
    cwd: root, encoding: 'utf8', env: { ...env, PATH: bin, ...extra },
  })
  return { root, build }
}

test('the real builder removes upstream and map leftovers before sealing a community runtime', (t) => {
  const { root, build } = buildFixture(t)
  const leftovers = ['packages/client/example/lib/client.private-old.js.map', 'packages/client/example/lib/host-old.js', 'map/client-ui-brand/lib/private-old.js', 'apps/web/dist/old.js']
  for (const file of leftovers) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'Fictional private organization\n')
  }
  const result = build({})
  assert.equal(result.status, 0, result.stderr)
  for (const file of leftovers) assert.equal(existsSync(join(root, file)), false, file)
  assert.match(readFileSync(join(root, 'build-steps.txt'), 'utf8'), /^run clean\nrun build:artifacts\n/)
  const packaged = pack(root)
  assert.equal(packaged.status, 0, packaged.stderr)
})

test('a real private build invalidates the public record even after clearing its environment', (t) => {
  const { root, build } = buildFixture(t)
  assert.equal(build({}).status, 0)
  const privateBuild = build({ DSH_CLIENT_MAP_ORG_NAME: 'Fictional Org' })
  assert.equal(privateBuild.status, 0, privateBuild.stderr)
  const result = pack(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /record.*missing/i)
  assert.equal(existsSync(join(root, 'out')), false)
})

test('a failed rebuild cannot reuse a previous public record', (t) => {
  const { root, build } = buildFixture(t)
  assert.equal(build({}).status, 0)
  assert.notEqual(build({ FIXTURE_FAIL_BUILD: '1' }).status, 0)
  assert.notEqual(pack(root).status, 0)
  assert.equal(existsSync(join(root, 'out')), false)
})

for (const state of ['missing', 'stale']) {
  test(`the actual publisher refuses ${state} evidence before remote commands`, (t) => {
    const { root, tracked } = packerFixture(t)
    if (state === 'stale') {
      recordPublicBuild(root, publicReleaseInputs(root, tracked), PUBLIC_ENV, tracked)
      writeFileSync(join(root, 'README.md'), 'Changed source\n')
    }
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
const responses = ${JSON.stringify({ 'status --porcelain': '', 'branch --show-current': 'main', 'rev-parse HEAD': 'a'.repeat(40), 'rev-parse --show-toplevel': root, '-c core.quotepath=false ls-files': tracked.join('\n') })};
if (!(args in responses)) { writeFileSync(${JSON.stringify(join(root, 'unexpected-command'))}, args); process.exit(99); }
process.stdout.write(responses[args]);
`, { mode: 0o755 })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
    const result = spawnSync(process.execPath, [join(repo, 'map/bin/publish-release.mjs'), '--version', 'v0.0.0'], {
      cwd: root, encoding: 'utf8', env: { ...inherited, PATH: bin },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Public build/i)
    assert.equal(existsSync(join(root, 'unexpected-command')), false)
  })
}

test('the publisher checks privacy before any git or gh command', (t) => {
  const { root } = fixture(t)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_CLIENT_')))
  const result = spawnSync(process.execPath, [join(repo, 'map/bin/publish-release.mjs'), '--version', 'v0.0.0'], {
    cwd: root, encoding: 'utf8', env: { ...inherited, DSH_CLIENT_MAP_ORG_NAME: 'Fictional Org', PATH: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /public|community/i)
  assert.doesNotMatch(result.stderr, /Fictional Org|git .*failed/)
})
