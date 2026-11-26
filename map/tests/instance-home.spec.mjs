import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { trackedTmpDir } from './support/reliability.mjs'
import test from 'node:test'
import {
  bridgeEnvironment, MAP_IDENTITY_REVISION, MAP_INSTANCE_FORMAT,
  MAP_INSTANCE_MARKER, MapHomeError, prepareMapInstance, readMapInstance, resolveMapInstance,
} from '../bin/instance-home.mjs'

function fixture(t) {
  const directory = trackedTmpDir('instance-home')
  const root = realpathSync(directory.path)
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await directory.dispose()
  })
  const userHome = join(root, 'user')
  const cwd = join(root, 'workspace')
  const checkoutRoot = join(root, 'checkout')
  for (const path of [userHome, cwd, checkoutRoot]) mkdirSync(path)
  const request = { env: {}, homedir: userHome, cwd }
  return { root, userHome, cwd, checkoutRoot, request, cleanups, resolve: extra => resolveMapInstance({ ...request, ...extra }) }
}

function snapshot(root) {
  const rows = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    rows.push([entry.name, entry.isDirectory() ? snapshot(path) : entry.isSymbolicLink() ? 'link' : readFileSync(path).toString('hex')])
  }
  return rows
}

function failure(code) {
  return error => {
    assert.ok(error instanceof MapHomeError, error.stack)
    assert.equal(error.code, code)
    return true
  }
}

function putMarker(home, value) {
  writeFileSync(join(home, MAP_INSTANCE_MARKER), typeof value === 'string' ? value : JSON.stringify(value))
}

test('release, preview and source defaults are independent and resolution has no write effects', t => {
  const item = fixture(t)
  const before = snapshot(item.root)
  assert.equal(item.resolve().home, join(item.userHome, '.map-harness'))
  assert.equal(item.resolve({ distribution: 'managed' }).home, join(item.userHome, '.map-harness'))
  assert.equal(item.resolve({ channel: 'preview' }).home, join(item.userHome, '.map-harness-preview'))
  const source = item.resolve({ mode: 'source', checkoutRoot: item.checkoutRoot })
  assert.match(source.checkoutKey, /^[a-f0-9]{16}$/u)
  assert.equal(source.home, join(item.userHome, '.map-harness-dev', source.checkoutKey))
  assert.deepEqual(snapshot(item.root), before)
})

test('canonical checkout keys separate worktrees and preserve a checkout alias', t => {
  const item = fixture(t)
  const second = join(item.root, 'checkout-two')
  mkdirSync(second)
  const alias = join(item.root, 'checkout-alias')
  symlinkSync(item.checkoutRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const source = item.resolve({ mode: 'source', checkoutRoot: item.checkoutRoot })
  assert.equal(item.resolve({ mode: 'source', checkoutRoot: alias }).home, source.home)
  assert.notEqual(item.resolve({ mode: 'source', checkoutRoot: second }).home, source.home)
})

test('only a non-blank MAPHARNESS_HOME selects a root and legal path spaces survive', t => {
  const item = fixture(t)
  for (const value of [undefined, '', ' \t ']) {
    assert.equal(item.resolve({ env: { MAPHARNESS_HOME: value } }).home, join(item.userHome, '.map-harness'))
  }
  assert.equal(item.resolve({ env: { MAPHARNESS_HOME: './ Map 数据 ' } }).home, join(item.cwd, ' Map 数据 '))
  for (const value of ['~/Map 数据', '~\\Map 数据']) {
    assert.equal(item.resolve({ env: { MAPHARNESS_HOME: value } }).home, join(item.userHome, 'Map 数据'))
  }
  assert.throws(() => item.resolve({ env: { MAPHARNESS_HOME: '~' } }), failure('MAP_HOME_CONFLICT'))
})

test('poisoned ambient DSH paths select nothing, remain byte-identical, and never alter provider inputs', t => {
  const item = fixture(t)
  const stock = join(item.userHome, '.dsh')
  const agents = join(item.userHome, '.agents')
  const runtime = join(item.userHome, '.cache', 'deepseek-harness', 'resources')
  for (const path of [stock, agents, runtime]) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'sentinel'), 'untouched\n')
  }
  writeFileSync(join(stock, '.credentials.yaml'), 'do not read\n')
  const before = snapshot(item.userHome)
  const env = Object.freeze({
    DSH_HOME: stock, DSH_AGENTS_HOME: agents, DSH_RESOURCE_CACHE: runtime, PKG_NATIVE_CACHE_PATH: join(item.root, 'stock-pkg-cache'),
    DSH_BUNDLED_PRIMARY_RUNTIME: '/not-used', DSH_OFFICE_SIDECAR: join(item.root, 'old-office'),
    DEEPSEEK_API_KEY: 'fixture-key', HTTPS_PROXY: 'http://proxy.invalid',
    HOME: item.userHome, USERPROFILE: item.userHome,
  })
  const spec = item.resolve({ env })
  assert.equal(spec.home, join(item.userHome, '.map-harness'))
  assert.deepEqual(bridgeEnvironment(spec), {
    MAPHARNESS_HOME: spec.home, DSH_HOME: spec.home,
    DSH_AGENTS_HOME: join(spec.home, 'agents'), DSH_RESOURCE_CACHE: join(spec.home, 'cache', 'runtime'),
    PKG_NATIVE_CACHE_PATH: join(spec.home, 'cache', 'runtime'),
  })
  assert.equal(env.DEEPSEEK_API_KEY, 'fixture-key')
  assert.deepEqual(snapshot(item.userHome), before)
})

