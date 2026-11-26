/**
 * Real portable-archive isolation: build the production bootstrap closure into a host SEA
 * executable, pack it through the real Web service packer, extract it outside the checkout,
 * and launch it with a poisoned PATH. The witness runtime replaces only the upstream CLI, so
 * these cases prove bootstrap data-home admission, locking, restart and diagnostics; the full
 * Map production chain remains a separate release qualification.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { sealApplication } from '../bin/application-sea.mjs'
import { stageApplicationHelpers } from '../bin/application-helpers.mjs'
import { createInstallDescriptor, readDataCompatibility } from '../bin/install-manifest.mjs'
import { packWebService } from '../bin/pack-web-service.mjs'
import { extractQualificationArchive, qualificationPlatform } from '../bin/web-service-qualification-platform.mjs'

const repo = realpathSync(join(import.meta.dirname, '../..'))
const toolRequire = createRequire(new URL('../tools/package.json', import.meta.url))
const runtimeRequire = createRequire(new URL('../application-runtime/package.json', import.meta.url))
const productVersion = JSON.parse(readFileSync(join(repo, 'map/release/version.json'), 'utf8')).version
const runtimeLock = JSON.parse(readFileSync(join(repo, 'scripts/primary-runtime/lock.json'), 'utf8'))
const hostTarget = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const POSIX = process.platform !== 'win32'
const STOCK_PREFIXES = ['.dsh/', '.agents/', '.cache/deepseek-harness/']

const witness = `/** Portable qualification runtime witness: records the admitted home and serves one page. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
// The product CLI reads --port; the witness mirrors it. No --port means the shipped default, 6425.
const portAt = args.indexOf('--port')
const port = portAt >= 0 ? Number(args[portAt + 1]) : 6425
const home = process.env.MAPHARNESS_HOME
const report = {
  kind: 'map-harness-portable-witness', home,
  dshHome: process.env.DSH_HOME,
  agentsHome: process.env.DSH_AGENTS_HOME,
  resourceCache: process.env.DSH_RESOURCE_CACHE,
  pkgCache: process.env.PKG_NATIVE_CACHE_PATH,
  namespace: process.env.MAPHARNESS_BROWSER_NAMESPACE,
  instanceId: process.env.MAPHARNESS_INSTANCE_ID,
  path: process.env.PATH,
  argv: args,
}
if (typeof home !== 'string' || home === '') { console.error('missing MAPHARNESS_HOME'); process.exit(90) }
if (process.env.DSH_HOME !== home) { console.error('DSH_HOME is not the Map home'); process.exit(91) }
if (process.env.DSH_AGENTS_HOME !== join(home, 'agents')) { console.error('DSH_AGENTS_HOME is not the Map agents root'); process.exit(92) }
if (process.env.DSH_RESOURCE_CACHE !== join(home, 'cache', 'runtime')) { console.error('DSH_RESOURCE_CACHE is not the Map cache'); process.exit(93) }
if (process.env.PKG_NATIVE_CACHE_PATH !== join(home, 'cache', 'runtime')) { console.error('PKG_NATIVE_CACHE_PATH is not the Map cache'); process.exit(95) }
if (process.env.DSH_BUNDLED_PRIMARY_RUNTIME !== undefined || process.env.DSH_BUNDLED_OFFICE_CLI !== undefined) {
  console.error('ambient bundled runtime leaked'); process.exit(94)
}
if (args.some(arg => arg.startsWith('--dump-config') || arg === '--dump-default-config')) {
  console.log(JSON.stringify({ ...report, kind: 'map-harness-portable-dump' }))
  process.exit(0)
}
mkdirSync(join(home, 'sessions'), { recursive: true })
const data = join(home, 'sessions', 'portable-witness.jsonl')
const boot = existsSync(data) ? readFileSync(data, 'utf8').trim().split('\\n').length + 1 : 1
appendFileSync(data, JSON.stringify({ boot, instanceId: report.instanceId, home }) + '\\n', { mode: 0o600 })
const server = createServer((request, response) => {
  if (String(request.url ?? '').startsWith('/app')) {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body>map-harness-portable</body></html>')
    return
  }
  response.writeHead(302, { location: '/app', 'set-cookie': 'portable=1; Path=/' })
  response.end()
})
// The shipped default port and label: the sealed production bootstrap forwards argv verbatim, so this
// is exactly what the portable package prints when the person passes no --port.
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ...report, boot }))
  console.log('map-harness web: http://127.0.0.1:' + server.address().port + '/?token=portable-fixture')
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
`

function filesBelow(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`fixture stage contains a link: ${file}`)
    return entry.isDirectory() ? filesBelow(root, file) : [file]
  }).sort()
}

function seaCapable(engine) {
  if (typeof engine !== 'string' || !existsSync(engine)) return false
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'map-sea-probe-')))
  try {
    writeFileSync(join(directory, 'entry.js'), 'console.log(1)\n')
    writeFileSync(join(directory, 'sea.json'), JSON.stringify({ main: join(directory, 'entry.js'), output: join(directory, 'out.blob') }))
    return spawnSync(engine, ['--experimental-sea-config', join(directory, 'sea.json')], { encoding: 'utf8' }).status === 0
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

/** Prefer a locked build engine from the repository cache; official Node builds support SEA. */
function fixtureEngine() {
  const main = join(repo, '..', '..', '..')
  const candidates = [
    process.env.MAP_NATIVE_ENGINE,
    join(repo, '.dsh-build/map-application/node/bin/node'),
    join(main, '.dsh-build/map-application/node/bin/node'),
    process.execPath,
  ]
  return candidates.find(candidate => typeof candidate === 'string' && seaCapable(candidate))
}

