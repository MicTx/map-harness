/**
 * Immutable resource registration: stage the source bytes in the controlled
 * staging area, validate structure and budgets against the actual bytes,
 * digest everything, then publish the resource version, its feature refs, and
 * the publish-intent record in ONE transaction before the version becomes
 * queryable. A failure before the commit leaves only recoverable staging
 * bytes — never a queryable version pointing at missing or unverified bytes.
 *
 * Registering changed bytes under the same resource name produces a new
 * version; existing versions stay readable and never inherit the new head.
 *
 * @module @map-harness/spatial-catalog/register
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { releaseStaging, registerStaging, sha256File } from '@map-harness/spatial-storage'
import { CatalogError } from './errors.ts'
import { assertGranted, grantOnPublish } from './governance-repo.ts'
import { TENANT_DEFAULT } from './governance.ts'
import { withTransaction } from './store.ts'
import { admitCollection } from './geojson.ts'
import {
  formatResourceRef,
  newResourceId,
  operationRefOf,
  resourceIdFromName,
  rowIdOfRef,
  sha256BytesHex,
  type OperationRef,
  type ResourceId,
  type ResourceRef,
} from './refs.ts'
import { coordinateConventionOf } from './crs.ts'
import type {
  FeatureRefEntry,
  RegisterResourceInput,
  RegisterResourceResult,
  ResourceVersion,
} from './types.ts'

/** The media type registration stores today. */
export const RESOURCE_MEDIA_TYPE = 'application/geo+json'

/** Internal row shape read back from `catalog_resources`. */
export interface ResourceRow {
  readonly resourceId: ResourceId
  readonly version: number
  readonly state: string
  readonly relativePath: string
  readonly sha256: string
  readonly bytes: number
  readonly schemaDigest: string
  readonly schemaFields: string
  readonly registeredAt: string
  readonly logicalId: string
  readonly mediaType: string
  readonly featureCount: number
  readonly geometryTypes: string
  readonly nativeCrs: string
  readonly extent: string | null
  readonly validTime: string | null
  readonly sourceDigest: string
  readonly authorization: string
}

/**
 * Register one immutable resource version.
 * @param db - the open catalog store.
 * @param root - the store root directory.
 * @param input - the registration request.
 * @param options - `maxStoreBytes` caps the published store size (staging is
 *   transient and uncounted); omit it for an uncapped store.
 * @returns the published version with its feature identities.
 * @throws {CatalogError} `CATALOG_INVALID_INPUT` for structural or budget
 *   violations, `CATALOG_STORE_FULL` when the byte budget is exhausted,
 *   `CATALOG_CONFLICT` when the same operation arrives with different
 *   inputs, `CATALOG_DIGEST_MISMATCH` when staged bytes stop matching, and
 *   `CATALOG_IO` for store write failures.
 */
export function registerResource(
  db: DatabaseSync,
  root: string,
  input: RegisterResourceInput,
  options: { maxStoreBytes?: number; tenant?: string } = {},
): RegisterResourceResult {
  const admitted = admitCollection(input.bytes, { enforceWgs84Range: input.enforceWgs84Range })
  const contentDigest = sha256BytesHex(input.bytes)
  const operationRef = operationRefOf('register', input.sessionId, input.sourceCallSeq)
  const requestDigest = requestDigestOf('register', input.nativeCrs, input.authorization, contentDigest, admitted.schemaDigest)

  const existing = publishedOperation(db, operationRef)
  if (existing !== undefined) {
    if (existing.requestDigest !== requestDigest) {
      throw new CatalogError('CATALOG_CONFLICT', `operation ${operationRef} was published with different inputs`)
    }
    const resource = readVersionRow(db, existing.resultRef as ResourceRef)
    return {
      resource,
      featureRefs: featureRefsOf(db, resource.resourceId, resource.version),
      operationRef,
      deduplicated: true,
    }
  }

  if (options.maxStoreBytes !== undefined && publishedBytes(db) + input.bytes.byteLength > options.maxStoreBytes) {
    throw new CatalogError(
      'CATALOG_STORE_FULL',
      `publishing ${input.bytes.byteLength} bytes would exceed the ${options.maxStoreBytes} byte store budget`,
    )
  }

  const resourceId = input.name === undefined ? newResourceId() : resourceIdFromName(input.name)
  const stagingPath = `staging/${operationRef}-${contentDigest.slice(0, 12)}.geojson`
  const stagingId = registerStaging(db, { relativePath: stagingPath, ownerSessionId: input.sessionId })

  let storageRef: string
  try {
    writeStagedBytes(join(root, stagingPath), input.bytes)
    const stagedDigest = sha256File(join(root, stagingPath))
    if (stagedDigest !== contentDigest) {
      throw new CatalogError('CATALOG_DIGEST_MISMATCH', 'staged bytes no longer match the registration digest')
    }
    storageRef = publishWithinTransaction(db, root, {
      resourceId,
      input,
      admitted,
      contentDigest,
      operationRef,
      requestDigest,
      stagingPath,
      stagingId,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    })
  } catch (error: unknown) {
    releaseStaging(db, stagingId)
    throw error
  }
  releaseStaging(db, stagingId)

  const ref = formatResourceRef(resourceId, versionOf(storageRef))
  const resource = readVersionRow(db, ref)
  if (resource === undefined) {
    throw new CatalogError('CATALOG_IO', `published version ${ref} is not queryable after its transaction committed`)
  }
  return {
    resource,
    featureRefs: featureRefsOf(db, resourceId, resource.version),
    operationRef,
    deduplicated: false,
  }
}

