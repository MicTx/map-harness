/** Kernel-owned Map writer leases; diagnostic records never establish liveness. */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeFileSync, writeSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MAP_IDENTITY_REVISION, MAP_INSTANCE_FORMAT, MAP_INSTANCE_MARKER, MapHomeError } from './instance-home.mjs'

/** Private directory containing the stable lock inode and non-secret diagnostics. */
export const INSTANCE_LOCK_DIRECTORY = 'map-run'
/** Stable inode retained after release; deleting a live lock forfeits exclusion. */
export const INSTANCE_LOCK_FILE = 'instance.lock'
/** Advisory, bounded diagnostic record; never a PID or readiness authority. */
export const INSTANCE_RECORD_FILE = 'instance.json'

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const checkoutKeyPattern = /^[a-f0-9]{16}$/u
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const channels = ['stable', 'preview']
const modes = ['release', 'source']
const maxRecordBytes = 4096
const noFollow = constants.O_NOFOLLOW ?? 0
const nonBlock = constants.O_NONBLOCK ?? 0

function pathKey(path) {
  return process.platform === 'win32'
    ? path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase()
    : path
}

function pathsFor(spec) {
  if (typeof spec?.home !== 'string' || !isAbsolute(spec.home) || spec.home.includes('\0')
    || spec.productId !== 'map-harness' || typeof spec.instanceId !== 'string' || !uuidPattern.test(spec.instanceId)) {
    throw new MapHomeError('MAP_HOME_INPUT', 'The instance lock needs a prepared Map instance.')
  }
  const directory = join(spec.home, INSTANCE_LOCK_DIRECTORY)
  return { home: spec.home, directory, lock: join(directory, INSTANCE_LOCK_FILE), record: join(directory, INSTANCE_RECORD_FILE) }
}

function invalidPath(path) {
  return new MapHomeError('MAP_INSTANCE_LOCK_FAILED', 'Inspect the Map lock paths; only unchanged, regular local files and directories are supported.', { path })
}

function entryAt(path, directory = false) {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (entry === undefined) return undefined
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1n)) throw invalidPath(path)
  return entry
}

function sameFile(a, b) {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino
}

function assertDirectories(paths, expected) {
  const home = entryAt(paths.home, true)
  if (home === undefined || pathKey(realpathSync.native(paths.home)) !== pathKey(resolve(paths.home))) throw invalidPath(paths.home)
  const directory = entryAt(paths.directory, true)
  if (directory !== undefined && pathKey(realpathSync.native(paths.directory)) !== pathKey(paths.directory)) throw invalidPath(paths.directory)
  if (expected !== undefined && (!sameFile(home, expected.home) || !sameFile(directory, expected.directory))) throw invalidPath(paths.directory)
  return { home, directory }
}

function assertDescriptor(fd, path) {
  const opened = fstatSync(fd, { bigint: true })
  if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, entryAt(path))) throw invalidPath(path)
  return opened
}

function openRegular(path, access, create = false) {
  const flags = access | noFollow | nonBlock
  if (entryAt(path) !== undefined || !create) return openSync(path, flags)
  try { return openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    entryAt(path)
    return openSync(path, flags)
  }
}

function readJson(path) {
  if (entryAt(path) === undefined) return undefined
  const fd = openRegular(path, constants.O_RDONLY)
  try {
    const info = assertDescriptor(fd, path)
    if (info.size > BigInt(maxRecordBytes)) return undefined
    const bytes = Buffer.alloc(maxRecordBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (count === 0) break
      size += count
    }
    if (size > maxRecordBytes) return undefined
    try { return JSON.parse(bytes.toString('utf8', 0, size)) } catch (error) {
      // JSON.parse diagnostics can contain file contents; malformed diagnostics stay absent.
      return undefined
    }
  } finally { closeSync(fd) }
}