/** Capture the engine identity after bytenode loads, matching the compiler's flag state. */
function engineIdentity(engine, stage) {
  const script = "import {createRequire} from 'node:module';"
    + "import v8 from 'node:v8';"
    + `const require=createRequire(${JSON.stringify(join(stage, 'probe.mjs'))});`
    + `require(${JSON.stringify(join(stage, 'node_modules', 'bytenode'))});`
    + "console.log(JSON.stringify({node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,tag:v8.cachedDataVersionTag()}))"
  const probe = spawnSync(engine, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  return JSON.parse(probe.stdout)
}

/** Stage production launch helpers plus a witness runtime and seal them into a host SEA executable. */
async function buildNativeService(root, engine) {
  const stage = join(root, 'native-stage')
  mkdirSync(stage)
  stageApplicationHelpers(repo, stage)
  cpSync(join(repo, 'map/bin/application-bootstrap.mjs'), join(stage, 'application.mjs'))
  writeFileSync(join(stage, 'dsh-runtime-bootstrap.mjs'), witness)
  cpSync(join(repo, 'map/presets/map-analyst'), join(stage, 'map-presets'), { recursive: true })
  const modules = join(stage, 'node_modules')
  cpSync(dirname(toolRequire.resolve('bytenode/package.json')), join(modules, 'bytenode'), { recursive: true, dereference: true })
  const flockEntry = dirname(runtimeRequire.resolve('@deepseek-ai/node-addon-system/package.json'))
  mkdirSync(join(modules, '@deepseek-ai/node-addon-system'), { recursive: true })
  cpSync(join(flockEntry, 'package.json'), join(modules, '@deepseek-ai/node-addon-system/package.json'))
  cpSync(join(flockEntry, 'lib'), join(modules, '@deepseek-ai/node-addon-system/lib'), { recursive: true, dereference: true })
  const platformSource = join(repo, 'native/system/packages', `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`)
  cpSync(platformSource, join(modules, `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`), { recursive: true, dereference: true })
  if (process.platform === 'win32') cpSync(dirname(runtimeRequire.resolve('koffi/package.json')), join(modules, 'koffi'), { recursive: true, dereference: true })
  const identity = engineIdentity(engine, stage)
  const install = createInstallDescriptor({ distribution: 'portable', channel: 'stable', dataCompatibility: await readDataCompatibility(repo) })
  writeFileSync(join(stage, 'map-application.json'), JSON.stringify({
    format: 1, node: identity.node, v8: identity.v8, platform: identity.platform, arch: identity.arch,
    cachedDataVersionTag: identity.tag, binaries: {}, facades: {}, coreModules: 0, version: productVersion, install,
  }, null, 2) + '\n')
  const executable = join(root, `map-harness-v${productVersion}-${hostTarget}`)
  await sealApplication(stage, filesBelow(stage), 'application.mjs', engine, identity.node.replace(/^v/u, ''), executable)
  chmodSync(executable, 0o755)
  const smoke = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 60000, env: { HOME: join(root, 'smoke-home'), PATH: qualificationPlatform(process.platform, process.env).path } })
  assert.equal(smoke.status, 0, smoke.stderr)
  assert.equal(smoke.stdout.trim(), `map-harness v${productVersion}`)
  return { executable, install, engine: identity }
}

