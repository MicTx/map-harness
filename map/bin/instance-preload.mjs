/** Establish Map instance paths before any upstream CLI, credential, or runtime import. */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeEnvironment, MapHomeError, prepareMapInstance, readMapInstance, resolveMapInstance } from './instance-home.mjs'
import { acquireInstanceLock } from './instance-lock.mjs'

const inheritedKeys = new Set([
  'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_RESOURCE_CACHE', 'DSH_OFFICE_SIDECAR',
  'DSH_SUBPROCESS_RUNNER', 'DSH_PTC_RUNTIME_NODE', 'DSH_RUNTIME_DOWNLOAD',
  'DSH_INSTALL_ROOT', 'DSH_INSTALLATION_ROOT', 'DSH_INSTALLATION_ID', 'PKG_NATIVE_CACHE_PATH',
])
const roles = ['DSH_SUBPROCESS_RUNNER', 'DSH_PTC_RUNTIME_NODE', 'DSH_RUNTIME_DOWNLOAD']
const contextKey = 'MAPHARNESS_INSTANCE_CONTEXT'

function normalizedKey(key) {
  return process.platform === 'win32' ? key.toUpperCase() : key
}

/**
 * Copy the external environment, removing inherited DSH runtime paths and private roles.
 * Provider keys, OS HOME/USERPROFILE, network settings, and non-path DSH controls survive.
 * @param {Record<string, string | undefined>} environment incoming environment
 * @returns {Record<string, string | undefined>} independent environment snapshot
 */
export function externalMapEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const name = normalizedKey(key)
    return !inheritedKeys.has(name) && !name.startsWith('DSH_BUNDLED_')
      && name !== contextKey && name !== 'MAPHARNESS_INSTANCE_ID' && name !== 'MAPHARNESS_BROWSER_NAMESPACE'
  }))
}

function decodeContext(value) {
  let context
  try { context = JSON.parse(value) } catch (error) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'The internal Map entry context is malformed; restart from the product launcher.', { reason: error.name })
  }
  if (context === null || typeof context !== 'object' || context.format !== 1
    || typeof context.home !== 'string' || typeof context.instanceId !== 'string'
    || typeof context.programRoot !== 'string' || !['release', 'source'].includes(context.mode)
    || !['stable', 'preview'].includes(context.channel) || !['portable', 'managed'].includes(context.distribution)) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'The internal Map entry context has invalid identity fields; restart from the product launcher.')
  }
  return context
}

function assertInheritedMarker(spec, context) {
  const inspected = readMapInstance(spec)
  if (inspected === undefined || inspected.instanceId !== context.instanceId) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'The internal Map context does not match this data home or build; restart from its launcher.')
  }
  return inspected
}

/**
 * Resolve an external entry or restore a fixed dispatcher child's already admitted instance.
 * Inherited contexts must name this program and an existing matching marker; external roles
 * alone never select the internal branch. No plugin loads or user files are written here.
 * @param {object} request identity, programRoot, env, cwd and optional homedir/check-out inputs
 * @returns {{spec: object, environment: object, internal: boolean, inherited: boolean}} entry state
 */
export function resolveMapEntry(request) {
  const env = request.env ?? process.env
  const programRoot = realpathSync(request.programRoot)
  const clean = externalMapEnvironment(env)
  const identity = request.identity ?? { mode: 'source', channel: 'stable', distribution: 'portable' }
  const context = env[contextKey] === undefined ? undefined : decodeContext(env[contextKey])
  if (context !== undefined && (context.programRoot !== programRoot || context.mode !== identity.mode
    || context.channel !== identity.channel || context.distribution !== identity.distribution)) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'This internal Map context belongs to another installation or channel.')
  }
  const spec = resolveMapInstance({
    ...identity, env: context === undefined ? env : { ...clean, MAPHARNESS_HOME: context.home },
    cwd: request.cwd, homedir: request.homedir,
    checkoutRoot: identity.mode === 'source' ? programRoot : undefined,
    installRoots: [programRoot],
  })
  const inherited = context === undefined ? spec : assertInheritedMarker(spec, context)
  const internal = context !== undefined && (request.fixedWorker === true || roles.some(key => env[key] !== undefined))
  if (internal) for (const key of roles) if (env[key] !== undefined) clean[key] = env[key]
  return { spec: inherited, environment: clean, internal, inherited: context !== undefined }
}

