/**
 * Analysis-artifact publication and consumption: a computation stages its
 * product bytes, the catalog validates and digests them, and the artifact
 * version, its input references, and the publish intent commit in one
 * transaction. Artifacts inherit the minimum-privilege authorization of the
 * inputs they cite; reads re-check the authorization, the digest, and the
 * lifecycle state. The durability sweep backs `map_save`'s cross-storage
 * order: confirm artifact and resource bytes before any session checkpoint.
 *
 * @module @map-harness/spatial-catalog/artifacts
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { releaseStaging, registerStaging, sha256File } from '@map-harness/spatial-storage'
import { CatalogError } from './errors.ts'
import { assertGranted, grantOnPublish, readGrant, recallAffects } from './governance-repo.ts'
import { TENANT_DEFAULT, deriveAuthorization } from './governance.ts'
import {
  formatArtifactRef,
  newArtifactId,
  operationRefOf,
  rowIdOfRef,
  sha256BytesHex,
  type ArtifactId,
  type ArtifactRef,
  type OperationRef,
} from './refs.ts'
import { publishedBytes } from './register.ts'
import { withTransaction } from './store.ts'
import { readSemanticDefinition } from './semantic.ts'
import type {
  ArtifactMethod,
  ArtifactVersion,
  ObjectDurability,
  ObjectDurabilityStatus,
  PublishArtifactInput,
  PublishArtifactResult,
} from './types.ts'

/** The media type the artifact file area stores today. */
export const ARTIFACT_MEDIA_TYPE = 'application/geo+json'

/** Maximum bytes one artifact may store. */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024

/**
 * Publish one immutable artifact version.
 * @param db - the open catalog store.
 * @param root - the store root directory.
 * @param input - the publication request.
 * @param options - `maxStoreBytes` caps the published store size.
 * @returns the published artifact version.
 * @throws {CatalogError} with the same contract as {@link registerResource}
 *   plus `CATALOG_INVALID_INPUT` for oversized products and empty inputs.
 */
