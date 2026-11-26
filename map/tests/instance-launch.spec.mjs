import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MapHomeError, prepareMapInstance } from '../bin/instance-home.mjs'
import { acquireInstanceLock } from '../bin/instance-lock.mjs'
import {
  applyMapEnvironment, externalMapEnvironment, mapEntryEnvironment, mapEntryMode, prepareMapDiagnostic, resolveMapEntry,
} from '../bin/instance-preload.mjs'

const repo = resolve(import.meta.dirname, '../..')

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-instance-launch-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'user')
  mkdirSync(home)
  return { root, home }
}

function failure(code) {
  return error => {
    assert.ok(error instanceof MapHomeError, error.stack)
    assert.equal(error.code, code)
    return true
  }
}

test('the external prelude ignores poisoned DSH roots, strips private selectors, and pins the bridge', t => {
  const item = fixture(t)
  const env = Object.freeze({
    HOME: item.home, USERPROFILE: item.home,
    DSH_HOME: join(item.home, '.dsh'), DSH_AGENTS_HOME: join(item.home, '.agents'),
    DSH_RESOURCE_CACHE: join(item.home, '.cache', 'deepseek-harness'), PKG_NATIVE_CACHE_PATH: join(item.home, '.cache', 'pkg'),
    DSH_BUNDLED_PRIMARY_RUNTIME: '/stale/runtime', DSH_BUNDLED_OFFICE_CLI: '/stale/office',
    DSH_SUBPROCESS_RUNNER: 'ambient-role', DSH_PTC_RUNTIME_NODE: '1',
    DEEPSEEK_API_KEY: 'fixture-key', HTTPS_PROXY: 'http://proxy.invalid', DSH_TELEMETRY_MODE: 'DISABLED',
  })
  const entry = resolveMapEntry({ programRoot: repo, identity: { mode: 'source', channel: 'stable', distribution: 'portable' }, env, cwd: item.root, homedir: item.home })
  assert.equal(entry.internal, false)
  assert.equal(entry.spec.home, join(item.home, '.map-harness-dev', entry.spec.checkoutKey))
  assert.deepEqual(Object.keys(entry.environment).filter(key => key.startsWith('DSH_')), ['DSH_TELEMETRY_MODE'])
  assert.equal(entry.environment.DEEPSEEK_API_KEY, 'fixture-key')
  assert.equal(entry.environment.HTTPS_PROXY, 'http://proxy.invalid')
  assert.throws(() => mapEntryEnvironment(entry, repo), failure('MAP_ENTRY_CONTEXT'))
  entry.spec = prepareMapInstance(entry.spec)
  const bridged = mapEntryEnvironment(entry, repo)
  assert.equal(bridged.DSH_HOME, entry.spec.home)
  assert.equal(bridged.DSH_AGENTS_HOME, join(entry.spec.home, 'agents'))
  assert.equal(bridged.DSH_RESOURCE_CACHE, join(entry.spec.home, 'cache', 'runtime'))
  assert.equal(bridged.PKG_NATIVE_CACHE_PATH, join(entry.spec.home, 'cache', 'runtime'))
  assert.equal(bridged.MAPHARNESS_BROWSER_NAMESPACE, `map-harness:${entry.spec.instanceId}`)
  assert.equal(JSON.parse(bridged.MAPHARNESS_INSTANCE_CONTEXT).programRoot, repo)
})

test('a fixed worker restores its admitted instance only from a matching context and marker', t => {
  const item = fixture(t)
  const env = { HOME: item.home, USERPROFILE: item.home, MAPHARNESS_HOME: join(item.root, 'data') }
  const external = resolveMapEntry({ programRoot: repo, identity: { mode: 'source', channel: 'stable', distribution: 'portable' }, env, cwd: item.root, homedir: item.home })
  const prepared = prepareMapInstance(external.spec)
  const bridged = mapEntryEnvironment({ ...external, spec: prepared }, repo)
  const internal = resolveMapEntry({
    programRoot: repo, identity: { mode: 'source', channel: 'stable', distribution: 'portable' },
    env: { ...bridged, DSH_SUBPROCESS_RUNNER: 'acp' }, cwd: item.root, homedir: item.home, fixedWorker: true,
  })
  assert.equal(internal.internal, true)
  assert.equal(internal.inherited, true)
  assert.equal(internal.spec.instanceId, prepared.instanceId)
  assert.equal(internal.environment.DSH_SUBPROCESS_RUNNER, 'acp')
  assert.throws(() => resolveMapEntry({
    programRoot: item.root, identity: { mode: 'source', channel: 'stable', distribution: 'portable' },
    env: { ...bridged, DSH_SUBPROCESS_RUNNER: 'acp' }, cwd: item.root, homedir: item.home, fixedWorker: true,
  }), failure('MAP_ENTRY_CONTEXT'))
  assert.throws(() => resolveMapEntry({
    programRoot: repo, identity: { mode: 'source', channel: 'preview', distribution: 'portable' },
    env: bridged, cwd: item.root, homedir: item.home, fixedWorker: true,
  }), failure('MAP_ENTRY_CONTEXT'))
})

