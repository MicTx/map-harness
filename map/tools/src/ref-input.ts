/**
 * The versioned single-feature input shared by the geo tools: an exact
 * resource ref plus the stable feature ref the computation must consume.
 * Selection never falls back to the first feature — an unknown feature ref is
 * a loud refusal — and the consumed feature comes from the version's stored
 * bytes converged with the version's own recorded CRS, never from the mutable
 * source path.
 */
import type { Feature, Geometry, GeoJsonProperties } from 'geojson'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { MAX_REGISTER_BYTES, type SessionSpatialCatalog } from '@map-harness/spatial-catalog'
import { SpatialError } from './spatial-errors.ts'
import { loadGeoJsonString } from './geo-source.ts'

/** The `ref` input one geo tool end accepts. */
export interface FeatureRefInput {
  /** Exact resource ref, `res-…@vN` from catalog_register. */
  readonly resource: string
  /** Stable feature ref, `f-…` from catalog_resolve. */
  readonly feature: string
}

/** One consumed versioned feature with its exact identity. */
export interface VersionedFeature {
  readonly feature: Feature<Geometry, GeoJsonProperties>
  /** Zero-based position in the version's stored collection. */
  readonly index: number
  readonly resourceRef: string
  readonly featureRef: string
  /** Native CRS the version's bytes were converged from. */
  readonly nativeCrs: string
}

/**
 * Read the exact feature one versioned input selects.
 * @param catalog - the resolved catalog service.
 * @param input - the ref pair naming the version and the feature.
 * @returns the WGS84 feature with its version identity.
 * @throws {SpatialError} `INVALID_ARGUMENT` for unknown feature refs,
 *   `GEOMETRY_UNSUPPORTED` when the selected feature has no geometry, and
 *   catalog codes for missing, unauthorized, or tampered versions.
 */
export async function versionedFeatureOf(
  catalog: SessionSpatialCatalog,
  input: FeatureRefInput,
): Promise<VersionedFeature> {
  const resolved = await catalog.resolve({ ref: input.resource, authorization: catalog.deploymentDomain() })
  const entry = resolved.featureRefs.find(candidate => candidate.featureRef === input.feature)
  if (entry === undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `featureRef "${input.feature}" is not part of ${input.resource}; resolve the resource to list its feature refs`)
  }
  const { bytes, resource } = await catalog.readResourceBytes(input.resource, catalog.deploymentDomain(), MAX_REGISTER_BYTES)
  const collection = loadGeoJsonString(bytes, resource.nativeCrs)
  const selected = collection.features[entry.featureIndex]
  if (selected === undefined || selected.geometry === null || selected.geometry === undefined) {
    throw new SpatialError('GEOMETRY_UNSUPPORTED', `featureRef "${input.feature}" selects a feature without geometry in ${input.resource}`)
  }
  return {
    feature: selected as unknown as Feature<Geometry, GeoJsonProperties>,
    index: entry.featureIndex,
    resourceRef: resource.ref,
    featureRef: entry.featureRef,
    nativeCrs: resource.nativeCrs,
  }
}

/** The parameter-schema fragment declaring one versioned single-feature input. */
export const FEATURE_REF_INPUT_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  description: 'Versioned single-feature input: exact resource ref plus the stable feature ref to select (never defaults to the first feature).',
  properties: {
    resource: { type: 'string', required: true, description: 'Exact resource ref, `res-…@vN`.' },
    feature: { type: 'string', required: true, description: 'Stable feature ref, `f-…`, from catalog_resolve.' },
  },
  additionalProperties: false,
}
