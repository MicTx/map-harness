/**
 * Transactional semantic definitions: immutable versions, normalized aliases,
 * bounded keyword retrieval, and authorization filtering before a candidate is
 * returned. The definition store deliberately keeps JSON values opaque to the
 * catalog; it indexes only the canonical name, aliases, and applicability.
 *
 * @module @map-harness/spatial-catalog/semantic
 */
import type { DatabaseSync } from 'node:sqlite'
import { CatalogError } from './errors.ts'
import { appendAudit, assertGranted, grantOnPublish } from './governance-repo.ts'
import { HOST_SUBJECT, TENANT_DEFAULT } from './governance.ts'
import { withTransaction } from './store.ts'

/** JSON values accepted in a semantic definition. */
export type SemanticJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SemanticJsonValue[]
  | { readonly [key: string]: SemanticJsonValue }

/** A definition version visible to an authorized reader. */
export interface SemanticDefinition {
  readonly definitionId: string
  readonly version: number
  readonly canonicalName: string
  readonly aliases: readonly string[]
  readonly definition: SemanticJsonValue
  readonly applicability: SemanticJsonValue
  readonly sourceRef: string
  readonly reviewStatus: string
  readonly authorization: string
  readonly createdAt: string
  readonly ref: string
}

/** Input for publishing the next immutable version of a definition. */
export interface RegisterSemanticDefinitionInput {
  readonly sessionId: string
  readonly definitionId: string
  readonly canonicalName: string
  readonly aliases?: readonly string[]
  readonly definition: SemanticJsonValue
  readonly applicability: SemanticJsonValue
  readonly sourceRef: string
  readonly reviewStatus: string
  readonly authorization: string
  /**
   * The tenant the definition is published under; absent publishes under
   * the single-tenant default, so `@1` call shapes keep their exact
   * behavior.
   */
  readonly tenant?: string
}

/** A semantic candidate and the field that matched the query. */
export interface SemanticCandidate {
  readonly definition: SemanticDefinition
  readonly exact: boolean
  readonly matchedBy: 'canonicalName' | 'alias' | 'keyword'
}

/** Bounded semantic retrieval result. */
export interface SemanticSearchResult {
  readonly query: string
  readonly candidates: readonly SemanticCandidate[]
  readonly total: number
}

/** Maximum definitions returned by one semantic query. */
export const MAX_SEMANTIC_CANDIDATES = 32

/** Publish one immutable semantic definition version. */
export function registerSemanticDefinition(
  db: DatabaseSync,
  input: RegisterSemanticDefinitionInput,
): SemanticDefinition {
  const definitionId = validateDefinitionId(input.definitionId)
  const canonicalName = requiredText(input.canonicalName, 'canonicalName')
  const sourceRef = requiredText(input.sourceRef, 'sourceRef')
  const reviewStatus = requiredText(input.reviewStatus, 'reviewStatus')
  const aliases = uniqueTexts(input.aliases ?? [], 'aliases')
  const definition = jsonText(input.definition, 'definition')
  const applicability = jsonText(input.applicability, 'applicability')
  const canonicalNormalized = normalizeText(canonicalName)
  const applicabilityNormalized = normalizeText(applicability)
  const now = new Date().toISOString()
  let version = 1
  withTransaction(db, () => {
    const row = db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM semantic_definitions WHERE definition_id = ?',
    ).get(definitionId) as { version: number | bigint }
    version = Number(row.version) + 1
    db.prepare(
      'INSERT INTO semantic_definitions '
      + '(definition_id, version, canonical_name, canonical_name_normalized, definition, applicability, applicability_normalized, source_ref, review_status, authorization, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      definitionId,
      version,
      canonicalName,
      canonicalNormalized,
      definition,
      applicability,
      applicabilityNormalized,
      sourceRef,
      reviewStatus,
      input.authorization,
      now,
    )
    for (const alias of aliases) {
      db.prepare(
        'INSERT INTO semantic_aliases (definition_id, definition_version, alias, alias_normalized) VALUES (?, ?, ?, ?)',
      ).run(definitionId, version, alias, normalizeText(alias))
    }
    grantOnPublish(db, 'semantic', semanticRefOf(definitionId, version), input.authorization, input.tenant ?? TENANT_DEFAULT)
    appendAudit(db, {
      subjectId: HOST_SUBJECT.subjectId, sessionId: input.sessionId, objectKind: 'semantic',
      ref: semanticRefOf(definitionId, version), resourceVersion: version,
      operation: 'publish', decision: 'allowed', reasonCode: 'GOVERNANCE_ALLOWED',
      domain: input.authorization, grantVersion: 1, tenant: input.tenant ?? TENANT_DEFAULT,
    })
  })
  return {
    definitionId,
    version,
    canonicalName,
    aliases,
    definition: input.definition,
    applicability: input.applicability,
    sourceRef,
    reviewStatus,
    authorization: input.authorization,
    createdAt: now,
    ref: semanticRefOf(definitionId, version),
  }
}

