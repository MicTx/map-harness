/** Managed installation dispatcher: argument parsing, structured status, and stable exit codes. */
import { readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MapInstallError } from './install-manifest.mjs'
import { defaultInstallRoot, expandInstallPath, inspectManagedInstall, pathsOverlap } from './install-layout.mjs'
import {
  runManagedInstall, runManagedRollback, runManagedUninstall, runManagedUpdate, verifyManagedInstallation,
} from './install-transaction.mjs'

/** Exit codes owned by the managed dispatcher; scripts forward them unchanged. */
export const MANAGE_EXIT = { ok: 0, usage: 2, conflict: 3, busy: 4, environment: 5 }

const exitForCode = {
  MAP_INSTALL_INPUT: MANAGE_EXIT.usage,
  MAP_OPERATION_UNKNOWN: MANAGE_EXIT.usage,
  MAP_INSTALL_IDENTITY: MANAGE_EXIT.conflict,
  MAP_VERSION_CONFLICT: MANAGE_EXIT.conflict,
  MAP_INSTALL_BUSY: MANAGE_EXIT.busy,
  MAP_INSTALL_EXISTS: MANAGE_EXIT.conflict,
  MAP_INSTALL_REFUSED: MANAGE_EXIT.conflict,
  MAP_INSTALL_STATE: MANAGE_EXIT.conflict,
  MAP_INSTANCE_BUSY: MANAGE_EXIT.busy,
}

/** Command surface; flags precede application arguments and unknown flags fail fast. */
export const MANAGE_USAGE = [
  'Usage: map-harness manage <command> [options]',
  '',
  'Commands:',
  '  install   --package-root <dir> --expected <file> [--install-root <dir>] [--data-home <dir>] [--json]',
  '  status    --install-root <dir> [--json]',
  '  doctor    --install-root <dir> [--json]',
  '  update    --archive <file> --checksums <file> | --package-root <dir> --expected <file> [--dry-run] [--json]',
  '  rollback  --to <version> [--dry-run] [--json]',
  '  uninstall [--install-root <dir>] [--dry-run] [--json]',
  '  import    [...import options]',
  '  transaction-worker <request.json> <result.json>',
  '',
  'Options:',
  '  --package-root <dir>  extracted release package directory that contains the installation manifest',
  '  --expected <file>     independently selected release identity (product/distribution/channel/target/version/identityRevision/sourceDigest/payloadSha256)',
  '  --manager-sha256 <hex> installer script bootstrap checksum from independent release checksums',
  '  --install-root <dir>  managed program root; defaults to the per-user root for the package channel',
  '  --data-home <dir>     explicit data home recorded for the launcher; never created by the installer',
  '  --json                print one JSON result instead of the summary line',
].join('\n')

function fail(code, message, details = {}) {
  throw new MapInstallError(code, message, details)
}

function parseFlags(argv, spec) {
  const values = {}
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') {
      json = true
      continue
    }
    if (!token.startsWith('--')) fail('MAP_INSTALL_INPUT', `Unexpected argument: ${token}`)
    const name = token.slice(2)
    if (!Object.hasOwn(spec, name)) fail('MAP_INSTALL_INPUT', `Unknown option: ${token}`)
    if (Object.hasOwn(values, name)) fail('MAP_INSTALL_INPUT', `Option ${token} may occur only once.`)
    if (spec[name] === 'boolean') {
      values[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail('MAP_INSTALL_INPUT', `Option ${token} needs a value.`)
    values[name] = value
    index += 1
  }
  return { values, json }
}

function readExpectedIdentity(path) {
  let bytes
  try { bytes = readFileSync(path) } catch (error) {
    throw new MapInstallError('MAP_INSTALL_IO', 'Read the independently supplied release identity and retry.', { path, reason: error.code }, { cause: error })
  }
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch (error) {
    fail('MAP_INSTALL_SCHEMA', 'Restore the malformed release identity file.', { path, reason: error.name })
  }
  const keys = ['product', 'distribution', 'channel', 'target', 'version', 'identityRevision', 'sourceDigest', 'payloadSha256']
  const format = value?.format
  if (format !== undefined && format !== 'map-harness-install-identity-1') {
    fail('MAP_INSTALL_SCHEMA', 'Restore the unsupported release identity format.', { path })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'format' && !keys.includes(key)) || !keys.every(key => Object.hasOwn(value, key))) {
    fail('MAP_INSTALL_INPUT', 'The release identity file needs exactly product, distribution, channel, target, version, identityRevision, sourceDigest, and payloadSha256.', { path })
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]))
}

