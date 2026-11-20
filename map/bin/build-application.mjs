#!/usr/bin/env node
/** Build one native-host map application with a fixed engine and compiled map core. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { downloadNodeRuntime, downloadPrimaryRuntimeAsset } from '../../scripts/primary-runtime/prepare.ts'
import { materializeStagedLinks, deduplicateStagedWorkspacePackages } from '../../scripts/build-exe-for-python-sdk-staging.ts'
import { restoreLegacyHoists } from '../../scripts/executable-packaging.ts'
import runtimeLock from '../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { assertCommunityEnvironment, assertPublicBuild, MAX_GIT_OUTPUT_BYTES, PUBLIC_BUILD_RECORD, readProductVersion } from './public-release-privacy.mjs'
import { filterPublicSources, publicReleaseInputs } from './pack-runtime.mjs'
import { runtimeBytes, runtimePackageManifests, isDependencyRuntimeSource, isDevelopmentFile } from './release-content.mjs'
import { sealApplication } from './application-sea.mjs'
import { auditApplicationSeal } from './application-core.mjs'
import { checkApplicationBrowser } from './application-browser-check.mjs'
import { assertWebApplicationMode, readWebServiceContract } from './web-service-contract.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CI: 'true' }, ...options })
  if (result.error || result.status !== 0) throw new Error(`Application build step failed: ${command}`)
}

function filesBelow(root) {
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const file = path ? `${path}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Application payload contains a symbolic link.')
    return entry.isDirectory() ? walk(file) : [file]
  })
  return walk('')
}

/**
 * Build only for the current architecture; code cache and native modules are not cross-platform assets.
 * @returns {{target: string, platform: string, arch: string}} host runtime target.
 */
export function applicationHost() {
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
  const target = `${platform}-${process.arch}`
  if (!Object.hasOwn(runtimeLock.targets, target)) throw new Error(`No locked application engine for ${target}.`)
  return { target, platform: process.platform, arch: process.arch }
}

/**
 * Stage the production DSH closure and verified map artifacts without linking back into the checkout.
 * @param {string} stage - empty private staging directory.
 * @param {string[]} tracked - checked repository inventory.
 * @param {string[]} inputs - exact verified runtime inputs.
 */
export async function stageApplication(stage, tracked, inputs) {
  try {
    run('pnpm', ['--filter', '@map-harness/application-runtime', 'deploy', '--legacy', '--prod', '--offline',
      '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', stage])
  } finally {
    run('pnpm', ['install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts'])
  }
  await restoreLegacyHoists(stage, join(ROOT, 'map/application-runtime/node_modules'))
  const deployed = JSON.parse(readFileSync(join(stage, 'package.json')))
  const dsh = JSON.parse(readFileSync(join(ROOT, 'python/sdk-runtime/package.json')))
  deployed.dependencies = { ...dsh.dependencies, ...deployed.dependencies }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(deployed, null, 2) + '\n')
  await restoreLegacyHoists(stage, join(ROOT, 'python/sdk-runtime/node_modules'))
  await materializeStagedLinks(stage)
  await deduplicateStagedWorkspacePackages(stage, ROOT)
  for (const manifest of runtimePackageManifests(tracked).filter(file => file.startsWith('map/'))) {
    const spec = JSON.parse(readFileSync(join(ROOT, manifest)))
    if (spec.name === '@map-harness/application-runtime') continue
    const dir = dirname(manifest), destination = join(stage, 'node_modules', spec.name)
    rmSync(destination, { recursive: true, force: true })
    for (const file of inputs.filter(file => file.startsWith(`${dir}/`))) {
      const target = join(destination, file.slice(dir.length + 1))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, runtimeBytes(file, readFileSync(join(ROOT, file))))
    }
  }
  // Native entry declarations are not sufficient: the interpreter loads these sibling JavaScript files.
  rmSync(join(stage, 'node_modules/@deepseek-ai/node-addon-system/lib'), { recursive: true, force: true })
  cpSync(join(ROOT, 'native/system/packages/entry/lib'), join(stage, 'node_modules/@deepseek-ai/node-addon-system/lib'), { recursive: true })
  const pty = join(stage, 'node_modules/node-pty')
  rmSync(join(pty, 'build'), { recursive: true, force: true })
  const host = `${process.platform}-${process.arch}`
  const prebuilt = join(ROOT, 'packages/subprocess/subprocess-local/node_modules/node-pty/prebuilds', host)
  if (existsSync(prebuilt)) {
    rmSync(join(pty, 'prebuilds', host), { recursive: true, force: true })
    cpSync(prebuilt, join(pty, 'prebuilds', host), { recursive: true })
  }
  mkdirSync(join(stage, 'map-presets'), { recursive: true })
  for (const file of ['preset.yml', 'agent.cordis.yml']) copyFileSync(join(ROOT, 'map/presets/map-analyst', file), join(stage, 'map-presets', file))
  copyFileSync(join(ROOT, 'map/bin/application-bootstrap.mjs'), join(stage, 'application.mjs'))
  copyFileSync(join(ROOT, 'map/bin/web-onboarding.mjs'), join(stage, 'web-onboarding.mjs'))
  copyFileSync(join(ROOT, 'python/sdk-runtime/runtime-bootstrap.mjs'), join(stage, 'dsh-runtime-bootstrap.mjs'))
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(join(ROOT, file), join(stage, file))
  for (const file of filesBelow(stage)) {
    const dependencySource = isDependencyRuntimeSource(file)
    if ((!dependencySource && isDevelopmentFile(file)) || /(?:^|\/)\.(?:modules\.yaml|pnpm.*)$/u.test(file)) rmSync(join(stage, file), { force: true })
  }
}