/**
 * Materialize the fixed instance bridge only after admission (or validated internal re-entry).
 * @param {object} entry resolved entry state
 * @param {string} programRoot this checked-out or installed program directory
 * @returns {Record<string, string | undefined>} child environment with no ambient bundled paths
 */
export function mapEntryEnvironment(entry, programRoot) {
  const { spec } = entry
  if (typeof spec.instanceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(spec.instanceId)) {
    throw new MapHomeError('MAP_ENTRY_CONTEXT', 'Admit the Map instance before creating a child environment.')
  }
  const context = {
    format: 1, home: spec.home, instanceId: spec.instanceId,
    mode: spec.mode, channel: spec.channel, distribution: spec.distribution,
    programRoot: realpathSync(programRoot),
  }
  return {
    ...entry.environment, ...bridgeEnvironment(spec),
    MAPHARNESS_INSTANCE_ID: spec.instanceId,
    MAPHARNESS_BROWSER_NAMESPACE: `map-harness:${spec.instanceId}`,
    [contextKey]: JSON.stringify(context),
  }
}

/**
 * Replace a process environment with its explicit entry snapshot before dynamic imports.
 * @param {Record<string, string | undefined>} environment resolved snapshot
 * @param {Record<string, string | undefined>} [target] process.env by default, or an isolated mapping
 * @returns {void}
 */
export function applyMapEnvironment(environment, target = process.env) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(environment, key)) delete target[key]
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete target[key]
    else target[key] = value
  }
}

/**
 * Distinguish diagnostics from a long-lived writer without starting the upstream parser.
 * @param {string[]} argv public argument tokens
 * @returns {'diagnostic'|'prepare'|'service'} required lifecycle
 */
export function mapEntryMode(argv) {
  if (argv.includes('--prepare')) return 'prepare'
  if (argv.some(arg => ['--help', '-h', '--version', '-v', '-V', '--dump-config', '--dump-default-config', '--dump-config-schema'].includes(arg))) return 'diagnostic'
  return 'service'
}

/**
 * Create a private configuration snapshot for upstream diagnostics that write their include root.
 * Only selected profile metadata and patches are copied; sessions, credentials, and settings
 * are never opened. Profile package links are used for read-only resolution, not rewritten.
 * @param {object} entry path-resolved original entry; its data home is never prepared
 * @param {{initializeProfile: (spec: object) => void, profile?: string}} options profile initializer and optional name
 * @returns {object} diagnostic entry with an idempotent dispose function and a private data home
 * @throws {MapHomeError} invalid profile or linked/non-regular config; private temporary state is cleaned
 */
export function prepareMapDiagnostic(entry, { initializeProfile, profile = 'map-web' }) {
  if (!/^[A-Za-z0-9._-]+$/u.test(profile) || ['.', '..', 'node_modules'].includes(profile)) {
    throw new MapHomeError('MAP_ENTRY_ARGUMENT', 'Select one ordinary profile name for diagnostics.')
  }
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'map-instance-diagnostic-')))
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    process.removeListener('exit', dispose)
    rmSync(temporary, { recursive: true, force: true })
  }
  process.once('exit', dispose)
  const original = entry.spec.home
  const spec = { ...entry.spec, home: temporary, agentsHome: join(temporary, 'agents'), resourceCache: join(temporary, 'cache', 'runtime'), instanceId: undefined }
  const copyConfig = path => {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const ancestor = join(original, ...parts.slice(0, index))
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new MapHomeError('MAP_HOME_CONFLICT', 'Profile configuration ancestors must remain inside the Map data home.', { path })
      }
    }
    const source = join(original, path)
    const info = lstatSync(source, { throwIfNoEntry: false })
    if (info === undefined) return
    if (!info.isFile() || info.isSymbolicLink()) throw new MapHomeError('MAP_HOME_CONFLICT', 'Inspect the linked or non-regular profile configuration before running diagnostics.', { path })
    const destination = join(temporary, path)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
  }
  try {
    const inspected = readMapInstance(entry.spec)
    spec.instanceId = inspected?.instanceId
    for (const path of [`profiles/${profile}/package.json`, `profiles/${profile}/cordis.patch.yml`, 'cordis.patch.yml']) copyConfig(path)
    const sourceModules = join(original, 'profiles', profile, 'node_modules')
    const targetModules = join(temporary, 'profiles', profile, 'node_modules')
    const sourceInfo = lstatSync(sourceModules, { throwIfNoEntry: false })
    if (sourceInfo !== undefined) {
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new MapHomeError('MAP_HOME_CONFLICT', 'Profile dependencies must have an ordinary node_modules directory for diagnostics.')
      const link = (source, destination) => {
        if (!existsSync(source)) return
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
      }
      // Upstream may unlink obsolete package projections; only private directory entries are mutable.
      for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === '@map-harness') continue
        const source = join(sourceModules, entry.name)
        const destination = join(targetModules, entry.name)
        if (entry.name.startsWith('@')) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MapHomeError('MAP_HOME_CONFLICT', 'Inspect the linked package scope before running diagnostics.')
          for (const name of readdirSync(source)) link(join(source, name), join(destination, name))
        } else link(source, destination)
      }
    }
    initializeProfile({ ...spec, instanceId: spec.instanceId ?? 'diagnostic' })
    return { ...entry, spec, dispose }
  } catch (error) {
    dispose()
    if (error instanceof SyntaxError) throw new MapHomeError('MAP_HOME_MARKER_INVALID', 'Restore the malformed instance marker before diagnostics.')
    throw error
  }
}

