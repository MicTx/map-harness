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
 *   MAPHARNESS_HOME  optional Harness home override (forwarded as the
 *                    upstream home variable) — keeps map-harness user state
 *                    separate from a stock dsh installation.
 *
 * Usage:
 *   map-harness [dsh args...]          # --profile map-web unless given
 *   map-harness web                    # profile web shorthand -> map-web web
 */
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const DEFAULT_PROFILE = 'map-web'

/** Workspace-root anchor: this file lives at <root>/map/bin/map-harness.mjs. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Map workspace packages the map-web profile mounts, repo-relative to map/. */
const MAP_PACKAGES = [
  { name: '@map-harness/map-web', dir: 'profiles/map-web' },
  { name: '@map-harness/client-ui-brand', dir: 'client-ui-brand' },
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

/** Resolve the Harness home the same way the upstream launcher defaults it. */
function resolveHome(env) {
  const configured = env.MAPHARNESS_HOME
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '') return resolve(env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/**
 * Initialize the map-web profile when absent. Existing files are never
 * touched — re-running is a no-op on an initialized profile, mirroring
 * upstream initProfile semantics.
 */
function ensureProfile(home) {
  const dir = join(home, 'profiles', DEFAULT_PROFILE)
  if (existsSync(join(dir, 'package.json'))) return dir
  mkdirSync(dir, { recursive: true })
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
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  const patchTemplate = [
    '# Your patch layer for this map-harness profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists).',
    '[]',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), patchTemplate)
  const workspaceSettings = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceSettings)
  return dir
}

/**
 * Link the workspace map packages into the profile's node_modules so the
 * launcher's bundle resolution finds @map-harness/map-web from the profile
 * anchor. The upstream bundle resolver accepts any directory holding a
 * package.json under the profile's node_modules search path, so a symlink to
 * the workspace source keeps profile state and repo source in sync with no
 * install step. Existing links are left alone.
 */
function ensurePackageLinks(profileDir) {
  const scopeDir = join(profileDir, 'node_modules', '@map-harness')
  mkdirSync(scopeDir, { recursive: true })
  for (const { name, dir } of MAP_PACKAGES) {
    const link = join(scopeDir, name.replace('@map-harness/', ''))
    if (existsSync(link)) continue
    symlinkSync(join(REPO_ROOT, 'map', dir), link, 'dir')
  }
}

/** Install the shipped map preset into the home user root; never overwrites. */
function ensurePresetInstalled(home) {
  const target = join(home, '.agent-presets', MAP_PRESET.id)
  if (existsSync(join(target, 'agent.cordis.yml'))) return
  mkdirSync(target, { recursive: true })
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    copyFileSync(join(MAP_PRESET.source, file), join(target, file))
  }
}

/**
 * Map argv: inject the map-web profile unless the caller chose one. A bare
 * leading `web` (upstream shorthand for its web profile) is dropped — this
 * wrapper's default profile IS the web surface.
 */
function buildArgs(argv) {
  const args = [...argv]
  if (args[0] === 'web') args.shift()
  const hasProfile = args.some(arg => arg === '--profile' || arg === '-p')
  // Launcher flags (--profile, --patch) must precede the booted app's own
  // flags: the launcher stops recognizing its options at the first unknown
  // token and passes the rest through verbatim.
  const launcherFlags = []
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch') {
      launcherFlags.push('--patch', args[i + 1] ?? '')
      i++
      continue
    }
    rest.push(args[i])
  }
  if (!hasProfile) launcherFlags.unshift('--profile', DEFAULT_PROFILE)
  return [...launcherFlags, ...rest]
}

ensureMapBuildArtifacts()
const bin = resolveDshBin()
const env = { ...process.env }
if (env.MAPHARNESS_HOME !== undefined && env.MAPHARNESS_HOME.trim() !== '') {
  env.DSH_HOME = env.MAPHARNESS_HOME
}
const home = resolveHome(env)
const profileDir = ensureProfile(home)
ensurePackageLinks(profileDir)
ensurePresetInstalled(home)

const result = spawnSync(process.execPath, [bin, ...buildArgs(process.argv.slice(2))], {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
})
if (result.error !== undefined) {
  process.stderr.write(`map-harness: failed to launch: ${String(result.error)}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
