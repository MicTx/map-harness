/** Standalone Map data-home admission, marker publication, and engine environment bridge. */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Instance marker filename; its version is independent of Session formats. */
export const MAP_INSTANCE_MARKER = 'map-instance.json'
/** Supported instance identity format. */
export const MAP_INSTANCE_FORMAT = 'map-harness-instance-1'
/** Supported product identity revision. */
export const MAP_IDENTITY_REVISION = 1

const productId = 'map-harness'
const channels = ['stable', 'preview']
const modes = ['release', 'source']
const distributions = ['portable', 'managed']
const instanceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const checkoutKeyPattern = /^[a-f0-9]{16}$/u
const inheritedPathKeys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_RESOURCE_CACHE', 'DSH_OFFICE_SIDECAR']
const initializationDirectory = '.map-initialize'

/** Home failures expose stable codes and metadata, never the contents of user files. */
export class MapHomeError extends Error {
  /**
   * @param {string} code machine-readable failure discriminator
   * @param {string} message failing subject and corrective action
   * @param {object} [details] non-secret operation metadata; empty when absent
   * @param {ErrorOptions} [options] original I/O or parse cause, when present
   */
  constructor(code, message, details = {}, options) {
    super(message, options)
    this.name = 'MapHomeError'
    this.code = code
    this.details = details
  }
}

function expandPath(value, userHome, cwd) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new MapHomeError('MAP_HOME_INPUT', 'A data or installation path must be a non-blank string without NUL bytes.')
  }
  const expanded = value === '~' ? userHome
    : value.startsWith('~/') || value.startsWith('~\\') ? join(userHome, value.slice(2)) : value
  return resolve(cwd, expanded)
}

function pathFailure(path, error) {
  return new MapHomeError('MAP_HOME_PATH', `Inspect the inaccessible or invalid directory path: ${path}`, {
    path, reason: error.code,
  }, { cause: error })
}

/** Resolve existing ancestors, without treating permissions, files, or dangling links as missing directories. */
function canonicalPath(path) {
  let ancestor = path
  const missing = []
  for (;;) {
    let canonical
    try { canonical = realpathSync.native(ancestor) } catch (error) {
      if (error.code !== 'ENOENT') throw pathFailure(path, error)
      let entry
      try { entry = lstatSync(ancestor, { throwIfNoEntry: false }) } catch (error) { throw pathFailure(path, error) }
      if (entry?.isSymbolicLink() || dirname(ancestor) === ancestor) throw pathFailure(path, error)
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
      continue
    }
    if (missing.length > 0 && !statSync(canonical).isDirectory()) {
      throw new MapHomeError('MAP_HOME_PATH', `A parent of the data directory is a regular file: ${canonical}`, { path })
    }
    return join(canonical, ...missing)
  }
}

function pathKey(path) {
  if (process.platform !== 'win32') return path
  return path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase()
}

