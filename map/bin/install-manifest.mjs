/** Build and validate the standalone installation identity against Web package bytes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAP_IDENTITY_REVISION } from './instance-home.mjs'

/** Repository policy for building standalone installation manifests. */
export const INSTALL_CONTRACT_PATH = 'map/release/install.json'
/** Filename stored beside the Web service payload manifest. */
export const INSTALL_MANIFEST_FILE = 'map-install-manifest.json'
/** Installation manifest format supported by this manager. */
export const INSTALL_MANIFEST_FORMAT = 'map-harness-install-manifest-1'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRODUCT = 'map-harness'
const CONTRACT_FORMAT = 'map-harness-install-contract-1'
const PAYLOAD_FILE = 'web-service-manifest.json'
const VERSION_SOURCE = 'map/release/version.json'
const TARGET_SOURCE = 'scripts/primary-runtime/lock.json'
// This is the manager's supported target ABI, not a list of qualified releases.
const TARGETS = ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const DISTRIBUTIONS = ['portable', 'managed']
const CHANNELS = ['stable', 'preview']
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u
const PAYLOAD_FIELDS = ['format', 'product', 'version', 'targets', 'supportedTargets', 'unsupportedTargets', 'files']
const FILE_FIELDS = ['path', 'role', 'target', 'executable', 'sha256']
const INSTALL_FIELDS = ['format', 'product', 'distribution', 'channel', 'version', 'target', 'identityRevision', 'sourceDigest', 'payload', 'dataCompatibility']
const COMPATIBILITY_FIELDS = ['sessionFormat', 'spatialStore', 'accessibilityStore', 'storageSqlite', 'migration']

/** Expected installation failures carry stable codes and non-secret diagnostics. */
export class MapInstallError extends Error {
  /**
   * @param {string} code Machine-readable failure discriminator.
   * @param {string} message Affected operation and corrective action.
   * @param {object} [details] Non-secret context, excluding payload contents.
   * @param {ErrorOptions} [options] Original I/O cause where safe to preserve.
   */
  constructor(code, message, details = {}, options) {
    super(message, options)
    this.name = 'MapInstallError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details = {}) {
  throw new MapInstallError(code, message, details)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fields(value, names) {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function setEquals(values, expected) {
  return Array.isArray(values) && values.length === expected.length
    && new Set(values).size === expected.length && expected.every(value => values.includes(value))
}

function isVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonFile(path, subject) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    throw new MapInstallError('MAP_INSTALL_IO', `Read the ${subject} and retry the build.`, { path, reason: error.code }, { cause: error })
  }
  try { return JSON.parse(text) } catch (error) {
    // SyntaxError can contain file contents; retain only its classification.
    fail('MAP_INSTALL_SCHEMA', `Restore the malformed ${subject} before building.`, { path, reason: error.name })
  }
}

function parseBytes(bytes, subject) {
  if (!Buffer.isBuffer(bytes)) fail('MAP_INSTALL_INPUT', `${subject} must be supplied as exact file bytes.`)
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    fail('MAP_INSTALL_SCHEMA', `Restore the malformed ${subject}.`, { reason: error.name })
  }
}

function compatibleRange(value) {
  return fields(value, ['min', 'max']) && isPositiveInteger(value.min)
    && value.min === value.max
}

function compatibility(value) {
  if (!fields(value, COMPATIBILITY_FIELDS) || !isPositiveInteger(value.sessionFormat)
    || !compatibleRange(value.spatialStore) || !compatibleRange(value.accessibilityStore)
    || !isPositiveInteger(value.storageSqlite) || value.migration !== 'none') {
    fail('MAP_INSTALL_SCHEMA', 'Restore the unsupported or malformed data compatibility declaration.')
  }
  return {
    sessionFormat: value.sessionFormat,
    spatialStore: { min: value.spatialStore.min, max: value.spatialStore.max },
    accessibilityStore: { min: value.accessibilityStore.min, max: value.accessibilityStore.max },
    storageSqlite: value.storageSqlite,
    migration: value.migration,
  }
}

/**
 * Read the build contract without copying product version or target inventory into it.
 * @param {string} [root] Repository root; defaults to this checkout.
 * @returns {object} Validated installation build contract.
 * @throws {MapInstallError} Malformed configuration or unreadable file; no writes occur.
 */