/** Search current authorized definition versions by name, alias, or keyword. */
export function searchSemanticDefinitions(
  db: DatabaseSync,
  input: { readonly query: string; readonly authorization: string; readonly applicability?: string; readonly limit?: number },
): SemanticSearchResult {
  const query = requiredText(input.query, 'query')
  const normalizedQuery = normalizeText(query)
  const applicability = input.applicability === undefined ? undefined : normalizeText(requiredText(input.applicability, 'applicability'))
  const limit = input.limit ?? MAX_SEMANTIC_CANDIDATES
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEMANTIC_CANDIDATES) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `semantic result limit must be an integer from 1 to ${MAX_SEMANTIC_CANDIDATES}`)
  }
  const rows = db.prepare(
    'SELECT d.definition_id AS definitionId, d.version, d.canonical_name AS canonicalName, '
    + 'd.definition, d.applicability, d.source_ref AS sourceRef, d.review_status AS reviewStatus, '
    + 'd.authorization, d.created_at AS createdAt, COUNT(*) OVER () AS total '
    + 'FROM semantic_definitions d '
    + 'JOIN governance_acl a ON a.object_kind = \'semantic\' '
    + 'AND a.ref = (\'def-\' || d.definition_id || \'@v\' || d.version) '
    + 'AND a.domain = ? AND a.state = \'granted\' '
    + 'WHERE '
    + 'd.version = (SELECT MAX(head.version) FROM semantic_definitions head WHERE head.definition_id = d.definition_id) '
    + 'AND (instr(d.canonical_name_normalized, ?) > 0 OR instr(lower(d.definition), ?) > 0 OR EXISTS '
    + '(SELECT 1 FROM semantic_aliases sa WHERE sa.definition_id = d.definition_id '
    + 'AND sa.definition_version = d.version AND instr(sa.alias_normalized, ?) > 0)) '
    + 'AND (? IS NULL OR instr(d.applicability_normalized, ?) > 0) '
    + 'ORDER BY CASE WHEN d.canonical_name_normalized = ? OR EXISTS '
    + '(SELECT 1 FROM semantic_aliases exact WHERE exact.definition_id = d.definition_id '
    + 'AND exact.definition_version = d.version AND exact.alias_normalized = ?) THEN 0 ELSE 1 END, '
    + 'd.canonical_name_normalized, d.definition_id LIMIT ?',
  ).all(input.authorization, normalizedQuery, normalizedQuery, normalizedQuery, applicability ?? null, applicability ?? null, normalizedQuery, normalizedQuery, limit) as readonly Record<string, unknown>[]
  const candidates: SemanticCandidate[] = []
  const seenIds = new Set<string>()
  for (const row of rows) {
    const definitionId = String(row.definitionId)
    if (seenIds.has(definitionId)) continue
    const definition = readSemanticDefinition(db, definitionId, Number(row.version), input.authorization)
    const canonical = normalizeText(definition.canonicalName)
    const alias = definition.aliases.some(value => normalizeText(value) === normalizedQuery)
    const exact = canonical === normalizedQuery || alias
    const matchedBy = canonical.includes(normalizedQuery)
      ? 'canonicalName'
      : alias || definition.aliases.some(value => normalizeText(value).includes(normalizedQuery))
        ? 'alias'
        : 'keyword'
    candidates.push({ definition, exact, matchedBy })
    seenIds.add(definitionId)
  }
  return { query, candidates, total: rows[0] === undefined ? 0 : Number(rows[0].total) }
}

/** Read one definition version without bypassing the caller's ACL filtering. */
export function readSemanticDefinition(db: DatabaseSync, definitionId: string, version: number, authorization: string, tenant: string = TENANT_DEFAULT): SemanticDefinition {
  const row = db.prepare(
    'SELECT definition_id AS definitionId, version, canonical_name AS canonicalName, definition, applicability, '
    + 'source_ref AS sourceRef, review_status AS reviewStatus, authorization, created_at AS createdAt '
    + 'FROM semantic_definitions WHERE definition_id = ? AND version = ?',
  ).get(definitionId, version) as Record<string, unknown> | undefined
  if (row === undefined) throw new CatalogError('CATALOG_NOT_FOUND', `semantic definition ${semanticRefOf(definitionId, version)} is not available to this reader`)
  assertGranted(db, 'semantic', semanticRefOf(definitionId, version), authorization, tenant)
  const aliases = db.prepare(
    'SELECT alias FROM semantic_aliases WHERE definition_id = ? AND definition_version = ? ORDER BY alias',
  ).all(definitionId, version) as readonly Record<string, unknown>[]
  return {
    definitionId: String(row.definitionId),
    version: Number(row.version),
    canonicalName: String(row.canonicalName),
    aliases: aliases.map(alias => String(alias.alias)),
    definition: parseJson(String(row.definition)),
    applicability: parseJson(String(row.applicability)),
    sourceRef: String(row.sourceRef),
    reviewStatus: String(row.reviewStatus),
    authorization: String(row.authorization),
    createdAt: String(row.createdAt),
    ref: semanticRefOf(String(row.definitionId), Number(row.version)),
  }
}

/** Check whether an exact definition version is granted in a domain. */
function validateDefinitionId(value: string): string {
  const id = requiredText(value, 'definitionId')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'definitionId must be one portable identifier segment')
  }
  return id
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new CatalogError('CATALOG_INVALID_INPUT', `${field} must be a non-empty string`)
  return value.trim()
}

function uniqueTexts(values: readonly string[], field: string): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = requiredText(value, field)
    const normalized = normalizeText(text)
    if (seen.has(normalized)) throw new CatalogError('CATALOG_INVALID_INPUT', `${field} contains a duplicate alias`)
    seen.add(normalized)
    result.push(text)
  }
  return result
}

function jsonText(value: SemanticJsonValue, field: string): string {
  if (!isSemanticJsonValue(value)) throw new CatalogError('CATALOG_INVALID_INPUT', `${field} must contain only finite JSON values`)
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('value serialized to undefined')
    return serialized
  } catch (error: unknown) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `${field} must be JSON serializable: ${String(error)}`)
  }
}

function isSemanticJsonValue(value: unknown): value is SemanticJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isSemanticJsonValue(item))
  if (typeof value !== 'object') return false
  return Object.values(value).every(item => isSemanticJsonValue(item))
}

function parseJson(value: string): SemanticJsonValue {
  return JSON.parse(value) as SemanticJsonValue
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function semanticRefOf(definitionId: string, version: number): string {
  return `def-${definitionId}@v${version}`
}
