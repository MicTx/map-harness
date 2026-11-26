/** Managed program-root admission, receipt-bound text pointers, and runtime-free launchers. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { INSTALL_MANIFEST_FILE, MapInstallError } from './install-manifest.mjs'
import { MAP_IDENTITY_REVISION } from './instance-home.mjs'

/** Installation layout format, independent of Session persistence versions. */
export const MANAGED_LAYOUT_FORMAT = 'map-harness-managed-layout-1'
/** Product-owned marker at the program root. */
export const INSTALLATION_MARKER = 'map-install.json'
/** Atomic activation selector containing exactly `A\n` or `B\n`. */
export const ACTIVE_SLOT = 'active-slot'
/** Slot identifiers understood by native and shell launchers. */
export const SLOT_NAMES = ['A', 'B']
/** Directory of single-line relative version pointers. */
export const SLOTS_DIRECTORY = 'slots'
/**
 * Name the receipt-bound metadata carried beside a slot pointer.
 * @param {'A'|'B'} slot supported selector
 * @returns {string} slot metadata basename
 */
export function slotMetadataName(slot) { return `${slot}.json` }
/** Directory of immutable complete release payloads. */
export const VERSIONS_DIRECTORY = 'versions'
/** Directory of operation receipts. */
export const RECEIPTS_DIRECTORY = 'receipts'
/** Stable POSIX launcher, never installed on PATH. */
export const LAUNCHER = 'map-harness'
/** Stable Windows command entry. */
export const WINDOWS_LAUNCHER = 'map-harness.cmd'
/** PowerShell implementation of the Windows text-pointer launcher. */
export const WINDOWS_LAUNCHER_SCRIPT = 'map-harness.ps1'
/** Same-volume staging prefix; an unknown entry with this prefix is still preserved. */
export const STAGING_PREFIX = '.staging-'
/** Exclusive initial-install reservation; crash residue is never stolen by age or PID. */
export const INSTALL_RESERVATION = '.map-installing'
/** Stable-inode installation maintenance lock; kernel-held, released on owner death. */
export const MAINTENANCE_LOCK = '.map-maintenance.lock'

const channels = ['stable', 'preview']
const targets = ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const digest = /^[a-f0-9]{64}$/u
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const pointer = /^versions\/[0-9A-Za-z][0-9A-Za-z._-]*-[a-f0-9]{64}$/u
const markerFields = ['format', 'product', 'installationId', 'channel', 'target', 'distribution', 'identityRevision',
  'version', 'sourceDigest', 'payloadSha256', 'manifestSha256', 'operationId', 'dataHome', 'ownedEntries', 'createdAt']

function fail(code, message, details = {}, options) {
  throw new MapInstallError(code, message, details, options)
}

function fields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function pathError(path, error) {
  return new MapInstallError('MAP_INSTALL_IO', 'Inspect the inaccessible installation path and retry.', { path, reason: error.code }, { cause: error })
}

/**
 * Expand tilde and relative program paths without changing the user home.
 * @param {string} value raw path, with literal surrounding spaces preserved
 * @param {string} [userHome] OS user home used only for tilde expansion
 * @param {string} [cwd] relative-path base
 * @returns {string} absolute path
 * @throws {MapInstallError} blank, NUL-bearing, or multiline path; no writes occur
 */
export function expandInstallPath(value, userHome = homedir(), cwd = process.cwd()) {
  if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/u.test(value)) {
    fail('MAP_INSTALL_INPUT', 'Choose a non-blank, single-line installation path without NUL bytes.')
  }
  return resolve(cwd, value === '~' ? userHome : /^~[/\\]/u.test(value) ? join(userHome, value.slice(2)) : value)
}

function canonicalPath(path) {
  let ancestor = path
  const missing = []
  for (;;) {
    let actual
    try { actual = realpathSync.native(ancestor) } catch (error) {
      if (error.code !== 'ENOENT') throw pathError(path, error)
      let entry
      try { entry = lstatSync(ancestor, { throwIfNoEntry: false }) } catch (entryError) { throw pathError(path, entryError) }
      if (entry?.isSymbolicLink() || dirname(ancestor) === ancestor) throw pathError(path, error)
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
      continue
    }
    if (missing.length > 0 && !lstatSync(actual).isDirectory()) {
      fail('MAP_INSTALL_IO', 'A parent of the installation root is a regular file; choose another path.', { path })
    }
    return join(actual, ...missing)
  }
}

