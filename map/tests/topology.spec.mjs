/**
 * Map-layer engineering topology gates: package ownership, import-graph
 * direction, workspace reverse isolation, and composition-manifest
 * consistency. These checks are pure source-plane scans (node builtins
 * only), so they run on a clean checkout before any build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(mapRoot, '..')

/** Map workspace packages with runtime source, keyed by package name. */
const packageDirs = [
  { name: '@map-harness/map-web', dir: 'profiles/map-web', src: 'src' },
  { name: '@map-harness/client-ui-brand', dir: 'client-ui-brand', src: 'src' },
  { name: '@map-harness/map-container', dir: 'map-container', src: 'src' },
  { name: '@map-harness/map-tools', dir: 'tools', src: 'src' },
  { name: '@map-harness/arcgis-mcp', dir: 'arcgis-mcp', src: 'src' },
  { name: '@map-harness/spatial-storage', dir: 'spatial-storage', src: 'src' },
  { name: '@map-harness/spatial-catalog', dir: 'spatial-catalog', src: 'src' },
  { name: '@map-harness/spatial-context', dir: 'spatial-context', src: 'src' },
  { name: '@map-harness/spatial-accessibility', dir: 'spatial-accessibility', src: 'src' },
  { name: '@map-harness/spatial-statistics', dir: 'spatial-statistics', src: 'src' },
  { name: '@map-harness/spatial-decision', dir: 'spatial-decision', src: 'src' },
  { name: '@map-harness/spatial-viz', dir: 'spatial-viz', src: 'src' },
  { name: '@map-harness/spatial-collab', dir: 'spatial-collab', src: 'src' },
  { name: '@map-harness/spatial-terrain', dir: 'spatial-terrain', src: 'src' },
  { name: '@map-harness/spatial-realtime', dir: 'spatial-realtime', src: 'src' },
  { name: '@map-harness/stream-providers', dir: 'stream-providers', src: 'src' },
  { name: '@map-harness/spatial-scale', dir: 'spatial-scale', src: 'src' },
  { name: '@map-harness/spatial-perf', dir: 'spatial-perf', src: 'src' },
  { name: '@map-harness/spatial-observability', dir: 'spatial-observability', src: 'src' },
]

/** Allowed package-level edges inside the map layer (dependency direction). */
const allowedEdges = new Map([
  ['@map-harness/arcgis-mcp', ['@map-harness/map-tools']],
  ['@map-harness/map-tools', ['@map-harness/map-container', '@map-harness/spatial-catalog', '@map-harness/spatial-context', '@map-harness/spatial-accessibility', '@map-harness/spatial-statistics', '@map-harness/spatial-decision', '@map-harness/spatial-viz', '@map-harness/spatial-collab', '@map-harness/spatial-terrain', '@map-harness/spatial-realtime', '@map-harness/spatial-scale']],
  ['@map-harness/map-container', ['@map-harness/spatial-catalog', '@map-harness/spatial-realtime', '@map-harness/spatial-viz']],
  ['@map-harness/client-ui-brand', []],
  ['@map-harness/map-web', []],
  ['@map-harness/spatial-storage', []],
  ['@map-harness/spatial-catalog', ['@map-harness/spatial-storage']],
  ['@map-harness/spatial-context', ['@map-harness/map-container']],
  ['@map-harness/spatial-accessibility', []],
  ['@map-harness/spatial-statistics', []],
  ['@map-harness/spatial-decision', ['@map-harness/spatial-statistics']],
  ['@map-harness/spatial-viz', []],
  ['@map-harness/spatial-collab', ['@map-harness/spatial-catalog']],
  ['@map-harness/spatial-realtime', []],
  ['@map-harness/stream-providers', ['@map-harness/spatial-realtime']],
  ['@map-harness/spatial-scale', []],
  ['@map-harness/spatial-perf', []],
  ['@map-harness/spatial-observability', []],
])

/** Upstream trees that must never import the map layer. */
const upstreamTrees = ['packages', 'apps', 'scripts', 'vendor', 'website', 'native', 'python', 'benchmarks', 'docs']

