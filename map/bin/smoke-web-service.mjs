#!/usr/bin/env node
/** Run a source-free script package outside the checkout and qualify its real Web service. */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNativeWindows, extractQualificationArchive, qualificationPlatform, windowsQualificationProcesses, windowsQualificationSession } from './web-service-qualification-platform.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sha256 = value => createHash('sha256').update(value).digest('hex')

/**
 * Validate that an archive, manifest and target build record describe one package.
 * @param {string} archive Absolute archive path.
 * @param {string} manifest Absolute manifest path.
 * @param {string} target Wanted target or `host`.
 * @param {string} packageRoot Extracted package root.
 * @param {{platform: string, arch: string}} host Actual platform and architecture.
 * @returns {object} Hashes and normalized manifest/build record.
 */
export function validateWebServiceRuntimeInputs(archive, manifest, target = 'host', packageRoot = dirname(manifest), host = process) {
  const manifestBytes = readFileSync(manifest)
  const parsed = JSON.parse(manifestBytes)
  if (parsed.format !== 1 || parsed.product !== 'map-harness') throw new Error('Web service manifest identity is invalid.')
  const actual = `${host.platform === 'darwin' ? 'mac' : host.platform === 'win32' ? 'win' : host.platform}-${host.arch}`
  const wanted = target === 'host' ? actual : target
  if (wanted !== actual) throw new Error(`Web service qualification target ${wanted} does not match host ${actual}.`)
  if (!parsed.supportedTargets?.includes(wanted) || parsed.unsupportedTargets?.includes(wanted)) {
    throw new Error(`Web service archive does not support ${wanted}.`)
  }
  const targetRow = parsed.targets?.find(row => row.target === wanted)
  if (targetRow === undefined) throw new Error('Web service target record is missing.')
  const recordBytes = readFileSync(join(packageRoot, targetRow.record))
  const record = JSON.parse(recordBytes)
  if (record.version !== parsed.version || record.target !== wanted || record.sourceCoreFiles !== 0
    || record.webService?.mode !== 'web' || record.webService?.profile !== 'map-web') {
    throw new Error('Web service build record does not match its manifest.')
  }
  const recordEntry = parsed.files.find(row => row.path === targetRow.record)
  const serviceEntry = parsed.files.find(row => row.role === 'service' && row.target === wanted)
  if (recordEntry === undefined || recordEntry.sha256 !== sha256(recordBytes) || serviceEntry === undefined || serviceEntry.sha256 !== record.sha256) {
    throw new Error('Web service manifest does not bind its service and build record.')
  }
  return { archiveSha256: sha256(readFileSync(archive)), manifestSha256: sha256(manifestBytes),
    buildRecordSha256: sha256(recordBytes), manifest: parsed, record, target: wanted }
}

function filesBelow(root, prefix = '') {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? filesBelow(join(root, entry.name), file) : [file]
  }).sort()
}

function stableTree(root) {
  return filesBelow(root).map(file => ({ file, sha256: sha256(readFileSync(join(root, file))) }))
}

async function launchService(packageRoot, home, settings, executable) {
  const launcher = join(packageRoot, settings.launcher)
  // No --port: the smoke exercises the shipped default (6425).
  const args = ['--no-onboarding', '--host', '127.0.0.1', '--no-open']
  // DSH_* roots stay absent: the native entry resolves and bridges the Map home itself.
  const env = { ...process.env, HOME: dirname(home), MAPHARNESS_HOME: home, PATH: settings.path }
  if (process.platform === 'win32') {
    const pty = await import('node-pty')
    return windowsQualificationSession(pty, launcher, args, env, packageRoot, { executable })
  }
  const child = spawn(launcher, args, {
    cwd: packageRoot,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024) })
  child.stderr.resume()
  return { child, result: new Promise((resolve, reject) => {
    let poll
    const timer = setTimeout(() => reject(new Error('Web service startup timed out.')), 120000)
    child.once('error', error => { clearTimeout(timer); clearInterval(poll); reject(error) })
    child.once('exit', (status, signal) => { clearTimeout(timer); clearInterval(poll); reject(new Error(`Web service exited before ready: ${status ?? signal}`)) })
    poll = setInterval(() => {
      const match = stdout.match(/map-harness web: (http:\/\/127\.0\.0\.1:6425\/\?token=[^\s]+)/)
      if (match === null) return
      clearInterval(poll)
      clearTimeout(timer)
      resolve(match[1])
    }, 100)
  }) }
}

