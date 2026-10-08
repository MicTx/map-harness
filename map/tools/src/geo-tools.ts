/**
 * The spatial-analysis tools: buffer, area, intersect, and distance over
 * WGS84 GeoJSON through Turf. Inputs are strictly exclusive per end: a
 * workspace file (`path`, the legacy branch with unchanged semantics) or a
 * versioned catalog ref plus one exact feature selector (`ref`, which reads
 * the immutable registered copy — never the mutable source path). Outputs are
 * one canonical JSON value per call that projects three ways from the same
 * source: the model content text (`output.render` strips the durable meta),
 * the ToolRuntime `presentationMeta` published as `tool/result.meta`, and the
 * canonical structured value itself. Every successful value states its
 * status, the feature selection it actually consumed, and the method's key
 * limitations; failures carry no meta (design §6.3). A `ref`-driven
 * `geo_buffer` publishes its product as an immutable catalog artifact before
 * returning, so the model receives a loadable `artifactRef` instead of a
 * bare number.
 */
import { buffer, area as turfArea, intersect, distance as turfDistance, featureCollection } from '@turf/turf'
import type { Feature, Geometry, GeoJsonProperties } from 'geojson'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Session } from '@deepseek-ai/dsh-session'
import { CatalogError } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish } from './catalog-tools.ts'
import {
  FEATURE_REF_INPUT_SCHEMA,
  versionedFeatureOf,
  type FeatureRefInput,
  type VersionedFeature,
} from './ref-input.ts'
import { loadGeoJson, type GeoSource, type LoadedGeoData } from './geo-source.ts'
import {
  GEO_META_KIND,
  buildGeoAnalysisMeta,
  type GeoAnalysisInputRef,
  type GeoAnalysisMetric,
} from './geo-meta.ts'
import { SpatialError } from './spatial-errors.ts'
import { bboxOf, renderJson, round6 } from './output.ts'

/** Extract the first geometry-bearing feature of a loaded collection with its index. */
async function firstFeature(exec: ToolRunContext, source: GeoSource): Promise<{ feature: Feature<Geometry, GeoJsonProperties>; index: number; loaded: LoadedGeoData }> {
  const loaded = await loadGeoJson(source, exec)
  for (const [index, feature] of loaded.data.features.entries()) {
    if (feature.geometry !== null && feature.geometry !== undefined) {
      return { feature: feature as unknown as Feature<Geometry, GeoJsonProperties>, index, loaded }
    }
  }
  throw new SpatialError('GEOMETRY_UNSUPPORTED', `"${source.path}" has no geometry features`)
}