/** Pack the sealed service into a real portable Web archive and extract it outside the checkout. */
async function buildPortablePackage(owned, engine) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-portable-isolation-')))
  owned.roots.push(root)
  const native = await buildNativeService(root, engine)
  const app = join(root, 'application')
  mkdirSync(app)
  const stem = `map-harness-v${productVersion}-${hostTarget}`
  const service = join(app, stem)
  cpSync(native.executable, service)
  chmodSync(service, 0o755)
  const helpers = hostTarget.startsWith('mac-') ? ['rg', 'spawn-helper'] : ['rg']
  const resources = {}
  for (const role of helpers) {
    const file = `${stem}-${role}`
    writeFileSync(join(app, file), `${role} helper fixture\n`)
    chmodSync(join(app, file), 0o755)
    resources[role] = { file, sha256: sha(readFileSync(join(app, file))) }
  }
  const notices = `${stem}.licenses.txt`
  writeFileSync(join(app, notices), 'portable fixture third-party notices\n')
  writeFileSync(join(app, `${stem}.json`), JSON.stringify({
    format: 'map-harness-native-1', version: productVersion, target: hostTarget,
    engine: { node: native.engine.node, platform: native.engine.platform, arch: native.engine.arch },
    executable: stem, sha256: sha(readFileSync(service)),
    webService: { format: 1, mode: 'web', profile: 'map-web' },
    install: native.install, coreModules: 1, sourceCoreFiles: 0,
    notices, noticesSha256: sha(readFileSync(join(app, notices))), resources,
    sourceDigest: 'a'.repeat(64), smokes: { config: true, worker: true, system: true, terminal: true },
  }, null, 2) + '\n')
  const source = join(root, 'source')
  mkdirSync(join(source, 'map/release/public'), { recursive: true })
  mkdirSync(join(source, '.dsh-build'))
  mkdirSync(join(source, 'scripts/primary-runtime'), { recursive: true })
  writeFileSync(join(source, 'map/release/version.json'), JSON.stringify({ version: productVersion }) + '\n')
  cpSync(join(repo, 'map/release/install.json'), join(source, 'map/release/install.json'))
  for (const [path, sourceFile] of [
    ['packages/core/session/src/types.ts', 'packages/core/session/src/types.ts'],
    ['map/spatial-storage/src/schema.ts', 'map/spatial-storage/src/schema.ts'],
    ['map/spatial-accessibility/src/runs.ts', 'map/spatial-accessibility/src/runs.ts'],
    ['packages/storage/storage-sqlite/src/schema.ts', 'packages/storage/storage-sqlite/src/schema.ts'],
  ]) cpSync(join(repo, path), join(source, sourceFile))
  writeFileSync(join(source, '.dsh-build/map-public-release.json'), JSON.stringify({ sources: { sha256: 'a'.repeat(64) } }))
  for (const name of ['web-service.json', 'source-offers.md', 'start-web.sh', 'start-web.cmd', 'start-web.ps1']) {
    cpSync(join(repo, 'map/release', name), join(source, 'map/release', name))
  }
  for (const name of ['README.md', 'README.zh.md']) {
    cpSync(join(repo, 'map/release/public', name), join(source, 'map/release/public', name))
  }
  cpSync(join(repo, 'scripts/primary-runtime/lock.json'), join(source, 'scripts/primary-runtime/lock.json'))
  writeFileSync(join(source, 'LICENSE'), 'Map license\n')
  writeFileSync(join(source, 'THIRD_PARTY_NOTICES.md'), 'Third-party notices\n')
  const packed = await packWebService({ root: source, applicationDirectories: [app], out: join(root, 'out') })
  const extracted = join(root, 'portable archive 中文')
  mkdirSync(extracted)
  await extractQualificationArchive(packed.archive, extracted, process.platform)
  const roots = readdirSync(extracted, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  assert.deepEqual(roots, [`map-harness-v${productVersion}-web-${hostTarget}`])
  assert.equal(join(extracted, roots[0]).startsWith(repo), false, 'package must launch outside the checkout')
  rmSync(app, { recursive: true, force: true })
  rmSync(source, { recursive: true, force: true })
  return { packageRoot: join(extracted, roots[0]) }
}

