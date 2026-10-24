#!/usr/bin/env node
/**
 * Runtime-package setup: install the dependencies of a prebuilt map-harness
 * release on the user's own machine (Windows, macOS, Linux). The release
 * archive already carries every build output, so this script only downloads
 * dependencies; it never compiles project code.
 *
 * Registry choice: `--registry <url>` or `MAPHARNESS_REGISTRY`, else the first
 * reachable mirror in {@link MIRRORS} (probed in order). Electron and
 * Playwright browser downloads are skipped: the map Web service needs neither.
 *
 * Usage: node map/bin/setup.mjs [--registry <url>] [--check]
 *   --check  only report the environment and the chosen registry.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Registries probed in order when none is given; each served the full lockfile when checked. */
export const MIRRORS = [
  { name: 'npmmirror (阿里云)', url: 'https://registry.npmmirror.com' },
  { name: 'Tencent Cloud (腾讯云)', url: 'https://mirrors.cloud.tencent.com/npm' },
  { name: 'npmjs (official)', url: 'https://registry.npmjs.org' },
]

/** Probe timeout per registry, in milliseconds. */
const PROBE_TIMEOUT_MS = 8_000

/** Report one refusal and exit non-zero. */
function fail(message) {
  process.stderr.write(`map-harness setup: ${message}\n`)
  process.exit(1)
}

/**
 * Parse `--registry` / `--check`; unknown flags and non-http(s) registries refuse.
 * @param argv - the CLI arguments.
 * @param env - the environment `MAPHARNESS_REGISTRY` is read from.
 * @returns the parsed options.
 */
export function parseArgs(argv, env = process.env) {
  const options = { registry: env.MAPHARNESS_REGISTRY?.trim() || undefined, check: false }
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--registry') options.registry = argv[++at]
    else if (argv[at]?.startsWith('--registry=')) options.registry = argv[at].slice('--registry='.length)
    else if (argv[at] === '--check') options.check = true
    else fail(`unknown argument ${argv[at]}; use [--registry <url>] [--check]`)
  }
  if (options.registry !== undefined && !/^https?:\/\/[^\s]+$/u.test(options.registry)) fail(`--registry must be an http(s) URL, got ${options.registry}`)
  return options
}

/**
 * Whether one Node version satisfies the workspace engines range (^22.19 || >=24).
 * @param version - a `major.minor.patch` version.
 * @returns `true` when supported.
 */
export function nodeSupported(version) {
  const [major, minor] = version.split('.').map(Number)
  return (major === 22 && minor >= 19) || major >= 24
}

/** Refuse Node versions outside the workspace engines range. */
function checkNode() {
  if (!nodeSupported(process.versions.node)) fail(`Node.js ${process.versions.node} is not supported; install Node.js 22.19+ or 24+ from https://nodejs.org (or https://npmmirror.com/mirrors/node/)`)
}

/** The pnpm version pinned in package.json `packageManager`. */
function pinnedPnpm() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const match = /^pnpm@(\d+\.\d+\.\d+)/u.exec(manifest.packageManager ?? '')
  if (match === null) fail('package.json has no pinned pnpm packageManager')
  return match[1]
}

/** Whether one registry answers the pinned pnpm metadata within the timeout. */
async function reachable(url, pnpmVersion) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${url.replace(/\/$/u, '')}/pnpm/${pnpmVersion}`, { signal: controller.signal })
    return response.ok
  } catch {
    // Unreachable or timed out: try the next mirror.
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Pick the registry: the explicit one, else the first reachable mirror. */
async function chooseRegistry(explicit, pnpmVersion) {
  if (explicit !== undefined) return { name: 'custom', url: explicit }
  for (const mirror of MIRRORS) {
    process.stdout.write(`probing ${mirror.name} ${mirror.url} … `)
    const ok = await reachable(mirror.url, pnpmVersion)
    process.stdout.write(ok ? 'ok\n' : 'unreachable\n')
    if (ok) return mirror
  }
  return fail('no npm registry is reachable; pass --registry <url> (or set MAPHARNESS_REGISTRY) to a mirror you can reach')
}

/** Run one command inheriting stdio; on Windows npm/npx/pnpm are `.cmd` shims and need a shell. */
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (result.error !== undefined) fail(`${command} could not start: ${result.error.message}`)
  return result.status ?? 1
}

/** Whether the pinned pnpm is already on PATH. */
function hasPinnedPnpm(version) {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0 && probe.stdout.trim() === version
}

/** Run the setup CLI. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  checkNode()
  if (!existsSync(join(ROOT, 'map', 'map-container', 'lib', 'client.js'))) {
    fail('this directory has no prebuilt map packages; download the runtime archive (map-harness-<version>-runtime) from the release page, or build a source checkout with the developer guide')
  }
  const pnpmVersion = pinnedPnpm()
  const registry = await chooseRegistry(options.registry, pnpmVersion)
  process.stdout.write(`node ${process.versions.node}; pnpm ${pnpmVersion}; registry ${registry.url}\n`)
  if (options.check) process.exit(0)

  const env = {
    ...process.env,
    npm_config_registry: registry.url,
    // The Web service needs neither the Electron desktop binary nor Playwright browsers.
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  }
  const installArgs = ['install', '--frozen-lockfile', `--config.registry=${registry.url}`,
    // Windows keeps the classic 260-character path limit unless long paths are enabled; short store entries stay under it.
    ...(process.platform === 'win32' ? ['--config.virtual-store-dir-max-length=60'] : [])]
  const status = hasPinnedPnpm(pnpmVersion)
    ? run('pnpm', installArgs, env)
    : run('npx', ['--yes', `pnpm@${pnpmVersion}`, ...installArgs], env)
  if (status !== 0) fail(`dependency install failed (exit ${status}); retry, or pass --registry <url> to try another mirror`)
  process.stdout.write('\nmap-harness setup: dependencies installed. Start with the start script (start.cmd on Windows, ./start.sh on macOS/Linux).\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