/** Inputs to the publish transaction, prepared outside it. */
interface PublishContext {
  readonly resourceId: ResourceId
  readonly input: RegisterResourceInput
  readonly admitted: ReturnType<typeof admitCollection>
  readonly contentDigest: string
  readonly operationRef: OperationRef
  readonly requestDigest: string
  readonly stagingPath: string
  readonly stagingId: string
  /** The tenant the published grants land under. */
  readonly tenant?: string
}

/**
 * Promote the staged bytes and publish every catalog row atomically: rename
 * into `files/` first (a crash here leaves a recyclable orphan), then commit
 * version, feature refs, and the publish intent together.
 */
function publishWithinTransaction(db: DatabaseSync, root: string, context: PublishContext): string {
  const { resourceId, input, admitted, contentDigest, operationRef } = context
  const now = new Date().toISOString()
  const fileDir = `files/${resourceId.slice(0, 6)}`
  mkdirSync(join(root, fileDir), { recursive: true, mode: 0o700 })

  const version = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS head FROM catalog_resources WHERE logical_id = ?',
  ).get(resourceId) as { head: number | bigint }
  const nextVersion = Number(version.head) + 1
  const storageRef = `${fileDir}/${resourceId}-v${nextVersion}.geojson`

  renameSync(join(root, context.stagingPath), join(root, storageRef))

  return withTransaction(db, () => {
    db.prepare(
      'INSERT INTO catalog_resources '
      + '(resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at, '
      + 'logical_id, media_type, feature_count, geometry_types, schema_fields, native_crs, extent, valid_time, '
      + 'source_digest, authorization, registered_by) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `${resourceId}-v${nextVersion}`,
      nextVersion,
      'available',
      storageRef,
      contentDigest,
      input.bytes.byteLength,
      admitted.schemaDigest,
      now,
      resourceId,
      RESOURCE_MEDIA_TYPE,
      admitted.featureCount,
      JSON.stringify(admitted.geometryTypes),
      JSON.stringify(admitted.fields),
      input.nativeCrs,
      admitted.extent === null ? null : JSON.stringify(admitted.extent),
      input.validTime === undefined ? null : JSON.stringify(input.validTime),
      sourceDigestOf(input.sourceLabel),
      input.authorization,
      input.sessionId,
    )
    const rowId = `${resourceId}-v${nextVersion}`
    const insertRef = db.prepare(
      'INSERT INTO feature_refs (resource_id, feature_ref, original_id, feature_index) VALUES (?, ?, ?, ?)',
    )
    for (const entry of admitted.featureRefs) {
      insertRef.run(rowId, entry.featureRef, entry.originalId, entry.featureIndex)
    }
    db.prepare(
      'INSERT INTO intents (operation_ref, session_id, source_call_seq, request_digest, state, created_at, updated_at, result_kind, result_ref) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      operationRef,
      input.sessionId,
      input.sourceCallSeq,
      context.requestDigest,
      'published',
      now,
      now,
      'resource',
      formatResourceRef(resourceId, nextVersion),
    )
    // The published version starts under an explicit granted ACL row; the
    // governance plane never fails closed on a missing row for fresh objects.
    grantOnPublish(db, 'resource', formatResourceRef(resourceId, nextVersion), input.authorization, context.tenant ?? TENANT_DEFAULT)
    grantOnPublish(db, 'session', input.sessionId, input.authorization, context.tenant ?? TENANT_DEFAULT)
    return storageRef
  })
}

