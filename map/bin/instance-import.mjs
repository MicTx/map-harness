/** Explicit, read-only legacy discovery and fingerprint-bound, never-merge Map imports. */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, realpathSync, renameSync, rmdirSync, statfsSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { MAP_IDENTITY_REVISION, MAP_INSTANCE_FORMAT, MAP_INSTANCE_MARKER, prepareMapInstance, resolveMapInstance } from './instance-home.mjs'

/** Version of plans accepted by this import implementation. */
export const IMPORT_PLAN_FORMAT = 'map-harness-import-plan-1'
/** Receipt identity, independent of the Session and domain database formats. */
export const IMPORT_RECEIPT_FORMAT = 'map-harness-import-receipt-1'
const RECEIPT = 'map-maintenance/import-receipt.json'
const DIGEST = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const CATALOG_REF = /^(res|art)-[A-Za-z0-9-]+@v[1-9][0-9]*$/u
const SCALE_REF = /^scl-([a-z0-9][a-z0-9-]{0,63})@([a-f0-9]{12})$/u
const LIMITS = { maxBytes: 10 * 1024 ** 3, maxLogBytes: 64 * 1024 ** 2, maxFiles: 100000 }
const SKIPPED = ['credentials', '.env', 'browser-auth', 'identity', 'schedules', 'goals', 'settings',
  'cache', 'logs', 'locks', 'run-records', 'agents', 'skills', 'profile-patches', 'installation-links', 'workspace-files']
// Historical durable metadata discriminators, not a second tool registry.
const META_VERSIONS = {
  'map-change': 8, 'map-observation': 3, 'map-use': 1, 'map-visual-proposal': 1,
  'map-visual-comparison': 2, 'map-visual-change': 2, 'map-agent-annotation': 1,
  'catalog-result': 1, 'analysis-result': 2, 'data-export': 1, 'map-save-receipt': 1,
  'decision-change': 1, 'accessibility-run': 1, 'spatial-stat': 1, 'spatial-decision': 1,
  'spatial-terrain': 1, 'spatial-scale': 1, 'viz-style': 1,
}

/** Import failures expose outcome and recovery metadata without Session text or database rows. */
export class MapImportError extends Error {
  /**
   * @param {string} code Stable failure discriminator.
   * @param {string} message Affected operation and corrective action.
   * @param {object} [details] Non-secret diagnostics; omitted means no additional metadata.
   * @param {ErrorOptions} [options] Original I/O cause, never a raw JSON parse error.
   */
  constructor(code, message, details = {}, options) {
    super(message, options)
    this.name = 'MapImportError'
    this.code = code
    this.details = { operation: 'import', state: 'not-committed', ...details }
  }
}

