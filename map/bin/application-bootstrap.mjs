/** Private entry for the installed map application and its fixed compiled worker. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { spawnSync } from 'node:child_process'
import { bridgeEnvironment, MAP_IDENTITY_REVISION, MapHomeError, prepareMapInstance } from './instance-home.mjs'
import { acquireInstanceLock } from './instance-lock.mjs'
import { createInstallDescriptor, MapInstallError } from './install-manifest.mjs'
import { applyMapEnvironment, externalMapEnvironment, mapEntryEnvironment, mapEntryMode, prepareMapDiagnostic, resolveMapEntry } from './instance-preload.mjs'

const root = dirname(fileURLToPath(import.meta.url))

const require = createRequire(import.meta.url)
require('bytenode')
const manifest = JSON.parse(readFileSync(join(root, 'map-application.json')))
if (manifest.node !== process.version || manifest.v8 !== process.versions.v8
  || manifest.platform !== process.platform || manifest.arch !== process.arch
  || manifest.cachedDataVersionTag !== v8.cachedDataVersionTag()) {
  throw new Error(`The map application engine does not match its compiled core (${process.version}/${process.versions.v8}/${v8.cachedDataVersionTag()}); reinstall this platform build.`)
}
for (const [file, expected] of Object.entries({ ...manifest.binaries, ...manifest.facades })) {
  if (createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== expected) {
    throw new Error('The compiled map core is incomplete or changed; reinstall this application.')
  }
}

const args = process.argv.slice(2)
const programRoot = 'pkg' in process ? dirname(process.execPath) : root
const aclRunner = process.platform === 'win32' ? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')) : undefined
/** @param {object} value embedded installation identity; absent fields stay absent, never defaulted */
function validatedInstall(value) {
  const fields = ['product', 'distribution', 'channel', 'identityRevision', 'dataCompatibility']
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.product !== 'map-harness'
    || value.identityRevision !== MAP_IDENTITY_REVISION || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))) {
    throw new MapHomeError('MAP_INSTALL_SCHEMA', 'Reinstall this build: its embedded installation identity is missing or unsupported.')
  }
  try {
    return { ...createInstallDescriptor({
      distribution: value.distribution, channel: value.channel,
      dataCompatibility: value.dataCompatibility,
    }), productVersion: manifest.version }
  } catch (error) {
    if (error instanceof MapInstallError) {
      throw new MapHomeError('MAP_INSTALL_SCHEMA', `Reinstall this build: its embedded installation identity is invalid (${error.code}).`, { reason: error.code }, { cause: error })
    }
    throw error
  }
}
/** Installation identity is required only when an entry actually resolves a data home. */
const identity = () => ({ mode: 'release', ...validatedInstall(manifest.install) })
const DUMP_COMMANDS = ['--dump-config', '--dump-default-config', '--dump-config-schema']

/** Product help that never imports the upstream CLI, writes a profile, or wakes the scheduler. */
function printHelp() {
  const defaultHome = identity().channel === 'preview' ? '~/.map-harness-preview' : '~/.map-harness'
  console.log(`map-harness v${manifest.version} — 独立安装的 Map Harness。
数据目录：${defaultHome}（可用 MAPHARNESS_HOME 覆盖；与 DeepSeek Harness 的 ~/.dsh 完全独立）
用法：
  start-web.sh|start-web.cmd [选项]     启动本地 Web 服务（默认 127.0.0.1:6425）
  --no-onboarding                       跳过引导，直接按已保存凭据启动
  --port <n> / --host <h>               显式端口与监听地址
  --patch <file>                        追加 Cordis 配置补丁
  --version, -v                         显示产品版本
诊断（只读，不启动服务、不写数据目录）：
  --dump-config                         打印实际 profile 的合成配置
  --dump-default-config                 打印默认配置
  --dump-config-schema                  打印配置 schema
完整文档见发行包 README。`)
}