function assertMarker(spec, paths) {
  const marker = readJson(join(paths.home, MAP_INSTANCE_MARKER))
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)
    || marker.format !== MAP_INSTANCE_FORMAT || marker.identityRevision !== MAP_IDENTITY_REVISION
    || marker.productId !== spec.productId || typeof marker.instanceId !== 'string' || !uuidPattern.test(marker.instanceId)
    || !modes.includes(marker.mode) || !channels.includes(marker.channel)
    || !validTimestamp(marker.createdAt)
    || (marker.mode === 'source'
      ? typeof marker.checkoutKey !== 'string' || !checkoutKeyPattern.test(marker.checkoutKey)
      : marker.checkoutKey !== null)
    || marker.instanceId !== spec.instanceId || marker.mode !== spec.mode || marker.channel !== spec.channel
    || marker.checkoutKey !== spec.checkoutKey) {
    throw new MapHomeError('MAP_INSTANCE_LOCK_FAILED', 'Restore the matching Map instance marker before starting or inspecting its service.', { home: paths.home })
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && timestampPattern.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

function validVersion(value) {
  return value === null || typeof value === 'string' && value.length <= 128 && versionPattern.test(value)
}

function projectRecord(value, spec) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 1 || value.productId !== spec.productId || value.instanceId !== spec.instanceId
    || typeof value.generationId !== 'string' || !uuidPattern.test(value.generationId)
    || !validVersion(value.version) || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff
    || !validTimestamp(value.startedAt) || !['running', 'stopped'].includes(value.state)
    || value.state === 'stopped' && !validTimestamp(value.stoppedAt)) return undefined
  return {
    format: 1, productId: value.productId, instanceId: value.instanceId, generationId: value.generationId,
    version: value.version, pid: value.pid, startedAt: value.startedAt, state: value.state,
    ...(value.state === 'stopped' ? { stoppedAt: value.stoppedAt } : {}),
  }
}

function makeRecord(spec, metadata) {
  const generationId = metadata.generationId ?? randomUUID()
  const version = metadata.version ?? null
  const startedAt = metadata.now ?? new Date().toISOString()
  if (typeof generationId !== 'string' || !uuidPattern.test(generationId) || !validVersion(version) || !validTimestamp(startedAt)) {
    throw new MapHomeError('MAP_HOME_INPUT', 'Use a UUID generation, a semantic version, and an ISO timestamp for Map lock diagnostics.')
  }
  return Object.freeze({ format: 1, productId: spec.productId, instanceId: spec.instanceId, generationId, version, pid: process.pid, startedAt, state: 'running' })
}

