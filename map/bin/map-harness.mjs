#!/usr/bin/env node
/**
 * map-harness CLI wrapper: forwards to the upstream dsh launcher with the
 * map-web profile by default. The wrapper owns no launcher logic — it maps
 * argv and execs the workspace CLI, so upstream launcher updates are picked
 * up unchanged.
 *
 * On first use it initializes the map-web profile in the Harness home with
 * the bundle stack base -> web-app -> map-web (the map brand layer), and
 * links the workspace map packages into the profile's node_modules so the
 * launcher's bundle resolution (installation anchor, then profile dir) finds
 * the @map-harness bundle.
 *
 * Env:
 *   MAPHARNESS_HOME  optional Harness home override, `~` expanded and
 *                    forwarded resolved as the upstream home variable — keeps
 *                    map-harness user state separate from a stock dsh installation.
 *
 * Usage:
 *   map-harness [dsh args...]          # --profile map-web unless given
 *   map-harness web                    # profile web shorthand -> map-web web
 *   map-harness --prepare              # prepare the map-web profile, then exit
 *
 * `--prepare` initializes this checkout's isolated source profile without booting.
 * Ordinary launch delegates admission and profile preparation to the same-process
 * instance prelude before the workspace CLI is imported.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveMapInstance } from './instance-home.mjs'

const require = createRequire(import.meta.url)
const DEFAULT_PROFILE = 'map-web'

/** Workspace-root anchor: this file lives at <root>/map/bin/map-harness.mjs. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Map workspace packages the map-web profile mounts, repo-relative to map/. */
const MAP_PACKAGES = [
  { name: '@map-harness/map-web', dir: 'profiles/map-web' },
  { name: '@map-harness/client-ui-brand', dir: 'client-ui-brand' },
  { name: '@map-harness/lbs-keyring', dir: 'lbs-keyring' },
  { name: '@map-harness/ui-settings-lbs', dir: 'ui-settings-lbs' },
  { name: '@map-harness/map-layers', dir: 'layers' },
  { name: '@map-harness/map-container', dir: 'map-container' },
  { name: '@map-harness/arcgis-mcp', dir: 'arcgis-mcp' },
  { name: '@map-harness/map-tools', dir: 'tools' },
  { name: '@map-harness/spatial-storage', dir: 'spatial-storage' },
  { name: '@map-harness/spatial-realtime', dir: 'spatial-realtime' },
  { name: '@map-harness/stream-providers', dir: 'stream-providers' },
  { name: '@map-harness/spatial-scale', dir: 'spatial-scale' },
  { name: '@map-harness/spatial-catalog', dir: 'spatial-catalog' },
  { name: '@map-harness/spatial-context', dir: 'spatial-context' },
  { name: '@map-harness/spatial-accessibility', dir: 'spatial-accessibility' },
  { name: '@map-harness/spatial-statistics', dir: 'spatial-statistics' },
  { name: '@map-harness/spatial-decision', dir: 'spatial-decision' },
  { name: '@map-harness/spatial-viz', dir: 'spatial-viz' },
  { name: '@map-harness/spatial-collab', dir: 'spatial-collab' },
  { name: '@map-harness/spatial-terrain', dir: 'spatial-terrain' },
  { name: '@map-harness/spatial-perf', dir: 'spatial-perf' },
  { name: '@map-harness/spatial-observability', dir: 'spatial-observability' },
  { name: '@map-harness/spatial-connect', dir: 'spatial-connect' },
  { name: '@map-harness/mcp-transport', dir: 'mcp-transport' },
]

/** Built entries the linked map profile loads at runtime. */
const MAP_BUILD_ARTIFACTS = [
  'client-ui-brand/lib/index.js',
  'client-ui-brand/lib/client.js',
  'lbs-keyring/lib/index.js',
  'ui-settings-lbs/lib/index.js',
  'ui-settings-lbs/lib/client.js',
  'layers/lib/index.js',
  'map-container/lib/index.js',
  'map-container/lib/client.js',
  'tools/lib/index.js',
  'tools/lib/mcp.js',
  'arcgis-mcp/lib/index.js',
  'spatial-catalog/lib/index.js',
  'spatial-context/lib/index.js',
  'spatial-context/lib/agent.js',
  'spatial-accessibility/lib/index.js',
  'spatial-statistics/lib/index.js',
  'spatial-decision/lib/index.js',
  'spatial-viz/lib/index.js',
  'spatial-collab/lib/index.js',
  'spatial-terrain/lib/index.js',
  'spatial-connect/lib/index.js',
  'mcp-transport/lib/index.js',
]