function contains(parent, child) {
  const suffix = relative(pathKey(parent), pathKey(child))
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function pathsOverlap(a, b) {
  const left = pathKey(a)
  const right = pathKey(b)
  const prefix = value => value.endsWith(sep) ? value : `${value}${sep}`
  return left === right || left.startsWith(prefix(right)) || right.startsWith(prefix(left))
}

function assertNoCollisions(home, roots) {
  const actualHome = canonicalPath(home)
  for (const root of roots) {
    if (pathsOverlap(actualHome, canonicalPath(root.path))) {
      throw new MapHomeError('MAP_HOME_CONFLICT', 'Choose a Map data home separate from DSH, installation, and import-source roots.', {
        home, conflictingRoot: root.path, kind: root.kind,
      })
    }
  }
  return actualHome
}

/**
 * Resolve one build's instance without creating files or changing the environment.
 * Only non-blank MAPHARNESS_HOME selects a root; surrounding path spaces remain literal.
 * Ambient DSH roots participate only in collision checks. Source checkouts get distinct,
 * canonical-path-derived keys. Callers must pass the program root in installRoots.
 * @param {object} [request] omitted fields use the OS environment and stable portable release identity
 * @param {Record<string, string | undefined>} [request.env] public environment inputs
 * @param {string} [request.cwd] base for relative overrides; defaults to process.cwd()
 * @param {string} [request.homedir] OS user home; defaults to os.homedir(), not DSH_HOME
 * @param {'source'|'release'} [request.mode] source requires checkoutRoot; default release
 * @param {'stable'|'preview'} [request.channel] build-record channel, default stable
 * @param {'portable'|'managed'} [request.distribution] build-record distribution, default portable
 * @param {string} [request.checkoutRoot] source checkout root; unused for releases
 * @param {string[]} [request.installRoots] program directories forbidden as data roots
 * @param {string[]} [request.dshRoots] additional known DSH directories
 * @param {string} [request.migrationSource] import source forbidden as a data root
 * @returns {object} resolved paths and identity for prepareMapInstance and bridgeEnvironment
 * @throws {MapHomeError} invalid input, inaccessible paths, or overlapping roots; no writes occur
 */
export function resolveMapInstance(request = {}) {
  const environment = request.env ?? process.env
  const cwd = resolve(request.cwd ?? process.cwd())
  const userHome = expandPath(request.homedir ?? homedir(), homedir(), cwd)
  const mode = request.mode ?? 'release'
  const channel = request.channel ?? 'stable'
  const distribution = request.distribution ?? 'portable'
  if (!modes.includes(mode) || !channels.includes(channel) || !distributions.includes(distribution)) {
    throw new MapHomeError('MAP_HOME_INPUT', 'Select a supported Map mode, build channel, and distribution.', { mode, channel, distribution })
  }
  const checkoutKey = mode === 'source'
    ? createHash('sha256').update(pathKey(canonicalPath(expandPath(request.checkoutRoot, userHome, cwd)))).digest('hex').slice(0, 16)
    : null
  const selected = environment.MAPHARNESS_HOME
  const overridden = selected !== undefined && selected.trim() !== ''
  const defaultHome = mode === 'source' ? join(userHome, '.map-harness-dev', checkoutKey)
    : join(userHome, channel === 'preview' ? '.map-harness-preview' : '.map-harness')
  const roots = [
    { kind: 'stock-dsh', path: join(userHome, '.dsh') },
    { kind: 'stock-agents', path: join(userHome, '.agents') },
    { kind: 'stock-runtime', path: join(userHome, '.cache', 'deepseek-harness') },
    ...inheritedPathKeys.filter(key => environment[key]?.trim()).map(key => ({ kind: key, path: expandPath(environment[key], userHome, cwd) })),
    ...(request.dshRoots ?? []).map(path => ({ kind: 'dsh', path: expandPath(path, userHome, cwd) })),
    ...(request.installRoots ?? []).map(path => ({ kind: 'installation', path: expandPath(path, userHome, cwd) })),
    ...(request.migrationSource === undefined ? [] : [{ kind: 'import-source', path: expandPath(request.migrationSource, userHome, cwd) }]),
  ]
  const home = assertNoCollisions(expandPath(overridden ? selected : defaultHome, userHome, cwd), roots)
  return {
    productId, format: MAP_INSTANCE_FORMAT, identityRevision: MAP_IDENTITY_REVISION,
    home, agentsHome: join(home, 'agents'), resourceCache: join(home, 'cache', 'runtime'),
    mode, channel, distribution, checkoutKey, overridden, collisionRoots: roots,
  }
}

/**
 * Produce internal engine paths without modifying the supplied environment or OS home.
 * External launch preludes separately remove inherited bundled-runtime paths and role selectors.
 * @param {object} spec resolved Map instance
 * @returns {{MAPHARNESS_HOME: string, DSH_HOME: string, DSH_AGENTS_HOME: string, DSH_RESOURCE_CACHE: string, PKG_NATIVE_CACHE_PATH: string}} fixed instance paths
 */
export function bridgeEnvironment(spec) {
  return {
    MAPHARNESS_HOME: spec.home, DSH_HOME: spec.home,
    DSH_AGENTS_HOME: spec.agentsHome, DSH_RESOURCE_CACHE: spec.resourceCache,
    PKG_NATIVE_CACHE_PATH: spec.resourceCache,
  }
}

function readMarker(spec) {
  const path = join(spec.home, MAP_INSTANCE_MARKER)
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry === undefined) return undefined
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new MapHomeError('MAP_HOME_MARKER_INVALID', 'The Map instance marker must be a regular file; inspect or restore it before starting.', { path })
  }
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) { throw pathFailure(path, error) }
  let marker
  try { marker = JSON.parse(text) } catch (error) {
    // JSON.parse includes input bytes in SyntaxError; retain only its classification.
    throw new MapHomeError('MAP_HOME_MARKER_INVALID', 'Restore the malformed Map instance marker before starting.', { path, reason: error.name })
  }
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)
    || marker.format !== MAP_INSTANCE_FORMAT || marker.identityRevision !== MAP_IDENTITY_REVISION
    || marker.productId !== productId || typeof marker.instanceId !== 'string' || !instanceIdPattern.test(marker.instanceId)
    || !modes.includes(marker.mode) || !channels.includes(marker.channel)
    || typeof marker.createdAt !== 'string' || !Number.isFinite(Date.parse(marker.createdAt))
    || (marker.mode === 'source'
      ? typeof marker.checkoutKey !== 'string' || !checkoutKeyPattern.test(marker.checkoutKey)
      : marker.checkoutKey !== null)) {
    throw new MapHomeError('MAP_HOME_MARKER_INVALID', 'The Map instance marker is damaged or uses an unsupported identity version; restore it or use a new data home.', { path })
  }
  if (marker.mode !== spec.mode || marker.channel !== spec.channel || marker.checkoutKey !== spec.checkoutKey) {
    throw new MapHomeError('MAP_HOME_CONFLICT', 'This data home belongs to a different Map mode, channel, or source checkout; choose a separate data home.', { path })
  }
  return marker
}

