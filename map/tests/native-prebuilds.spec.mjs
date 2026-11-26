/** Native setup uses the target runtime, pinned artifacts, and no source-tree state. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { installNativePrebuild, materializeNativePrebuild, resolveNativePrebuild } from '../bin/native-prebuilds.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const name = '@deepseek-ai/node-addon-system-darwin-arm64'
const version = '9.9.9'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-native-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceBinary = join(repo, 'native/system/packages/darwin-arm64/bin/system.node')
  const sourceBefore = existsSync(sourceBinary) ? hash(readFileSync(sourceBinary)) : null
  t.after(() => assert.equal(existsSync(sourceBinary) ? hash(readFileSync(sourceBinary)) : null, sourceBefore))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
  }
  const bytes = Buffer.from('native-prebuild-fixture')
  const binaries = [{ path: 'bin/system.node', sha256: hash(bytes), executable: false }]
  const prebuilds = { platform: 'darwin-arm64', binaries: [{ tool: 'flock', kind: 'node-api', path: 'bin/system.node', napi: 8 }] }
  put('payload/package/package.json', { name, version })
  put('payload/package/prebuilds.json', prebuilds)
  put('payload/package/bin/system.node', bytes)
  const packed = join(root, 'fixture.tgz')
  const tar = spawnSync('tar', ['-czf', packed, '-C', join(root, 'payload'), 'package'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const archive = readFileSync(packed)
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
  const pins = { formatVersion: 1, version, packages: { 'darwin-arm64': { name, integrity, binaries } } }
  put('npm-user.conf', '')
  put('npm-global.conf', '')
  put('map/release/native-prebuilds.json', pins)
  put('native/system/packages/darwin-arm64/package.json', { name, version })
  put('native/system/packages/darwin-arm64/prebuilds.json', prebuilds)
  put('native/system/packages/entry/package.json', { name: '@deepseek-ai/node-addon-system', version, type: 'module' })
  put('native/system/packages/entry/lib/flock.js', `import fs from 'node:fs'; export async function tryLockExclusive(fd) { await Promise.resolve(); fs.fstatSync(fd); fs.writeFileSync(${JSON.stringify(join(root, 'probe-ok'))}, 'ok'); }`)
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key))),
    npm_config_userconfig: join(root, 'npm-user.conf'), npm_config_globalconfig: join(root, 'npm-global.conf'),
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  return { root, put, pins, archive, bytes, environment, target: join(root, 'native/system/packages/darwin-arm64/bin/system.node') }
}

test('resolution uses the target metadata, skips Windows, and rejects version drift', t => {
  const env = fixture(t)
  const spec = resolveNativePrebuild(env.root, 'darwin', 'arm64')
  assert.equal(spec.name, name)
  assert.equal(spec.version, version)
  assert.equal(resolveNativePrebuild(env.root, 'win32', 'x64'), undefined)
  assert.throws(() => resolveNativePrebuild(env.root, 'linux', 'riscv64'), error => error.code === 'UNSUPPORTED_PLATFORM')
  env.put('native/system/packages/entry/package.json', { name: '@deepseek-ai/node-addon-system', version: '0.0.1', type: 'module' })
  assert.throws(() => resolveNativePrebuild(env.root, 'darwin', 'arm64'), error => error.code === 'INVALID_METADATA')
})

test('release pins cover every bundled POSIX platform without requiring a source build', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const arch of ['arm64', 'x64']) {
      const spec = resolveNativePrebuild(repo, platform, arch)
      assert.equal(spec.binaries.length, platform === 'linux' ? 3 : 1)
      assert.equal(spec.binaries.filter(binary => binary.executable).length, platform === 'linux' ? 1 : 0)
    }
  }
})

test('materialization verifies all bytes before writing only the target package', t => {
  const env = fixture(t)
  materializeNativePrebuild(resolveNativePrebuild(env.root, 'darwin', 'arm64'), env.archive)
  assert.deepEqual(readFileSync(env.target), env.bytes)
})

test('archive and binary checksum failures leave no installed binary', t => {
  const env = fixture(t)
  const spec = resolveNativePrebuild(env.root, 'darwin', 'arm64')
  assert.throws(() => materializeNativePrebuild(spec, Buffer.from('changed archive')), error => error.code === 'INTEGRITY_MISMATCH')
  assert.equal(existsSync(env.target), false)
  env.pins.packages['darwin-arm64'].binaries[0].sha256 = '0'.repeat(64)
  env.put('map/release/native-prebuilds.json', env.pins)
  assert.throws(() => materializeNativePrebuild(resolveNativePrebuild(env.root, 'darwin', 'arm64'), env.archive), error => error.code === 'INTEGRITY_MISMATCH')
  assert.equal(existsSync(env.target), false)
})

test('a pre-existing binary-directory symlink cannot change an outside sentinel', t => {
  const env = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'map-native-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const sentinel = join(outside, 'system.node')
  writeFileSync(sentinel, 'unchanged')
  symlinkSync(outside, dirname(env.target), 'junction')
  assert.throws(() => materializeNativePrebuild(resolveNativePrebuild(env.root, 'darwin', 'arm64'), env.archive), error => error.code === 'UNSAFE_PATH')
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged')
})

test('a dangling binary symlink is rejected without creating its outside target', t => {
  const env = fixture(t)
  const outside = join(env.root, 'outside-missing')
  mkdirSync(dirname(env.target), { recursive: true })
  symlinkSync(outside, env.target, process.platform === 'win32' ? 'junction' : 'file')
  assert.throws(() => materializeNativePrebuild(resolveNativePrebuild(env.root, 'darwin', 'arm64'), env.archive), error => error.code === 'UNSAFE_PATH')
  assert.equal(existsSync(outside), false)
})

test('cached verified bytes still run the lock probe without a registry request', async t => {
  const env = fixture(t)
  const spec = resolveNativePrebuild(env.root, 'darwin', 'arm64')
  materializeNativePrebuild(spec, env.archive)
  await installNativePrebuild(spec, 'http://127.0.0.1:1', env.environment)
  assert.equal(readFileSync(join(env.root, 'probe-ok'), 'utf8'), 'ok')
})

test('a failed lock probe refuses an otherwise complete native installation', async t => {
  const env = fixture(t)
  const spec = resolveNativePrebuild(env.root, 'darwin', 'arm64')
  materializeNativePrebuild(spec, env.archive)
  env.put('native/system/packages/entry/lib/flock.js', 'export async function tryLockExclusive() { throw new Error("fixture rejected"); }')
  await assert.rejects(installNativePrebuild(spec, 'http://127.0.0.1:1', env.environment), error => error.code === 'BINDING_UNAVAILABLE' && !error.message.includes(env.root))
})

test('installation downloads a pinned prebuild from a local npm registry and probes it', { timeout: 30_000 }, async t => {
  const env = fixture(t)
  let requests = 0
  let address
  const server = createServer((request, response) => {
    requests += 1
    if (request.url.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(env.archive)
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { name, version, dist: { tarball: address + '/fixture.tgz', integrity: env.pins.packages['darwin-arm64'].integrity } } } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  address = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => server.close(resolve)))
  await installNativePrebuild(resolveNativePrebuild(env.root, 'darwin', 'arm64'), address, env.environment)
  assert.ok(requests >= 2)
  assert.deepEqual(readFileSync(env.target), env.bytes)
  assert.equal(readFileSync(join(env.root, 'probe-ok'), 'utf8'), 'ok')
})
