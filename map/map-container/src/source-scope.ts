/**
 * Private representation scope and credential-independent native fingerprints.
 * @module @map-harness/map-container/source-scope
 */
import { createHash } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { BasemapSource } from '@map-harness/map-layers'
import type { SourceImagePlan, ResolvedNativeSource } from './source-resource.ts'
import type { NativeSourceEpoch, SourceRuntimeEpoch } from './source-render-protocol.ts'

/**
 * Identify one image within its activation, native geometry and accepted source.
 * @param runtimeEpoch - opaque credential-scope activation, not a credential hash.
 * @param nativeEpoch - exact admitted native geometry.
 * @param source - current immutable public descriptor.
 * @param plan - compiler-owned canonical URL before credentials are bound.
 * @returns private cache key containing the compiled endpoint; never expose it.
 */
export function sourceImageScopeKey(runtimeEpoch: SourceRuntimeEpoch, nativeEpoch: NativeSourceEpoch, source: BasemapSource, plan: SourceImagePlan): string {
  return JSON.stringify(['map-source-image-v1', runtimeEpoch, nativeEpoch, source.id, source.configDigest, plan.cacheKey])
}

/**
 * Derive a browser validator for an admitted representation in its exact scope.
 * @param scopeKey - private key returned by sourceImageScopeKey.
 * @param body - admitted original image bytes.
 * @returns quoted SHA-256 representation tag; no upstream validators are included.
 */
export function sourceImageEtag(scopeKey: string, body: Buffer): string {
  return `"${createHash('sha256').update(scopeKey, 'utf8').update('\0', 'utf8').update(body).digest('hex')}"`
}

/**
 * Compare admitted native configurations during concurrent materialization.
 * @param native - host-owned native source; resolved endpoints/credentials are excluded.
 * @returns private fingerprint of the adapter and admitted semantic metadata only.
 */
export function nativeSourceFingerprint(native: ResolvedNativeSource): string {
  const adapter = native.adapter
  switch (adapter) {
    case 'xyz':
      return createHash('sha256').update(JSON.stringify({ adapter })).digest('hex')
    case 'arcgis-mapserver':
    case 'wmts':
      return createHash('sha256').update(JSON.stringify({ adapter, metadata: native.metadata })).digest('hex')
    default:
      return assertNever(adapter)
  }
}