function tree(directory) {
  if (!existsSync(directory)) return []
  return filesBelow(directory).map(file => [file, sha(readFileSync(join(directory, file)))])
}

function poisonPath(root) {
  const directory = join(root, 'poison-bin')
  mkdirSync(directory, { recursive: true })
  const log = join(root, 'poison.log')
  for (const name of ['node', 'dsh', 'python', 'python3', 'npm', 'pnpm']) {
    const file = join(directory, name)
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$MAPHARNESS_POISON_LOG"\nexit 42\n`)
    chmodSync(file, 0o755)
  }
  return { path: `${directory}:${qualificationPlatform(process.platform, process.env).path}`, log }
}

// No --port by default: the shipped default (6425) is what the portable package must bind.
function launch(resources, packageRoot, home, environment, args = ['--no-onboarding', '--no-open']) {
  const child = spawn(join(packageRoot, 'start-web.sh'), args, {
    cwd: packageRoot,
    env: { HOME: home, USERPROFILE: home, ...environment },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const closed = new Promise(resolveClose => {
    let spawnError
    child.once('error', error => { spawnError = error })
    child.once('close', (code, signal) => resolveClose({ code, signal, error: spawnError }))
  })
  const fixture = { child, closed, stdout: () => stdout, stderr: () => stderr }
  resources.processes.push(fixture)
  return fixture
}

/** Readiness is a complete output line, not elapsed time or an independently chosen port. */
function waitFor(fixture, pattern, timeoutMs = 30000) {
  return new Promise((resolveReady, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      fixture.child.stdout.off('data', inspect)
      fixture.child.off('error', onError)
      fixture.child.off('close', onClose)
    }
    const inspect = () => {
      const match = fixture.stdout().match(pattern)
      if (match === null) return
      cleanup()
      resolveReady(match)
    }
    const onError = error => { cleanup(); reject(error) }
    const onClose = (code, signal) => { cleanup(); reject(fixture.child.spawnError ?? new Error(`service exited before readiness (${code ?? signal}): ${fixture.stderr()}`)) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`service readiness timed out: ${fixture.stderr()}`)) }, timeoutMs)
    fixture.child.stdout.on('data', inspect)
    fixture.child.once('error', onError)
    fixture.child.once('close', onClose)
    inspect()
  })
}

