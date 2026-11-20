/**
 * Cordis plugin (host plane): the deployment's real stream source and
 * fusion configuration surface. Two blocks declare the plane — `sources`
 * (SSE feeds and OpenAI-compatible completions relays) and `fusions` (2..8
 * bound sources behind one fused horizon) — and every declaration is
 * validated at load: id shape and global uniqueness across kinds, URL and
 * model bounds, bounded deadlines and budgets, the total source and fusion
 * counts, and every fusion's source ids must resolve to declared sources.
 * Credential *references* are grammar-checked at load (`cc-switch:<name>`);
 * their *values* resolve at the execution round that opens a source — the
 * cc-switch store is the rotation point, so a load-time snapshot would go
 * stale — and live only in the reader's memory. Values never enter config
 * defaults, logs, error text, or summaries. Plugin disposal closes every
 * open fusion engine quiescently; nothing outlives the host.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AnyStreamSourceSpec, CompletionsSourceSpec, SseSourceSpec, StreamFusionSpec, StreamSourceVerification } from './contract.ts'
import {
  completionsSpecProblem,
  credentialRefProblem,
  fusionSpecProblem,
  MAX_FUSIONS,
  MAX_SOURCES,
  sseSpecProblem,
  streamIdProblem,
} from './contract.ts'
import { resolveCredentialRef } from './credentials.ts'
import { StreamFusionEngine, type FusionAdvanceReport, type FusionReader } from './fusion.ts'
import { SseSourceReader } from './sse.ts'
import { CompletionsSourceReader } from './completions.ts'
import { StreamProvidersError } from './errors.ts'
import {
  credentialOutcome,
  sanitizeDetail,
  STREAM_PROVIDERS_SERVICE,
  type StreamFusionSummary,
  type StreamProvidersService,
  type StreamServiceOptions,
  type StreamSourceSummary,
} from './service.ts'

/** Plugin config for the source and fusion blocks. */
export interface StreamProvidersPluginConfig {
  /** Declared sources, both families, ids global across kinds. */
  readonly sources?: ReadonlyArray<{
    id: string
    kind: 'sse' | 'completions'
    url: string
    model?: string
    /** By-name credential reference (`cc-switch:<name>`); sse may omit it. */
    credentialRef?: string
    prompt?: string
    eventTimeBaseMs?: number
    maxTokens?: number
    timeoutMs?: number
    maxEventsPerFetch?: number
    maxLineBytes?: number
  }>
  /** Declared fusions; each binds 2..8 declared source ids. */
  readonly fusions?: ReadonlyArray<{
    id: string
    sources: string[]
    pendingCapacity?: number
    maxEventsPerRelease?: number
  }>
  /** cc-switch store path override (default `<home>/.cc-switch/cc-switch.db`). */
  readonly ccSwitchDb?: string
}

/** Loader config schema; validation failures fail the plugin at load. */
export const Config = z.object({
  sources: z.array(z.object({
    id: z.string().required(),
    kind: z.union(['sse', 'completions']).required(),
    url: z.string().required(),
    model: z.string(),
    credentialRef: z.string().role('credential-ref'),
    prompt: z.string(),
    eventTimeBaseMs: z.number().min(0),
    maxTokens: z.number().min(256).max(8192),
    timeoutMs: z.number().min(1000).max(60000),
    maxEventsPerFetch: z.number().min(1).max(1024),
    maxLineBytes: z.number().min(1024).max(1048576),
  })),
  fusions: z.array(z.object({
    id: z.string().required(),
    sources: z.array(z.string()).required(),
    pendingCapacity: z.number().min(1).max(4096),
    maxEventsPerRelease: z.number().min(1).max(4096),
  })),
  ccSwitchDb: z.string(),
})

/** One declared source with its spec validated at load. */
export interface ResolvedStreamSource {
  readonly spec: AnyStreamSourceSpec
}

