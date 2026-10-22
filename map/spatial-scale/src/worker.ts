/**
 * The worker/process plane: scale scans run in a real child process, not on
 * the coordinating process. The parent stages a private job directory (the
 * self-contained worker entry script plus the job request), spawns a plain
 * Node child with a scrubbed environment, and speaks one JSON line per
 * message over the pipes: a request line in, progress/cancelled/result
 * lines out. The protocol is deliberately tiny so both sides agree without
 * sharing code — the child verifies each chunk digest before scanning,
 * folds the predicate, caps its sample, and reports per-chunk progress the
 * parent turns into resume cursors.
 *
 * The plane is deliberate about four failure behaviors:
 * - **Backpressure** — the runner holds at most `jobSlots` live children;
 *   submissions beyond that queue up to `queueDepth` deep and are counted
 *   as held; a full queue refuses loudly instead of growing.
 * - **Cancel reaches quiescence** — a cancel writes the cancel line and the
 *   runner settles only after the child process has actually exited; a
 *   cancel/completion race is adjudicated by whichever terminal message the
 *   child itself produced, never by the parent's intent. A child that
 *   cannot stop on its own (a wedged scan) is the timeout's kill target,
 *   and a kill settles as `failed`, never as a fabricated cancellation.
 * - **Timeouts do not fake termination** — a timed-out child is killed and
 *   its outcome is `failed` with the timeout diagnostic; the same holds for
 *   a crashed (non-zero exit) child.
 * - **Temp resources are cleaned on every path** — success, cancel, crash,
 *   and timeout all remove the job's staging directory in a `finally`.
 *
 * @module @map-harness/spatial-scale/worker
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCALE_METHOD_VERSION,
  type ScaleBudgets,
  type ScaleJobCancelled,
  type ScaleJobProgress,
  type ScaleJobReply,
  type ScaleJobRequest,
  type ScaleJobResult,
} from './contract.ts'
import { newStagingDir, randomToken, removeStagingDir } from './store.ts'

/**
 * The self-contained worker entry: plain Node JavaScript with no imports,
 * written into the job's private staging directory at submit time and
 * spawned as its own process. Protocol: the first stdin line is the
 * {@link ScaleJobRequest}; later `cancel` lines request a stop at the next
 * chunk boundary. Stdout carries one JSON line per {@link ScaleJobReply}.
 * Each chunk is digest-verified before it is parsed — a corrupted chunk
 * fails the job instead of silently scanning different bytes.
 */
