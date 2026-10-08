#!/usr/bin/env node
/**
 * map-harness web build: runs the upstream web frontend build with the map
 * brand title injected through the upstream public build env seam
 * (`DSH_CLIENT_TITLE`). Upstream consumes any `DSH_CLIENT_*` variable at
 * build time (`scripts/client-build-environment.ts`), so this stays a
 * zero-patch integration: no upstream file is modified.
 *
 * Run from the repository root: `node map/bin/build-web.mjs`
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const env = {
  ...process.env,
  DSH_CLIENT_TITLE: 'Map Harness',
}

const mapBuild = spawnSync(process.execPath, [join(root, 'map', 'bin', 'build.mjs')], {
  stdio: 'inherit',
  env,
  cwd: root,
  shell: process.platform === 'win32',
})
if (mapBuild.error !== undefined) {
  process.stderr.write(`map-harness web build: failed to start map package build: ${String(mapBuild.error)}\n`)
  process.exit(1)
}
if (mapBuild.status !== 0) process.exit(mapBuild.status ?? 1)

const result = spawnSync('pnpm', ['run', 'build:web'], {
  stdio: 'inherit',
  env,
  cwd: root,
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
