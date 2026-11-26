/** Managed installation transactions: verified staging, dual slots, receipts, and maintenance. */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, copyFileSync, createReadStream, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { INSTALL_MANIFEST_FILE, MapInstallError, validateInstallManifest } from './install-manifest.mjs'
import { readMapInstance, resolveMapInstance } from './instance-home.mjs'
import { probeInstanceLock } from './instance-lock.mjs'
import {
  ACTIVE_SLOT, INSTALLATION_MARKER, INSTALL_RESERVATION, LAUNCHER, MAINTENANCE_LOCK, MANAGED_LAYOUT_FORMAT,
  RECEIPTS_DIRECTORY, SLOTS_DIRECTORY, STAGING_PREFIX, VERSIONS_DIRECTORY, WINDOWS_LAUNCHER,
  WINDOWS_LAUNCHER_SCRIPT, assertSeparateRoots, availableBytes, checkedInstallPath, detectHostTarget,
  inspectManagedInstall, installOwnedEntries, launcherTemplates, pathsOverlap, pointerFor, slotMetadataName,
  versionDirectoryName,
} from './install-layout.mjs'

/** Receipt format shared by installation and maintenance operations. */
export const INSTALL_RECEIPT_FORMAT = 'map-harness-install-receipt-1'
const PAYLOAD_MANIFEST = 'web-service-manifest.json'
// The fixed reserve covers transaction metadata, allocation units, and the final receipt.
const METADATA_RESERVE = 2 * 1024 * 1024
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const SLOT_IDS = ['A', 'B']

const require = createRequire(import.meta.url)
const nativeRequire = createRequire(new URL('../../packages/session/session-persistence-jsonl/package.json', import.meta.url))

function fail(code, message, details = {}) {
  throw new MapInstallError(code, message, details)
}

function ioFailure(error) {
  if (error instanceof MapInstallError) return error
  return new MapInstallError(['ENOSPC', 'EDQUOT'].includes(error.code) ? 'MAP_INSTALL_SPACE' : 'MAP_INSTALL_IO',
    'The installation operation stopped; inspect the receipt, free space, and directory permissions before retrying.',
    { reason: error.code ?? error.name }, { cause: error })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function parseJson(bytes, path) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the malformed installation metadata from the verified release.', { path, reason: error.name })
  }
}

function readChecked(root, path) {
  return readFileSync(checkedInstallPath(root, path))
}