function fail(code, message, details) { throw new MapImportError(code, message, details) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }
function parseJson(bytes, path) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    fail('MAP_IMPORT_FORMAT', 'Inspect the malformed JSON object before preparing another import plan.', { path, reason: error.name })
  }
}
function key(path) { return process.platform === 'win32' ? path.toLowerCase() : path }
function overlaps(left, right) {
  const contains = (a, b) => { const rest = relative(key(a), key(b)); return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`)) }
  return contains(left, right) || contains(right, left)
}
function canonicalPath(path, cwd, userHome) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) fail('MAP_IMPORT_INPUT', 'Supply explicit non-blank source and target paths.')
  const expanded = path === '~' ? userHome : /^~[/\\]/u.test(path) ? join(userHome, path.slice(2)) : path
  let cursor = resolve(cwd, expanded)
  const missing = []
  while (!existsSync(cursor)) {
    if (lstatSync(cursor, { throwIfNoEntry: false }) !== undefined) fail('MAP_IMPORT_PATH', 'Inspect the dangling path before importing.', { path: cursor })
    missing.unshift(basename(cursor))
    const parent = dirname(cursor)
    if (parent === cursor) fail('MAP_IMPORT_PATH', 'Resolve the import path before retrying.', { path: cursor })
    cursor = parent
  }
  return join(realpathSync.native(cursor), ...missing)
}
function safeRelative(path) {
  return typeof path === 'string' && path !== '' && !path.includes('\\') && !path.includes('\0')
    && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[\u0000-\u001f\u007f:]/u.test(part) && !/[. ]$/u.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}
function checkedPath(root, path, missing = false) {
  if (!safeRelative(path)) fail('MAP_IMPORT_PATH', 'A referenced path escapes the supported portable layout.', { path })
  const rootEntry = lstatSync(root, { throwIfNoEntry: false })
  if (rootEntry === undefined || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()
    || key(realpathSync.native(root)) !== key(resolve(root))) {
    fail('MAP_IMPORT_PATH', 'The canonical import root changed; inspect it before retrying.', { root })
  }
  let absolute = root
  for (const part of path.split('/')) {
    absolute = join(absolute, part)
    const entry = lstatSync(absolute, { throwIfNoEntry: false })
    if (entry === undefined && missing) continue
    if (entry === undefined) fail('MAP_IMPORT_MISSING', 'Restore the missing referenced object, then create another plan.', { path })
    if (entry.isSymbolicLink()) fail('MAP_IMPORT_PATH', 'Materialize link-shaped source objects in the snapshot before importing.', { path })
  }
  return absolute
}
function privateDirectory(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry !== undefined) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('MAP_IMPORT_PATH', 'The import directory changed; inspect it before retrying.', { path })
    return
  }
  privateDirectory(dirname(path))
  mkdirSync(path, { mode: 0o700 })
}
function aborted(signal) {
  if (signal?.aborted) fail('MAP_IMPORT_CANCELLED', 'The import stopped before publication; retain its plan for a checked retry.')
}
function fileFacts(root, path, limit = Number.MAX_SAFE_INTEGER) {
  const absolute = checkedPath(root, path)
  const before = lstatSync(absolute)
  if (!before.isFile()) fail('MAP_IMPORT_PATH', 'A referenced object is not a regular file.', { path })
  if (before.size > limit) fail('MAP_IMPORT_BUDGET', 'Increase the explicit import budget or select a smaller closure.', { path, bytes: before.size, limit })
  const handle = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  const digest = createHash('sha256')
  let bytes = 0
  try {
    const held = fstatSync(handle)
    if (held.ino !== before.ino || held.dev !== before.dev) fail('MAP_IMPORT_SOURCE_CHANGED', 'The source changed while being inspected; create a consistent snapshot and a new plan.', { path })
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const size = readSync(handle, buffer, 0, buffer.length, null)
      if (!size) break
      bytes += size
      if (bytes > limit) fail('MAP_IMPORT_BUDGET', 'The source exceeded the explicit read budget.', { path, limit })
      digest.update(buffer.subarray(0, size))
    }
    const after = fstatSync(handle)
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('MAP_IMPORT_SOURCE_CHANGED', 'The source changed during the read; prepare a quiescent snapshot.', { path })
    }
  } finally { closeSync(handle) }
  return { path, bytes, sha256: digest.digest('hex') }
}
function smallBytes(root, path, limit) {
  const absolute = checkedPath(root, path)
  const handle = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = fstatSync(handle)
    if (!before.isFile()) fail('MAP_IMPORT_PATH', 'A referenced object is not a regular file.', { path })
    if (before.size > limit) fail('MAP_IMPORT_BUDGET', 'Increase the explicit read budget or select a smaller closure.', { path, bytes: before.size, limit })
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, null)
      if (!count) break
      offset += count
    }
    const after = fstatSync(handle)
    const current = lstatSync(absolute)
    if (offset !== before.size || after.size !== before.size || before.ino !== current.ino || before.dev !== current.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('MAP_IMPORT_SOURCE_CHANGED', 'The source changed during inspection; prepare another plan.', { path })
    }
    return { facts: { path, bytes: bytes.length, sha256: sha(bytes) }, bytes }
  } finally { closeSync(handle) }
}
function issue(scan, code, details = {}) {
  const item = { code, ...details }
  if (!scan.unresolved.some(row => canonicalJson(row) === canonicalJson(item))) scan.unresolved.push(item)
}
function recoverable(scan, details, action) {
  try { return action() } catch (error) {
    if (!(error instanceof MapImportError)) throw error
    issue(scan, error.code, { ...details, ...error.details, operation: undefined, state: undefined })
    return undefined
  }
}
function remember(scan, facts) {
  const previous = scan.inventory.get(facts.path)
  if (previous !== undefined && canonicalJson(previous) !== canonicalJson(facts)) fail('MAP_IMPORT_SOURCE_CHANGED', 'The snapshot changed within one scan.', { path: facts.path })
  scan.inventory.set(facts.path, facts)
  if (scan.inventory.size > scan.limits.maxFiles) fail('MAP_IMPORT_BUDGET', 'The import scan exceeds maxFiles; use a smaller snapshot or an explicit larger limit.')
}
function list(scan, path) {
  const absolute = checkedPath(scan.source, path, true)
  const entry = lstatSync(absolute, { throwIfNoEntry: false })
  if (entry === undefined) { remember(scan, { path, kind: 'missing' }); return [] }
  if (!entry.isDirectory()) fail('MAP_IMPORT_PATH', 'The source layout expects a real directory.', { path })
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  remember(scan, { path, kind: 'directory', entries: entries.map(item => [item.name, item.isSymbolicLink() ? 'link' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'special']) })
  return entries
}
function readObject(scan, path) {
  const { facts, bytes } = smallBytes(scan.source, path, scan.limits.maxLogBytes)
  remember(scan, facts)
  return parseJson(bytes, path)
}
function addFile(scan, path, kind, sessionId, expected) {
  let facts
  try { facts = fileFacts(scan.source, path, scan.limits.maxBytes) } catch (error) {
    if (!(error instanceof MapImportError)) throw error
    issue(scan, error.code, { path, sessionId, ...error.details, operation: undefined, state: undefined })
    return undefined
  }
  remember(scan, facts)
  if (expected !== undefined && (facts.sha256 !== expected.sha256 || facts.bytes !== expected.bytes)) {
    fail('MAP_IMPORT_DIGEST', 'A referenced object disagrees with its durable digest or byte count.', { path, sessionId })
  }
  const old = scan.files.get(path)
  if (old !== undefined && (old.kind !== kind || old.sha256 !== facts.sha256)) fail('MAP_IMPORT_CONFLICT', 'Two owners disagree about one import file.', { path })
  if (old === undefined) scan.files.set(path, { ...facts, kind, sessions: [sessionId] })
  else if (!old.sessions.includes(sessionId)) old.sessions.push(sessionId)
  return facts
}

/**
 * Domain owners are supplied by the managing process, never located by probing for a checkout.
 * Required `context.owners` fields: `storage` exposing the spatial-storage public functions
 * `createBackup`/`verifyBackup`/`restoreBackup`/`openStoreDatabase`/`verifyStore`; `scale` exposing
 * `parseScaleRef` and `SCALE_METHOD_VERSION`; `toolNames` from
 * `SPATIAL_TOOL_CATALOG.map(row => row.name)`; `compatibility` carrying the verified build
 * dataCompatibility descriptor; and `require`, a Node require rooted at the owning payload
 * where `require('sharp')` loads its image verifier. Source callers explicitly load the same
 * owners from their build anchor or source test modules. Missing injection fails MAP_IMPORT_BUILD.
 * @param {object} context execution context; see {@link runImportCommand}
 * @returns {{storage: object, scale: object, toolNames: Set<string>, compatibility: object, require: Function}} owner bundle
 */
function owners(context) {
  const injected = context?.owners
  if (!object(injected)) fail('MAP_IMPORT_BUILD', 'The managing process must inject its loaded domain owners and verified compatibility descriptor.')
  const { storage, scale, toolNames, compatibility, require } = injected
  if (!object(storage) || !object(scale) || !object(compatibility)
    || [storage.createBackup, storage.verifyBackup, storage.restoreBackup, storage.openStoreDatabase,
      storage.verifyStore, scale.parseScaleRef, require].some(member => typeof member !== 'function')
    || typeof scale.SCALE_METHOD_VERSION !== 'string' || scale.SCALE_METHOD_VERSION.length === 0
    || !Array.isArray(toolNames) || toolNames.some(name => typeof name !== 'string' || name === '')
    || !Number.isSafeInteger(compatibility.sessionFormat) || compatibility.sessionFormat < 1
    || !Number.isSafeInteger(compatibility.storageSqlite) || compatibility.storageSqlite < 1
    || compatibility.migration !== 'none'
    || !['spatialStore', 'accessibilityStore'].every(key => object(compatibility[key])
      && Number.isSafeInteger(compatibility[key].min) && compatibility[key].min > 0
      && compatibility[key].min === compatibility[key].max)) {
    fail('MAP_IMPORT_BUILD', 'Inject complete domain owners and the verified compatibility descriptor through the managing process.')
  }
  return { storage, scale, toolNames: new Set(toolNames), compatibility, require }
}
function sessionRecord(id) {
  return { id, generations: [], evidence: new Set(), relations: new Map(), attachments: new Map(),
    catalogRefs: new Set(), scaleRefs: new Set(), runs: new Map(), workspaces: new Set(), failures: [] }
}
function relation(session, id, kind) {
  if (typeof id !== 'string' || id === '' || id === session.id) return
  session.relations.set(`${kind}:${id}`, { from: session.id, to: id, kind })
}
function walk(value, visit) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object') { visit(item); continue }
    visit(item)
    for (const child of Array.isArray(item) ? item : Object.values(item)) pending.push(child)
  }
}
function inspectReferences(session, value) {
  walk(value, item => {
    if (typeof item === 'string') {
      if (CATALOG_REF.test(item)) session.catalogRefs.add(item)
      if (SCALE_REF.test(item)) session.scaleRefs.add(item)
      return
    }
    if (!object(item)) return
    if (Object.hasOwn(item, 'attachmentId')) session.attachments.set(canonicalJson(item), item)
    if (['image', 'file'].includes(item.type) && (!object(item.attachment) || !Object.hasOwn(item.attachment, 'attachmentId'))) {
      session.failures.push({ code: 'unsupported-attachment-reference' })
    }
    if (item.kind === 'accessibility-run' && typeof item.runId === 'string' && typeof item.operationRef === 'string') {
      const previous = session.runs.get(item.runId)
      if (previous !== undefined && previous !== item.operationRef) session.failures.push({ code: 'run-identity-conflict', runId: item.runId })
      session.runs.set(item.runId, item.operationRef)
    }
  })
}
function inspectEvent(session, event, toolNames) {
  const data = event.data
  if (object(data)) {
    if (event.type === 'subagent/catalog') {
      if (data.mode === 'external') session.failures.push({ code: 'external-subagent', childId: data.childId })
      else relation(session, data.childId, 'subagent')
    }
    for (const field of ['parentSession', 'parentSessionId', 'childSessionId', 'sourceSessionId', 'forkedFrom']) {
      if (typeof data[field] === 'string') relation(session, data[field], field.startsWith('parent') ? 'parent' : 'fork')
    }
  }
  const isCall = event.type === 'tool/call' && object(data) && typeof data.name === 'string'
  if (isCall && toolNames.has(data.name)) {
    session.evidence.add('map-tool-call')
    if (typeof data.arguments === 'string') {
      let args
      try { args = JSON.parse(data.arguments) } catch (error) {
        session.failures.push({ code: 'tool-arguments-invalid', reason: error.name })
      }
      if (args !== undefined) inspectReferences(session, args)
    } else if (object(data.arguments)) inspectReferences(session, data.arguments)
  }
  walk(event, item => {
    if (!object(item)) return
    if (['tool-call', 'tool-call-chunks'].includes(item.type) && toolNames.has(item.name)) session.evidence.add('map-tool-call')
    if (typeof item.kind === 'string' && (Object.hasOwn(META_VERSIONS, item.kind) || /^(?:map|spatial)-/u.test(item.kind)) && Object.hasOwn(item, 'schemaVersion')) {
      session.evidence.add('versioned-map-event')
      if (!Object.hasOwn(META_VERSIONS, item.kind) || !Number.isSafeInteger(item.schemaVersion)
        || item.schemaVersion < 1 || item.schemaVersion > META_VERSIONS[item.kind]) {
        session.failures.push({ code: 'unsupported-map-event', kind: item.kind, version: item.schemaVersion })
      }
    }
    if (item.kind === 'subagent' && typeof item.childId === 'string') relation(session, item.childId, 'subagent')
  })
  if (typeof event.type === 'string' && /^(?:map|spatial)[/-]/u.test(event.type)
    && Number.isSafeInteger(data?.schemaVersion ?? data?.version)) {
    session.evidence.add('versioned-map-event')
    session.failures.push({ code: 'unsupported-map-event', type: event.type })
  }
  inspectReferences(session, event)
}
function encodedSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let output = ''
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index]
    output += /^[A-Za-z0-9._-]$/u.test(ch) ? ch : `~${raw.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return output
}
/** Match the persistence owner's readable project key without moving released generations. */
function storedProject(cwd) {
  if (cwd === undefined) return '_no-cwd'
  let value = '', separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const ch = cwd[index]
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) value += '-'
      separatorRun = true
    } else {
      value += /^[A-Za-z0-9._-]$/u.test(ch) ? ch : `~${cwd.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(value.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}
function readGeneration(scan, path, directory) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(basename(path))
  if (match === null) return
  const version = match[1] === undefined ? 0 : Number(match[1])
  const { facts, bytes } = smallBytes(scan.source, path, scan.limits.maxLogBytes)
  remember(scan, facts)
  let text = bytes.toString('utf8')
  if (match[2] !== undefined) {
    try { text = zstdDecompressSync(bytes, { maxOutputLength: scan.limits.maxLogBytes }).toString('utf8') } catch (error) {
      issue(scan, 'compressed-session-invalid', { path, reason: error.code ?? error.name })
      return
    }
  }
  const lines = text.split('\n')
  const header = parseJson(Buffer.from(lines[0]), path)
  if (!object(header) || header.type !== 'session' || typeof header.id !== 'string' || !header.id || header.id.length > 512) {
    issue(scan, 'session-header-invalid', { path }); return
  }
  let session = scan.sessions.get(header.id)
  if (session === undefined) { session = sessionRecord(header.id); scan.sessions.set(header.id, session) }
  if (session.directory !== undefined && session.directory !== directory) session.failures.push({ code: 'duplicate-session-id' })
  session.directory = directory
  session.generations.push({ ...facts, version, compression: match[2] === undefined ? 'none' : 'zstd' })
  if (header.agentPreset === 'map-analyst') session.evidence.add('analyst-header')
  relation(session, header.parentSession, header.origin === 'subagent' ? 'parent' : 'fork')
  if (typeof header.cwd === 'string') session.workspaces.add(header.cwd)
  if (header.version !== version || !Number.isSafeInteger(version) || version > scan.owner.compatibility.sessionFormat) {
    session.failures.push({ code: 'unsupported-session-generation', path, version }); return
  }
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0
    || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0
    || header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))
    || header.parentSession !== undefined && (typeof header.parentSession !== 'string' || header.parentSession === '')
    || header.origin !== undefined && header.origin !== 'subagent') {
    session.failures.push({ code: 'session-header-invalid', path }); return
  }
  const parts = directory.split('/')
  if (parts.length !== 3 || key(parts[1]) !== key(storedProject(header.cwd)) || key(parts[2]) !== key(encodedSegment(header.id))) {
    session.failures.push({ code: 'unsupported-session-layout', path })
  }
  if (!text.endsWith('\n')) session.failures.push({ code: 'incomplete-session-generation', path })
  for (const [index, line] of lines.entries()) {
    if (index === 0 || index === lines.length - 1 && line === '') continue
    let event
    try { event = JSON.parse(line) } catch (error) {
      session.failures.push({ code: 'session-row-invalid', path, line: index + 1, reason: error.name }); continue
    }
    if (!object(event) || typeof event.type !== 'string') {
      session.failures.push({ code: 'session-row-invalid', path, line: index + 1 }); continue
    }
    inspectEvent(session, event, scan.owner.toolNames)
  }
}
function discoverSessions(scan) {
  const visit = (path, depth) => {
    for (const entry of list(scan, path)) {
      const child = `${path}/${entry.name}`
      if (entry.isDirectory() && depth < 2) visit(child, depth + 1)
      else if (/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u.test(entry.name)) recoverable(scan, { path: child }, () => readGeneration(scan, child, path))
      else if (entry.isSymbolicLink()) issue(scan, 'link-shaped-session-entry', { path: child })
      else if (/\.jsonl(?:\..+)?$/u.test(entry.name)) issue(scan, 'unsupported-session-layout', { path: child })
    }
  }
  visit('sessions', 0)
  for (const entry of list(scan, 'spatial-store/sessions')) {
    if (!SESSION_ID.test(entry.name)) continue
    let session = scan.sessions.get(entry.name)
    if (session === undefined) { session = sessionRecord(entry.name); scan.sessions.set(entry.name, session) }
    session.evidence.add('spatial-session-store')
    session.hasSpatial = true
    if (!entry.isDirectory() || entry.isSymbolicLink()) session.failures.push({ code: 'spatial-store-not-directory' })
  }
}
function inspectAttachment(scan, session, ref) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    issue(scan, 'unsupported-attachment-reference', { sessionId: session.id }); return undefined
  }
  const digest = ref.attachmentId.slice(7)
  const expected = { sha256: digest, bytes: ref.bytes }
  if (Object.hasOwn(ref, 'mediaType')) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
      || !Number.isSafeInteger(ref.width) || ref.width <= 0 || !Number.isSafeInteger(ref.height) || ref.height <= 0) {
      issue(scan, 'unsupported-attachment-metadata', { sessionId: session.id, attachmentId: ref.attachmentId }); return undefined
    }
    const path = `attachments/v1/objects/${digest.slice(0, 2)}/${digest}`
    addFile(scan, path, 'attachment', session.id, expected)
    return { path, ref }
  }
  if (typeof ref.name !== 'string' || !safeRelative(ref.name) || ref.name.includes('/')) {
    issue(scan, 'unsupported-attachment-metadata', { sessionId: session.id, attachmentId: ref.attachmentId }); return undefined
  }
  addFile(scan, `attachments/v1/file-objects/${digest.slice(0, 2)}/${digest}`, 'attachment', session.id, expected)
  addFile(scan, `attachments/v1/files/${digest.slice(0, 2)}/${digest}/${ref.name}`, 'attachment', session.id, expected)
  return undefined
}
/** Existing writer locks are probed read-only; absent locks never imply a consistent snapshot. */
async function probeSourceSessions(scan, selected) {
  if (selected.length === 0) return
  if (process.platform === 'win32') {
    const koffi = (await import('koffi')).default
    const library = koffi.load('kernel32.dll')
    try {
      const open = library.func('__stdcall', 'OpenSemaphoreW', 'intptr', ['uint', 'int', 'str16'])
      const wait = library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint'])
      const release = library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*'])
      const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
      const lastError = library.func('__stdcall', 'GetLastError', 'uint', [])
      for (const session of selected) {
        if (session.directory === undefined) continue
        const lockPath = join(scan.source, session.directory, 'session.lock')
        const name = `Local\\dsh-session-lock-${sha(resolve(lockPath).toLowerCase())}`
        const handle = open(0x00100002, 0, name)
        if (handle === 0) {
          if (lastError() !== 2) issue(scan, 'source-lock-unverified', { sessionId: session.id })
          continue
        }
        const status = wait(handle, 0)
        try {
          if (status === 0x102) issue(scan, 'active-source-session', { sessionId: session.id })
          else if (status !== 0) issue(scan, 'source-lock-unverified', { sessionId: session.id })
          else if (release(handle, 1, null) === 0) issue(scan, 'source-lock-unverified', { sessionId: session.id })
        } finally { if (close(handle) === 0) issue(scan, 'source-lock-unverified', { sessionId: session.id }) }
      }
    } finally { library.unload() }
    return
  }
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
  for (const session of selected) {
    if (session.directory === undefined) continue
    const path = `${session.directory}/session.lock`
    const absolute = checkedPath(scan.source, path, true)
    const entry = lstatSync(absolute, { throwIfNoEntry: false })
    if (entry === undefined) continue
    if (!entry.isFile() || entry.nlink !== 1) { issue(scan, 'source-lock-unverified', { sessionId: session.id }); continue }
    const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      try { await tryLockExclusive(fd) } catch (error) {
        issue(scan, ['EAGAIN', 'EWOULDBLOCK'].includes(error.code) ? 'active-source-session' : 'source-lock-unverified', { sessionId: session.id })
        continue
      }
      const held = fstatSync(fd)
      const current = lstatSync(absolute)
      if (held.ino !== entry.ino || held.dev !== entry.dev || current.ino !== entry.ino || current.dev !== entry.dev) {
        issue(scan, 'source-lock-unverified', { sessionId: session.id })
      }
    } finally { closeSync(fd) }
  }
}
function withDatabase(scan, path, sessionId, action) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${path}${suffix}`
    const entry = lstatSync(checkedPath(scan.source, sidecar, true), { throwIfNoEntry: false })
    remember(scan, { path: sidecar, kind: entry === undefined ? 'missing' : 'sqlite-sidecar', bytes: entry?.size ?? 0 })
    if (entry !== undefined) { issue(scan, 'inconsistent-sqlite-snapshot', { path: sidecar, sessionId }); return undefined }
  }
  const facts = fileFacts(scan.source, path, scan.limits.maxBytes)
  remember(scan, facts)
  const uri = pathToFileURL(checkedPath(scan.source, path))
  uri.search = '?mode=ro&immutable=1'
  let db
  try { db = new DatabaseSync(uri.href, { readOnly: true, enableExtensions: false }) } catch (error) {
    issue(scan, 'sqlite-open-failed', { path, sessionId, reason: error.code ?? error.name }); return undefined
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      issue(scan, 'sqlite-integrity-failed', { path, sessionId }); return undefined
    }
    const result = action(db, facts)
    if (fileFacts(scan.source, path, scan.limits.maxBytes).sha256 !== facts.sha256) fail('MAP_IMPORT_SOURCE_CHANGED', 'The database changed during the scan.', { path })
    return result
  } catch (error) {
    if (error instanceof MapImportError) throw error
    issue(scan, 'unsupported-database-layout', { path, sessionId, reason: error.code ?? error.name })
    return undefined
  } finally { db.close() }
}
function collectSpatial(scan, session) {
  if (!session.hasSpatial) {
    if (session.catalogRefs.size || session.scaleRefs.size) issue(scan, 'missing-spatial-store', { sessionId: session.id })
    return
  }
  const root = `spatial-store/sessions/${session.id}`
  withDatabase(scan, `${root}/store.db`, session.id, (db, facts) => {
    const version = db.prepare('PRAGMA user_version').get().user_version
    const range = scan.owner.compatibility.spatialStore
    if (version < range.min || version > range.max) { issue(scan, 'unsupported-spatial-schema', { sessionId: session.id, version }); return }
    const descriptor = { sessionId: session.id, root, database: facts, version, files: [] }
    addFile(scan, `${root}/store.db`, 'spatial-database', session.id)
    const ids = { resource: new Set(), artifact: new Set() }
    for (const [table, column, kind] of [['catalog_resources', 'resource_id', 'resource'], ['artifacts', 'artifact_id', 'artifact']]) {
      for (const row of db.prepare(`SELECT ${column} AS id, relative_path AS path, sha256, bytes FROM ${table} ORDER BY ${column}`).all()) {
        if (!safeRelative(row.path) || !row.path.startsWith('files/') || !DIGEST.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
          issue(scan, 'unsupported-resource-row', { sessionId: session.id, kind }); continue
        }
        ids[kind].add(row.id)
        const path = `${root}/${row.path}`
        const copied = recoverable(scan, { sessionId: session.id }, () => addFile(scan, path, `spatial-${kind}`, session.id, row))
        if (copied !== undefined) descriptor.files.push(path)
      }
    }
    for (const table of ['session_refs', 'intents', 'streams', 'map_refs', 'report_refs', 'export_refs', 'job_refs']) {
      for (const row of db.prepare(`SELECT DISTINCT session_id FROM ${table}`).all()) {
        if (row.session_id !== session.id) issue(scan, 'mixed-spatial-ownership', { sessionId: session.id, table })
      }
    }
    for (const row of db.prepare('SELECT parent_session_id FROM session_refs WHERE parent_session_id IS NOT NULL').all()) relation(session, row.parent_session_id, 'fork')
    for (const table of ['map_refs', 'report_refs', 'export_refs', 'job_refs']) {
      for (const row of db.prepare(`SELECT target_kind, target_id FROM ${table}`).all()) {
        if (!Object.hasOwn(ids, row.target_kind) || !ids[row.target_kind].has(row.target_id)) issue(scan, 'missing-resource-reference', { sessionId: session.id, table })
      }
    }
    for (const row of db.prepare('SELECT input_refs FROM artifacts').all()) inspectReferences(session, parseJson(Buffer.from(row.input_refs), `${root}/store.db`))
    for (const [table, predicate] of [['staging', "state = 'active'"], ['intents', "state NOT IN ('published', 'failed', 'cancelled')"], ['job_refs', "state IN ('running', 'queued', 'active')"], ['streams', "state IN ('running', 'queued', 'active')"]]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get() !== undefined) issue(scan, 'active-spatial-state', { sessionId: session.id, table })
    }
    for (const ref of session.scaleRefs) recoverable(scan, { sessionId: session.id }, () => collectScale(scan, session, root, ref))
    for (const ref of session.catalogRefs) {
      const kind = ref.startsWith('res-') ? 'resource' : 'artifact'
      if (!ids[kind].has(ref.replace('@v', '-v'))) issue(scan, 'missing-resource-reference', { sessionId: session.id, ref })
    }
    scan.spatial.push(descriptor)
  })
}
function collectScale(scan, session, root, ref) {
  const parsed = scan.owner.scale.parseScaleRef(ref)
  if (parsed === null) { issue(scan, 'unsupported-scale-reference', { sessionId: session.id }); return }
  const path = `${root}/scale/versions/${parsed.resourceId}/${parsed.digestPrefix}`
  const manifest = readObject(scan, `${path}/manifest.json`)
  if (!object(manifest) || manifest.methodVersion !== scan.owner.scale.SCALE_METHOD_VERSION || manifest.resourceId !== parsed.resourceId
    || typeof manifest.contentDigest !== 'string' || !DIGEST.test(manifest.contentDigest) || !manifest.contentDigest.startsWith(parsed.digestPrefix)
    || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 || !CATALOG_REF.test(manifest.sourceRef)) {
    issue(scan, 'unsupported-scale-manifest', { sessionId: session.id, ref }); return
  }
  session.catalogRefs.add(manifest.sourceRef)
  addFile(scan, `${path}/manifest.json`, 'scale-manifest', session.id)
  const content = createHash('sha256')
  let totalBytes = 0
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (!object(chunk) || chunk.index !== index || !DIGEST.test(chunk.digest) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0) {
      issue(scan, 'unsupported-scale-chunk', { sessionId: session.id, ref }); continue
    }
    const chunkPath = `${path}/chunks/${index}.ndjson`
    addFile(scan, chunkPath, 'scale-chunk', session.id, { sha256: chunk.digest, bytes: chunk.bytes })
    const bytes = smallBytes(scan.source, chunkPath, scan.limits.maxLogBytes).bytes
    content.update(bytes)
    totalBytes += bytes.length
  }
  if (content.digest('hex') !== manifest.contentDigest || totalBytes !== manifest.totalBytes) issue(scan, 'scale-content-mismatch', { sessionId: session.id, ref })
}
function collectAccessibility(scan, selected) {
  const wanted = new Map()
  for (const session of selected) for (const [runId, operationRef] of session.runs) {
    if (wanted.has(runId) && wanted.get(runId).session.id !== session.id) issue(scan, 'mixed-accessibility-ownership', { runId })
    wanted.set(runId, { session, operationRef })
  }
  if (wanted.size === 0) return
  const path = 'accessibility-store/accessibility-runs.db'
  recoverable(scan, {}, () => withDatabase(scan, path, undefined, (db, facts) => {
    const version = db.prepare('PRAGMA user_version').get().user_version
    const range = scan.owner.compatibility.accessibilityStore
    if (version !== 1 || version < range.min || version > range.max) { issue(scan, 'unsupported-accessibility-schema', { version }); return }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort()
    if (canonicalJson(tables) !== canonicalJson(['accessibility_meta', 'accessibility_runs'])) { issue(scan, 'unsupported-accessibility-layout'); return }
    const rows = db.prepare('SELECT run_id, operation_ref, status, spec_json, result_json FROM accessibility_runs ORDER BY run_id').all()
    let complete = true
    const found = new Set()
    for (const row of rows) {
      const owner = wanted.get(row.run_id)
      if (owner === undefined || owner.operationRef !== row.operation_ref) { issue(scan, 'mixed-accessibility-ownership'); complete = false; continue }
      found.add(row.run_id)
      if (!['partial', 'succeeded', 'failed', 'cancelled', 'outcomeUnknown'].includes(row.status)) { issue(scan, 'active-accessibility-run', { runId: row.run_id }); complete = false }
      inspectReferences(owner.session, parseJson(Buffer.from(row.spec_json), path))
      if (row.result_json !== null) inspectReferences(owner.session, parseJson(Buffer.from(row.result_json), path))
    }
    for (const runId of wanted.keys()) if (!found.has(runId)) { issue(scan, 'missing-accessibility-run', { runId }); complete = false }
    if (!complete) return
    for (const owner of wanted.values()) addFile(scan, path, 'accessibility-database', owner.session.id)
    scan.accessibility = { path, version, runIds: [...wanted.keys()].sort(), database: facts }
  }))
}
function closure(scan, selectedIds) {
  const relations = []
  for (const session of scan.sessions.values()) for (const edge of session.relations.values()) relations.push(edge)
  const required = new Set(selectedIds)
  for (;;) {
    const previous = required.size
    for (const edge of relations) if (required.has(edge.from) || required.has(edge.to)) { required.add(edge.from); required.add(edge.to) }
    if (previous === required.size) break
  }
  for (const id of required) {
    if (!scan.sessions.has(id) || scan.sessions.get(id).generations.length === 0) issue(scan, 'missing-session-reference', { sessionId: id })
    else if (!selectedIds.includes(id)) issue(scan, 'related-session-needs-selection', { sessionId: id })
  }
  return relations.filter(edge => required.has(edge.from) || required.has(edge.to)).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'))
}
function profileFor(compression) {
  const manifest = { name: 'map-harness-profile-map-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@map-harness/map-web'] } } }
  const patch = compression === 'none'
    ? '- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath(\'sessions\')\n    compression: none\n'
    : '[]\n'
  return [{ path: 'profiles/map-web/package.json', content: jsonBytes(manifest).toString('utf8') },
    { path: 'profiles/map-web/cordis.patch.yml', content: patch }]
}
function targetConflicts(target, operationId, digest) {
  const entry = lstatSync(target, { throwIfNoEntry: false })
  if (entry === undefined) return []
  if (!entry.isDirectory() || entry.isSymbolicLink()) return [{ code: 'target-not-directory' }]
  if (readdirSync(target).length === 0) return []
  let receipt
  try { receipt = parseJson(smallBytes(target, RECEIPT, 16 * 1024 ** 2).bytes, RECEIPT) } catch (error) {
    if (!(error instanceof MapImportError)) throw error
    return [{ code: 'target-not-empty' }]
  }
  return receipt.format === IMPORT_RECEIPT_FORMAT && receipt.operationId === operationId && receipt.state === 'publishing'
    && (digest === undefined || receipt.planDigest === digest) ? [] : [{ code: 'target-not-empty' }]
}
function core(plan) {
  const { digest: _digest, status: _status, conflicts: _conflicts, ...rest } = plan
  return rest
}
function normalizedOptions(options) {
  const limits = { ...LIMITS, ...options.limits }
  if (options.maxBytes !== undefined) limits.maxBytes = options.maxBytes
  if (Object.keys(limits).some(name => !Object.hasOwn(LIMITS, name) || !Number.isSafeInteger(limits[name]) || limits[name] < 1)) {
    fail('MAP_IMPORT_INPUT', 'Import budgets must be positive safe integers.')
  }
  const sessions = options.sessions ?? []
  if (!Array.isArray(sessions) || sessions.some(id => typeof id !== 'string' || !id || id.length > 512 || id.includes('\0')) || new Set(sessions).size !== sessions.length) {
    fail('MAP_IMPORT_INPUT', 'Select distinct, non-blank session ids.')
  }
  const snapshot = options.snapshot ?? 'unconfirmed'
  if (!['readonly', 'backup', 'unconfirmed'].includes(snapshot)) fail('MAP_IMPORT_INPUT', 'Name the source as readonly or backup only after preparing that snapshot.')
  const operationId = options.operationId ?? randomUUID()
  if (!UUID.test(operationId)) fail('MAP_IMPORT_INPUT', 'The import operation id is malformed.')
  const createdAt = options.createdAt ?? new Date().toISOString()
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) fail('MAP_IMPORT_INPUT', 'The import plan timestamp is malformed.')
  return { limits, sessions: [...sessions].sort(), snapshot, operationId, createdAt }
}

