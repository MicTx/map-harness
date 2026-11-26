/** Actual V8 core compilation, sealed standalone bootstrap, and source-omission gates. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, realpathSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { auditApplicationCore, auditApplicationSeal, compileApplicationCore, compileOnboarding } from '../bin/application-core.mjs'
import { APPLICATION_LAUNCH_HELPERS, stageApplicationHelpers } from '../bin/application-helpers.mjs'
import { createInstallDescriptor, readDataCompatibility } from '../bin/install-manifest.mjs'
import { prepareMapInstance, readMapInstance } from '../bin/instance-home.mjs'
import { resolveMapEntry, mapEntryEnvironment } from '../bin/instance-preload.mjs'
import { isDependencyRuntimeSource, isDevelopmentFile } from '../bin/release-content.mjs'
import { packApplications } from '../bin/application-assets.mjs'
import { sealApplication } from '../bin/application-sea.mjs'

const repo = realpathSync(join(import.meta.dirname, '../..'))
const toolRequire = createRequire(new URL('../tools/package.json', import.meta.url))
const runtimeRequire = createRequire(new URL('../application-runtime/package.json', import.meta.url))
const FIXTURE_VERSION = '9.9.9-fixture.1'
const installDescriptor = createInstallDescriptor({ distribution: 'portable', channel: 'stable', dataCompatibility: await readDataCompatibility(repo) })

/** OS home, data home, program stage, and native output have disjoint owned roots. */
function fixture(t) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'map-application-test-')))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'program'), user = join(temporary, 'user'), data = join(temporary, 'data')
  mkdirSync(user)
  const dir = join(root, 'node_modules/@map-harness/spatial-scale')
  mkdirSync(join(dir, 'lib/types'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"@map-harness/spatial-scale","type":"module","main":"lib/types/worker.js"}\n')
  const file = join(dir, 'lib/types/worker.js')
  const program = "process.stdin.resume();process.stdin.on('end',()=>console.log('compiled-worker-ran'))"
  writeFileSync(join(dir, 'lib/types/lazy.js'), "throw new Error('lazy branch executed');export const value=3;\n")
  writeFileSync(join(dir, 'lib/types/unused.js'), "throw new Error('unused implementation executed');export const value=4;\n")
  writeFileSync(file, `const WORKER_ENTRY_SOURCE=${JSON.stringify(program)};export const SCALE_WORKER_ENTRY=WORKER_ENTRY_SOURCE;export function calculate(x){const coefficient=7;return x*coefficient}export async function platform(){return (await import('node:os')).platform()}export function location(){return import.meta.url}export async function lazy(){return import('./lazy.js')}\n`)
  cpSync(dirname(toolRequire.resolve('bytenode/package.json')), join(root, 'node_modules/bytenode'), { recursive: true, dereference: true })
  return { temporary, root, user, data, file }
}

/** The deployed payload materializes the same native flock dependency as the application. */
function stageBootstrap(program) {
  copyFileSync(join(repo, 'map/bin/application-bootstrap.mjs'), join(program, 'application.mjs'))
  stageApplicationHelpers(repo, program)
  writeFileSync(join(program, 'dsh-runtime-bootstrap.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const modules = join(program, 'node_modules')
  const nativeName = '@deepseek-ai/node-addon-system'
  const flockEntry = dirname(runtimeRequire.resolve(`${nativeName}/package.json`))
  mkdirSync(join(modules, nativeName), { recursive: true })
  cpSync(join(flockEntry, 'package.json'), join(modules, nativeName, 'package.json'))
  cpSync(join(flockEntry, 'lib'), join(modules, nativeName, 'lib'), { recursive: true, dereference: true })
  if (process.platform === 'win32') cpSync(dirname(runtimeRequire.resolve('koffi')), join(modules, 'koffi'), { recursive: true, dereference: true })
  else {
    const nativeRequire = createRequire(join(flockEntry, 'package.json'))
    const nativeBinary = `${nativeName}-${process.platform}-${process.arch}`
    const binaryRoot = dirname(nativeRequire.resolve(`${nativeBinary}/package.json`))
    mkdirSync(join(modules, nativeBinary), { recursive: true })
    cpSync(join(binaryRoot, 'package.json'), join(modules, nativeBinary, 'package.json'))
    cpSync(join(binaryRoot, 'bin'), join(modules, nativeBinary, 'bin'), { recursive: true, dereference: true })
  }
  // argv-emulated Windows runs resolve the ACL runner subpath even on POSIX hosts.
  const aclName = '@deepseek-ai/dsh-sandbox-windows-acl'
  const aclRoot = join(repo, 'packages/sandbox/sandbox-windows-acl')
  mkdirSync(join(modules, aclName), { recursive: true })
  copyFileSync(join(aclRoot, 'package.json'), join(modules, aclName, 'package.json'))
  mkdirSync(join(modules, aclName, 'lib'), { recursive: true })
  copyFileSync(join(aclRoot, 'lib/runner.js'), join(modules, aclName, 'lib/runner.js'))
  mkdirSync(join(program, 'map-presets'), { recursive: true })
  for (const file of ['preset.yml', 'agent.cordis.yml']) copyFileSync(join(repo, 'map/presets/map-analyst', file), join(program, 'map-presets', file))
}

function applicationRecord(manifest) {
  return JSON.stringify({ ...manifest, version: FIXTURE_VERSION, install: installDescriptor }, null, 2) + '\n'
}

/** Keep runtime and credential variables from the host out of subprocess fixtures. */
function fixtureEnvironment(user, data, extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^DSH_|^MAPHARNESS_|^NODE_|^PKG_|(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key)) delete env[key]
  }
  return { ...env, HOME: user, USERPROFILE: user, MAPHARNESS_HOME: data, ...extra }
}