const WORKER_ENTRY_SOURCE = `
const crypto = require('node:crypto')
const fs = require('node:fs')

let request = null
let cancelled = false
let buffer = ''

function compare(value, op, against) {
  switch (op) {
    case '>': return value > against
    case '>=': return value >= against
    case '<': return value < against
    case '<=': return value <= against
    case '==': return value === against
    case '!=': return value !== against
    default: return false
  }
}

function firstPosition(geometry) {
  const walk = (coords) => {
    if (!Array.isArray(coords)) return null
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return [coords[0], coords[1]]
    }
    for (const nested of coords) {
      const hit = walk(nested)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(geometry === null || geometry === undefined ? null : geometry.coordinates)
}

function emit(line) {
  process.stdout.write(JSON.stringify(line) + '\\n')
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at === -1) break
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line.length === 0) continue
    if (request === null) {
      request = JSON.parse(line)
      run()
    } else if (line === 'cancel') {
      cancelled = true
    }
  }
})

process.stdin.on('end', () => {
  // The request pipe closed without a request: report and leave.
  if (request === null) process.exit(2)
})

function run() {
  if (request.methodVersion !== ${JSON.stringify(SCALE_METHOD_VERSION)}) {
    emit({ type: 'failed', code: 'method-version', message: 'unknown method version' })
    process.exit(2)
  }
  const aggregate = { count: 0, sum: 0, min: 0, max: 0 }
  const sample = []
  let chunksDone = 0
  let rowsScanned = 0
  let bytesScanned = 0
  let truncated = false

  const step = () => {
    if (cancelled) {
      emit({ type: 'cancelled', chunksDone, rowsScanned, bytesScanned })
      process.exit(0)
    }
    const chunk = request.chunks[chunksDone]
    if (chunk === undefined) {
      emit({ type: 'result', chunksDone, rowsScanned, bytesScanned, truncated, aggregate, sample })
      process.exit(0)
    }
    const bytes = fs.readFileSync(chunk.path).subarray(chunk.start, chunk.end)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    if (digest !== chunk.digest) {
      emit({ type: 'failed', code: 'digest-mismatch', message: 'chunk ' + chunksDone + ' failed its digest check' })
      process.exit(3)
    }
    bytesScanned += bytes.byteLength
    for (const line of bytes.toString('utf8').split('\\n')) {
      if (line.length === 0) continue
      const row = JSON.parse(line)
      rowsScanned += 1
      if (request.predicate !== null) {
        const value = row.p[request.predicate.field]
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        if (!compare(value, request.predicate.op, request.predicate.value)) continue
      }
      aggregate.count += 1
      const value = row.p.value
      if (typeof value === 'number' && Number.isFinite(value)) {
        aggregate.sum += value
        aggregate.min = aggregate.count === 1 ? value : Math.min(aggregate.min, value)
        aggregate.max = aggregate.count === 1 ? value : Math.max(aggregate.max, value)
      }
      const position = firstPosition(row.g)
      if (sample.length < request.sampleRows) {
        sample.push({
          index: row.i,
          lon: position === null ? null : Math.round(position[0] * 1e6) / 1e6,
          lat: position === null ? null : Math.round(position[1] * 1e6) / 1e6,
          value: typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : null,
        })
      } else {
        truncated = true
      }
    }
    chunksDone += 1
    emit({ type: 'progress', chunksDone, rowsScanned, bytesScanned, matches: aggregate.count })
    if (request.fault !== undefined && request.fault.kind === 'crash' && chunksDone >= (request.fault.afterChunks ?? 0)) {
      process.exit(9)
    }
    if (request.fault !== undefined && request.fault.kind === 'hang' && chunksDone >= (request.fault.afterChunks ?? 0)) {
      setInterval(() => {}, 60_000)
      return
    }
    if (request.fault !== undefined && request.fault.kind === 'pace') {
      setTimeout(step, request.fault.paceMs ?? 0)
      return
    }
    setImmediate(step)
  }
  setImmediate(step)
}
`

/** Why one job settled the way it did. */
export type ScaleJobStatus = 'succeeded' | 'cancelled' | 'failed'

/** The terminal outcome of one job, settled only by the child's real exit. */
export type ScaleJobOutcome =
  | { readonly status: 'succeeded'; readonly result: ScaleJobResult; readonly progress: readonly ScaleJobProgress[] }
  | { readonly status: 'cancelled'; readonly cancelled: ScaleJobCancelled; readonly progress: readonly ScaleJobProgress[] }
  | { readonly status: 'failed'; readonly code: 'digest-mismatch' | 'worker-crash' | 'timeout' | 'spawn' | 'method-version'; readonly reason: string; readonly progress: readonly ScaleJobProgress[] }

/** One queued submission awaiting a free slot — the backpressure hold the stats face reports. */
interface QueuedSubmission {
  readonly request: ScaleJobRequest
  readonly resolve: (outcome: ScaleJobOutcome) => void
  readonly options: { signal?: AbortSignal; onProgress?: (progress: ScaleJobProgress) => void }
}

/** One live child the runner tracks: graceful cancel, hard kill, and its exit. */
interface LiveJob {
  readonly cancel: () => void
  readonly kill: () => void
  readonly whenExited: Promise<void>
}

/** The runner's bounded slot/queue face (the backpressure observability). */
export interface ScaleRunnerStats {
  readonly jobSlots: number
  readonly occupied: number
  readonly queued: number
  /** Cumulative submissions that waited for a free slot at least once. */
  readonly heldByBackpressure: number
  /** Cumulative submissions a full queue refused. */
  readonly refusedByFullQueue: number
}

/**
 * The scan worker runner: bounded child processes over staged job
 * directories. One runner owns its staging root and its slot accounting.
 */
