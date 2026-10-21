/**
 * Node-half Cordis plugin: provides the `ctx.spatialCollab` writer-lifecycle
 * service. Disposal waits for real writer quiescence — no commit gate stays
 * open past the service's own teardown.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SPATIAL_COLLAB_SERVICE, createSpatialCollabService, type SpatialCollabService } from './service.ts'

/** Plugin config; the writer lifecycle needs no deployment-varying fields. */
export interface SpatialCollabPluginConfig {}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/spatial-collab'

/** Required host services: none — the registry is process-local by design. */
export const inject: string[] = []

/**
 * Host plugin body: provide the writer-lifecycle service for the process
 * lifetime.
 * @param ctx - the host root context receiving the service.
 */
export function apply(ctx: Context): void {
  const service: SpatialCollabService = createSpatialCollabService()
  const dispose = ctx.reflect.provide(SPATIAL_COLLAB_SERVICE, service)
  ctx.effect(() => async () => {
    // Real quiescence first: no writer may still commit after the service closes.
    await service.quiesce()
    void dispose()
  }, '@map-harness/spatial-collab: service')
}