function completed(result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.error, undefined, `${result.error?.message ?? ''}\n${output}`)
  assert.equal(result.signal, null, output)
  assert.notEqual(result.status, null, output)
  return result
}

function execute(program, user, data, args, input, extraEnv = {}) {
  return completed(spawnSync(process.execPath, args, {
    cwd: program, encoding: 'utf8', input, env: fixtureEnvironment(user, data, extraEnv), timeout: 30000,
  }))
}

/** Admit the fixture data home and produce the exact child environment the launcher would set. */
function admittedEnvironment(program, user, data) {
  const entry = resolveMapEntry({ programRoot: program, homedir: user, cwd: program,
    identity: { mode: 'release', channel: 'stable', distribution: 'portable' },
    env: fixtureEnvironment(user, data) })
  entry.spec = prepareMapInstance(entry.spec)
  return { environment: mapEntryEnvironment(entry, program), instanceId: entry.spec.instanceId }
}

test('real core bytecode executes after implementation JS is replaced by its interface facade', async t => {
  const { root, user, data, file } = fixture(t)
  const manifest = await compileApplicationCore(root)
  auditApplicationCore(root, manifest)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /coefficient|function calculate/u)
  const result = execute(root, user, data, ['--input-type=module', '--eval', "const m=await import('./node_modules/@map-harness/spatial-scale/lib/types/worker.js');console.log(JSON.stringify({value:m.calculate(3),platform:await m.platform(),location:m.location()}))"])
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.value, 21)
  assert.equal(value.platform, process.platform)
  assert.match(value.location, /worker\.jsc$/u)
  assert.equal(manifest.coreModules, 2)
  const lazy = execute(root, user, data, ['--input-type=module', '--eval', "const m=await import('./node_modules/@map-harness/spatial-scale/lib/types/worker.js');await m.lazy()"])
  assert.notEqual(lazy.status, 0)
  assert.match(lazy.stderr, /lazy branch executed/u)
  assert.doesNotMatch(lazy.stderr, /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/u)
})

test('compiled onboarding runs its SEA entry exports under the target engine', async t => {
  const { root, user, data } = fixture(t)
  stageApplicationHelpers(repo, root)
  const compiled = await compileOnboarding(root, join(root, 'web-onboarding.mjs'))
  assert.match(readFileSync(compiled.compiled, 'utf8'), /module\.exports=worker\.exports/u)
  assert.equal(existsSync(join(root, 'web-onboarding.mjs')), false)
  const script = "const assert=require('node:assert/strict');const m=require('./web-onboarding.cjs');assert.equal(typeof m.mainWebOnboarding,'function');assert.rejects(()=>m.mainWebOnboarding(['--invalid-command']),/Unknown Web onboarding command/).then(()=>console.log('onboarding-entry-ok'))"
  const result = execute(root, user, data, ['--eval', script])
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'onboarding-entry-ok')
})