function pathKey(path) {
  return process.platform === 'win32'
    ? path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase() : path
}

function contains(parent, child) {
  const suffix = relative(pathKey(parent), pathKey(child))
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

/**
 * Compare canonical roots, including symlinked ancestors and Windows case aliases.
 * @param {string} left absolute first root
 * @param {string} right absolute second root
 * @returns {boolean} either root equals or contains the other
 */
export function pathsOverlap(left, right) {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return contains(a, b) || contains(b, a)
}

/**
 * Select the native host ABI; unsupported combinations fail instead of guessing.
 * @param {NodeJS.Platform} [platform] process platform
 * @param {string} [arch] process CPU architecture
 * @returns {string} target identifier
 */
export function detectHostTarget(platform = process.platform, arch = process.arch) {
  const target = { darwin: { arm64: 'mac-arm64', x64: 'mac-x64' }, linux: { arm64: 'linux-arm64', x64: 'linux-x64' },
    win32: { x64: 'win-x64' } }[platform]?.[arch]
  if (target === undefined) fail('MAP_INSTALL_INPUT', 'Use a native release for a supported operating system and CPU.', { platform, arch })
  return target
}

/**
 * Resolve the per-user, channel-separated default program directory.
 * @param {object} [request] optional platform, channel, homedir, and env inputs
 * @returns {string} program directory; no data-home choice or filesystem write occurs
 */
export function defaultInstallRoot(request = {}) {
  const platform = request.platform ?? process.platform
  const channel = request.channel ?? 'stable'
  const home = request.homedir ?? homedir()
  const environment = request.env ?? process.env
  if (!channels.includes(channel)) fail('MAP_INSTALL_INPUT', 'Select the stable or preview build channel.', { channel })
  const name = channel === 'preview' ? 'Map Harness Preview' : 'Map Harness'
  if (platform === 'darwin') return join(home, 'Applications', name)
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA?.trim() ? environment.LOCALAPPDATA : win32.join(home, 'AppData', 'Local')
    return win32.join(local, 'Programs', name)
  }
  if (platform === 'linux') return join(home, '.local', 'opt', channel === 'preview' ? 'map-harness-preview' : 'map-harness')
  fail('MAP_INSTALL_INPUT', 'This operating system has no managed installation default.', { platform })
}

/**
 * Resolve CLI argument → MAPHARNESS_INSTALL_ROOT → platform default, independently of home.
 * @param {object} [request] optional installRoot, env, cwd, homedir, platform, and channel
 * @returns {{installRoot: string}} canonical program-root selection, with no writes
 */
export function resolveInstallLayout(request = {}) {
  const env = request.env ?? process.env
  const explicit = request.installRoot
  const inherited = env.MAPHARNESS_INSTALL_ROOT
  const selected = explicit !== undefined ? explicit : inherited?.trim() ? inherited : defaultInstallRoot(request)
  const installRoot = canonicalPath(expandInstallPath(selected, request.homedir, request.cwd))
  return { installRoot }
}

/**
 * Name an immutable version from the already validated version and source digest.
 * @param {object} manifest validated installation manifest
 * @returns {string} directory basename
 */
export function versionDirectoryName(manifest) {
  return `${manifest.version}-${manifest.sourceDigest}`
}

/**
 * Create the portable text pointer shared by every shell.
 * @param {string} directory version directory basename
 * @returns {string} relative `versions/<directory>` pointer
 */
export function pointerFor(directory) {
  return `${VERSIONS_DIRECTORY}/${directory}`
}

/**
 * Validate every component before reading a package or installed file; links and junctions fail.
 * @param {string} root real directory root, which itself must not be a link
 * @param {string} name strict relative manifest path
 * @param {'file'|'directory'} [kind] expected final entry type
 * @returns {string} checked absolute path
 * @throws {MapInstallError} missing, linked, non-regular, or escaped component; no writes occur
 */