/** The agent preset this distribution ships and the home directory it lands in. */
const MAP_PRESET = { source: join(REPO_ROOT, 'map', 'presets', 'map-analyst'), id: 'map-analyst' }

/**
 * Resolve the upstream CLI bin: apps/cli IS the @deepseek-ai/dsh package in
 * this workspace (bin `dsh` -> lib/bin.js). Resolution falls back to Node
 * package resolution for installs where the package is linked elsewhere.
 */
function resolveDshBin() {
  const candidates = [
    join(REPO_ROOT, 'apps', 'cli', 'package.json'),
  ]
  try {
    candidates.unshift(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    // workspace-local layout is the normal path
  }
  for (const pkgPath of candidates) {
    try {
      const pkg = require(pkgPath)
      const binRel = typeof pkg.bin === 'object' && pkg.bin !== null ? pkg.bin.dsh : pkg.bin
      if (typeof binRel === 'string' && binRel.length > 0) return resolve(dirname(pkgPath), binRel)
    } catch {
      // try the next candidate
    }
  }
  process.stderr.write(
    'map-harness: cannot resolve the upstream dsh CLI; run `pnpm install && pnpm run build` at the repository root first.\n',
  )
  process.exit(1)
}

function ensureMapBuildArtifacts() {
  const missing = MAP_BUILD_ARTIFACTS.filter(path => !existsSync(join(REPO_ROOT, 'map', path)))
  if (missing.length === 0) return
  process.stderr.write(
    `map-harness: built map packages are missing (${missing.join(', ')}); run \`pnpm run build && node map/bin/build-web.mjs\` at the repository root first.\n`,
  )
  process.exit(1)
}

/**
 * Initialize the map-web profile when absent. Existing files are never
 * touched — re-running is a no-op on an initialized profile, mirroring
 * upstream initProfile semantics.
 */
function ensureProfile(home) {
  const dir = join(home, 'profiles', DEFAULT_PROFILE)
  if (existsSync(join(dir, 'package.json'))) return dir
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: `map-harness-profile-${DEFAULT_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@map-harness/map-web',
        ],
      },
    },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
  const patchTemplate = [
    '# Your patch layer for this map-harness profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists).',
    '[]',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), patchTemplate, { mode: 0o600 })
  const workspaceSettings = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceSettings, { mode: 0o600 })
  return dir
}

/**
 * Link the workspace map packages into the profile's node_modules so the
 * launcher's bundle resolution finds @map-harness/map-web from the profile
 * anchor. The upstream bundle resolver accepts any directory holding a
 * package.json under the profile's node_modules search path, so a symlink to
 * the workspace source keeps profile state and repo source in sync with no
 * install step. Links into this checkout stay; dangling links and links into
 * another checkout are replaced; real directories are user-installed and stay.
 */
function ensurePackageLinks(profileDir) {
  const scopeDir = join(profileDir, 'node_modules', '@map-harness')
  mkdirSync(scopeDir, { recursive: true, mode: 0o700 })
  let relinked = false
  for (const { name, dir } of MAP_PACKAGES) {
    const link = join(scopeDir, name.replace('@map-harness/', ''))
    const target = join(REPO_ROOT, 'map', dir)
    const entry = lstatSync(link, { throwIfNoEntry: false })
    // A real directory is user-installed and stays; only wrapper links are reconciled.
    if (entry !== undefined && !entry.isSymbolicLink()) continue
    if (entry !== undefined) {
      if (linkTarget(link) === realpathSync(target)) continue
      unlinkSync(link)
      relinked = true
    }
    symlinkSync(target, link, 'dir')
  }
  if (relinked) process.stderr.write(`map-harness: profile package links now point at ${join(REPO_ROOT, 'map')}\n`)
}

/** The canonical target of one profile link, or undefined when it dangles. */
function linkTarget(link) {
  try {
    return realpathSync(link)
  } catch (_dangling) {
    // A moved or deleted checkout leaves the link pointing nowhere; the caller replaces it.
    return undefined
  }
}

/** Install the shipped map preset into the home user root; never overwrites. */
function ensurePresetInstalled(home) {
  const target = join(home, '.agent-presets', MAP_PRESET.id)
  if (existsSync(join(target, 'agent.cordis.yml'))) return
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    const destination = join(target, file)
    if (existsSync(destination)) continue
    copyFileSync(join(MAP_PRESET.source, file), destination)
    chmodSync(destination, 0o600)
  }
}

/**
 * Map argv: inject the map-web profile unless the caller chose one. A bare
 * leading `web` shorthand selects Map's Web surface.
 * @param {string[]} argv caller arguments
 * @returns {string[]} launcher flags before application arguments
 */
export function buildArgs(argv) {
  const args = [...argv]
  if (args[0] === 'web') args.shift()
  const hasProfile = args.some(arg => arg === '--profile' || arg === '-p' || arg.startsWith('--profile='))
  // Launcher flags (--profile, --patch) must precede the booted app's own
  // flags: the launcher stops recognizing its options at the first unknown
  // token and passes the rest through verbatim.
  const launcherFlags = []
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (['--patch', '--profile', '-p', '--from-default-profile'].includes(args[i])) {
      launcherFlags.push(args[i] === '-p' ? '--profile' : args[i], args[i + 1] ?? '')
      i++
      continue
    }
    if (args[i].startsWith('--patch=') || args[i].startsWith('--profile=')) launcherFlags.push(args[i])
    else rest.push(args[i])
  }
  if (!hasProfile) launcherFlags.unshift('--profile', DEFAULT_PROFILE)
  return [...launcherFlags, ...rest]
}

/**
 * Initialize the Map profile only after source instance admission.
 * @param {object} instance prepared source instance, owned by this checkout
 * @returns {string} prepared profile directory
 */
export function prepareSourceProfile(instance) {
  if (instance.mode !== 'source' || instance.instanceId === undefined) throw new Error('Map profile preparation requires an admitted source instance.')
  const profileDir = ensureProfile(instance.home)
  ensurePackageLinks(profileDir)
  ensurePresetInstalled(instance.home)
  return profileDir
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { externalMapEnvironment, preloadSourceInstance } = await import('./instance-preload.mjs')
  if (process.argv[2] === 'manage') {
    const { mainManage } = await import('./manage.mjs')
    const context = {
      env: externalMapEnvironment(process.env), homedir: homedir(), cwd: process.cwd(),
      programRoot: REPO_ROOT, installRoots: [REPO_ROOT],
    }
    const argv = process.argv.slice(3)
    if (argv[0] === 'import') {
      const { readDataCompatibility } = await import('./install-manifest.mjs')
      const anchor = createRequire(join(REPO_ROOT, 'map/application-runtime/package.json'))
      const [storage, tools, scale] = await Promise.all([
        import(pathToFileURL(anchor.resolve('@map-harness/spatial-storage')).href),
        import(pathToFileURL(anchor.resolve('@map-harness/map-tools')).href),
        import(pathToFileURL(anchor.resolve('@map-harness/spatial-scale')).href),
      ])
      context.owners = {
        storage, scale, toolNames: tools.SPATIAL_TOOL_CATALOG.map(row => row.name),
        compatibility: await readDataCompatibility(REPO_ROOT),
        require: createRequire(anchor.resolve('@map-harness/map-tools/package.json')),
      }
    }
    const result = await mainManage(argv, context)
    const json = argv.includes('--json') || argv[0] === 'import'
    process.stdout.write(`${json ? JSON.stringify(result.json, null, 2) : result.output}\n`)
    process.exit(result.exitCode)
  }
  // Resolve before clearing ambient values so conflicting DSH roots remain visible.
  const instance = resolveMapInstance({ mode: 'source', checkoutRoot: REPO_ROOT, installRoots: [REPO_ROOT] })
  const environment = { ...externalMapEnvironment(process.env), MAPHARNESS_HOME: instance.home }
  if (process.argv[2] === '--prepare') {
    ensureMapBuildArtifacts()
    await preloadSourceInstance({ argv: ['--prepare'], initializeProfile: prepareSourceProfile })
  } else {
    ensureMapBuildArtifacts()
    const bin = resolveDshBin()
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--import', join(REPO_ROOT, 'map/bin/source-preload.mjs'), bin, ...buildArgs(process.argv.slice(2))], {
      stdio: 'inherit', env: environment, cwd: process.cwd(), detached: process.platform !== 'win32',
    })
    // Forward signals to the service child and await its own termination; the wrapper is not the writer.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { child.kill(signal) })
    child.once('error', error => {
      process.stderr.write(`map-harness: failed to launch: ${String(error)}\n`)
      process.exitCode = 1
    })
    child.once('exit', (code, signal) => {
      const signalCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
      process.exitCode = code ?? (signal === null ? 1 : signalCode[signal] ?? 1)
    })
    await new Promise(resolve => child.once('close', resolve))
    process.exitCode ??= 1
  }
}