export class ScaleJobRunner {
  private readonly stagingRoot: string
  private readonly budgets: ScaleBudgets
  private readonly live = new Map<string, LiveJob>()
  private readonly queue: QueuedSubmission[] = []
  private heldByBackpressure = 0
  private refusedByFullQueue = 0
  private disposed = false

  /**
   * @param stagingRoot - the private staging root job directories are
   *   created under (typically the store's staging area).
   * @param budgets - the budgets this runner enforces (job slots, queue
   *   depth, timeout).
   */
  constructor(stagingRoot: string, budgets: ScaleBudgets) {
    this.stagingRoot = stagingRoot
    this.budgets = budgets
  }

  /** The bounded slot/queue face (the backpressure observability). */
  stats(): ScaleRunnerStats {
    return {
      jobSlots: this.budgets.jobSlots,
      occupied: this.live.size,
      queued: this.queue.length,
      heldByBackpressure: this.heldByBackpressure,
      refusedByFullQueue: this.refusedByFullQueue,
    }
  }

  /**
   * Request cancellation of one live job. The request is not the terminal
   * state: the job settles when the child actually exits at a chunk
   * boundary, and a child that finishes first still wins the race (its own
   * result is the outcome).
   * @param jobId - the job id to cancel.
   * @returns whether a live job was found and the cancel line was sent.
   */
  cancel(jobId: string): boolean {
    const job = this.live.get(jobId)
    if (job === undefined) return false
    job.cancel()
    return true
  }

  /**
   * Run one scan job to its settled outcome. Bounded by the job slots: when
   * all slots are busy the submission queues (up to `queueDepth`); a full
   * queue refuses loudly. The returned promise resolves only after the
   * child process has exited and the staging directory has been removed.
   * @param request - the job request (chunks, predicate, sample cap).
   * @param options - optional abort signal wired to the cancel line, and an
   *   optional per-chunk progress observer.
   * @returns the settled outcome.
   */
  async run(request: ScaleJobRequest, options: { signal?: AbortSignal; onProgress?: (progress: ScaleJobProgress) => void } = {}): Promise<ScaleJobOutcome> {
    if (this.disposed) {
      return { status: 'failed', code: 'spawn', reason: 'the runner is disposed and accepts no new jobs', progress: [] }
    }
    if (this.live.size >= this.budgets.jobSlots) {
      if (this.queue.length >= this.budgets.queueDepth) {
        this.refusedByFullQueue += 1
        return { status: 'failed', code: 'spawn', reason: `the job queue is full (${this.budgets.queueDepth} deep); submit refused instead of growing`, progress: [] }
      }
      this.heldByBackpressure += 1
      return await new Promise<ScaleJobOutcome>(resolve => {
        this.queue.push({ request, resolve, options })
      })
    }
    return await this.execute(request, options)
  }

