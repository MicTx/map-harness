/**
 * The P0b data-chain tools: `catalog_register` (immutable resource versions
 * copied into the controlled store), `catalog_resolve` (exact-ref resolution
 * into a frozen RetrievalBundle), and `map_save` (the cross-storage save that
 * confirms artifact and catalog durability before the session checkpoint).
 *
 * Publish tools pair with their accepted `tool/call` through the
 * `spatialCatalog` projection — the trusted `sourceCallSeq` every publish
 * operation cites — so a retry can only ever return an already-published
 * object, never recompute from a changed source. Every failure carries a
 * stable `SpatialErrorCode`/`CATALOG_*` prefix in its model-visible text.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type CatalogResultResource,
  buildCatalogResultMeta,
} from './catalog-meta.ts'
import { buildMapSaveReceiptMeta, type MapSaveStageStatus } from './save-meta.ts'
import { SpatialError } from './spatial-errors.ts'
import {
  CatalogError,
  COPY_LIMIT_NOTE,
  type PendingPublishCall,
  RECALL_NOTE,
  type SessionSpatialCatalog,
  type SpatialCatalogService,
} from '@map-harness/spatial-catalog'
import {
  type MapContainerService,
  type MapProjectionState,
} from '@map-harness/map-container'
import type { Session } from '@deepseek-ai/dsh-session'
import { assertCrsSupported, readBoundedWorkspaceFile, type GeoSource } from './geo-source.ts'
import { isWgs84FamilyCrs, MAX_REGISTER_BYTES } from '@map-harness/spatial-catalog'
import { renderJson } from './output.ts'
import { serviceOf } from './service-context.ts'

/** The tool session a catalog tool requires (inferred; no extra package dep). */
type ToolSession = NonNullable<ToolRunContext['agent']>['session']

/** Resolve the calling agent's session; every catalog tool requires an agent caller. */
export function sessionOf(exec: ToolRunContext): ToolSession {
  const session = exec.agent?.session
  if (session === undefined || typeof session.id !== 'string') {
    throw new Error('catalog tools require an agent session caller')
  }
  return session
}

/**
 * Reach the calling conversation's own catalog library from the tool's
 * execution context: the host-plane service is a process-level router, so
 * this binds the agent caller's session id to its per-session store view.
 * Every subsequent call on the returned view reads and writes only that
 * conversation's database.
 */
export function catalogServiceOf(exec: ToolRunContext): SessionSpatialCatalog {
  const catalog = serviceOf<SpatialCatalogService>(exec, 'spatialCatalog')
  if (catalog === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'spatial catalog service is unavailable in this process')
  }
  return catalog.forSession(sessionOf(exec).id)
}

/** Reach the map read face (host-plane service). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
  return map
}

/**
 * The tools whose successful results publish catalog objects and therefore
 * pair with their accepted `tool/call`: the two P0b originals, the six P2
 * stat/pattern tools, the eight P3 decision-model tools, the visualization
 * style publisher, the terrain line-of-sight tool, the stream
 * materialization tool, and the scale scan publisher.
 */
export type PublishToolName = 'catalog_register' | 'geo_buffer' | 'stats_zonal' | 'stats_autocorrelation' | 'stats_hotspot' | 'pattern_change' | 'pattern_cluster' | 'pattern_flow' | 'attribution_association' | 'attribution_explain' | 'attribution_effect' | 'forecast_validate' | 'forecast_fit' | 'forecast_predict' | 'scenario_compare' | 'location_allocate' | 'viz_create_style' | 'viz_aggregate' | 'geo_line_of_sight' | 'terrain_viewshed' | 'stream_materialize' | 'scale_scan'

/**
 * Resolve the accepted publish `tool/call` this execution pairs with, through
 * the catalog projection's pending entries. Publish tools without that
 * pairing cannot cite an honest `sourceCallSeq`, so they fail loud instead of
 * publishing.
 */
