#!/usr/bin/env node
/**
 * Build source-free runtime ZIP/TAR archives from compiled outputs, install
 * metadata and package-declared runtime resources. Development source,
 * declarations and source maps are excluded; staged bytes are verified
 * against the community build record before archiving.
 *
 * Usage: node map/bin/pack-runtime.mjs --version vX.Y.Z --out <dir>
 *   [--include <tracked file list>]
 * Requires a fresh community build through node map/bin/build-web.mjs.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCommunityEnvironment, assertPublicBuild, isPrivate, isPublicSourcePath, MAX_GIT_OUTPUT_BYTES, stagedFiles } from './public-release-privacy.mjs'
import { assertRuntimeContent, FACADE_READMES, isDevelopmentFile, runtimeBytes, runtimePackageManifests, runtimeTrackedFiles } from './release-content.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Split tracked paths into the publishable source list and the privacy
 * exclusions, rejecting every path the public source allowlist does not
 * name: a new root file or top-level directory fails the publish until it
 * is added to the allowlist explicitly.
 * @param {string[]} tracked - tracked repository paths.
 * @returns {{ published: string[], excluded: string[] }} classified paths.
 */
export function filterPublicSources(tracked) {
  const published = []
  const excluded = []
  for (const file of tracked) {
    if (isPrivate(file)) excluded.push(file)
    else if (isPublicSourcePath(file)) published.push(file)
    else throw new Error(`Public source allowlist does not name ${file}; publish it explicitly or exclude it.`)
  }
  return { published, excluded }
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
  for (const file of runtimePackageManifests(tracked)) {
    const dir = dirname(file)
    if (existsSync(join(root, dir, 'lib'))) roots.add(dir === '.' ? 'lib' : `${dir}/lib`)
  }
  return [...roots].filter(path => existsSync(join(root, path))).sort()
}

/**
 * Enumerate install files, runtime resources and compiled output; exclude debug source material.
 * @param {string} root - repository root.
 * @param {string[]} tracked - privacy-filtered source paths.
 * @returns {string[]} sorted runtime inputs without source maps or declarations.
 */
export function publicReleaseInputs(root, tracked) {
  for (const file of tracked) {
    if (isPrivate(file)) throw new Error(`Private path ${file} cannot enter a public release.`)
    if (!isPublicSourcePath(file)) throw new Error(`Public source allowlist does not name ${file}; publish it explicitly or exclude it.`)
  }
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const child = `${path}/${entry.name}`
    if (isPrivate(child)) throw new Error(`Private path ${child} cannot enter public build outputs.`)
    if (SKIP_SEGMENTS.has(entry.name) || isDevelopmentFile(child)) return []
    if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot enter public build outputs.')
    return entry.isDirectory() ? walk(child) : [child]
  })
  return [...new Set([...runtimeTrackedFiles(root, tracked), ...LAUNCHER_SOURCES, ...buildOutputRoots(tracked, root).flatMap(walk)])].sort()
}

/** Copy one build-output tree, skipping dependency folders and build caches. */
function copyOutput(sourceRoot, stage, root) {
  cpSync(join(root, sourceRoot), join(stage, sourceRoot), {
    recursive: true,
    filter: source => {
      const parts = relative(root, source).split(sep)
      if (isPrivate(parts.join('/'))) throw new Error('Private path cannot enter runtime staging.')
      return !parts.some(part => SKIP_SEGMENTS.has(part)) && !isDevelopmentFile(parts.join('/'))
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
 * @param options - repository root, version, output directory, and the
 *   public source files to include.
 * @returns the archive paths written.
 */
export function packRuntime({ root = ROOT, version, out, tracked }) {
  assertCommunityEnvironment(process.env)
  const inputs = publicReleaseInputs(root, tracked)
  assertPublicBuild(root, inputs, process.env, root, tracked)
  for (const output of REQUIRED_OUTPUTS) {
    if (!existsSync(join(root, output))) fail(`missing build output ${output}; run \`node map/bin/build-web.mjs\` first`)
  }
  const name = `map-harness-${version}-runtime`
  const parent = mkdtempSync(join(tmpdir(), 'map-runtime-'))
  const stage = join(parent, name)
  mkdirSync(stage)
  try {
    for (const file of new Set([...runtimeTrackedFiles(root, tracked), ...LAUNCHER_SOURCES])) {
      const target = join(stage, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, runtimeBytes(file, readFileSync(join(root, file))), { mode: statSync(join(root, file)).mode })
    }
    const roots = buildOutputRoots(tracked, root)
    for (const sourceRoot of roots) copyOutput(sourceRoot, stage, root)
    for (const file of inputs.filter(file => /^map\/[^/]+\/lib\/.+\.[cm]?js$/u.test(file))) {
      writeFileSync(join(stage, file), runtimeBytes(file, readFileSync(join(root, file))))
    }
    for (const launcher of LAUNCHERS) {
      copyFileSync(join(stage, 'map', 'release', launcher), join(stage, launcher))
    }
    const readmes = Object.entries(FACADE_READMES).filter(([, source]) => existsSync(join(stage, source)))
    for (const [name, source] of readmes) copyFileSync(join(stage, source), join(stage, name))
    for (const [name, source] of readmes) {
      if (!readFileSync(join(stage, name)).equals(readFileSync(join(stage, source)))) throw new Error('Runtime README differs from its verified release document.')
    }
    const files = stagedFiles(stage)
    if (files.some(isPrivate)) throw new Error('Private path cannot enter runtime staging.')
    assertRuntimeContent(stage, files)
    assertPublicBuild(root, files.filter(file => !LAUNCHERS.includes(file) && !readmes.some(([name]) => name === file)), process.env, stage)
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
    const tar = spawnSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', tgz, '-C', parent, name], { stdio: 'inherit' })
    if (tar.status !== 0) throw new Error('pack-runtime: tar failed')
    // Executable modes remain in ZIP directory entries; Unix creator metadata is omitted.
    const zipped = spawnSync('zip', ['-qryX', '-UN=UTF8', zip, name], { cwd: parent, stdio: 'inherit' })
    if (zipped.status !== 0) throw new Error('pack-runtime: zip failed (requires Unicode-enabled Info-ZIP on PATH)')
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
  const listed = include === undefined
    ? spawnSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES }).stdout.split('\n').filter(file => file.length > 0)
    : readFileSync(include, 'utf8').split('\n').filter(Boolean)
  const { published } = filterPublicSources(listed)
  packRuntime({ version, out, tracked: published })
}