/**
 * Inspect only the explicitly named legacy root. No directories, caches, locks, or databases
 * are created. Session bodies and SQL rows never enter the returned plan. Related Sessions
 * remain unresolved until explicitly selected; unknown or mixed ownership stops publication.
 * @param {object} options Explicit from/to paths; sessions defaults to no selection. snapshot
 *   defaults to unconfirmed (discovery only). Limits and build identity may be supplied explicitly.
 * @returns {Promise<object>} JSON plan with candidates, required references, immutable file hashes,
 *   byte budget, conflicts, and unresolved diagnostics. Only status ready is applyable.
 * @throws {MapImportError} Invalid inputs, inaccessible paths, or changing source; no writes occur.
 */
export async function planLegacyImport(options) {
  if (!object(options)) fail('MAP_IMPORT_INPUT', 'Supply explicit import source and target paths.')
  const normalized = normalizedOptions(options)
  const cwd = options.cwd ?? process.cwd()
  const userHome = options.homedir ?? homedir()
  // --to never defaults to the user's current Map home.
  if (typeof options.to !== 'string' || !options.to.trim()) fail('MAP_IMPORT_INPUT', 'Supply an explicit empty target using --to.')
  const source = canonicalPath(options.from, cwd, userHome)
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) fail('MAP_IMPORT_PATH', 'The explicit source must be an existing snapshot directory.', { source })
  const target = resolveMapInstance({ env: { ...(options.env ?? process.env), MAPHARNESS_HOME: options.to }, cwd, homedir: userHome,
    migrationSource: source, mode: options.mode ?? 'release', channel: options.channel ?? 'stable',
    distribution: options.distribution ?? 'portable', checkoutRoot: options.checkoutRoot, installRoots: options.installRoots })
  const owner = owners(options)
  const scan = { source, owner, limits: normalized.limits, inventory: new Map(), files: new Map(), sessions: new Map(),
    unresolved: [], spatial: [], accessibility: null }
  aborted(options.signal)
  discoverSessions(scan)
  const selected = normalized.sessions.map(id => scan.sessions.get(id)).filter(Boolean)
  for (const id of normalized.sessions) if (!scan.sessions.has(id)) issue(scan, 'missing-selected-session', { sessionId: id })
  await probeSourceSessions(scan, selected)
  collectAccessibility(scan, selected)
  const images = []
  const encodings = new Set()
  for (const session of selected) {
    for (const generation of session.generations) {
      encodings.add(generation.compression)
      addFile(scan, generation.path, 'session-generation', session.id, generation)
    }
    recoverable(scan, { sessionId: session.id }, () => collectSpatial(scan, session))
    for (const ref of session.attachments.values()) {
      const image = recoverable(scan, { sessionId: session.id }, () => inspectAttachment(scan, session, ref))
      if (image !== undefined) images.push({ ...image, sessionId: session.id })
    }
  }
  for (const session of selected) for (const failure of session.failures) issue(scan, failure.code, { sessionId: session.id, ...failure })
  for (const image of images) {
    let metadata
    try { metadata = await owner.require('sharp')(smallBytes(source, image.path, scan.limits.maxLogBytes).bytes).metadata() } catch (error) {
      issue(scan, 'attachment-image-invalid', { sessionId: image.sessionId, path: image.path, reason: error.code ?? error.name }); continue
    }
    const mediaType = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[metadata.format]
    const transposed = metadata.orientation >= 5 && metadata.orientation <= 8
    if (mediaType !== image.ref.mediaType || (transposed ? metadata.height : metadata.width) !== image.ref.width
      || (transposed ? metadata.width : metadata.height) !== image.ref.height) issue(scan, 'attachment-metadata-mismatch', { sessionId: image.sessionId, path: image.path })
  }
  const dependencies = closure(scan, normalized.sessions)
  if (encodings.size > 1) issue(scan, 'mixed-session-encodings')
  if (normalized.sessions.length && normalized.snapshot === 'unconfirmed') issue(scan, 'source-snapshot-unconfirmed')
  const files = [...scan.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(item => ({ ...item, sessions: item.sessions.sort() }))
  const portablePaths = new Set()
  for (const file of files) {
    if (portablePaths.has(file.path.toLowerCase())) issue(scan, 'case-colliding-path', { path: file.path })
    portablePaths.add(file.path.toLowerCase())
  }
  const copyBytes = files.reduce((total, entry) => total + entry.bytes, 0)
  if (!Number.isSafeInteger(copyBytes) || copyBytes > normalized.limits.maxBytes) issue(scan, 'byte-budget-exceeded', { bytes: copyBytes, limit: normalized.limits.maxBytes })
  const inventory = [...scan.inventory.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const plan = {
    format: IMPORT_PLAN_FORMAT, dryRun: true, operationId: normalized.operationId, createdAt: normalized.createdAt,
    source: { root: source, snapshot: normalized.snapshot, fingerprint: sha(canonicalJson(inventory)) },
    target: { root: target.home, mode: target.mode, channel: target.channel, distribution: target.distribution, checkoutKey: target.checkoutKey },
    selection: normalized.sessions, compatibility: owner.compatibility, limits: normalized.limits,
    candidates: [...scan.sessions.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(session => ({ id: session.id,
      classification: session.evidence.size ? 'map-candidate' : 'needs-selection', evidence: [...session.evidence].sort(),
      selected: normalized.sessions.includes(session.id), generations: session.generations.map(generation => ({ path: generation.path, version: generation.version })) })),
    dependencies, files, spatialStores: scan.spatial, accessibilityStore: scan.accessibility,
    profile: { action: 'rebuild', compression: [...encodings][0] ?? 'zstd', files: profileFor([...encodings][0] ?? 'zstd') },
    workspaceRegistration: { action: 'owner-header-bootstrap', paths: [...new Set(selected.flatMap(session => [...session.workspaces]))].sort() },
    byteBudget: { copyBytes, stagingUpperBoundBytes: copyBytes * 4 + 1024 ** 2, maxBytes: normalized.limits.maxBytes },
    excluded: [...SKIPPED], unresolved: scan.unresolved.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))),
    conflicts: targetConflicts(target.home, normalized.operationId),
  }
  plan.digest = sha(canonicalJson(core(plan)))
  plan.status = plan.conflicts.length || plan.unresolved.length ? 'blocked' : plan.selection.length ? 'ready' : 'needs-selection'
  aborted(options.signal)
  return plan
}