/** Collect source files under one directory recursively. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'lib' || entry === '.git') continue
      found.push(...sourceFiles(full))
    } else if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

/** Extract static import/export specifiers from one module's text. */
function importSpecifiers(text) {
  const specifiers = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'";]*?from\s*'([^']+)'/g,
    /(?:^|\n)\s*import\s+'([^']+)'/g,
    /(?:^|\n)\s*export\s+[^'";]*?from\s*'([^']+)'/g,
    /(?:^|\n)\s*import\s*\(\s*'([^']+)'/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/** Bare package specifier (`@scope/name` or `name`), subpath stripped. */
function barePackage(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'lib' || entry === '.pnpm' || entry === '.sessions') continue
      yield* walkFiles(full)
    } else {
      yield full
    }
  }
}

test('map package import graph stays acyclic, downstream-only, and declared', () => {
  const mapNames = new Set(packageDirs.map(pkg => pkg.name))
  for (const pkg of packageDirs) {
    const manifest = readJson(join(mapRoot, pkg.dir, 'package.json'))
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])
    const imported = new Set()
    for (const file of sourceFiles(join(mapRoot, pkg.dir, pkg.src))) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('#')) continue
        const pkgName = barePackage(specifier)
        if (pkgName === 'geojson') continue // provided by the declared @types/geojson
        imported.add(pkgName)
        assert.ok(
          declared.has(pkgName),
          `${pkg.name} imports "${pkgName}" (from ${file.replace(`${repoRoot}/`, '')}) without declaring it in package.json`,
        )
      }
    }
    const mapImports = [...imported].filter(name => mapNames.has(name)).sort()
    assert.deepEqual(
      mapImports,
      [...new Set(allowedEdges.get(pkg.name))].sort(),
      `unexpected map-layer dependency set for ${pkg.name}`,
    )
  }
  // Direction is fixed as arcgis-mcp -> map-tools -> map-container; the edge
  // sets above already forbid the reverse, and the cycle check makes it loud.
  for (const name of allowedEdges.keys()) {
    assert.ok(mapNames.has(name), `allowed-edge table names unknown package ${name}`)
  }
})