/** Write staged bytes with an exclusive owner-only file. */
function writeStagedBytes(absolutePath: string, bytes: Uint8Array): void {
  try {
    const descriptor = openSync(absolutePath, 'wx', 0o600)
    try {
      writeSync(descriptor, bytes)
    } finally {
      closeSync(descriptor)
    }
  } catch (error: unknown) {
    throw new CatalogError('CATALOG_IO', `staging write failed: ${String((error as NodeJS.ErrnoException).code ?? error)}`)
  }
}

/** The published intent record for one operation, when one exists. */
function publishedOperation(db: DatabaseSync, operationRef: OperationRef): { requestDigest: string; resultRef: string } | undefined {
  const row = db.prepare(
    "SELECT request_digest AS requestDigest, result_ref AS resultRef FROM intents WHERE operation_ref = ? AND state = 'published' AND result_kind = 'resource'",
  ).get(operationRef) as { requestDigest: string; resultRef: string } | undefined
  return row
}

/** Read one version row back into the public record. */
export function readVersionRow(db: DatabaseSync, ref: ResourceRef): ResourceVersion {
  const row = db.prepare(
    'SELECT logical_id AS logicalId, version, state, relative_path AS relativePath, sha256, bytes, '
    + 'schema_digest AS schemaDigest, registered_at AS registeredAt, media_type AS mediaType, '
    + 'feature_count AS featureCount, geometry_types AS geometryTypes, schema_fields AS schemaFields, '
    + 'native_crs AS nativeCrs, extent, valid_time AS validTime, source_digest AS sourceDigest, '
    + 'authorization, registered_by AS registeredBy '
    + 'FROM catalog_resources WHERE resource_id = ?',
  ).get(rowIdOfRef(ref)) as Record<string, unknown> | undefined
  if (row === undefined) {
    throw new CatalogError('CATALOG_NOT_FOUND', `resource version ${ref} is not registered`)
  }
  return rowToVersion(row as unknown as ResourceRow & { registeredBy: string })
}

/** Map one storage row to the public record. */
function rowToVersion(row: ResourceRow & { registeredBy: string }): ResourceVersion {
  const resourceId = row.logicalId as ResourceId
  return {
    ref: formatResourceRef(resourceId, row.version),
    resourceId,
    version: row.version,
    contentDigest: row.sha256,
    schemaDigest: row.schemaDigest,
    schemaFields: safeJsonFields(row.schemaFields),
    mediaType: row.mediaType,
    byteCount: row.bytes,
    featureCount: row.featureCount,
    geometryTypes: safeJsonArray(row.geometryTypes),
    nativeCrs: row.nativeCrs,
    coordinateConvention: coordinateConventionOf(row.nativeCrs),
    extent: row.extent === null ? null : safeJsonExtent(row.extent),
    validTime: row.validTime === null ? null : JSON.parse(row.validTime) as ResourceVersion['validTime'],
    sourceDigest: row.sourceDigest,
    storageRef: row.relativePath,
    authorization: row.authorization,
    lifecycleState: row.state === 'available' ? 'available' : 'revoked',
    registeredAt: row.registeredAt,
  }
}

/** Feature identities of one version, in collection order. */
export function featureRefsOf(db: DatabaseSync, resourceId: ResourceId, version: number): readonly FeatureRefEntry[] {
  const rowId = rowIdOfRef(formatResourceRef(resourceId, version))
  const rows = db.prepare(
    'SELECT feature_ref AS featureRef, original_id AS originalId, feature_index AS featureIndex '
    + 'FROM feature_refs WHERE resource_id = ? ORDER BY feature_index',
  ).all(rowId) as Array<{ featureRef: string; originalId: string | null; featureIndex: number }>
  return rows.map(row => ({
    featureRef: row.featureRef as FeatureRefEntry['featureRef'],
    originalId: row.originalId,
    featureIndex: row.featureIndex,
  }))
}

