/**
 * Public entry of `@map-harness/stream-providers`: the versioned
 * `stream-providers@1` contract, the cc-switch by-name credential resolver,
 * the real source readers (SSE and OpenAI-compatible completions relay),
 * the deterministic multi-source fusion engine, the program-side error
 * codes, and the host plugin (`name`/`inject`/`apply`/`Config`) that
 * validates deployment configuration and provides the `streamProviders`
 * service for the process lifetime.
 *
 * @module @map-harness/stream-providers
 */
export * from './contract.ts'
export * from './errors.ts'
export * from './credentials.ts'
export * from './reader.ts'
export * from './sse.ts'
export * from './completions.ts'
export * from './fusion.ts'
export * from './service.ts'
export { name, inject, apply, Config, resolveStreamRegistry, buildStreamProvidersService } from './plugin.ts'
export type { StreamProvidersPluginConfig, StreamProviderRegistry, ServiceRuntime } from './plugin.ts'