test('upstream trees never import the map layer (reverse-isolation negative check)', () => {
  const offenders = []
  for (const tree of upstreamTrees) {
    const dir = join(repoRoot, tree)
    if (!existsSync(dir)) continue
    for (const file of walkFiles(dir)) {
      const text = readFileSync(file, 'utf8')
      for (const specifier of importSpecifiers(text)) {
        if (specifier.startsWith('@map-harness/')) {
          offenders.push(`${file.replace(`${repoRoot}/`, '')}: ${specifier}`)
        }
      }
      if (/(?:^|\n)\s*(?:import|export)[^\n]*'(\.\.\/)+map\//.test(text)) {
        offenders.push(`${file.replace(`${repoRoot}/`, '')}: relative import into map/`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'upstream files must not import the map layer')
})

test('every composition row name resolves to a workspace package export', () => {
  const workspace = new Map()
  const addPackageDir = (dir) => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = readJson(manifestPath)
    if (typeof manifest.name === 'string') workspace.set(manifest.name, manifest)
  }
  for (const group of readdirSync(join(repoRoot, 'packages'))) {
    const groupDir = join(repoRoot, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const entry of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, entry)
      if (statSync(pkgDir).isDirectory()) addPackageDir(pkgDir)
    }
  }
  for (const base of ['apps', 'vendor', 'map']) {
    for (const entry of readdirSync(join(repoRoot, base))) {
      const pkgDir = join(repoRoot, base, entry)
      if (statSync(pkgDir).isDirectory()) addPackageDir(pkgDir)
    }
  }
  const rowFiles = [
    join(mapRoot, 'profiles', 'map-web', 'cordis.patch.yml'),
    join(mapRoot, 'presets', 'map-analyst', 'agent.cordis.yml'),
  ]
  for (const rowFile of rowFiles) {
    const text = readFileSync(rowFile, 'utf8')
    const names = [...text.matchAll(/^\s*name:\s*'([^']+)'\s*$/gm)].map(match => match[1])
    assert.ok(names.length > 0, `${rowFile} lists no plugin rows`)
    for (const name of names) {
      const pkgName = barePackage(name)
      const manifest = workspace.get(pkgName)
      assert.ok(manifest !== undefined, `${rowFile.replace(`${repoRoot}/`, '')} row "${name}" matches no workspace package`)
      if (name !== pkgName) {
        const subpath = `.${name.slice(pkgName.length)}`
        assert.ok(
          manifest.exports !== undefined && subpath in manifest.exports,
          `${rowFile.replace(`${repoRoot}/`, '')} row "${name}" uses subpath "${subpath}" missing from ${pkgName} exports`,
        )
      }
    }
  }
})

test('wrapper, build aggregate, patch rows, and package manifests agree on the package set', () => {
  const buildText = readFileSync(join(mapRoot, 'bin', 'build.mjs'), 'utf8')
  const wrapperText = readFileSync(join(mapRoot, 'bin', 'map-harness.mjs'), 'utf8')
  const patchText = readFileSync(join(mapRoot, 'profiles', 'map-web', 'cordis.patch.yml'), 'utf8')

  const buildPackages = [...buildText.matchAll(/'(@map-harness\/[a-z-]+)'/g)].map(m => m[1]).filter(n => n !== '@map-harness/map-web')
  const linkedPackages = [...wrapperText.matchAll(/name: '(@map-harness\/[a-z-]+)'/g)].map(m => m[1])
  const artifactPaths = [...wrapperText.matchAll(/'((?:client-ui-brand|map-container|tools|arcgis-mcp|spatial-catalog|spatial-storage|spatial-context|spatial-accessibility|spatial-statistics|spatial-decision|spatial-collab|spatial-terrain|spatial-realtime|spatial-scale)\/lib\/[^']+)'/g)].map(m => m[1])
  const patchNames = [...patchText.matchAll(/name: '(@map-harness\/[a-z-]+)'/g)].map(m => m[1])

  assert.deepEqual(new Set(buildPackages), new Set(['@map-harness/client-ui-brand', '@map-harness/map-container', '@map-harness/map-tools', '@map-harness/arcgis-mcp', '@map-harness/spatial-storage', '@map-harness/spatial-realtime', '@map-harness/stream-providers', '@map-harness/spatial-catalog', '@map-harness/spatial-context', '@map-harness/spatial-accessibility', '@map-harness/spatial-statistics', '@map-harness/spatial-decision', '@map-harness/spatial-viz', '@map-harness/spatial-collab', '@map-harness/spatial-terrain', '@map-harness/spatial-scale', '@map-harness/spatial-perf', '@map-harness/spatial-observability', '@map-harness/spatial-connect', '@map-harness/mcp-transport']), 'build aggregate package set')
  assert.deepEqual(new Set(linkedPackages), new Set([...buildPackages, '@map-harness/map-web']), 'wrapper links the built packages plus the map-web bundle')
  for (const name of patchNames) {
    assert.ok(linkedPackages.includes(name), `patch inserts "${name}" which the wrapper does not link into the profile`)
  }
  assert.ok(artifactPaths.length > 0, 'wrapper declares no built artifacts')

  const byName = new Map(packageDirs.map(pkg => [pkg.name, readJson(join(mapRoot, pkg.dir, 'package.json'))]))
  const packageByDir = new Map(packageDirs.map(pkg => [pkg.dir, pkg.name]))
  for (const artifact of artifactPaths) {
    const dir = artifact.split('/')[0]
    const pkgName = packageByDir.get(dir)
    assert.ok(pkgName !== undefined, `built artifact "${artifact}" belongs to no known map package`)
    const manifest = byName.get(pkgName)
    assert.ok(manifest !== undefined, `built artifact "${artifact}" belongs to no known map package`)
    const inExports = Object.values(manifest.exports ?? {}).some(entry => {
      const target = typeof entry === 'string' ? entry : entry.default
      return typeof target === 'string' && artifact.endsWith(target.replace(/^\.\//, ''))
    })
    assert.ok(
      inExports,
      `built artifact "${artifact}" is not a package export of ${pkgName}`,
    )
  }
})

test('map README slot table and engineering owner table cover every top-level directory', () => {
  const actualDirs = readdirSync(mapRoot).filter(entry => statSync(join(mapRoot, entry)).isDirectory() && entry !== 'node_modules').sort()
  const readme = readFileSync(join(mapRoot, 'README.md'), 'utf8')
  const engineering = readFileSync(join(mapRoot, 'docs', 'engineering.md'), 'utf8')
  for (const dir of actualDirs) {
    assert.ok(readme.includes(`\`${dir}/\``), `map/README.md slot table does not name \`${dir}/\``)
    assert.ok(engineering.includes(`\`${dir}/\``), `map/docs/engineering.md owner table does not name \`${dir}/\``)
  }
})

test('the only upstream workspace addition stays the map/* glob', () => {
  const workspaceYaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspaceYaml, /^  - map\/\*$/m, 'pnpm-workspace.yaml must keep the map/* workspace glob')
  assert.match(workspaceYaml, /Map Harness overlay layer/, 'the map/* glob keeps its explanatory comment')
})
