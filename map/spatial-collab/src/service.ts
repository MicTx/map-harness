/**
 * The `spatialCollab` service contract: per-session writer registries the
 * collaboration tools resolve before any commit segment. The service owns
 * only the writer lifecycle (leases, permissions, in-flight quiescence) —
 * the authoritative document state stays the `mapContainer` projection and
 * is never written here.
 */
import type {} from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CollabGate, CollabWriterRecord } from './lifecycle.ts'
import { CollabLifecycleError, WriterRegistry } from './lifecycle.ts'

/** Cordis service name for the collaboration writer lifecycle. */
export const SPATIAL_COLLAB_SERVICE = 'spatialCollab'

/** One writer joining a session's collaboration document. */
export interface CollabWriterDescriptor {
  /** Stable writer id (`[A-Za-z0-9_.:-]`, ≤64 chars) — e.g. `client-rightbar`, `client-field-tablet`. */
  readonly id: string
  /** Display-only channel label. */
  readonly label?: string
  /** Initial write permission; `true` by default. */
  readonly canCommit?: boolean
}

/**
 * The `ctx.spatialCollab` service face. Writers are process-local lease
 * holders: after a host restart every writer rejoins (the document itself
 * recovers from the session log; the audit ledger folds back identically).
 */
export interface SpatialCollabService {
  /**
   * Resolve the writer a commit runs as. An explicit id must already be
   * joined (the operator-console pattern: a call acts for a registered
   * writer); without one, the session's own writer joins lazily.
   * @param session - the live session the document belongs to.
   * @param writerId - the explicit writer id, when the call carries one.
   * @returns the resolved writer record.
   */
  writerFor(session: Session, writerId: string | undefined): CollabWriterRecord
  /**
   * Open the commit gate for one writer — the only entry into a commit
   * segment; the caller closes it in a `finally`.
   * @param session - the live session.
   * @param writerId - the resolved writer id.
   * @returns the gate to close when the handler settles.
   */
  gate(session: Session, writerId: string): CollabGate
  /** Register one writer on the session's document. */
  join(session: Session, descriptor: CollabWriterDescriptor): CollabWriterRecord
  /** Close one writer's transport: new gates refuse; the identity stays for a reconnect. */
  disconnect(session: Session, writerId: string): void
  /** Resume one disconnected writer. */
  reconnect(session: Session, writerId: string): CollabWriterRecord
  /** Flip one writer's write permission; both directions are explicit. */
  setPermission(session: Session, writerId: string, canCommit: boolean): CollabWriterRecord
  /** Release one writer; the promise settles after its in-flight handlers quiesce. */
  release(session: Session, writerId: string): Promise<void>
  /** Every writer record on the session's registry. */
  writersOf(session: Session): readonly CollabWriterRecord[]
  /** Wait until no writer in this process holds an in-flight gate. */
  quiesce(): Promise<void>
}

/** The per-session registry key: sessions identify by their string id. */
function registryKeyOf(session: Session): string {
  return typeof session.id === 'string' ? session.id : String(session.id)
}

/** Build the service implementation over one registry per session. */
export function createSpatialCollabService(): SpatialCollabService {
  const registries = new Map<string, WriterRegistry>()
  const registryOf = (session: Session): WriterRegistry => {
    const key = registryKeyOf(session)
    let registry = registries.get(key)
    if (registry === undefined) {
      registry = new WriterRegistry()
      registries.set(key, registry)
    }
    return registry
  }
  return {
    writerFor(session, writerId) {
      const registry = registryOf(session)
      if (writerId !== undefined) {
        const record = registry.writerOf(writerId)
        if (record === undefined) {
          throw new CollabLifecycleError('unknown-writer', `collab writer "${writerId}" is not joined on this session; join it before committing`)
        }
        return record
      }
      const sessionWriterId = `session:${registryKeyOf(session)}`
      return registry.writerOf(sessionWriterId) ?? registry.join({ id: sessionWriterId, label: 'session-agent' })
    },
    gate(session, writerId) {
      return registryOf(session).gate(writerId)
    },
    join(session, descriptor) {
      return registryOf(session).join(descriptor)
    },
    disconnect(session, writerId) {
      registryOf(session).disconnect(writerId)
    },
    reconnect(session, writerId) {
      return registryOf(session).reconnect(writerId)
    },
    setPermission(session, writerId, canCommit) {
      return registryOf(session).setPermission(writerId, canCommit)
    },
    async release(session, writerId) {
      await registryOf(session).release(writerId)
    },
    writersOf(session) {
      return registryOf(session).list()
    },
    async quiesce() {
      await Promise.all([...registries.values()].map(registry => registry.quiesce()))
    },
  }
}
