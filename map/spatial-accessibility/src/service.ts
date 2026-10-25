/**
 * The `ctx.spatialAccessibility` service contract: the host-plane face over
 * the durable run store that the model-facing run tools resolve from their
 * execution context. The service owns one open store, one worker epoch, and
 * the in-process worker lifecycle; disposal waits for real worker quiescence.
 *
 * @module @map-harness/spatial-accessibility/service
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { RunId, RunOperationRef } from './contract.ts'
import type {
  AccessibilityRunRecord,
  AccessibilityRunService,
  RunSubmitResult,
} from './runs.ts'
import type { PendingRunCall } from './projection.ts'

/** Cordis service name for the accessibility run service. */
export const SPATIAL_ACCESSIBILITY_SERVICE = 'spatialAccessibility'

/** The data one submit consumes alongside its spec (resolved from catalog bytes). */
export interface RunInputData {
  readonly population: readonly { readonly id: string; readonly coordinates: readonly [number, number]; readonly population: number; readonly community?: string }[]
  readonly facilities: readonly { readonly id: string; readonly coordinates: readonly [number, number]; readonly capacity?: number; readonly entrance?: readonly [number, number] }[]
}

/**
 * The `ctx.spatialAccessibility` service face. Tools resolve it from the
 * agent context through `ctx.get('spatialAccessibility')` (host-plane service).
 */
export interface SpatialAccessibilityService {
  /**
   * Validate, persist, and start one accessibility run. The run row is
   * durable before the worker starts; the same operationRef with the same
   * digest deduplicates, a different digest conflicts.
   */
  submit(input: {
    readonly operationRef: RunOperationRef
    readonly spec: RunSubmitSpecInput
    readonly data: RunInputData
  }): Promise<RunSubmitResult>
  /** Read one run without re-executing anything. */
  get(runId: string): AccessibilityRunRecord
  /** Request cancellation; the worker/provider adjudicates the terminal state. */
  cancel(runId: string): AccessibilityRunRecord
  /** Look up a run by its operation identity, or `undefined` (the retryOf path). */
  lookupByOperationRef(operationRef: RunOperationRef): AccessibilityRunRecord | undefined
  /**
   * Resolve the accepted run_submit `tool/call` this execution pairs with —
   * the trusted `sourceCallSeq` the operationRef cites.
   * @param session - the live session that accepted the call.
   * @param callId - the ToolRuntime call id of the executing call.
   * @returns the pending run-submit entry, or `undefined`.
   */
  pendingRunCallOf(session: Session, callId: string): PendingRunCall | undefined
  /** Wait for every live worker to settle; used by disposal and tests. */
  quiesce(): Promise<void>
  /** The underlying run service (worker registry), exposed for lifecycle owners. */
  readonly runs: AccessibilityRunService
}

/**
 * The spec shape submit accepts: the caller composes the network version and
 * method version at submit time (the provider identity is derived from the
 * support extent), so these two fields are optional here and filled by the
 * service.
 */
export type RunSubmitSpecInput = Omit<import('./contract.ts').AccessibilitySpec, 'networkRef' | 'methodVersion'> & {
  readonly networkRef?: string
  readonly methodVersion?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Map-owned accessibility run service (host-plane service). */
    spatialAccessibility: SpatialAccessibilityService
  }
}

/** Re-export the run id type for service consumers. */
export type { RunId }