test('stock roots, custom DSH roots, installations and migration sources reject equality and both containment directions', t => {
  const item = fixture(t)
  const stock = join(item.userHome, '.dsh')
  const roots = [
    { path: stock, request: {} },
    { path: join(item.userHome, '.agents'), request: {} },
    { path: join(item.userHome, '.cache', 'deepseek-harness'), request: {} },
    { path: join(item.root, 'custom-dsh'), request: { dshRoots: [join(item.root, 'custom-dsh')] } },
    { path: join(item.root, 'installed'), request: { installRoots: [join(item.root, 'installed')] } },
    { path: join(item.root, 'legacy'), request: { migrationSource: join(item.root, 'legacy') } },
    { path: join(item.root, 'ambient'), request: { env: { DSH_HOME: join(item.root, 'ambient') } } },
  ]
  for (const row of roots) {
    for (const home of [row.path, join(row.path, 'map'), dirname(row.path)]) {
      const env = { ...row.request.env, MAPHARNESS_HOME: home }
      assert.throws(() => item.resolve({ ...row.request, env }), failure('MAP_HOME_CONFLICT'))
      assert.equal(existsSync(row.path), false)
    }
  }
  assert.equal(item.resolve({ env: { MAPHARNESS_HOME: `${stock}-map` } }).home, `${stock}-map`)
})

test('symlink and junction aliases and missing suffixes still collide with stock roots', t => {
  const item = fixture(t)
  const stock = join(item.userHome, '.dsh')
  mkdirSync(stock)
  const alias = join(item.root, 'stock-alias')
  symlinkSync(stock, alias, process.platform === 'win32' ? 'junction' : 'dir')
  for (const home of [alias, join(alias, 'not-created', 'map')]) {
    assert.throws(() => item.resolve({ env: { MAPHARNESS_HOME: home } }), failure('MAP_HOME_CONFLICT'))
  }
  assert.deepEqual(readdirSync(stock), [])
})

test('first preparation publishes a private marker and fixed agents/cache roots without profile or credentials', t => {
  const item = fixture(t)
  const spec = item.resolve()
  const prepared = prepareMapInstance(spec)
  const path = join(spec.home, MAP_INSTANCE_MARKER)
  const marker = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(prepared.created, true)
  assert.equal(marker.format, MAP_INSTANCE_FORMAT)
  assert.equal(marker.identityRevision, MAP_IDENTITY_REVISION)
  assert.equal(marker.productId, 'map-harness')
  assert.match(marker.instanceId, /^[a-f0-9-]{36}$/u)
  assert.equal(marker.instanceId, prepared.instanceId)
  assert.equal(marker.mode, 'release')
  assert.equal(marker.channel, 'stable')
  assert.equal(marker.checkoutKey, null)
  for (const path of [spec.agentsHome, spec.resourceCache]) assert.equal(statSync(path).isDirectory(), true)
  for (const name of ['profiles', '.credentials.yaml', '.env', 'sessions', 'storages']) assert.equal(existsSync(join(spec.home, name)), false)
  if (process.platform !== 'win32') {
    for (const path of [spec.home, spec.agentsHome, join(spec.home, 'cache'), spec.resourceCache]) assert.equal(statSync(path).mode & 0o777, 0o700)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  }
  assert.equal(readdirSync(item.userHome).some(name => name.startsWith('.map-instance-')), false)
  assert.equal(prepareMapInstance(spec).instanceId, marker.instanceId)
  assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true)
})