function rootArgument(values, context) {
  const environment = context.env ?? process.env
  const raw = values['install-root'] ?? environment.MAPHARNESS_INSTALL_ROOT
  if (raw === undefined || (values['install-root'] === undefined && raw.trim() === '')) return undefined
  return expandInstallPath(raw, context.homedir, context.cwd ?? process.cwd())
}

function statusSummary(command, installRoot, layout) {
  return {
    command, installRoot, state: layout.state, reason: layout.reason ?? null,
    activeSlot: layout.activeSlot ?? null, activeVersion: layout.activeVersion ?? null,
    version: layout.activeManifest?.version ?? layout.marker?.version ?? null,
    channel: layout.marker?.channel ?? null, target: layout.marker?.target ?? null,
    installationId: layout.marker?.installationId ?? null,
    versions: layout.versions ?? [], receipts: (layout.receipts ?? []).length,
  }
}

function statusOutput(summary) {
  if (summary.state === 'ready') {
    return `install: ready, version ${summary.version} (slot ${summary.activeSlot}, ${summary.installRoot})`
  }
  return `install: ${summary.state}${summary.reason ? ` (${summary.reason})` : ''}, ${summary.installRoot}`
}

/**
 * Execute one managed installation command without printing.
 * Results carry a stable exit code plus machine-readable `json` and a one-line `output`;
 * the native dispatcher prints whichever representation it owns and forwards `exitCode`.
 * `install` requires an independently selected release identity; the package's own manifest
 * is never treated as trusted identity input. `update`, `rollback`, and `uninstall` belong
 * to the managed-maintenance build and report `MAP_OPERATION_UNKNOWN` until they land.
 * @param {string[]} argv command followed by its flags
 * @param {object} [context] environment, cwd, homedir, and injected filesystem/clock seams
 * @returns {Promise<{exitCode: number, json: object, output: string}>} structured result
 * @throws {MapInstallError} unexpected internal failures; expected failures are returned as results
 */
export async function mainManage(argv, context = {}) {
  const command = argv[0]
  const environment = {
    env: process.env, ...context,
    homedir: context.homedir ?? osHomedir(),
    cwd: context.cwd ?? process.cwd(),
  }
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      return { exitCode: MANAGE_EXIT.ok, json: { command: 'help', usage: MANAGE_USAGE }, output: MANAGE_USAGE }
    }
    if (command === 'install') return await installCommand(argv.slice(1), environment)
    if (command === 'status' || command === 'doctor') return await statusCommand(command, argv.slice(1), environment)
    if (command === 'import') return await importCommand(argv.slice(1), environment)
    if (command === 'update') return await updateCommand(argv.slice(1), environment)
    if (command === 'rollback') return await rollbackCommand(argv.slice(1), environment)
    if (command === 'uninstall') return await uninstallCommand(argv.slice(1), environment)
    if (command === 'transaction-worker') return await transactionWorkerCommand(argv.slice(1), environment)
    return failure({ command }, new MapInstallError('MAP_OPERATION_UNKNOWN', `Unknown management command: ${command}`, { command }))
  } catch (error) {
    if (error instanceof MapInstallError) return failure({ command }, error)
    throw error
  }
}

function failure(json, error) {
  const exitCode = exitForCode[error.code] ?? MANAGE_EXIT.environment
  return {
    exitCode,
    json: { ...json, error: { code: error.code, message: error.message, details: error.details ?? {} } },
    output: `map-harness: ${error.message} [${error.code}]`,
  }
}