/** The registry the plugin builds from config: sources and fusions by id. */
export interface StreamProviderRegistry {
  readonly sources: ReadonlyMap<string, ResolvedStreamSource>
  readonly fusions: ReadonlyMap<string, StreamFusionSpec>
  /** cc-switch store path the execution-round resolver uses. */
  readonly ccSwitchDb: string | undefined
}

/**
 * Build the validated registry from config. Exported for the service
 * tests; the plugin is the only production caller.
 * @param config - validated plugin config.
 * @returns the registry with sources and fusions keyed by id.
 * @throws StreamProvidersError with `STREAM_PROVIDERS_CONFIG_INVALID` on any
 * invalid declaration, duplicate id, count breach, or dangling fusion
 * source reference.
 */
export function resolveStreamRegistry(config: StreamProvidersPluginConfig): StreamProviderRegistry {
  const sources = new Map<string, ResolvedStreamSource>()
  for (const declared of config.sources ?? []) {
    const idProblem = streamIdProblem(declared.id)
    if (idProblem !== undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', idProblem)
    }
    if (sources.has(declared.id)) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `source id ${declared.id} is declared more than once; ids are global across kinds`)
    }
    if (sources.size >= MAX_SOURCES) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `at most ${String(MAX_SOURCES)} sources may be declared`)
    }
    if (declared.credentialRef !== undefined) {
      const refProblem = credentialRefProblem(declared.credentialRef)
      if (refProblem !== undefined) {
        throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `source ${declared.id}: ${refProblem}`)
      }
    }
    const spec: AnyStreamSourceSpec = declared.kind === 'sse'
      ? {
          id: declared.id,
          kind: 'sse',
          url: declared.url,
          ...(declared.credentialRef === undefined ? {} : { credentialRef: declared.credentialRef }),
          ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
          ...(declared.maxEventsPerFetch === undefined ? {} : { maxEventsPerFetch: declared.maxEventsPerFetch }),
          ...(declared.maxLineBytes === undefined ? {} : { maxLineBytes: declared.maxLineBytes }),
        } satisfies SseSourceSpec
      : {
          id: declared.id,
          kind: 'completions',
          url: declared.url,
          model: declared.model ?? '',
          credentialRef: declared.credentialRef ?? '',
          ...(declared.prompt === undefined ? {} : { prompt: declared.prompt }),
          ...(declared.eventTimeBaseMs === undefined ? {} : { eventTimeBaseMs: declared.eventTimeBaseMs }),
          ...(declared.maxTokens === undefined ? {} : { maxTokens: declared.maxTokens }),
          ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
          ...(declared.maxEventsPerFetch === undefined ? {} : { maxEventsPerFetch: declared.maxEventsPerFetch }),
          ...(declared.maxLineBytes === undefined ? {} : { maxLineBytes: declared.maxLineBytes }),
        } satisfies CompletionsSourceSpec
    const problem = spec.kind === 'sse' ? sseSpecProblem(spec) : completionsSpecProblem(spec)
    if (problem !== undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `source ${declared.id}: ${problem}`)
    }
    sources.set(declared.id, { spec })
  }

  const fusions = new Map<string, StreamFusionSpec>()
  for (const declared of config.fusions ?? []) {
    const idProblem = streamIdProblem(declared.id)
    if (idProblem !== undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', idProblem)
    }
    if (fusions.has(declared.id)) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `fusion id ${declared.id} is declared more than once`)
    }
    if (fusions.size >= MAX_FUSIONS) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `at most ${String(MAX_FUSIONS)} fusions may be declared`)
    }
    const spec: StreamFusionSpec = {
      id: declared.id,
      sources: [...declared.sources],
      ...(declared.pendingCapacity === undefined ? {} : { pendingCapacity: declared.pendingCapacity }),
      ...(declared.maxEventsPerRelease === undefined ? {} : { maxEventsPerRelease: declared.maxEventsPerRelease }),
    }
    const problem = fusionSpecProblem(spec, new Set(sources.keys()))
    if (problem !== undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `fusion ${declared.id}: ${problem}`)
    }
    fusions.set(declared.id, spec)
  }
  return { sources, fusions, ccSwitchDb: config.ccSwitchDb }
}