test('restarts and delivery-form changes retain identity and existing permissions', t => {
  const item = fixture(t)
  const first = prepareMapInstance(item.resolve())
  const path = join(first.home, MAP_INSTANCE_MARKER)
  const before = readFileSync(path)
  if (process.platform !== 'win32') chmodSync(first.home, 0o750)
  const second = prepareMapInstance(item.resolve({ distribution: 'managed' }))
  assert.equal(second.created, false)
  assert.equal(second.instanceId, first.instanceId)
  assert.deepEqual(readFileSync(path), before)
  if (process.platform !== 'win32') assert.equal(statSync(first.home).mode & 0o777, 0o750)
})

test('read-only instance inspection never initializes a missing home or changes existing files', t => {
  const item = fixture(t)
  const spec = item.resolve()
  const before = snapshot(item.root)
  assert.equal(readMapInstance(spec), undefined)
  assert.deepEqual(snapshot(item.root), before)
  const created = prepareMapInstance(spec)
  const admitted = snapshot(item.root)
  assert.equal(readMapInstance(spec).instanceId, created.instanceId)
  assert.deepEqual(snapshot(item.root), admitted)
})

test('non-empty unmarked homes remain untouched and empty existing homes can be admitted', t => {
  const item = fixture(t)
  const spec = item.resolve()
  mkdirSync(spec.home)
  writeFileSync(join(spec.home, 'settings.yaml'), 'legacy: keep\n')
  const before = snapshot(item.root)
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_UNCLAIMED'))
  assert.deepEqual(snapshot(item.root), before)
  rmSync(join(spec.home, 'settings.yaml'))
  assert.equal(prepareMapInstance(spec).created, true)
})

test('corrupt, foreign, unsupported or incomplete markers stop admission without mutation', t => {
  const item = fixture(t)
  const spec = item.resolve()
  const { marker } = prepareMapInstance(spec)
  const invalid = [
    '{fixture-secret', 'null', '[]', {}, { ...marker, productId: 'deepseek-harness' },
    { ...marker, format: 'map-harness-instance-999' }, { ...marker, identityRevision: 999 },
    { ...marker, identityRevision: undefined }, { ...marker, identityRevision: 0 },
    { ...marker, instanceId: '' }, { ...marker, instanceId: '../outside' },
    { ...marker, mode: 'unknown' }, { ...marker, channel: 'unknown' },
    { ...marker, checkoutKey: 'unexpected' }, { ...marker, createdAt: 'unknown' },
  ]
  for (const candidate of invalid) {
    putMarker(spec.home, candidate)
    const before = snapshot(spec.home)
    assert.throws(() => prepareMapInstance(spec), error => {
      failure('MAP_HOME_MARKER_INVALID')(error)
      assert.doesNotMatch(inspect(error), /fixture-secret/u)
      return true
    })
    assert.deepEqual(snapshot(spec.home), before)
  }
})

test('channel, source/release and checkout ownership mismatches stop before writes', t => {
  const item = fixture(t)
  const spec = item.resolve()
  prepareMapInstance(spec)
  const env = { MAPHARNESS_HOME: spec.home }
  const before = snapshot(spec.home)
  for (const extra of [{ channel: 'preview' }, { mode: 'source', checkoutRoot: item.checkoutRoot }]) {
    assert.throws(() => prepareMapInstance(item.resolve({ ...extra, env })), failure('MAP_HOME_CONFLICT'))
  }
  assert.deepEqual(snapshot(spec.home), before)
  const sourceHome = join(item.root, 'source-home')
  const source = item.resolve({ mode: 'source', checkoutRoot: item.checkoutRoot, env: { MAPHARNESS_HOME: sourceHome } })
  prepareMapInstance(source)
  const other = join(item.root, 'other-checkout')
  mkdirSync(other)
  assert.throws(() => prepareMapInstance(item.resolve({ mode: 'source', checkoutRoot: other, env: { MAPHARNESS_HOME: sourceHome } })), failure('MAP_HOME_CONFLICT'))
})