export function checkedInstallPath(root, name, kind = 'file') {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(name)
    || name.split('/').some(part => part === '' || part === '.' || part === '..' || part.endsWith('.')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    fail('MAP_INSTALL_SCHEMA', 'A package or installation path is invalid; restore the matching release.', { path: name })
  }
  const rootEntry = lstatSync(root, { throwIfNoEntry: false })
  if (rootEntry === undefined || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail('MAP_INSTALL_INPUT', 'Use a real package or installation directory without a symlink or junction.', { path: root })
  }
  let path = root
  const parts = name.split('/')
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    let entry
    try { entry = lstatSync(path, { throwIfNoEntry: false }) } catch (error) { throw pathError(path, error) }
    if (entry === undefined) fail('MAP_INSTALL_IO', 'A required package or installation entry is missing; restore the matching release.', { path: name, reason: 'ENOENT' })
    const directory = index < parts.length - 1 || kind === 'directory'
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
      fail('MAP_INSTALL_INPUT', 'Package and installation entries must be regular files and directories without links.', { path: name })
    }
  }
  return path
}

function readText(root, name) {
  const path = checkedInstallPath(root, name)
  try { return readFileSync(path, 'utf8') } catch (error) { throw pathError(path, error) }
}

function parseJson(text, name) {
  try { return JSON.parse(text) } catch (error) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the malformed installation metadata before continuing.', { path: name, reason: error.name })
  }
}

/**
 * Return the complete list of root-owned entries, never a recursive ownership claim elsewhere.
 * @returns {string[]} fixed program-root entries
 */
export function installOwnedEntries() {
  return [INSTALLATION_MARKER, ACTIVE_SLOT, SLOTS_DIRECTORY, VERSIONS_DIRECTORY, RECEIPTS_DIRECTORY,
    LAUNCHER, WINDOWS_LAUNCHER, WINDOWS_LAUNCHER_SCRIPT, MAINTENANCE_LOCK]
}

function markerValue(text, allowSlot = false) {
  const value = parseJson(text, INSTALLATION_MARKER)
  const expectedFields = allowSlot ? [...markerFields, 'slot'] : markerFields
  if (!fields(value, expectedFields) || (allowSlot && !SLOT_NAMES.includes(value.slot))
    || value.format !== MANAGED_LAYOUT_FORMAT || value.product !== 'map-harness'
    || !uuid.test(value.installationId) || !uuid.test(value.operationId) || !channels.includes(value.channel)
    || !targets.includes(value.target) || value.distribution !== 'managed' || value.identityRevision !== MAP_IDENTITY_REVISION
    || !version.test(value.version) || !digest.test(value.sourceDigest) || !digest.test(value.payloadSha256)
    || !digest.test(value.manifestSha256) || typeof value.dataHome !== 'string' || !isAbsolute(value.dataHome)
    || !Array.isArray(value.ownedEntries) || JSON.stringify(value.ownedEntries) !== JSON.stringify(installOwnedEntries())
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the unsupported or damaged Map installation marker.')
  }
  return value
}

/**
 * Validate one slot against its installation anchor, immutable manifest, and committed receipt.
 * Legacy initial slots use the root marker; maintenance publishes a full marker in A.json/B.json.
 * @param {string} installRoot program root
 * @param {'A'|'B'} slot selector
 * @param {object} [anchor] validated installation anchor; read from root when omitted
 * @returns {object} receipt-bound marker, manifest, pointer, and version directory
 */
