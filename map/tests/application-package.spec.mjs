/** Actual V8 core compilation, runtime identity and source-omission gates. */
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
import { isDependencyRuntimeSource, isDevelopmentFile } from '../bin/release-content.mjs'
import { packApplications } from '../bin/application-assets.mjs'
import { sealApplication } from '../bin/application-sea.mjs'

const toolRequire = createRequire(new URL('../tools/package.json', import.meta.url))
const nodePath = dirname(dirname(dirname(toolRequire.resolve('bytenode'))))

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-application-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'node_modules/@map-harness/spatial-scale')
  mkdirSync(join(dir, 'lib/types'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"@map-harness/spatial-scale","type":"module","main":"lib/types/worker.js"}\n')
  const file = join(dir, 'lib/types/worker.js')
  const program = "process.stdin.resume();process.stdin.on('end',()=>console.log('compiled-worker-ran'))"
  writeFileSync(join(dir, 'lib/types/lazy.js'), "throw new Error('lazy branch executed');export const value=3;\n")
  writeFileSync(join(dir, 'lib/types/unused.js'), "throw new Error('unused implementation executed');export const value=4;\n")
  writeFileSync(file, `const WORKER_ENTRY_SOURCE=${JSON.stringify(program)};export const SCALE_WORKER_ENTRY=WORKER_ENTRY_SOURCE;export function calculate(x){const coefficient=7;return x*coefficient}export async function platform(){return (await import('node:os')).platform()}export function location(){return import.meta.url}export async function lazy(){return import('./lazy.js')}\n`)
  mkdirSync(join(root, 'map-presets'))
  writeFileSync(join(root, 'map-presets/preset.yml'), 'name: test-map\n')
  writeFileSync(join(root, 'map-presets/agent.cordis.yml'), '[]\n')
  return { root, file }
}

function execute(root, args, input) {
  const env = { ...process.env, NODE_PATH: nodePath, MAPHARNESS_HOME: join(root, 'home'), DSH_HOME: join(root, 'home') }
  for (const key of ['DSH_SUBPROCESS_RUNNER', 'DSH_PTC_RUNTIME_NODE', 'DSH_RUNTIME_DOWNLOAD']) delete env[key]
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', input, env, timeout: 30000 })
}

test('real core bytecode executes after implementation JS is replaced by its interface facade', async t => {
  const { root, file } = fixture(t)
  const manifest = await compileApplicationCore(root)
  auditApplicationCore(root, manifest)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /coefficient|function calculate/u)
  const result = execute(root, ['--input-type=module', '--eval', "const m=await import('./node_modules/@map-harness/spatial-scale/lib/types/worker.js');console.log(JSON.stringify({value:m.calculate(3),platform:await m.platform(),location:m.location()}))"])
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.value, 21)
  assert.equal(value.platform, process.platform)
  assert.match(value.location, /worker\.jsc$/u)
  assert.equal(manifest.coreModules, 2)
  const lazy = execute(root, ['--input-type=module', '--eval', "const m=await import('./node_modules/@map-harness/spatial-scale/lib/types/worker.js');await m.lazy()"])
  assert.notEqual(lazy.status, 0)
  assert.match(lazy.stderr, /lazy branch executed/u)
  assert.doesNotMatch(lazy.stderr, /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/u)
})

test('compiled onboarding exports the SEA entry under the target engine', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-onboarding-seal-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  copyFileSync(fileURLToPath(new URL('../bin/web-onboarding.mjs', import.meta.url)), join(root, 'web-onboarding.mjs'))
  const compiled = await compileOnboarding(root, join(root, 'web-onboarding.mjs'))
  const facade = readFileSync(compiled.compiled, 'utf8')
  assert.match(facade, /module\.exports=worker\.exports/u)
  assert.equal(existsSync(join(root, 'web-onboarding.mjs')), false)
})

