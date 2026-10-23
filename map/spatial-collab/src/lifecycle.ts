/**
 * The writer lease lifecycle: join, disconnect, reconnect, release, and
 * permission revoke for the writers of one session's collaborative document.
 *
 * The lifecycle contract (spec §3.1 lifecycle row, design §11.3):
 * - `gate()` is the only way to enter a commit segment. It fails loud for an
 *   unknown, disconnected (transport closed), released, revoked, or disposed
 *   writer, and while open it pins the writer's in-flight count.
 * - `disconnect()` closes the transport: new gates refuse immediately, the
 *   identity stays so a reconnect can resume it.
 * - `release()` stops new writes first, then settles only after every
 *   in-flight gate has closed (real quiescence — the returned promise cannot
 *   resolve while a handler still holds a gate), and only then drops the
 *   identity.
 * - `revoke()`/`grant()` flip the write permission; a revoked writer's gates
 *   refuse with `permission_denied`.
 * - `quiesce()` waits for every writer's in-flight gates (plugin disposal
 *   uses it so no handler survives its service).
 *
 * @module @map-harness/spatial-collab/lifecycle
 */

/** Why a gate or lifecycle call failed. */
export type CollabLifecycleCode =
  | 'unknown-writer'
  | 'writer-offline'
  | 'writer-released'
  | 'permission-denied'
  | 'writer-active'
  | 'service-disposed'

/** The named failure every lifecycle call surfaces (never a silent skip). */
export class CollabLifecycleError extends Error {
  readonly code: CollabLifecycleCode
  constructor(code: CollabLifecycleCode, message: string) {
    super(message)
    this.code = code
  }
}

/** One writer's lifecycle state. */
export interface CollabWriterRecord {
  readonly id: string
  /** Human-readable channel label (occurrence/client face), display only. */
  readonly label?: string
  /** `false` after a permission revoke; gates refuse while false. */
  readonly canCommit: boolean
  /** `offline` between disconnect and reconnect; released writers leave the table. */
  readonly status: 'active' | 'offline'
}

/** One open commit gate: closed exactly once by the handler's `finally`. */
export interface CollabGate {
  /** Mark this handler finished; idempotent. */
  close(): void
}

/** The lifecycle face one session's writers live behind. */
export class WriterRegistry {
  private writers = new Map<string, { record: CollabWriterRecord; inFlight: number; closed: Set<() => void> }>()
  /** Writers released while handlers still held gates; kept until quiescent so waits see them. */
  private draining = new Set<{ inFlight: number; closed: Set<() => void> }>()
  /** Ids whose identity was released; gates name them instead of "unknown". */
  private releasedIds = new Set<string>()
  private disposed = false

  /**
   * Register one writer.
   * @param record - the writer identity and initial permission.
   * @returns the stored record.
   */
  join(record: { id: string; label?: string; canCommit?: boolean }): CollabWriterRecord {
    if (this.disposed) throw new CollabLifecycleError('service-disposed', 'the writer registry is disposed')
    const existing = this.writers.get(record.id)
    if (existing !== undefined) {
      throw new CollabLifecycleError('writer-active', `writer ${record.id} is already joined`)
    }
    const stored: CollabWriterRecord = {
      id: record.id,
      ...(record.label === undefined ? {} : { label: record.label }),
      canCommit: record.canCommit ?? true,
      status: 'active',
    }
    this.writers.set(record.id, { record: stored, inFlight: 0, closed: new Set() })
    return stored
  }

  /** Read one writer's record, or `undefined` when unknown/released. */
  writerOf(id: string): CollabWriterRecord | undefined {
    return this.writers.get(id)?.record
  }

  /** Every writer record (release order preserved). */
  list(): readonly CollabWriterRecord[] {
    return [...this.writers.values()].map(entry => entry.record)
  }