test('path errors and files used as roots or parents are structured and create no marker', t => {
  const item = fixture(t)
  const file = join(item.root, 'file')
  writeFileSync(file, 'preserve\n')
  for (const path of [file, join(file, 'child')]) {
    assert.throws(() => prepareMapInstance(item.resolve({ env: { MAPHARNESS_HOME: path } })), failure('MAP_HOME_PATH'))
  }
  assert.equal(readFileSync(file, 'utf8'), 'preserve\n')
})

test('retargeting an ancestor after resolution cannot redirect writes into stock data', t => {
  const item = fixture(t)
  const parent = join(item.root, 'parent')
  mkdirSync(parent)
  const spec = item.resolve({ env: { MAPHARNESS_HOME: join(parent, 'new-map') } })
  rmSync(parent, { recursive: true })
  const stock = join(item.userHome, '.dsh')
  mkdirSync(stock)
  symlinkSync(stock, parent, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_CONFLICT'))
  assert.deepEqual(readdirSync(stock), [])
})

test('symlinked agents or cache cannot escape a valid instance', t => {
  const item = fixture(t)
  const spec = item.resolve()
  const first = prepareMapInstance(spec)
  const outside = join(item.root, 'outside')
  mkdirSync(outside)
  for (const path of [spec.agentsHome, spec.resourceCache]) {
    rmSync(path, { recursive: true })
    symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_CONFLICT'))
    assert.equal(JSON.parse(readFileSync(join(spec.home, MAP_INSTANCE_MARKER))).instanceId, first.instanceId)
    unlinkSync(path)
    mkdirSync(path)
  }
  assert.deepEqual(readdirSync(outside), [])
})

test('a retained first-use reservation never implies permission to adopt an unmarked home', t => {
  const item = fixture(t)
  const spec = item.resolve()
  mkdirSync(join(spec.home, '.map-initialize'), { recursive: true })
  writeFileSync(join(spec.home, '.map-initialize', 'marker.json'), 'partial identity bytes')
  const before = snapshot(spec.home)
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_INITIALIZING'))
  assert.deepEqual(snapshot(spec.home), before)
})

test('marker directories and linked markers are rejected before reading their contents', t => {
  const item = fixture(t)
  const spec = item.resolve()
  mkdirSync(spec.home)
  const markerPath = join(spec.home, MAP_INSTANCE_MARKER)
  mkdirSync(markerPath)
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_MARKER_INVALID'))
  rmSync(markerPath, { recursive: true })
  const target = join(item.root, 'external')
  mkdirSync(target)
  symlinkSync(target, markerPath, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_MARKER_INVALID'))
  assert.deepEqual(readdirSync(target), [])
})

test('a retargeted non-stock ancestor requires resolution again and writes nowhere', t => {
  const item = fixture(t)
  const parent = join(item.root, 'parent')
  const outside = join(item.root, 'outside')
  mkdirSync(parent)
  mkdirSync(outside)
  const spec = item.resolve({ env: { MAPHARNESS_HOME: join(parent, 'map') } })
  rmSync(parent, { recursive: true })
  symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_CONFLICT'))
  assert.deepEqual(readdirSync(outside), [])
})

test('invalid build identities fail during resolution rather than choosing a fallback', t => {
  const item = fixture(t)
  for (const request of [{ mode: 'unknown' }, { channel: 'unknown' }, { distribution: 'unknown' }, { mode: 'source' }]) {
    assert.throws(() => item.resolve(request), failure('MAP_HOME_INPUT'))
  }
})

test('publication I/O faults report commit and cleanup state without replacing user data', async t => {
  for (const operation of ['openSync', 'writeFileSync', 'fsyncSync', 'linkSync', 'unlinkSync']) {
    await t.test(operation, subtest => {
      const item = fixture(subtest)
      const module = pathToFileURL(join(import.meta.dirname, '../bin/instance-home.mjs')).href
      const program = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const operation = ${JSON.stringify(operation)};
        const original = fs[operation];
        let injected = false;
        fs[operation] = (...args) => {
          const markerOperation = operation === 'fsyncSync' || operation === 'writeFileSync'
            || String(args[0]).includes('.map-initialize');
          if (markerOperation && !injected) {
            injected = true;
            const error = new Error('fixture I/O failure');
            error.code = 'EIO';
            throw error;
          }
          return original(...args);
        };
        syncBuiltinESMExports();
        const { resolveMapInstance, prepareMapInstance } = await import(${JSON.stringify(module)});
        try { prepareMapInstance(resolveMapInstance(${JSON.stringify(item.request)})); }
        catch (error) { console.log(JSON.stringify({ code: error.code, details: error.details, injected })); }
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
      const observed = JSON.parse(result.stdout)
      assert.equal(observed.injected, true)
      assert.equal(observed.code, 'MAP_HOME_IO')
      const spec = item.resolve()
      const markerPath = join(spec.home, MAP_INSTANCE_MARKER)
      if (operation === 'unlinkSync') {
        assert.equal(observed.details.markerPresent, true)
        assert.equal(observed.details.cleanupPending, true)
        const original = readFileSync(markerPath)
        assert.equal(prepareMapInstance(spec).created, false)
        assert.deepEqual(readFileSync(markerPath), original)
      } else {
        assert.equal(observed.details.markerPresent, false)
        assert.deepEqual(readdirSync(spec.home), [])
        assert.equal(prepareMapInstance(spec).created, true)
      }
    })
  }
})

test('a competitor at the marker commit point sees initialization, then the same identity on retry', { timeout: 30000 }, async t => {
  const item = fixture(t)
  const module = pathToFileURL(join(import.meta.dirname, '../bin/instance-home.mjs')).href
  const spec = item.resolve()
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      process.send('before-publication');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      return link(...args);
    };
    syncBuiltinESMExports();
    const { resolveMapInstance, prepareMapInstance } = await import(${JSON.stringify(module)});
    const prepared = prepareMapInstance(resolveMapInstance(${JSON.stringify(item.request)}));
    process.send({ instanceId: prepared.instanceId });
    process.disconnect();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'ignore', 'pipe', 'ipc'] })
  const closed = once(child, 'close')
  item.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  })
  const [ready] = await once(child, 'message')
  assert.equal(ready, 'before-publication')
  const before = snapshot(spec.home)
  assert.throws(() => prepareMapInstance(spec), failure('MAP_HOME_INITIALIZING'))
  assert.deepEqual(snapshot(spec.home), before)
  const result = once(child, 'message')
  child.stdin.end('x')
  const [winner] = await result
  const [code, signal] = await closed
  assert.equal(signal, null)
  assert.equal(code, 0)
  assert.equal(prepareMapInstance(spec).instanceId, winner.instanceId)
  assert.equal(existsSync(join(spec.home, '.map-initialize')), false)
})

