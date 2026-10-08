/**
 * Node-half Cordis plugin (host plane): registers the authoritative
 * `decisionFrame` session projection and provides the `spatialContext`
 * service — the resolved task budget and the frame read face the
 * `decision_update` tool resolves from its execution context.
 *
 * The agent-plane pre-step listener lives on the `./agent` entry and mounts
 * through the map-analyst preset; this host row mounts through the map-web
 * profile patch. Neither face duplicates the other.
 *
 * @module @map-harness/spatial-context
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveBudgetConfig, type BudgetConfig } from './budget.ts'
import { SPATIAL_CONTEXT_PLUGIN_NAME, type SpatialContextState } from './protocol.ts'
import { spatialContextProjectionDefinition } from './projection.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/** Loader config schema: validated task-budget overrides. */
export interface SpatialContextPluginConfig {
  /** Task budget overrides; every field is optional over the defaults. */
  budget?: Partial<BudgetConfig>
}

/** Loader config; validation failures fail the plugin at load. */
export const Config: z<SpatialContextPluginConfig> = z.object({
  budget: z.object({
    maxModelSteps: z.number(),
    maxMetaBytes: z.number(),
    maxContextBytes: z.number(),
    maxScanFeatures: z.number(),
    maxElapsedMs: z.number(),
    maxGapRetries: z.number(),
  }) as unknown as z<Partial<BudgetConfig>>,
})

/** Function-plugin name under the Loader. */
export const name = SPATIAL_CONTEXT_PLUGIN_NAME

/** Required host services: the session-projection registry this unit joins. */
export const inject: string[] = ['sessionProjections']

/** Cordis service name for the spatial-context host face. */
export const SPATIAL_CONTEXT_SERVICE = 'spatialContext'

/**
 * The `ctx.spatialContext` service face: the resolved task budget plus the
 * authoritative frame read for one session.
 */
export interface SpatialContextService {
  /** The resolved task budget (validated overrides over the defaults). */
  readonly budget: BudgetConfig
  /**
   * Read one session's authoritative DecisionFrame state.
   * @param session - the live session whose accepted events are folded.
   * @returns the state, or `undefined` when the projection is not mounted.
   */
  frameOf(session: Session): SpatialContextState | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Map-owned spatial-context face (task budget + frame read). */
    spatialContext: SpatialContextService
  }
}

/**
 * Host plugin body: register the projection and provide the service for the
 * process lifetime.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: SpatialContextPluginConfig): void {
  const budget = resolveBudgetConfig(config.budget)
  const service: SpatialContextService = {
    budget,
    frameOf(session) {
      return ctx.sessionProjections.stateOf(session, 'decisionFrame') as SpatialContextState | undefined
    },
  }
  ctx.effect(() => ctx.sessionProjections.register(spatialContextProjectionDefinition), '@map-harness/spatial-context: projection')
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(SPATIAL_CONTEXT_SERVICE, service)
    return () => {
      void unprovide()
    }
  }, '@map-harness/spatial-context: service')
}