function writeRecord(lease, record) {
  assertDirectories(lease.paths, lease.directories)
  assertDescriptor(lease.fd, lease.paths.lock)
  const fd = openRegular(lease.paths.record, constants.O_WRONLY, true)
  try {
    assertDescriptor(fd, lease.paths.record)
    assertDirectories(lease.paths, lease.directories)
    ftruncateSync(fd, 0)
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`)
  } finally { closeSync(fd) }
}

function winError(api, syscall) {
  return Object.assign(new Error(`The Windows instance lock operation failed: ${syscall}`), {
    code: 'MAP_WIN32_LOCK_FAILED', syscall, win32Code: api.getLastError(),
  })
}

async function windowsBindings() {
  const { default: koffi } = await import('koffi')
  const library = koffi.load('kernel32.dll')
  try {
    return {
      library,
      createSemaphore: library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
      wait: library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
      release: library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
      close: library.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
      getLastError: library.func('__stdcall', 'GetLastError', 'uint', []),
    }
  } catch (error) {
    library.unload()
    throw error
  }
}

/** Attempt every cleanup even when an earlier one fails; never retry an uncertain descriptor close. */
function closeLease(lease) {
  const errors = []
  if (lease.handle !== undefined) {
    const handle = lease.handle
    lease.handle = undefined
    if (lease.held) {
      try { if (lease.api.release(handle, 1, null) === 0) throw winError(lease.api, 'ReleaseSemaphore') } catch (error) { errors.push(error) }
    }
    try { if (lease.api.close(handle) === 0) throw winError(lease.api, 'CloseHandle') } catch (error) { errors.push(error) }
  }
  if (lease.fd !== undefined) {
    const fd = lease.fd
    lease.fd = undefined
    try { closeSync(fd) } catch (error) { errors.push(error) }
  }
  if (lease.api !== undefined) {
    try { lease.api.library.unload() } catch (error) { errors.push(error) }
    lease.api = undefined
  }
  return errors
}

function lockFailure(paths, error, cleanupErrors = []) {
  if (error instanceof MapHomeError && cleanupErrors.length === 0) return error
  return new MapHomeError('MAP_INSTANCE_LOCK_FAILED', 'The Map instance lock failed; no service was started. Inspect the local filesystem and native runtime before retrying.', {
    home: paths.home, reason: error.code, cleanupPending: cleanupErrors.length > 0,
  }, { cause: cleanupErrors.length > 0 ? new AggregateError([error, ...cleanupErrors], 'Instance lock acquisition and cleanup failed') : error })
}

function busy(paths) {
  return new MapHomeError('MAP_INSTANCE_BUSY', 'Another Map instance holds this data root; exit it before starting another.', { home: paths.home })
}

async function openLease(spec, create) {
  const paths = pathsFor(spec)
  const lease = { paths, fd: undefined, api: undefined, handle: undefined, held: false, directories: undefined }
  try {
    const directories = assertDirectories(paths)
    assertMarker(spec, paths)
    if (directories.directory === undefined) {
      if (!create) return undefined
      try { mkdirSync(paths.directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    lease.directories = assertDirectories(paths)
    entryAt(paths.record)
    if (entryAt(paths.lock) === undefined && !create) return undefined
    let tryLockExclusive
    if (process.platform === 'win32') lease.api = await windowsBindings()
    else ({ tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock'))
    assertDirectories(paths, lease.directories)
    assertMarker(spec, paths)
    lease.fd = openRegular(paths.lock, create ? constants.O_RDWR : constants.O_RDONLY, create)
    assertDescriptor(lease.fd, paths.lock)
    if (lease.api !== undefined) {
      const name = `Local\\map-harness-instance-${createHash('sha256').update(pathKey(paths.lock)).digest('hex')}`
      const handle = lease.api.createSemaphore(null, 1, 1, name)
      if (handle === 0) throw winError(lease.api, 'CreateSemaphoreW')
      lease.handle = handle
      const status = lease.api.wait(handle, 0)
      if (status === 0x102) throw busy(paths)
      if (status !== 0) throw winError(lease.api, 'WaitForSingleObject')
    } else {
      try { await tryLockExclusive(lease.fd) } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') throw busy(paths)
        throw error
      }
    }
    lease.held = true
    assertDirectories(paths, lease.directories)
    assertDescriptor(lease.fd, paths.lock)
    entryAt(paths.record)
    return lease
  } catch (error) {
    throw lockFailure(paths, error, closeLease(lease))
  }
}

/**
 * Acquire one main-service lease on a prepared local data root. POSIX uses the
 * public native nonblocking flock export; Windows uses a named kernel semaphore.
 * The caller owns release after all service writes and subprocesses have settled.
 * Native or path failures stop acquisition; no PID, expiry, or HTTP fallback exists.
 * Failed publication closes every acquired handle; the lock directory, stable inode,
 * and a partial advisory record may remain. Windows uses the local session namespace;
 * this module does not establish exclusion across Windows login sessions or machines.
 * @param {object} spec prepared Map instance with canonical home and marker identity
 * @param {{version?: string, generationId?: string, now?: string}} [metadata] semantic version and optional UUID/ISO diagnostics; absent values use null, randomUUID, and the current time
 * @returns {Promise<{release: () => Promise<void>, record: object, lockPath: string}>} owned lease; release is idempotent, writes stopped while locked, and removes its exit listener
 * @throws {MapHomeError} MAP_INSTANCE_BUSY for contention; MAP_INSTANCE_LOCK_FAILED for native, path, or publication errors; MAP_INSTANCE_RELEASE_FAILED reports uncertain cleanup or diagnostic writes
 */
export async function acquireInstanceLock(spec, metadata = {}) {
  const paths = pathsFor(spec)
  const record = makeRecord(spec, metadata)
  let lease
  try { lease = await openLease(spec, true) } catch (error) {
    if (error.code === 'MAP_INSTANCE_BUSY') error.details.record = readInstanceRecord(spec)
    throw error
  }
  try { writeRecord(lease, record) } catch (error) { throw lockFailure(paths, error, closeLease(lease)) }
  let released = false
  let releaseError
  const releaseSync = () => {
    if (released) {
      if (releaseError !== undefined) throw releaseError
      return
    }
    released = true
    process.off('exit', onExit)
    let recordError
    let recordUpdated = false
    try {
      assertDirectories(paths, lease.directories)
      assertDescriptor(lease.fd, paths.lock)
      const latest = projectRecord(readJson(paths.record), spec)
      if (latest?.instanceId === record.instanceId && latest.generationId === record.generationId) {
        writeRecord(lease, { ...record, state: 'stopped', stoppedAt: new Date().toISOString() })
        recordUpdated = true
      }
    } catch (error) { recordError = error }
    const cleanupErrors = closeLease(lease)
    if (recordError !== undefined || cleanupErrors.length > 0) {
      releaseError = new MapHomeError('MAP_INSTANCE_RELEASE_FAILED', 'Inspect the Map instance diagnostics or handle cleanup before restarting; the service must remain stopped.', {
        home: paths.home, recordUpdated, lockReleased: cleanupErrors.length === 0 ? true : 'unknown',
      }, { cause: new AggregateError([...(recordError === undefined ? [] : [recordError]), ...cleanupErrors], 'Instance lock release failed') })
      throw releaseError
    }
  }
  const onExit = () => {
    try { releaseSync() } catch (error) {
      process.exitCode ||= 1
      try { writeSync(2, `${error.code}: inspect the Map instance lock cleanup before restarting.\n`) } catch (reportError) {
        // Exit has no writable diagnostic channel left; retain the nonzero outcome.
        process.exitCode ||= 1
      }
    }
  }
  process.once('exit', onExit)
  return { release: async () => releaseSync(), record, lockPath: paths.lock }
}

/**
 * Read only the bounded diagnostic allowlist; unknown fields, paths, URLs and secrets never escape.
 * @param {object} spec prepared Map instance
 * @returns {object|undefined} strictly validated matching record, or undefined for absent, malformed, inaccessible, or link-shaped files
 */
export function readInstanceRecord(spec) {
  try {
    const paths = pathsFor(spec)
    assertDirectories(paths)
    assertMarker(spec, paths)
    return projectRecord(readJson(paths.record), spec)
  } catch (error) {
    // Diagnostics are optional and never establish a lease; callers use the kernel probe.
    return undefined
  }
}

/**
 * Observe a local kernel lock with an independent descriptor and a zero-wait acquisition.
 * This creates no directory, lock file, or diagnostic record and never modifies existing bytes.
 * A missing lock for a valid prepared marker is stopped; native/path/marker uncertainty is unknown.
 * The observation is not a reservation: maintenance writers must acquire their own lease.
 * @param {object} spec prepared Map instance
 * @returns {Promise<'stopped'|'locked'|'unknown'>} kernel observation; diagnostic state and PIDs are ignored
 */
export async function probeInstanceLock(spec) {
  let lease
  try { lease = await openLease(spec, false) } catch (error) {
    return error.code === 'MAP_INSTANCE_BUSY' ? 'locked' : 'unknown'
  }
  return lease === undefined || closeLease(lease).length === 0 ? 'stopped' : 'unknown'
}

/**
 * Inspect marker and kernel evidence without claiming application readiness.
 * @param {object} spec prepared Map instance
 * @returns {Promise<'stopped'|'locked'|'unknown'>} current probe; a stale running record never means locked
 */
export async function inspectInstanceState(spec) {
  return probeInstanceLock(spec)
}
