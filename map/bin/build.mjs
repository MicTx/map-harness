#!/usr/bin/env node
/**
 * Build every runtime package owned by the map layer. Upstream artifacts remain
 * owned by `pnpm run build`; this aggregate is the second clean-checkout stage
 * required before the map wrapper can link package `lib/` entries.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const packages = [
  '@map-harness/spatial-storage',
  '@map-harness/spatial-realtime',
  '@map-harness/stream-providers',
  '@map-harness/spatial-scale',
  '@map-harness/spatial-viz',
  '@map-harness/spatial-catalog',
  '@map-harness/client-ui-brand',
  '@map-harness/map-container',
  '@map-harness/map-tools',
  '@map-harness/arcgis-mcp',
  '@map-harness/spatial-context',
  '@map-harness/spatial-accessibility',
  '@map-harness/spatial-statistics',
  '@map-harness/spatial-decision',
  '@map-harness/spatial-collab',
  '@map-harness/spatial-terrain',
  '@map-harness/spatial-perf',
  '@map-harness/spatial-observability',
  '@map-harness/spatial-connect',
  '@map-harness/mcp-transport',
]
const args = packages.flatMap(name => ['--filter', name])
args.push('-r', 'run', 'build')
const result = spawnSync('pnpm', args, {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
})
if (result.error !== undefined) {
  process.stderr.write(`map-harness build: failed to start pnpm: ${String(result.error)}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