test('compiled map application resolves and runs its fixed Wayback worker', async t => {
  const { root } = fixture(t)
  const packageRoot = join(root, 'node_modules/@map-harness/map-container')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  const built = fileURLToPath(new URL('../map-container/lib/', import.meta.url))
  copyFileSync(join(built, 'index.js'), join(packageRoot, 'lib/index.js'))
  copyFileSync(join(built, 'wayback-worker.js'), join(packageRoot, 'lib/wayback-worker.js'))
  const original = JSON.parse(readFileSync(new URL('../map-container/package.json', import.meta.url), 'utf8'))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: original.name, type: 'module', main: original.main, exports: { '.': original.exports['.'], './wayback-worker': original.exports['./wayback-worker'] } }))
  const llm = join(root, 'node_modules/@deepseek-ai/dsh-llm')
  mkdirSync(llm, { recursive: true })
  writeFileSync(join(llm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.js' }))
  writeFileSync(join(llm, 'index.js'), 'exports.MessageId = value => value\n')
  const official = join(root, 'node_modules/@esri/wayback-core')
  mkdirSync(dirname(official), { recursive: true })
  cpSync(realpathSync(join(fileURLToPath(new URL('../map-container/', import.meta.url)), 'node_modules/@esri/wayback-core')), official, { recursive: true })
  const sharpRequire = createRequire(new URL('../map-container/package.json', import.meta.url))
  const sharpRoot = dirname(dirname(sharpRequire.resolve('sharp')))
  cpSync(sharpRoot, join(root, 'node_modules/sharp'), { recursive: true })
  const sharpModuleRequire = createRequire(join(sharpRoot, 'package.json'))
  for (const name of Object.keys(JSON.parse(readFileSync(join(sharpRoot, 'package.json'), 'utf8')).dependencies)) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(dirname(sharpModuleRequire.resolve(`${name}/package.json`)), destination, { recursive: true })
  }
  const sharpNative = `@img/sharp-${process.platform}-${process.arch}`
  const sharpLibvips = `@img/sharp-libvips-${process.platform}-${process.arch}`
  for (const [name, entry] of [[sharpNative, `${sharpNative}/sharp.node`], [sharpLibvips, `${sharpLibvips}/versions`]]) {
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
    const worker = new Worker(require.resolve('@map-harness/map-container/wayback-worker'));
    try {
      const message = await new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        worker.postMessage({kind:'call',id:1,operation:'not-a-real-operation'});
      });
      console.log(JSON.stringify(message));
    } finally { await worker.terminate() }
  `
  const result = execute(root, ['--input-type=module', '--eval', program])
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { kind: 'result', id: 1, error: 'official Wayback operation failed' })
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

test('engine mismatch and changed facades reject before loading core bytecode', async t => {
  const { root, file } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify({ ...manifest, version: '0.0.0' }))
  assert.equal(execute(root, ['application.mjs', '--application-info']).status, 0)
  writeFileSync(file, readFileSync(file, 'utf8') + '\nmodule.exports.secret=1;\n')
  assert.throws(() => auditApplicationCore(root, manifest), /Editable map implementation/u)
  assert.match(execute(root, ['application.mjs', '--application-info']).stderr, /compiled map core is incomplete or changed/u)
  writeFileSync(join(root, 'map-application.json'), JSON.stringify({ ...manifest, node: 'v0.0.0' }))
  assert.match(execute(root, ['application.mjs', '--application-info']).stderr, /engine does not match/u)
})

test('the fixed compiled worker accepts stdin data and refuses a script path argument', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify(manifest))
  const good = execute(root, ['application.mjs', '--map-harness-internal-worker'], '')
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.trim(), 'compiled-worker-ran')
  const bad = execute(root, ['application.mjs', '--map-harness-internal-worker', '/tmp/arbitrary-script.js'], '')
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /stdin only/u)
})

test('Windows ACL runner argv passes through before profile arguments are added', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify({ ...manifest, platform: 'win32' }))
  const acl = join(root, 'node_modules/@deepseek-ai/dsh-sandbox-windows-acl')
  mkdirSync(acl, { recursive: true })
  writeFileSync(join(acl, 'package.json'), '{"exports":{"./runner":"./runner.js"}}\n')
  writeFileSync(join(acl, 'runner.js'), '')
  writeFileSync(join(root, 'dsh-runtime-bootstrap.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const runner = realpathSync(join(acl, 'runner.js'))
  const result = execute(root, ['--input-type=module', '--eval', `Object.defineProperty(process,'platform',{value:'win32'});process.argv=[process.execPath,${JSON.stringify(join(root, 'application.mjs'))},${JSON.stringify(runner)}];await import('./application.mjs')`])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [runner])
})

test('launcher patches precede Web options while keeping their declared order', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'dsh-runtime-bootstrap.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  for (const [args, expected] of [
    [['web', '--no-open', '--patch', 'first.yml', '--port', '0', '--patch', 'second.yml'],
      ['--profile', 'map-web', '--patch', 'first.yml', '--patch', 'second.yml', '--no-open', '--port', '0']],
    [['--profile', 'custom-map', '--no-open', '--patch', 'custom.yml'],
      ['--patch', 'custom.yml', '--profile', 'custom-map', '--no-open']],
  ]) {
    const result = execute(root, ['application.mjs', ...args])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected)
    assert.ok(existsSync(join(root, 'home/profiles/map-web/package.json')))
    assert.ok(existsSync(join(root, 'home/.agent-presets/map-analyst/agent.cordis.yml')))
  }
})

test('Windows system diagnostics require successful PTY output after search succeeds', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify({ ...manifest, platform: 'win32' }))
  const pty = join(root, 'node_modules/node-pty')
  mkdirSync(pty)
  writeFileSync(join(pty, 'package.json'), '{"main":"index.cjs"}\n')
  const shell = 'C:\\Windows path\\cmd.exe'
  for (const exitCode of [0, 1]) {
    writeFileSync(join(pty, 'index.cjs'), `exports.spawn=(file,args,options)=>{
require('node:fs').writeFileSync('pty-call.json',JSON.stringify({file,args,cols:options.cols,useConptyDll:options.useConptyDll}));
return {onData(fn){setImmediate(()=>fn('map-native-pty'));},onExit(fn){setImmediate(()=>fn({exitCode:${exitCode}}));},kill(){require('node:fs').appendFileSync('pty-kill-${exitCode}.txt','kill\\n')}};
};\n`)
    const result = execute(root, ['--input-type=module', '--eval', `
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
  const listed = spawnSync('tar', ['-tzf', archives[0]], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(listed.stdout.trim().split('\n').filter(name => !name.endsWith('/')).map(name => name.split('/').at(-1)).sort(),
    ['LICENSE', 'THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.md', 'map-harness', 'map-harness-rg', 'map-harness-spawn-helper'].sort())
  const extracted = mkdtempSync(join(root, 'unpacked-'))
  const unpacked = spawnSync('tar', ['-xzf', archives[0], '-C', extracted], { encoding: 'utf8' })
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
  const { root } = fixture(t)
  const checker = new URL('../bin/application-browser-check.mjs', import.meta.url).href
  for (const mode of ['passed', 'no-tests', 'timeout', 'cleanup-failed']) {
    const result = execute(root, ['--input-type=module', '--eval', `
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
      encoding: 'utf8', env, timeout: 120000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /pass 1/u)
    return
  }
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  cpSync(dirname(toolRequire.resolve('bytenode/package.json')), join(root, 'node_modules/bytenode'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"map-native-fixture","type":"module"}\n')
  writeFileSync(join(root, 'map-application.json'), JSON.stringify(manifest))
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'entry.mjs'), "if(process.argv[2]==='--map-harness-internal-worker'){await import('./application.mjs')}else{const m=await import('@map-harness/spatial-scale');console.log(m.calculate(3))}\n")
  const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)])
  const assets = walk('')
  const output = join(root, process.platform === 'win32' ? 'map-native.exe' : 'map-native')
  await sealApplication(root, assets, 'entry.mjs', process.execPath, process.versions.node, output)
  for (const [args, expected] of [[[], '21'], [['--map-harness-internal-worker'], 'compiled-worker-ran']]) {
    const result = spawnSync(output, args, { input: '', encoding: 'utf8', timeout: 60000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), expected)
  }
})

test('a tilde MAPHARNESS_HOME is expanded before the runtime boots', async t => {
  const { root } = fixture(t)
  const manifest = await compileApplicationCore(root)
  copyFileSync(fileURLToPath(new URL('../bin/application-bootstrap.mjs', import.meta.url)), join(root, 'application.mjs'))
  writeFileSync(join(root, 'map-application.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'dsh-runtime-bootstrap.mjs'), 'console.log(JSON.stringify(process.env.DSH_HOME))\n')
  const env = { ...process.env, NODE_PATH: nodePath, HOME: root, MAPHARNESS_HOME: '~/tilde-home' }
  for (const key of ['DSH_HOME', 'DSH_SUBPROCESS_RUNNER', 'DSH_PTC_RUNTIME_NODE', 'DSH_RUNTIME_DOWNLOAD']) delete env[key]
  const result = spawnSync(process.execPath, ['application.mjs', '--no-open'], { cwd: root, encoding: 'utf8', env, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout), join(root, 'tilde-home'), 'the runtime reads the expanded absolute home')
  assert.ok(existsSync(join(root, 'tilde-home/profiles/map-web/package.json')), 'the profile lands in the same home')
  assert.equal(existsSync(join(root, '~')), false, 'no literal tilde directory')
    if (process.platform !== 'win32') {
      const mapHome = join(root, 'tilde-home')
      const profile = join(mapHome, 'profiles', 'map-web')
      const preset = join(mapHome, '.agent-presets', 'map-analyst')
      for (const path of [mapHome, join(mapHome, 'profiles'), profile, join(preset, '..'), preset]) {
        assert.equal(statSync(path).mode & 0o777, 0o700, `${path} is private to its owner`)
      }
      for (const path of [join(profile, 'package.json'), join(profile, 'cordis.patch.yml'), join(preset, 'preset.yml'), join(preset, 'agent.cordis.yml')]) {
        assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is private to its owner`)
      }
    }
})
