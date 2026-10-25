/**
 * The data-resourcing tools: `data_import` turns one workspace file (GeoJSON,
 * CSV, KML, or a Shapefile ZIP) into an immutable, versioned catalog resource
 * through the shared import admission; `data_export` publishes precise-ref,
 * loaded-layer, or whole-map data as immutable artifacts in the four formats.
 * Import never touches `catalog_register`'s verbatim-copy contract: the
 * canonical GeoJSON product is registered, the raw file stays in the
 * workspace, and every ambiguity stops at `needs_confirmation` with
 * candidates and a content-bound fingerprint. Export consumes exact refs
 * and inherits the source's authorization; whole-map exports report each
 * layer's success or failure honestly.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CatalogError, type SessionSpatialCatalog } from '@map-harness/spatial-catalog'
import { MAX_REGISTER_BYTES } from '@map-harness/spatial-catalog'
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { buildCatalogResultMeta } from './catalog-meta.ts'
import { buildDataExportMeta, decodeDataExportMeta, type DataExportArtifactEntry, type DataExportMeta } from './data-meta.ts'
import { catalogServiceOf, requirePendingPublish, sessionOf, type ToolSession } from './catalog-tools.ts'
import { admitImport } from './import-format/detect.ts'
import type { ImportFormat } from './import-format/admission.ts'
import { serializeExport, type ExportFormat } from './export-format/index.ts'
import { loadGeoJsonString } from './geo-source.ts'
import { renderJson } from './output.ts'
import { decodeJsonParam } from './json-param.ts'
import { serviceOf } from './service-context.ts'
import { SpatialError } from './spatial-errors.ts'

/** The formats `data_import` admits. */
const IMPORT_FORMATS: readonly ImportFormat[] = ['geojson', 'csv', 'kml', 'shapefile']

/** Render helper shared with the catalog tools: model text omits the durable meta. */
function renderCatalogJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Model guidance shared with the confirm parameter. */
const CONFIRM_DESCRIPTION = 'Confirmation from the previous needs_confirmation result: {"fingerprint": "…"}. Resend the same call with your resolved decisions (format/columns/crs) as normal parameters plus this confirm object; a changed file refuses the stale fingerprint.'