/** Numeric option accessor with bounds checking. */
function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} must be a number in [${min}, ${max}]`)
  }
  return value
}

/** The consumed-input identity one path-branch analysis records in its durable meta. */
function inputRef(source: GeoSource, loaded: LoadedGeoData, featureIndex: number): GeoAnalysisInputRef {
  return { path: source.path, crs: loaded.sourceCrs, featureIndex }
}

/** The consumed-input identity one versioned-ref analysis records in its durable meta. */
function versionedInputRef(consumed: VersionedFeature): GeoAnalysisInputRef {
  return {
    resourceRef: consumed.resourceRef,
    featureRef: consumed.featureRef,
    crs: consumed.nativeCrs,
    featureIndex: consumed.index,
  }
}

/**
 * Resolve exactly one data source end: `path` and `ref` are mutually
 * exclusive per end, and a `ref` must name both a resource and a feature —
 * there is never an implicit first-feature fallback.
 */
async function resolveEnd(
  exec: ToolRunContext,
  end: { path?: string | undefined; ref?: FeatureRefInput | undefined; crs?: string | undefined },
  label: string,
): Promise<
  | { readonly kind: 'path'; readonly feature: Feature<Geometry, GeoJsonProperties>; readonly index: number; readonly loaded: LoadedGeoData; readonly source: GeoSource }
  | { readonly kind: 'ref'; readonly consumed: VersionedFeature }
> {
  if (end.path !== undefined && end.ref !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `${label}: path and ref are mutually exclusive; give exactly one`)
  }
  if (end.path !== undefined) {
    const source: GeoSource = end.crs === undefined ? { path: end.path } : { path: end.path, crs: end.crs }
    const { feature, index, loaded } = await firstFeature(exec, source)
    return { kind: 'path', feature, index, loaded, source }
  }
  if (end.ref !== undefined) {
    const consumed = await versionedFeatureOf(catalogServiceOf(exec), end.ref)
    return { kind: 'ref', consumed }
  }
  throw new SpatialError('INVALID_ARGUMENT', `${label}: give either a workspace path or a versioned ref`)
}

/** Render helper for the geo family: model text omits the durable meta record. */
function renderGeoJson(value: JsonValue) {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Durable-meta projector for the geo family: publish the canonical record only. */
function geoPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** `geo_buffer`: buffer a feature by a fixed distance (meters) and report the result footprint. */
export const geoBuffer = defineTool({
  name: 'geo_buffer',
  description:
    'Compute a fixed-distance buffer around a GeoJSON feature. Give EITHER `path` (workspace file, legacy '
    + 'first-geometry-feature semantics) OR `ref` (exact resource + feature refs; publishes an immutable, '
    + 'map-loadable artifact). Buffers in geodesic-equivalent meters and reports area, bounding box, and — '
    + 'on the ref branch — a `artifact.ref` you can pass to map_add_layer.',
  parameters: {
    path: { type: 'string', description: 'GeoJSON file path (legacy branch; mutually exclusive with `ref`).' },
    crs: { type: 'string', description: 'Source CRS for `path` inputs; defaults to WGS84.' },
    ref: FEATURE_REF_INPUT_SCHEMA,
    distance_m: { type: 'number', description: 'Buffer distance in meters (positive grows, negative shrinks). Required unless `retry_of` is given.' },
    steps: { type: 'number', description: 'Number of circle approximation steps per quarter (higher is smoother; 1–32).' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original geo_buffer `tool/call` to retry: returns the already-published artifact and never recomputes.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderGeoJson(value),
    presentationMeta: (_args, value) => geoPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { path, ref, crs, distance_m, steps, retry_of: retryOf } = args as unknown as {
      path?: string
      ref?: FeatureRefInput
      crs?: string
      distance_m: number
      steps?: number
      retry_of?: number
    }
    if (retryOf !== undefined) {
      // retryOf returns the original published artifact as-is: the path is
      // never re-read and no geometry is recomputed; product metrics derive
      // from the stored bytes.
      const session = sessionForPublish(exec)
      const catalog = catalogServiceOf(exec)
      requirePendingPublish(exec, catalog, session, 'geo_buffer')
      const published = await catalog.lookupPublication('artifact', retryOf)
      if (published === undefined) {
        throw new CatalogError('CATALOG_OPERATION_NOT_PUBLISHED', `call seq ${retryOf} has no published artifact in this session`)
      }
      const { artifact, bytes } = await catalog.readArtifactBytes(published.resultRef, catalog.deploymentDomain())
      const product = JSON.parse(Buffer.from(bytes).toString('utf8')) as { features: Array<{ geometry: { coordinates?: unknown } }> }
      const areaM2 = turfArea(featureCollection(product.features as never))
      const box = bboxOf(product)
      return {
        distance_m: Number(artifact.method.parameters.distance_m),
        area_m2: round6(areaM2),
        bbox: box !== undefined ? box.map(round6) : null,
        artifact: {
          ref: artifact.ref,
          contentDigest: artifact.contentDigest,
          feature_count: product.features.length,
          deduplicated: true,
        },
        resource_ref: String(artifact.inputRefs[0]).split('+')[0] ?? '',
        feature_ref: String(artifact.inputRefs[0]).split('+')[1] ?? '',
        retry_of: retryOf,
        status: 'succeeded',
        limitations: [
          'returned from the original publication; the input path was not re-read and nothing was recomputed',
        ],
        meta: buildGeoAnalysisMeta({
          kind: GEO_META_KIND,
          tool: 'geo_buffer',
          status: 'succeeded',
          inputs: [{
            resourceRef: artifact.inputRefs[0]?.split('+')[0] ?? artifact.ref,
            featureRef: artifact.inputRefs[0]?.split('+')[1] ?? 'f-unknown',
            crs: artifact.analysisCrs,
            featureIndex: 0,
          }],
          method: { algorithm: 'turf-buffer', units: 'm', parameters: artifact.method.parameters },
          metrics: [{ name: 'buffer_area', value: round6(areaM2), unit: 'm^2' }],
          limitations: [
            'returned from the original publication; the input path was not re-read and nothing was recomputed',
          ],
        }),
      }
    }
    if (retryOf === undefined && distance_m === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'distance_m is required unless retry_of is given')
    }
    const meters = boundedNumber(distance_m, 'distance_m', -1e7, 1e7)
    const stepCount = steps === undefined ? 8 : boundedNumber(steps, 'steps', 1, 32)
    const end = await resolveEnd(exec, { path, ref, crs }, 'geo_buffer input')
    const source = end.kind === 'path'
      ? end.feature
      : end.consumed.feature
    const buffered = buffer(source, meters / 1000, { units: 'kilometers', steps: stepCount })
    if (buffered === undefined || buffered === null) throw new SpatialError('GEOMETRY_UNSUPPORTED', 'buffer produced no geometry for this feature')
    const areaM2 = turfArea(featureCollection([buffered]))
    const box = bboxOf({ features: [buffered as unknown as { geometry: { coordinates?: unknown } }] })

    if (end.kind === 'path') {
      const limitations = [
        'only the first geometry-bearing feature of the file is buffered',
        'the buffer outline is a steps-discretized approximation of geodesic-equivalent meters',
        'path inputs do not publish an artifact; use a versioned ref to get a map-loadable artifactRef',
      ]
      const metrics: GeoAnalysisMetric[] = [
        { name: 'buffer_area', value: round6(areaM2), unit: 'm^2' },
      ]
      return {
        distance_m: meters,
        area_m2: round6(areaM2),
        bbox: box !== undefined ? box.map(round6) : null,
        feature_index: end.index,
        status: 'succeeded',
        limitations,
        meta: buildGeoAnalysisMeta({
          kind: GEO_META_KIND,
          tool: 'geo_buffer',
          status: 'succeeded',
          inputs: [inputRef(end.source, end.loaded, end.index)],
          method: { algorithm: 'turf-buffer', units: 'm', parameters: { distance_m: meters, steps: stepCount } },
          metrics,
          limitations,
        }),
      }
    }

    // Versioned branch: publish the immutable artifact before returning, so
    // the reported ref always resolves to durable, authorized bytes.
    exec.signal.throwIfAborted()
    const session = sessionForPublish(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingPublish(exec, catalog, session, 'geo_buffer')
    const consumed = end.consumed
    const product = featureCollection([buffered as unknown as Feature<Geometry, GeoJsonProperties>])
    const resolved = await catalog.resolve({ ref: consumed.resourceRef, authorization: catalog.deploymentDomain() })
    const published = await catalog.publishArtifact({
      bytes: Buffer.from(JSON.stringify(product), 'utf8'),
      inputRefs: [`${consumed.resourceRef}+${consumed.featureRef}`],
      method: { algorithm: 'turf-buffer', units: 'm', parameters: { distance_m: meters, steps: stepCount } },
      analysisCrs: 'EPSG:4326',
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [resolved.resource.authorization],
    })
    const limitations = [
      'the buffer outline is a steps-discretized approximation of geodesic-equivalent meters',
      'the artifact bytes are the authoritative product; pass artifact.ref to map_add_layer to display it',
    ]
    const metrics: GeoAnalysisMetric[] = [
      { name: 'buffer_area', value: round6(areaM2), unit: 'm^2' },
    ]
    return {
      distance_m: meters,
      area_m2: round6(areaM2),
      bbox: box !== undefined ? box.map(round6) : null,
      artifact: {
        ref: published.artifact.ref,
        contentDigest: published.artifact.contentDigest,
        feature_count: 1,
        deduplicated: published.deduplicated,
      },
      resource_ref: consumed.resourceRef,
      feature_ref: consumed.featureRef,
      status: 'succeeded',
      limitations,
      meta: buildGeoAnalysisMeta({
        kind: GEO_META_KIND,
        tool: 'geo_buffer',
        status: 'succeeded',
        inputs: [versionedInputRef(consumed)],
        method: { algorithm: 'turf-buffer', units: 'm', parameters: { distance_m: meters, steps: stepCount } },
        metrics,
        limitations,
      }),
    }
  },
})

/** Resolve the calling session for a publish-capable execution. */
function sessionForPublish(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined || typeof session.id !== 'string') {
    throw new Error('publishing geo tools require an agent session caller')
  }
  return session
}

/** `geo_area`: measure a polygon feature's geodesic area. */
export const geoArea = defineTool({
  name: 'geo_area',
  description:
    'Measure the geodesic area (square meters) and bounding box of a polygonal GeoJSON feature. Give EITHER '
    + '`path` (workspace file; `feature_index` selects, default 0) OR `ref` (exact resource + feature refs). '
    + 'Pass `crs` for projected path sources.',
  parameters: {
    path: { type: 'string', description: 'GeoJSON file path (legacy branch; mutually exclusive with `ref`).' },
    feature_index: { type: 'number', description: 'Zero-based feature index for `path` inputs; defaults to 0. Ignored with `ref`.' },
    crs: { type: 'string', description: 'Source CRS for `path` inputs; defaults to WGS84.' },
    ref: FEATURE_REF_INPUT_SCHEMA,
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderGeoJson(value),
    presentationMeta: (_args, value) => geoPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { path, ref, feature_index: featureIndex, crs } = args as unknown as {
      path?: string
      ref?: FeatureRefInput
      feature_index?: number
      crs?: string
    }
    if (ref !== undefined && (path !== undefined || featureIndex !== undefined || crs !== undefined)) {
      throw new SpatialError('INVALID_ARGUMENT', 'ref is mutually exclusive with path, feature_index, and crs')
    }
    const limitations = [
      'area is the turf geodesic approximation over the whole selected feature',
      'a Point or line geometry contributes no measurable area under this operator',
    ]
    if (ref !== undefined) {
      const consumed = await versionedFeatureOf(catalogServiceOf(exec), ref)
      const areaM2 = turfArea(consumed.feature)
      const box = bboxOf({ features: [consumed.feature as unknown as { geometry: { coordinates?: unknown } }] })
      const metrics: GeoAnalysisMetric[] = [
        { name: 'area', value: round6(areaM2), unit: 'm^2' },
      ]
      return {
        area_m2: round6(areaM2),
        bbox: box !== undefined ? box.map(round6) : null,
        resource_ref: consumed.resourceRef,
        feature_ref: consumed.featureRef,
        status: 'succeeded',
        limitations,
        meta: buildGeoAnalysisMeta({
          kind: GEO_META_KIND,
          tool: 'geo_area',
          status: 'succeeded',
          inputs: [versionedInputRef(consumed)],
          method: { algorithm: 'turf-area', units: 'm^2', parameters: {} },
          metrics,
          limitations,
        }),
      }
    }
    if (path === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'geo_area requires either a workspace path or a versioned ref')
    }
    const source: GeoSource = crs === undefined ? { path } : { path, crs }
    const loaded = await loadGeoJson(source, exec)
    const index = featureIndex ?? 0
    if (!Number.isInteger(index) || index < 0 || index >= loaded.data.features.length) {
      throw new SpatialError('INVALID_ARGUMENT', `feature_index must be an integer in [0, ${loaded.data.features.length - 1}]`)
    }
    const feature = loaded.data.features[index] as unknown as Feature<Geometry, GeoJsonProperties>
    const areaM2 = turfArea(feature)
    const box = bboxOf({ features: [loaded.data.features[index] as { geometry: { coordinates?: unknown } | null }] })
    const metrics: GeoAnalysisMetric[] = [
      { name: 'area', value: round6(areaM2), unit: 'm^2' },
    ]
    return {
      area_m2: round6(areaM2),
      bbox: box !== undefined ? box.map(round6) : null,
      feature_index: index,
      status: 'succeeded',
      limitations,
      meta: buildGeoAnalysisMeta({
        kind: GEO_META_KIND,
        tool: 'geo_area',
        status: 'succeeded',
        inputs: [inputRef(source, loaded, index)],
        method: { algorithm: 'turf-area', units: 'm^2', parameters: {} },
        metrics,
        limitations,
      }),
    }
  },
})

/** `geo_intersect`: intersect two polygon features and report the overlap. */
export const geoIntersect = defineTool({
  name: 'geo_intersect',
  description:
    'Compute the geometric intersection of two polygonal GeoJSON features. Each end independently takes a '
    + 'workspace `path` (with its own `crs_a`/`crs_b`) or a versioned `ref_a`/`ref_b` selector — never both on '
    + 'one end, and a ref never falls back to the first feature. Reports overlap presence, area, and bbox.',
  parameters: {
    path_a: { type: 'string', description: 'First GeoJSON file path (legacy branch).' },
    path_b: { type: 'string', description: 'Second GeoJSON file path (legacy branch).' },
    ref_a: FEATURE_REF_INPUT_SCHEMA,
    ref_b: FEATURE_REF_INPUT_SCHEMA,
    crs_a: { type: 'string', description: 'Source CRS of file A; defaults to WGS84.' },
    crs_b: { type: 'string', description: 'Source CRS of file B; defaults to WGS84.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderGeoJson(value),
    presentationMeta: (_args, value) => geoPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { path_a, path_b, ref_a, ref_b, crs_a, crs_b } = args as unknown as {
      path_a?: string
      path_b?: string
      ref_a?: FeatureRefInput
      ref_b?: FeatureRefInput
      crs_a?: string
      crs_b?: string
    }
    const [a, b] = await Promise.all([
      resolveEnd(exec, { path: path_a, ref: ref_a, crs: crs_a }, 'input A'),
      resolveEnd(exec, { path: path_b, ref: ref_b, crs: crs_b }, 'input B'),
    ])
    const featureA = a.kind === 'path' ? a.feature : a.consumed.feature
    const featureB = b.kind === 'path' ? b.feature : b.consumed.feature
    const overlap = intersect(featureCollection([featureA, featureB]) as unknown as Parameters<typeof intersect>[0])
    const limitations = [
      'each end consumes the single feature its path or ref selected',
      'polygon-overlay semantics: intersects=false means no positive-area overlap; boundary-touching polygons report no overlap',
    ]
    const identities = {
      ...(a.kind === 'path'
        ? { feature_index_a: a.index }
        : { resource_ref_a: a.consumed.resourceRef, feature_ref_a: a.consumed.featureRef }),
      ...(b.kind === 'path'
        ? { feature_index_b: b.index }
        : { resource_ref_b: b.consumed.resourceRef, feature_ref_b: b.consumed.featureRef }),
    }
    const inputs: GeoAnalysisInputRef[] = [
      a.kind === 'path' ? inputRef(a.source, a.loaded, a.index) : versionedInputRef(a.consumed),
      b.kind === 'path' ? inputRef(b.source, b.loaded, b.index) : versionedInputRef(b.consumed),
    ]
    if (overlap === null) {
      const metrics: GeoAnalysisMetric[] = [{ name: 'overlap_area', value: 0, unit: 'm^2' }]
      return {
        intersects: false,
        overlap_area_m2: 0,
        bbox: null,
        ...identities,
        status: 'succeeded',
        limitations,
        meta: buildGeoAnalysisMeta({
          kind: GEO_META_KIND,
          tool: 'geo_intersect',
          status: 'succeeded',
          inputs,
          method: { algorithm: 'turf-intersect', units: 'm^2', parameters: {} },
          metrics,
          limitations,
        }),
      }
    }
    const areaM2 = turfArea(overlap)
    const box = bboxOf({ features: [overlap as unknown as { geometry: { coordinates?: unknown } }] })
    const metrics: GeoAnalysisMetric[] = [
      { name: 'overlap_area', value: round6(areaM2), unit: 'm^2' },
    ]
    return {
      intersects: true,
      overlap_area_m2: round6(areaM2),
      bbox: box !== undefined ? box.map(round6) : null,
      ...identities,
      status: 'succeeded',
      limitations,
      meta: buildGeoAnalysisMeta({
        kind: GEO_META_KIND,
        tool: 'geo_intersect',
        status: 'succeeded',
        inputs,
        method: { algorithm: 'turf-intersect', units: 'm^2', parameters: {} },
        metrics,
        limitations,
      }),
    }
  },
})

/** `geo_distance`: geodesic distance between two point features. */
export const geoDistance = defineTool({
  name: 'geo_distance',
  description:
    'Measure the geodesic distance between two point GeoJSON features. Each end independently takes a workspace '
    + '`path` (with its own `crs_a`/`crs_b`) or a versioned `ref_a`/`ref_b` selector — never both on one end. '
    + 'Reports kilometers and meters.',
  parameters: {
    path_a: { type: 'string', description: 'First GeoJSON file path holding a Point feature (legacy branch).' },
    path_b: { type: 'string', description: 'Second GeoJSON file path holding a Point feature (legacy branch).' },
    ref_a: FEATURE_REF_INPUT_SCHEMA,
    ref_b: FEATURE_REF_INPUT_SCHEMA,
    crs_a: { type: 'string', description: 'Source CRS of file A; defaults to WGS84.' },
    crs_b: { type: 'string', description: 'Source CRS of file B; defaults to WGS84.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderGeoJson(value),
    presentationMeta: (_args, value) => geoPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { path_a, path_b, ref_a, ref_b, crs_a, crs_b } = args as unknown as {
      path_a?: string
      path_b?: string
      ref_a?: FeatureRefInput
      ref_b?: FeatureRefInput
      crs_a?: string
      crs_b?: string
    }
    const [a, b] = await Promise.all([
      resolveEnd(exec, { path: path_a, ref: ref_a, crs: crs_a }, 'input A'),
      resolveEnd(exec, { path: path_b, ref: ref_b, crs: crs_b }, 'input B'),
    ])
    const featureA = a.kind === 'path' ? a.feature : a.consumed.feature
    const featureB = b.kind === 'path' ? b.feature : b.consumed.feature
    const km = turfDistance(featureA as unknown as Parameters<typeof turfDistance>[0], featureB as unknown as Parameters<typeof turfDistance>[1], { units: 'kilometers' })
    const limitations = [
      'each end consumes the single feature its path or ref selected',
      'distance is the turf great-circle (spherical) approximation',
    ]
    const metrics: GeoAnalysisMetric[] = [
      { name: 'distance', value: round6(km), unit: 'km' },
      { name: 'distance', value: round6(km * 1000), unit: 'm' },
    ]
    return {
      distance_km: round6(km),
      distance_m: round6(km * 1000),
      ...(a.kind === 'path'
        ? { feature_index_a: a.index }
        : { resource_ref_a: a.consumed.resourceRef, feature_ref_a: a.consumed.featureRef }),
      ...(b.kind === 'path'
        ? { feature_index_b: b.index }
        : { resource_ref_b: b.consumed.resourceRef, feature_ref_b: b.consumed.featureRef }),
      status: 'succeeded',
      limitations,
      meta: buildGeoAnalysisMeta({
        kind: GEO_META_KIND,
        tool: 'geo_distance',
        status: 'succeeded',
        inputs: [
          a.kind === 'path' ? inputRef(a.source, a.loaded, a.index) : versionedInputRef(a.consumed),
          b.kind === 'path' ? inputRef(b.source, b.loaded, b.index) : versionedInputRef(b.consumed),
        ],
        method: { algorithm: 'turf-distance', units: 'km', parameters: {} },
        metrics,
        limitations,
      }),
    }
  },
})