function writeNew(path, bytes) {
  privateDirectory(dirname(path))
  const handle = openSync(path, 'wx', 0o600)
  try { writeFileSync(handle, bytes); fsyncSync(handle) } finally { closeSync(handle) }
}
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeNew(temporary, jsonBytes(value))
  try { renameSync(temporary, path) } catch (error) {
    try { unlinkSync(temporary) } catch (cleanupError) { throw new MapImportError('MAP_OPERATION_UNKNOWN', 'Inspect the retained receipt temporary file.', { path: temporary, cleanupPending: true }, { cause: cleanupError }) }
    throw error
  }
}
function copyExact(source, destination, file, signal) {
  aborted(signal)
  privateDirectory(destination)
  const target = checkedPath(destination, file.path, true)
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    const existing = fileFacts(destination, file.path)
    if (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes) fail('MAP_IMPORT_CONFLICT', 'A retained staging entry changed; inspect it before retrying.', { path: file.path })
    return
  }
  privateDirectory(dirname(target))
  const origin = checkedPath(source, file.path)
  const input = openSync(origin, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const temporary = `${target}.${randomUUID()}.part`
  let output
  let digest
  let copied = 0
  try {
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      aborted(signal)
      const size = readSync(input, buffer, 0, buffer.length, null)
      if (!size) break
      copied += size
      if (copied > file.bytes) fail('MAP_IMPORT_SOURCE_CHANGED', 'A source file grew after planning; generate a new plan.', { path: file.path })
      digest.update(buffer.subarray(0, size))
      let offset = 0
      while (offset < size) offset += writeSync(output, buffer, offset, size - offset)
    }
    fsyncSync(output)
    if (copied !== file.bytes || digest.digest('hex') !== file.sha256) fail('MAP_IMPORT_SOURCE_CHANGED', 'The snapshot changed after planning; create another plan.', { path: file.path })
  } catch (error) {
    if (output !== undefined) { closeSync(output); output = undefined }
    if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) {
      try { unlinkSync(temporary) } catch (cleanupError) { throw new MapImportError('MAP_IMPORT_IO', 'Inspect the retained copy temporary file.', { path: temporary, cleanupPending: true }, { cause: cleanupError }) }
    }
    throw error
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
  }
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) fail('MAP_IMPORT_CONFLICT', 'The staging destination changed while copying.', { path: file.path })
  renameSync(temporary, target)
}
function treeFiles(root, path = '') {
  const entry = lstatSync(root)
  if (!entry.isDirectory() || entry.isSymbolicLink() || key(realpathSync.native(root)) !== key(resolve(root))) {
    fail('MAP_IMPORT_PATH', 'The operation root is no longer the admitted directory.', { root })
  }
  const results = []
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) fail('MAP_IMPORT_CONFLICT', 'The retained operation contains a link or special object.', { path: child })
    if (entry.isDirectory()) results.push(...treeFiles(root, child))
    else results.push(fileFacts(root, child))
  }
  return results.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