test('compiled map application resolves and runs its fixed Wayback worker from the public artifact closure', async t => {
  const { root, user, data } = fixture(t)
  const packageRoot = join(root, 'node_modules/@map-harness/map-container')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  const built = join(repo, 'map/map-container/lib/')
  copyFileSync(join(built, 'wayback-worker.js'), join(packageRoot, 'lib/wayback-worker.js'))
  const original = JSON.parse(readFileSync(join(repo, 'map/map-container/package.json'), 'utf8'))
  // This fixture exercises only the public worker subpath; the separate test compiles the full plugin entry.
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: original.name, type: original.type,
    exports: { './wayback-worker': original.exports['./wayback-worker'] } }))
  const official = join(root, 'node_modules/@esri/wayback-core')
  mkdirSync(dirname(official), { recursive: true })
  cpSync(realpathSync(join(repo, 'map/map-container/node_modules/@esri/wayback-core')), official, { recursive: true })
  const sharpRequire = createRequire(join(repo, 'map/map-container/package.json'))
  const sharpRoot = dirname(dirname(sharpRequire.resolve('sharp')))
  cpSync(sharpRoot, join(root, 'node_modules/sharp'), { recursive: true })
  const sharpModuleRequire = createRequire(join(sharpRoot, 'package.json'))
  for (const name of Object.keys(JSON.parse(readFileSync(join(sharpRoot, 'package.json'), 'utf8')).dependencies)) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(dirname(sharpModuleRequire.resolve(`${name}/package.json`)), destination, { recursive: true })
  }
  const sharpPlatform = process.platform === 'linux' && sharpModuleRequire('detect-libc').isNonGlibcLinuxSync()
    ? 'linuxmusl' : process.platform
  const sharpNative = `@img/sharp-${sharpPlatform}-${process.arch}`
  const sharpLibvips = `@img/sharp-libvips-${sharpPlatform}-${process.arch}`
  const binaries = [[sharpNative, `${sharpNative}/sharp.node`]]
  if (process.platform !== 'win32') binaries.push([sharpLibvips, `${sharpLibvips}/versions`])
  for (const [name, entry] of binaries) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(dirname(sharpModuleRequire.resolve(entry)), destination, { recursive: true })
  }
  const manifest = await compileApplicationCore(root)
  auditApplicationCore(root, manifest)
  const program = `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(require.resolve('@map-harness/map-container/wayback-worker'), { execArgv: [] });
    let timer;
    try {
      const message = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Wayback worker response timed out')), 20000);
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => reject(new Error('Wayback worker exited before its response: ' + code)));
        worker.postMessage({kind:'call',id:1,operation:'not-a-real-operation'});
      });
      console.log(JSON.stringify(message));
    } finally { clearTimeout(timer); await worker.terminate() }
  `
  const result = execute(root, user, data, ['--input-type=module', '--eval', program])
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { kind: 'result', id: 1, error: 'official Wayback operation failed' })
})

test('the full built map plugin entry compiles without late upstream ESM requires', async t => {
  const { root } = fixture(t)
  const packageRoot = join(root, 'node_modules/@map-harness/map-container')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  copyFileSync(join(repo, 'map/map-container/lib/index.js'), join(packageRoot, 'lib/index.js'))
  const original = JSON.parse(readFileSync(join(repo, 'map/map-container/package.json'), 'utf8'))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: original.name, type: original.type,
    main: original.main, exports: { '.': original.exports['.'] } }))
  const mapRequire = createRequire(join(repo, 'map/map-container/package.json'))
  const credentials = dirname(mapRequire.resolve('@deepseek-ai/dsh-credentials/package.json'))
  const destination = join(root, 'node_modules/@deepseek-ai/dsh-credentials')
  mkdirSync(join(destination, 'lib'), { recursive: true })
  copyFileSync(join(credentials, 'package.json'), join(destination, 'package.json'))
  copyFileSync(join(credentials, 'lib/index.js'), join(destination, 'lib/index.js'))
  // Compilation consumes the actual plugin artifact; the worker case separately loads its runtime closure.
  const manifest = await compileApplicationCore(root)
  auditApplicationCore(root, manifest)
  const facade = 'node_modules/@map-harness/map-container/lib/index.js'
  assert.ok(Object.hasOwn(manifest.facades, facade))
  assert.ok(Object.hasOwn(manifest.binaries, facade.replace(/\.js$/u, '.jsc')))
  assert.equal(manifest.coreModules, 3)
})

test('the application scan rejects an extra map source copy outside the compiled package root', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  const nested = join(root, 'node_modules/other/node_modules/@map-harness/spatial-scale/lib')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'index.js'), 'export function secretAlgorithm(){return 42}\n')
  assert.throws(() => auditApplicationCore(root, manifest), /Nested map package|Editable map implementation/u)
})

