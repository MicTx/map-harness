/**
 * The durable accessibility run store and service: `run_submit` / `run_get` /
 * `run_cancel` over a monotonic-version SQLite store. Submit persists the run
 * (stable runId + operationRef + request digest) before any worker starts;
 * `run_get` never re-executes; `run_cancel` only requests cancellation and
 * the provider-side worker adjudicates the terminal state — a completion that
 * lands after the cancel request finishes as succeeded with the request
 * recorded, a stop at a worker checkpoint finishes as cancelled. Workers run
 * at-least-once with explicit checkpoints (never a Promise timeout); a
 * process restart adjudicates every non-terminal run from a dead worker epoch
 * as `outcomeUnknown` instead of inventing an outcome. Disposal waits for
 * real worker quiescence.
 *
 * @module @map-harness/spatial-accessibility/runs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  newRunId,
  specDigestOf,
  validateAccessibilitySpec,
  type AccessibilitySpec,
  type RunId,
  type RunOperationRef,
} from './contract.ts'
import { AccessibilityError, RunCancelled } from './errors.ts'

/** Monotonic schema version of the run store; the ladder only moves forward. */
export const ACCESSIBILITY_RUN_SCHEMA_VERSION = 1

/** The database file name inside the store root. */
const RUN_DB_NAME = 'accessibility-runs.db'

/** One open run store handle; the owner closes it. */
export interface AccessibilityRunStore {
  readonly root: string
  readonly db: DatabaseSync
  /** Process worker epoch this store instance owns. */
  readonly epoch: number
  close(): void
}

/** Every status the run lifecycle reports. */
export type AccessibilityRunStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelRequested'
  | 'cancelled'
  | 'outcomeUnknown'

/** The terminal statuses; everything else is either live or adjudicated unknown. */
const TERMINAL_STATUSES: readonly AccessibilityRunStatus[] = ['partial', 'succeeded', 'failed', 'cancelled', 'outcomeUnknown']