test('the context alone never grants internal status and malformed contexts fail closed', t => {
  const item = fixture(t)
  const base = { programRoot: repo, identity: { mode: 'source', channel: 'stable', distribution: 'portable' }, cwd: item.root, homedir: item.home }
  const plain = resolveMapEntry({ ...base, env: { HOME: item.home, USERPROFILE: item.home, MAPHARNESS_HOME: join(item.root, 'data') } })
  const prepared = prepareMapInstance(plain.spec)
  const bridged = mapEntryEnvironment({ ...plain, spec: prepared }, repo)
  const withoutRole = resolveMapEntry({ ...base, env: bridged })
  assert.equal(withoutRole.internal, false)
  assert.equal(withoutRole.inherited, true)
  for (const value of ['{broken', 'null', JSON.stringify({ format: 1 }), JSON.stringify({ ...JSON.parse(bridged.MAPHARNESS_INSTANCE_CONTEXT), mode: 'unknown' })]) {
    assert.throws(() => resolveMapEntry({ ...base, env: { ...bridged, MAPHARNESS_INSTANCE_CONTEXT: value } }), failure('MAP_ENTRY_CONTEXT'))
  }
})

test('applying an entry environment removes every ambient key while preserving the bridge', t => {
  const target = { KEEP: '1', DSH_HOME: '/stock', DSH_BUNDLED_PRIMARY_RUNTIME: '/stale', OTHER: '2' }
  applyMapEnvironment({ KEEP: 'changed', DSH_HOME: '/map', ADDED: '3' }, target)
  assert.deepEqual(target, { KEEP: 'changed', DSH_HOME: '/map', ADDED: '3' })
  assert.deepEqual(externalMapEnvironment({ DSH_HOME: '/stock', DSH_AGENTS_HOME: '/a', DSH_RESOURCE_CACHE: '/c', PKG_NATIVE_CACHE_PATH: '/pkg', PATH: '/bin', MAPHARNESS_HOME: '/m' }), { PATH: '/bin', MAPHARNESS_HOME: '/m' })
})

