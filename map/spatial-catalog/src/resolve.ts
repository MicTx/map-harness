/**
 * Exact ref resolution: after the authorization filter, one catalog ref
 * resolves to its version, its frozen schema, its bounded feature-ref
 * listing, and a {@link RetrievalBundle}. The bundle pins the version,
 * digests, semantic binding, transform identity, read point, and
 * authorization grant so a later computation can re-verify exactly what this
 * resolution observed — without the catalog head ever silently invalidating
 * an older frozen version.
 *
 * @module @map-harness/spatial-catalog/resolve
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transformVersionOf } from './crs.ts'
import { CatalogError } from './errors.ts'
import { GovernanceError } from './governance-errors.ts'
import { assertGranted, readGrant } from './governance-repo.ts'
import { TENANT_DEFAULT, revokedDetail, tombstonedDetail } from './governance.ts'
import { parseCatalogRef } from './refs.ts'
import { featureRefsOf, readVersionRow } from './register.ts'
import { semanticRefOf } from './artifacts.ts'
import type { ResourceVersion, ResolvedResource, RetrievalBundle } from './types.ts'
import { readSemanticDefinition } from './semantic.ts'

/** Maximum feature refs one resolution lists before truncating. */
export const MAX_RESOLVE_FEATURE_REFS = 256

/** One resolution request. */
export interface ResolveInput {
  /** Exact ref of the resource version, `res-…@vN`. */
  readonly ref: string
  /** Authorization domain the caller reads under. */
  readonly authorization: string
  /** Feature-ref listing cap; defaults to {@link MAX_RESOLVE_FEATURE_REFS}. */
  readonly maxFeatureRefs?: number
  /**
   * The tenant the resolution reads under; absent reads as the
   * single-tenant default, so `@1` call shapes keep their exact behavior.
   */
  readonly tenant?: string
}

/**
 * Resolve one exact resource version for an authorized reader.
 * @param db - the open catalog store.
 * @param input - the resolution request.
 * @returns the version, schema, feature identities, and frozen bundle.
 * @throws {CatalogError} `CATALOG_NOT_FOUND` for unknown refs and for
 *   authorization mismatches (no existence disclosure), `CATALOG_REVOKED`
 *   for revoked versions, `CATALOG_INVALID_INPUT` for malformed refs.
 */
export function resolveResource(db: DatabaseSync, input: ResolveInput): ResolvedResource {
  const parsed = parseCatalogRef(input.ref)
  if (parsed.kind !== 'resource') {
    throw new CatalogError('CATALOG_INVALID_INPUT', `expected a resource ref, got artifact ref "${input.ref}"`)
  }
  const resource = readVersionRow(db, parsed.text)
  if (resource.authorization !== input.authorization) {
    throw new CatalogError('CATALOG_NOT_FOUND', `resource version ${input.ref} is not available to this reader`)
  }
  if (resource.lifecycleState === 'revoked') {
    throw new CatalogError('CATALOG_REVOKED', `resource version ${input.ref} is revoked and unavailable`)
  }
  assertGranted(db, 'resource', input.ref, input.authorization, input.tenant ?? TENANT_DEFAULT)
  const allRefs = featureRefsOf(db, resource.resourceId, resource.version)
  const cap = input.maxFeatureRefs ?? MAX_RESOLVE_FEATURE_REFS
  const bundle: RetrievalBundle = {
    resourceRef: resource.ref,
    contentDigest: resource.contentDigest,
    schemaDigest: resource.schemaDigest,
    semanticDefinition: null,
    mappingVersion: null,
    transformVersion: transformVersionOf(resource.nativeCrs),
    catalogReadPoint: { readId: randomUUID(), readAt: new Date().toISOString() },
    authorizationVersion: input.authorization,
  }
  const boundBundle = attachBinding(db, resource, bundle, input.tenant ?? TENANT_DEFAULT)
  return {
    semanticDefinitions: boundBundle.semanticDefinition === null ? [] : [readSemanticDefinition(db, boundBundle.semanticDefinition.definitionId, boundBundle.semanticDefinition.version, input.authorization)],
    resource,
    schema: {
      fields: resource.schemaFields,
      geometryTypes: resource.geometryTypes,
      featureCount: resource.featureCount,
    },
    featureRefs: allRefs.slice(0, cap),
    totalFeatureRefs: allRefs.length,
    bundle: boundBundle,
  }
}

/** Attach the semantic binding's frozen versions to the bundle, when one exists. */
function attachBinding(db: DatabaseSync, resource: ResourceVersion, bundle: RetrievalBundle, tenant: string): RetrievalBundle {
  const rows = db.prepare(
    'SELECT definition_id AS definitionId, definition_version AS definitionVersion, '
    + 'mapping_version AS mappingVersion, transform_version AS transformVersion '
    + 'FROM semantic_bindings WHERE resource_id = ?',
  ).all(versionRowId(resource)) as readonly Record<string, unknown>[]
  if (rows.length > 1) throw new CatalogError('CATALOG_CONFLICT', 'multiple bindings cannot fit a singular retrieval bundle')
  const row = rows[0] as { definitionId: string; definitionVersion: number; mappingVersion: number; transformVersion: string } | undefined
  if (row === undefined) return bundle
  // A semantic definition is a governed object: a resolution whose bundle
  // needs the binding refuses when the definition's grant is not granted —
  // a bundle frozen without its bound definition would be a silent downgrade.
  const grant = readGrant(db, 'semantic', semanticRefOf(row.definitionId, row.definitionVersion), resource.authorization, tenant)
  if (grant !== undefined && grant.state !== 'granted') {
    const ref = semanticRefOf(row.definitionId, row.definitionVersion)
    throw grant.state === 'revoked'
      ? new GovernanceError('GOVERNANCE_REVOKED', revokedDetail(`semantic definition ${ref}`))
      : new GovernanceError('GOVERNANCE_TOMBSTONED', tombstonedDetail(`semantic definition ${ref}`))
  }
  readSemanticDefinition(db, row.definitionId, row.definitionVersion, resource.authorization)
  return {
    ...bundle,
    semanticDefinition: { definitionId: row.definitionId, version: row.definitionVersion },
    mappingVersion: row.mappingVersion,
    transformVersion: row.transformVersion,
  }
}

/** The `catalog_resources` row id one version record corresponds to. */
export function versionRowId(resource: ResourceVersion): string {
  return `${resource.resourceId}-v${resource.version}`
}