  /** Close the transport for one writer; the identity stays for a reconnect. */
  disconnect(id: string): void {
    const entry = this.requireWriter(id)
    entry.record = { ...entry.record, status: 'offline' }
  }

  /** Resume one disconnected writer. */
  reconnect(id: string): CollabWriterRecord {
    const entry = this.requireWriter(id)
    if (entry.record.status !== 'offline') {
      throw new CollabLifecycleError('writer-active', `writer ${id} is not disconnected`)
    }
    entry.record = { ...entry.record, status: 'active' }
    return entry.record
  }

  /** Flip one writer's write permission; both directions are explicit. */
  setPermission(id: string, canCommit: boolean): CollabWriterRecord {
    const entry = this.requireWriter(id)
    entry.record = { ...entry.record, canCommit }
    return entry.record
  }

  /**
   * Release one writer: refuse new gates immediately, wait for every
   * in-flight handler to close, then drop the identity.
   * @param id - the writer to release.
   * @returns a promise settling once the writer is quiescent and removed.
   */
  release(id: string): Promise<void> {
    const entry = this.writers.get(id)
    if (entry === undefined) {
      throw this.releasedIds.has(id)
        ? new CollabLifecycleError('writer-released', `writer ${id} is already released`)
        : new CollabLifecycleError('unknown-writer', `writer ${id} is not joined`)
    }
    this.writers.delete(id)
    this.releasedIds.add(id)
    if (entry.inFlight === 0) return Promise.resolve()
    this.draining.add(entry)
    return new Promise<void>(resolve => {
      entry.closed.add(() => resolve())
    }).then(() => {
      this.draining.delete(entry)
    })
  }

  /**
   * Open one commit gate for a writer — the only entry into a commit
   * segment. The caller MUST close the gate in a `finally`.
   * @param id - the writer committing.
   * @returns the gate to close when the handler settles.
   */
  gate(id: string): CollabGate {
    const entry = this.writers.get(id)
    if (entry === undefined) {
      if (this.disposed) throw new CollabLifecycleError('service-disposed', 'the writer registry is disposed')
      if (this.releasedIds.has(id)) throw new CollabLifecycleError('writer-released', `writer ${id} was released`)
      throw new CollabLifecycleError('unknown-writer', `writer ${id} is not joined`)
    }
    if (entry.record.status === 'offline') {
      throw new CollabLifecycleError('writer-offline', `writer ${id} is disconnected; reconnect before writing`)
    }
    if (!entry.record.canCommit) {
      throw new CollabLifecycleError('permission-denied', `writer ${id} lost write permission`)
    }
    entry.inFlight += 1
    let open = true
    return {
      close: () => {
        if (!open) return
        open = false
        entry.inFlight -= 1
        if (entry.inFlight === 0 && entry.closed.size > 0) {
          for (const resolve of entry.closed) resolve()
          entry.closed.clear()
        }
      },
    }
  }

  /** Wait until no writer holds an in-flight gate, including draining releases. */
  quiesce(): Promise<void> {
    const pending = [
      ...[...this.writers.values()].filter(entry => entry.inFlight > 0),
      ...this.draining,
    ]
    if (pending.length === 0) return Promise.resolve()
    return Promise.all(pending.map(entry => new Promise<void>(resolve => {
      entry.closed.add(() => resolve())
    }))).then(() => undefined)
  }

  /** Drop every writer (after quiescence for release-safety semantics). */
  dispose(): Promise<void> {
    this.disposed = true
    return this.quiesce().then(() => {
      this.writers.clear()
      this.draining.clear()
    })
  }

  /** Whether the registry refuses new work. */
  get isDisposed(): boolean {
    return this.disposed
  }

  private requireWriter(id: string): { record: CollabWriterRecord; inFlight: number; closed: Set<() => void> } {
    const entry = this.writers.get(id)
    if (entry === undefined) throw new CollabLifecycleError('unknown-writer', `writer ${id} is not joined`)
    return entry
  }
}
