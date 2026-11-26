/** Windows out-of-tree transaction worker protocol for managed self-replacement. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { MapInstallError } from './install-manifest.mjs'

/** Worker request format exchanged over a private temporary directory. */
export const WINDOWS_TRANSACTION_FORMAT = 'map-harness-windows-transaction-1'
const REQUEST_FILE = 'request.json'
const RESULT_FILE = 'result.json'
const RESULT_TIMEOUT = 600000

function fail(code, message, details = {}) {
  throw new MapInstallError(code, message, details)
}

/**
 * Describe one out-of-tree worker run; the caller selects and verifies the executable.
 * The worker must live outside the installation tree because a running Windows service keeps
 * its image locked; only after every owned launcher/service process exits may files switch.
 * @param {object} request transaction request for the worker
 * @param {string} request.operation 'update'|'rollback'|'uninstall'
 * @param {string} request.installRoot canonical program root
 * @param {object} request.payload operation-specific payload validated by the sender
 * @returns {{format: string, requestId: string, createdAt: string, request: object}} envelope
 */
export function buildWindowsTransactionRequest(request) {
  if (!['update', 'rollback', 'uninstall'].includes(request?.operation) || !isAbsolute(request.installRoot ?? '')) {
    fail('MAP_INSTALL_INPUT', 'Supply the maintenance operation and absolute program root for the Windows worker.')
  }
  return { format: WINDOWS_TRANSACTION_FORMAT, requestId: randomUUID(), createdAt: new Date().toISOString(), request }
}

/**
 * Run the verified external transaction worker and await its final receipt.
 * The worker path must already be digest-verified by its caller. The first launcher's
 * exit is never treated as completion: only the worker's own result record is, and its
 * process exit is awaited to quiescence. Windows-native execution is not verified here.
 * @param {object} options worker inputs
 * @param {string} options.executable absolute worker executable, verified by the caller
 * @param {object} options.envelope buildWindowsTransactionRequest result
 * @param {string[]} [options.arguments] extra worker arguments
 * @param {object} [deps] injectable spawn, timers, and result reader for tests
 * @returns {Promise<object>} worker result record
 * @throws {MapInstallError} worker failure, timeout, or absent result record
 */
