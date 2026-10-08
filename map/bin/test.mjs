#!/usr/bin/env node
/**
 * Map-layer test aggregate: runs every map-owned suite in dependency order —
 * per-package source-plane specs first, then the map-level engineering gates
 * (topology, manifests, Loader smoke, built artifacts). The browser-level
 * composition e2e (`map/arcgis-mcp` `test:composition`) stays separate: it
 * needs the built web frontend and Playwright, so wire it into CI as its own
 * lane via `pnpm --filter @map-harness/arcgis-mcp run test:composition`.
 *
 * Usage:
 *   node map/bin/test.mjs            # everything below, in order
 *   node map/bin/test.mjs --build    # run `node map/bin/build.mjs` first
 *
 * Requires upstream `pnpm run build` (the wrapper smoke boots apps/cli's
 * built launcher; per-package specs import upstream built libs).
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(mapRoot, '..')

/** Expand one `tests/*.spec.mjs` glob against its suite cwd; zero matches fail loud. */
function specFiles(cwd) {
  const files = readdirSync(join(cwd, 'tests'))
    .filter(file => file.endsWith('.spec.mjs'))
    .sort()
    .map(file => join(cwd, 'tests', file))
  if (files.length === 0) throw new Error(`no *.spec.mjs under ${join(cwd, 'tests')}`)
  return files
}

function packageSuite(label, dir) {
  const cwd = resolve(mapRoot, dir)
  return {
    label,
    command: ['--test', '--experimental-strip-types', ...specFiles(cwd)],
    cwd,
  }
}

const suites = [
  packageSuite('map-container package tests (incl. plugin lifecycle)', 'map-container'),
  packageSuite('spatial-storage package tests (migrations/backup/lifecycle)', 'spatial-storage'),
  packageSuite('spatial-catalog package tests (register/resolve/artifacts)', 'spatial-catalog'),
  packageSuite('spatial-context package tests (frame/injection/budget)', 'spatial-context'),
  packageSuite('spatial-accessibility package tests (contract/provider/runs/metrics/compare)', 'spatial-accessibility'),
  packageSuite('spatial-statistics package tests (contract/weights/stats/patterns/evidence)', 'spatial-statistics'),
  packageSuite('spatial-decision package tests (contract/linalg/attribution/causal/forecast/optimize)', 'spatial-decision'),
  packageSuite('spatial-viz package tests (contract/classify/timeline/linked)', 'spatial-viz'),
  packageSuite('spatial-collab package tests (contract/engine/lifecycle)', 'spatial-collab'),
  packageSuite('spatial-terrain package tests (contract/surface/los)', 'spatial-terrain'),
  packageSuite('spatial-realtime package tests (contract/runtime/checkpoint)', 'spatial-realtime'),
  packageSuite('stream-providers package tests (contract/sse/completions/fusion/service)', 'stream-providers'),
  packageSuite('spatial-scale package tests (contract/store/worker/record)', 'spatial-scale'),
  packageSuite('spatial-perf package tests (workload/instrument/budgets/benchmark)', 'spatial-perf'),
  packageSuite('spatial-observability package tests (contract/sanitize/instrument/health/faults/correlation)', 'spatial-observability'),
  packageSuite('spatial-connect package tests (contract/postgres/objectstore/cog/service/live)', 'spatial-connect'),
  packageSuite('mcp-transport package tests (contract/stdio/http/service/live)', 'mcp-transport'),
  packageSuite('map-tools package tests', 'tools'),
  packageSuite('arcgis-mcp package tests (incl. provider lifecycle)', 'arcgis-mcp'),
  {
    label: 'map engineering topology gates',
    command: ['--test', join(mapRoot, 'tests', 'topology.spec.mjs'), join(mapRoot, 'tests', 'build-exports.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map resource reliability gates',
    command: ['--test', join(mapRoot, 'tests', 'reliability.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map built-artifact replay parity',
    command: ['--test', join(mapRoot, 'tests', 'built-replay.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map built-artifact smoke',
    command: ['--test', join(mapRoot, 'tests', 'built-smoke.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map Loader composition smoke',
    command: ['--test', join(mapRoot, 'tests', 'loader-smoke.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map GLM/DeepSeek corpus parity gates',
    command: ['--test', join(mapRoot, 'tests', 'glm-deepseek-parity.spec.mjs')],
    cwd: mapRoot,
  },
  {
    label: 'map verification matrix gate',
    command: ['--test', join(mapRoot, 'tests', 'verification-matrix.spec.mjs')],
    cwd: mapRoot,
  },
]

if (process.argv.includes('--build')) {
  const build = spawnSync(process.execPath, [resolve(mapRoot, 'bin', 'build.mjs')], {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: process.platform === 'win32',
  })
  if (build.error !== undefined || build.status !== 0) {
    process.stderr.write('map test: map package build failed\n')
    process.exit(build.status ?? 1)
  }
}

let failed = false
for (const suite of suites) {
  process.stdout.write(`\n== map test: ${suite.label}\n`)
  const result = spawnSync(process.execPath, suite.command, {
    stdio: 'inherit',
    cwd: suite.cwd,
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    process.stderr.write(`map test: failed to start ${suite.label}: ${String(result.error)}\n`)
    failed = true
  } else if (result.status !== 0) {
    failed = true
  }
}
process.exit(failed ? 1 : 0)
