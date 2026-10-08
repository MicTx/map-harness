/**
 * The agent-plane plugin: the `agent/pre-step` listener that injects the
 * bounded spatial-context snapshot ahead of each admitted model request.
 *
 * Ordering and admission rules (design §5.2, spec §4.4): the listener first
 * calls `next()`; a `reject` decision or an empty first step returns
 * unchanged — a snapshot never starts a request by itself. For a proceeding
 * step it composes the snapshot from the accepted projection state (never
 * expensive GIS work), re-checks the cancellation signal, deduplicates
 * against the model-visible surface, and splices the message right after the
 * claimed batch. The injection state updates only when the loop actually
 * appends the message — the projection folds that fact, never the listener.
 *
 * @module @map-harness/spatial-context/agent
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@map-harness/map-container'
import z from '@deepseek-ai/schemastery'
import { resolveBudgetConfig, type BudgetConfig } from './budget.ts'
import { provisionalFrameOf, SPATIAL_CONTEXT_PLUGIN_NAME, type SpatialContextState } from './protocol.ts'
import { composeSnapshot, isDuplicate, visibleInjectionsOf } from './snapshot.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Spatial-context snapshot producer; its plugin field keeps the producer identity explicit. */
    'spatial-context': {
      kind: 'spatial-context'
      plugin: string
      form: 'snapshot'
      sections: readonly { readonly name: string; readonly text: string }[]
    }
  }
}

/** Loader config schema: validated task-budget overrides. */
export interface SpatialContextAgentConfig {
  /** Task budget overrides; every field is optional over the defaults. */
  budget?: Partial<BudgetConfig>
}

/** Loader config; validation failures fail the plugin at load. */
export const Config: z<SpatialContextAgentConfig> = z.object({
  budget: budgetConfigSchema(),
})

/** Build the schemastery face of the budget overrides. */
function budgetConfigSchema(): z<Partial<BudgetConfig>> {
  return z.object({
    maxModelSteps: z.number(),
    maxMetaBytes: z.number(),
    maxContextBytes: z.number(),
    maxScanFeatures: z.number(),
    maxElapsedMs: z.number(),
    maxGapRetries: z.number(),
  }) as unknown as z<Partial<BudgetConfig>>
}

/** Function-plugin name under the Loader (the preset row cites this). */
export const name = `${SPATIAL_CONTEXT_PLUGIN_NAME}/agent`

/** Required host services: the projection registry the frame state reads from. */
export const inject: string[] = ['sessionProjections']

/**
 * Agent plugin body: register the pre-step listener for this agent scope.
 * @param ctx - the agent-scoped context receiving the listener.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: SpatialContextAgentConfig): void {
  const budget = resolveBudgetConfig(config.budget)
  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    // A rejected step or an empty first entry owns a no-step turn: a spatial
    // snapshot never turns a cleared request into a standalone one.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      return decision
    }
    const state = ctx.sessionProjections.stateOf(agent.session, 'decisionFrame') as SpatialContextState | undefined
    if (state === undefined) return decision
    signal.throwIfAborted()
    const mapState = ctx.sessionProjections.stateOf(agent.session, 'mapContainer') as { revision: number; layers: readonly { id: string; name: string }[] } | undefined
    const visible = visibleInjectionsOf(surfaceSnapshotTexts(agent.session))
    // The claimed batch has not entered the log yet: fold its real user
    // messages as provisional goal candidates for composition only. The
    // persistent contract still changes only via the projection fold.
    const nowMs = Date.now()
    const frame = provisionalFrameOf(state, messages as never, nowMs)
    // The model-context entry: resource candidates are re-checked against
    // the catalog's governance plane at composition time, so a candidate
    // revoked since its resolve is injected with the explicit unavailable
    // marker instead of being presented as usable. The lookup is structural
    // (string service name) so the context unit needs no catalog import; a
    // mounted catalog always provides `refStateOf`. A parallel composer
    // awaits every distinct ref once per request.
    const refAvailability = await refAvailabilityOf(ctx, agent.session, frame)
    const composed = composeSnapshot({
      frame,
      mapRevision: mapState?.revision,
      mapLayerCount: mapState?.layers.length,
      mapLayerNames: (mapState?.layers ?? []).map(layer => layer.name),
      budget,
      nowMs,
      ...(refAvailability === undefined ? {} : { refAvailability }),
    }, visible)
    signal.throwIfAborted()
    if (composed === undefined || isDuplicate(composed, visible)) return decision
    if (state.budget.contextBytes + composed.bytes > budget.maxContextBytes) {
      // The remaining context balance cannot cover this snapshot: refuse the
      // injection instead of truncating authority, units, or limits away.
      return decision
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: composed.text }],
      source: {
        kind: 'spatial-context',
        plugin: SPATIAL_CONTEXT_PLUGIN_NAME,
        form: 'snapshot',
        sections: [{ name: 'spatial-context', text: composed.text }],
      },
    })
    // Fold the snapshot right after the claimed batch so the user request
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, message)
    return { ...decision, messages: entered }
  })
}

/**
 * The structural face of the catalog's governance gate this listener reads.
 * Declared locally so the context unit depends on the service name string,
 * not on the catalog package.
 */
interface CatalogRouter {
  forSession(sessionId: string): { refStateOf(ref: string): Promise<'available' | 'revoked' | 'tombstoned' | 'recalled' | 'unknown'> }
}

/**
 * Resolve one availability lookup over the frame's distinct candidate refs
 * when a catalog unit is mounted in this process; `undefined` when it is
 * not (no catalog candidates can exist without one). The lookup binds the
 * snapshot's own session: every conversation owns its catalog library, so a
 * ref another session published answers `unknown` here without disclosure.
 */
async function refAvailabilityOf(
  ctx: Context,
  session: Session,
  frame: { resources: readonly { ref: string }[] },
): Promise<((ref: string) => 'available' | 'revoked' | 'tombstoned' | 'recalled' | 'unknown') | undefined> {
  const router = (ctx as { get(name: string): unknown }).get('spatialCatalog') as CatalogRouter | undefined
  if (router === undefined || frame.resources.length === 0) return undefined
  const catalog = router.forSession(session.id)
  const refs = [...new Set(frame.resources.map(resource => resource.ref))]
  const states = await Promise.all(refs.map(async ref => [ref, await catalog.refStateOf(ref)] as const))
  const byRef = new Map(states)
  return ref => byRef.get(ref) ?? 'unknown'
}

/**
 * Decode the snapshot texts this plugin authored that are still visible on
 * the model surface. A digest counted here was accepted into a
 * `user/message`; log-only or compacted-away events never appear.
 * @param session - the live session.
 */
function surfaceSnapshotTexts(session: Session): { seq: number; text: string }[] {
  const texts: { seq: number; text: string }[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data.source as { kind: string; plugin?: string }
    if (!((source.kind === 'spatial-context' || source.kind === 'plugin') && source.plugin === SPATIAL_CONTEXT_PLUGIN_NAME)) continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join('\n')
    texts.push({ seq, text })
  }
  return texts
}
