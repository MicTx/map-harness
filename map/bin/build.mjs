#!/usr/bin/env node
/**
 * Build every runtime package owned by the map layer. Upstream artifacts remain
 * owned by `pnpm run build`; this aggregate is the second clean-checkout stage
 * required before the map wrapper can link package `lib/` entries.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inlineBrowserDefines, inlineEmbeddedPrograms, stagePreparedFiles } from './release-protection.mjs'
import { mapBrowserDefines } from './browser-defines.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const packages = [
  '@map-harness/spatial-storage',
  '@map-harness/spatial-realtime',
  '@map-harness/stream-providers',
  '@map-harness/spatial-scale',
  '@map-harness/spatial-viz',
  '@map-harness/map-layers',
  '@map-harness/spatial-catalog',
  '@map-harness/client-ui-brand',
  '@map-harness/lbs-keyring',
  '@map-harness/ui-settings-lbs',
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
function run(args) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' })
  if (result.error || result.status !== 0) throw new Error('Map package build failed.')
}

run([...packages.flatMap(name => ['--filter', name]), '-r', 'run', 'build'])
if (process.argv.includes('--release')) {
  const dirs = readdirSync(join(root, 'map')).map(name => `map/${name}`).filter(dir => {
    const manifest = join(root, dir, 'package.json')
    return existsSync(manifest) && packages.includes(JSON.parse(readFileSync(manifest, 'utf8')).name)
  })
  if (dirs.length !== packages.length) throw new Error('Map release package inventory is incomplete.')
  // Map packages resolve declarations through workspace exports rather than project references.
  const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`
    return entry.isDirectory() ? walk(file) : file.endsWith('.js') ? [file] : []
  })
  const modules = dirs.flatMap(dir => walk(`${dir}/lib/types`))
  const prepared = new Map()
  const definitions = mapBrowserDefines(process.env)
  for (const file of modules.filter(file => /^map\/(?:client-ui-brand|ui-settings-lbs|map-container)\/lib\/types\/client\//u.test(file))) {
    prepared.set(file, inlineBrowserDefines(file, readFileSync(join(root, file)), definitions))
  }
  for (const [file, name, exported] of [
    ['map/spatial-scale/lib/types/worker.js', 'WORKER_ENTRY_SOURCE', 'SCALE_WORKER_ENTRY'],
    ['map/spatial-accessibility/lib/types/tianditu-sdk.js', 'TIANDITU_SDK_PAGE_HTML', 'TIANDITU_SDK_PAGE_HTML'],
  ]) {
    const module = await import(pathToFileURL(join(root, file)).href)
    prepared.set(file, inlineEmbeddedPrograms(file, readFileSync(join(root, file)), { [name]: module[exported] }))
  }
  const restore = stagePreparedFiles(root, prepared)
  try {
    const bundled = dirs.filter(dir => existsSync(join(root, dir, 'tsdown.config.ts')))
      .map(dir => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name)
    run([...bundled.flatMap(name => ['--filter', name]), '-r', 'exec', 'tsdown'])
  } finally { restore() }
  process.stdout.write(`map release: prepared ${prepared.size} authored compiler modules; DSH inputs unchanged.\n`)
}