test('simultaneous first starts publish one identity and contention never takes over', { timeout: 30000 }, async t => {
  const item = fixture(t)
  const module = pathToFileURL(join(import.meta.dirname, '../bin/instance-home.mjs')).href
  const request = JSON.stringify(item.request)
  const program = `
    import { resolveMapInstance, prepareMapInstance } from ${JSON.stringify(module)};
    const spec = resolveMapInstance(${request});
    process.send('ready');
    process.once('message', () => {
      try { process.send({ instanceId: prepareMapInstance(spec).instanceId }); }
      catch (error) { process.send({ code: error.code, message: error.message }); }
      process.disconnect();
    });
  `
  const children = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: item.root, TEMP: item.root },
    })
    const exit = once(child, 'close')
    item.cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exit
    })
    return { child, exit, ready: once(child, 'message') }
  })
  await Promise.all(children.map(async ({ ready }) => assert.deepEqual(await ready, ['ready', undefined])))
  const replies = children.map(({ child }) => once(child, 'message'))
  for (const { child } of children) child.send('go')
  const results = await Promise.all(replies)
  for (const { exit } of children) {
    const [code, signal] = await exit
    assert.equal(signal, null)
    assert.equal(code, 0)
  }
  const ids = results.map(([row]) => row.instanceId).filter(Boolean)
  assert.ok(ids.length > 0, JSON.stringify(results))
  for (const [row] of results) {
    if (row.instanceId === undefined) assert.equal(row.code, 'MAP_HOME_INITIALIZING', JSON.stringify(row))
  }
  assert.equal(new Set(ids).size, 1)
  const prepared = prepareMapInstance(item.resolve())
  assert.equal(prepared.instanceId, ids[0])
  assert.equal(lstatSync(join(prepared.home, MAP_INSTANCE_MARKER)).nlink, 1)
  assert.equal(readdirSync(item.userHome).some(name => name.startsWith('.map-instance-')), false)
})
