#!/usr/bin/env node
/**
 * Pack the prebuilt runtime archive one release attaches: the privacy-filtered
 * tracked tree plus every build output the map Web service loads (package
 * `lib/` entries, the Web client bundle, the native entry JavaScript), with
 * no `node_modules`. Users install dependencies themselves with
 * `install.cmd` / `install.sh`; nothing is compiled on their machine.
 *
 * The same archive serves Windows and macOS: the only platform-specific
 * binaries (node-pty prebuilds, Koffi) arrive through the dependency install,
 * and the Landlock launcher binary is Linux-only and optional.
 *
 * Usage: node map/bin/pack-runtime.mjs --version vX.Y.Z --out <dir>
 *   [--include <tracked file list>] — the publisher passes its staged list;
 *   without it the privacy-filtered `git ls-files` list is used.
 * Requires a fresh community build through `node map/bin/build-web.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCommunityEnvironment, assertPublicBuild, stagedFiles } from './public-release-privacy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Paths and patterns never published. Order-independent; prefix/exact matched. */
export const PRIVACY_EXCLUDES = [
  '.spec/',
  '.agents/',
  '.claude/',
  '.codex/',
  '.pi/',
  '.zcode/',
  '.cursor/',
  '.paseo/',
  '.github/workflows/privacy-probe*',
  'logs/',
  'user/',
]

/**
 * Whether one tracked path is excluded from every published artifact: a
 * privacy prefix, or any `.env`/`.env.*` file at any depth except the
 * value-free `*.example` templates.
 * @param file - repository-relative path.
 * @returns `true` when the path must never be published.
 */
export function isPrivate(file) {
  if (PRIVACY_EXCLUDES.some(pattern => file === pattern.replace(/\/$/, '') || file.startsWith(pattern))) return true
  const base = file.split('/').at(-1) ?? ''
  return (base === '.env' || base.startsWith('.env.')) && !base.endsWith('.example')
}

/** Build outputs the archive must carry; missing ones refuse the pack. */
export const REQUIRED_OUTPUTS = [
  'apps/cli/lib/bin.js',
  'apps/web/dist',
  'map/map-container/lib/client.js',
  'map/tools/lib/index.js',
  'native/system/packages/entry/lib/index.js',
]

/** Path segments a copied build output never contains. */
const SKIP_SEGMENTS = new Set(['node_modules', '.DS_Store'])
const LAUNCHERS = ['install.cmd', 'install.sh', 'start.cmd', 'start.sh']
const LAUNCHER_SOURCES = LAUNCHERS.map(name => `map/release/${name}`)

function fail(message) {
  process.stderr.write(`pack-runtime: ${message}\n`)
  process.exit(1)
}

/**
 * The ignored build-output roots to carry: every `lib/` beside a tracked
 * `package.json`, plus the Web client bundle.
 * @param tracked - the tracked files being staged.
 * @returns repository-relative directories.
 */
export function buildOutputRoots(tracked, root = ROOT) {
  const roots = new Set(['apps/web/dist'])
  for (const file of tracked) {
    if (!file.endsWith('/package.json') && file !== 'package.json') continue
    const dir = dirname(file)
    if (existsSync(join(root, dir, 'lib'))) roots.add(dir === '.' ? 'lib' : `${dir}/lib`)
  }
  return [...roots].filter(path => existsSync(join(root, path))).sort()
}

/**
 * Enumerate the exact source and build files included in a public runtime.
 * @param {string} root - repository root.
 * @param {string[]} tracked - privacy-filtered source paths.
 * @returns {string[]} the sorted release inputs, including source maps.
 */
export function publicReleaseInputs(root, tracked) {
  if (tracked.some(isPrivate)) throw new Error('Private paths cannot enter a public runtime.')
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const child = `${path}/${entry.name}`
    if (SKIP_SEGMENTS.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) return []
    if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot enter public build outputs.')
    return entry.isDirectory() ? walk(child) : [child]
  })
  return [...new Set([...tracked, ...LAUNCHER_SOURCES, ...buildOutputRoots(tracked, root).flatMap(walk)])].sort()
}

/** Copy one build-output tree, skipping dependency folders and build caches. */
function copyOutput(root, stage) {
  cpSync(join(ROOT, root), join(stage, root), {
    recursive: true,
    filter: source => {
      const parts = relative(ROOT, source).split(sep)
      return !parts.some(part => SKIP_SEGMENTS.has(part)) && !source.endsWith('.tsbuildinfo')
    },
  })
}

/** Count files under one directory. */
function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    count += statSync(path).isDirectory() ? countFiles(path) : 1
  }
  return count
}

/**
 * Stage and archive the runtime tree.
 * @param options - version, output directory, and the tracked files to include.
 * @returns the archive paths written.
 */
export function packRuntime({ version, out, tracked }) {
  assertCommunityEnvironment(process.env)
  const inputs = publicReleaseInputs(ROOT, tracked)
  assertPublicBuild(ROOT, inputs)
  for (const output of REQUIRED_OUTPUTS) {
    if (!existsSync(join(ROOT, output))) fail(`missing build output ${output}; run \`pnpm run build:lib && node map/bin/build-web.mjs\` first`)
  }
  const name = `map-harness-${version}-runtime`
  const parent = mkdtempSync(join(tmpdir(), 'map-runtime-'))
  const stage = join(parent, name)
  mkdirSync(stage)
  try {
    for (const file of new Set([...tracked, ...LAUNCHER_SOURCES])) {
      const target = join(stage, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(ROOT, file), target)
    }
    const roots = buildOutputRoots(tracked)
    for (const root of roots) copyOutput(root, stage)
    for (const launcher of LAUNCHERS) {
      copyFileSync(join(stage, 'map', 'release', launcher), join(stage, launcher))
    }
    assertPublicBuild(ROOT, stagedFiles(stage).filter(file => !LAUNCHERS.includes(file)), process.env, stage)
    for (const launcher of LAUNCHERS) {
      if (!readFileSync(join(stage, launcher)).equals(readFileSync(join(stage, 'map/release', launcher)))) {
        throw new Error('Public runtime launcher differs from its verified source.')
      }
    }
    mkdirSync(out, { recursive: true })
    const zip = join(out, `${name}.zip`)
    const tgz = join(out, `${name}.tar.gz`)
    rmSync(zip, { force: true })
    rmSync(tgz, { force: true })
    const tar = spawnSync('tar', ['-czf', tgz, '-C', parent, name], { stdio: 'inherit' })
    if (tar.status !== 0) throw new Error('pack-runtime: tar failed')
    // zip keeps the executable bit of the .sh launchers through `-X`-free defaults.
    const zipped = spawnSync('zip', ['-qry', zip, name], { cwd: parent, stdio: 'inherit' })
    if (zipped.status !== 0) throw new Error('pack-runtime: zip failed (install the zip command)')
    process.stdout.write(`pack-runtime: ${countFiles(stage)} files (${roots.length} build-output roots) → ${zip}, ${tgz}\n`)
    return { zip, tgz }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const value = flag => { const at = argv.indexOf(flag); return at === -1 ? undefined : argv[at + 1] }
  const version = value('--version')
  const out = value('--out')
  if (version === undefined || !/^v\d+\.\d+\.\d+$/u.test(version) || out === undefined) fail('usage: --version vX.Y.Z --out <dir> [--include <file list>]')
  const include = value('--include')
  const tracked = include === undefined
    ? spawnSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(file => file.length > 0 && !isPrivate(file))
    : readFileSync(include, 'utf8').split('\n').filter(Boolean)
  packRuntime({ version, out, tracked })
}