test('compiled map facades reject requires of upstream ESM packages', async t => {
  const { root } = fixture(t)
  const upstream = join(root, 'node_modules/@deepseek-ai/dsh-example')
  mkdirSync(join(upstream, 'lib'), { recursive: true })
  writeFileSync(join(upstream, 'package.json'), '{"name":"@deepseek-ai/dsh-example","type":"module","main":"lib/index.js"}\n')
  writeFileSync(join(upstream, 'lib/index.js'), 'export const value=1\n')
  const mapPackage = join(root, 'node_modules/@map-harness/example')
  mkdirSync(join(mapPackage, 'lib'), { recursive: true })
  writeFileSync(join(mapPackage, 'package.json'), '{"name":"@map-harness/example","main":"lib/index.js"}\n')
  writeFileSync(join(mapPackage, 'lib/index.js'), "import { value } from '@deepseek-ai/dsh-example'\nexport const answer = value\n")
  await assert.rejects(compileApplicationCore(root), /requires ESM package @deepseek-ai\/dsh-example/u)
})

test('the final seal inventory rejects source paths and unregistered map loaders', async t => {
  const { root, file } = fixture(t)
  const manifest = await compileApplicationCore(root)
  const brand = join(root, 'node_modules/@map-harness/client-ui-brand/lib')
  mkdirSync(brand, { recursive: true })
  writeFileSync(join(brand, '..', 'package.json'), '{"name":"@map-harness/client-ui-brand","main":"lib/client.js","dsh":{"client":{"platform":"web"}}}\n')
  writeFileSync(join(brand, 'client.js'), "export const value='browser-runtime'\n")
  assert.doesNotThrow(() => auditApplicationSeal(root, ['application.mjs'], manifest))
  assert.doesNotThrow(() => auditApplicationSeal(root, ['node_modules/@map-harness/client-ui-brand/lib/client.js'], manifest))
  assert.throws(() => auditApplicationSeal(root, ['src/index.ts'], manifest), /development source/u)
  assert.equal(isDevelopmentFile('node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/sources/core-changes.patch'), true)
  assert.equal(isDependencyRuntimeSource('node_modules/@opentelemetry/api-logs/build/src/NoopLogger.js'), true)
  assert.doesNotThrow(() => auditApplicationSeal(root, ['node_modules/@opentelemetry/api-logs/build/src/NoopLogger.js'], manifest))
  assert.throws(() => auditApplicationSeal(root, ['debug/core.js.map'], manifest), /development source/u)
  assert.throws(() => auditApplicationSeal(root, ['node_modules/@map-harness/extra/lib/index.js'], manifest), /unregistered map loader/u)
  assert.doesNotThrow(() => auditApplicationSeal(root, ['node_modules/@map-harness/spatial-scale/lib/types/worker.js'], manifest))
  writeFileSync(file, 'export function editable(){return 1}\n')
  assert.throws(() => auditApplicationSeal(root, ['node_modules/@map-harness/spatial-scale/lib/types/worker.js'], manifest), /editable map loader/u)
})

test('engine mismatch and changed facades reject before loading core bytecode or any data home', async t => {
  const { root, user, data, file } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord(manifest))
  const info = execute(root, user, data, ['application.mjs', '--application-info'])
  assert.equal(info.status, 0, info.stderr)
  assert.equal(JSON.parse(info.stdout).version, FIXTURE_VERSION)
  writeFileSync(file, readFileSync(file, 'utf8') + '\nmodule.exports.secret=1;\n')
  assert.throws(() => auditApplicationCore(root, manifest), /Editable map implementation/u)
  const changed = execute(root, user, data, ['application.mjs', '--application-info'])
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /compiled map core is incomplete or changed/u)
  writeFileSync(join(root, 'map-application.json'), applicationRecord({ ...manifest, node: 'v0.0.0' }))
  const mismatch = execute(root, user, data, ['application.mjs', '--application-info'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /engine does not match/u)
  assert.equal(existsSync(join(data, 'map-instance.json')), false, 'rejections never admit a data home')
  assert.equal(existsSync(join(data, 'profiles')), false)
  assert.equal(existsSync(join(data, 'agents')), false)
})

test('the sealed program materializes real launch helpers and fails without them', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord(manifest))
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const name of APPLICATION_LAUNCH_HELPERS) {
    const staged = join(root, name)
    assert.equal(statSync(staged).isFile(), true, `${name} is a regular file`)
    assert.equal(digest(staged), digest(join(repo, 'map/bin', name)), `${name} copies its checkout bytes`)
  }
  rmSync(join(root, 'instance-lock.mjs'))
  const result = execute(root, user, data, ['application.mjs', '--version'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /instance-lock\.mjs/u)
})