/**
 * Build and smoke one installed application. The output contains an executable, not a workspace distribution.
 * @param {string} out - directory receiving the host application and its acceptance manifest.
 * @param {boolean} skipBuild - reuse only a fresh verified community build.
 * @param {string} mode - application mode.
 * @param {boolean} deferBrowserCheck - move Windows browser acceptance to clean package qualification.
 * @returns {Promise<object>} executable path and native-host acceptance record.
 */
export async function buildApplication(out, skipBuild = false, mode = 'web', deferBrowserCheck = false) {
  assertCommunityEnvironment(process.env)
  const host = applicationHost(), webService = assertWebApplicationMode(mode, readWebServiceContract(ROOT)), version = readProductVersion(ROOT)
  if (!skipBuild) run(process.execPath, [join(ROOT, 'map/bin/build-web.mjs')])
  const listing = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES })
  if (listing.status !== 0) throw new Error('Cannot enumerate application inputs.')
  const { published: tracked } = filterPublicSources(listing.stdout.split('\0').filter(Boolean))
  const inputs = publicReleaseInputs(ROOT, tracked)
  assertPublicBuild(ROOT, inputs, process.env, ROOT, tracked)
  const sourceDigest = JSON.parse(readFileSync(join(ROOT, PUBLIC_BUILD_RECORD))).sources.sha256
  const name = `map-harness-v${version}-${host.target}`
  rmSync(join(out, name + '.json'), { force: true })
  const work = join(ROOT, '.dsh-build/map-application')
  mkdirSync(work, { recursive: true })
  const engineRoot = join(work, 'node'), cache = join(work, 'cache')
  try { await downloadNodeRuntime(host.target, engineRoot, cache) } catch (error) {
    const pin = runtimeLock.targets[host.target]
    await downloadPrimaryRuntimeAsset(`https://npmmirror.com/mirrors/node/v${runtimeLock.nodeVersion}/node-v${runtimeLock.nodeVersion}-${pin.nodeArchive}`, pin.nodeSha256, cache)
    await downloadNodeRuntime(host.target, engineRoot, cache)
  }
  const engine = join(engineRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const parent = mkdtempSync(join(work, 'stage-')), stage = join(parent, 'runtime')
  try {
    await stageApplication(stage, tracked, inputs)
    run(engine, [join(ROOT, 'map/bin/application-core.mjs'), stage])
    const manifestPath = join(stage, 'map-application.json'), manifest = JSON.parse(readFileSync(manifestPath))
    manifest.version = version
    manifest.webService = webService
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    copyFileSync(join(engineRoot, 'LICENSE'), join(stage, 'NODE-LICENSE.txt'))
    const fileList = filesBelow(stage).filter(file => !file.startsWith('node_modules/.'))
    const notices = fileList.filter(file => /(?:^|\/)(?:LICENSE(?:[.-][^/]*)?|NOTICE(?:[.-][^/]*)?|COPYING(?:[.-][^/]*)?|MAP-BUNDLE-NOTICES\.txt|NODE-LICENSE\.txt)$/iu.test(file))
      .map(file => `${file}\n${readFileSync(join(stage, file), 'utf8')}`)
    const noticeBytes = Buffer.from(notices.join('\n\n') + '\n')
    writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), noticeBytes)
    fileList.push('THIRD_PARTY_LICENSES.txt')
    auditApplicationSeal(stage, fileList, manifest)
    for (const file of fileList) {
      const bytes = readFileSync(join(stage, file))
      if (bytes.includes(ROOT) || bytes.includes(JSON.stringify(ROOT).slice(1, -1))) throw new Error(`Application input contains its checkout path: ${file}`)
    }
    mkdirSync(out, { recursive: true })
    const executable = join(out, name + (process.platform === 'win32' ? '.exe' : ''))
    const sidecars = { rg: { source: join(stage, 'node_modules/@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
      file: name + '-rg' + (process.platform === 'win32' ? '.exe' : '') } }
    if (process.platform === 'darwin') sidecars['spawn-helper'] = { source: join(stage, 'node_modules/node-pty/prebuilds', `darwin-${process.arch}`, 'spawn-helper'), file: name + '-spawn-helper' }
    const resources = {}
    for (const [role, item] of Object.entries(sidecars)) {
      copyFileSync(item.source, join(out, item.file))
      chmodSync(join(out, item.file), 0o755)
      resources[role] = { file: item.file, sha256: hash(readFileSync(join(out, item.file))) }
    }
    await sealApplication(stage, fileList, 'application.mjs', engine, runtimeLock.nodeVersion, executable)
    chmodSync(executable, 0o755)
    const info = spawnSync(executable, ['--application-info'], { encoding: 'utf8', timeout: 60000 })
    if (info.status !== 0) throw new Error(`Native application failed to load its compiled core: ${info.stderr}`)
    const onboardingCheck = spawnSync(executable, ['--web-onboarding', '--no-onboarding'], { encoding: 'utf8', timeout: 60000 })
    if (onboardingCheck.status === 0 || !onboardingCheck.stderr.includes('web-service-manifest.json')) throw new Error(`Native Web onboarding entry failed: ${onboardingCheck.stderr}`)
    const diagnostic = spawnSync(executable, ['--application-check'], { encoding: 'utf8', timeout: 60000 })
    if (diagnostic.status !== 0 || JSON.parse(diagnostic.stdout).worker !== true) throw new Error(`Native application worker failed: ${diagnostic.stderr}`)
    const system = spawnSync(executable, ['--application-system-check'], { encoding: 'utf8', timeout: 60000 })
    if (system.status !== 0 || JSON.parse(system.stdout).search !== true || JSON.parse(system.stdout).terminal !== true) {
      throw new Error(`Native application search or terminal helper failed: ${system.stderr}`)
    }
    const home = mkdtempSync(join(work, 'smoke-home-'))
    try {
      const config = spawnSync(executable, ['--dump-config'], { encoding: 'utf8', timeout: 60000,
        env: { ...process.env, MAPHARNESS_HOME: home } })
      if (config.status !== 0 || !config.stdout.includes('@map-harness/map-container')) throw new Error(`Native map profile failed: ${config.stderr}`)
    } finally { rmSync(home, { recursive: true, force: true }) }
    if (host.target === 'win-x64' && !deferBrowserCheck) await checkApplicationBrowser(executable)
    assertPublicBuild(ROOT, inputs, process.env, ROOT, tracked)
    if (JSON.parse(readFileSync(join(ROOT, PUBLIC_BUILD_RECORD))).sources.sha256 !== sourceDigest) throw new Error('Community build changed during application packaging; rebuild the application.')
    const record = { format: 'map-harness-native-1', version, target: host.target, engine: JSON.parse(info.stdout), executable: basename(executable),
      sha256: hash(readFileSync(executable)), webService, coreModules: manifest.coreModules, sourceCoreFiles: 0,
      notices: name + '.licenses.txt', noticesSha256: hash(noticeBytes),
      resources, sourceDigest, smokes: { config: true, worker: true, system: true, terminal: true,
        ...(host.target === 'win-x64' && !deferBrowserCheck ? { mapBrowser: true } : {}) },
      ...(host.target === 'win-x64' && deferBrowserCheck ? { deferredBrowserCheck: true } : {}) }
    writeFileSync(join(out, record.notices), noticeBytes)
    writeFileSync(join(out, name + '.json'), JSON.stringify(record, null, 2) + '\n')
    return { executable, record }
  } finally { rmSync(parent, { recursive: true, force: true }) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out')
  // An explicit --out is relative to the caller's shell; the default matches the publisher's repository-root default.
  const out = at >= 0 ? resolve(process.argv[at + 1]) : join(ROOT, '.dsh-build/map-application/out')
  const modeAt = process.argv.indexOf('--mode')
  const mode = modeAt >= 0 ? process.argv[modeAt + 1] : 'web'
  const result = await buildApplication(out, process.argv.includes('--skip-build'), mode, process.argv.includes('--defer-browser-check'))
  console.log(JSON.stringify(result))
}