/** The cc-switch store options one execution-round resolution carries. */
function storeOptions(registry: StreamProviderRegistry): { dbPath?: string } {
  return registry.ccSwitchDb === undefined ? {} : { dbPath: registry.ccSwitchDb }
}

/** Construct one reader for a declared source; credentials resolve lazily at first read. */
function buildReader(spec: AnyStreamSourceSpec, registry: StreamProviderRegistry): FusionReader {
  const resolveAtRound = (): string | undefined =>
    resolveCredentialRef((spec as { credentialRef?: string }).credentialRef ?? '', storeOptions(registry))
  if (spec.kind === 'sse') {
    return new SseSourceReader(spec, spec.credentialRef === undefined ? () => undefined : resolveAtRound)
  }
  return new CompletionsSourceReader(spec, () => resolveCredentialRef(spec.credentialRef, storeOptions(registry)))
}

/** Open fusion bookkeeping the service owns. */
interface OpenFusion {
  readonly engine: StreamFusionEngine
}

/** Service runtime the plugin and the tests construct. */
export interface ServiceRuntime {
  readonly service: StreamProvidersService
  /** Close every open fusion quiescently; the plugin dispose path. */
  closeAll(): Promise<void>
}

/**
 * Build the service face over one validated registry; exported so tests
 * and future hosts construct it without a Cordis context.
 * @param registry - the validated sources and fusions keyed by id.
 * @returns the `streamProviders` service and its disposal hook.
 */