test('the fixed compiled worker runs only with a validated instance context', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord(manifest))
  const admitted = admittedEnvironment(root, user, data)
  const good = execute(root, user, data, ['application.mjs', '--map-harness-internal-worker'], '', admitted.environment)
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.trim(), 'compiled-worker-ran')
  assert.equal(existsSync(join(data, 'map-instance.json')), true, 'the marker belongs to the separate data home')
  assert.equal(existsSync(join(data, 'agents')), true)
  assert.equal(existsSync(join(data, 'cache/runtime')), true)
  assert.equal(existsSync(join(data, 'profiles')), false, 'internal workers never write profiles')
  assert.equal(existsSync(join(data, 'map-run')), false, 'internal workers never take the writer lock')
  const scriptPath = execute(root, user, data, ['application.mjs', '--map-harness-internal-worker', '/tmp/arbitrary-script.js'], '', admitted.environment)
  assert.notEqual(scriptPath.status, 0)
  assert.match(scriptPath.stderr, /stdin only/u)
  const noContext = execute(root, user, data, ['application.mjs', '--map-harness-internal-worker'], '')
  assert.notEqual(noContext.status, 0)
  assert.match(noContext.stderr, /MAP_ENTRY_CONTEXT|reserved for admitted Map children/u)
  const foreignContext = execute(root, user, data, ['application.mjs', '--map-harness-internal-worker'], '', {
    MAPHARNESS_INSTANCE_CONTEXT: JSON.stringify({ ...JSON.parse(admitted.environment.MAPHARNESS_INSTANCE_CONTEXT), instanceId: '00000000-0000-0000-0000-000000000000' }),
  })
  assert.notEqual(foreignContext.status, 0)
  assert.match(foreignContext.stderr, /MAP_ENTRY_CONTEXT/u)
  const markerPath = join(data, 'map-instance.json')
  const marker = readFileSync(markerPath)
  rmSync(markerPath)
  const noMarker = execute(root, user, data, ['application.mjs', '--map-harness-internal-worker'], '', admitted.environment)
  assert.notEqual(noMarker.status, 0)
  assert.match(noMarker.stderr, /MAP_ENTRY_CONTEXT/u)
  assert.equal(existsSync(markerPath), false, 'a child never creates a missing marker')
  assert.equal(existsSync(join(data, 'profiles')), false)
  assert.equal(existsSync(join(data, 'map-run')), false)
  writeFileSync(markerPath, marker, { mode: 0o600 })
})

test('Windows ACL runner argv passes through before profile arguments are added', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord({ ...manifest, platform: 'win32' }))
  const runner = join(root, 'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js')
  const admitted = admittedEnvironment(root, user, data)
  const result = execute(root, user, data, ['--input-type=module', '--eval', `Object.defineProperty(process,'platform',{value:'win32'});process.argv=[process.execPath,${JSON.stringify(join(root, 'application.mjs'))},${JSON.stringify(realpathSync(runner))}];await import('./application.mjs')`], '', admitted.environment)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [realpathSync(runner)])
  assert.equal(existsSync(join(data, 'profiles')), false, 'an admitted child context writes no profile')
})

test('launcher patches precede Web options while keeping their declared order', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord(manifest))
  for (const [args, expected] of [
    [['web', '--no-open', '--patch', 'first.yml', '--port', '6425', '--patch', 'second.yml'],
      ['--profile', 'map-web', '--patch', 'first.yml', '--patch', 'second.yml', '--no-open', '--port', '6425']],
    [['--profile', 'custom-map', '--no-open', '--patch', 'custom.yml'],
      ['--profile', 'custom-map', '--patch', 'custom.yml', '--no-open']],
  ]) {
    const result = execute(root, user, data, ['application.mjs', ...args])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected)
    assert.ok(existsSync(join(data, 'profiles/map-web/package.json')), 'the profile lands in the data home')
    assert.ok(existsSync(join(data, '.agent-presets/map-analyst/agent.cordis.yml')))
    assert.ok(existsSync(join(data, 'map-run/instance.lock')), 'the service creates its stable lock inode')
    const marker = JSON.parse(readFileSync(join(data, 'map-instance.json'), 'utf8'))
    const record = JSON.parse(readFileSync(join(data, 'map-run/instance.json'), 'utf8'))
    assert.equal(record.state, 'stopped', 'normal exit settles the lifetime lease')
    assert.equal(record.instanceId, marker.instanceId)
    assert.equal(existsSync(join(root, 'home')), false, 'no legacy home inside the program tree')
  }
})