/** `data_import`: parse and admit one workspace data file into an immutable resource version. */
export const dataImport = defineTool({
  name: 'data_import',
  description:
    'Import one workspace data file (GeoJSON, CSV, KML, or a Shapefile ZIP) as an immutable, versioned catalog '
    + 'resource and use its ref for map_add_layer and analysis. CSV coordinate columns, a missing or '
    + 'unrecognizable Shapefile CRS, and undetectable formats stop at needs_confirmation with candidates and a '
    + 'fingerprint; ask the user, then resend with the decisions and confirm.fingerprint. Imported coordinates '
    + 'normalize to WGS84; the registered copy is immutable. Retry returns the original publication without '
    + 'rereading the file.',
  parameters: {
    path: { type: 'string', description: 'Data file path, workspace-relative; the format comes from the extension or content sniff. Omit only for retry_of.' },
    format: { type: 'string', description: 'geojson | csv | kml | shapefile; omit to resolve by extension/content sniff.' },
    crs: { type: 'string', description: 'Source CRS for CSV/Shapefile (EPSG code or +proj= string); KML is fixed WGS84 and refuses crs.' },
    encoding: { type: 'string', description: 'Text encoding for CSV (for example gbk); defaults to BOM sniff then UTF-8.' },
    lon_column: { type: 'string', description: 'Explicit CSV longitude column; skips the column confirmation. Pair with lat_column.' },
    lat_column: { type: 'string', description: 'Explicit CSV latitude column; skips the column confirmation. Pair with lon_column.' },
    id_column: { type: 'string', description: 'Optional explicit CSV id column that becomes feature.id.' },
    confirm: { type: 'json', description: CONFIRM_DESCRIPTION },
    name: { type: 'string', description: 'Stable resource name; re-importing one name publishes the next version of that resource.' },
    authorization: { type: 'string', description: 'Authorization domain to publish under; defaults to the local domain.' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original data_import `tool/call` to retry: returns the already-published version and never re-reads the path.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCatalogJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const {
      path, format, crs, encoding, lon_column: lonColumn, lat_column: latColumn, id_column: idColumn,
      confirm, name, authorization, retry_of: retryOf,
    } = args as {
      path?: string
      format?: string
      crs?: string
      encoding?: string
      lon_column?: string
      lat_column?: string
      id_column?: string
      confirm?: JsonValue
      name?: string
      authorization?: string
      retry_of?: number
    }
    if (path === undefined && retryOf === undefined) throw new SpatialError('INVALID_ARGUMENT', 'data_import requires a workspace-relative path (only retry_of needs none)')
    if (format !== undefined && !IMPORT_FORMATS.includes(format as ImportFormat)) {
      throw new SpatialError('INVALID_ARGUMENT', `format "${format}" is not one of ${IMPORT_FORMATS.join(' | ')}`)
    }
    let fingerprint: string | undefined
    if (confirm !== undefined) {
      const decoded = decodeJsonParam(confirm, 'confirm') as { fingerprint?: unknown }
      if (typeof decoded.fingerprint !== 'string' || decoded.fingerprint.length === 0) {
        throw new SpatialError('INVALID_ARGUMENT', 'confirm must be {"fingerprint": "<hex from the needs_confirmation result>"}')
      }
      fingerprint = decoded.fingerprint
    }
    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const publishDomain = catalog.deploymentDomain()
    if (authorization !== undefined && authorization !== publishDomain) {
      throw new SpatialError(
        'INVALID_ARGUMENT',
        `authorization "${authorization}" is not this deployment's domain ("${publishDomain}"); the publish domain comes from the deployment, not from model parameters`,
      )
    }
    const pending = requirePendingPublish(exec, catalog, session, 'data_import')
    if (retryOf !== undefined) {
      const published = await catalog.lookupPublication('register', retryOf)
      if (published === undefined) {
        throw new CatalogError('CATALOG_OPERATION_NOT_PUBLISHED', `call seq ${retryOf} has no published registration in this session`)
      }
      const { resource } = await catalog.readResourceBytes(published.resultRef, publishDomain, MAX_REGISTER_BYTES)
      return {
        status: 'succeeded',
        resource: {
          ref: resource.ref,
          version: resource.version,
          contentDigest: resource.contentDigest,
          schemaDigest: resource.schemaDigest,
          featureCount: resource.featureCount,
          geometryTypes: [...resource.geometryTypes],
          nativeCrs: resource.nativeCrs,
          coordinateConvention: resource.coordinateConvention,
          extent: resource.extent === null ? null : resource.extent.map(value => Math.round(value * 1e6) / 1e6),
        },
        feature_refs: [],
        total_feature_refs: 0,
        deduplicated: true,
        retry_of: retryOf,
        limitations: ['returned from the original publication; the source path was not re-read'],
        meta: buildCatalogResultMeta({
          operation: 'register',
          resources: [{
            ref: resource.ref,
            contentDigest: resource.contentDigest,
            schemaDigest: resource.schemaDigest,
            nativeCrs: resource.nativeCrs,
            featureCount: resource.featureCount,
            authorization: resource.authorization,
          }],
        }),
      }
    }
    // Unreachable in practice (the retry branch returns or throws), but it
    // narrows `path` to a string for the registration below.
    if (path === undefined) throw new SpatialError('INVALID_ARGUMENT', 'a new import requires a path')
    const outcome = await admitImport({
      path,
      ...(format === undefined ? {} : { format: format as ImportFormat }),
      ...(crs === undefined ? {} : { crs }),
      ...(encoding === undefined ? {} : { encoding }),
      ...(lonColumn === undefined ? {} : { lonColumn }),
      ...(latColumn === undefined ? {} : { latColumn }),
      ...(idColumn === undefined ? {} : { idColumn }),
      ...(fingerprint === undefined ? {} : { confirm: { fingerprint } }),
    }, exec as Parameters<typeof admitImport>[1])
    exec.signal.throwIfAborted()
    if (outcome.kind === 'needs_confirmation') {
      const admission = outcome.admission
      // The admission record carries readonly arrays from the pure parser;
      // a JSON round-trip projects it into the plain shapes results carry
      // (the same convention catalogResolve uses for interface-typed records).
      return JSON.parse(JSON.stringify({
        status: 'needs_confirmation',
        admission: {
          format: admission.format,
          format_candidates: admission.formatCandidates,
          encoding: admission.encoding,
          native_crs: admission.nativeCrs,
          source_digest: admission.sourceDigest,
          column_mapping: admission.columnMapping,
          column_candidates: admission.columnCandidates,
          prj_conclusion: admission.prjConclusion,
          crs_candidates: admission.crsCandidates,
          warnings: admission.warnings,
        },
        candidates_fingerprint: admission.candidatesFingerprint,
        next: 'ask the user to decide, then resend this call with the decisions as normal parameters plus confirm {"fingerprint": "' + admission.candidatesFingerprint + '"}',
      })) as JsonValue
    }
    const { geojson, admission } = outcome
    const { resource, featureRefs, deduplicated } = await catalog.register({
      ...(name === undefined ? {} : { name }),
      bytes: Buffer.from(JSON.stringify(geojson), 'utf8'),
      sourceLabel: `import:${admission.format}:${path}`,
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: publishDomain,
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
    })
    return {
      status: 'succeeded',
      resource: {
        ref: resource.ref,
        version: resource.version,
        contentDigest: resource.contentDigest,
        schemaDigest: resource.schemaDigest,
        featureCount: resource.featureCount,
        geometryTypes: [...resource.geometryTypes],
        nativeCrs: resource.nativeCrs,
        coordinateConvention: resource.coordinateConvention,
        extent: resource.extent === null ? null : resource.extent.map(value => Math.round(value * 1e6) / 1e6),
      },
      feature_refs: featureRefs.slice(0, 64).map(entry => ({
        feature_ref: entry.featureRef,
        original_id: entry.originalId,
        feature_index: entry.featureIndex,
      })),
      total_feature_refs: featureRefs.length,
      deduplicated,
      import: {
        format: admission.format,
        encoding: admission.encoding,
        source_digest: admission.sourceDigest,
      },
      limitations: [
        ...(admission.warnings.length === 0 ? [] : admission.warnings),
        'the registered copy is immutable: re-importing changed source bytes publishes a new version',
        'coordinates were normalized to WGS84 at import; the original file stays in the workspace',
      ],
      meta: buildCatalogResultMeta({
        operation: 'register',
        resources: [{
          ref: resource.ref,
          contentDigest: resource.contentDigest,
          schemaDigest: resource.schemaDigest,
          nativeCrs: resource.nativeCrs,
          featureCount: resource.featureCount,
          authorization: resource.authorization,
        }],
      }),
    }
  },
})

/** The export formats `data_export` publishes. */
const EXPORT_FORMATS: readonly ExportFormat[] = ['geojson', 'csv', 'kml', 'shapefile']

/** One resolved export source: canonical data plus publication identity. */
interface ExportSource {
  readonly collection: GeoJsonFeatureCollection
  readonly sourceRef: string
  readonly authorization: string
  readonly layerId: string | null
}

/** Read one exact catalog ref into canonical WGS84 data. */
async function sourceOfRef(catalog: SessionSpatialCatalog, ref: string, domain: string): Promise<ExportSource> {
  if (ref.startsWith('art-')) {
    const { artifact, bytes } = await catalog.readArtifactBytes(ref, domain)
    return {
      collection: loadGeoJsonString(bytes, artifact.analysisCrs),
      sourceRef: ref,
      authorization: artifact.authorization,
      layerId: null,
    }
  }
  const { resource, bytes } = await catalog.readResourceBytes(ref, domain, MAX_REGISTER_BYTES)
  return {
    collection: loadGeoJsonString(bytes, resource.nativeCrs),
    sourceRef: ref,
    authorization: resource.authorization,
    layerId: null,
  }
}

/** Serialize and publish one source as one immutable artifact. */
async function publishExport(parts: {
  readonly catalog: SessionSpatialCatalog
  readonly session: ToolSession
  readonly pending: Parameters<typeof requirePendingPublish>[3] extends never ? never : { readonly callSeq: number }
  readonly source: ExportSource
  readonly format: ExportFormat
  readonly name: string
  /** Zero-based within-call slot distinguishing a whole-map call's per-layer artifacts. */
  readonly operationSlot?: number
}): Promise<{
  readonly artifact: { ref: string; contentDigest: string; byteCount: number }
  readonly algorithm: string
  readonly featureCount: number
  readonly deduplicated: boolean
}> {
  const payload = serializeExport(parts.format, parts.source.collection, { name: parts.name })
  const featureCount = parts.source.collection.features.length
  const published = await parts.catalog.publishArtifact({
    bytes: payload.bytes,
    inputRefs: [parts.source.sourceRef],
    method: {
      algorithm: payload.algorithm,
      units: payload.extension,
      parameters: {
        format: parts.format,
        feature_count: featureCount,
        ...(parts.source.layerId === null ? {} : { layer_id: parts.source.layerId }),
      },
    },
    analysisCrs: 'EPSG:4326',
    sessionId: parts.session.id,
    sourceCallSeq: parts.pending.callSeq,
    ...(parts.operationSlot === undefined ? {} : { operationSlot: parts.operationSlot }),
    inputAuthorizations: [parts.source.authorization],
  })
  return {
    artifact: { ref: published.artifact.ref, contentDigest: published.artifact.contentDigest, byteCount: published.artifact.byteCount },
    algorithm: payload.algorithm,
    featureCount,
    deduplicated: published.deduplicated,
  }
}

/** `data_export`: publish exact-ref, loaded-layer, or whole-map data as immutable artifacts. */
export const dataExport = defineTool({
  name: 'data_export',
  description:
    'Publish map data as immutable, fixed-version artifacts in geojson, csv (points), kml, or shapefile ZIP. '
    + 'Choose exactly one source: an exact resource/artifact ref, one loaded layer (must be ref-loaded), or the '
    + 'whole map (one artifact per loaded layer, with per-layer success and failure reported honestly). Exports '
    + 'carry data only — no map styles or camera. Retry returns the already-published artifact without re-reading '
    + 'the source.',
  parameters: {
    ref: { type: 'string', description: 'Exact resource/artifact ref (`res-…@vN` or `art-…@vN`); mutually exclusive with layer_id and map.' },
    layer_id: { type: 'string', description: 'Loaded layer id to export (map_get_state lists layers); must be ref-loaded. Mutually exclusive with ref and map.' },
    map: { type: 'boolean', description: 'Export every loaded layer, one artifact per layer; per-layer failures are reported, never hidden. Mutually exclusive with ref and layer_id.' },
    format: { type: 'string', description: 'geojson | csv | kml | shapefile. CSV carries points only; shapefile requires one geometry family.' },
    name: { type: 'string', description: 'Artifact name; defaults to <source>.<extension>.' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original data_export `tool/call` to retry: returns the already-published artifact and never re-reads the source.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCatalogJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { ref, layer_id: layerId, map: wholeMap, format, name, retry_of: retryOf } = args as {
      ref?: string
      layer_id?: string
      map?: boolean
      format?: string
      name?: string
      retry_of?: number
    }
    if (format !== undefined && !EXPORT_FORMATS.includes(format as ExportFormat)) {
      throw new SpatialError('INVALID_ARGUMENT', `format "${format}" is not one of ${EXPORT_FORMATS.join(' | ')}`)
    }
    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const domain = catalog.deploymentDomain()
    const pending = requirePendingPublish(exec, catalog, session, 'data_export')
    if (retryOf !== undefined) {
      const publishedRef = await catalog.lookupPublication('artifact', retryOf)
      if (publishedRef === undefined) {
        throw new CatalogError('CATALOG_OPERATION_NOT_PUBLISHED', `call seq ${retryOf} has no published artifact in this session`)
      }
      const { artifact } = await catalog.readArtifactBytes(publishedRef.resultRef, domain)
      const featureCount = typeof artifact.method.parameters.feature_count === 'number' ? artifact.method.parameters.feature_count : 0
      return {
        status: 'succeeded',
        source: { kind: 'retry' },
        artifact: {
          ref: artifact.ref,
          content_digest: artifact.contentDigest,
          byte_count: artifact.byteCount,
          feature_count: featureCount,
          deduplicated: true,
        },
        retry_of: retryOf,
        limitations: ['returned from the original publication; the source was not re-read'],
        meta: buildDataExportMeta({
          tool: 'data_export',
          format: artifact.method.parameters.format as DataExportMeta['format'],
          artifacts: [{
            ref: artifact.ref,
            algorithm: artifact.method.algorithm,
            sourceRef: artifact.inputRefs[0] ?? artifact.ref,
            layerId: null,
            featureCount,
          }],
          limitations: ['retry record; the artifact was published by the original call'],
        }),
      }
    }
    if (format === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'data_export requires a format (only retry_of needs none)')
    }
    const chosen = [ref, layerId, wholeMap].filter(value => value !== undefined).length
    if (chosen !== 1) {
      throw new SpatialError('INVALID_ARGUMENT', 'data_export requires exactly one of ref, layer_id, or map')
    }
    exec.signal.throwIfAborted()

    const exportOne = async (source: ExportSource, options: { readonly operationSlot?: number } = {}): Promise<{
      status: 'succeeded'
      artifact: { ref: string; content_digest: string; byte_count: number; feature_count: number; deduplicated: boolean }
      meta: ReturnType<typeof buildDataExportMeta>
    }> => {
      const published = await publishExport({
        catalog,
        session,
        pending,
        source,
        format: format as ExportFormat,
        name: name ?? `${source.layerId ?? source.sourceRef}.${serializeExport(format as ExportFormat, source.collection, { name: 'probe' }).extension}`,
        ...(options.operationSlot === undefined ? {} : { operationSlot: options.operationSlot }),
      })
      return {
        status: 'succeeded',
        artifact: {
          ref: published.artifact.ref,
          content_digest: published.artifact.contentDigest,
          byte_count: published.artifact.byteCount,
          feature_count: published.featureCount,
          deduplicated: published.deduplicated,
        },
        meta: buildDataExportMeta({
          tool: 'data_export',
          format: format as DataExportMeta['format'],
          artifacts: [{
            ref: published.artifact.ref,
            algorithm: published.algorithm,
            sourceRef: source.sourceRef,
            layerId: source.layerId,
            featureCount: published.featureCount,
          }],
          limitations: [],
        }),
      }
    }

    if (ref !== undefined) {
      const source = await sourceOfRef(catalog, ref, domain)
      const result = await exportOne(source)
      return JSON.parse(JSON.stringify({
        status: 'succeeded',
        source: { kind: 'ref', ref },
        format,
        artifact: result.artifact,
        limitations: dataExportLimitationsOf(format as ExportFormat),
        meta: result.meta,
      })) as JsonValue
    }

    const mapService = serviceOf<{ stateOf(session: unknown): { revision: number; layers: readonly { id: string; name: string; data: GeoJsonFeatureCollection; resourceRef?: string; artifactRef?: string }[] } }>(exec, 'map')
    if (mapService === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
    const state = mapService.stateOf(session)

    if (layerId !== undefined) {
      const layer = state.layers.find(candidate => candidate.id === layerId)
      if (layer === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `unknown layer ${layerId}; map_get_state lists the loaded layers`)
      }
      const sourceRef = layer.resourceRef ?? layer.artifactRef
      if (sourceRef === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `layer ${layerId} was loaded from a workspace path; exports derive only from version-ref-loaded layers (re-add via map_add_layer ref)`)
      }
      const identity = await sourceOfRef(catalog, sourceRef, domain)
      const result = await exportOne({ collection: layer.data, sourceRef, authorization: identity.authorization, layerId })
      return JSON.parse(JSON.stringify({
        status: 'succeeded',
        source: { kind: 'layer', layer_id: layerId, map_revision: state.revision },
        format,
        artifact: result.artifact,
        limitations: dataExportLimitationsOf(format as ExportFormat),
        meta: result.meta,
      })) as JsonValue
    }

    // Whole map: one artifact per layer, per-layer failures reported honestly.
    const exported: Array<{ layer_id: string; artifact: { ref: string; content_digest: string; byte_count: number; feature_count: number; deduplicated: boolean } }> = []
    const failed: Array<{ layer_id: string; reason: string }> = []
    const metaArtifacts: DataExportArtifactEntry[] = []
    for (const layer of state.layers) {
      const sourceRef = layer.resourceRef ?? layer.artifactRef
      if (sourceRef === undefined) {
        failed.push({ layer_id: layer.id, reason: 'loaded from a workspace path; exports derive only from version-ref-loaded layers' })
        continue
      }
      try {
        const identity = await sourceOfRef(catalog, sourceRef, domain)
        const result = await exportOne({ collection: layer.data, sourceRef, authorization: identity.authorization, layerId: layer.id }, { operationSlot: exported.length })
        exported.push({ layer_id: layer.id, artifact: result.artifact })
        const meta = decodeDataExportMeta(result.meta)
        if (meta.status === 'ok') metaArtifacts.push(...meta.meta.artifacts)
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error)
        failed.push({ layer_id: layer.id, reason })
      }
    }
    if (exported.length === 0) {
      return {
        status: 'failed',
        source: { kind: 'map', map_revision: state.revision },
        format,
        exported: [],
        failed,
        limitations: ['no layer produced an artifact; nothing was published'],
      }
    }
    return JSON.parse(JSON.stringify({
      status: 'succeeded',
      source: { kind: 'map', map_revision: state.revision },
      format,
      exported,
      failed,
      limitations: [...dataExportLimitationsOf(format as ExportFormat), 'per-layer artifacts; failed layers are listed and never silently skipped'],
      meta: buildDataExportMeta({
        tool: 'data_export',
        format: format as DataExportMeta['format'],
        artifacts: metaArtifacts,
        limitations: [],
      }),
    })) as JsonValue
  },
})

/** Honest per-format limitations every export result carries. */
function dataExportLimitationsOf(format: ExportFormat): string[] {
  if (format === 'csv') return ['CSV carries lon/lat points with flattened properties; one row per point']
  if (format === 'kml') return ['KML ExtendedData carries property values as strings; Multi* geometries export one placemark per part']
  if (format === 'shapefile') return ['one geometry family per shapefile; DBF strings are capped at 254 bytes and refuse loudly beyond']
  return ['the artifact is immutable: re-exporting changed data publishes a new version']
}