/** Compose a profile in a disposable copy so diagnostics never write the live home. */
async function runDiagnostic(argv) {
  const invocation = profileInvocation(argv)
  const entry = resolveEntry()
  const diagnostic = prepareMapDiagnostic(entry, { initializeProfile: initializeInstalledProfile, profile: invocation.profile })
  try {
    applyMapEnvironment({ ...entry.environment, ...bridgeEnvironment(diagnostic.spec),
      MAPHARNESS_BROWSER_NAMESPACE: '', MAPHARNESS_COMPILED_APP: '1' })
    process.argv.splice(2, process.argv.length - 2, ...invocation.argv)
    await import('./dsh-runtime-bootstrap.mjs')
  } finally { diagnostic.dispose() }
}

/** Keep launcher options before application options while preserving each group's order. */
function profileInvocation(argv) {
  const tokens = argv[0] === 'web' ? argv.slice(1) : [...argv]
  const launcherFlags = [], applicationArgs = []
  let profile = 'map-web'
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (['--patch', '--profile', '-p', '--from-default-profile'].includes(token)) {
      const value = tokens[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new MapHomeError('MAP_ENTRY_ARGUMENT', `${token} requires a value.`)
      }
      if (token === '--profile' || token === '-p') profile = value
      launcherFlags.push(token === '-p' ? '--profile' : token, value)
      index += 1
    } else if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length)
      launcherFlags.push(token)
    } else if (token.startsWith('--patch=') || token.startsWith('--from-default-profile=') || DUMP_COMMANDS.includes(token)) {
      launcherFlags.push(token)
    } else applicationArgs.push(token)
  }
  if (!tokens.some(token => token === '--profile' || token === '-p' || token.startsWith('--profile='))) launcherFlags.unshift('--profile', profile)
  return { profile, argv: [...launcherFlags, ...applicationArgs] }
}

const resolveEntry = () => resolveMapEntry({ programRoot, identity: identity(), fixedWorker: args[0] === '--map-harness-internal-worker' || (aclRunner !== undefined && args[0] === aclRunner) })
const publicArgs = (args[0] === '--web-onboarding' ? args.slice(1) : args).filter(arg => arg !== '--no-onboarding')
const publicDiagnostic = args[0] !== 'manage' && !args[0]?.startsWith('--application-')
  && args[0] !== '--map-harness-internal-worker' && mapEntryMode(publicArgs) === 'diagnostic'