test('Windows system diagnostics require successful PTY output after search succeeds', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord({ ...manifest, platform: 'win32' }))
  const pty = join(root, 'node_modules/node-pty')
  mkdirSync(pty)
  writeFileSync(join(pty, 'package.json'), '{"main":"index.cjs"}\n')
  const shell = 'C:\\Windows path\\cmd.exe'
  for (const exitCode of [0, 1]) {
    writeFileSync(join(pty, 'index.cjs'), `exports.spawn=(file,args,options)=>{
require('node:fs').writeFileSync('pty-call.json',JSON.stringify({file,args,cols:options.cols,useConptyDll:options.useConptyDll}));
return {onData(fn){setImmediate(()=>fn('map-native-pty'));},onExit(fn){setImmediate(()=>fn({exitCode:${exitCode}}));},kill(){require('node:fs').appendFileSync('pty-kill-${exitCode}.txt','kill\\n')}};
};\n`)
    const result = execute(root, user, data, ['--input-type=module', '--eval', `
import {createRequire,syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'win32'});
process.env.ComSpec=${JSON.stringify(shell)};
process.argv=[process.execPath,${JSON.stringify(join(root, 'application.mjs'))},'--application-system-check'];
createRequire(import.meta.url)('node:child_process').spawnSync=()=>({status:0,stdout:'ripgrep fixture'});
syncBuiltinESMExports();
await import('./application.mjs');`])
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'pty-call.json'))),
      { file: shell, args: ['/d', '/s', '/c', 'echo map-native-pty'], cols: 80, useConptyDll: true })
    assert.equal(readFileSync(join(root, `pty-kill-${exitCode}.txt`), 'utf8'), 'kill\n')
    if (exitCode === 0) {
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { search: true, terminal: true })
    } else {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /installed terminal helper failed/u)
      assert.equal(result.stdout.trim(), '')
    }
  }
})

test('archive creation verifies the actual copied executable after acceptance', t => {
  const { root } = fixture(t)
  const executable = join(root, 'program'), notices = join(root, 'notices.txt')
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  writeFileSync(executable, bytes)
  writeFileSync(notices, 'license')
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) writeFileSync(join(root, file), 'license')
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const accepted = { executable: 'map-harness-v0.0.0-mac-arm64', path: executable, target: 'mac-arm64',
    noticesPath: notices, sha256: digest(bytes), noticesSha256: digest('license'), resources: {}, resourcePaths: {} }
  for (const role of ['rg', 'spawn-helper']) {
    const path = join(root, role)
    writeFileSync(path, bytes)
    accepted.resources[role] = { sha256: digest(bytes) }
    accepted.resourcePaths[role] = path
  }
  const archives = packApplications(root, [accepted], join(root, 'out'))
  const listed = completed(spawnSync('tar', ['-tzf', archives[0]], { encoding: 'utf8', timeout: 30000 }))
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(listed.stdout.trim().split('\n').filter(name => !name.endsWith('/')).map(name => name.split('/').at(-1)).sort(),
    ['LICENSE', 'THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.md', 'map-harness', 'map-harness-rg', 'map-harness-spawn-helper'].sort())
  const extracted = mkdtempSync(join(root, 'unpacked-'))
  const unpacked = completed(spawnSync('tar', ['-xzf', archives[0], '-C', extracted], { encoding: 'utf8', timeout: 30000 }))
  assert.equal(unpacked.status, 0, unpacked.stderr)
  if (process.platform !== 'win32') {
    for (const file of ['map-harness', 'map-harness-rg', 'map-harness-spawn-helper']) {
      assert.equal(statSync(join(extracted, accepted.executable, file)).mode & 0o777, 0o755, `${file} is executable after extraction`)
    }
  }
  writeFileSync(executable, 'console.log("editable map implementation")\n')
  assert.throws(() => packApplications(root, [accepted], join(root, 'changed')), /changed before archiving/u)
  writeFileSync(executable, bytes)
  writeFileSync(notices, 'changed license')
  assert.throws(() => packApplications(root, [accepted], join(root, 'changed-notices')), /changed before archiving/u)
  writeFileSync(notices, 'license')
  writeFileSync(accepted.resourcePaths.rg, 'changed helper')
  assert.throws(() => packApplications(root, [accepted], join(root, 'changed-helper')), /helper changed before archiving/u)
})