/** True when one status is terminal. */
export function isTerminalStatus(status: AccessibilityRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** The plain-JSON run record `run_get` returns. */
export interface AccessibilityRunRecord {
  readonly runId: RunId
  readonly operationRef: RunOperationRef
  readonly requestDigest: string
  readonly goalRevision: number
  readonly status: AccessibilityRunStatus
  /** The spec the run was submitted with (present for recovery and stale-run adjudication). */
  readonly spec: AccessibilitySpec
  /** The terminal coverage outcome, when the run finished with one. */
  readonly result: unknown | null
  /** Live diagnostics: cancel requests, worker loss, or failure reasons. */
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
  readonly createdAt: string
  readonly updatedAt: string
}

const runRowSchema = z.object({
  run_id: z.string().min(1),
  operation_ref: z.string().min(1),
  request_digest: z.string().min(1),
  goal_revision: z.number().int().nonnegative(),
  spec_json: z.string().min(1),
  status: z.string().min(1),
  result_json: z.string().nullable(),
  diagnostics_json: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})

/** Decode one store row into the plain-JSON record; corrupted rows fail loud. */
function decodeRow(row: unknown): AccessibilityRunRecord {
  const parsed = runRowSchema.safeParse(row)
  if (!parsed.success) {
    throw new AccessibilityError('ACCESS_STATE', `run row failed to decode: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  }
  const row_ = parsed.data
  let spec: AccessibilitySpec
  try {
    spec = JSON.parse(row_.spec_json) as AccessibilitySpec
  } catch {
    throw new AccessibilityError('ACCESS_STATE', `run ${row_.run_id} carries an unreadable spec`)
  }
  let result: unknown = null
  if (row_.result_json !== null) {
    try {
      result = JSON.parse(row_.result_json)
    } catch {
      throw new AccessibilityError('ACCESS_STATE', `run ${row_.run_id} carries an unreadable result`)
    }
  }
  let diagnostics: { code: string; message: string }[]
  try {
    diagnostics = JSON.parse(row_.diagnostics_json) as { code: string; message: string }[]
  } catch {
    throw new AccessibilityError('ACCESS_STATE', `run ${row_.run_id} carries unreadable diagnostics`)
  }
  return {
    runId: row_.run_id as RunId,
    operationRef: row_.operation_ref as RunOperationRef,
    requestDigest: row_.request_digest,
    goalRevision: row_.goal_revision,
    status: row_.status as AccessibilityRunStatus,
    spec,
    result,
    diagnostics,
    createdAt: row_.created_at,
    updatedAt: row_.updated_at,
  }
}

/**
 * Open (creating when absent) one run store, apply the monotonic schema
 * ladder, and adjudicate the orphaned runs of dead worker epochs.
 * @param root - the store root directory (created when absent).
 * @returns the open store handle.
 * @throws {AccessibilityError} `ACCESS_IO` on open failure, `ACCESS_STATE`
 *   when the database carries a newer schema version than this package knows.
 */
export function openRunStore(root: string): AccessibilityRunStore {
  try {
    mkdirSync(root, { recursive: true })
  } catch (error: unknown) {
    throw new AccessibilityError('ACCESS_IO', `run store root "${root}" could not be created: ${String(error)}`)
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(join(root, RUN_DB_NAME))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
  } catch (error: unknown) {
    throw new AccessibilityError('ACCESS_IO', `run store database could not be opened: ${String(error)}`)
  }
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current > ACCESSIBILITY_RUN_SCHEMA_VERSION) {
    db.close()
    throw new AccessibilityError('ACCESS_STATE', `run store schema version ${current} is newer than this package supports (${ACCESSIBILITY_RUN_SCHEMA_VERSION})`)
  }
  if (current < ACCESSIBILITY_RUN_SCHEMA_VERSION) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accessibility_runs (
        run_id TEXT PRIMARY KEY,
        operation_ref TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        goal_revision INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        diagnostics_json TEXT NOT NULL,
        worker_epoch INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS accessibility_runs_status ON accessibility_runs(status);
      CREATE TABLE IF NOT EXISTS accessibility_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    db.exec(`PRAGMA user_version = ${ACCESSIBILITY_RUN_SCHEMA_VERSION}`)
  }
  // The epoch advances every open: rows still live under an older epoch were
  // owned by a dead process and can never complete.
  const epochRow = db.prepare('SELECT value FROM accessibility_meta WHERE key = \'epoch\'').get()
  const epoch = (epochRow === undefined ? 0 : Number((epochRow as { value: string }).value)) + 1
  if (epochRow === undefined) {
    db.prepare('INSERT INTO accessibility_meta (key, value) VALUES (\'epoch\', ?)').run(String(epoch))
  } else {
    db.prepare('UPDATE accessibility_meta SET value = ? WHERE key = \'epoch\'').run(String(epoch))
  }
  adjudicateOrphans(db, epoch)
  return {
    root,
    db,
    epoch,
    close: () => { db.close() },
  }
}

/** Adjudicate non-terminal runs of dead epochs as outcomeUnknown. */
function adjudicateOrphans(db: DatabaseSync, epoch: number): void {
  const orphans = db.prepare(
    'SELECT run_id FROM accessibility_runs WHERE status IN (\'queued\', \'running\', \'cancelRequested\') AND (worker_epoch IS NULL OR worker_epoch < ?)',
  ).all(epoch)
  const now = new Date().toISOString()
  const update = db.prepare(
    'UPDATE accessibility_runs SET status = \'outcomeUnknown\', diagnostics_json = ?, updated_at = ? WHERE run_id = ?',
  )
  for (const orphan of orphans) {
    const runId = (orphan as { run_id: string }).run_id
    const existing = db.prepare('SELECT diagnostics_json FROM accessibility_runs WHERE run_id = ?').get(runId) as { diagnostics_json: string } | undefined
    let diagnostics: { code: string; message: string }[] = []
    try {
      diagnostics = existing === undefined ? [] : JSON.parse(existing.diagnostics_json) as { code: string; message: string }[]
    } catch {
      diagnostics = []
    }
    diagnostics.push({ code: 'OUTCOME_UNKNOWN', message: `worker epoch ${epoch - 1} died before the run settled; the run cannot claim an outcome` })
    update.run(JSON.stringify(diagnostics), now, runId)
  }
}

/** Sweep helper exposed for recovery tests: rerun the orphan adjudication explicitly. */
export function sweepOrphans(store: AccessibilityRunStore): readonly string[] {
  const orphans = store.db.prepare(
    'SELECT run_id FROM accessibility_runs WHERE status IN (\'queued\', \'running\', \'cancelRequested\') AND (worker_epoch IS NULL OR worker_epoch < ?)',
  ).all(store.epoch)
  adjudicateOrphans(store.db, store.epoch)
  return orphans.map(orphan => (orphan as { run_id: string }).run_id)
}

/** The checkpoint handle a worker's compute receives. */
export interface RunCheckpoints {
  /** Throw `RunCancelled` when a cancel was requested or the caller aborted. */
  throwIfCancelled(): void
}

/** The outcome a compute returns on completion. */
export interface RunOutcome {
  /** The coverage verdict the run finished with. */
  readonly outcome: 'complete' | 'partial' | 'empty'
  /** The plain-JSON evidence record stored with the run. */
  readonly result: unknown
}

/** The compute a run executes; every bounded step ends in a checkpoint. */
export type RunCompute = (checkpoints: RunCheckpoints) => Promise<RunOutcome>

/** One submit request. */
export interface RunSubmitInput {
  /** The operationRef derived from the owning session call. */
  readonly operationRef: RunOperationRef
  /** The spec to run; validated here before anything persists. */
  readonly spec: AccessibilitySpec
  /** The compute factory; invoked only after the run row is durable. */
  readonly buildCompute: (spec: AccessibilitySpec) => RunCompute
}

/** One submit result. */
export interface RunSubmitResult {
  readonly runId: RunId
  readonly operationRef: RunOperationRef
  readonly requestDigest: string
  readonly status: AccessibilityRunStatus
  /** True when an existing run of the same operation + digest was returned. */
  readonly deduplicated: boolean
  /** The deterministic cost estimate computed from the spec extents. */
  readonly estimate: { readonly latticeNodesUpperBound: number; readonly slices: number; readonly maxNodeExpansions: number }
}

/** The internal live row shape (superset of the record). */
interface LiveRow {
  run_id: string
  operation_ref: string
  request_digest: string
  goal_revision: number
  spec_json: string
  status: AccessibilityRunStatus
  result_json: string | null
  diagnostics_json: string
  worker_epoch: number | null
  created_at: string
  updated_at: string
}

/** Append one diagnostic to a run row and stamp the update time. */
function appendDiagnostic(db: DatabaseSync, runId: string, code: string, message: string): void {
  const existing = db.prepare('SELECT diagnostics_json FROM accessibility_runs WHERE run_id = ?').get(runId) as { diagnostics_json: string } | undefined
  let diagnostics: { code: string; message: string }[] = []
  try {
    diagnostics = existing === undefined ? [] : JSON.parse(existing.diagnostics_json) as { code: string; message: string }[]
  } catch {
    diagnostics = []
  }
  diagnostics.push({ code, message })
  db.prepare('UPDATE accessibility_runs SET diagnostics_json = ?, updated_at = ? WHERE run_id = ?')
    .run(JSON.stringify(diagnostics), new Date().toISOString(), runId)
}

/** The in-process worker registry entry. */
interface LiveWorker {
  readonly runId: RunId
  finished: Promise<void>
  /** The cancel flag the worker's checkpoints observe. */
  cancelled: boolean
  readonly abort: AbortController
}

/**
 * The run service: submit/get/cancel over one open store plus the in-process
 * worker lifecycle. One service instance owns one worker epoch.
 */
export class AccessibilityRunService {
  private readonly store: AccessibilityRunStore
  private readonly workers = new Map<RunId, LiveWorker>()
  private disposed = false

  constructor(store: AccessibilityRunStore) {
    this.store = store
  }

  /** The worker epoch this service instance owns. */
  get epoch(): number {
    return this.store.epoch
  }

  /**
   * Submit one spec for execution. The spec is validated first, the run row
   * is persisted in one transaction, and only then does the worker start —
   * the durable row exists before any work does.
   * @param input - the operation ref, spec, and compute factory.
   * @returns the submit result.
   * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` for a structurally
   *   invalid spec; `ACCESS_CONFLICT` when the same operationRef arrives with
   *   a different digest; `ACCESS_STATE` after disposal.
   */
  submit(input: RunSubmitInput): RunSubmitResult {
    const issues = validateAccessibilitySpec(input.spec)
    if (issues.length > 0) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', `spec rejected: ${issues.map(issue => `${issue.field} (${issue.code})`).join('; ')}`)
    }
    const requestDigest = specDigestOf(input.spec)
    const existing = this.byOperationRef(input.operationRef)
    if (existing !== undefined) {
      // Dedupe and conflict checks stay answerable after disposal: recovering
      // a lost submit response must never require new work.
      if (existing.requestDigest !== requestDigest) {
        throw new AccessibilityError('ACCESS_CONFLICT', `operation ${input.operationRef} was already submitted with a different request digest`)
      }
      return {
        runId: existing.runId,
        operationRef: existing.operationRef,
        requestDigest,
        status: existing.status,
        deduplicated: true,
        estimate: estimateFor(existing.spec),
      }
    }
    if (this.disposed) throw new AccessibilityError('ACCESS_STATE', 'the run service is disposed')
    const runId = newRunId()
    const now = new Date().toISOString()
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      this.store.db.prepare(
        'INSERT INTO accessibility_runs (run_id, operation_ref, request_digest, goal_revision, spec_json, status, result_json, diagnostics_json, worker_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'queued\', NULL, \'[]\', ?, ?, ?)',
      ).run(runId, input.operationRef, requestDigest, input.spec.goalRevision, JSON.stringify(input.spec), this.store.epoch, now, now)
      this.store.db.exec('COMMIT')
    } catch (error: unknown) {
      try {
        this.store.db.exec('ROLLBACK')
      } catch {
        // The original failure is the caller's answer.
      }
      throw new AccessibilityError('ACCESS_IO', `run row could not be persisted: ${String(error)}`)
    }
    this.startWorker(runId, input.buildCompute(input.spec))
    return {
      runId,
      operationRef: input.operationRef,
      requestDigest,
      status: 'queued',
      deduplicated: false,
      estimate: estimateFor(input.spec),
    }
  }

  /** Start the in-process worker for one durable queued run. */
  private startWorker(runId: RunId, compute: RunCompute): void {
    const abort = new AbortController()
    const worker: LiveWorker = { runId, cancelled: false, abort, finished: Promise.resolve() }
    const finished = (async () => {
      this.transition(runId, ['queued'], 'running', null)
      const checkpoints: RunCheckpoints = {
        throwIfCancelled() {
          if (worker.cancelled) throw new RunCancelled()
          abort.signal.throwIfAborted()
        },
      }
      try {
        const outcome = await compute(checkpoints)
        const terminal = outcome.outcome === 'partial' ? 'partial' : 'succeeded'
        const applied = this.transition(runId, ['running', 'cancelRequested'], terminal, JSON.stringify(outcome.result))
        if (applied && worker.cancelled) {
          // The compute finished everything despite the request: the terminal
          // state stays honest and the request is recorded, never lost.
          appendDiagnostic(this.store.db, runId, 'CANCEL_REQUESTED', 'a cancel was requested; the run completed all work before the worker reached a checkpoint')
        }
      } catch (error: unknown) {
        if (error instanceof RunCancelled || abort.signal.aborted) {
          this.transition(runId, ['running', 'cancelRequested'], 'cancelled', null)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof AccessibilityError ? error.code : 'ACCESS_IO'
        try {
          const applied = this.transition(runId, ['running', 'cancelRequested'], 'failed', null)
          if (applied) appendDiagnostic(this.store.db, runId, code, message)
        } catch (secondary: unknown) {
          // The store is closed (process teardown raced the worker): the row
          // stays for the next open's orphan adjudication, which is the
          // honest answer — never a fabricated terminal status.
          console.warn?.(`accessibility runs: failure transition could not be written: ${String(secondary)}`)
        }
      }
    })()
    worker.finished = finished
    this.workers.set(runId, worker)
    const dropWorker = () => {
      if (this.workers.get(runId) === worker) this.workers.delete(runId)
    }
    finished.then(dropWorker, dropWorker)
  }

  /**
   * Compare-and-set one run's status. Returns whether the transition applied;
   * a losing side of the cancel/completion race simply does not write.
   */
  private transition(runId: string, from: readonly AccessibilityRunStatus[], to: AccessibilityRunStatus, resultJson: string | null): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const info = this.store.db.prepare(
      `UPDATE accessibility_runs SET status = ?, result_json = COALESCE(?, result_json), worker_epoch = COALESCE(?, worker_epoch), updated_at = ? WHERE run_id = ? AND status IN (${placeholders})`,
    ).run(to, resultJson, this.store.epoch, new Date().toISOString(), runId, ...from)
    return info.changes > 0
  }

  /**
   * Read one run without re-executing anything.
   * @throws {AccessibilityError} `ACCESS_NOT_FOUND` for an unknown runId.
   */
  get(runId: string): AccessibilityRunRecord {
    const row = this.store.db.prepare('SELECT * FROM accessibility_runs WHERE run_id = ?').get(runId) as LiveRow | undefined
    if (row === undefined) throw new AccessibilityError('ACCESS_NOT_FOUND', `run "${runId}" does not exist in this store`)
    return decodeRow(row)
  }

  /** Read one run by its operation identity, or `undefined`. */
  byOperationRef(operationRef: RunOperationRef): AccessibilityRunRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM accessibility_runs WHERE operation_ref = ?').get(operationRef) as LiveRow | undefined
    return row === undefined ? undefined : decodeRow(row)
  }

  /**
   * Request cancellation. The final state is adjudicated by the worker: a
   * queued/running run becomes `cancelRequested` and finishes `cancelled`
   * (stop at a checkpoint) or its real terminal outcome (completed first).
   * Cancelling an unknown run fails loud; cancelling a terminal run is a
   * no-op that returns its current record.
   */
  cancel(runId: string): AccessibilityRunRecord {
    const current = this.get(runId)
    if (isTerminalStatus(current.status)) return current
    const worker = this.workers.get(current.runId)
    if (current.status === 'queued' || current.status === 'running' || current.status === 'cancelRequested') {
      const applied = this.transition(runId, ['queued', 'running'], 'cancelRequested', null)
      if (applied) {
        appendDiagnostic(this.store.db, runId, 'CANCEL_REQUESTED', 'cancellation requested; the final state is the worker/provider adjudication')
      }
      if (worker !== undefined) {
        worker.cancelled = true
        worker.abort.abort(new RunCancelled())
      }
    }
    return this.get(runId)
  }

  /**
   * Wait for every live worker to settle (real quiescence — the compute
   * either finished or hit its cancel checkpoint), then leave the store open.
   * The owner closes the store itself.
   */
  async quiesce(): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map(worker => worker.finished))
  }

  /** Quiesce and mark the service unusable; the store stays open for reads until closed. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.quiesce()
  }
}

/** The deterministic cost estimate computed from the spec's support extent and slices. */
function estimateFor(spec: AccessibilitySpec): RunSubmitResult['estimate'] {
  const [west, south, east, north] = spec.analysisSupportExtent.bbox
  const latticeNodesUpperBound = Math.ceil(((east - west) / 0.005) + 1) * Math.ceil(((north - south) / 0.005) + 1)
  return {
    latticeNodesUpperBound,
    slices: spec.timeSlices.length,
    maxNodeExpansions: latticeNodesUpperBound * spec.timeSlices.length,
  }
}