export function readInstallContract(root = ROOT) {
  const value = jsonFile(join(root, INSTALL_CONTRACT_PATH), 'installation contract')
  const keys = ['format', 'manifest', 'product', 'identityRevision', 'distributions', 'channels', 'versionSource', 'targetSource', 'payloadManifest']
  if (!fields(value, keys) || value.format !== CONTRACT_FORMAT || value.product !== PRODUCT
    || value.identityRevision !== MAP_IDENTITY_REVISION
    || !fields(value.manifest, ['file', 'format']) || value.manifest.file !== INSTALL_MANIFEST_FILE
    || value.manifest.format !== INSTALL_MANIFEST_FORMAT || !setEquals(value.distributions, DISTRIBUTIONS)
    || !setEquals(value.channels, CHANNELS) || value.versionSource !== VERSION_SOURCE
    || value.targetSource !== TARGET_SOURCE || value.payloadManifest !== PAYLOAD_FILE) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the installation build contract before packaging.')
  }
  return value
}

/**
 * Snapshot one build's installation identity for the native application record.
 * The returned data is copied so subsequent caller mutation cannot alter the input.
 * @param {object} request Explicit distribution, channel, and owner-derived dataCompatibility.
 * @returns {object} Descriptor to embed in both the native core and build record.
 * @throws {MapInstallError} Unknown identity or malformed compatibility data; no writes occur.
 */
export function createInstallDescriptor(request) {
  if (!fields(request, ['distribution', 'channel', 'dataCompatibility'])
    || !DISTRIBUTIONS.includes(request.distribution) || !CHANNELS.includes(request.channel)) {
    fail('MAP_INSTALL_SCHEMA', 'Supply the supported distribution, channel, and owner-derived data compatibility.')
  }
  return { product: PRODUCT, distribution: request.distribution, channel: request.channel, identityRevision: MAP_IDENTITY_REVISION,
    dataCompatibility: compatibility(request.dataCompatibility) }
}

function unwrapExpression(ts, expression) {
  while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression))) {
    expression = expression.expression
  }
  return expression
}

function exportedInitializer(ts, source, name, path) {
  const matches = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
      || !statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.name.text === name) matches.push(item.initializer)
    }
  }
  if (matches.length !== 1 || matches[0] === undefined) {
    fail('MAP_INSTALL_OWNER', `Restore the unique exported ${name} in its owner.`, { path, symbol: name })
  }
  return unwrapExpression(ts, matches[0])
}

function literalInteger(ts, expression, path, symbol, allowZero = false) {
  const value = unwrapExpression(ts, expression)
  if (!value || !ts.isNumericLiteral(value) || !/^(?:0|[1-9]\d*)$/u.test(value.text)) {
    fail('MAP_INSTALL_OWNER', `Keep ${symbol} as a non-negative integer literal in its owner.`, { path, symbol })
  }
  const number = Number(value.text)
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    fail('MAP_INSTALL_OWNER', `Correct the numeric ${symbol} in its owner.`, { path, symbol })
  }
  return number
}

function ownerSource(ts, root, path) {
  let text
  try { text = readFileSync(join(root, path), 'utf8') } catch (error) {
    throw new MapInstallError('MAP_INSTALL_IO', `Read the data format owner ${path} before building.`, { path, reason: error.code }, { cause: error })
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (source.parseDiagnostics.length) fail('MAP_INSTALL_OWNER', `Repair the data format owner ${path} before building.`, { path })
  return source
}

function ownerVersion(ts, source, path, symbol) {
  return literalInteger(ts, exportedInitializer(ts, source, symbol, path), path, symbol)
}

function migrationLadder(ts, source, path, expected) {
  const initializer = exportedInitializer(ts, source, 'STORE_MIGRATION_STEPS', path)
  if (!ts.isArrayLiteralExpression(initializer)) {
    fail('MAP_INSTALL_OWNER', 'Restore the explicit spatial-store migration ladder.', { path })
  }
  let current = 0
  for (const step of initializer.elements) {
    if (!ts.isObjectLiteralExpression(step)) fail('MAP_INSTALL_OWNER', 'Restore the explicit spatial-store migration steps.', { path })
    const values = {}
    for (const property of step.properties) {
      if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) {
        fail('MAP_INSTALL_OWNER', 'Keep spatial migration version fields explicit without spreads or computed keys.', { path })
      }
      const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined
      if (!['from', 'to'].includes(key)) continue
      if (!ts.isPropertyAssignment(property) || Object.hasOwn(values, key)) {
        fail('MAP_INSTALL_OWNER', 'Keep each spatial migration version field as one literal assignment.', { path })
      }
      values[key] = literalInteger(ts, property.initializer, path, key, true)
    }
    if (values.from !== current || values.to !== current + 1) {
      fail('MAP_INSTALL_OWNER', 'Repair the contiguous spatial-store migration ladder.', { path })
    }
    current = values.to
  }
  if (current !== expected) fail('MAP_INSTALL_OWNER', 'Align the spatial-store migration ladder with its current schema.', { path })
}