export function readManagedSlot(installRoot, slot, anchor, options = {}) {
  if (!SLOT_NAMES.includes(slot)) fail('MAP_INSTALL_INPUT', 'Select slot A or B.')
  const owner = anchor ?? markerValue(readText(installRoot, INSTALLATION_MARKER))
  const text = readText(installRoot, `${SLOTS_DIRECTORY}/${slot}`)
  if (!text.endsWith('\n') || !pointer.test(text.slice(0, -1))) {
    fail('MAP_INSTALL_STATE', 'Restore the single-line version pointer.', { reason: 'slot-pointer' })
  }
  const selected = text.slice(0, -1)
  checkedInstallPath(installRoot, selected, 'directory')
  const metadata = `${SLOTS_DIRECTORY}/${slotMetadataName(slot)}`
  const marker = lstatSync(join(installRoot, metadata), { throwIfNoEntry: false }) === undefined
    ? owner : markerValue(readText(installRoot, metadata), true)
  for (const key of ['product', 'installationId', 'channel', 'target', 'distribution', 'identityRevision', 'dataHome']) {
    if (marker[key] !== owner[key]) fail('MAP_INSTALL_STATE', 'The slot belongs to another installation.', { reason: 'slot-identity', field: key })
  }
  const versionDirectory = selected.slice(VERSIONS_DIRECTORY.length + 1)
  const manifestBytes = Buffer.from(readText(installRoot, `${selected}/${INSTALL_MANIFEST_FILE}`))
  const manifest = parseJson(manifestBytes.toString('utf8'), 'slot manifest')
  if (createHash('sha256').update(manifestBytes).digest('hex') !== marker.manifestSha256
    || versionDirectory !== versionDirectoryName(marker) || manifest?.product !== marker.product
    || manifest.distribution !== marker.distribution || manifest.channel !== marker.channel
    || manifest.target !== marker.target || manifest.identityRevision !== marker.identityRevision
    || manifest.version !== marker.version || manifest.sourceDigest !== marker.sourceDigest
    || manifest.payload?.sha256 !== marker.payloadSha256) {
    fail('MAP_INSTALL_STATE', 'The slot manifest does not match its installation receipt.', { reason: 'active-manifest' })
  }
  const receipt = parseJson(readText(installRoot, `${RECEIPTS_DIRECTORY}/${marker.operationId}.json`), 'slot receipt')
  const pending = options.pendingOperationId !== undefined && receipt?.operationId === options.pendingOperationId
    && receipt.state === 'committed' && receipt.result === 'pending-health'
  if (receipt?.format !== 'map-harness-install-receipt-1' || receipt.operationId !== marker.operationId
    || receipt.installationId !== marker.installationId || receipt.manifestSha256 !== marker.manifestSha256
    || receipt.payloadSha256 !== marker.payloadSha256 || receipt.sourceDigest !== marker.sourceDigest
    || receipt.version !== marker.version || !['committed', 'cleanup-pending'].includes(receipt.state)
    || (!pending && receipt.health?.ok === false) || (!pending && receipt.result === 'pending-health')) {
    fail('MAP_INSTALL_STATE', 'The slot has no matching healthy committed receipt.', { reason: 'receipt' })
  }
  return { marker, manifest, manifestBytes, receipt, pointer: selected, versionDirectory }
}

/**
 * Inspect program state without starting a service or reading its data home.
 * `ready` denotes receipt-bound program metadata, never live service readiness. Unknown content
 * is preserved. Maintenance may ignore only its own staging name and report other unknown entries.
 * @param {string} installRoot absolute program root
 * @param {object} [options] optional operationId for owned staging, and allowUnknown for uninstall planning
 * @returns {object} state, anchor, active marker/manifest/slot, pointers, and inventory
 */