export function requirePendingPublish(
  exec: ToolRunContext,
  service: SessionSpatialCatalog,
  session: Session,
  name: PublishToolName,
): PendingPublishCall {
  if (exec.parent !== undefined) {
    throw new Error('publish tools support native model-direct calls only; nested dispatch cannot publish')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingPublishCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `publish requires its accepted tool/call in the session log before execution (${name})`)
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** Render helper shared by the catalog tools: model text omits the durable meta. */
function renderCatalogJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** `catalog_register`: copy, validate, and publish one immutable resource version. */
export const catalogRegister = defineTool({
  name: 'catalog_register',
  description:
    'Register a workspace GeoJSON file as an immutable, versioned resource in the map catalog. '
    + 'The exact bytes are copied into the controlled store and digested; later analysis reads the copy, '
    + 'so later changes to the source file never alter a registered version. Pass `crs` for projected sources. '
    + 'Returns the exact resource ref (res-…@vN) that the geo_* tools\' `ref` input and map_add_layer consume.',
  parameters: {
    path: { type: 'string', required: true, description: 'GeoJSON file path (workspace-relative or absolute).' },
    crs: { type: 'string', description: 'Source CRS of the file; defaults to WGS84.' },
    name: { type: 'string', description: 'Stable resource name; re-registering one name publishes the next version of that resource.' },
    authorization: { type: 'string', description: 'Authorization domain to publish under; defaults to the local domain.' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original catalog_register `tool/call` to retry: returns the already-published version and never re-reads the path.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCatalogJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { path, crs, name, authorization, retry_of: retryOf } = args as {
      path: string
      crs?: string
      name?: string
      authorization?: string
      retry_of?: number
    }
    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    // The authorization domain is a deployment decision owned by the host:
    // a model-supplied domain that differs from the deployment domain refuses
    // loudly instead of being silently rewritten.
    const publishDomain = catalog.deploymentDomain()
    if (authorization !== undefined && authorization !== publishDomain) {
      throw new SpatialError(
        'INVALID_ARGUMENT',
        `authorization "${authorization}" is not this deployment's domain ("${publishDomain}"); the publish domain comes from the deployment, not from model parameters`,
      )
    }
    const pending = requirePendingPublish(exec, catalog, session as unknown as Session, 'catalog_register')
    if (retryOf !== undefined) {
      // retryOf returns the original publication as-is: the source path is
      // never re-read and a missing record is a loud refusal, not a recompute.
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
        limitations: [
          'returned from the original publication; the source path was not re-read',
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
    }
    const nativeCrs = crs === undefined ? 'EPSG:4326' : crs
    if (!isWgs84FamilyCrs(nativeCrs)) assertCrsSupported(nativeCrs)
    const source: GeoSource = crs === undefined ? { path } : { path, crs }
    const bytes = await readBoundedWorkspaceFile(source, exec, MAX_REGISTER_BYTES)
    exec.signal.throwIfAborted()
    const { resource, featureRefs, deduplicated } = await catalog.register({
      ...(name === undefined ? {} : { name }),
      bytes,
      sourceLabel: path,
      nativeCrs,
      enforceWgs84Range: isWgs84FamilyCrs(nativeCrs),
      authorization: publishDomain,
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
    })
    const meta: JsonValue = buildCatalogResultMeta({
      operation: 'register',
      resources: [{
        ref: resource.ref,
        contentDigest: resource.contentDigest,
        schemaDigest: resource.schemaDigest,
        nativeCrs: resource.nativeCrs,
        featureCount: resource.featureCount,
        authorization: resource.authorization,
      }],
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
      limitations: [
        'the registered copy is immutable: re-registering changed source bytes publishes a new version',
        'only Point/LineString/Polygon layers are display-supported; Multi* geometries analyze but are refused at map_add_layer',
      ],
      meta,
    }
  },
})

/** `catalog_resolve`: resolve an exact resource or search governed semantic definitions. */
export const catalogResolve = defineTool({
  name: 'catalog_resolve',
  description:
    'Resolve one exact registered resource version (ref `res-…@vN` from catalog_register), or search governed '
    + 'semantic definitions with a business-language query. Resource resolution returns stable feature refs and a '
    + 'RetrievalBundle; semantic search returns bounded, exact-version definition candidates.',
  parameters: {
    resource: { type: 'string', description: 'Exact resource ref, `res-…@vN`.' },
    query: { type: 'string', description: 'Business-language query matched against semantic canonical names and aliases.' },
    applicability: { type: 'string', description: 'Optional applicability text filter for semantic search.' },
    limit: { type: 'number', description: 'Semantic candidate limit, from 1 to 32.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCatalogJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { resource, query, applicability, limit } = args as { resource?: string; query?: string; applicability?: string; limit?: number }
    const catalog = catalogServiceOf(exec)
    if ((resource === undefined) === (query === undefined)) {
      throw new SpatialError('INVALID_ARGUMENT', 'catalog_resolve requires exactly one of resource or query')
    }
    if (query !== undefined) {
      const result = await catalog.searchSemanticDefinitions({
        query,
        authorization: catalog.deploymentDomain(),
        ...(applicability === undefined ? {} : { applicability }),
        ...(limit === undefined ? {} : { limit }),
      })
      const meta: JsonValue = buildCatalogResultMeta({ operation: 'resolve', resources: [] })
      return {
        status: 'succeeded',
        query: result.query,
        semantic_definitions: JSON.parse(JSON.stringify(result.candidates)) as JsonValue,
        total: result.total,
        meta,
      }
    }
    if (resource === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'catalog_resolve requires a resource ref')
    }
    const resolved = await catalog.resolve({ ref: resource, authorization: catalog.deploymentDomain() })
    const { resource: version, schema, featureRefs, totalFeatureRefs, bundle } = resolved
    const meta: JsonValue = buildCatalogResultMeta({
      operation: 'resolve',
      resources: [catalogResultResourceOf(version)],
    })
    return {
      status: 'succeeded',
      resource: catalogResultResourceOf(version),
      schema: {
        fields: schema.fields.map(field => ({ name: field.name, type: field.type })),
        geometryTypes: [...schema.geometryTypes],
        feature_count: schema.featureCount,
      },
      feature_refs: featureRefs.slice(0, 64).map(entry => ({
        feature_ref: entry.featureRef,
        original_id: entry.originalId,
        feature_index: entry.featureIndex,
      })),
      total_feature_refs: totalFeatureRefs,
      ...(resolved.semanticDefinitions.length === 0
        ? {}
        : { semantic_definitions: JSON.parse(JSON.stringify(resolved.semanticDefinitions)) as JsonValue }),
      // Plain-JSON projection of the frozen bundle (the record type is an
      // interface, which carries no implicit index signature for JsonValue).
      bundle: JSON.parse(JSON.stringify(bundle)) as JsonValue,
      meta,
    }
  },
})

/** The frozen presentation record one resource version projects into catalog results. */
function catalogResultResourceOf(version: {
  ref: string
  contentDigest: string
  schemaDigest: string
  nativeCrs: string
  featureCount: number
  authorization: string
}): CatalogResultResource {
  return {
    ref: version.ref,
    contentDigest: version.contentDigest,
    schemaDigest: version.schemaDigest,
    nativeCrs: version.nativeCrs,
    featureCount: version.featureCount,
    authorization: version.authorization,
  }
}

/**
 * `map_save`: the explicit cross-storage save. Order is fixed: confirm the
 * artifact/catalog bytes the current layers cite, then flush the session
 * prefix fixed at call time. The receipt covers only that fixed prefix —
 * never the save result itself — and reports file, catalog, and flush stages
 * independently instead of claiming cross-storage atomicity.
 */
export const mapSave = defineTool({
  name: 'map_save',
  description:
    'Durably save the current session\'s map: confirm the referenced resource/artifact bytes in the map store, '
    + 'then checkpoint the accepted session prefix. Returns a receipt with the covered sequence, the map revision, '
    + 'and each storage stage\'s independent status.',
  parameters: {
    map_revision: { type: 'number', description: 'Expected current map revision; a mismatch refuses the save before any I/O.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderCatalogJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { map_revision: mapRevision } = args as { map_revision?: number }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const catalog = catalogServiceOf(exec)
    const sessions = exec.agent?.ctx.get('sessions') as { flush(session: Session): Promise<boolean> } | undefined
    if (sessions === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'session store service is unavailable in this process')

    const state: MapProjectionState = service.stateOf(session)
    if (mapRevision !== undefined && mapRevision !== state.revision) {
      throw new SpatialError('INVALID_ARGUMENT', `map_revision ${mapRevision} does not match the current revision ${state.revision}`)
    }
    // Fix the accepted prefix: everything appended through this call's own
    // tool/call. The save's own result appends later and is never covered.
    const durableThroughSeq = session.seq - 1
    if (!Number.isInteger(durableThroughSeq) || durableThroughSeq < 0) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the session log has no accepted prefix to save')
    }

    const citedRefs = [
      ...new Set(state.layers.flatMap(layer => [layer.artifactRef, layer.resourceRef].filter(ref => typeof ref === 'string'))),
    ]
    const confirmations = citedRefs.length > 0 ? await catalog.confirmDurability(citedRefs) : []
    const failed = confirmations.filter(entry => entry.status !== 'ok')
    if (failed.length > 0) {
      const recalled = failed.filter(entry => entry.status === 'recalled')
      const governed = failed.filter(entry => entry.status === 'revoked' || entry.status === 'tombstoned')
      // Revoked/tombstoned citations carry the copy-limit note; recalled
      // citations carry the recall boundary sentence instead — the two
      // governed refusals never share a promise.
      const notes: string[] = []
      if (governed.length > 0) {
        notes.push(`${governed.map(entry => `${entry.ref} is ${entry.status}`).join(', ')} — ${COPY_LIMIT_NOTE}`)
      }
      if (recalled.length > 0) {
        notes.push(`${recalled.map(entry => `${entry.ref} is recalled`).join(', ')} — ${RECALL_NOTE}`)
      }
      const governanceNote = notes.length > 0 ? `; ${notes.join('; ')}` : ''
      return saveFailure(exec, {
        durableThroughSeq,
        revision: state.revision,
        artifactStage: 'failed',
        sessionFlush: 'not-performed',
        confirmedRefs: confirmations.map(entry => `${entry.ref}:${entry.status}`),
        reason: `store objects not durable: ${failed.map(entry => `${entry.ref} (${entry.status})`).join(', ')}${governanceNote}`,
      })
    }

    let flushed: boolean
    try {
      flushed = await sessions.flush(session)
    } catch (error: unknown) {
      return saveFailure(exec, {
        durableThroughSeq,
        revision: state.revision,
        artifactStage: citedRefs.length > 0 ? 'confirmed' : 'not-checked',
        sessionFlush: 'failed',
        confirmedRefs: confirmations.map(entry => `${entry.ref}:${entry.status}`),
        reason: `session flush failed; the accepted state is preserved (${String(error instanceof Error ? error.message : error)})`,
      })
    }
    if (!flushed) {
      return saveFailure(exec, {
        durableThroughSeq,
        revision: state.revision,
        artifactStage: citedRefs.length > 0 ? 'confirmed' : 'not-checked',
        sessionFlush: 'failed',
        confirmedRefs: confirmations.map(entry => `${entry.ref}:${entry.status}`),
        reason: 'no persistence provider is enabled for this session; the accepted state is preserved',
      })
    }
    // The flushed checkpoint is a durable export of the cited bytes;
    // register one export copy per cited object so a later recall can name
    // this address. Registration is idempotent per holder, so repeated
    // saves of the same prefix stay one address.
    const citedKinds = new Map<string, 'artifact' | 'resource'>()
    for (const layer of state.layers) {
      if (layer.artifactRef !== undefined) citedKinds.set(layer.artifactRef, 'artifact')
      else if (layer.resourceRef !== undefined) citedKinds.set(layer.resourceRef, 'resource')
    }
    for (const [citedRef, objectKind] of citedKinds) {
      await catalog.registerCopy({
        objectKind,
        ref: citedRef,
        channel: 'export',
        holder: `checkpoint:${durableThroughSeq}`,
        sessionId: session.id,
      })
    }
    const meta: JsonValue = buildMapSaveReceiptMeta({
      durableThroughSeq,
      revision: state.revision,
      artifactStage: citedRefs.length > 0 ? 'confirmed' : 'not-checked',
      sessionFlush: 'confirmed',
      confirmedRefs: confirmations.map(entry => entry.ref),
    })
    return {
      saved: true,
      durable_through_seq: durableThroughSeq,
      revision: state.revision,
      artifact_stage: citedRefs.length > 0 ? 'confirmed' : 'not-checked',
      session_flush: 'confirmed',
      confirmed_refs: confirmations.map(entry => entry.ref),
      meta,
    }
  },
})

/** Build the failure receipt a non-throwing save failure returns. */
function saveFailure(
  exec: ToolRunContext,
  receipt: {
    durableThroughSeq: number
    revision: number
    artifactStage: MapSaveStageStatus
    sessionFlush: MapSaveStageStatus
    confirmedRefs: string[]
    reason: string
  },
): {
  saved: boolean
  reason: string
  durable_through_seq: number
  revision: number
  artifact_stage: MapSaveStageStatus
  session_flush: MapSaveStageStatus
  confirmed_refs: string[]
  meta: JsonValue
} {
  exec.signal.throwIfAborted()
  const meta: JsonValue = buildMapSaveReceiptMeta({
    durableThroughSeq: receipt.durableThroughSeq,
    revision: receipt.revision,
    artifactStage: receipt.artifactStage,
    sessionFlush: receipt.sessionFlush,
    confirmedRefs: receipt.confirmedRefs,
  })
  return {
    saved: false,
    reason: receipt.reason,
    durable_through_seq: receipt.durableThroughSeq,
    revision: receipt.revision,
    artifact_stage: receipt.artifactStage,
    session_flush: receipt.sessionFlush,
    confirmed_refs: receipt.confirmedRefs,
    meta,
  }
}