/** New directories are private; existing permissions are never silently changed. */
function privateDirectory(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry !== undefined) {
    if (!statSync(path).isDirectory()) throw new MapHomeError('MAP_HOME_PATH', `Expected a directory: ${path}`, { path })
    return
  }
  privateDirectory(dirname(path))
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!statSync(path).isDirectory()) throw error
  }
}

function assertPrivateRoots(spec) {
  for (const path of [spec.agentsHome, spec.resourceCache]) {
    const actual = canonicalPath(path)
    if (!contains(spec.home, actual) || pathKey(actual) === pathKey(spec.home)) {
      throw new MapHomeError('MAP_HOME_CONFLICT', 'Map agents and runtime cache directories must remain inside this data home.', { path })
    }
  }
}

function assertResolvedHome(spec) {
  if (pathKey(assertNoCollisions(spec.home, spec.collisionRoots)) !== pathKey(spec.home)) {
    throw new MapHomeError('MAP_HOME_CONFLICT', 'The resolved Map home changed; resolve it again before preparing the instance.', { home: spec.home })
  }
}

function validateUnmarkedEntries(spec, allowed = []) {
  const entries = readdirSync(spec.home)
  if (entries.some(name => !allowed.includes(name))) {
    throw new MapHomeError('MAP_HOME_UNCLAIMED', 'Use an explicit import/claim for this non-empty, unmarked Map data home.', { home: spec.home })
  }
}