  /**
   * Dispose the runner: refuse new submissions, drain the queue, kill every
   * live child, and wait for all children to exit. Disposal reaches
   * quiescence, not just requests it.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const queued = this.queue.splice(0, this.queue.length)
    for (const submission of queued) {
      submission.resolve({ status: 'failed', code: 'spawn', reason: 'the runner is disposing; the queued job never started', progress: [] })
    }
    const exits: Promise<void>[] = []
    for (const job of this.live.values()) {
      job.kill()
      exits.push(job.whenExited)
    }
    await Promise.all(exits)
  }

  // -- internals --

  /** Execute one job in a fresh child process and settle by its real exit. */
  private async execute(request: ScaleJobRequest, options: { signal?: AbortSignal; onProgress?: (progress: ScaleJobProgress) => void } = {}): Promise<ScaleJobOutcome> {
    const jobId = randomToken(6)
    const staging = newStagingDir(this.stagingRoot, `job-${jobId}`)
    // Private job dir: the worker entry lands here owner-only and is removed
    // on every settle path.
    const entryPath = join(staging, 'worker-entry.cjs')
    writeFileSync(entryPath, WORKER_ENTRY_SOURCE, { mode: 0o600 })
    const child = spawn(process.execPath, [entryPath], {
      cwd: staging,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Scrubbed environment: no harness credentials reach the worker.
      env: scrubEnv(process.env),
    })
    const whenExited = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      // A failed spawn never emits `exit`; the error event releases the wait.
      child.once('error', () => resolve())
    })
    // A cancel written as the child exits is a no-op race loss, not a
    // failure: the settle already happened by whatever finished first.
    child.stdin.on('error', () => { })
    let killedForTimeout = false
    const liveJob: LiveJob = {
      cancel: () => {
        child.stdin.write('cancel\n')
      },
      kill: () => {
        child.kill('SIGKILL')
      },
      whenExited,
    }
    this.live.set(jobId, liveJob)
    const signal = options.signal
    const onAbort = () => liveJob.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })

    const progress: ScaleJobProgress[] = []
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`)
      // A signal that aborted while the job waited in the queue never fires
      // its listener: cancel immediately on an already-aborted signal.
      if (signal?.aborted === true) liveJob.cancel()
      const outcome = await new Promise<ScaleJobOutcome>(resolve => {
        let lineBuffer = ''
        let settled = false
        const progressCopy = () => [...progress]
        const settle = (outcome: ScaleJobOutcome) => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
        const timer = setTimeout(() => {
          killedForTimeout = true
          child.kill('SIGKILL')
          // A kill is a timeout failure, never a fabricated cancelled or
          // success; the exit handler defers to this settle.
        }, this.budgets.jobTimeoutMs)
        child.stdout.on('data', (chunk: Buffer) => {
          lineBuffer += chunk.toString('utf8')
          for (;;) {
            const at = lineBuffer.indexOf('\n')
            if (at === -1) break
            const line = lineBuffer.slice(0, at).trim()
            lineBuffer = lineBuffer.slice(at + 1)
            if (line.length === 0) continue
            let reply: ScaleJobReply
            try {
              reply = JSON.parse(line) as ScaleJobReply
            } catch {
              continue
            }
            if (reply.type === 'progress') {
              progress.push(reply)
              options.onProgress?.(reply)
            }
            else if (reply.type === 'result') {
              clearTimeout(timer)
              settle({ status: 'succeeded', result: reply, progress: progressCopy() })
            } else if (reply.type === 'cancelled') {
              clearTimeout(timer)
              settle({ status: 'cancelled', cancelled: reply, progress: progressCopy() })
            } else if (reply.type === 'failed') {
              clearTimeout(timer)
              const code = reply.code === 'digest-mismatch' ? 'digest-mismatch' : 'method-version'
              settle({ status: 'failed', code, reason: reply.message, progress: progressCopy() })
            }
          }
        })
        child.once('error', (error: Error) => {
          clearTimeout(timer)
          settle({ status: 'failed', code: 'spawn', reason: `the worker could not be started: ${String(error)}`, progress: progressCopy() })
        })
        child.once('exit', (code, signalName) => {
          clearTimeout(timer)
          if (killedForTimeout) {
            settle({
              status: 'failed',
              code: 'timeout',
              reason: `the job exceeded its ${this.budgets.jobTimeoutMs} ms timeout and was killed; no outcome is claimed`,
              progress: progressCopy(),
            })
            return
          }
          // Orthogonal facts reported independently: exit code and signal are
          // surfaced as observed; neither is folded into a success.
          settle({
            status: 'failed',
            code: 'worker-crash',
            reason: `the worker exited without a terminal protocol line (code ${String(code)}, signal ${String(signalName)})`,
            progress: progressCopy(),
          })
        })
      })
      await whenExited
      return outcome
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.live.delete(jobId)
      // Temp resources are cleaned on every path, then the next queued job
      // takes the freed slot.
      removeStagingDir(staging)
      if (!this.disposed) {
        const next = this.queue.shift()
        if (next !== undefined) {
          void this.execute(next.request, next.options).then(next.resolve)
        }
      }
    }
  }
}

/** Drop every credential-shaped environment variable before spawning. */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) continue
    scrubbed[key] = value
  }
  return scrubbed
}

/** The job request the parent assembles for one full-version scan (worker-facing alias). */
export type ScaleScanJobRequest = ScaleJobRequest

/** Exposed for tests that stage their own requests against the protocol. */
export const SCALE_WORKER_ENTRY = WORKER_ENTRY_SOURCE
