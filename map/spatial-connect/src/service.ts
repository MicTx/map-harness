/**
 * The `ctx.spatialConnect` service contract: the host-plane face over the
 * declared external connections. The plugin validates every declared
 * connection at load (shape, ids, credential references), resolves each
 * credential once from the environment, and keeps the values in memory for
 * the process lifetime. The service answers connection listings without
 * secrets and runs protocol-level verifications on demand; verifications are
 * stateless exchanges, so disposal needs no quiescence beyond aborting
 * in-flight checks alongside the runtime's own teardown.
 *
 * @module @map-harness/spatial-connect/service
 */
import type { AnyConnectionSpec, ConnectionKind, ConnectionVerification } from './contract.ts'

/** Cordis service name for the external connection plane. */
export const SPATIAL_CONNECT_SERVICE = 'spatialConnect'

/** One connection's listing projection: identity and endpoint shape, never secrets. */
export interface ConnectionSummary {
  /** The configured connection id. */
  readonly id: string
  /** The connection kind. */
  readonly kind: ConnectionKind
  /** Endpoint identity with credential references (names only, never values). */
  readonly endpoint: string
}

/**
 * The `ctx.spatialConnect` service face. Consumers resolve it from the agent
 * context through `ctx.get('spatialConnect')` (host-plane service).
 */
export interface SpatialConnectService {
  /** List the declared connections (ids, kinds, endpoint identities; no secret material). */
  listConnections(): readonly ConnectionSummary[]
  /**
   * Run one protocol-level verification against the named connection.
   * @param id - the configured connection id.
   * @param options - caller cancellation carried into the transport.
   * @returns the verification report; server-side answers are results, never throws for them.
   * @throws when the id is not declared (`CONNECT_UNKNOWN_CONNECTION`) or the caller aborted before the exchange (`CONNECT_ABORTED`).
   */
  verifyConnection(id: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionVerification>
  /** The declared specs keyed by id, for tests and future consumers; never carries credential values. */
  readonly specs: readonly AnyConnectionSpec[]
}