/**
 * Derive a build snapshot from the four code owners without executing their modules.
 * Ranges denote schemas directly opened for reads/writes, not old versions that need migration.
 * `migration: none` means the installation manager performs no data migration; domain owners may.
 * @param {string} [root] Repository root; defaults to this checkout.
 * @returns {Promise<object>} Frozen-at-build compatibility declaration.
 * @throws {MapInstallError} An owner, literal, or the spatial migration ladder is missing or invalid; no writes occur.
 */
export async function readDataCompatibility(root = ROOT) {
  let ts
  try { ts = await import('typescript') } catch (error) {
    throw new MapInstallError('MAP_INSTALL_OWNER', 'Install the repository build dependencies before reading data format owners.', {}, { cause: error })
  }
  const specs = [
    ['sessionFormat', 'packages/core/session/src/types.ts', 'SESSION_FORMAT_VERSION'],
    ['spatialStore', 'map/spatial-storage/src/schema.ts', 'SPATIAL_STORE_SCHEMA_VERSION'],
    ['accessibilityStore', 'map/spatial-accessibility/src/runs.ts', 'ACCESSIBILITY_RUN_SCHEMA_VERSION'],
    ['storageSqlite', 'packages/storage/storage-sqlite/src/schema.ts', 'STORAGE_SQLITE_SCHEMA_VERSION'],
  ]
  const result = {}
  for (const [key, path, symbol] of specs) {
    const source = ownerSource(ts, root, path)
    const version = ownerVersion(ts, source, path, symbol)
    if (key === 'spatialStore') migrationLadder(ts, source, path, version)
    result[key] = key === 'spatialStore' || key === 'accessibilityStore' ? { min: version, max: version } : version
  }
  return compatibility({ ...result, migration: 'none' })
}

function shape(value) {
  if (!fields(value, INSTALL_FIELDS) || value.format !== INSTALL_MANIFEST_FORMAT || value.product !== PRODUCT
    || !DISTRIBUTIONS.includes(value.distribution) || !CHANNELS.includes(value.channel)
    || !isVersion(value.version) || !TARGETS.includes(value.target) || value.identityRevision !== MAP_IDENTITY_REVISION
    || !isDigest(value.sourceDigest) || !fields(value.payload, ['manifest', 'sha256'])
    || value.payload.manifest !== PAYLOAD_FILE || !isDigest(value.payload.sha256)) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the unsupported or malformed installation manifest.')
  }
  return {
    format: value.format, product: value.product, distribution: value.distribution, channel: value.channel,
    version: value.version, target: value.target, identityRevision: value.identityRevision, sourceDigest: value.sourceDigest,
    payload: { manifest: value.payload.manifest, sha256: value.payload.sha256 },
    dataCompatibility: compatibility(value.dataCompatibility),
  }
}

function expectedIdentity(expected) {
  const keys = ['product', 'distribution', 'channel', 'target', 'version', 'identityRevision', 'sourceDigest', 'payloadSha256']
  if (!fields(expected, keys) || expected.product !== PRODUCT || !DISTRIBUTIONS.includes(expected.distribution)
    || !CHANNELS.includes(expected.channel) || !TARGETS.includes(expected.target) || !isVersion(expected.version)
    || expected.identityRevision !== MAP_IDENTITY_REVISION || !isDigest(expected.sourceDigest) || !isDigest(expected.payloadSha256)) {
    fail('MAP_INSTALL_INPUT', 'Supply the complete independently verified installation identity and payload digest.')
  }
}