export async function runWindowsTransactionWorker(options, deps = {}) {
  const { executable, envelope } = options
  if (!isAbsolute(executable ?? '') || !existsSync(executable)) {
    fail('MAP_INSTALL_INPUT', 'Supply the verified out-of-tree worker executable.')
  }
  if (envelope?.format !== WINDOWS_TRANSACTION_FORMAT) fail('MAP_INSTALL_SCHEMA', 'Supply a Windows transaction request envelope.')
  const directory = mkdtempSync(join(tmpdir(), 'map-windows-transaction-'))
  const requestPath = join(directory, REQUEST_FILE)
  const resultPath = join(directory, RESULT_FILE)
  let worker
  try {
    writeFileSync(requestPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
    const run = deps.spawn ?? spawn
    worker = run(executable, ['manage', 'transaction-worker', requestPath, resultPath, ...(options.arguments ?? [])], {
      stdio: ['ignore', 'ignore', 'pipe'], cwd: directory,
    })
    const stderr = []
    worker.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const exited = new Promise((resolve, reject) => {
      worker.on('error', reject)
      worker.on('exit', (code, signal) => resolve({ code, signal }))
    })
    const result = await (deps.waitForResult ?? waitForResultFile)(resultPath, exited, stderr)
    if (result.format !== WINDOWS_TRANSACTION_FORMAT || result.requestId !== envelope.requestId) {
      fail('MAP_INSTALL_STATE', 'The transaction worker returned a mismatched result record.')
    }
    if (result.error !== null && result.error !== undefined) {
      const error = new MapInstallError(result.error.code ?? 'MAP_OPERATION_UNKNOWN', result.error.message ?? 'The Windows transaction worker failed.', result.error.details ?? {})
      error.details = { ...error.details, workerExit: result.workerExit ?? null }
      throw error
    }
    return result
  } finally {
    if (worker !== undefined && worker.exitCode === null && !worker.killed) {
      try { worker.kill() } catch { /* the worker may have exited between the check and the signal */ }
      await new Promise(resolve => { worker.once('exit', resolve); setTimeout(resolve, 10000).unref?.() })
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Poll for the worker result file while its process remains live; never trust exit alone. */
async function waitForResultFile(resultPath, exited, stderr) {
  const started = Date.now()
  for (;;) {
    if (existsSync(resultPath)) {
      try { return JSON.parse(readFileSync(resultPath, 'utf8')) }
      catch (error) {
        fail('MAP_INSTALL_STATE', 'The transaction worker wrote a malformed result record.', { reason: error.name })
      }
    }
    const outcome = await Promise.race([exited.then(value => value), sleep(250).then(() => null)])
    if (outcome !== null) {
      fail('MAP_INSTALL_STATE', 'The transaction worker exited without a final result record.', {
        code: outcome.code, signal: outcome.signal, stderr: stderr.join('').slice(-512),
      })
    }
    if (Date.now() - started > RESULT_TIMEOUT) {
      fail('MAP_INSTANCE_BUSY', 'The transaction worker did not finish within its budget.')
    }
    await sleep(250)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Verify a result record's digest binding for tests and callers that re-read it.
 * @param {string} resultPath result file written by the worker
 * @param {string} expectedSha256 independently computed digest of the result bytes
 * @returns {object} parsed result
 */
export function readVerifiedWorkerResult(resultPath, expectedSha256) {
  const bytes = readFileSync(resultPath)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail('MAP_INSTALL_DIGEST', 'The worker result record differs from its digest.')
  }
  return JSON.parse(bytes.toString('utf8'))
}

/**
 * Execute one external transaction worker request inside the verified worker process.
 * Reads the request envelope, waits until no process owned by the installation tree remains,
 * runs the requested maintenance transaction in place, and writes the final result record.
 * POSIX runners have no self-replacement constraint; the wait seam is injectable for tests.
 * @param {string} requestPath absolute request envelope path
 * @param {string} resultPath absolute result record path
 * @param {object} [deps] injected transaction, wait, and filesystem seams for tests
 * @returns {Promise<object>} result record also written to resultPath
 */
export async function executeTransactionWorker(requestPath, resultPath, deps = {}) {
  if (!isAbsolute(requestPath ?? '') || !isAbsolute(resultPath ?? '')) {
    fail('MAP_INSTALL_INPUT', 'Transaction worker needs absolute request and result paths.')
  }
  const envelope = JSON.parse(readFileSync(requestPath, 'utf8'))
  if (envelope?.format !== WINDOWS_TRANSACTION_FORMAT || typeof envelope.requestId !== 'string') {
    fail('MAP_INSTALL_SCHEMA', 'Transaction worker request envelope is malformed.')
  }
  const request = envelope.request
  const result = { format: WINDOWS_TRANSACTION_FORMAT, requestId: envelope.requestId, receipt: null,
    error: null, workerExit: { pid: process.pid, code: null, signal: null } }
  try {
    const wait = deps.waitForOwnedExit ?? defaultWaitForOwnedExit
    await wait(request.installRoot, deps)
    const transactionDeps = { ...(deps.transactionDeps ?? {}), inPlace: true, platform: deps.platform ?? process.platform }
    const transaction = deps.transaction ?? (await import('./install-transaction.mjs'))
    if (request.operation === 'update') result.receipt = await transaction.runManagedUpdate(request.request, transactionDeps)
    else if (request.operation === 'rollback') result.receipt = await transaction.runManagedRollback(request.request, transactionDeps)
    else if (request.operation === 'uninstall') result.receipt = await transaction.runManagedUninstall(request.request, transactionDeps)
    else fail('MAP_OPERATION_UNKNOWN', 'Unknown transaction worker operation.', { operation: request.operation })
  } catch (error) {
    result.error = { code: error?.code ?? 'MAP_OPERATION_UNKNOWN', message: error?.message ?? 'Transaction worker failed.',
      details: error?.details ?? {} }
  }
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  if (result.error !== null) {
    const error = new MapInstallError(result.error.code, result.error.message, result.error.details)
    error.details = { ...error.details, workerExit: result.workerExit }
    throw error
  }
  return result
}

/** Wait for no process whose executable or command line is rooted in the installation tree. */
async function defaultWaitForOwnedExit(installRoot, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return
  const { spawnSync } = await import('node:child_process')
  const deadline = Date.now() + (deps.waitBudgetMs ?? 120000)
  while (Date.now() < deadline) {
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:MAPHARNESS_WORKER_ROOT,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($env:MAPHARNESS_WORKER_ROOT,[StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { $_.ProcessId }"
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, MAPHARNESS_WORKER_ROOT: installRoot },
    })
    if (result.status !== 0) fail('MAP_INSTALL_STATE', 'Cannot inspect processes owned by the installation tree.')
    const remaining = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    if (remaining.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  fail('MAP_INSTANCE_BUSY', 'Owned processes did not exit within the transaction worker budget.')
}