/** Total published bytes across resources and artifacts (the store-budget denominator). */
export function publishedBytes(db: DatabaseSync): number {
  const row = db.prepare(
    'SELECT (SELECT COALESCE(SUM(bytes), 0) FROM catalog_resources) + (SELECT COALESCE(SUM(bytes), 0) FROM artifacts) AS total',
  ).get() as { total: number | bigint }
  return Number(row.total)
}

/** Canonical request digest: identity inputs only — never the byte payload itself. */
function requestDigestOf(
  kind: 'register',
  nativeCrs: string,
  authorization: string,
  contentDigest: string,
  schemaDigest: string,
): string {
  return sha256BytesHex(Buffer.from(JSON.stringify({ kind, nativeCrs, authorization, contentDigest, schemaDigest }), 'utf8'))
}

/** The registered source path's digest — recorded origin without the host path. */
function sourceDigestOf(label: string): string {
  return sha256BytesHex(Buffer.from(label, 'utf8'))
}

/** Parse a stored JSON array, refusing corrupt rows instead of defaulting. */
function safeJsonArray(text: string): readonly string[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new CatalogError('CATALOG_IO', 'stored geometry types are corrupt')
  return parsed.map(String)
}

/** Parse the stored schema field table, refusing corrupt rows. */
function safeJsonFields(text: string): ResourceVersion['schemaFields'] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new CatalogError('CATALOG_IO', 'stored schema fields are corrupt')
  return parsed.map(field => {
    const entry = field as { name?: unknown; type?: unknown }
    if (typeof entry.name !== 'string' || typeof entry.type !== 'string') {
      throw new CatalogError('CATALOG_IO', 'stored schema fields are corrupt')
    }
    return { name: entry.name, type: entry.type }
  })
}

/** Parse the stored extent tuple, refusing corrupt rows. */
function safeJsonExtent(text: string): ResourceVersion['extent'] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some(value => typeof value !== 'number')) {
    throw new CatalogError('CATALOG_IO', 'stored extent is corrupt')
  }
  return [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!]
}

/** Extract the per-version number from a published storage ref. */
function versionOf(storageRef: string): number {
  const match = /-v([1-9][0-9]*)\.geojson$/.exec(storageRef)
  if (match === null) throw new CatalogError('CATALOG_IO', `stored path "${storageRef}" is not a managed resource path`)
  return Number(match[1])
}


/**
 * Look up an already-published operation without touching any input source —
 * the retryOf path: the original call's publication is returned as-is, and a
 * missing record refuses instead of recomputing from the mutable source.
 * @param db - the open catalog store.
 * @param kind - which publish operation kind to look up.
 * @param sessionId - session that performed the original publication.
 * @param sourceCallSeq - seq of the original accepted `tool/call`.
 * @returns the published ref, or `undefined` when the operation never published.
 */
export function lookupPublication(
  db: DatabaseSync,
  kind: 'register' | 'artifact',
  sessionId: string,
  sourceCallSeq: number,
): { resultRef: string } | undefined {
  const operationRef = operationRefOf(kind, sessionId, sourceCallSeq)
  const row = db.prepare(
    "SELECT result_ref AS resultRef FROM intents WHERE operation_ref = ? AND state = 'published' AND result_kind = ?",
  ).get(operationRef, kind === 'register' ? 'resource' : 'artifact') as { resultRef: string } | undefined
  return row === undefined ? undefined : { resultRef: row.resultRef }
}

/** Check whether one store-relative path exists inside the root (read helpers). */
export function storedBytesPresent(root: string, storageRef: string): boolean {
  return existsSync(join(root, storageRef))
}

/**
 * Read one resource version's immutable bytes for an authorized consumer.
 * @param db - the open catalog store.
 * @param root - the store root directory.
 * @param ref - exact resource ref, `res-…@vN`.
 * @param authorization - the caller's authorization domain.
 * @param maxBytes - inclusive read cap.
 * @returns the resource record and its exact stored bytes.
 * @throws {CatalogError} `CATALOG_NOT_FOUND`/`CATALOG_REVOKED` per lifecycle,
 *   `CATALOG_DIGEST_MISMATCH` when bytes stop matching the record,
 *   `CATALOG_IO` for read failures.
 */