test('browser acceptance rejects missing scenarios and stops the live Windows tree before reporting a timeout', t => {
  const { root, user, data } = fixture(t)
  const checker = new URL('../bin/application-browser-check.mjs', import.meta.url).href
  for (const mode of ['passed', 'no-tests', 'timeout', 'cleanup-failed']) {
    const result = execute(root, user, data, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFileSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
Object.defineProperty(process,'platform',{value:'win32'});
const api=createRequire(import.meta.url)('node:child_process'), mode=${JSON.stringify(mode)};
const events=[], child=new EventEmitter();child.pid=12345;
let report;
child.kill=()=>{events.push('fallback-kill');queueMicrotask(()=>child.emit('exit',1,null));return true;};
api.spawn=(command,args,options)=>{
events.push('spawn');assert.equal(options.detached,false);assert.equal(options.env.MAP_APPLICATION_BIN,'C:\\\\map path\\\\map-harness.exe');
report=args.find(arg=>arg.startsWith('--test-reporter-destination=')).split('=')[1];
if(mode==='passed'||mode==='no-tests') {writeFileSync(report,mode==='passed'?'pass 1\\nskipped 0':'pass 0\\nskipped 0');queueMicrotask(()=>child.emit('exit',0,null));}
return child;};
api.spawnSync=(command,args)=>{
events.push('taskkill');assert.equal(command,'taskkill');assert.deepEqual(args,['/PID','12345','/T','/F']);
if(mode!=='cleanup-failed')queueMicrotask(()=>child.emit('exit',1,null));
return {status:mode==='cleanup-failed'?1:0};};
if(mode==='timeout'||mode==='cleanup-failed')globalThis.setTimeout=callback=>{queueMicrotask(callback);return 0;};
syncBuiltinESMExports();
const {checkApplicationBrowser}=await import(${JSON.stringify(checker)});
const run=()=>checkApplicationBrowser('C:\\\\map path\\\\map-harness.exe');
if(mode==='passed')await run();
else await assert.rejects(run(),mode==='no-tests'?/did not run exactly one/:mode==='cleanup-failed'?/cleanup was not confirmed/:/timed out/);
assert.equal(existsSync(dirname(report)),false);
assert.deepEqual(events,mode==='timeout'?['spawn','taskkill']:mode==='cleanup-failed'?['spawn','taskkill','fallback-kill']:['spawn']);
console.log('browser acceptance checked');`])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'browser acceptance checked')
  }
})

test('Windows ZIP contains the accepted executable and search helper without a development tree', t => {
  const { root } = fixture(t)
  const directory = join(root, 'Windows 用户 path with spaces')
  mkdirSync(directory)
  const executable = join(directory, 'program.exe'), noticesPath = join(directory, 'notices.txt')
  const bytes = Buffer.from('accepted Windows executable fixture')
  const sha = value => createHash('sha256').update(value).digest('hex')
  writeFileSync(executable, bytes)
  writeFileSync(noticesPath, 'third-party license')
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) writeFileSync(join(directory, file), file)
  const helper = join(directory, 'rg.exe')
  writeFileSync(helper, 'accepted Windows helper fixture')
  const accepted = { executable: 'map-harness-v0.0.0-win-x64.exe', target: 'win-x64', path: executable, sha256: sha(bytes),
    noticesPath, noticesSha256: sha('third-party license'), resources: { rg: { sha256: sha(readFileSync(helper)) } }, resourcePaths: { rg: helper } }
  const [archive] = packApplications(directory, [accepted], join(directory, 'out'))
  assert.match(archive, /-win-x64\.zip$/u)
  const files = unzipSync(readFileSync(archive))
  const name = 'map-harness-v0.0.0-win-x64/'
  assert.deepEqual(Object.keys(files).filter(file => !file.endsWith('/')).sort(),
    ['LICENSE', 'THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.md', 'map-harness.exe', 'map-harness-rg.exe'].map(file => name + file).sort())
  assert.deepEqual(Buffer.from(files[name + 'map-harness.exe']), bytes)
  assert.deepEqual(Buffer.from(files[name + 'map-harness-rg.exe']), readFileSync(helper))
})

test('native SEA executes compiled map exports and its fixed worker without extension hooks', {
  skip: !process.env.MAP_NATIVE_ENGINE && 'Set MAP_NATIVE_ENGINE to the locked official Node executable for native integration.',
}, async t => {
  const engine = realpathSync(process.env.MAP_NATIVE_ENGINE)
  if (realpathSync(process.execPath) !== engine) {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(engine, ['--test', '--test-name-pattern=^native SEA', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env, timeout: 240000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /pass 1/u)
    return
  }
  const { temporary, root, user, data } = fixture(t)
  stageBootstrap(root)
  writeFileSync(join(root, 'package.json'), '{"name":"map-native-fixture","type":"module"}\n')
  // This witness replaces only the upstream CLI; the production bootstrap still admits and locks the data home.
  writeFileSync(join(root, 'dsh-runtime-bootstrap.mjs'), "const m=await import('@map-harness/spatial-scale');console.log(m.calculate(3))\n")
  const compiled = spawnSync(engine, [join(repo, 'map/bin/application-core.mjs'), root], {
    encoding: 'utf8', timeout: 240000, env: fixtureEnvironment(user, data),
  })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  const coreManifest = JSON.parse(readFileSync(join(root, 'map-application.json'), 'utf8'))
  writeFileSync(join(root, 'map-application.json'), applicationRecord(coreManifest))
  const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)])
  const output = join(temporary, 'sealed', process.platform === 'win32' ? 'map-native.exe' : 'map-native')
  mkdirSync(dirname(output), { recursive: true })
  await sealApplication(root, walk(''), 'application.mjs', engine, coreManifest.node.replace(/^v/u, ''), output)
  rmSync(root, { recursive: true, force: true })
  const plain = { PATH: process.env.PATH ?? '', HOME: user, USERPROFILE: user, MAPHARNESS_HOME: data }
  const exports = spawnSync(output, [], { input: '', encoding: 'utf8', timeout: 60000, env: plain })
  assert.equal(exports.error, undefined, exports.stdout + String(exports.error ?? ''))
  assert.equal(exports.signal, null, exports.stdout + exports.stderr)
  assert.equal(exports.status, 0, exports.stderr)
  assert.equal(exports.stdout.trim(), '21')
  const programRoot = dirname(output)
  const entry = resolveMapEntry({ programRoot, identity: { mode: 'release', channel: 'stable', distribution: 'portable' }, env: plain })
  entry.spec = prepareMapInstance(entry.spec)
  const worker = spawnSync(output, ['--map-harness-internal-worker'], {
    input: '', encoding: 'utf8', timeout: 60000, env: mapEntryEnvironment(entry, programRoot),
  })
  assert.equal(worker.status, 0, worker.stderr)
  assert.equal(worker.stdout.trim(), 'compiled-worker-ran')
  assert.equal(existsSync(join(data, 'map-instance.json')), true, 'the SEA worker admits the separate data home')
})

test('a tilde MAPHARNESS_HOME is expanded before the runtime boots', async t => {
  const { root, user, data } = fixture(t)
  const manifest = await compileApplicationCore(root)
  stageBootstrap(root)
  writeFileSync(join(root, 'map-application.json'), applicationRecord(manifest))
  writeFileSync(join(root, 'dsh-runtime-bootstrap.mjs'), 'console.log(JSON.stringify(process.env.DSH_HOME))\n')
  const env = fixtureEnvironment(user, '~/tilde-home', { PATH: process.env.PATH ?? '' })
  const result = spawnSync(process.execPath, ['application.mjs', '--no-open'], { cwd: root, encoding: 'utf8', env, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  const tildeHome = join(user, 'tilde-home')
  assert.equal(JSON.parse(result.stdout), tildeHome, 'the runtime reads the expanded absolute home')
  assert.ok(existsSync(join(tildeHome, 'profiles/map-web/package.json')), 'the profile lands in the same home')
  assert.equal(existsSync(join(user, '~')), false, 'no literal tilde directory')
  assert.ok(existsSync(join(tildeHome, 'map-instance.json')), 'the expanded home carries its instance marker')
  assert.ok(existsSync(join(tildeHome, 'map-run/instance.lock')), 'the service held its kernel lock')
  if (process.platform !== 'win32') {
    const profile = join(tildeHome, 'profiles', 'map-web')
    const preset = join(tildeHome, '.agent-presets', 'map-analyst')
    for (const path of [tildeHome, join(tildeHome, 'profiles'), profile, join(preset, '..'), preset]) {
      assert.equal(statSync(path).mode & 0o777, 0o700, `${path} is private to its owner`)
    }
    for (const path of [join(profile, 'package.json'), join(profile, 'cordis.patch.yml'), join(preset, 'preset.yml'), join(preset, 'agent.cordis.yml')]) {
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is private to its owner`)
    }
  }
  assert.equal(existsSync(join(data, 'map-instance.json')), false, 'the overridden home wins over the ambient data root')
})