function verifyReceipt(root, receipt, plan) {
  if (!object(receipt) || receipt.format !== IMPORT_RECEIPT_FORMAT || receipt.operationId !== plan.operationId
    || receipt.planDigest !== plan.digest || receipt.sourceFingerprint !== plan.source.fingerprint
    || receipt.state !== 'publishing' || !Array.isArray(receipt.files)) fail('MAP_IMPORT_CONFLICT', 'The target belongs to another or completed operation.')
  const actual = treeFiles(root).filter(file => file.path !== RECEIPT)
  if (canonicalJson(actual) !== canonicalJson(receipt.files)) fail('MAP_IMPORT_CONFLICT', 'The unfinished target differs from its verified publication inventory.')
  const allowed = new Set([MAP_INSTANCE_MARKER, ...plan.files.map(file => file.path), ...plan.profile.files.map(file => file.path)])
  if (actual.length !== allowed.size || actual.some(file => !allowed.has(file.path))) fail('MAP_IMPORT_CONFLICT', 'The unfinished target contains an unplanned or missing object.')
  const indexed = new Map(actual.map(file => [file.path, file]))
  for (const file of plan.files.filter(file => file.kind !== 'spatial-database')) {
    const found = indexed.get(file.path)
    if (found?.sha256 !== file.sha256 || found.bytes !== file.bytes) fail('MAP_IMPORT_CONFLICT', 'An unfinished target file differs from the reviewed source.', { path: file.path })
  }
  for (const profile of plan.profile.files) {
    if (indexed.get(profile.path)?.sha256 !== sha(profile.content)) fail('MAP_IMPORT_CONFLICT', 'The unfinished target profile differs from the approved reconstruction.', { path: profile.path })
  }
  const marker = parseJson(smallBytes(root, MAP_INSTANCE_MARKER, 4096).bytes, MAP_INSTANCE_MARKER)
  if (!object(marker) || marker.format !== MAP_INSTANCE_FORMAT || marker.identityRevision !== MAP_IDENTITY_REVISION
    || marker.productId !== 'map-harness' || marker.instanceId !== receipt.instanceId || !UUID.test(marker.instanceId)
    || marker.mode !== plan.target.mode || marker.channel !== plan.target.channel || marker.checkoutKey !== plan.target.checkoutKey) {
    fail('MAP_IMPORT_CONFLICT', 'The unfinished target marker differs from the selected instance identity.')
  }
}
async function restoreSpatial(plan, stage, owner, signal) {
  const reports = []
  for (const store of plan.spatialStores) {
    aborted(signal)
    const inputRoot = join(stage, 'input')
    for (const file of plan.files.filter(file => file.path === store.database.path || store.files.includes(file.path))) copyExact(plan.source.root, inputRoot, file, signal)
    const privateRoot = join(inputRoot, store.root)
    const statePath = `spatial-${sha(store.sessionId).slice(0, 24)}.json`
    let backup
    if (existsSync(join(stage, statePath))) {
      const state = parseJson(smallBytes(stage, statePath, 4096).bytes, statePath)
      if (!object(state) || state.planDigest !== plan.digest || state.sourceSha256 !== store.database.sha256
        || !safeRelative(state.bundle) || !state.bundle.startsWith(`input/${store.root}/backups/`)
        || !DIGEST.test(state.manifestSha256)) fail('MAP_IMPORT_CONFLICT', 'The retained spatial backup identity changed.', { sessionId: store.sessionId })
      const manifest = smallBytes(stage, `${state.bundle}/manifest.json`, plan.limits.maxLogBytes)
      if (manifest.facts.sha256 !== state.manifestSha256) fail('MAP_IMPORT_CONFLICT', 'The retained spatial backup manifest changed.', { sessionId: store.sessionId })
      backup = { bundlePath: join(stage, state.bundle) }
    } else {
      const db = owner.storage.openStoreDatabase(join(privateRoot, 'store.db'), { readOnly: true })
      try { backup = owner.storage.createBackup(privateRoot, db) } finally { db.close() }
      const bundle = relative(stage, backup.bundlePath).split(sep).join('/')
      const manifestSha256 = fileFacts(stage, `${bundle}/manifest.json`).sha256
      writeNew(join(stage, statePath), jsonBytes({ planDigest: plan.digest, sourceSha256: store.database.sha256, bundle, manifestSha256 }))
    }
    const bundledInventory = treeFiles(backup.bundlePath)
    const bundledManifest = parseJson(smallBytes(backup.bundlePath, 'manifest.json', plan.limits.maxLogBytes).bytes, 'manifest.json')
    if (!object(bundledManifest) || !Array.isArray(bundledManifest.entries)
      || bundledManifest.entries.some(entry => !object(entry) || !safeRelative(entry.path) || !entry.path.startsWith('data/')
        || entry.kind !== 'store-db' && (!safeRelative(entry.sourcePath) || !entry.sourcePath.startsWith('files/')))
      || bundledInventory.some(entry => entry.path !== 'manifest.json' && !bundledManifest.entries.some(file => file.path === entry.path))) {
      fail('MAP_IMPORT_CONFLICT', 'The retained spatial backup contains unplanned paths.', { sessionId: store.sessionId })
    }
    const verification = owner.storage.verifyBackup(backup.bundlePath)
    if (verification.entries.some(entry => entry.status !== 'ok')) fail('MAP_IMPORT_DIGEST', 'The staged spatial backup failed verification.', { sessionId: store.sessionId })
    checkedPath(join(stage, 'home'), store.root, true)
    for (const entry of bundledManifest.entries) {
      checkedPath(join(stage, 'home'), `${store.root}/${entry.kind === 'store-db' ? 'store.db' : entry.sourcePath}`, true)
    }
    const report = owner.storage.restoreBackup(backup.bundlePath, join(stage, 'home', store.root))
    if (report.database.status === 'conflict-kept-existing' || report.files.some(file => file.status === 'conflict-kept-existing')
      || report.database.storeSchemaVersion !== store.version) fail('MAP_IMPORT_CONFLICT', 'The staged spatial restore conflicts with this operation.', { sessionId: store.sessionId })
    const restored = owner.storage.verifyStore(join(stage, 'home', store.root))
    if (restored.store !== 'ok' || restored.summary.unavailable !== 0) fail('MAP_IMPORT_INCOMPLETE', 'The restored spatial closure failed its owner verification.', { sessionId: store.sessionId })
    reports.push({ sessionId: store.sessionId, database: report.database.status, resources: report.files.length, integrity: 'ok' })
  }
  return reports
}
async function buildStage(plan, stage, context) {
  const home = join(stage, 'home')
  const owner = owners(context)
  const spec = resolveMapInstance({ env: { ...(context.env ?? process.env), MAPHARNESS_HOME: home }, homedir: context.homedir,
    mode: plan.target.mode, channel: plan.target.channel, distribution: plan.target.distribution,
    checkoutRoot: context.checkoutRoot, migrationSource: plan.source.root, installRoots: context.installRoots })
  const marker = prepareMapInstance(spec)
  for (const file of plan.files.filter(file => !file.kind.startsWith('spatial-'))) {
    copyExact(plan.source.root, home, file, context.signal)
    await context.onProgress?.({ phase: 'copy', path: file.path, bytes: file.bytes })
  }
  const stores = await restoreSpatial(plan, stage, owner, context.signal)
  for (const file of plan.profile.files) {
    const bytes = Buffer.from(file.content)
    const existing = lstatSync(join(home, file.path), { throwIfNoEntry: false })
    if (existing === undefined) writeNew(join(home, file.path), bytes)
    else if (!smallBytes(home, file.path, bytes.length).bytes.equals(bytes)) fail('MAP_IMPORT_CONFLICT', 'The staged profile changed; retain it for inspection.', { path: file.path })
  }
  const allowed = new Set([MAP_INSTANCE_MARKER, ...plan.files.map(file => file.path), ...plan.profile.files.map(file => file.path)])
  const output = treeFiles(home).filter(file => file.path !== RECEIPT)
  if (output.some(file => !allowed.has(file.path)) || allowed.size !== output.length) fail('MAP_IMPORT_CONFLICT', 'The staged instance contains missing or unplanned files.')
  const receipt = { format: IMPORT_RECEIPT_FORMAT, operationId: plan.operationId, planDigest: plan.digest,
    sourceFingerprint: plan.source.fingerprint, state: 'publishing', instanceId: marker.instanceId,
    sessions: plan.selection, stores, files: output, excluded: plan.excluded,
    workspaceRegistration: plan.workspaceRegistration, profile: 'rebuilt', source: 'unchanged', createdAt: plan.createdAt }
  atomicJson(join(home, RECEIPT), receipt)
  return receipt
}
function syncDirectory(path) {
  if (process.platform === 'win32') return
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function syncTree(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) syncTree(path)
    else if (entry.isFile()) {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } else fail('MAP_IMPORT_CONFLICT', 'The prepared instance changed before its durability checkpoint.')
  }
  syncDirectory(root)
}