/** A reservation serializes first publication only; it never represents a running service. */
function initializeMarker(spec) {
  const reservation = join(spec.home, initializationDirectory)
  try { mkdirSync(reservation, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const marker = readMarker(spec)
    if (marker !== undefined) return { marker, created: false }
    throw new MapHomeError('MAP_HOME_INITIALIZING', 'Another initialization is in progress or left a reservation; retry after it exits, or inspect the reservation before explicit recovery.', { home: spec.home, reservation })
  }
  const temporary = join(reservation, 'marker.json')
  let marker
  let created = false
  let operationError
  let cleanupError
  let ownsTemporary = false
  try {
    assertResolvedHome(spec)
    marker = readMarker(spec)
    if (marker === undefined) {
      validateUnmarkedEntries(spec, [initializationDirectory])
      const candidate = {
        format: MAP_INSTANCE_FORMAT, productId, identityRevision: MAP_IDENTITY_REVISION,
        instanceId: randomUUID(), mode: spec.mode, channel: spec.channel,
        checkoutKey: spec.checkoutKey, createdAt: new Date().toISOString(),
      }
      const file = openSync(temporary, 'wx', 0o600)
      ownsTemporary = true
      try {
        writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`)
        fsyncSync(file)
      } finally { closeSync(file) }
      assertResolvedHome(spec)
      validateUnmarkedEntries(spec, [initializationDirectory])
      try { linkSync(temporary, join(spec.home, MAP_INSTANCE_MARKER)) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      marker = readMarker(spec)
      if (marker === undefined) throw new MapHomeError('MAP_HOME_IO', 'The instance marker disappeared during publication; inspect the data home before retrying.', { home: spec.home })
      created = marker.instanceId === candidate.instanceId
    }
  } catch (error) { operationError = error }
  if (ownsTemporary) {
    try { unlinkSync(temporary) } catch (error) { cleanupError = error }
  }
  try { rmdirSync(reservation) } catch (error) { cleanupError ??= error }
  if (cleanupError !== undefined) {
    throw new MapHomeError('MAP_HOME_IO', 'Inspect the retained initialization reservation before recovery.', {
      home: spec.home, reservation, markerPresent: marker !== undefined, createdByThisCall: created,
      cleanupPending: true, cleanupReason: cleanupError.code,
    }, { cause: operationError ?? cleanupError })
  }
  if (operationError !== undefined) throw operationError
  return { marker, created }
}

function prepare(spec) {
  assertResolvedHome(spec)
  assertPrivateRoots(spec)
  let marker = readMarker(spec)
  let created = false
  if (marker === undefined) {
    const entry = lstatSync(spec.home, { throwIfNoEntry: false })
    if (entry !== undefined && !statSync(spec.home).isDirectory()) {
      throw new MapHomeError('MAP_HOME_PATH', `Expected a data directory: ${spec.home}`, { path: spec.home })
    }
    if (entry !== undefined && lstatSync(join(spec.home, initializationDirectory), { throwIfNoEntry: false }) === undefined) {
      try { validateUnmarkedEntries(spec) } catch (error) {
        marker = readMarker(spec)
        if (marker === undefined) {
          if (lstatSync(join(spec.home, initializationDirectory), { throwIfNoEntry: false }) !== undefined) {
            throw new MapHomeError('MAP_HOME_INITIALIZING', 'Wait for the Map initialization reservation to settle before retrying.', { home: spec.home })
          }
          throw error
        }
      }
    }
    if (marker === undefined) {
      privateDirectory(spec.home)
      assertResolvedHome(spec)
      const initialized = initializeMarker(spec)
      marker = initialized.marker
      created = initialized.created
    }
  }
  assertPrivateRoots(spec)
  privateDirectory(spec.agentsHome)
  privateDirectory(spec.resourceCache)
  return { ...spec, instanceId: marker.instanceId, marker, created }
}

/**
 * Inspect an existing Map identity without creating directories or rewriting the marker.
 * @param {object} spec result from resolveMapInstance
 * @returns {object|undefined} instance with its validated marker, or undefined for an unmarked root
 * @throws {MapHomeError} malformed identity or changed/conflicting canonical paths
 */
export function readMapInstance(spec) {
  assertResolvedHome(spec)
  assertPrivateRoots(spec)
  const marker = readMarker(spec)
  return marker === undefined ? undefined : { ...spec, instanceId: marker.instanceId, marker, created: false }
}

/**
 * Admit an empty or marked root and prepare its agents/runtime directories.
 * A private first-use reservation publishes a flushed marker without replacement.
 * Contention or an interrupted first use yields MAP_HOME_INITIALIZING, never takeover;
 * valid markers retain identity across restarts and portable/managed delivery changes.
 * Non-empty unmarked roots require explicit import/claim. Invalid markers remain unchanged.
 * Profiles, credentials, stores, and the main service lock belong to subsequent callers.
 * @param {object} spec result from resolveMapInstance; canonical paths are rechecked before writes
 * @returns {object} spec plus instanceId, marker, and whether this call created the marker
 * @throws {MapHomeError} admission or I/O failure; directories or a valid marker may remain for retry, and cleanup failures report markerPresent and cleanupPending
 */
export function prepareMapInstance(spec) {
  try { return prepare(spec) } catch (error) {
    if (error instanceof MapHomeError) throw error
    let markerPresent
    try { markerPresent = lstatSync(join(spec.home, MAP_INSTANCE_MARKER), { throwIfNoEntry: false }) !== undefined } catch (probeError) {
      // An inaccessible root leaves publication unknown; preserve the original I/O failure.
      markerPresent = 'unknown'
    }
    throw new MapHomeError('MAP_HOME_IO', 'Inspect the Map data-home I/O failure before retrying preparation.', {
      home: spec.home, reason: error.code, markerPresent,
    }, { cause: error })
  }
}
