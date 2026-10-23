#!/usr/bin/env node
/**
 * Build the complete map Web distribution with one branding environment.
 * Community builds remove old outputs before rebuilding upstream and map
 * packages, then bind public source/runtime inputs to a local digest record.
 * Private builds use DSH_CLIENT_MAP_ORG_NAME and never issue that record.
 * Run from the repository root: node map/bin/build-web.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOutputRoots, isPrivate, publicReleaseInputs } from './pack-runtime.mjs'
import { assertCommunityEnvironment, COMMUNITY_TITLE, invalidatePublicBuild, recordPublicBuild } from './public-release-privacy.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const orgName = (process.env.DSH_CLIENT_MAP_ORG_NAME ?? '').trim()
const env = {
  ...process.env,
  DSH_CLIENT_MAP_ORG_NAME: orgName,
  DSH_CLIENT_TITLE: orgName === '' ? COMMUNITY_TITLE : `探索未至之境 x Map Harness · ${orgName}`,
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, env, shell: process.platform === 'win32' })
  if (result.error !== undefined) {
    process.stderr.write('map-harness web build: failed to start a required build step.\n')
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

invalidatePublicBuild(root)
const listing = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
if (listing.status !== 0) throw new Error('Cannot enumerate public build inputs.')
const tracked = listing.stdout.split('\0').filter(file => file.length > 0 && !isPrivate(file))
if (orgName === '') {
  assertCommunityEnvironment(env)
  const outputs = buildOutputRoots(tracked, root)
  for (const output of outputs) {
    const parent = relative(realpathSync(root), realpathSync(dirname(join(root, output))))
    if (parent.startsWith('..') || isAbsolute(parent) || tracked.some(file => file === output || file.startsWith(`${output}/`))) {
      throw new Error('Refusing to clear unsafe or tracked build outputs.')
    }
  }
  // The project cleaner also removes incremental compiler state. The extra
  // roots include map packages and outputs outside its project-reference graph.
  run('pnpm', ['run', 'clean'])
  for (const output of outputs) {
    if (existsSync(join(root, output))) rmSync(join(root, output), { recursive: true, force: true })
  }
}

run('pnpm', ['run', 'build:artifacts'])
run(process.execPath, [join(root, 'map', 'bin', 'build.mjs')])
if (orgName === '') recordPublicBuild(root, publicReleaseInputs(root, tracked), env, tracked)