export function readResourceBytes(
  db: DatabaseSync,
  root: string,
  ref: string,
  authorization: string,
  maxBytes: number,
  tenant: string = TENANT_DEFAULT,
): { resource: ResourceVersion; bytes: Uint8Array } {
  const parsed = parseLooseResourceRef(ref)
  const resource = readVersionRow(db, parsed)
  if (resource.authorization !== authorization) {
    throw new CatalogError('CATALOG_NOT_FOUND', `resource version ${ref} is not available to this reader`)
  }
  if (resource.lifecycleState === 'revoked') {
    throw new CatalogError('CATALOG_REVOKED', `resource version ${ref} is revoked and unavailable`)
  }
  assertGranted(db, 'resource', ref, authorization, tenant)
  const chunks: Buffer[] = []
  try {
    const descriptor = openSync(join(root, resource.storageRef), 'r')
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let total = 0
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, total)
        if (count === 0) break
        total += count
        if (total > maxBytes) {
          throw new CatalogError('CATALOG_INVALID_INPUT', `resource version ${ref} exceeds the ${maxBytes} byte read limit`)
        }
        chunks.push(Buffer.from(buffer.subarray(0, count)))
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error: unknown) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('CATALOG_IO', `resource version ${ref} bytes could not be read`)
  }
  const bytes = Buffer.concat(chunks)
  if (sha256BytesHex(bytes) !== resource.contentDigest) {
    throw new CatalogError('CATALOG_DIGEST_MISMATCH', `resource version ${ref} bytes no longer match its recorded digest`)
  }
  return { resource, bytes }
}

/**
 * Stream one resource version's bytes in bounded chunks after the same
 * authorization and digest checks as {@link readResourceBytes} — the digest
 * verifies over the whole content before the first chunk reaches the
 * consumer, so a consumer never sees bytes the record does not cover.
 * @param db - the open store handle.
 * @param root - the store root.
 * @param ref - exact resource ref.
 * @param authorization - reader authorization the version was registered with.
 * @param limits - total byte ceiling and chunk size for one read.
 * @param onChunk - sink for successive content chunks (excluding the digest).
 * @returns the resolved resource version (bytes are delivered via `onChunk`).
 * @throws {CatalogError} same refusal family as {@link readResourceBytes}.
 */
export function readResourceChunks(
  db: DatabaseSync,
  root: string,
  ref: string,
  authorization: string,
  limits: { maxBytes: number; chunkBytes: number },
  onChunk: (chunk: Uint8Array) => void,
  tenant: string = TENANT_DEFAULT,
): { resource: ResourceVersion } {
  const parsed = parseLooseResourceRef(ref)
  const resource = readVersionRow(db, parsed)
  if (resource.authorization !== authorization) {
    throw new CatalogError('CATALOG_NOT_FOUND', `resource version ${ref} is not available to this reader`)
  }
  if (resource.lifecycleState === 'revoked') {
    throw new CatalogError('CATALOG_REVOKED', `resource version ${ref} is revoked and unavailable`)
  }
  assertGranted(db, 'resource', ref, authorization, tenant)
  if (resource.byteCount > limits.maxBytes) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `resource version ${ref} (${String(resource.byteCount)} bytes) exceeds the ${String(limits.maxBytes)} byte read limit`)
  }
  const digest = createHash('sha256')
  try {
    const descriptor = openSync(join(root, resource.storageRef), 'r')
    try {
      const buffer = Buffer.allocUnsafe(Math.min(limits.chunkBytes, 1024 * 1024))
      let total = 0
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, total)
        if (count === 0) break
        total += count
        digest.update(buffer.subarray(0, count))
        onChunk(Uint8Array.from(buffer.subarray(0, count)))
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error: unknown) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('CATALOG_IO', `resource version ${ref} bytes could not be read`)
  }
  if (digest.digest('hex') !== resource.contentDigest) {
    throw new CatalogError('CATALOG_DIGEST_MISMATCH', `resource version ${ref} bytes no longer match its recorded digest`)
  }
  return { resource }
}

/** Parse one resource ref (internal; the public grammar lives in refs.ts). */
function parseLooseResourceRef(ref: string): ResourceRef {
  if (!/^res-[A-Za-z0-9-]+@v[1-9][0-9]*$/.test(ref)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `"${ref}" is not a resource ref of the form res-…@vN`)
  }
  return formatResourceRef(ref.slice(0, ref.indexOf('@')) as ResourceId, Number(ref.slice(ref.indexOf('@v') + 2)))
}