export function publishArtifact(
  db: DatabaseSync,
  root: string,
  input: PublishArtifactInput,
  options: { maxStoreBytes?: number; tenant?: string } = {},
): PublishArtifactResult {
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit`)
  }
  if (input.inputRefs.length === 0) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'an artifact must cite the inputs it was computed from')
  }
  const contentDigest = sha256BytesHex(input.bytes)
  const parametersDigest = parametersDigestOf(input)
  const authorization = deriveAuthorization(input.inputAuthorizations)
  const operationRef = operationRefOf('artifact', input.sessionId, input.sourceCallSeq)
  const requestDigest = requestDigestOf(parametersDigest, contentDigest, authorization)

  const existing = publishedOperation(db, operationRef)
  if (existing !== undefined) {
    if (existing.requestDigest !== requestDigest) {
      throw new CatalogError('CATALOG_CONFLICT', `operation ${operationRef} was published with different inputs`)
    }
    return {
      artifact: readArtifactRow(db, existing.resultRef as ArtifactRef),
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

  const artifactId = newArtifactId()
  const stagingPath = `staging/${operationRef}-${contentDigest.slice(0, 12)}.geojson`
  const stagingId = registerStaging(db, { relativePath: stagingPath, ownerSessionId: input.sessionId })
  try {
    writeStagedBytes(join(root, stagingPath), input.bytes)
    const stagedDigest = sha256File(join(root, stagingPath))
    if (stagedDigest !== contentDigest) {
      throw new CatalogError('CATALOG_DIGEST_MISMATCH', 'staged artifact bytes no longer match the publication digest')
    }
    publishWithinTransaction(db, root, {
      artifactId, input, contentDigest, parametersDigest, authorization, operationRef, requestDigest, stagingPath,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    })
  } catch (error: unknown) {
    releaseStaging(db, stagingId)
    throw error
  }
  releaseStaging(db, stagingId)
  return {
    artifact: readArtifactRow(db, formatArtifactRef(artifactId, 1)),
    operationRef,
    deduplicated: false,
  }
}

/** Promote the staged artifact bytes and commit version, inputs, and intent atomically. */
function publishWithinTransaction(
  db: DatabaseSync,
  root: string,
  context: {
    artifactId: ArtifactId
    input: PublishArtifactInput
    contentDigest: string
    parametersDigest: string
    authorization: string
    operationRef: OperationRef
    requestDigest: string
    stagingPath: string
    /** The tenant the artifact's grant publishes under. */
    tenant?: string
  },
): void {
  const { artifactId, input, contentDigest, parametersDigest, authorization, operationRef } = context
  const now = new Date().toISOString()
  const fileDir = `files/${artifactId.slice(0, 6)}`
  mkdirSync(join(root, fileDir), { recursive: true, mode: 0o700 })
  const storageRef = `${fileDir}/${artifactId}-v1.geojson`
  renameSync(join(root, context.stagingPath), join(root, storageRef))
  withTransaction(db, () => {
    db.prepare(
      'INSERT INTO artifacts '
      + '(artifact_id, version, state, relative_path, sha256, bytes, input_refs, method, created_at, '
      + 'logical_id, parameters_digest, analysis_crs, created_by, authorization) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `${artifactId}-v1`,
      1,
      'available',
      storageRef,
      contentDigest,
      input.bytes.byteLength,
      JSON.stringify(input.inputRefs),
      JSON.stringify(input.method),
      now,
      artifactId,
      parametersDigest,
      input.analysisCrs,
      input.sessionId,
      authorization,
    )
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
      'artifact',
      formatArtifactRef(artifactId, 1),
    )
    // The derived minimum-privilege domain is frozen into an explicit ACL row.
    grantOnPublish(db, 'artifact', formatArtifactRef(artifactId, 1), authorization, context.tenant ?? TENANT_DEFAULT)
  })
}

/**
 * Read one artifact version's bytes for an authorized consumer.
 * @param db - the open catalog store.
 * @param root - the store root directory.
 * @param ref - exact artifact ref, `art-…@vN`.
 * @param authorization - the caller's authorization domain.
 * @returns the artifact record and its immutable bytes.
 * @throws {CatalogError} `CATALOG_NOT_FOUND`/`CATALOG_REVOKED` per lifecycle,
 *   `CATALOG_DIGEST_MISMATCH` when bytes stop matching the record.
 */
export function readArtifactBytes(
  db: DatabaseSync,
  root: string,
  ref: string,
  authorization: string,
  tenant: string = TENANT_DEFAULT,
): { artifact: ArtifactVersion; bytes: Uint8Array } {
  const artifact = readArtifactRow(db, parseArtifactRef(ref))
  if (artifact.authorization !== authorization) {
    throw new CatalogError('CATALOG_NOT_FOUND', `artifact ${ref} is not available to this reader`)
  }
  if (artifact.status === 'revoked') {
    throw new CatalogError('CATALOG_REVOKED', `artifact ${ref} is revoked and unavailable`)
  }
  assertGranted(db, 'artifact', ref, authorization, tenant)
  const bytes = readControlledBytes(root, artifact.storageRef)
  if (sha256BytesHex(bytes) !== artifact.contentDigest) {
    throw new CatalogError('CATALOG_DIGEST_MISMATCH', `artifact ${ref} bytes no longer match its recorded digest`)
  }
  return { artifact, bytes }
}

/** Read one artifact record without its bytes. */
export function readArtifactRow(db: DatabaseSync, ref: ArtifactRef): ArtifactVersion {
  const row = db.prepare(
    'SELECT logical_id AS logicalId, version, state, relative_path AS relativePath, sha256, bytes, '
    + 'input_refs AS inputRefs, method, created_at AS createdAt, parameters_digest AS parametersDigest, '
    + 'analysis_crs AS analysisCrs, created_by AS createdBy, authorization '
    + 'FROM artifacts WHERE artifact_id = ?',
  ).get(rowIdOfRef(ref)) as Record<string, unknown> | undefined
  if (row === undefined) throw new CatalogError('CATALOG_NOT_FOUND', `artifact ${ref} is not published`)
  return rowToArtifact(row as Record<string, string | number>)
}

/**
 * Confirm a set of published refs for cross-storage durability checks. An
 * object whose copies were recalled reports `recalled`; otherwise an object
 * whose ACL grant is revoked or tombstoned reports that governance state
 * instead of `ok` — a save never confirms durability for content the
 * reader may no longer access, and the receipt names the state per ref.
 */
export function confirmDurability(
  db: DatabaseSync,
  root: string,
  refs: readonly string[],
  tenant: string = TENANT_DEFAULT,
): readonly ObjectDurability[] {
  return refs.map((ref) => {
    const kind = ref.startsWith('art-') ? 'artifact' as const : 'resource' as const
    const table = kind === 'artifact' ? 'artifacts' : 'catalog_resources'
    const row = db.prepare(
      `SELECT relative_path AS relativePath, sha256, state, authorization FROM ${table} WHERE ${kind === 'artifact' ? 'artifact_id' : 'resource_id'} = ?`,
    ).get(rowIdOfRef(ref)) as { relativePath: string; sha256: string; state: string; authorization: string } | undefined
    if (row !== undefined) {
      if (recallAffects(db, tenant, kind, ref)) {
        return { ref, kind, status: 'recalled' as const satisfies ObjectDurabilityStatus }
      }
      const grant = readGrant(db, kind, ref, row.authorization, tenant)
      if (grant !== undefined && grant.state !== 'granted') {
        return { ref, kind, status: grant.state as Extract<ObjectDurabilityStatus, 'revoked' | 'tombstoned'> }
      }
    }
    if (row === undefined || row.state !== 'available') {
      return { ref, kind, status: 'unpublished' as const satisfies ObjectDurabilityStatus }
    }
    const absolute = join(root, row.relativePath)
    if (!existsSync(absolute)) return { ref, kind, status: 'missing-file' as const satisfies ObjectDurabilityStatus }
    try {
      return {
        ref,
        kind,
        status: (sha256File(absolute) === row.sha256 ? 'ok' : 'digest-mismatch') as ObjectDurabilityStatus,
      }
    } catch {
      return { ref, kind, status: 'missing-file' as const satisfies ObjectDurabilityStatus }
    }
  })
}

/**
 * Upsert the semantic binding of one resource version: which definition
 * version maps its fields, with which mapping version and transform. The
 * binding publishes an explicit `granted` semantic ACL row under the
 * resource's own domain, so a semantic definition is itself a governed
 * object — revoking it refuses further resolutions that would need it.
 */
export function bindResource(
  db: DatabaseSync,
  ref: string,
  binding: { definitionId: string; definitionVersion: number; mappingVersion: number; transformVersion: string },
  tenant: string = TENANT_DEFAULT,
): void {
  const parsed = parseRefLoose(ref)
  if (parsed.kind !== 'resource') {
    throw new CatalogError('CATALOG_INVALID_INPUT', `bindings attach to resource refs, got "${ref}"`)
  }
  const domain = readVersionAuthorization(db, ref)
  if (domain === undefined) {
    throw new CatalogError('CATALOG_NOT_FOUND', `resource version ${ref} is not registered`)
  }
  readSemanticDefinition(db, binding.definitionId, binding.definitionVersion, domain, tenant)
  withTransaction(db, () => {
    assertGranted(db, 'resource', ref, domain, tenant)
    const other = db.prepare('SELECT definition_id FROM semantic_bindings WHERE resource_id = ? AND definition_id != ?').get(rowIdOfRef(ref), binding.definitionId)
    if (other !== undefined) throw new CatalogError('CATALOG_CONFLICT', 'a resource version supports one semantic binding')
    db.prepare(
      'INSERT INTO semantic_bindings (resource_id, definition_id, definition_version, mapping_version, transform_version, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(resource_id, definition_id) DO UPDATE SET definition_version = excluded.definition_version, '
      + 'mapping_version = excluded.mapping_version, transform_version = excluded.transform_version',
    ).run(rowIdOfRef(ref), binding.definitionId, binding.definitionVersion, binding.mappingVersion, binding.transformVersion, new Date().toISOString())
  })
}

/** The public ref of one semantic definition version. */
export function semanticRefOf(definitionId: string, definitionVersion: number): string {
  return `def-${definitionId}@v${definitionVersion}`
}

/** The authorization domain one resource version is published under. */
function readVersionAuthorization(db: DatabaseSync, ref: string): string | undefined {
  const row = db.prepare(
    'SELECT authorization FROM catalog_resources WHERE resource_id = ?',
  ).get(rowIdOfRef(ref)) as { authorization: string } | undefined
  return row?.authorization
}

/** Parse a ref for internal helpers without leaking the grammar's details. */
function parseRefLoose(ref: string): { kind: 'resource' | 'artifact'; id: string; version: number } {
  const match = /^(res|art)-[A-Za-z0-9-]+@v([1-9][0-9]*)$/.exec(ref)
  if (match === null) throw new CatalogError('CATALOG_INVALID_INPUT', `"${ref}" is not a catalog ref`)
  return { kind: match[1] === 'res' ? 'resource' : 'artifact', id: ref.slice(0, ref.indexOf('@')), version: Number(match[2]) }
}

/** Strict artifact ref parse (public reads refuse resource refs loudly). */
function parseArtifactRef(ref: string): ArtifactRef {
  if (!/^art-[A-Za-z0-9-]+@v[1-9][0-9]*$/.test(ref)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `"${ref}" is not an artifact ref of the form art-…@vN`)
  }
  return formatArtifactRef(ref.slice(0, ref.indexOf('@')) as ArtifactId, Number(ref.slice(ref.indexOf('@v') + 2)))
}

/** Map one artifacts row to the public record. */
function rowToArtifact(row: Record<string, string | number>): ArtifactVersion {
  const artifactId = String(row.logicalId) as ArtifactId
  const state = String(row.state)
  return {
    ref: formatArtifactRef(artifactId, Number(row.version)),
    artifactId,
    version: Number(row.version),
    inputRefs: safeArray(String(row.inputRefs)),
    method: JSON.parse(String(row.method)) as ArtifactMethod,
    parametersDigest: String(row.parametersDigest),
    analysisCrs: String(row.analysisCrs),
    contentDigest: String(row.sha256),
    byteCount: Number(row.bytes),
    storageRef: String(row.relativePath),
    status: state === 'available' ? 'available' : 'revoked',
    createdBy: String(row.createdBy),
    authorization: String(row.authorization),
    createdAt: String(row.createdAt),
  }
}

/** The published intent record for one artifact operation, when one exists. */
function publishedOperation(db: DatabaseSync, operationRef: OperationRef): { requestDigest: string; resultRef: string } | undefined {
  return db.prepare(
    "SELECT request_digest AS requestDigest, result_ref AS resultRef FROM intents WHERE operation_ref = ? AND state = 'published' AND result_kind = 'artifact'",
  ).get(operationRef) as { requestDigest: string; resultRef: string } | undefined
}

/** Canonical artifact request digest: method, parameters identity, and product digest. */
function parametersDigestOf(input: PublishArtifactInput): string {
  return sha256BytesHex(Buffer.from(JSON.stringify({
    inputRefs: [...input.inputRefs],
    method: input.method,
    analysisCrs: input.analysisCrs,
  }), 'utf8'))
}

/** The full request digest the intent record freezes. */
function requestDigestOf(parametersDigest: string, contentDigest: string, authorization: string): string {
  return sha256BytesHex(Buffer.from(JSON.stringify({ parametersDigest, contentDigest, authorization }), 'utf8'))
}

/** Write staged bytes with an exclusive owner-only file. */function writeStagedBytes(absolutePath: string, bytes: Uint8Array): void {
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

/** Bounded read of controlled bytes; digest verification is the caller's contract. */
function readControlledBytes(root: string, storageRef: string): Uint8Array {
  const absolute = join(root, storageRef)
  const chunks: Buffer[] = []
  try {
    const descriptor = openSync(absolute, 'r')
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let total = 0
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, total)
        if (count === 0) break
        total += count
        if (total > MAX_ARTIFACT_BYTES) {
          throw new CatalogError('CATALOG_INVALID_INPUT', `stored object exceeds the ${MAX_ARTIFACT_BYTES} byte read limit`)
        }
        chunks.push(Buffer.from(buffer.subarray(0, count)))
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error: unknown) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('CATALOG_IO', `stored object at "${storageRef}" could not be read`)
  }
  return Buffer.concat(chunks)
}

/** Parse a stored JSON array, refusing corrupt rows. */
function safeArray(text: string): readonly string[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new CatalogError('CATALOG_IO', 'stored input refs are corrupt')
  return parsed.map(String)
}
