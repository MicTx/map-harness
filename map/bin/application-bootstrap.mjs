/** Private entry for the installed map application and its fixed compiled worker. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))

/** Create a missing home as an owner-only directory; parents keep their default mode. */
function ensureHome(home) {
  if (existsSync(home)) return
  mkdirSync(dirname(home), { recursive: true })
  try {
    mkdirSync(home, { mode: 0o700 })
  } catch (error) {
    // A concurrent first launch may create the same home between the check and mkdir.
    if (error?.code !== 'EEXIST') throw error
  }
}

/** Expand a leading `~`, `~/`, or `~\` the way the upstream home resolver does. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}
const require = createRequire(import.meta.url)
require('bytenode')
const manifest = JSON.parse(readFileSync(join(root, 'map-application.json')))
if (manifest.node !== process.version || manifest.v8 !== process.versions.v8
  || manifest.platform !== process.platform || manifest.arch !== process.arch
  || manifest.cachedDataVersionTag !== v8.cachedDataVersionTag()) {
  throw new Error('The map application engine does not match its compiled core; reinstall this platform build.')
}
for (const [file, expected] of Object.entries({ ...manifest.binaries, ...manifest.facades })) {
  if (createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== expected) {
    throw new Error('The compiled map core is incomplete or changed; reinstall this application.')
  }
}

const args = process.argv.slice(2)
if (args[0] === '--web-onboarding') {
  const { mainWebOnboarding } = await import('./web-onboarding.mjs')
  const onboarding = await mainWebOnboarding(args)
  if (onboarding?.direct !== undefined) await runApplication(['web', ...onboarding.direct])
} else if (args[0] === '--map-harness-internal-worker') {
  if (args.length !== 1) throw new Error('The internal map worker accepts its request on stdin only.')
  const worker = { exports: {} }
  require('bytenode').runBytecode(readFileSync(join(root, 'map-worker.jsc'))).call(worker.exports,
    worker.exports, require, worker, join(root, 'map-worker.jsc'), root)
} else if (args[0] === '--application-info') {
  console.log(JSON.stringify({ version: manifest.version, node: manifest.node, v8: manifest.v8,
    platform: manifest.platform, arch: manifest.arch, coreModules: manifest.coreModules }))
} else if (args[0] === '--application-sdk-check') {
  const { createPlaywrightSdkBridge } = await import('@map-harness/spatial-accessibility')
  const bridge = await createPlaywrightSdkBridge()
  try {
    const page = await bridge.open('data:text/html,<title>map-sdk-check</title>')
    try {
      if (await page.evaluate('document.title') !== 'map-sdk-check') throw new Error('Compiled SDK browser bridge failed.')
    } finally { await page.close() }
    console.log(JSON.stringify({ sdk: true }))
  } finally { await bridge.close() }
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
  process.env.MAPHARNESS_COMPILED_APP = '1'
  const { correctPValues } = await import('@map-harness/spatial-statistics')
  const { ScaleJobRunner, SCALE_BUDGETS, SCALE_METHOD_VERSION } = await import('@map-harness/spatial-scale')
  if (JSON.stringify(correctPValues([0.01, 0.04], 'bonferroni')) !== '[0.02,0.08]') throw new Error('Compiled statistics check failed.')
  const temp = mkdtempSync(join(tmpdir(), 'map-application-check-'))
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
  } finally {
    await runner.dispose()
    rmSync(temp, { recursive: true, force: true })
  }
} else if (args[0] === '--version' || args[0] === '-v') {
  console.log(`map-harness v${manifest.version}`)
} else {
  await runApplication(args)
}

/** Enter the installed Map Web profile after resolving its data directory. */
export async function runApplication(args) {
  process.env.MAPHARNESS_COMPILED_APP = '1'
  // The runtime and its workers read DSH_HOME, so a chosen home is forwarded resolved.
  const chosenHome = [process.env.MAPHARNESS_HOME, process.env.DSH_HOME].find(value => value?.trim())
  if (chosenHome !== undefined) process.env.DSH_HOME = resolve(expandHome(chosenHome))
  const aclRunner = process.platform === 'win32' ? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')) : undefined
  const internal = process.env.DSH_SUBPROCESS_RUNNER !== undefined || process.env.DSH_PTC_RUNTIME_NODE === '1'
    || process.env.DSH_RUNTIME_DOWNLOAD !== undefined || (aclRunner !== undefined && args[0] === aclRunner)
  if (!internal) {
    const home = chosenHome === undefined ? join(homedir(), '.dsh') : process.env.DSH_HOME
    ensureHome(home)
    const profile = join(home, 'profiles/map-web')
    if (!existsSync(join(profile, 'package.json'))) {
      mkdirSync(profile, { recursive: true, mode: 0o700 })
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'map-harness-profile-map-web', private: true,
        dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@map-harness/map-web'] } } }, null, 2) + '\n', { mode: 0o600 })
      writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
    }
    const preset = join(home, '.agent-presets/map-analyst')
    if (!existsSync(join(preset, 'agent.cordis.yml'))) {
      mkdirSync(preset, { recursive: true, mode: 0o700 })
      for (const file of ['preset.yml', 'agent.cordis.yml']) {
        const destination = join(preset, file)
        if (existsSync(destination)) continue
        writeFileSync(destination, readFileSync(join(root, 'map-presets', file)), { mode: 0o600 })
      }
    }
    if (args[0] === 'web') args.shift()
    const launcherFlags = [], applicationArgs = []
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--patch') {
        launcherFlags.push('--patch', args[index + 1] ?? '')
        index += 1
      } else applicationArgs.push(args[index])
    }
    if (!args.includes('--profile') && !args.includes('-p')) launcherFlags.unshift('--profile', 'map-web')
    process.argv.splice(2, process.argv.length - 2, ...launcherFlags, ...applicationArgs)
  }
  await import('./dsh-runtime-bootstrap.mjs')
}
