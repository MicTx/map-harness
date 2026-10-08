/**
 * Node-half Cordis plugin: registers the `mapContainer` session projection —
 * the authoritative map state — and provides `ctx.map` as the projection's
 * read face for the map tools. The browser half ships through
 * `exports["./client"]`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MAP_CONTAINER_SERVICE, type MapContainerService } from './service.ts'
import { mapContainerProjectionDefinition } from './projection.ts'

/** Plugin config; the container needs no deployment-varying fields this round. */
export interface MapPluginConfig {}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/map-container'

/** Required host services: the projection registry this unit registers on and reads through. */
export const inject: string[] = ['sessionProjections']

/**
 * Host plugin body: register the authoritative projection unit and provide
 * its read face for the process lifetime.
 * @param ctx - the host root context receiving the service.
 */
export function apply(ctx: Context): void {
  const service: MapContainerService = {
    stateOf(session) {
      const state = ctx.sessionProjections.stateOf(session, 'mapContainer')
      if (state === undefined) {
        throw new Error('mapContainer projection is not registered in this process')
      }
      return state
    },
    pendingCallOf(session, callId) {
      return service.stateOf(session).pendingCalls.find(pending => pending.callId === callId)
    },
  }
  const dispose = ctx.reflect.provide(MAP_CONTAINER_SERVICE, service)
  ctx.effect(() => () => { void dispose() }, '@map-harness/map-container: service')
  ctx.effect(() => ctx.sessionProjections.register(mapContainerProjectionDefinition), '@map-harness/map-container: projection')
}
