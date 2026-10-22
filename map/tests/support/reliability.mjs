/**
 * Shared resource-reliability helpers for map-owned suites: tracked temporary
 * roots with failure-safe teardown, explicit barriers, predicate waits with
 * deadlines, and real-filesystem leak checks. The contract itself is proven
 * by `map/tests/reliability.spec.mjs`; suites adopt the helpers instead of
 * bare `mkdtemp` + author-discipline `finally` blocks.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Prefix every tracked map test root carries, so leak checks can count leftovers. */
export const TRACKED_TMP_PREFIX = 'map-test-'

/** Every live tracked root; a suite that exits with entries left here leaked them. */
const liveRoots = new Set()

/**
 * Create one tracked temporary root under the OS tmpdir.
 * @param {string} label - short owner tag; becomes part of the directory prefix.
 * @returns {{ path: string, dispose: () => Promise<void> }} the root and an idempotent remover.
 */
export function trackedTmpDir(label) {
  const path = mkdtempSync(join(tmpdir(), `${TRACKED_TMP_PREFIX}${label}-`))
  liveRoots.add(path)
  return {
    path,
    async dispose() {
      if (!liveRoots.delete(path)) return
      rmSync(path, { recursive: true, force: true })
    },
  }
}

/**
 * Run one body inside a tracked root, removing the root whether the body
 * resolves or throws.
 * @template T
 * @param {string} label - owner tag for the root.
 * @param {(dir: { path: string }) => Promise<T>} body - the scoped work.
 * @returns {Promise<T>} the body's resolution.
 */
export async function withTrackedTmpDir(label, body) {
  const dir = trackedTmpDir(label)
  try {
    return await body(dir)
  } finally {
    await dir.dispose()
  }
}

/**
 * Create one externally-released barrier for deterministic interleavings.
 * @returns {{ promise: Promise<void>, release: () => void }} await `promise` to
 * block until `release()` is called; releasing twice is harmless.
 */
export function barrier() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release: () => release() }
}

/**
 * Poll one predicate until it holds, or fail with a named deadline error.
 * No fixed sleeps: the wait observes the external state itself.
 * @param {() => boolean | Promise<boolean>} predicate - the condition to observe.
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<void>} resolves once the predicate holds.
 * @throws {Error} naming `label` when the deadline passes first.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * Count real tmpdir entries carrying one tracked prefix — the leak check reads
 * the filesystem, it never trusts a suite's self-report.
 * @param {string} prefix - full prefix to match (for example `map-test-leak-probe-`).
 * @returns {string[]} matching entry names, so a failure names the leftover.
 */
export function tmpRoots(prefix) {
  return readdirSync(tmpdir()).filter(entry => entry.startsWith(prefix))
}

/**
 * Remove one leftover root observed by a leak check.
 * @param {string} name - entry name as returned by {@link tmpRoots}.
 */
export function removeTmpRoot(name) {
  rmSync(join(tmpdir(), name), { recursive: true, force: true })
}

/**
 * Names of tracked roots this process still holds — suites may assert their
 * own discipline in an after-hook.
 * @returns {string[]} absolute paths of undisposed roots.
 */
export function leakedRoots() {
  return [...liveRoots]
}
