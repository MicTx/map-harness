/**
 * Node-half Cordis plugin: registers the `mapContainer` session projection —
 * the authoritative map state — and provides `ctx.map` as the projection's
 * read face for the map tools. The browser half ships through
 * `exports["./client"]`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MAP_CONTAINER_SERVICE, type MapContainerService } from './service.ts'
import { mapContainerProjectionDefinition } from './projection.ts'
import { MAP_OBSERVATION_SERVICE, createMapObservationService, registerObservationRoute } from './observation.ts'
import { registerArtifactRoute, type ArtifactCatalog } from './artifact-route.ts'

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
  // Visual observation: the pending-wait registry plus, when the host
  // Connection is mounted, the client submission route.
  const observation = createMapObservationService()
  const disposeObservation = ctx.reflect.provide(MAP_OBSERVATION_SERVICE, observation)
  ctx.effect(() => () => { void disposeObservation() }, '@map-harness/map-container: observation service')
  // The Connection service may mount or be REPLACED after this plugin (the
  // web host composes it late, and a replaced connection carries a fresh
  // route table). Re-register on every (re)mount: dispose the previous
  // registration first so exactly one live route exists at any time.
  let routeDispose = registerObservationRoute(ctx, observation)
  // Artifact download: the catalog-backed GET route needs BOTH the Connection
  // (registered below) and the spatial catalog service; either may mount or be
  // replaced after this plugin, so re-register on both.
  const registerArtifact = (): (() => Promise<void>) | undefined => {
    const catalog = ctx.get('spatialCatalog', false) as ArtifactCatalog | undefined
    return catalog === undefined ? undefined : registerArtifactRoute(ctx, catalog)
  }
  let artifactDispose = registerArtifact()
  const offListener = ctx.on('internal/service', (name: string, value: unknown) => {
    if (value === undefined) return
    if (name === 'connection') {
      if (routeDispose !== undefined) void routeDispose()
      routeDispose = registerObservationRoute(ctx, observation)
      if (artifactDispose !== undefined) void artifactDispose()
      artifactDispose = registerArtifact()
      return
    }
    if (name === 'spatialCatalog') {
      if (artifactDispose !== undefined) void artifactDispose()
      artifactDispose = registerArtifact()
    }
  })
  ctx.effect(() => () => {
    offListener()
    if (routeDispose !== undefined) void routeDispose()
    if (artifactDispose !== undefined) void artifactDispose()
  }, '@map-harness/map-container: observation route')
}