export function buildStreamProvidersService(registry: StreamProviderRegistry): ServiceRuntime {
  const open = new Map<string, OpenFusion>()

  const requireFusionSpec = (id: string): StreamFusionSpec => {
    const spec = registry.fusions.get(id)
    if (spec === undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_UNKNOWN_FUSION', `no declared fusion carries id ${id}; listFusions() names the declared set`)
    }
    return spec
  }

  const requireOpen = (id: string): OpenFusion => {
    const fusion = open.get(id)
    if (fusion === undefined) {
      throw new StreamProvidersError('STREAM_PROVIDERS_STATE', `fusion ${id} is not open; openFusion(${id}) first`)
    }
    return fusion
  }

  const openOrExisting = (id: string): OpenFusion => {
    const existing = open.get(id)
    if (existing !== undefined) return existing
    const spec = requireFusionSpec(id)
    const engine = new StreamFusionEngine(spec, spec.sources.map(sourceId => {
      const source = registry.sources.get(sourceId)
      if (source === undefined) {
        throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `fusion ${id} references source ${sourceId}, which is not declared`)
      }
      return { sourceId, reader: buildReader(source.spec, registry) }
    }))
    const fusion: OpenFusion = { engine }
    open.set(id, fusion)
    return fusion
  }

  const service: StreamProvidersService = {
    specs: [...registry.sources.values()].map(source => source.spec),
    fusionSpecs: [...registry.fusions.values()],
    listSources(): readonly StreamSourceSummary[] {
      return [...registry.sources.values()].map(source => ({
        id: source.spec.id,
        kind: source.spec.kind,
        endpoint: source.spec.url,
        credentialRef: (source.spec as { credentialRef?: string }).credentialRef ?? null,
      }))
    },
    listFusions(): readonly StreamFusionSummary[] {
      return [...registry.fusions.values()].map(spec => {
        const fusion = open.get(spec.id)
        return {
          id: spec.id,
          sources: [...spec.sources],
          perSource: fusion === undefined ? null : fusion.engine.report(),
        }
      })
    },
    async verifySource(id: string, options?: StreamServiceOptions): Promise<StreamSourceVerification> {
      const source = registry.sources.get(id)
      if (source === undefined) {
        throw new StreamProvidersError('STREAM_PROVIDERS_UNKNOWN_SOURCE', `no declared source carries id ${id}; listSources() names the declared set`)
      }
      const startedAt = Date.now()
      const reader = buildReader(source.spec, registry)
      try {
        const round = await reader.readRound(options)
        if (round.failure === undefined) {
          return {
            id: source.spec.id,
            kind: source.spec.kind,
            outcome: round.ended ? 'source-closed' : 'streaming',
            detail: round.ended ? 'the readable side ended cleanly after the verifying read' : 'the channel opened and delivered',
            eventsObserved: round.events.length,
            durationMs: Date.now() - startedAt,
          }
        }
        return {
          id: source.spec.id,
          kind: source.spec.kind,
          outcome: round.failure.outcome,
          detail: sanitizeDetail(round.failure.detail),
          eventsObserved: round.events.length,
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        if (error instanceof StreamProvidersError) {
          // A credential refusal is an answer about the source, not a
          // program failure: it lands on the report by name, never by value.
          const mapped = credentialOutcome(error)
          return {
            id: source.spec.id,
            kind: source.spec.kind,
            outcome: mapped.outcome,
            detail: mapped.detail,
            eventsObserved: 0,
            durationMs: Date.now() - startedAt,
          }
        }
        throw error
      } finally {
        await reader.close().catch(() => undefined)
      }
    },
    async openFusion(id: string): Promise<StreamFusionSummary> {
      const fusion = openOrExisting(id)
      const spec = requireFusionSpec(id)
      return { id, sources: [...spec.sources], perSource: fusion.engine.report() }
    },
    async fusionAdvance(id: string, options?: StreamServiceOptions): Promise<FusionAdvanceReport> {
      requireFusionSpec(id)
      return await requireOpen(id).engine.advance(options)
    },
    pauseSource(fusionId: string, sourceId: string): void {
      const spec = requireFusionSpec(fusionId)
      if (!spec.sources.includes(sourceId)) {
        throw new StreamProvidersError('STREAM_PROVIDERS_UNKNOWN_SOURCE', `fusion ${fusionId} does not bind source ${sourceId}; its declaration names ${spec.sources.join(', ')}`)
      }
      requireOpen(fusionId).engine.pauseSource(sourceId)
    },
    resumeSource(fusionId: string, sourceId: string): void {
      const spec = requireFusionSpec(fusionId)
      if (!spec.sources.includes(sourceId)) {
        throw new StreamProvidersError('STREAM_PROVIDERS_UNKNOWN_SOURCE', `fusion ${fusionId} does not bind source ${sourceId}; its declaration names ${spec.sources.join(', ')}`)
      }
      requireOpen(fusionId).engine.resumeSource(sourceId)
    },
    async closeFusion(id: string): Promise<boolean> {
      const fusion = open.get(id)
      if (fusion === undefined) return false
      open.delete(id)
      await fusion.engine.close()
      return true
    },
  }
  return {
    service,
    async closeAll(): Promise<void> {
      const closing = [...open.values()]
      open.clear()
      await Promise.allSettled(closing.map(fusion => fusion.engine.close()))
    },
  }
}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/stream-providers'

/** No host services are required: the plugin owns config validation and its service only. */
export const inject: string[] = []

/**
 * Host plugin body: validate every declaration, resolve credential
 * references by name at load (values only at execution rounds), provide the
 * service for the process lifetime, and close every open fusion on
 * disposal.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: StreamProvidersPluginConfig): void {
  const registry = resolveStreamRegistry(config)
  const { service, closeAll } = buildStreamProvidersService(registry)

  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(STREAM_PROVIDERS_SERVICE, service)
    return () => {
      void unprovide()
      void closeAll()
    }
  }, '@map-harness/stream-providers: service')
}