async function stop(fixture) {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) return fixture.closed
  try { process.kill(-fixture.child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  const timer = setTimeout(() => {
    try { process.kill(-fixture.child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }, 15000)
  try { return await fixture.closed } finally { clearTimeout(timer) }
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

test('portable archive runs a standalone Map instance from a real extracted package', { timeout: 300000, skip: process.platform === 'win32' && 'POSIX portable archive launcher' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-portable-e2e-')))
  const resources = { roots: [root], processes: [] }
  t.after(async () => {
    await Promise.all(resources.processes.map(service => stop(service)))
    for (const directory of resources.roots) rmSync(directory, { recursive: true, force: true })
  })
  const engine = fixtureEngine()
  if (engine === undefined) return t.skip('portable isolation needs a SEA-capable Node (set MAP_NATIVE_ENGINE)')
  const engineVersion = spawnSync(engine, ['-p', 'process.version'], { encoding: 'utf8' }).stdout.trim()
  if (engineVersion !== `v${runtimeLock.nodeVersion}`) return t.skip(`portable isolation needs the locked engine v${runtimeLock.nodeVersion} (MAP_NATIVE_ENGINE)`)
  const built = await buildPortablePackage(resources, engine)
  const poison = poisonPath(root)
  const userHome = join(root, 'home 用户')
  mkdirSync(userHome)
  for (const [file, bytes] of [['.dsh/settings.yaml', 'stock-settings: true\n'], ['.dsh/.credentials.yaml', 'DEEPSEEK_API_KEY: stock-secret\n'], ['.dsh/sessions/stock.jsonl', '{"type":"stock"}\n'], ['.agents/skills/stock.md', '# stock skill\n']]) {
    mkdirSync(dirname(join(userHome, file)), { recursive: true })
    writeFileSync(join(userHome, file), bytes)
  }
  const stockBefore = tree(userHome)
  const env = {
    PATH: poison.path,
    MAPHARNESS_POISON_LOG: poison.log,
    DSH_HOME: join(userHome, '.dsh'), DSH_AGENTS_HOME: join(userHome, '.agents'),
    DSH_RESOURCE_CACHE: join(userHome, '.cache', 'deepseek-harness'),
    DSH_BUNDLED_PRIMARY_RUNTIME: '/stale/runtime', DSH_BUNDLED_OFFICE_CLI: '/stale/office',
  }
  const mapHome = join(userHome, '.map-harness')
  let running = launch(resources, built.packageRoot, userHome, env)
  let first
  await t.test('default data root, stock sentinels and poisoned PATH stay independent', async () => {
    await waitFor(running, /map-harness web: (http:\/\/127\.0\.0\.1:6425\/\?token=[^\s]+)/u)
    first = JSON.parse(running.stdout().match(/^\{.*"kind":"map-harness-portable-witness".*\}$/mu)[0])
    assert.equal(first.home, mapHome)
    assert.equal(first.dshHome, mapHome)
    assert.equal(first.agentsHome, join(mapHome, 'agents'))
    assert.equal(first.resourceCache, join(mapHome, 'cache', 'runtime'))
    assert.match(first.namespace, /^map-harness:[a-f0-9-]{36}$/u)
    assert.equal(first.path, poison.path)
    const marker = readJson(join(mapHome, 'map-instance.json'))
    assert.equal(marker.format, 'map-harness-instance-1')
    assert.equal(marker.productId, 'map-harness')
    assert.equal(marker.mode, 'release')
    assert.equal(marker.channel, 'stable')
    assert.equal(marker.checkoutKey, null)
    assert.equal(marker.instanceId, first.instanceId)
    assert.equal(existsSync(join(mapHome, 'profiles/map-web/package.json')), true)
    assert.equal(existsSync(join(mapHome, 'agents')), true)
    assert.equal(existsSync(join(mapHome, 'cache/runtime')), true)
    const response = await fetch(running.stdout().match(/map-harness web: (\S+)/u)[1])
    assert.equal(response.status, 200)
    assert.match(await response.text(), /map-harness-portable/u)
    assert.deepEqual(tree(userHome).filter(([file]) => STOCK_PREFIXES.some(prefix => file.startsWith(prefix))), stockBefore)
    assert.equal(existsSync(poison.log) ? readFileSync(poison.log, 'utf8') : '', '')
    if (POSIX) {
      assert.equal(statSync(mapHome).mode & 0o777, 0o700)
      assert.equal(statSync(join(mapHome, 'map-instance.json')).mode & 0o777, 0o600)
      assert.equal(statSync(join(mapHome, 'map-run/instance.lock')).mode & 0o777, 0o600)
    }
  })

  await t.test('a restart preserves the instance id, profile bytes and witness data', async () => {
    const markerBytes = readFileSync(join(mapHome, 'map-instance.json'))
    const profileBytes = readFileSync(join(mapHome, 'profiles/map-web/package.json'))
    const ended = await stop(running)
    assert.equal(ended.signal, null)
    assert.equal(ended.code, 0)
    assert.equal(readJson(join(mapHome, 'map-run/instance.json')).state, 'stopped')
    running = launch(resources, built.packageRoot, userHome, env)
    await waitFor(running, /map-harness web: http:/u)
    const second = JSON.parse(running.stdout().match(/^\{.*"kind":"map-harness-portable-witness".*\}$/mu)[0])
    assert.equal(second.boot, 2)
    assert.equal(second.instanceId, first.instanceId)
    assert.deepEqual(readFileSync(join(mapHome, 'map-instance.json')), markerBytes)
    assert.deepEqual(readFileSync(join(mapHome, 'profiles/map-web/package.json')), profileBytes)
    const records = readFileSync(join(mapHome, 'sessions/portable-witness.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.map(record => record.boot), [1, 2])
    assert.ok(records.every(record => record.instanceId === first.instanceId))
    assert.deepEqual(tree(userHome).filter(([file]) => file.startsWith('.dsh/') || file.startsWith('.agents/')), stockBefore.filter(([file]) => file.startsWith('.dsh/') || file.startsWith('.agents/')))
  })

  await t.test('a second instance reports MAP_INSTANCE_BUSY without writing the live root', async () => {
    const liveBefore = tree(mapHome)
    // An explicit port keeps the port out of the picture: the rival must be refused by the data-root lock.
    const rival = launch(resources, built.packageRoot, userHome, env, ['--no-onboarding', '--no-open', '--port', '0'])
    const ended = await rival.closed
    assert.equal(ended.signal, null)
    assert.notEqual(ended.code, 0)
    assert.match(rival.stderr(), /MAP_INSTANCE_BUSY/u)
    assert.match(rival.stderr(), /Another Map instance (?:already runs|holds this data root)/u)
    assert.deepEqual(tree(mapHome), liveBefore)
    const response = await fetch(running.stdout().match(/map-harness web: (\S+)/u)[1])
    assert.equal(response.status, 200)
  })

  await t.test('diagnostics stay read-only while the service owns the root', async () => {
    const liveBefore = tree(mapHome)
    const dump = spawnSync(join(built.packageRoot, 'start-web.sh'), ['--dump-config', '--no-open'], {
      cwd: built.packageRoot, env: { HOME: userHome, USERPROFILE: userHome, ...env }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(dump.status, 0, dump.stderr)
    const report = JSON.parse(dump.stdout.trim().split('\n').find(line => line.includes('map-harness-portable-dump')))
    assert.equal(report.home.includes('map-instance-diagnostic-'), true)
    assert.ok(report.argv.includes('--dump-config'))
    assert.deepEqual(tree(mapHome), liveBefore)
    for (const argument of ['--help', '--version']) {
      const fresh = mkdtempSync(join(tmpdir(), 'map-portable-help-'))
      try {
        const result = spawnSync(join(built.packageRoot, 'start-web.sh'), [argument], {
          cwd: built.packageRoot, env: { HOME: fresh, USERPROFILE: fresh, PATH: poison.path }, encoding: 'utf8', timeout: 60000,
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, argument === '--help' ? /MAPHARNESS_HOME/u : new RegExp(`map-harness v${productVersion.replaceAll('.', '\\.')}`, 'u'))
        assert.equal(existsSync(join(fresh, '.map-harness')), false)
      } finally { rmSync(fresh, { recursive: true, force: true }) }
    }
  })

  await t.test('MAPHARNESS_HOME overrides the default root', async () => {
    const overrideHome = join(root, 'custom map 数据')
    const user = join(root, 'override-user')
    mkdirSync(user)
    // The default-port instance is still live, so this second service passes an explicit --port, as a person would.
    const service = launch(resources, built.packageRoot, user, { PATH: poison.path, MAPHARNESS_HOME: overrideHome }, ['--no-onboarding', '--no-open', '--port', '0'])
    try {
      await waitFor(service, /map-harness web: http:/u)
      const report = JSON.parse(service.stdout().match(/^\{.*"kind":"map-harness-portable-witness".*\}$/mu)[0])
      assert.equal(report.home, overrideHome)
      assert.equal(readJson(join(overrideHome, 'map-instance.json')).instanceId, report.instanceId)
      assert.equal(existsSync(join(user, '.map-harness')), false)
    } finally {
      await stop(service)
      const ended = await service.closed
      assert.equal(ended.signal, null)
    }
  })

  const ended = await stop(running)
  assert.equal(ended.signal, null)
  assert.equal(ended.code, 0)
  assert.equal(existsSync(poison.log) ? readFileSync(poison.log).toString() : '', '')
})