export function inspectManagedInstall(installRoot, options = {}) {
  const base = { installRoot, versions: [], receipts: [] }
  const entry = lstatSync(installRoot, { throwIfNoEntry: false })
  if (entry === undefined) return { ...base, state: 'absent' }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return { ...base, state: 'not-directory' }
  let names
  try { names = readdirSync(installRoot) } catch (error) { throw pathError(installRoot, error) }
  const ownedStaging = uuid.test(options.operationId ?? '') ? `${STAGING_PREFIX}${options.operationId}` : null
  const content = names.filter(name => name !== INSTALL_RESERVATION && name !== ownedStaging)
  if (!names.includes(INSTALLATION_MARKER)) {
    if (content.length === 0) return { ...base, state: 'empty' }
    // An audit-only uninstall tombstone keeps its final receipt and stable lock but no marker.
    const receiptNames = content.includes(RECEIPTS_DIRECTORY) ? readdirSync(join(installRoot, RECEIPTS_DIRECTORY)) : []
    for (const file of receiptNames) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(file)) continue
      let receipt
      try { receipt = JSON.parse(readText(installRoot, `${RECEIPTS_DIRECTORY}/${file}`)) } catch { continue }
      if (receipt?.format === 'map-harness-install-receipt-1' && receipt.operation === 'uninstall'
        && ['committed', 'cleanup-pending'].includes(receipt.state)) {
        return { ...base, state: 'uninstalled', receipts: receiptNames, unknown: content.filter(name => name !== RECEIPTS_DIRECTORY && name !== MAINTENANCE_LOCK) }
      }
    }
    return { ...base, state: 'foreign', unknown: content }
  }
  let anchor
  try { anchor = markerValue(readText(installRoot, INSTALLATION_MARKER)) } catch (error) {
    if (!(error instanceof MapInstallError)) throw error
    return { ...base, state: 'damaged', reason: 'marker' }
  }
  const owned = new Set(installOwnedEntries())
  const unknown = content.filter(name => !owned.has(name))
  if (unknown.length && !options.allowUnknown) return { ...base, state: 'damaged', marker: anchor, anchor, reason: 'unknown-entries', unknown }
  try {
    checkedInstallPath(installRoot, RECEIPTS_DIRECTORY, 'directory')
    base.receipts = readdirSync(join(installRoot, RECEIPTS_DIRECTORY)).sort()
    if (lstatSync(join(installRoot, ACTIVE_SLOT), { throwIfNoEntry: false }) === undefined) {
      for (const file of base.receipts) {
        if (!/^[a-f0-9-]{36}\.json$/u.test(file)) continue
        const receipt = parseJson(readText(installRoot, `${RECEIPTS_DIRECTORY}/${file}`), 'uninstall receipt')
        if (receipt.operation === 'uninstall' && receipt.installationId === anchor.installationId
          && ['committed', 'cleanup-pending'].includes(receipt.state)) {
          return { ...base, state: 'uninstalled', anchor, marker: anchor, receipt, unknown }
        }
      }
    }
    for (const name of [VERSIONS_DIRECTORY, SLOTS_DIRECTORY]) checkedInstallPath(installRoot, name, 'directory')
    base.versions = readdirSync(join(installRoot, VERSIONS_DIRECTORY)).sort()
    const active = readText(installRoot, ACTIVE_SLOT)
    if (!/^[AB]\n$/u.test(active)) return { ...base, state: 'damaged', marker: anchor, anchor, reason: 'active-slot' }
    const activeSlot = active[0]
    const slots = {}
    for (const name of SLOT_NAMES) slots[name] = readManagedSlot(installRoot, name, anchor, { pendingOperationId: options.pendingOperationId })
    const selected = slots[activeSlot]
    for (const name of [LAUNCHER, WINDOWS_LAUNCHER, WINDOWS_LAUNCHER_SCRIPT]) checkedInstallPath(installRoot, name)
    return { ...base, state: 'ready', anchor, marker: selected.marker, activeManifest: selected.manifest,
      activeSlot, activeVersion: selected.versionDirectory, receipt: selected.receipt,
      pointers: Object.fromEntries(SLOT_NAMES.map(slot => [slot, slots[slot].pointer])), slots, unknown }
  } catch (error) {
    if (!(error instanceof MapInstallError)) throw error
    return { ...base, state: error.code === 'MAP_INSTALL_IO' ? 'incomplete' : 'damaged', marker: anchor, anchor,
      reason: error.details?.reason ?? 'layout-entries', unknown }
  }
}

/**
 * Inspect the nearest existing ancestor's user-available bytes without creating the root.
 * @param {string} path absolute installation path
 * @param {typeof statfsSync} [statfs] filesystem statistics provider
 * @returns {number} available byte count
 * @throws {MapInstallError} missing or invalid volume statistics
 */
export function availableBytes(path, statfs = statfsSync) {
  let ancestor = path
  for (;;) {
    try {
      const stats = statfs(ancestor)
      const available = Number(stats.bavail) * Number(stats.bsize)
      if (!Number.isSafeInteger(available) || available < 0) fail('MAP_INSTALL_IO', 'The volume did not report usable free space.', { path: ancestor })
      return available
    } catch (error) {
      if (error instanceof MapInstallError) throw error
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw pathError(ancestor, error)
      ancestor = dirname(ancestor)
    }
  }
}

/**
 * Keep program, data, and stock DSH roots distinct after resolving aliases.
 * @param {object} request installRoot, dataHome, and optional homedir
 * @returns {void} no files change
 * @throws {MapInstallError} a selected root overlaps another protected root
 */
export function assertSeparateRoots(request) {
  const home = request.homedir ?? homedir()
  const stock = [join(home, '.dsh'), join(home, '.agents'), join(home, '.cache', 'deepseek-harness')]
  if (request.dataHome && pathsOverlap(request.installRoot, request.dataHome)) {
    fail('MAP_INSTALL_INPUT', 'Select a Map data home outside the program root; neither directory may contain the other.')
  }
  for (const root of stock) {
    if (pathsOverlap(request.installRoot, root) || (request.dataHome && pathsOverlap(request.dataHome, root))) {
      fail('MAP_INSTALL_REFUSED', 'Choose program and Map data roots separate from every stock DSH directory.', { conflictingRoot: root })
    }
  }
}