/**
 * Recompute a plan from its original source before any writes, then stage and verify an entire
 * instance on the target volume. Source files are only read; no source backup APIs are invoked.
 * Existing target data is never merged or replaced. Cancelled staging is reusable only by the
 * same operation and hashes; a crash-retained reservation requires explicit operator inspection.
 * @param {object} options plan is the unmodified JSON plan. Optional signal cancels before commit;
 *   onProgress observes copied files and publication. Build identity/context matches planning.
 * @returns {Promise<object>} Committed receipt after atomic directory publication.
 * @throws {MapImportError} Precommit failures leave the target unchanged and retain owned staging;
 *   postcommit uncertainty reports outcome-unknown and the recovery receipt path.
 */
export async function applyLegacyImport(options) {
  const plan = options?.plan
  if (!object(plan) || plan.format !== IMPORT_PLAN_FORMAT || !DIGEST.test(plan.digest)
    || plan.digest !== sha(canonicalJson(core(plan))) || !UUID.test(plan.operationId)
    || !object(plan.source) || !object(plan.target) || !Array.isArray(plan.selection)) {
    fail('MAP_IMPORT_PLAN', 'Use the complete, unedited JSON plan generated by this manager.')
  }
  aborted(options.signal)
  const fresh = await planLegacyImport({ ...options, from: plan.source.root, to: plan.target.root,
    sessions: plan.selection, snapshot: plan.source.snapshot, operationId: plan.operationId,
    createdAt: plan.createdAt, limits: plan.limits, mode: plan.target.mode, channel: plan.target.channel, distribution: plan.target.distribution })
  if (fresh.source.fingerprint !== plan.source.fingerprint || fresh.digest !== plan.digest) fail('MAP_IMPORT_SOURCE_CHANGED', 'The source or import plan changed; review a new dry-run plan before applying.')
  if (fresh.status !== 'ready') fail('MAP_IMPORT_INCOMPLETE', 'Resolve the listed conflicts and incomplete references, then generate a fresh plan.', { unresolved: fresh.unresolved, conflicts: fresh.conflicts })
  const target = fresh.target.root
  const parent = dirname(target)
  privateDirectory(parent)
  const lock = join(parent, `.map-import-lock-${sha(key(target)).slice(0, 24)}`)
  try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') fail('MAP_OPERATION_UNKNOWN', 'An import reservation is active or interrupted; inspect it before an explicit recovery.', { reservation: lock })
    throw new MapImportError('MAP_IMPORT_IO', 'Create the import reservation on the target volume before retrying.', { reason: error.code }, { cause: error })
  }
  const stage = join(parent, `.map-import-${plan.operationId}`)
  let published = false
  let failure
  let result
  try {
    if (targetConflicts(target, plan.operationId, plan.digest).length) fail('MAP_IMPORT_CONFLICT', 'The target is no longer empty or owned by this unfinished operation.')
    const interrupted = existsSync(join(target, RECEIPT))
    if (interrupted) {
      const receipt = parseJson(smallBytes(target, RECEIPT, 16 * 1024 ** 2).bytes, RECEIPT)
      verifyReceipt(target, receipt, plan)
      published = true
      result = { ...receipt, state: 'committed' }
      atomicJson(join(target, RECEIPT), result)
    } else {
      const free = statfsSync(parent, { bigint: true })
      if (free.bavail * free.bsize < BigInt(plan.byteBudget.stagingUpperBoundBytes)) fail('MAP_IMPORT_SPACE', 'Free the reported staging budget on the target volume, then retry.', { requiredBytes: plan.byteBudget.stagingUpperBoundBytes })
      const operation = { format: IMPORT_PLAN_FORMAT, operationId: plan.operationId, planDigest: plan.digest, target, sourceFingerprint: plan.source.fingerprint }
      const existing = lstatSync(stage, { throwIfNoEntry: false })
      if (existing === undefined) { mkdirSync(stage, { mode: 0o700 }); writeNew(join(stage, 'operation.json'), jsonBytes(operation)) }
      else if (!existing.isDirectory() || existing.isSymbolicLink()
        || canonicalJson(parseJson(smallBytes(stage, 'operation.json', 4096).bytes, 'operation.json')) !== canonicalJson(operation)) {
        fail('MAP_IMPORT_CONFLICT', 'The staging directory belongs to another operation or changed plan.', { staging: stage })
      }
      const receipt = await buildStage(plan, stage, options)
      aborted(options.signal)
      verifyReceipt(join(stage, 'home'), receipt, plan)
      await options.onProgress?.({ phase: 'verified', files: receipt.files.length })
      aborted(options.signal)
      const finalCheck = await planLegacyImport({ ...options, from: plan.source.root, to: target, sessions: plan.selection, snapshot: plan.source.snapshot,
        operationId: plan.operationId, createdAt: plan.createdAt, limits: plan.limits,
        mode: plan.target.mode, channel: plan.target.channel, distribution: plan.target.distribution })
      if (finalCheck.digest !== plan.digest || finalCheck.status !== 'ready') fail('MAP_IMPORT_SOURCE_CHANGED', 'Source or target changed before publication; retain staging and regenerate the plan.')
      verifyReceipt(join(stage, 'home'), receipt, plan)
      syncTree(join(stage, 'home'))
      aborted(options.signal)
      if (key(realpathSync.native(parent)) !== key(parent)) fail('MAP_IMPORT_PATH', 'The destination parent changed before publication.')
      const targetEntry = lstatSync(target, { throwIfNoEntry: false })
      if (targetEntry !== undefined && (!targetEntry.isDirectory() || targetEntry.isSymbolicLink() || readdirSync(target).length !== 0)) {
        fail('MAP_IMPORT_CONFLICT', 'The target is no longer empty; retain the staging instance.')
      }
      renameSync(join(stage, 'home'), target)
      published = true
      syncDirectory(parent)
      result = { ...receipt, state: 'committed' }
      atomicJson(join(target, RECEIPT), result)
      syncDirectory(join(target, 'map-maintenance'))
    }
  } catch (error) {
    failure = error instanceof MapImportError ? error : new MapImportError('MAP_IMPORT_IO', 'Inspect the failed import and retained staging before retrying.', { reason: error.code ?? error.name }, { cause: error })
    failure.details = { ...failure.details, state: published ? 'outcome-unknown' : 'not-committed', staging: stage, target, receipt: published ? join(target, RECEIPT) : null }
  }
  try { rmdirSync(lock) } catch (error) {
    throw new MapImportError('MAP_OPERATION_UNKNOWN', 'Inspect the retained import reservation before another operation.', {
      state: published ? 'committed' : 'not-committed', reservation: lock, cleanupPending: true, staging: stage,
    }, { cause: failure ?? error })
  }
  if (failure !== undefined) throw failure
  return { ...result, staging: stage, cleanup: 'retained-operation-evidence' }
}