async function installCommand(argv, context) {
  const { values } = parseFlags(argv, { 'package-root': 'value', 'install-root': 'value', 'data-home': 'value', expected: 'value', 'manager-sha256': 'value' })
  if (values['manager-sha256'] !== undefined && !/^[a-f0-9]{64}$/u.test(values['manager-sha256'])) fail('MAP_INSTALL_INPUT', 'Use a lowercase hexadecimal manager checksum.')
  if (values.expected === undefined) {
    fail('MAP_INSTALL_INPUT', 'Supply --expected with the independently selected release identity; the package manifest alone is not trusted identity input.')
  }
  if (values['package-root'] === undefined) fail('MAP_INSTALL_INPUT', 'Supply --package-root pointing at the extracted release package.')
  const expectedPath = expandInstallPath(values.expected, context.homedir, context.cwd)
  const packageRoot = expandInstallPath(values['package-root'], context.homedir, context.cwd ?? process.cwd())
  if (pathsOverlap(packageRoot, expectedPath)) fail('MAP_INSTALL_INPUT', 'Select release identity from outside the candidate package directory.')
  const expected = readExpectedIdentity(expectedPath)
  const homedir = context.homedir
  const installRoot = rootArgument(values, context)
    ?? defaultInstallRoot({ platform: context.platform ?? process.platform, channel: expected.channel, homedir, env: context.env })
  const homeInput = values['data-home'] ?? context.env?.MAPHARNESS_HOME
  const dataHome = values['data-home'] !== undefined || homeInput?.trim() ? expandInstallPath(homeInput, homedir, context.cwd) : null
  const receipt = await runManagedInstall({ packageRoot, installRoot, expected, dataHome, homedir, env: context.env }, context)
  const exitCode = receipt.state === 'committed' ? MANAGE_EXIT.ok : MANAGE_EXIT.environment
  const output = receipt.state === 'committed'
    ? `install: ${receipt.result}, version ${receipt.version} (${receipt.installRoot}) receipt ${receipt.operationId}`
    : `install: ${receipt.state}, version ${receipt.version} (${receipt.installRoot}) receipt ${receipt.operationId}`
  return { exitCode, json: receipt, output }
}

async function updateCommand(argv, context) {
  const { values } = parseFlags(argv, { archive: 'value', checksums: 'value', 'package-root': 'value',
    expected: 'value', 'install-root': 'value', 'dry-run': 'boolean' })
  const installRoot = rootArgument(values, context)
  if (installRoot === undefined) fail('MAP_INSTALL_INPUT', 'Supply --install-root or MAPHARNESS_INSTALL_ROOT for the installation to update.')
  if (values.archive === undefined && values['package-root'] === undefined) {
    fail('MAP_INSTALL_INPUT', 'Supply --archive with --checksums, or --package-root with --expected.')
  }
  const request = { installRoot, dryRun: values['dry-run'] === true, homedir: context.homedir, env: context.env }
  if (values.archive !== undefined) request.archive = expandInstallPath(values.archive, context.homedir, context.cwd)
  if (values.checksums !== undefined) request.checksums = expandInstallPath(values.checksums, context.homedir, context.cwd)
  if (values['package-root'] !== undefined) request.packageRoot = expandInstallPath(values['package-root'], context.homedir, context.cwd)
  if (values.expected !== undefined) {
    const expectedPath = expandInstallPath(values.expected, context.homedir, context.cwd)
    if (request.packageRoot !== undefined && pathsOverlap(request.packageRoot, expectedPath)) {
      fail('MAP_INSTALL_INPUT', 'Select release identity from outside the candidate package directory.')
    }
    request.expected = readExpectedIdentity(expectedPath)
  }
  const receipt = await runManagedUpdate(request, context)
  return receiptResult('update', receipt)
}

async function rollbackCommand(argv, context) {
  const { values } = parseFlags(argv, { to: 'value', 'install-root': 'value', 'dry-run': 'boolean' })
  const installRoot = rootArgument(values, context)
  if (installRoot === undefined) fail('MAP_INSTALL_INPUT', 'Supply --install-root or MAPHARNESS_INSTALL_ROOT for the installation to roll back.')
  if (values.to === undefined) fail('MAP_INSTALL_INPUT', 'Supply --to with the registered version to roll back to.')
  const receipt = await runManagedRollback({
    installRoot, version: values.to, dryRun: values['dry-run'] === true, homedir: context.homedir, env: context.env,
  }, context)
  return receiptResult('rollback', receipt)
}

