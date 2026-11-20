/**
 * Host-only materialization APIs; bindings and image results are not wire DTOs.
 * @module @map-harness/map-container/source-service-protocol
 */
import type { BasemapSource, BasemapSourceId } from '@map-harness/map-layers'
import type { SourceCatalogFailureCode } from './source-error.ts'
import type { SourceMapServerInfo } from './source-mapserver.ts'
import type { SourceResourceView, ResolvedNativeSource } from './source-resource.ts'
import type { SourceRuntimeEpoch, NativeSourceEpoch, PublicSourcePresetId, SourceImageMime } from './source-render-protocol.ts'
import type { WmtsMetadata } from './source-wmts.ts'
import type { MapSourceCatalog } from './sources.ts'
import type { WaybackCoverage, WaybackViewport } from './wayback.ts'

/** A fixed known key-free endpoint; browser SDK loading does not require Node metadata. */
export interface PublicSourceRuntimeBinding {
  readonly transport: 'public-preset'
  readonly runtimeEpoch: SourceRuntimeEpoch
  readonly nativeEpoch: NativeSourceEpoch
  readonly source: BasemapSource
  readonly presetId: PublicSourcePresetId
}

/** Private deployment data; route/SDK adapters must publish only reconstructed fields. */
export interface ControlledSourceRuntimeBinding {
  readonly transport: 'controlled'
  readonly runtimeEpoch: SourceRuntimeEpoch
  readonly nativeEpoch: NativeSourceEpoch
  readonly source: BasemapSource
  readonly native: ResolvedNativeSource
}

/** Host-owned native materialization, without any session selection state. */
export type SourceRuntimeBinding = PublicSourceRuntimeBinding | ControlledSourceRuntimeBinding

/** Private output; routes explicitly convert metadata or write admitted image bytes. */
export type SourceResourceResult =
  | { readonly kind: 'arcgis-metadata'; readonly metadata: SourceMapServerInfo }
  | { readonly kind: 'wmts-metadata'; readonly metadata: WmtsMetadata; readonly source: BasemapSource }
  | {
    readonly kind: 'image'
    /** Response-owned copy; mutating it cannot alter retained cache bytes. */
    readonly body: Buffer
    readonly contentType: SourceImageMime
    /** Derived only from opaque scope and admitted representation bytes. */
    readonly etag: string
    readonly cacheControl: string
  }

/** Latest controlled transport result, not deployment availability or SDK rendered health. */
export type SourceTransportHealth =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'reachable' }
  | { readonly kind: 'failed'; readonly code: SourceCatalogFailureCode }

/** One activation's transport/native state; session permission and selection remain external. */
export interface MapSourceService {
  readonly catalog: MapSourceCatalog
  readonly runtimeEpoch: SourceRuntimeEpoch
  /** Resolve a fixed historical release against the live official catalog. */
  waybackRelease(releaseId: number, signal?: AbortSignal): Promise<BasemapSource>
  /** Read bounded historical releases for a model or UI catalog. */
  waybackCatalog(query?: { readonly cursor?: string; readonly pageSize?: number }, signal?: AbortSignal): Promise<unknown>
  /** Read point-scoped local historical releases and acquisition evidence. */
  waybackLocal(point: { readonly lon: number; readonly lat: number }, zoom: number, signal?: AbortSignal): Promise<unknown>
  /** Read acquisition metadata for one fixed historical release. */
  waybackMetadata(point: { readonly lon: number; readonly lat: number }, zoom: number, releaseId: number, signal?: AbortSignal): Promise<unknown>
  /**
   * Sample one fixed release at the requested view center and corners.
   * @param viewport - current view coordinates and their WKID.
   * @param zoom - current map zoom.
   * @param releaseId - official fixed release number.
   * @param signal - optional cancellation signal.
   * @returns point evidence without a full-extent coverage claim.
   */
  waybackCoverage(
    viewport: WaybackViewport,
    zoom: number,
    releaseId: number,
    signal?: AbortSignal,
  ): Promise<WaybackCoverage>
  /** Deadline for one complete Wayback catalog or local-evidence request. */
  readonly waybackRequestTimeoutMs: number
  /**
   * Verify the full current descriptor, including grants, without any network I/O.
   * @param source - admitted public snapshot, which may be stale or forged semantically.
   * @returns normally only for an available exact catalog descriptor; Wayback requires a fresh cached official catalog and otherwise throws a safe source error.
   */
  verifySource(source: BasemapSource): void
  /**
   * Materialize native geometry; cached definitions do not imply live service reachability.
   * @param source - exact current public descriptor.
   * @param signal - caller cancellation; omission still enforces the service deadline.
   * @returns host-only binding; failures leave session selection unchanged.
   */
  prepare(source: BasemapSource, signal?: AbortSignal): Promise<SourceRuntimeBinding>
  /**
   * Compile and read one current native resource, with the deadline including queue wait.
   * @param source - exact current public descriptor.
   * @param nativeEpoch - previously admitted geometry; stale epochs never rematerialize silently.
   * @param view - actual SDK engine WKID, copied at admission.
   * @param query - closed native request fields, copied at admission.
   * @param signal - caller cancellation; omission still enforces the service deadline.
   * @returns host-only typed metadata or admitted image bytes; never stale recovery.
   */
  resource(source: BasemapSource, nativeEpoch: NativeSourceEpoch, view: SourceResourceView, query: URLSearchParams, signal?: AbortSignal): Promise<SourceResourceResult>
  /**
   * Read the latest transport fact; unknown ids never allocate state.
   * @param sourceId - configured source id or an absent branded id.
   * @returns unknown until a completed controlled transport result; unknown after disposal.
   */
  healthOf(sourceId: BasemapSourceId): SourceTransportHealth
  /**
   * Cancel retained work, close transport and clear derived state; repeated calls do nothing.
   * @returns immediately; late native completions cannot mutate disposed state.
   */
  dispose(): void | Promise<void>
}