if (publicDiagnostic) {
  if (publicArgs.some(arg => ['--version', '-v', '-V'].includes(arg))) console.log(`map-harness v${manifest.version}`)
  else if (publicArgs.some(arg => ['--help', '-h'].includes(arg))) printHelp()
  else await runDiagnostic(publicArgs)
} else if (args[0] === '--web-onboarding') {
  const entry = resolveEntry()
  const { mainWebOnboarding } = await import('./web-onboarding.mjs')
  let onboarding
  try {
    onboarding = await mainWebOnboarding(args, entry, programRoot)
  } catch (error) {
    if (!(error instanceof MapHomeError)) throw error
    console.error(`map-harness: ${error.code}: ${error.message}`)
    process.exitCode = 3
  }
  if (onboarding?.direct !== undefined) await runApplication(['web', ...onboarding.direct], entry)
} else if (args[0] === '--map-harness-internal-worker') {
  if (args.length !== 1) throw new Error('The internal map worker accepts its request on stdin only.')
  const entry = resolveEntry()
  if (entry.internal !== true) throw new MapHomeError('MAP_ENTRY_CONTEXT', 'The internal map worker is reserved for admitted Map children; restart from the product launcher.')
  applyMapEnvironment(mapEntryEnvironment(entry, programRoot))
  const worker = { exports: {} }
  require('bytenode').runBytecode(readFileSync(join(root, 'map-worker.jsc'))).call(worker.exports,
    worker.exports, require, worker, join(root, 'map-worker.jsc'), root)
} else if (args[0] === '--application-info') {
  console.log(JSON.stringify({ version: manifest.version, node: manifest.node, v8: manifest.v8,
    platform: manifest.platform, arch: manifest.arch, coreModules: manifest.coreModules }))
} else if (args[0] === '--application-sdk-check') {
  await withCheckInstance(async () => {
    const { createPlaywrightSdkBridge } = await import('@map-harness/spatial-accessibility')
    const bridge = await createPlaywrightSdkBridge()
    try {
      const page = await bridge.open('data:text/html,<title>map-sdk-check</title>')
      try {
        if (await page.evaluate('document.title') !== 'map-sdk-check') throw new Error('Compiled SDK browser bridge failed.')
      } finally { await page.close() }
      console.log(JSON.stringify({ sdk: true }))
    } finally { await bridge.close() }
  })
} else if (args[0] === '--application-system-check') {
  const rg = process.platform === 'win32' ? process.execPath.replace(/\.exe$/iu, '-rg.exe') : process.execPath + '-rg'
  const search = spawnSync(rg, ['--version'], { encoding: 'utf8', timeout: 30000 })
  if (search.status !== 0 || !search.stdout.startsWith('ripgrep ')) throw new Error('The installed search helper failed.')
  const pty = require('node-pty')
  await new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const terminal = pty.spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
      windows ? ['/d', '/s', '/c', 'echo map-native-pty'] : ['-c', 'printf map-native-pty'],
      { cols: 80, rows: 24, cwd: tmpdir(), env: process.env, ...(windows ? { useConptyDll: true } : {}) })
    let output = '', expired = false
    const timer = setTimeout(() => {
      expired = true
      try { terminal.kill() } catch { /* the terminal may have already released its worker */ }
    }, 30000)
    terminal.onData(data => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (expired || exitCode !== 0 || !output.includes('map-native-pty')) {
        try { terminal.kill() } catch { /* the timeout path may have already killed the terminal */ }
        reject(new Error('The installed terminal helper failed.'))
        return
      }
      try {
        terminal.kill()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  console.log(JSON.stringify({ search: true, terminal: true }))
} else if (args[0] === '--application-check') {
  await withCheckInstance(async temp => {
    const { correctPValues } = await import('@map-harness/spatial-statistics')
    const { ScaleJobRunner, SCALE_BUDGETS, SCALE_METHOD_VERSION } = await import('@map-harness/spatial-scale')
    if (JSON.stringify(correctPValues([0.01, 0.04], 'bonferroni')) !== '[0.02,0.08]') throw new Error('Compiled statistics check failed.')
    mkdirSync(join(temp, 'staging'))
    const runner = new ScaleJobRunner(join(temp, 'staging'), SCALE_BUDGETS)
    try {
      const bytes = Buffer.from('{"i":0,"p":{"value":5},"g":null}\n{"i":1,"p":{"value":9},"g":null}\n')
      const path = join(temp, 'chunk.jsonl')
      writeFileSync(path, bytes)
      const outcome = await runner.run({ methodVersion: SCALE_METHOD_VERSION, manifestPath: join(temp, 'manifest.json'),
        chunks: [{ path, start: 0, end: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }],
        predicate: { field: 'value', op: '>', value: 6 }, sampleRows: 2 })
      if (outcome.status !== 'succeeded' || outcome.result.rowsScanned !== 2 || outcome.result.aggregate.count !== 1
        || outcome.result.aggregate.sum !== 9) throw new Error(`Compiled worker check failed: ${JSON.stringify(outcome)}`)
      console.log(JSON.stringify({ statistics: true, worker: true }))
    } finally { await runner.dispose() }
  })
} else if (args[0] === 'manage') {
  // Maintenance owns its own installation lock and never starts the profile or instance lock.
  const { mainManage } = await import('./manage.mjs')
  const context = {
    env: externalMapEnvironment(process.env),
    cwd: process.cwd(),
    dataCompatibility: identity().dataCompatibility,
    installRoots: [programRoot],
    programRoot,
    manifest,
  }
  if (args[1] === 'import') {
    const [storage, scale, tools] = await Promise.all([
      import('@map-harness/spatial-storage'), import('@map-harness/spatial-scale'), import('@map-harness/map-tools'),
    ])
    context.owners = { storage, scale, toolNames: tools.SPATIAL_TOOL_CATALOG.map(row => row.name),
      compatibility: identity().dataCompatibility, require: createRequire(import.meta.resolve('@map-harness/map-tools/package.json')) }
  }
  const result = await mainManage(args.slice(1), context)
  console.log(args.includes('--json') || args[1] === 'import' ? JSON.stringify(result.json) : result.output)
  process.exitCode = result.exitCode
} else {
  await runApplication(args)
}

/** Private application checks admit a disposable instance for their fixed children, never the user's home. */
async function withCheckInstance(run) {
  const temporary = mkdtempSync(join(tmpdir(), 'map-application-check-'))
  const original = { ...process.env }
  try {
    const entry = resolveMapEntry({ programRoot, identity: identity(),
      env: { ...externalMapEnvironment(original), MAPHARNESS_HOME: join(temporary, 'home') } })
    entry.spec = prepareMapInstance(entry.spec)
    applyMapEnvironment({ ...mapEntryEnvironment(entry, programRoot), MAPHARNESS_COMPILED_APP: '1' })
    await run(temporary)
  } finally {
    applyMapEnvironment(original)
    rmSync(temporary, { recursive: true, force: true })
  }
}

/**
 * Create the installed profile and analyst preset in one home, atomically per file.
 * Writers other than the owner never share this root: callers acquire the service lock first.
 * @param {object} spec prepared or diagnostic instance whose home receives the profile
 * @returns {void}
 */
export function initializeInstalledProfile(spec) {
  const home = spec.home
  const profile = join(home, 'profiles/map-web')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const packageFile = join(profile, 'package.json')
  if (!existsSync(packageFile)) {
    // Write a complete sibling then rename, so an interrupted init never leaves half JSON at the final path.
    const temporary = join(profile, `.package-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(temporary, JSON.stringify({ name: 'map-harness-profile-map-web', private: true,
      dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@map-harness/map-web'] } } }, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, packageFile)
  }
  const patchFile = join(profile, 'cordis.patch.yml')
  if (!existsSync(patchFile)) {
    const temporary = join(profile, `.patch-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(temporary, '[]\n', { mode: 0o600 })
    renameSync(temporary, patchFile)
  }
  const preset = join(home, '.agent-presets/map-analyst')
  mkdirSync(preset, { recursive: true, mode: 0o700 })
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    const destination = join(preset, file)
    if (existsSync(destination)) continue
    const temporary = join(preset, `.${file}-${process.pid}.tmp`)
    writeFileSync(temporary, readFileSync(join(root, 'map-presets', file)), { mode: 0o600 })
    renameSync(temporary, destination)
  }
}

/**
 * Enter the installed Map Web profile after admitting its fixed data directory.
 * The service path acquires its lifetime writer lock before any profile write; a failed
 * runtime import releases it so no abandoned record claims a stopped service.
 * Internal dispatcher children only restore the validated bridge and never take the lock.
 * @param {string[]} args application or fixed-worker arguments
 * @param {object} [resolvedEntry] entry already admitted by the bootstrap dispatcher
 * @returns {Promise<void>} settles after the compiled runtime bootstrap imports
 */
export async function runApplication(args, resolvedEntry) {
  const admitted = resolvedEntry ?? resolveEntry()
  if (admitted.internal) {
    applyMapEnvironment({ ...mapEntryEnvironment(admitted, programRoot), MAPHARNESS_COMPILED_APP: '1' })
    await import('./dsh-runtime-bootstrap.mjs')
    return
  }
  if (aclRunner !== undefined && args[0] === aclRunner) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'The ACL runner requires an admitted Map child context.')
  }
  const invocation = profileInvocation(args)
  admitted.spec = prepareMapInstance(admitted.spec)
  applyMapEnvironment({ ...mapEntryEnvironment(admitted, programRoot), MAPHARNESS_COMPILED_APP: '1' })
  let lease
  try {
    lease = await acquireInstanceLock(admitted.spec, { version: manifest.version })
  } catch (error) {
    if (error instanceof MapHomeError) {
      console.error(`map-harness: ${error.code}: ${error.message}`)
      process.exitCode = 3
      return
    }
    throw error
  }
  try {
    initializeInstalledProfile(admitted.spec)
  } catch (error) {
    await lease.release()
    throw error
  }
  process.argv.splice(2, process.argv.length - 2, ...invocation.argv)
  try {
    await import('./dsh-runtime-bootstrap.mjs')
  } catch (error) {
    await lease.release()
    throw error
  }
}