/**
 * Parse only the import command. Discovery is the default; stdout/file rendering belongs to
 * the dispatcher. --snapshot records the operator's prepared readonly snapshot or quiescent
 * backup, not a promise inferred from mtimes or the destination's service lock.
 * @param {string[]} argv Arguments after `manage import`.
 * @param {object} [context] The managing process injects `owners` (storage, scale, toolNames,
 *   compatibility, require as documented on the owner resolver), mode/channel/distribution,
 *   and installRoots. Missing owners fails MAP_IMPORT_BUILD. homedir/cwd/env default to the
 *   process only for path parsing; signal and onProgress are optional operation controls.
 * @returns {Promise<object>} A dry-run plan, help descriptor, or committed receipt.
 * @throws {MapImportError} Unknown flags, missing paths, edited plans, or incomplete imports.
 */
export async function runImportCommand(argv, context = {}) {
  const args = { ...context, sessions: [] }
  let apply = false
  let dryRun = false
  let planPath
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, ...inline] = argv[index].split('=')
    if (flag === '--json') continue
    if (flag === '--help' || flag === '-h') return { usage: 'import --from SNAPSHOT --to EMPTY_HOME [--session ID] [--snapshot readonly|backup] [--max-bytes N]; import --apply --plan FILE', default: 'dry-run' }
    if (flag === '--apply') { apply = true; continue }
    if (flag === '--dry-run') { dryRun = true; continue }
    if (!['--from', '--to', '--session', '--sessions', '--snapshot', '--max-bytes', '--max-log-bytes', '--max-files', '--plan'].includes(flag)) fail('MAP_IMPORT_INPUT', 'Use only documented import arguments.', { flag })
    if (flag !== '--session' && seen.has(flag)) fail('MAP_IMPORT_INPUT', 'Supply each import option once, except --session.', { flag })
    seen.add(flag)
    const value = inline.length ? inline.join('=') : argv[++index]
    if (value === undefined || value.startsWith('--') || value === '') fail('MAP_IMPORT_INPUT', 'Supply a value for the import option.', { flag })
    if (flag === '--session') args.sessions.push(value)
    else if (flag === '--sessions') args.sessions.push(...value.split(','))
    else if (flag === '--max-bytes') args.limits = { ...args.limits, maxBytes: Number(value) }
    else if (flag === '--max-log-bytes') args.limits = { ...args.limits, maxLogBytes: Number(value) }
    else if (flag === '--max-files') args.limits = { ...args.limits, maxFiles: Number(value) }
    else if (flag === '--plan') planPath = value
    else args[flag.slice(2)] = value
  }
  if (!apply) {
    if (planPath !== undefined) fail('MAP_IMPORT_INPUT', '--plan is an apply input; save dry-run JSON using stdout redirection.')
    return planLegacyImport(args)
  }
  if (dryRun || planPath === undefined || seen.size !== 1 || !seen.has('--plan')) fail('MAP_IMPORT_INPUT', 'Apply with --apply --plan FILE; source and selection come from that immutable plan.')
  const absolute = resolve(context.cwd ?? process.cwd(), planPath)
  const plan = parseJson(smallBytes(dirname(absolute), basename(absolute), 16 * 1024 ** 2).bytes, basename(absolute))
  if (object(plan?.source) && overlaps(absolute, plan.source.root) || object(plan?.target) && overlaps(absolute, plan.target.root)) {
    fail('MAP_IMPORT_INPUT', 'Keep the plan file outside both the legacy snapshot and the destination.')
  }
  return applyLegacyImport({ ...context, plan })
}
