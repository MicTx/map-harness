/** Relocated native helpers load their staged closure without a source checkout or user state. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { APPLICATION_LAUNCH_HELPERS, stageApplicationHelpers } from '../bin/application-helpers.mjs'
import { readDataCompatibility } from '../bin/install-manifest.mjs'
import { trackedTmpDir } from './support/reliability.mjs'

const repo = realpathSync(join(import.meta.dirname, '../..'))

function fixture(t) {
  const directory = trackedTmpDir('runtime-payload')
  t.after(() => directory.dispose())
  const root = realpathSync(directory.path)
  const stage = join(root, 'program'), user = join(root, 'user')
  mkdirSync(stage)
  mkdirSync(user)
  return { root, stage, user }
}

function run(item, script, commonjs = false) {
  return spawnSync(process.execPath, [`--input-type=${commonjs ? 'commonjs' : 'module'}`, '-e', script], {
    cwd: item.stage, encoding: 'utf8', timeout: 10000,
    env: { HOME: item.user, USERPROFILE: item.user, PATH: '/no-runtime-on-path', NODE_PATH: '', NODE_OPTIONS: '' },
  })
}

function success(result) {
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
}

test('helper staging copies the bootstrap and management closure into an independent program directory', t => {
  const item = fixture(t)
  const copied = stageApplicationHelpers(repo, item.stage)
  assert.deepEqual(copied, APPLICATION_LAUNCH_HELPERS)
  assert.deepEqual(readdirSync(item.stage).sort(), [...APPLICATION_LAUNCH_HELPERS].sort())
  for (const name of copied) assert.deepEqual(readFileSync(join(item.stage, name)), readFileSync(join(repo, 'map/bin', name)))
  const result = run(item, `
    const names = ${JSON.stringify(copied)}.filter(name => name !== 'web-service-qualification-platform.mjs');
    const modules = await Promise.all(names.map(name => import('./' + name)));
    const manager = modules[names.indexOf('manage.mjs')];
    const help = await manager.mainManage(['help']);
    if(help.exitCode !== 0) throw new Error(JSON.stringify(help));
    console.log(JSON.stringify({modules:names.length, usage:help.output}));
  `)
  success(result)
  assert.equal(JSON.parse(result.stdout).modules, copied.length - 1)
  assert.match(JSON.parse(result.stdout).usage, /map-harness manage/u)
  assert.deepEqual(readdirSync(item.user), [], 'loading helpers and management help writes no user state')
  assert.equal(existsSync(join(item.stage, 'map-harness.mjs')), false, 'source-only launcher is not a native dependency')
  assert.equal(existsSync(join(item.stage, 'source-preload.mjs')), false, 'source-only top-level await stays outside the installed closure')
})

test('compiled onboarding can require the pure instance prelude without triggering source admission', t => {
  const item = fixture(t)
  stageApplicationHelpers(repo, item.stage)
  const result = run(item, `
    const prelude=require('./instance-preload.mjs');
    const home=require('./instance-home.mjs');
    console.log(JSON.stringify({resolve:typeof prelude.resolveMapEntry, read:typeof home.readMapInstance}));
  `, true)
  success(result)
  assert.deepEqual(JSON.parse(result.stdout), { resolve: 'function', read: 'function' })
  assert.deepEqual(readdirSync(item.user), [])
})

test('a missing staged dependency is detected at load rather than reaching the checkout', t => {
  const item = fixture(t)
  stageApplicationHelpers(repo, item.stage)
  rmSync(join(item.stage, 'instance-home.mjs'))
  const result = run(item, "await import('./instance-preload.mjs')")
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/u)
  assert.match(result.stderr, /instance-home\.mjs/u)
  assert.deepEqual(readdirSync(item.user), [])
})

test('helper staging rejects linked or missing source helpers instead of copying another tree', t => {
  const item = fixture(t)
  const source = join(item.root, 'source'), helperRoot = join(source, 'map/bin')
  mkdirSync(helperRoot, { recursive: true })
  assert.throws(() => stageApplicationHelpers(source, item.stage), { code: 'ENOENT' })
  const first = APPLICATION_LAUNCH_HELPERS[0]
  const linked = join(item.root, 'linked-helper')
  mkdirSync(linked)
  symlinkSync(linked, join(helperRoot, first), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => stageApplicationHelpers(source, item.stage), /regular file/u)
  assert.deepEqual(readdirSync(item.stage), [])
})

test('a staged management status reads only its explicitly selected installation', async t => {
  const item = fixture(t)
  stageApplicationHelpers(repo, item.stage)
  const other = join(item.root, 'uninitialized-installation')
  const result = run(item, `
    const {mainManage}=await import('./manage.mjs');
    const status=await mainManage(['status','--install-root',${JSON.stringify(other)},'--json']);
    console.log(JSON.stringify(status));
  `)
  success(result)
  const resultValue = JSON.parse(result.stdout)
  assert.equal(resultValue.exitCode, 0)
  assert.equal(resultValue.json.state, 'absent')
  assert.equal(existsSync(other), false)
  assert.deepEqual(readdirSync(item.user), [])
})

test('the source manage help entry needs neither a profile nor built domain packages', t => {
  const item = fixture(t)
  const bin = join(item.root, 'source/map/bin')
  mkdirSync(bin, { recursive: true })
  stageApplicationHelpers(repo, bin)
  copyFileSync(join(repo, 'map/bin/map-harness.mjs'), join(bin, 'map-harness.mjs'))
  const result = spawnSync(process.execPath, [join(bin, 'map-harness.mjs'), 'manage', '--help'], {
    cwd: item.stage, encoding: 'utf8', timeout: 10000,
    env: { HOME: item.user, USERPROFILE: item.user, PATH: '/no-runtime-on-path', NODE_PATH: '', NODE_OPTIONS: '' },
  })
  success(result)
  assert.match(result.stdout, /map-harness manage/u)
  assert.deepEqual(readdirSync(item.user), [])
})

test('a sealed dry-run import plan fails closed without injected domain owners', async t => {
  const item = fixture(t)
  stageApplicationHelpers(repo, item.stage)
  const legacy = join(item.root, 'legacy-source')
  mkdirSync(legacy)
  const dataHome = join(item.root, 'map-data')
  const compatibility = await readDataCompatibility(repo)
  const result = run(item, `
    const {mainManage}=await import('./manage.mjs');
    const context={dataCompatibility:${JSON.stringify(compatibility)},installRoots:[${JSON.stringify(item.stage)}]};
    const outcome=await mainManage(['import','--from',${JSON.stringify(legacy)},'--to',${JSON.stringify(dataHome)}],context);
    console.log(JSON.stringify(outcome));
  `)
  success(result)
  const outcome = JSON.parse(result.stdout)
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.json.error.code, 'MAP_IMPORT_BUILD')
  assert.equal(existsSync(dataHome), false)
  assert.deepEqual(readdirSync(legacy), [], 'a failed plan leaves the legacy source unchanged')
})