function safePath(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]+$/u.test(value)
    && value.split('/').every(part => part !== '' && !part.endsWith('.')
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

function distinctPaths(paths) {
  // Windows aliases and a file used as a directory must fail before any extraction.
  const normalized = paths.map(path => path.toLowerCase())
  const entries = new Set(normalized)
  if (entries.size !== paths.length) return false
  return normalized.every(path => {
    const parts = path.split('/')
    return parts.every((_, index) => index === 0 || !entries.has(parts.slice(0, index).join('/')))
  })
}

function validatePayload(manifest, bytes, records) {
  if (!Buffer.isBuffer(bytes)) fail('MAP_INSTALL_INPUT', 'Supply the exact Web service manifest bytes.')
  if (sha256(bytes) !== manifest.payload.sha256) fail('MAP_INSTALL_DIGEST', 'The Web service manifest digest changed; obtain the matching package.')
  const payload = parseBytes(bytes, 'Web service manifest')
  if (!fields(payload, PAYLOAD_FIELDS) || payload.format !== 1 || payload.product !== PRODUCT
    || payload.version !== manifest.version || !Array.isArray(payload.supportedTargets) || payload.supportedTargets.length === 0
    || !Array.isArray(payload.unsupportedTargets) || !Array.isArray(payload.targets) || !Array.isArray(payload.files)) {
    fail('MAP_INSTALL_PAYLOAD', 'Restore the Web service manifest identity and target inventory.')
  }
  const supported = payload.supportedTargets
  if (supported.some(target => !TARGETS.includes(target)) || new Set(supported).size !== supported.length
    || !setEquals(payload.unsupportedTargets, TARGETS.filter(target => !supported.includes(target)))
    || !supported.includes(manifest.target) || payload.targets.length !== supported.length
    || !object(records) || !setEquals(Object.keys(records), supported)) {
    fail('MAP_INSTALL_PAYLOAD', 'Supply exactly the native build records for all supported targets.')
  }
  const rows = new Map()
  for (const row of payload.targets) {
    if (!fields(row, ['target', 'record']) || !supported.includes(row.target) || rows.has(row.target)
      || !safePath(row.record) || !row.record.startsWith(`${row.target}/`) || !row.record.endsWith('.json')) {
      fail('MAP_INSTALL_PAYLOAD', 'Restore the Web service target record inventory.')
    }
    rows.set(row.target, row.record)
  }
  if (!setEquals([...rows.keys()], supported) || !distinctPaths([...rows.values()])) {
    fail('MAP_INSTALL_PAYLOAD', 'Restore the distinct Web service target record paths.')
  }
  if (payload.files.length === 0 || !distinctPaths(payload.files.map(row => typeof row?.path === 'string' ? row.path : ''))) {
    fail('MAP_INSTALL_PAYLOAD', 'Restore the unique Web service file inventory.')
  }
  const entries = new Map()
  for (const row of payload.files) {
    if (!fields(row, FILE_FIELDS) || !safePath(row.path)
      || [PAYLOAD_FILE, INSTALL_MANIFEST_FILE].includes(row.path.split('/').at(-1).toLowerCase())
      || typeof row.role !== 'string' || row.role.length === 0 || typeof row.executable !== 'boolean' || !isDigest(row.sha256)
      || (row.target !== null && !supported.includes(row.target))) {
      fail('MAP_INSTALL_PAYLOAD', 'Restore the Web service file metadata.')
    }
    entries.set(row.path, row)
  }
  const parsedRecords = {}
  for (const target of supported) {
    const recordPath = rows.get(target)
    const entry = entries.get(recordPath)
    const nativeBytes = records[target]
    if (!Buffer.isBuffer(nativeBytes)) fail('MAP_INSTALL_INPUT', 'Supply exact native build record bytes for every supported target.', { target })
    if (entry?.role !== 'build-record' || entry.target !== target || entry.executable || entry.sha256 !== sha256(nativeBytes)
      || payload.files.filter(item => item.role === 'build-record' && item.target === target).length !== 1) {
      fail('MAP_INSTALL_DIGEST', 'The Web service manifest does not bind the target build record.', { target })
    }
    const record = parseBytes(nativeBytes, `native ${target} build record`)
    const install = record?.install
    const service = payload.files.filter(item => item.role === 'service' && item.target === target)
    const [os, architecture] = target.split('-')
    const platform = { mac: 'darwin', win: 'win32', linux: 'linux' }[os]
    if (!object(record) || record.format !== 'map-harness-native-1' || record.version !== manifest.version
      || record.target !== target || record.sourceDigest !== manifest.sourceDigest || record.sourceCoreFiles !== 0
      || !object(record.engine) || record.engine.platform !== platform || record.engine.arch !== architecture
      || typeof record.engine.node !== 'string' || !/^v\d+\.\d+\.\d+$/u.test(record.engine.node)
      || !fields(record.webService, ['format', 'mode', 'profile']) || record.webService.format !== 1
      || record.webService.mode !== 'web' || record.webService.profile !== 'map-web'
      || !fields(install, ['product', 'distribution', 'channel', 'identityRevision', 'dataCompatibility'])
      || install.product !== manifest.product || install.distribution !== manifest.distribution || install.channel !== manifest.channel
      || install.identityRevision !== manifest.identityRevision || !same(compatibility(install.dataCompatibility), manifest.dataCompatibility)
      || typeof record.executable !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(record.executable)
      || record.executable === '.' || record.executable === '..' || !isDigest(record.sha256)
      || service.length !== 1 || !service[0].executable || service[0].path !== `${target}/${record.executable}`
      || service[0].sha256 !== record.sha256) {
      fail('MAP_INSTALL_PAYLOAD', 'The native build record conflicts with installation identity or payload.', { target })
    }
    parsedRecords[target] = record
  }
  if (payload.files.some(row => row.role === 'build-record' && (row.target === null || rows.get(row.target) !== row.path))
    || payload.files.some(row => row.role === 'service' && row.target === null)) {
    fail('MAP_INSTALL_PAYLOAD', 'Remove unbound native services or build records from the payload.')
  }
  return { payload, records: parsedRecords }
}

function validateExisting(installed, candidate) {
  if (installed === null) return 'ready'
  const previous = shape(installed)
  for (const key of ['product', 'distribution', 'channel', 'target', 'identityRevision']) {
    if (previous[key] !== candidate[key]) {
      fail('MAP_INSTALL_IDENTITY', `The existing installation ${key} differs; choose its matching package.`, { field: key })
    }
  }
  if (previous.version !== candidate.version) return 'ready'
  if (previous.sourceDigest !== candidate.sourceDigest || previous.payload.sha256 !== candidate.payload.sha256
    || !same(previous.dataCompatibility, candidate.dataCompatibility)) {
    fail('MAP_VERSION_CONFLICT', 'This version is already installed with different content or data compatibility; retain the current installation.')
  }
  return 'no-op'
}

/**
 * Validate an installation against independent release identity and exact package bytes.
 * The caller validates the release matrix/checksums and installed receipt before supplying
 * `expected` and `installedManifest`; this function does not authenticate publishers, read
 * local data versions, inspect the archive, or mutate installation state. It does not approve
 * update direction or rollback readability; the transaction owner must enforce both. On
 * `no-op` the installed identity, source digest, payload digest, and data metadata all match.
 * @param {object} input Candidate installation manifest.
 * @param {object} options Exact fields: expected, payloadManifestBytes, buildRecordBytes, installedManifest.
 * @param {object} options.expected Independent product, distribution, channel, target, version, identityRevision, sourceDigest, payloadSha256.
 * @param {Buffer} options.payloadManifestBytes Unmodified bytes of the payload manifest.
 * @param {Record<string, Buffer>} options.buildRecordBytes Unmodified native records for every payload-supported target.
 * @param {object|null} options.installedManifest Receipt-verified current manifest, or null for a new installation.
 * @returns {{manifest: object, payloadManifest: object, buildRecords: object, status: 'ready'|'no-op'}} Validated data for the transaction owner.
 * @throws {MapInstallError} Invalid schema, identity, digest, payload, or installed-version conflict; no writes occur.
 */
export function validateInstallManifest(input, options) {
  const manifest = shape(input)
  if (!fields(options, ['expected', 'payloadManifestBytes', 'buildRecordBytes', 'installedManifest'])) {
    fail('MAP_INSTALL_INPUT', 'Supply expected release identity, payload bytes, all build records, and explicit installed state.')
  }
  expectedIdentity(options.expected)
  for (const key of ['product', 'distribution', 'channel', 'target', 'version', 'identityRevision', 'sourceDigest']) {
    if (manifest[key] !== options.expected[key]) {
      fail('MAP_INSTALL_IDENTITY', `The package ${key} differs from the selected installation.`, { field: key })
    }
  }
  if (manifest.payload.sha256 !== options.expected.payloadSha256) {
    fail('MAP_INSTALL_DIGEST', 'The payload digest differs from the verified release; obtain the matching package.')
  }
  const validated = validatePayload(manifest, options.payloadManifestBytes, options.buildRecordBytes)
  const status = validateExisting(options.installedManifest, manifest)
  return { manifest, payloadManifest: validated.payload, buildRecords: validated.records, status }
}

/**
 * Construct one target-specific installation manifest from a verified native build snapshot.
 * The same Web payload bytes may be bound by several manifests, one per supported target.
 * `sourceDigest` must come from the build/release authority; all native records must agree.
 * @param {object} options Explicit build inputs; no fields default from the ambient environment.
 * @param {string} options.root Repository root containing installation policy and code owners.
 * @param {'portable'|'managed'} options.distribution Distribution recorded in the native build.
 * @param {'stable'|'preview'} options.channel Channel recorded in the native build.
 * @param {string} options.target Target selected from the locked inventory.
 * @param {string} options.sourceDigest Digest from verified community-build or release evidence.
 * @param {Buffer} options.payloadManifestBytes Unmodified bytes of the payload manifest.
 * @param {Record<string, Buffer>} options.buildRecordBytes Unmodified native records for every payload-supported target.
 * @returns {Promise<object>} New manifest with product version and data compatibility taken from their code owners.
 * @throws {MapInstallError} Build inputs disagree, required owners are unreadable, or any payload record is invalid; no writes occur.
 */
export async function createInstallManifest(options) {
  const keys = ['root', 'distribution', 'channel', 'target', 'sourceDigest', 'payloadManifestBytes', 'buildRecordBytes']
  if (!fields(options, keys) || typeof options.root !== 'string' || options.root.length === 0
    || !DISTRIBUTIONS.includes(options.distribution) || !CHANNELS.includes(options.channel)
    || !TARGETS.includes(options.target) || !isDigest(options.sourceDigest) || !Buffer.isBuffer(options.payloadManifestBytes)) {
    fail('MAP_INSTALL_INPUT', 'Supply the explicit checkout, identity, source digest, payload, and native records.')
  }
  const contract = readInstallContract(options.root)
  const version = jsonFile(join(options.root, contract.versionSource), 'product version')
  const lock = jsonFile(join(options.root, contract.targetSource), 'runtime target lock')
  if (!fields(version, ['version']) || !isVersion(version.version)) fail('MAP_INSTALL_OWNER', 'Restore the product version source.')
  if (!object(lock) || !object(lock.targets) || !setEquals(Object.keys(lock.targets), TARGETS)) {
    fail('MAP_INSTALL_OWNER', 'Align the manager supported targets with the runtime target owner.')
  }
  const dataCompatibility = await readDataCompatibility(options.root)
  const manifest = {
    format: contract.manifest.format, product: contract.product, distribution: options.distribution,
    channel: options.channel, version: version.version, target: options.target,
    identityRevision: contract.identityRevision, sourceDigest: options.sourceDigest,
    payload: { manifest: contract.payloadManifest, sha256: sha256(options.payloadManifestBytes) }, dataCompatibility,
  }
  validateInstallManifest(manifest, {
    expected: { product: manifest.product, distribution: manifest.distribution, channel: manifest.channel,
      target: manifest.target, version: manifest.version, identityRevision: manifest.identityRevision,
      sourceDigest: manifest.sourceDigest, payloadSha256: manifest.payload.sha256 },
    payloadManifestBytes: options.payloadManifestBytes, buildRecordBytes: options.buildRecordBytes, installedManifest: null,
  })
  return manifest
}