test('diagnostic, prepare, and service modes stay distinct', () => {
  for (const argv of [['--help'], ['-h'], ['--version'], ['-v'], ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema']]) {
    assert.equal(mapEntryMode(argv), 'diagnostic', argv.join(' '))
  }
  assert.equal(mapEntryMode(['--prepare']), 'prepare')
  assert.equal(mapEntryMode(['web', '--port', '6425']), 'service')
})

test('the source prelude prepares one isolated home and profile in a subprocess without build artifacts', t => {
  const item = fixture(t)
  const home = join(item.root, 'map home with spaces')
  const result = spawnSync(process.execPath, ['--import', join(repo, 'map/bin/source-preload.mjs'), '--input-type=module', '-e',
    "console.log(JSON.stringify({ home: process.env.MAPHARNESS_HOME, agents: process.env.DSH_AGENTS_HOME, cache: process.env.DSH_RESOURCE_CACHE, pkgCache: process.env.PKG_NATIVE_CACHE_PATH, namespace: process.env.MAPHARNESS_BROWSER_NAMESPACE }))"], {
    encoding: 'utf8', cwd: item.root,
    env: { PATH: process.env.PATH, HOME: item.home, USERPROFILE: item.home, MAPHARNESS_HOME: home, DSH_HOME: join(item.home, '.dsh'), DSH_TELEMETRY_MODE: 'DISABLED' },
    timeout: 30000,
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.home, home)
  assert.equal(observed.agents, join(home, 'agents'))
  assert.equal(observed.cache, join(home, 'cache', 'runtime'))
  assert.equal(observed.pkgCache, join(home, 'cache', 'runtime'))
  assert.match(observed.namespace, /^map-harness:[a-f0-9-]{36}$/u)
  assert.equal(existsSync(join(home, 'map-instance.json')), true)
  assert.equal(existsSync(join(home, 'profiles', 'map-web', 'package.json')), true)
  assert.equal(existsSync(join(item.home, '.dsh')), false)
})

test('an admitted source worker restores the bridge without grabbing its parent service lock or writing a profile', async t => {
  const item = fixture(t)
  const entry = resolveMapEntry({ programRoot: repo, homedir: item.home, env: { HOME: item.home, USERPROFILE: item.home, MAPHARNESS_HOME: join(item.root, 'worker-data') } })
  entry.spec = prepareMapInstance(entry.spec)
  const lease = await acquireInstanceLock(entry.spec)
  t.after(() => lease.release())
  const result = spawnSync(process.execPath, ['--import', join(repo, 'map/bin/source-preload.mjs'), '--input-type=module', '-e',
    'console.log(JSON.stringify({ home:process.env.DSH_HOME, namespace:process.env.MAPHARNESS_BROWSER_NAMESPACE, role:process.env.DSH_SUBPROCESS_RUNNER }))'], {
    encoding: 'utf8', cwd: item.root, timeout: 10000,
    env: { ...mapEntryEnvironment(entry, repo), DSH_SUBPROCESS_RUNNER: 'fixture' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { home: entry.spec.home, namespace: `map-harness:${entry.spec.instanceId}`, role: 'fixture' })
  assert.equal(existsSync(join(entry.spec.home, 'profiles')), false)
  await lease.release()
})

test('read-only diagnostics use a disposable config copy and never initialize the requested home', t => {
  const item = fixture(t)
  const original = join(item.root, 'not-yet-created')
  const entry = resolveMapEntry({ programRoot: repo, homedir: item.home, env: { MAPHARNESS_HOME: original } })
  const diagnostic = prepareMapDiagnostic(entry, { initializeProfile: spec => {
    mkdirSync(join(spec.home, 'profiles/map-web'), { recursive: true })
    writeFileSync(join(spec.home, 'profiles/map-web/package.json'), '{}\n')
  } })
  t.after(diagnostic.dispose)
  assert.notEqual(diagnostic.spec.home, original)
  assert.equal(existsSync(original), false)
  assert.equal(existsSync(join(diagnostic.spec.home, 'profiles/map-web/package.json')), true)
  diagnostic.dispose()
  assert.equal(existsSync(diagnostic.spec.home), false)
})

test('source help and version leave the configured Map root untouched', t => {
  const item = fixture(t)
  const home = join(item.root, 'untouched-home')
  const entry = join(item.root, 'unreached.mjs')
  writeFileSync(entry, 'throw new Error("CLI must not import")\n')
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, ['--import', join(repo, 'map/bin/source-preload.mjs'), entry, flag], {
      encoding: 'utf8', timeout: 10000, cwd: item.root,
      env: { PATH: process.env.PATH, HOME: item.home, USERPROFILE: item.home, MAPHARNESS_HOME: home },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /map-harness|Map Harness/u)
    assert.equal(existsSync(home), false)
  }
})

test('every launch entry delegates to the shared resolver and no entry keeps the old DSH fallback', () => {
  for (const file of ['map/bin/map-harness.mjs', 'map/bin/application-bootstrap.mjs', 'map/bin/web-onboarding.mjs']) {
    const source = readFileSync(join(repo, file), 'utf8')
    assert.doesNotMatch(source, /\[.*MAPHARNESS_HOME,\s*.*DSH_HOME.*\]/u, `${file} must not select DSH_HOME`)
    assert.doesNotMatch(source, /(?:join|resolve)\(homedir\(\),\s*'\.dsh'\)/u, `${file} must not default to ~/.dsh`)
    assert.match(source, /instance-(?:home|preload)\.mjs/u, `${file} must use the shared instance contract`)
  }
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['start:web'].includes('--import ./map/bin/source-preload.mjs'), true)
  assert.equal(pkg.scripts['start:web'].includes('&&'), false)
  assert.match(pkg.scripts['dev:web'], /--profile map-web/u)
  assert.match(pkg.scripts['dev:web'], /--preload \.\/map\/bin\/source-preload\.mjs/u)
})

test('dev-web forwards the selected profile and preload before the CLI, keeping the stock default without them', () => {
  const program = `
    import { parseDevWebArguments } from ${JSON.stringify(join(repo, 'scripts/dev-web.ts'))};
    console.log(JSON.stringify([
      parseDevWebArguments([]),
      parseDevWebArguments(['--profile', 'map-web', '--preload', './map/bin/instance-preload.mjs', '--no-open']),
    ]));
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', program], {
    encoding: 'utf8', cwd: repo, timeout: 30000,
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  const [stock, map] = JSON.parse(result.stdout)
  assert.equal(stock.profile, undefined)
  assert.equal(stock.preload, undefined)
  assert.deepEqual(stock.appArgs, [])
  assert.equal(map.profile, 'map-web')
  assert.equal(map.preload, resolve('map/bin/instance-preload.mjs'))
  assert.deepEqual(map.appArgs, ['--no-open'])
})