async function uninstallCommand(argv, context) {
  const { values } = parseFlags(argv, { 'install-root': 'value', 'dry-run': 'boolean' })
  const installRoot = rootArgument(values, context)
  if (installRoot === undefined) fail('MAP_INSTALL_INPUT', 'Supply --install-root or MAPHARNESS_INSTALL_ROOT for the installation to remove.')
  const receipt = await runManagedUninstall({
    installRoot, dryRun: values['dry-run'] === true, homedir: context.homedir, env: context.env,
  }, context)
  return receiptResult('uninstall', receipt)
}

function receiptResult(command, receipt) {
  const exitCode = ['committed', 'cleanup-pending'].includes(receipt.state) && receipt.result !== 'failed'
    ? MANAGE_EXIT.ok : MANAGE_EXIT.environment
  const target = receipt.targetVersion ?? receipt.previousVersion ?? ''
  return {
    exitCode,
    json: receipt,
    output: `${command}: ${receipt.state}, ${receipt.result}${target ? `, version ${target}` : ''} (${receipt.installRoot}) receipt ${receipt.operationId}`,
  }
}

async function statusCommand(command, argv, context) {
  const { values } = parseFlags(argv, { 'install-root': 'value' })
  const installRoot = rootArgument(values, context)
  if (installRoot === undefined) fail('MAP_INSTALL_INPUT', 'Supply --install-root or MAPHARNESS_INSTALL_ROOT for the installation to inspect.')
  const layout = inspectManagedInstall(installRoot)
  if (command === 'status') {
    const summary = statusSummary('status', installRoot, layout)
    return { exitCode: MANAGE_EXIT.ok, json: summary, output: statusOutput(summary) }
  }
  const report = await verifyManagedInstallation(installRoot)
  const summary = { ...statusSummary('doctor', installRoot, layout), ok: report.ok, checks: report.checks }
  return {
    exitCode: report.ok ? MANAGE_EXIT.ok : MANAGE_EXIT.environment,
    json: summary,
    output: report.ok ? `doctor: healthy, version ${report.version}` : `doctor: ${summary.state} failed ${report.checks.filter(check => !check.ok).map(check => check.name).join(', ')}`,
  }
}

async function transactionWorkerCommand(argv, context) {
  const [requestPath, resultPath] = argv
  if (requestPath === undefined || resultPath === undefined) {
    fail('MAP_INSTALL_INPUT', 'Supply the transaction worker request and result paths.')
  }
  const { executeTransactionWorker } = await import('./windows-transaction.mjs')
  const result = await executeTransactionWorker(
    expandInstallPath(requestPath, context.homedir, context.cwd),
    expandInstallPath(resultPath, context.homedir, context.cwd),
    context.workerDeps ?? {},
  )
  return { exitCode: MANAGE_EXIT.ok, json: result, output: `transaction-worker: ${result.requestId}` }
}

async function importCommand(argv, context) {
  let module
  try {
    module = context.importModule === undefined ? await import('./instance-import.mjs') : await context.importModule()
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      fail('MAP_OPERATION_UNKNOWN', 'The legacy import command is unavailable in this build; use a build that ships the import module.')
    }
    throw error
  }
  try {
    const value = await module.runImportCommand(argv, context)
    return { exitCode: value?.status === 'blocked' ? 1 : 0, json: value, output: `${value?.format ?? 'import'}: ${value?.status ?? 'ready'}` }
  } catch (error) {
    if (error instanceof MapInstallError) throw error
    if (error?.code !== undefined && error?.code !== null) {
      return {
        exitCode: 1,
        json: { command: 'import', error: { code: error.code, message: error.message, details: error.details ?? {} } },
        output: `map-harness: ${error.message} [${error.code}]`,
      }
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await mainManage(process.argv.slice(2), { env: process.env })
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`)
  else process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}