/**
 * Prepare the source entry before importing dsh. The main process acquires its lifetime
 * lock before profile mutation; diagnostics only write their disposable configuration copy.
 * @param {object} [request] entry inputs; defaults use this checkout and process argv/env
 * @returns {Promise<object>} entry, lifecycle, and an owned release function when applicable
 */
export async function preloadSourceInstance(request = {}) {
  const programRoot = request.programRoot ?? fileURLToPath(new URL('../..', import.meta.url))
  const argv = request.argv ?? process.argv.slice(2)
  const entry = resolveMapEntry({ ...request, programRoot, identity: { mode: 'source', channel: 'stable', distribution: 'portable' } })
  if (request.watcher === true) {
    // The watcher never imports plugins; retain collision inputs for its service child.
    process.env.MAPHARNESS_HOME = entry.spec.home
    return entry
  }
  if (entry.internal) {
    applyMapEnvironment(mapEntryEnvironment(entry, programRoot))
    return { ...entry, lifecycle: 'worker' }
  }
  const lifecycle = mapEntryMode(argv)
  if (argv.some(arg => ['--help', '-h', '--version', '-v', '-V'].includes(arg))) {
    const version = JSON.parse(readFileSync(join(programRoot, 'map/release/version.json'), 'utf8')).version
    process.stdout.write(argv.some(arg => ['--version', '-v', '-V'].includes(arg))
      ? `map-harness v${version}\n`
      : 'Map Harness\nUsage: map-harness [--profile map-web] [--host HOST] [--port PORT] [--no-open]\n       map-harness --prepare | --dump-config | --dump-config-schema | --version\nData home: MAPHARNESS_HOME or the isolated per-checkout Map home.\n')
    process.exit(0)
  }
  const prepareSourceProfile = request.initializeProfile ?? (await import('./map-harness.mjs')).prepareSourceProfile
  if (lifecycle === 'diagnostic') {
    const at = argv.findIndex(arg => arg === '--profile' || arg === '-p')
    const profile = at >= 0 ? argv[at + 1] : argv.find(arg => arg.startsWith('--profile='))?.slice('--profile='.length)
    const diagnostic = prepareMapDiagnostic(entry, { initializeProfile: prepareSourceProfile, profile })
    applyMapEnvironment({ ...entry.environment, ...bridgeEnvironment(diagnostic.spec), MAPHARNESS_BROWSER_NAMESPACE: '' })
    return { ...diagnostic, lifecycle }
  }
  entry.spec = prepareMapInstance(entry.spec)
  const lease = await acquireInstanceLock(entry.spec)
  applyMapEnvironment(mapEntryEnvironment(entry, programRoot))
  try { prepareSourceProfile(entry.spec) } catch (error) {
    await lease.release()
    throw error
  }
  if (lifecycle === 'prepare') await lease.release()
  return { ...entry, lifecycle, release: lease.release }
}