function quoteSh(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/**
 * Generate runtime-free launchers with strictly bounded text pointers and no PATH changes.
 * An explicitly configured launch-time MAPHARNESS_HOME overrides the recorded data-home default;
 * MAPHARNESS_INSTALL_ROOT communicates only the canonical program root.
 * @param {string} dataHome independently resolved default Map data home
 * @returns {{posix: string, windows: string, windowsScript: string}} stable launcher bytes
 */
export function launcherTemplates(dataHome) {
  const posix = [
    '#!/bin/sh', 'set -eu',
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'fail() { echo "map-harness: invalid managed slot pointer; run manage doctor." >&2; exit 90; }',
    '[ ! -L "$root/active-slot" ] && [ ! -L "$root/slots" ] && [ ! -L "$root/versions" ] || fail',
    '{ IFS= read -r slot && ! IFS= read -r extra; } < "$root/active-slot" || fail',
    'case "$slot" in A|B) ;; *) fail ;; esac',
    '[ ! -L "$root/slots/$slot" ] || fail',
    '{ IFS= read -r version && ! IFS= read -r extra; } < "$root/slots/$slot" || fail',
    'case "$version" in versions/*) ;; *) fail ;; esac',
    'directory=${version#versions/}',
    'case "$directory" in ""|.*|*[!A-Za-z0-9._-]*|*..*) fail ;; esac',
    'digest=${directory##*-}',
    '[ "${#digest}" = 64 ] || fail',
    'case "$digest" in *[!a-f0-9]*) fail ;; esac',
    'actual=$(CDPATH= cd -- "$root/$version" && pwd -P) || fail',
    '[ "$actual" = "$root/$version" ] && [ ! -L "$actual/start-web.sh" ] && [ -f "$actual/start-web.sh" ] || fail',
    'MAPHARNESS_INSTALL_ROOT=$root', 'export MAPHARNESS_INSTALL_ROOT',
    `if [ -z "\${MAPHARNESS_HOME:-}" ]; then MAPHARNESS_HOME=${quoteSh(dataHome)}; export MAPHARNESS_HOME; fi`,
    'exec "$actual/start-web.sh" "$@"', '',
  ].join('\n')
  const windows = [
    '@echo off', 'setlocal',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0map-harness.ps1" %*',
    'exit /b %ERRORLEVEL%', '',
  ].join('\r\n')
  const windowsScript = [
    "$ErrorActionPreference = 'Stop'", 'Set-StrictMode -Version 3.0',
    '$root = $PSScriptRoot',
    "function Assert-Regular($path) { if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'map-harness: linked managed pointer.' } }",
    "foreach ($name in @('active-slot', 'slots', 'versions')) { Assert-Regular (Join-Path $root $name) }",
    "$slot = [IO.File]::ReadAllText((Join-Path $root 'active-slot'))",
    "if ($slot -cnotmatch '\\A[AB]\\n\\z') { throw 'map-harness: active-slot must be A or B.' }",
    "$slotPath = Join-Path $root ('slots/' + $slot.Trim())", 'Assert-Regular $slotPath',
    '$pointer = [IO.File]::ReadAllText($slotPath)',
    "if ($pointer -cnotmatch '\\Aversions/[0-9A-Za-z][0-9A-Za-z._-]*-[a-f0-9]{64}\\n\\z') { throw 'map-harness: invalid version pointer.' }",
    '$payload = Join-Path $root $pointer.Trim()', 'Assert-Regular $payload',
    "$launcher = Join-Path $payload 'start-web.ps1'", 'Assert-Regular $launcher',
    '$env:MAPHARNESS_INSTALL_ROOT = $root',
    `if ([string]::IsNullOrWhiteSpace($env:MAPHARNESS_HOME)) { $env:MAPHARNESS_HOME = '${dataHome.replaceAll("'", "''")}' }`,
    '& $launcher @args', 'exit $LASTEXITCODE', '',
  ].join('\r\n')
  return { posix, windows, windowsScript }
}