async function stopService(service) {
  if (service.stop) return service.stop()
  if (service.child.exitCode !== null || service.child.signalCode !== null) throw new Error('Web service exited before shutdown.')
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Web service did not stop cleanly.')), 30000)
    service.child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  try { process.kill(-service.child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await exited
  if (service.child.exitCode !== 0 || service.child.signalCode !== null) throw new Error('Web service did not complete graceful shutdown.')
}

async function abortService(service) {
  if (service.abort) return service.abort()
  if (service.child.pid === undefined) return
  if (service.child.exitCode !== null || service.child.signalCode !== null) return
  const exited = new Promise(resolveExit => service.child.once('exit', resolveExit))
  try { process.kill(-service.child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error('Web service cleanup timed out.')), 5000)
    exited.then(() => { clearTimeout(timer); resolveWait() })
  })
}

function processReferences(root) {
  if (process.platform === 'win32') return windowsQualificationProcesses(root, process.env)
  const listed = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`Cannot inspect processes: ${listed.stderr}`)
  return listed.stdout.split('\n').filter(line => line.includes(root)).map(line => line.trim().split(/\s+/u)[0])
}

/**
 * Restrict a scenario report to its own temporary home and workspace.
 * @param {object} scenario Runtime report from the browser scenario.
 * @returns {{temp: string, home: string, workspace: string}} Canonical paths owned by that scenario.
 */
export function qualificationScenarioPaths(scenario) {
  if (!scenario || ['temp', 'home', 'workspace'].some(key => typeof scenario[key] !== 'string')) {
    throw new Error('Web service scenario returned unsafe paths.')
  }
  const tempRoot = realpathSync(tmpdir()), temp = realpathSync(scenario.temp)
  const local = relative(tempRoot, temp)
  if (!local || isAbsolute(local) || local.startsWith('..') || !basename(temp).startsWith('map-web-qualification-')) {
    throw new Error('Web service scenario returned an unsafe temporary directory.')
  }
  const home = realpathSync(scenario.home), workspace = realpathSync(scenario.workspace)
  const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path
  if (normalize(home) !== normalize(join(temp, 'home')) || normalize(workspace) !== normalize(join(temp, 'workspace'))) {
    throw new Error('Web service scenario returned unsafe home or workspace paths.')
  }
  return { temp, home, workspace }
}

/**
 * Extract and qualify a script-launched Web service package.
 * @param {object} options Archive, manifest, target and output directory.
 * @returns {Promise<object>} Qualification record paths and checks.
 */
