/**
 * Real-Loader composition smoke for the map-web distribution: boots the
 * upstream launcher through the map wrapper (keyless `--dump-config` path),
 * asserts the composed rows, and proves the two startup fast-fail paths —
 * missing built artifacts and presentation-mode escape. Requires upstream
 * `pnpm run build` (apps/cli) so the launcher resolves; every case uses a
 * throwaway MAPHARNESS_HOME.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wrapper = join(repoRoot, 'map', 'bin', 'map-harness.mjs')

/** Run the wrapper once and capture the composed output. */
function runWrapper(args, env) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: repoRoot,
  })
}

/** `--dump-config` row block for one row id, comments and all. */
function rowBlock(dump, id) {
  const lines = dump.split('\n')
  const start = lines.findIndex(line => line === `- id: ${id}`)
  assert.ok(start !== -1, `dump-config has no row "${id}"`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('- id: ') || lines[i].startsWith('# ==')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('wrapper dump-config composes the map-web profile rows and initializes the home', () => {
  const home = mkdtempSync(join(tmpdir(), 'map-loader-smoke-'))
  try {
    const result = runWrapper(['--dump-config'], { MAPHARNESS_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' })
    assert.equal(result.status, 0, `dump-config failed: ${result.stderr}`)
    const dump = result.stdout
    assert.match(dump, /# == @map-harness\/map-web/)

    const mapSection = dump.slice(dump.indexOf('# == @map-harness/map-web'))
    for (const row of ['map-client-ui-brand', 'map-container', 'arcgis-mcp', 'spatial-catalog', 'spatial-context', 'spatial-accessibility', 'spatial-collab', 'spatial-connect', 'mcp-transport', 'stream-providers']) {
      assert.match(mapSection, new RegExp(`^- id: ${row}\\n  name: '@map-harness/`, 'm'), `map bundle section lacks row ${row}`)
    }

    assert.match(rowBlock(dump, 'ui-brand-official'), /disabled: true/, 'the official brand row must stay disabled')
    assert.match(rowBlock(dump, 'ui-sidebar-terminal'), /disabled: true/, 'terminal tab must stay disabled')
    assert.match(rowBlock(dump, 'ui-sidebar-browser'), /disabled: true/, 'browser tab must stay disabled')

    const tools = rowBlock(dump, 'tools')
    assert.match(tools, /mode: native/, 'the map profile pins native tool presentation')
    // The P0b catalog store lives under the harness home via the Loader's
    // home-path helper, never a repo or cwd-relative default.
    const catalogRow = rowBlock(dump, 'spatial-catalog')
    assert.match(catalogRow, /root: !!js dshHomePath\('spatial-store'\)/, 'the catalog store root resolves through the home helper')
    const accessibilityRow = rowBlock(dump, 'spatial-accessibility')
    assert.match(accessibilityRow, /root: !!js dshHomePath\('accessibility-store'\)/, 'the run store root resolves through the home helper')

    // Profile init side effects the launcher relies on at next real boot.
    const profileDir = join(home, 'profiles', 'map-web')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@map-harness/map-web',
    ])
    // The full wrapper link set, one name per composed map package — kept in
    // lockstep with MAP_PACKAGES in `map/bin/map-harness.mjs` (the topology
    // gate cross-checks that table against the build aggregate and patch rows).
    const linkedPackages = [
      'map-web', 'client-ui-brand', 'map-container', 'arcgis-mcp', 'map-tools',
      'spatial-storage', 'spatial-realtime', 'spatial-scale', 'spatial-catalog',
      'spatial-context', 'spatial-accessibility', 'spatial-statistics',
      'spatial-decision', 'spatial-viz', 'spatial-collab', 'spatial-terrain',
      'spatial-perf', 'spatial-observability', 'spatial-connect', 'mcp-transport', 'stream-providers',
    ]
    const scopeDir = join(profileDir, 'node_modules', '@map-harness')
    assert.deepEqual(
      readdirSync(scopeDir).sort(),
      [...linkedPackages].sort(),
      'the profile link set must match the composed map packages exactly (no missing, no extra)',
    )
    for (const name of linkedPackages) {
      assert.ok(existsSync(join(scopeDir, name)), `profile link @map-harness/${name} missing`)
    }
    const preset = readFileSync(join(home, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
    assert.doesNotMatch(preset, /'@map-harness\/map-tools\/mcp'/)
    assert.match(preset, /'@map-harness\/spatial-context\/agent'/, 'the preset must mount the spatial-context pre-step listener')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the composed preset roster keeps non-analyst presets native and closes the ptc escape', () => {
  const home = mkdtempSync(join(tmpdir(), 'map-loader-roster-'))
  try {
    const result = runWrapper(['--dump-config'], { MAPHARNESS_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' })
    assert.equal(result.status, 0, `dump-config failed: ${result.stderr}`)
    const dump = result.stdout

    // The registry default stays the map analyst preset; the tools row keeps
    // the native presentation pin regardless of the roster around it.
    assert.match(rowBlock(dump, 'agent-preset-registry'), /default: map-analyst/, 'the registry default must stay pinned to map-analyst')
    assert.match(rowBlock(dump, 'tools'), /mode: native/, 'the composed roster must not disturb the native presentation pin')

    // The upstream non-analyst presets stay selectable: their rows mount in
    // their own preset scopes and inherit the deployment presentation.
    for (const [row, preset] of [
      ['preset-standard', 'standard'],
      ['preset-minimal', 'minimal'],
      ['preset-cordis', 'cordis'],
    ]) {
      const block = rowBlock(dump, row)
      assert.doesNotMatch(block, /^  disabled:/m, `${row} must stay enabled in the map profile`)
      assert.match(block, new RegExp(`^    id: ${preset}$`, 'm'), `${row} must declare preset id ${preset}`)
    }

    // The ptc preset is the one non-analyst composition the map surface
    // cannot carry: its tool-presentation row shadows the deployment pin per
    // scope, flipping a selecting session onto the unvalidated run_code
    // collapse. The map patch disables the declaration, removing it from the
    // selectable roster.
    const ptc = rowBlock(dump, 'preset-ptc')
    assert.match(ptc, /^  disabled: true$/m, 'preset-ptc must be disabled in the map profile (per-scope ptc presentation escape)')
    assert.match(ptc, /mode: ptc/, 'the disabled row is the upstream ptc preset (its presentation row names mode: ptc)')

    // The map analyst declaration composes with its spatial-context agent
    // row — the one preset-plane row the map host services exist to serve.
    const analyst = rowBlock(dump, 'preset-map-analyst')
    assert.doesNotMatch(analyst, /^  disabled:/m, 'preset-map-analyst must stay enabled')
    assert.match(analyst, /'@map-harness\/spatial-context\/agent'/, 'the composed map-analyst declaration must mount the spatial-context agent row')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH_TOOLS_MODE cannot flip the map profile out of native presentation', () => {
  const home = mkdtempSync(join(tmpdir(), 'map-loader-ptc-'))
  try {
    for (const mode of ['ptc', 'both']) {
      const result = runWrapper(['--dump-config'], {
        MAPHARNESS_HOME: home,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_TOOLS_MODE: mode,
      })
      assert.equal(result.status, 0, `dump-config failed under DSH_TOOLS_MODE=${mode}: ${result.stderr}`)
      assert.match(rowBlock(result.stdout, 'tools'), /mode: native/, `DSH_TOOLS_MODE=${mode} must not reach the composed map profile`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the wrapper refuses to launch when the built map artifacts are missing', () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-wrapper-relocated-'))
  try {
    // A relocated copy resolves its repo root to the temp directory, where no
    // map/*/lib exists — the real ensureMapBuildArtifacts fast-fail path.
    const relocated = join(temp, 'map-harness.mjs')
    copyFileSync(wrapper, relocated)
    const result = spawnSync(process.execPath, [relocated, '--dump-config'], { encoding: 'utf8', cwd: temp })
    assert.notEqual(result.status, 0, 'a wrapper with no built artifacts must exit non-zero')
    assert.match(result.stderr, /built map packages are missing/, 'the failure must name the missing artifacts and the build command')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