async function hashFile(path) {
  const hash = createHash('sha256')
  // Async iteration closes the file handle before another operation can publish or remove it.
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function durableFile(path, bytes, mode = 0o600) {
  const fd = openSync(path, 'wx', mode)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Atomically replace a product-owned metadata file, never a version-payload file.
 * @param {string} path destination with a validated, owned parent
 * @param {Buffer|string} bytes complete content
 * @param {number} [mode] new file mode, default private read/write
 * @returns {void} the replacement has been flushed before rename
 */
export function writeAtomic(path, bytes, mode = 0o600) {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`)
  try {
    durableFile(temporary, bytes, mode)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function expectedFromMarker(marker) {
  return { product: marker.product, distribution: marker.distribution, channel: marker.channel,
    target: marker.target, version: marker.version, identityRevision: marker.identityRevision,
    sourceDigest: marker.sourceDigest, payloadSha256: marker.payloadSha256 }
}

function readPackage(packageRoot, expected, installedManifest = null) {
  let manifestName = INSTALL_MANIFEST_FILE
  if (lstatSync(join(packageRoot, manifestName), { throwIfNoEntry: false }) === undefined) {
    manifestName = `${expected.target}/${INSTALL_MANIFEST_FILE}`
  }
  const manifestBytes = readChecked(packageRoot, manifestName)
  const manifest = parseJson(manifestBytes, manifestName)
  if (manifest?.payload?.manifest !== PAYLOAD_MANIFEST) fail('MAP_INSTALL_SCHEMA', 'The package must name the fixed Web service manifest.')
  const payloadBytes = readChecked(packageRoot, PAYLOAD_MANIFEST)
  if (sha256(payloadBytes) !== expected.payloadSha256) {
    fail('MAP_INSTALL_DIGEST', 'The payload manifest differs from the independently selected release digest.')
  }
  const payload = parseJson(payloadBytes, PAYLOAD_MANIFEST)
  if (!Array.isArray(payload?.targets)) fail('MAP_INSTALL_PAYLOAD', 'Restore the release target inventory before installing.')
  const buildRecordBytes = Object.create(null)
  for (const row of payload.targets) {
    if (row === null || typeof row !== 'object' || typeof row.target !== 'string'
      || !/^(?:mac|linux|win)-(?:x64|arm64)$/u.test(row.target) || Object.hasOwn(buildRecordBytes, row.target)) {
      fail('MAP_INSTALL_PAYLOAD', 'Restore the distinct native build-record inventory.')
    }
    buildRecordBytes[row.target] = readChecked(packageRoot, row.record)
  }
  const valid = validateInstallManifest(manifest, {
    expected, payloadManifestBytes: payloadBytes, buildRecordBytes, installedManifest,
  })
  return { ...valid, root: packageRoot, manifestBytes, payloadBytes, buildRecordBytes }
}

/**
 * Verify every manifest-listed file digest; with `exact`, also enforce the executable bit and
 * reject any unlisted entry inside the version payload.
 * @param {object} pkg readPackage result (root may be redirected to a staged copy)
 * @param {boolean} [exact] enforce inventory and permission exactness
 * @returns {Promise<number>} total payload bytes
 */
async function verifyFiles(pkg, exact = false) {
  let bytes = pkg.manifestBytes.length + pkg.payloadBytes.length
  for (const row of pkg.payloadManifest.files) {
    const path = checkedInstallPath(pkg.root, row.path)
    if (await hashFile(path) !== row.sha256) fail('MAP_INSTALL_DIGEST', 'A payload file differs from its verified digest.', { path: row.path })
    const entry = lstatSync(path)
    if (exact && process.platform !== 'win32' && row.executable && (entry.mode & 0o100) === 0) {
      fail('MAP_INSTALL_STATE', 'Restore the executable permission of the installed payload.', { path: row.path })
    }
    bytes += entry.size
  }
  if (exact) {
    const files = new Set([INSTALL_MANIFEST_FILE, PAYLOAD_MANIFEST, ...pkg.payloadManifest.files.map(row => row.path)])
    const directories = new Set()
    for (const path of files) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'))
    }
    const visit = relative => {
      for (const entry of readdirSync(join(pkg.root, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory() && directories.has(path)) visit(path)
        else if (!entry.isFile() || !files.has(path)) fail('MAP_INSTALL_STATE', 'Preserve and inspect unknown content in the immutable version directory.', { path })
      }
    }
    visit('')
  }
  return bytes
}

function assertFreshOrReady(layout) {
  if (layout.state === 'not-directory') fail('MAP_INSTALL_IO', 'Choose a real program directory rather than a file or link.')
  if (layout.state === 'foreign') {
    fail('MAP_INSTALL_REFUSED', 'The program root contains unrelated content; choose a new empty root and retain its existing files.', { unknown: layout.unknown })
  }
  if (!['absent', 'empty', 'ready'].includes(layout.state)) {
    fail('MAP_INSTALL_STATE', 'The managed root is incomplete or damaged; run manage doctor and inspect its receipt before repair.', { state: layout.state, reason: layout.reason })
  }
}

function resolveDataHome(request, pkg, layout) {
  const userHome = request.homedir ?? homedir()
  const raw = request.dataHome ?? request.env?.MAPHARNESS_HOME
  const selected = typeof raw === 'string' && raw.trim() !== '' ? raw
    : layout.marker?.dataHome ?? join(userHome, pkg.manifest.channel === 'preview' ? '.map-harness-preview' : '.map-harness')
  if (!isAbsolute(selected) || /[\0\r\n]/u.test(selected)) fail('MAP_INSTALL_INPUT', 'Supply an absolute single-line Map data-home path.')
  assertSeparateRoots({ installRoot: request.installRoot, dataHome: selected, homedir: userHome })
  return selected
}

function markerFor(request, pkg, receipt, dataHome) {
  return {
    format: MANAGED_LAYOUT_FORMAT, product: pkg.manifest.product, installationId: receipt.installationId,
    channel: pkg.manifest.channel, target: pkg.manifest.target, distribution: 'managed', identityRevision: pkg.manifest.identityRevision,
    version: pkg.manifest.version, sourceDigest: pkg.manifest.sourceDigest, payloadSha256: pkg.manifest.payload.sha256,
    manifestSha256: sha256(pkg.manifestBytes), operationId: receipt.operationId, dataHome,
    ownedEntries: installOwnedEntries(), createdAt: receipt.startedAt,
  }
}

function makeReceipt(request, pkg, operationId, dataHome, installationId) {
  return {
    format: INSTALL_RECEIPT_FORMAT, operation: 'install', operationId, installationId,
    installRoot: request.installRoot, dataHome, startedAt: new Date().toISOString(), finishedAt: null,
    version: pkg.manifest.version, sourceDigest: pkg.manifest.sourceDigest, payloadSha256: pkg.manifest.payload.sha256,
    manifestSha256: sha256(pkg.manifestBytes), target: pkg.manifest.target, channel: pkg.manifest.channel,
    distribution: 'managed', files: { count: pkg.payloadManifest.files.length, bytes: 0 },
    state: 'not-committed', result: 'pending', cleanup: 'pending', error: null,
  }
}

function launcherFiles(dataHome) {
  const templates = launcherTemplates(dataHome)
  return [[LAUNCHER, templates.posix, 0o700], [WINDOWS_LAUNCHER, templates.windows, 0o600],
    [WINDOWS_LAUNCHER_SCRIPT, templates.windowsScript, 0o600]]
}

async function stagePackage(pkg, stage) {
  const payloadRoot = join(stage, 'payload')
  mkdirSync(payloadRoot, { mode: 0o700 })
  for (const row of pkg.payloadManifest.files) {
    const source = checkedInstallPath(pkg.root, row.path)
    const destination = join(payloadRoot, row.path)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
    if (process.platform !== 'win32') chmodSync(destination, row.executable ? 0o700 : 0o600)
    const fd = openSync(destination, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  durableFile(join(payloadRoot, INSTALL_MANIFEST_FILE), pkg.manifestBytes)
  durableFile(join(payloadRoot, PAYLOAD_MANIFEST), pkg.payloadBytes)
  await verifyFiles({ ...pkg, root: payloadRoot }, true)
  return payloadRoot
}

async function installedNoop(request, layout, pkg, receipt, dataHome) {
  if (layout.marker.dataHome !== dataHome) fail('MAP_INSTALL_INPUT', 'Retain the recorded data home when repeating an installation.')
  if (layout.marker.manifestSha256 !== sha256(pkg.manifestBytes)) fail('MAP_VERSION_CONFLICT', 'The installed manifest bytes differ for this version.')
  const installedRoot = checkedInstallPath(request.installRoot, layout.pointers[layout.activeSlot], 'directory')
  const installed = readPackage(installedRoot, request.expected)
  await verifyFiles(installed, true)
  for (const [name, bytes] of launcherFiles(dataHome)) {
    if (!readChecked(request.installRoot, name).equals(Buffer.from(bytes))) fail('MAP_INSTALL_STATE', 'Restore the managed launcher before repeating installation.', { path: name })
  }
  receipt.state = 'committed'
  receipt.result = 'no-op'
  receipt.cleanup = 'done'
  receipt.finishedAt = new Date().toISOString()
  writeAtomic(join(request.installRoot, RECEIPTS_DIRECTORY, `${receipt.operationId}.json`), jsonBytes(receipt))
  return receipt
}

/**
 * Install a complete managed package; changing an installed version requires maintenance.
 * The caller supplies independent release identity. Initial install claims only an empty root,
 * verifies source and staged bytes, publishes immutable payload/metadata, and replaces active-slot
 * last. An exclusive short reservation is held across every write; interrupted reservations are
 * never stolen. Data roots are recorded but never created. No-op checks all installed bytes and
 * records a new receipt without replacing payloads or pointers. Errors expose operationId and
 * committed state; partial initial installs stay visible for explicit repair, not automatic reuse.
 * @param {object} request absolute packageRoot/installRoot, expected release identity, optional dataHome/homedir/env
 * @param {object} [deps] optional statfs provider for deterministic filesystem-capacity tests
 * @returns {Promise<object>} final receipt; cleanup-pending is separate from activation
 * @throws {MapInstallError} invalid package/root, busy reservation, space, permission, or I/O failure
 */
export async function runManagedInstall(request, deps = {}) {
  const operationId = randomUUID()
  let reserved = false
  let stageOwned = false
  let markerPublished = false
  let committed = false
  let receipt
  let stage
  let reservation
  let errorToThrow
  try {
    if (request === null || typeof request !== 'object' || typeof request.installRoot !== 'string' || !isAbsolute(request.installRoot)
      || typeof request.packageRoot !== 'string' || !isAbsolute(request.packageRoot)) {
      fail('MAP_INSTALL_INPUT', 'Supply absolute extracted-package and program-root paths.')
    }
    if (request.expected === null || typeof request.expected !== 'object') fail('MAP_INSTALL_INPUT', 'Supply independently verified release identity.')
    if (request.expected.distribution !== 'managed' || request.expected.target !== detectHostTarget()) {
      fail('MAP_INSTALL_IDENTITY', 'Select a managed release built for this native operating system and CPU.')
    }
    if (pathsOverlap(request.installRoot, request.packageRoot)) fail('MAP_INSTALL_REFUSED', 'Keep the source package separate from the program root.')
    let layout = inspectManagedInstall(request.installRoot)
    assertFreshOrReady(layout)
    const pkg = readPackage(request.packageRoot, request.expected, layout.state === 'ready' ? layout.activeManifest : null)
    const bytes = await verifyFiles(pkg)
    const dataHome = resolveDataHome(request, pkg, layout)
    if (layout.state === 'ready' && pkg.status !== 'no-op') fail('MAP_INSTALL_EXISTS', 'Use manage update to switch an already installed version.')
    const available = availableBytes(request.installRoot, deps.statfs ?? statfsSync)
    const required = (layout.state === 'ready' ? 0 : bytes) + METADATA_RESERVE
    if (available < required) fail('MAP_INSTALL_SPACE', 'Free space on the installation volume before retrying.', { available, needed: required })
    mkdirSync(request.installRoot, { recursive: true, mode: 0o700 })
    reservation = join(request.installRoot, INSTALL_RESERVATION)
    let handle
    try { handle = openSync(reservation, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') fail('MAP_INSTALL_BUSY', 'Another operation or interrupted reservation owns this program root; inspect it before retrying.')
      throw error
    }
    reserved = true
    closeSync(handle)
    layout = inspectManagedInstall(request.installRoot, { operationId })
    assertFreshOrReady(layout)
    const status = validateInstallManifest(pkg.manifest, {
      expected: request.expected, payloadManifestBytes: pkg.payloadBytes, buildRecordBytes: pkg.buildRecordBytes,
      installedManifest: layout.state === 'ready' ? layout.activeManifest : null,
    }).status
    receipt = makeReceipt(request, pkg, operationId, dataHome, layout.marker?.installationId ?? randomUUID())
    receipt.files.bytes = bytes
    if (status === 'no-op') return await installedNoop(request, layout, pkg, receipt, dataHome)
    if (layout.state === 'ready') fail('MAP_INSTALL_EXISTS', 'Use manage update to switch an already installed version.')
    stage = join(request.installRoot, `${STAGING_PREFIX}${operationId}`)
    mkdirSync(stage, { mode: 0o700 })
    stageOwned = true
    const stagedPayload = await stagePackage(pkg, stage)
    const directory = versionDirectoryName(pkg.manifest)
    const marker = markerFor(request, pkg, receipt, dataHome)
    const slotMetadata = slotId => jsonBytes({ ...marker, slot: slotId })
    const metadata = [
      [INSTALLATION_MARKER, jsonBytes(marker), 0o600],
      ['A', `${pointerFor(directory)}\n`, 0o600], [slotMetadataName('A'), slotMetadata('A'), 0o600],
      ['B', `${pointerFor(directory)}\n`, 0o600], [slotMetadataName('B'), slotMetadata('B'), 0o600],
      [ACTIVE_SLOT, 'A\n', 0o600], ...launcherFiles(dataHome),
    ]
    for (const [name, bytes, mode] of metadata) durableFile(join(stage, name), bytes, mode)
    for (const name of [VERSIONS_DIRECTORY, RECEIPTS_DIRECTORY, SLOTS_DIRECTORY]) mkdirSync(join(request.installRoot, name), { mode: 0o700 })
    // A pre-commit receipt and marker make partial publication recognizable without inferring ownership from filenames.
    writeAtomic(join(request.installRoot, RECEIPTS_DIRECTORY, `${operationId}.json`), jsonBytes(receipt))
    renameSync(join(stage, INSTALLATION_MARKER), join(request.installRoot, INSTALLATION_MARKER))
    markerPublished = true
    renameSync(stagedPayload, join(request.installRoot, VERSIONS_DIRECTORY, directory))
    for (const name of ['A', slotMetadataName('A'), 'B', slotMetadataName('B')]) {
      renameSync(join(stage, name), join(request.installRoot, SLOTS_DIRECTORY, name))
    }
    for (const [name] of launcherFiles(dataHome)) renameSync(join(stage, name), join(request.installRoot, name))
    receipt.state = 'committed'
    receipt.result = 'installed'
    receipt.cleanup = 'done'
    receipt.finishedAt = new Date().toISOString()
    // Preallocate the final receipt before activation so known space failures stay pre-commit.
    const finalReceipt = join(stage, 'final-receipt.json')
    durableFile(finalReceipt, jsonBytes(receipt))
    renameSync(join(stage, ACTIVE_SLOT), join(request.installRoot, ACTIVE_SLOT))
    committed = true
    renameSync(finalReceipt, join(request.installRoot, RECEIPTS_DIRECTORY, `${operationId}.json`))
    return receipt
  } catch (error) {
    errorToThrow = ioFailure(error)
    errorToThrow.details = { ...errorToThrow.details, operationId, committed }
    if (markerPublished && receipt !== undefined) {
      receipt.state = committed ? 'outcome-unknown' : 'not-committed'
      receipt.result = 'failed'
      receipt.cleanup = 'pending'
      receipt.error = { code: errorToThrow.code }
      receipt.finishedAt = new Date().toISOString()
      try { writeAtomic(join(request.installRoot, RECEIPTS_DIRECTORY, `${operationId}.json`), jsonBytes(receipt)) } catch (receiptError) {
        errorToThrow.details.receiptError = receiptError.code ?? receiptError.name
      }
    }
    throw errorToThrow
  } finally {
    const cleanup = []
    if (stageOwned) {
      try { rmSync(stage, { recursive: true, force: true }) } catch (error) { cleanup.push({ entry: 'staging', reason: error.code }) }
    }
    if (reserved) {
      try { unlinkSync(reservation) } catch (error) { cleanup.push({ entry: 'reservation', reason: error.code }) }
    }
    if (cleanup.length > 0) {
      if (receipt) {
        receipt.cleanup = 'pending'
        receipt.error = { code: 'MAP_INSTALL_CLEANUP', entries: cleanup }
        try { writeAtomic(join(request.installRoot, RECEIPTS_DIRECTORY, `${operationId}.json`), jsonBytes(receipt)) } catch (error) {
          cleanup.push({ entry: 'receipt', reason: error.code ?? error.name })
        }
      }
      if (errorToThrow) errorToThrow.details.cleanup = cleanup
      else throw new MapInstallError('MAP_OPERATION_UNKNOWN', 'Activation and cleanup have separate outcomes; inspect the operation receipt before continuing.', { operationId, committed, cleanup })
    }
  }
}

/**
 * Verify the receipt-bound active package without starting a service or reading its home.
 * @param {string} installRoot absolute program root
 * @returns {Promise<object>} ok, metadata state, version, and named verification checks
 */
export async function verifyManagedInstallation(installRoot) {
  const layout = inspectManagedInstall(installRoot)
  const checks = [{ name: 'layout', ok: layout.state === 'ready', detail: { state: layout.state, reason: layout.reason ?? null } }]
  if (layout.state !== 'ready') return { ok: false, state: layout.state, version: null, checks }
  let payloadError
  try {
    const root = checkedInstallPath(installRoot, layout.pointers[layout.activeSlot], 'directory')
    await verifyFiles(readPackage(root, expectedFromMarker(layout.marker)), true)
  } catch (error) { payloadError = ioFailure(error) }
  checks.push({ name: 'payload', ok: payloadError === undefined,
    detail: payloadError === undefined ? [] : [{ path: payloadError.details.path ?? null, reason: payloadError.code === 'MAP_INSTALL_DIGEST' ? 'digest' : payloadError.code }] })
  const launcherMatches = launcherFiles(layout.marker.dataHome).every(([name, bytes]) => readChecked(installRoot, name).equals(Buffer.from(bytes)))
  checks.push({ name: 'launcher', ok: launcherMatches })
  return { ok: checks.every(check => check.ok), state: layout.state, version: layout.marker.version, checks }
}

/**
 * Read an operation receipt using a UUID, without following links or parsing unrelated files.
 * @param {string} installRoot real program root
 * @param {string} operationId receipt UUID
 * @returns {object|null} receipt or explicit absence
 */
export function readInstallReceipt(installRoot, operationId) {
  if (!UUID.test(operationId)) fail('MAP_INSTALL_INPUT', 'Supply a valid operation identifier.')
  const name = `${RECEIPTS_DIRECTORY}/${operationId}.json`
  if (lstatSync(join(installRoot, name), { throwIfNoEntry: false }) === undefined) return null
  return parseJson(readChecked(installRoot, name), name)
}

/**
 * Hold the kernel-owned maintenance lease while committing one program-root transaction.
 * POSIX uses the repository's native nonblocking flock; Windows uses a named kernel
 * semaphore. Closing the descriptor or semaphore handle releases the lock if this process
 * dies; no age, PID, or record decides whether an interrupted lock is stale.
 * @param {string} installRoot real program root
 * @returns {Promise<() => Promise<void>>} idempotent release callback
 * @throws {MapInstallError} MAP_INSTALL_BUSY on contention; MAP_INSTALL_IO on native/path failure
 */
export async function withMaintenanceLease(installRoot) {
  const path = join(installRoot, MAINTENANCE_LOCK)
  let fd
  let handle
  try {
    fd = openSync(path, 'a+', 0o600)
    if (process.platform === 'win32') {
      const koffi = require('koffi').default
      const kernel = koffi.load('kernel32.dll')
      const create = kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16'])
      const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint'])
      const key = `Local\\map-harness-maintenance-${sha256(Buffer.from(path.toLowerCase())).slice(0, 32)}`
      handle = create(null, 1, 1, key)
      if (handle === 0 || wait(handle, 0) !== 0) {
        const held = handle !== 0 ? handle : undefined
        handle = undefined
        if (held !== undefined) kernel.func('__stdcall', 'CloseHandle', 'int')(held)
        fail('MAP_INSTALL_BUSY', 'Another maintenance operation owns this installation; wait for it to finish.')
      }
    } else {
      const { pathToFileURL } = await import('node:url')
      const { tryLockExclusive } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/node-addon-system/flock')).href)
      await tryLockExclusive(fd)
    }
  } catch (error) {
    const busy = error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK' || error.code === 'EBUSY'
    let cleanupError
    try {
      if (handle !== undefined) {
        const koffi = require('koffi').default
        koffi.load('kernel32.dll').func('__stdcall', 'CloseHandle', 'int')(handle)
      }
      if (fd !== undefined) closeSync(fd)
    } catch (closeFailure) { cleanupError = closeFailure }
    if (error instanceof MapInstallError) throw error
    if (busy) fail('MAP_INSTALL_BUSY', 'Another maintenance operation owns this installation; wait for it to finish.')
    fail('MAP_INSTALL_IO', 'The maintenance lock is unavailable; no files were changed.',
      { path, reason: error.code ?? error.name, cleanupPending: cleanupError !== undefined }, { cause: error })
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    const errors = []
    try {
      if (handle !== undefined) {
        const koffi = require('koffi').default
        const kernel = koffi.load('kernel32.dll')
        kernel.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*'])(handle, 1, null)
        kernel.func('__stdcall', 'CloseHandle', 'int')(handle)
        handle = undefined
      }
    } catch (error) { errors.push(error) }
    try { if (fd !== undefined) { closeSync(fd); fd = undefined } } catch (error) { errors.push(error) }
    if (errors.length > 0) {
      fail('MAP_INSTALL_STATE', 'Maintenance lock cleanup failed; exclusion persists until process exit.',
        { errors: errors.map(error => error.code ?? error.name) })
    }
  }
}

function versionParts(value) {
  const [core] = value.split('+')
  const dash = core.indexOf('-')
  return { numbers: (dash === -1 ? core : core.slice(0, dash)).split('.').map(Number), suffix: dash === -1 ? '' : core.slice(dash + 1) }
}

/**
 * Compare two release versions without parsing build metadata as an ordering hint.
 * @param {string} left version
 * @param {string} right version
 * @returns {number} -1, 0, or 1
 */
export function versionOrder(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1
  if (a.suffix === b.suffix) return 0
  if (a.suffix === '') return 1
  if (b.suffix === '') return -1
  return a.suffix < b.suffix ? -1 : 1
}

function receiptFor(operation, layout) {
  return {
    format: INSTALL_RECEIPT_FORMAT, operation, operationId: randomUUID(),
    installationId: layout.marker.installationId, installRoot: layout.installRoot, dataHome: layout.marker.dataHome,
    startedAt: new Date().toISOString(), finishedAt: null,
    version: layout.marker.version, previousVersion: layout.marker.version, targetVersion: null,
    sourceDigest: layout.marker.sourceDigest, payloadSha256: layout.marker.payloadSha256,
    manifestSha256: layout.marker.manifestSha256, target: layout.marker.target, channel: layout.marker.channel,
    distribution: 'managed', files: { count: 0, bytes: 0 }, state: 'not-committed', result: 'pending',
    cleanup: 'pending', error: null, dataState: 'untouched', health: null, dryRun: false,
    steps: ['inspect', 'stage', 'verify', 'maintenance-lock', 'quiesce', 'backup-if-needed', 'commit', 'health', 'receipt'],
    preserved: null, cleanupEntries: null, uninitializedDataHome: false,
  }
}

function finish(receipt, state, result, cleanup = 'done') {
  receipt.state = state
  receipt.result = result
  receipt.cleanup = cleanup
  receipt.finishedAt = new Date().toISOString()
  return receipt
}

function writeReceipt(layout, receipt) {
  mkdirSync(join(layout.installRoot, RECEIPTS_DIRECTORY), { recursive: true, mode: 0o700 })
  writeAtomic(join(layout.installRoot, RECEIPTS_DIRECTORY, `${receipt.operationId}.json`), jsonBytes(receipt))
}

function assertReadyLayout(layout) {
  if (layout.state !== 'ready') {
    fail('MAP_INSTALL_STATE', 'Run manage doctor and repair this installation before maintenance.', { state: layout.state, reason: layout.reason ?? null })
  }
}

async function verifyVersionDirectory(layout, pointer) {
  const root = checkedInstallPath(layout.installRoot, pointer, 'directory')
  const marker = layout.marker
  await verifyFiles(readPackage(root, expectedFromMarker(marker)), true)
  return root
}

/**
 * Resolve and observe the recorded data home without creating, claiming, or mutating it.
 * An absent or unmarked root is reported as `uninitialized`; apply-time maintenance then
 * refuses with MAP_DATA_UNKNOWN because service activity cannot be excluded from a non-Map
 * directory whose contents are outside installer ownership.
 * @param {object} request installRoot and optional homedir/env/cwd
 * @param {object} layout ready layout
 * @param {object} deps injected probe and acquire seams
 * @returns {Promise<object>} data spec, state, and provenance
 */
async function dataRootState(request, layout, deps) {
  const probe = deps.probe ?? probeInstanceLock
  const spec = resolveMapInstance({
    env: { ...request.env, MAPHARNESS_HOME: layout.marker.dataHome },
    homedir: request.homedir ?? homedir(), cwd: request.cwd, mode: 'release',
    channel: layout.marker.channel, distribution: 'managed', installRoots: [layout.installRoot],
  })
  const instance = readMapInstance(spec)
  if (instance === undefined) return { spec: null, state: 'uninitialized', uninitializedDataHome: true }
  return { spec: instance, state: await probe(instance), uninitializedDataHome: false }
}

/**
 * Acquire the main-service lease on a marked data root; never claim a stopped state from a record.
 * @param {object} deps injected acquire seam
 * @param {object} data observed data-root state
 * @returns {Promise<{release: () => Promise<void>}|null>} lease to release after quiescence
 */
async function quiesceDataRoot(deps, data) {
  if (data.state === 'locked' || data.state === 'unknown' || data.state === 'uninitialized') {
    fail('MAP_INSTANCE_BUSY', 'Exit the Map service and resolve its data-home lock before maintenance.', { state: data.state })
  }
  const acquire = deps.acquire ?? (await import('./instance-lock.mjs')).acquireInstanceLock
  return acquire(data.spec, { version: '0.0.0-map-maintenance' })
}

export function compareCompatibility(installed, candidate) {
  if (JSON.stringify(installed.dataCompatibility) !== JSON.stringify(candidate.dataCompatibility)) {
    fail('MAP_DATA_INCOMPATIBLE', 'This release changes data compatibility; keep the current version and migrate data separately.',
      { installed: installed.dataCompatibility, candidate: candidate.dataCompatibility })
  }
}

/**
 * Execute a candidate's native `--application-info` entry and compare its version.
 * File digests alone do not constitute a health check; this runs the shipped executable.
 * @param {object} layout ready layout after slot switch
 * @returns {Promise<{ok: boolean, detail: object}>} health result
 */
async function defaultHealthCheck(layout) {
  const { spawn } = await import('node:child_process')
  const pointer = layout.pointers?.[layout.activeSlot] ?? layout.slots?.[layout.activeSlot]?.pointer
  if (typeof pointer !== 'string') fail('MAP_INSTALL_STATE', 'The active slot has no version pointer after the switch.', { slot: layout.activeSlot })
  const root = checkedInstallPath(layout.installRoot, pointer, 'directory')
  const payloadName = layout.activeManifest.payload.manifest
  const payload = parseJson(readChecked(root, payloadName), payloadName)
  const target = payload.targets.find(row => row?.target === layout.marker.target) ?? payload.targets[0]
  const recordName = target?.record
  if (typeof recordName !== 'string') fail('MAP_INSTALL_PAYLOAD', 'The active payload manifest has no native build record.')
  const record = parseJson(readChecked(root, recordName), recordName)
  const executable = join(root, layout.marker.target, record.executable)
  return await new Promise(resolve => {
    const child = spawn(executable, ['--application-info'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.on('error', error => resolve({ ok: false, detail: { reason: error.code ?? error.name } }))
    child.on('close', (code, signal) => {
      if (signal !== null || code !== 0) return resolve({ ok: false, detail: { reason: 'exit', code, signal } })
      try {
        const info = JSON.parse(stdout)
        resolve({ ok: info.version === layout.marker.version, detail: { version: info.version } })
      } catch { resolve({ ok: false, detail: { reason: 'output' } }) }
    })
  })
}

/**
 * Extract a trusted local release archive under strict path, type, and byte budgets.
 * Callers supply independently verified checksums before this touches archive bytes.
 * @param {object} request archive, output, allowed paths, and byte budget
 * @param {object} deps optional extract seam for tests
 * @returns {Promise<string>} extracted package root
 * @throws {MapInstallError} unsafe archive entry, link, duplicate, or unexpected file
 */
export async function extractManagedPackage(request, deps = {}) {
  const { archive, destination, expectedFiles, maxBytes, platform = process.platform } = request
  if (!isAbsolute(archive) || !isAbsolute(destination)) fail('MAP_INSTALL_INPUT', 'Supply absolute archive and extraction paths.')
  const archiveEntry = lstatSync(archive, { throwIfNoEntry: false })
  if (archiveEntry === undefined || !archiveEntry.isFile() || archiveEntry.isSymbolicLink()) fail('MAP_INSTALL_IO', 'Read the verified local release archive.', { reason: 'ENOENT' })
  const helper = await import('./web-service-qualification-platform.mjs')
  const extract = deps.extract ?? helper.extractQualificationArchive
  const inner = request.packageName ?? basename(archive).replace(/\.(?:tar\.gz|zip)$/u, '')
  const allowed = ['map-install-manifest.json', ...expectedFiles].map(path => `${inner}/${path}`)
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  await extract(archive, destination, platform, allowed)
  const root = join(destination, inner)
  const bytes = await verifyFiles(readPackage(root, request.expected))
  if (bytes > maxBytes) fail('MAP_INSTALL_SPACE', 'The extracted release exceeds the independently supplied byte budget.', { bytes, maxBytes })
  return root
}

/**
 * Prepare an independently trusted update candidate from an extracted directory or archive.
 * @param {object} request maintenance request
 * @param {object} deps injected seams
 * @returns {Promise<object>} candidate package, bytes, checksums, and temporary extraction path
 */
async function candidateFromRequest(request, deps) {
  if (request.archive !== undefined) {
    if (request.packageRoot !== undefined) fail('MAP_INSTALL_INPUT', 'Choose either --archive or --package-root.')
    const checksumsPath = request.checksums
    if (typeof checksumsPath !== 'string' || !isAbsolute(checksumsPath)) fail('MAP_INSTALL_INPUT', 'Supply absolute independent --checksums with --archive.')
    const checksums = parseJson(readFileSync(checksumsPath), checksumsPath)
    if (checksums?.format !== 'map-harness-update-checksums-1' || !/^[a-f0-9]{64}$/u.test(checksums.archiveSha256 ?? '')) {
      fail('MAP_INSTALL_SCHEMA', 'Restore the update checksums from the independently obtained release channel.')
    }
    const expected = checksums.expected
    if (expected === null || typeof expected !== 'object') fail('MAP_INSTALL_INPUT', 'Checksums need a complete expected release identity.')
    const archiveBytes = readFileSync(request.archive)
    if (sha256(archiveBytes) !== checksums.archiveSha256) fail('MAP_INSTALL_DIGEST', 'The local archive differs from its independent checksum.')
    if (!Array.isArray(checksums.files) || checksums.files.some(path => typeof path !== 'string')
      || typeof checksums.packageName !== 'string' || !checksums.packageName) {
      fail('MAP_INSTALL_SCHEMA', 'Checksums need the archive file inventory and package directory name.')
    }
    const paths = ['web-service-manifest.json', INSTALL_MANIFEST_FILE, ...checksums.files]
    const destination = join(dirname(request.archive), `.map-update-${randomUUID()}`)
    const packageRoot = await extractManagedPackage({ archive: request.archive, destination,
      expectedFiles: paths, maxBytes: Number.isSafeInteger(checksums.maxBytes) ? checksums.maxBytes : archiveBytes.length * 4,
      expected, platform: deps.platform, packageName: checksums.packageName }, deps)
    return { packageRoot, expected, destination, checksums }
  }
  if (request.packageRoot === undefined || request.expected === undefined) {
    fail('MAP_INSTALL_INPUT', 'Supply --package-root with --expected, or --archive with --checksums.')
  }
  return { packageRoot: request.packageRoot, expected: request.expected, destination: null, checksums: null }
}

/**
 * Switch the active payload under both kernel leases. The inactive slot is staged and
 * verified, its pointer and metadata are receipt-bound, active-slot is the final atomic
 * rename, and health executes the native program. Health failure reverts the slot because
 * data was never opened for writes; unknown cleanup keeps an outcome-unknown receipt.
 * @param {object} request maintenance request
 * @param {object} deps injected probe/acquire/health/statfs seams
 * @param {'update'|'rollback'} operation receipt operation name
 * @param {object} candidate verified package, manifest, bytes, and optional destination
 * @returns {Promise<object>} receipt
 */
async function switchTransaction(request, deps, operation, candidate) {
  const layout = inspectManagedInstall(request.installRoot, { operationId: candidate.operationId })
  assertReadyLayout(layout)
  const receipt = receiptFor(operation, layout)
  candidate.operationId = receipt.operationId
  receipt.targetVersion = candidate.manifest.version
  receipt.version = candidate.manifest.version
  receipt.sourceDigest = candidate.manifest.sourceDigest
  receipt.payloadSha256 = candidate.manifest.payload.sha256
  receipt.manifestSha256 = sha256(candidate.package.manifestBytes)
  const data = await dataRootState(request, layout, deps)
  receipt.dataState = data.state
  receipt.uninitializedDataHome = data.uninitializedDataHome
  if (data.state === 'locked' || data.state === 'unknown') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_INSTANCE_BUSY', 'Exit the running Map instance on this data home before maintenance.', { state: data.state })
  }
  if (data.state === 'uninitialized') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_DATA_UNKNOWN', 'The recorded data home has no Map marker; resolve service activity explicitly before committing.', { dataHome: layout.marker.dataHome })
  }
  const staging = join(request.installRoot, `${STAGING_PREFIX}${receipt.operationId}`)
  let stageOwned = false
  let releaseMaintenance
  let dataLease = null
  let switched = false
  try {
    const available = availableBytes(request.installRoot, deps.statfs ?? statfsSync)
    if (available < candidate.bytes + METADATA_RESERVE) {
      fail('MAP_INSTALL_SPACE', 'Free space on the installation volume before switching versions.', { available, needed: candidate.bytes + METADATA_RESERVE })
    }
    releaseMaintenance = await withMaintenanceLease(request.installRoot)
    dataLease = await quiesceDataRoot(deps, data)
    mkdirSync(staging, { mode: 0o700 })
    stageOwned = true
    const stagedPayload = await stagePackage(candidate.package, staging)
    const directory = versionDirectoryName(candidate.manifest)
    const finalVersion = join(request.installRoot, VERSIONS_DIRECTORY, directory)
    const inactiveSlot = layout.activeSlot === 'A' ? 'B' : 'A'
    const originalPointer = readChecked(request.installRoot, `${SLOTS_DIRECTORY}/${inactiveSlot}`)
    const originalMetadata = readChecked(request.installRoot, `${SLOTS_DIRECTORY}/${slotMetadataName(inactiveSlot)}`)
    const pointer = pointerFor(directory)
    const marker = { ...layout.marker, version: candidate.manifest.version, sourceDigest: candidate.manifest.sourceDigest,
      payloadSha256: candidate.manifest.payload.sha256, manifestSha256: sha256(candidate.package.manifestBytes),
      operationId: receipt.operationId, slot: inactiveSlot }
    durableFile(join(staging, inactiveSlot), `${pointer}\n`, 0o600)
    durableFile(join(staging, slotMetadataName(inactiveSlot)), jsonBytes(marker), 0o600)
    // A pre-commit receipt records the switch intent; the post-health receipt replaces it.
    receipt.result = 'pending-health'
    finish(receipt, 'committed', 'pending-health', 'pending')
    receipt.health = { ok: false, state: 'unchecked' }
    writeReceipt(layout, receipt)
    if (lstatSync(finalVersion, { throwIfNoEntry: false }) !== undefined) {
      await verifyFiles({ ...candidate.package, root: finalVersion }, true)
      rmSync(stagedPayload, { recursive: true, force: true })
    } else {
      renameSync(stagedPayload, finalVersion)
    }
    renameSync(join(staging, inactiveSlot), join(request.installRoot, SLOTS_DIRECTORY, inactiveSlot))
    renameSync(join(staging, slotMetadataName(inactiveSlot)), join(request.installRoot, SLOTS_DIRECTORY, slotMetadataName(inactiveSlot)))
    writeAtomic(join(request.installRoot, ACTIVE_SLOT), `${inactiveSlot}\n`, 0o600)
    switched = true
    const after = inspectManagedInstall(request.installRoot, { operationId: receipt.operationId, pendingOperationId: receipt.operationId, allowUnknown: true })
    const health = deps.health === undefined ? await defaultHealthCheck(after) : await deps.health(after)
    receipt.health = health
    if (!health.ok) {
      writeAtomic(join(request.installRoot, ACTIVE_SLOT), `${layout.activeSlot}\n`, 0o600)
      writeAtomic(join(request.installRoot, SLOTS_DIRECTORY, inactiveSlot), originalPointer, 0o600)
      writeAtomic(join(request.installRoot, SLOTS_DIRECTORY, slotMetadataName(inactiveSlot)), originalMetadata, 0o600)
      const reverted = inspectManagedInstall(request.installRoot, { operationId: receipt.operationId, allowUnknown: true })
      await verifyVersionDirectory(reverted, reverted.pointers[layout.activeSlot])
      finish(receipt, 'health-failed', 'failed', 'pending')
      writeReceipt(layout, receipt)
      return receipt
    }
    finish(receipt, 'committed', operation === 'update' ? 'updated' : 'rolled-back')
    writeReceipt(layout, receipt)
    const keep = new Set([directory, layout.activeVersion])
    const pending = []
    for (const name of readdirSync(join(request.installRoot, VERSIONS_DIRECTORY))) {
      if (keep.has(name) || name.startsWith('.')) continue
      try { rmSync(join(request.installRoot, VERSIONS_DIRECTORY, name), { recursive: true, force: true }) }
      catch (error) { pending.push({ name, reason: error.code }) }
    }
    if (pending.length > 0) {
      receipt.cleanupEntries = pending
      finish(receipt, 'cleanup-pending', receipt.result, 'pending')
      writeReceipt(layout, receipt)
    }
    return receipt
  } catch (error) {
    const wrapped = ioFailure(error)
    wrapped.details = { ...wrapped.details, operationId: receipt.operationId, switched }
    receipt.error = { code: wrapped.code, message: wrapped.message }
    finish(receipt, switched ? 'outcome-unknown' : 'not-committed', 'failed', 'pending')
    try { writeReceipt(layout, receipt) } catch { /* reported through the error details */ }
    throw wrapped
  } finally {
    if (stageOwned) {
      try { rmSync(staging, { recursive: true, force: true }) }
      catch (error) { receipt.cleanupEntries ??= [{ name: 'staging', reason: error.code }]; receipt.cleanup = 'pending' }
    }
    try { if (dataLease !== null) await dataLease.release() } catch { /* kernel fallback on process exit */ }
    try { if (releaseMaintenance !== undefined) await releaseMaintenance() } catch { /* kernel fallback on process exit */ }
    if (candidate.destination !== null) {
      try { rmSync(candidate.destination, { recursive: true, force: true }) }
      catch (error) { receipt.cleanupEntries ??= [{ name: 'extraction', reason: error.code }]; receipt.cleanup = 'pending' }
    }
  }
}

/**
 * On Windows, execute program-root changes through a verified external worker.
 * The worker copy lives outside the install tree; its own request runs with `inPlace:true`
 * to avoid recursion. `deps.worker` is injectable for tests and native integration.
 * @param {'update'|'rollback'|'uninstall'} operation requested operation
 * @param {object} request serializable operation inputs
 * @param {object} deps injected seams
 * @returns {Promise<object|null>} worker receipt, or null on POSIX/in-place execution
 */
async function delegateWindowsTransaction(operation, request, deps) {
  if ((deps.platform ?? process.platform) !== 'win32' || deps.inPlace === true) return null
  const { buildWindowsTransactionRequest, runWindowsTransactionWorker } = await import('./windows-transaction.mjs')
  const envelope = buildWindowsTransactionRequest({ operation, installRoot: request.installRoot, request })
  if (typeof deps.worker === 'function') return deps.worker(envelope)
  const result = await runWindowsTransactionWorker({ executable: deps.workerExecutable ?? process.execPath, envelope }, deps.workerDeps ?? {})
  return result.receipt
}

/**
 * Update a managed installation to an independently verified newer release.
 * The legacy data home never changes; compatibility must equal the installed manifest,
 * downgrade is refused, and a busy or unknown data-home lock blocks commit.
 * @param {object} request update inputs
 * @param {object} [deps] injected seams
 * @returns {Promise<object>} receipt
 */
export async function runManagedUpdate(request, deps = {}) {
  const delegated = await delegateWindowsTransaction('update', request, deps)
  if (delegated !== null) return delegated
  if (!isAbsolute(request?.installRoot ?? '')) fail('MAP_INSTALL_INPUT', 'Supply the absolute managed installation root.')
  const layout = inspectManagedInstall(request.installRoot)
  assertReadyLayout(layout)
  await verifyVersionDirectory(layout, layout.pointers[layout.activeSlot])
  const source = await candidateFromRequest(request, deps)
  const pkg = readPackage(source.packageRoot, source.expected, layout.activeManifest)
  if (source.expected.distribution !== 'managed' || source.expected.target !== detectHostTarget()) {
    fail('MAP_INSTALL_IDENTITY', 'Select a managed release for this native target.')
  }
  if (pathsOverlap(request.installRoot, source.packageRoot)) fail('MAP_INSTALL_REFUSED', 'Keep the update source separate from the program root.')
  const bytes = await verifyFiles(pkg)
  const receipt = receiptFor('update', layout)
  receipt.targetVersion = pkg.manifest.version
  if (pkg.status === 'no-op') return finish(receipt, 'committed', 'no-op')
  compareCompatibility(layout.activeManifest, pkg.manifest)
  if (versionOrder(pkg.manifest.version, layout.marker.version) <= 0) {
    fail('MAP_INSTALL_INPUT', 'Refusing a downgrade through update; use rollback for a registered older version.', { installed: layout.marker.version, requested: pkg.manifest.version })
  }
  for (const field of ['product', 'distribution', 'channel', 'target', 'identityRevision']) {
    if (pkg.manifest[field] !== layout.marker[field]) fail('MAP_INSTALL_IDENTITY', 'The update package does not match this installation.', { field })
  }
  const data = await dataRootState(request, layout, deps)
  receipt.dataState = data.state
  receipt.uninitializedDataHome = data.uninitializedDataHome
  if (request.dryRun === true) {
    receipt.dryRun = true
    return finish(receipt, 'not-committed', 'dry-run')
  }
  if (data.state === 'locked' || data.state === 'unknown') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_INSTANCE_BUSY', 'Exit the running Map instance on this data home before maintenance.', { state: data.state })
  }
  if (data.state === 'uninitialized') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_DATA_UNKNOWN', 'The recorded data home has no Map marker; resolve service activity explicitly before committing.', { dataHome: layout.marker.dataHome })
  }
  return switchTransaction(request, deps, 'update', { ...source, package: pkg, manifest: pkg.manifest, bytes })
}

/**
 * Rollback to another registered, receipt-bound, payload-verified version directory.
 * No new bytes are installed; only the inactive slot is reconstructed from the retained
 * version's own install manifest and the active-slot pointer is switched back.
 * @param {object} request installRoot, version, optional dryRun
 * @param {object} [deps] injected seams
 * @returns {Promise<object>} receipt
 */
export async function runManagedRollback(request, deps = {}) {
  const delegated = await delegateWindowsTransaction('rollback', request, deps)
  if (delegated !== null) return delegated
  if (!isAbsolute(request?.installRoot ?? '')) fail('MAP_INSTALL_INPUT', 'Supply the absolute managed installation root.')
  if (typeof request.version !== 'string') fail('MAP_INSTALL_INPUT', 'Supply the registered version to roll back to.')
  const layout = inspectManagedInstall(request.installRoot)
  assertReadyLayout(layout)
  await verifyVersionDirectory(layout, layout.pointers[layout.activeSlot])
  const receipt = receiptFor('rollback', layout)
  receipt.targetVersion = request.version
  if (request.version === layout.marker.version) return finish(receipt, 'committed', 'no-op')
  const directory = layout.versions.find(name => name.startsWith(`${request.version}-`))
  if (directory === undefined) fail('MAP_INSTALL_INPUT', 'This installation has no registered version for rollback.', { version: request.version, registered: layout.versions })
  const root = checkedInstallPath(request.installRoot, `${VERSIONS_DIRECTORY}/${directory}`, 'directory')
  const marker = parseJson(readChecked(request.installRoot, `${VERSIONS_DIRECTORY}/${directory}/${INSTALL_MANIFEST_FILE}`), 'rollback manifest')
  if (marker.version !== request.version || versionDirectoryName(marker) !== directory) {
    fail('MAP_INSTALL_STATE', 'The rollback version directory does not match its manifest.', { directory })
  }
  const expected = { product: marker.product, distribution: marker.distribution, channel: marker.channel,
    target: marker.target, version: marker.version, identityRevision: marker.identityRevision,
    sourceDigest: marker.sourceDigest, payloadSha256: marker.payload.sha256 }
  const pkg = readPackage(root, expected)
  const bytes = await verifyFiles(pkg, true)
  compareCompatibility(layout.activeManifest, pkg.manifest)
  if (versionOrder(marker.version, layout.marker.version) >= 0) {
    fail('MAP_INSTALL_INPUT', 'Rollback selects an older version only.', { installed: layout.marker.version, requested: marker.version })
  }
  const data = await dataRootState(request, layout, deps)
  receipt.dataState = data.state
  receipt.uninitializedDataHome = data.uninitializedDataHome
  if (request.dryRun === true) {
    receipt.dryRun = true
    return finish(receipt, 'not-committed', 'dry-run')
  }
  if (data.state === 'locked' || data.state === 'unknown') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_INSTANCE_BUSY', 'Exit the running Map instance on this data home before maintenance.', { state: data.state })
  }
  if (data.state === 'uninitialized') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_DATA_UNKNOWN', 'The recorded data home has no Map marker; resolve service activity explicitly before committing.', { dataHome: layout.marker.dataHome })
  }
  return switchTransaction({ ...request, version: marker.version }, deps, 'rollback',
    { package: pkg, manifest: pkg.manifest, bytes, destination: null })
}

/**
 * Uninstall this managed program while preserving the data home and every unknown entry.
 * The final committed receipt and the stable maintenance lock remain as an audit-only
 * tombstone; the data lease prevents a service from starting while program files are removed.
 * @param {object} request installRoot, optional dryRun
 * @param {object} [deps] injected seams
 * @returns {Promise<object>} receipt
 */
export async function runManagedUninstall(request, deps = {}) {
  const delegated = await delegateWindowsTransaction('uninstall', request, deps)
  if (delegated !== null) return delegated
  if (!isAbsolute(request?.installRoot ?? '')) fail('MAP_INSTALL_INPUT', 'Supply the absolute managed installation root.')
  const layout = inspectManagedInstall(request.installRoot, { allowUnknown: true })
  if (layout.marker === undefined) {
    fail('MAP_INSTALL_STATE', 'No managed installation is registered at this root.', { state: layout.state })
  }
  const receipt = layout.state === 'uninstalled' ? receiptFor('uninstall', { ...layout, marker: layout.anchor })
    : receiptFor('uninstall', layout)
  const rootEntries = readdirSync(request.installRoot)
  const owned = new Set(installOwnedEntries())
  const unknown = rootEntries.filter(name => !owned.has(name) && name !== INSTALL_RESERVATION && !name.startsWith(STAGING_PREFIX))
  receipt.preserved = [...unknown]
  if (layout.state === 'uninstalled') return finish(receipt, 'committed', 'already-uninstalled')
  assertReadyLayout(layout)
  const data = await dataRootState(request, layout, deps)
  receipt.dataState = data.state
  receipt.uninitializedDataHome = data.uninitializedDataHome
  if (request.dryRun === true) {
    receipt.dryRun = true
    return finish(receipt, 'not-committed', 'dry-run')
  }
  if (unknown.length > 0) {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_INSTALL_REFUSED', 'The installation root holds unknown content; review and remove it explicitly before uninstalling.', { preserved: unknown })
  }
  if (data.state === 'locked' || data.state === 'unknown') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_INSTANCE_BUSY', 'Exit the running Map instance on this data home before uninstalling.', { state: data.state })
  }
  if (data.state === 'uninitialized') {
    finish(receipt, 'not-committed', 'failed')
    writeReceipt(layout, receipt)
    fail('MAP_DATA_UNKNOWN', 'The recorded data home has no Map marker; resolve service activity explicitly before uninstalling.', { dataHome: layout.marker.dataHome })
  }
  let releaseMaintenance
  let dataLease = null
  let committed = false
  try {
    releaseMaintenance = await withMaintenanceLease(request.installRoot)
    dataLease = await quiesceDataRoot(deps, data)
    finish(receipt, 'committed', 'uninstalled', 'pending')
    writeReceipt(layout, receipt)
    for (const name of [ACTIVE_SLOT, INSTALLATION_MARKER, LAUNCHER, WINDOWS_LAUNCHER, WINDOWS_LAUNCHER_SCRIPT]) {
      try { unlinkSync(join(request.installRoot, name)) }
      catch (error) { receipt.cleanupEntries ??= []; receipt.cleanupEntries.push({ name, reason: error.code }) }
    }
    for (const name of [SLOTS_DIRECTORY, VERSIONS_DIRECTORY]) {
      try { rmSync(join(request.installRoot, name), { recursive: true, force: true }) }
      catch (error) { receipt.cleanupEntries ??= []; receipt.cleanupEntries.push({ name, reason: error.code }) }
    }
    for (const file of readdirSync(join(request.installRoot, RECEIPTS_DIRECTORY))) {
      if (file === `${receipt.operationId}.json`) continue
      try { unlinkSync(join(request.installRoot, RECEIPTS_DIRECTORY, file)) }
      catch (error) { receipt.cleanupEntries ??= []; receipt.cleanupEntries.push({ name: `receipts/${file}`, reason: error.code }) }
    }
    committed = true
    receipt.cleanup = receipt.cleanupEntries === null && unknown.length === 0 ? 'done' : 'pending'
    writeReceipt(layout, receipt)
  } catch (error) {
    const wrapped = ioFailure(error)
    wrapped.details = { ...wrapped.details, operationId: receipt.operationId, committed }
    receipt.error = { code: wrapped.code, message: wrapped.message }
    finish(receipt, committed ? 'outcome-unknown' : 'not-committed', 'failed', 'pending')
    try { writeReceipt(layout, receipt) } catch { /* reported through the error details */ }
    throw wrapped
  } finally {
    try { if (dataLease !== null) await dataLease.release() } catch { /* kernel fallback on process exit */ }
    try { if (releaseMaintenance !== undefined) await releaseMaintenance() } catch { /* kernel fallback on process exit */ }
  }
  const remaining = readdirSync(request.installRoot)
  receipt.preservedAudit = remaining
  receipt.preserved = [...unknown, ...remaining]
  receipt.cleanup = unknown.length === 0 && remaining.length <= 2 ? 'done' : 'pending'
  try { writeAtomic(join(request.installRoot, RECEIPTS_DIRECTORY, `${receipt.operationId}.json`), jsonBytes(receipt)) }
  catch (error) { receipt.cleanupEntries ??= [{ name: 'final-receipt', reason: error.code }]; receipt.cleanup = 'pending' }
  return receipt
}