export async function smokeWebService({ archive, manifest, target = 'host', out }) {
  mkdirSync(out, { recursive: true })
  const lock = join(out, '.web-service-qualification.lock')
  let fd
  try {
    fd = openSync(lock, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Web service qualification is already running for this output.')
    throw error
  }
  try {
    rmSync(join(out, 'web-service-qualification.json'), { force: true })
    if (!existsSync(archive) || !existsSync(manifest)) throw new Error('Web service archive or manifest is missing.')
    return await runSmokeWebService({ archive, manifest, target, out })
  } finally {
    closeSync(fd)
    rmSync(lock, { force: true })
  }
}

async function runSmokeWebService({ archive, manifest, target, out }) {
  const settings = qualificationPlatform(process.platform, process.env)
  const work = mkdtempSync(join(tmpdir(), 'map-web-service-smoke-'))
  const extracted = join(work, 'extracted')
  let scenarioTemp, activeService
  mkdirSync(extracted)
  try {
    if (process.platform === 'win32') assertNativeWindows(process.env)
    await extractQualificationArchive(archive, extracted, process.platform)
    const directories = readdirSync(extracted, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    if (directories.length !== 1) throw new Error('Web service archive must contain one root directory.')
    const packageRoot = join(extracted, directories[0])
    if (packageRoot === ROOT || packageRoot.startsWith(`${ROOT}/`)) throw new Error('Web service must be extracted outside the checkout.')
    if (!readFileSync(manifest).equals(readFileSync(join(packageRoot, 'web-service-manifest.json')))) {
      throw new Error('Web service external and packaged manifests differ.')
    }
    const inputs = validateWebServiceRuntimeInputs(archive, manifest, target, packageRoot)
    const serviceRow = inputs.manifest.files.find(row => row.role === 'service' && row.target === inputs.target)
    const executable = join(packageRoot, serviceRow.path)
    const reportPath = join(work, 'runtime-report.json')
    const artifacts = join(out, 'qualification-evidence')
    mkdirSync(artifacts, { recursive: true })
    const test = spawnSync(process.execPath, [
      '--test', '--test-name-pattern=^P3-visualization workbench: viz_classify styles the map and the Web panel passes ARIA checks$',
      join(ROOT, 'map/arcgis-mcp/tests/composition.e2e.mjs'),
    ], {
      cwd: ROOT,
      env: { ...process.env, MAP_APPLICATION_LAUNCHER: join(packageRoot, settings.launcher), MAP_APPLICATION_CWD: packageRoot,
        MAP_APPLICATION_MINIMAL_PATH: '1', MAP_FACILITY_ARTIFACTS: artifacts, MAP_APPLICATION_RUNTIME_REPORT: reportPath },
      stdio: 'inherit',
      timeout: 300000,
    })
    if (test.error || test.status !== 0) throw new Error(`Browser Web service scenario failed: ${test.error?.message ?? test.status}`)
    const scenario = qualificationScenarioPaths(JSON.parse(readFileSync(reportPath, 'utf8')))
    scenarioTemp = scenario.temp
    const persistedRoots = [join(scenario.home, 'profiles'), join(scenario.home, '.agent-presets'),
      join(scenario.home, 'sessions'), scenario.workspace].map(root => stableTree(root))
    activeService = await launchService(packageRoot, scenario.home, settings, executable)
    const firstUrl = await activeService.result
    if (!firstUrl.startsWith('http://127.0.0.1:')) throw new Error('Web service did not bind a loopback URL.')
    await stopService(activeService)
    activeService = undefined
    activeService = await launchService(packageRoot, scenario.home, settings, executable)
    await activeService.result
    await stopService(activeService)
    activeService = undefined
    const afterRoots = [join(scenario.home, 'profiles'), join(scenario.home, '.agent-presets'),
      join(scenario.home, 'sessions'), scenario.workspace].map(root => stableTree(root))
    if (JSON.stringify(persistedRoots) !== JSON.stringify(afterRoots)) throw new Error('Web service restart changed persisted profile, session or workspace data.')
    const residue = processReferences(packageRoot)
    if (residue.length > 0) throw new Error(`Web service left processes: ${residue.join('; ')}`)
    const qualification = {
      format: 'map-harness-web-qualification-1',
      product: inputs.manifest.product,
      version: inputs.manifest.version,
      target: inputs.target,
      archive: basename(archive),
      archiveSha256: inputs.archiveSha256,
      manifestSha256: inputs.manifestSha256,
      buildRecordSha256: inputs.buildRecordSha256,
      sourceDigest: inputs.record.sourceDigest,
      runtime: { platform: process.platform, arch: process.arch, node: inputs.record.engine.node,
        v8: inputs.record.engine.v8, cwdOutsideCheckout: true,
        minimalPath: settings.recordedPath },
      checks: { browserScenario: { passed: true, evidence: 'qualification-evidence' },
        restartDataPreservation: { passed: true, roots: ['profiles', '.agent-presets', 'sessions', 'workspace'] },
        cleanExit: { passed: true }, noResidualProcesses: { passed: true } },
    }
    const qualificationPath = join(out, 'web-service-qualification.json')
    const staging = mkdtempSync(join(out, '.qualification-'))
    try {
      const temporary = join(staging, 'record.json')
      writeFileSync(temporary, JSON.stringify(qualification, null, 2) + '\n')
      renameSync(temporary, qualificationPath)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return { qualificationPath, evidence: artifacts, archive: inputs.archiveSha256 }
  } finally {
    let stopped = activeService === undefined
    try {
      if (activeService !== undefined) {
        await abortService(activeService)
        stopped = true
      }
    } finally {
      if (stopped) {
        rmSync(work, { recursive: true, force: true })
        if (scenarioTemp !== undefined) rmSync(scenarioTemp, { recursive: true, force: true })
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const value = name => { const at = argv.indexOf(name); return at >= 0 ? resolve(argv[at + 1]) : undefined }
  const archive = value('--archive'), manifest = value('--manifest'), out = value('--out')
  const targetAt = argv.indexOf('--target')
  const target = targetAt >= 0 ? argv[targetAt + 1] : 'host'
  if (archive === undefined || out === undefined) {
    console.error('smoke-web-service: usage: --archive <file> [--manifest <file>] [--target host] --out <dir>')
    process.exit(1)
  }
  const result = await smokeWebService({ archive, manifest: manifest ?? join(dirname(archive), 'web-service-manifest.json'), target, out })
  console.log(JSON.stringify(result))
}
