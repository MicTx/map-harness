/** Platform-specific archive and process operations for Web service qualification. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'

function withMinimalPath(environment, path) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path')), PATH: path }
}

function windowsPowerShell(environment) {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Select the host launcher, archive format, and system-only executable search path.
 * @param {string} platform Node platform name.
 * @param {NodeJS.ProcessEnv} env Host environment.
 * @returns {{extension: string, launcher: string, path: string, recordedPath: string}} Platform settings.
 */
export function qualificationPlatform(platform, env) {
  if (platform === 'darwin' || platform === 'linux') {
    return { extension: '.tar.gz', launcher: 'start-web.sh', path: '/usr/bin:/bin:/usr/sbin:/sbin', recordedPath: '/usr/bin:/bin:/usr/sbin:/sbin' }
  }
  if (platform !== 'win32') throw new Error(`Unsupported qualification platform: ${platform}`)
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR
  if (!root || !win32.isAbsolute(root)) throw new Error('Windows qualification requires an absolute SystemRoot.')
  const system = win32.join(root, 'System32')
  return { extension: '.zip', launcher: 'start-web.cmd',
    path: [system, root, win32.join(system, 'WindowsPowerShell', 'v1.0'), win32.join(system, 'Wbem')].join(';'),
    recordedPath: 'Windows system directories' }
}

/**
 * Reject Wine and fail closed when the native Windows host probe cannot run.
 * @param {NodeJS.ProcessEnv} environment Host environment.
 * @param {typeof spawnSync} run Process runner for the host probe.
 */
export function assertNativeWindows(environment, run = spawnSync) {
  const settings = qualificationPlatform('win32', environment)
  const powershell = windowsPowerShell(environment)
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MapQualificationNativeProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
  public static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
}
'@
$module = [MapQualificationNativeProbe]::GetModuleHandle('ntdll.dll')
if ($module -eq [IntPtr]::Zero) { exit 2 }
if ([MapQualificationNativeProbe]::GetProcAddress($module, 'wine_get_version') -ne [IntPtr]::Zero) { exit 3 }
exit 0
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 30000, env: withMinimalPath(environment, settings.path),
  })
  if (result.status === 3) throw new Error('Windows qualification cannot run under Wine.')
  if (result.error || result.status !== 0) throw new Error('Windows native host probe failed.')
}

function safeArchivePath(path) {
  const name = path.endsWith('/') ? path.slice(0, -1) : path
  return /^[A-Za-z0-9._/-]+$/u.test(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * Extract a host archive into an empty directory without accepting links or unsafe paths.
 * @param {string} archive Input archive.
 * @param {string} directory Empty output directory.
 * @param {string} platform Node platform name.
 * @param {string[]} expectedFiles Optional complete list of archive files.
 * @returns {Promise<void>} Resolves after extraction.
 */
export async function extractQualificationArchive(archive, directory, platform, expectedFiles) {
  const extension = platform === 'win32' ? '.zip' : platform === 'darwin' || platform === 'linux' ? '.tar.gz' : undefined
  if (!extension || !archive.endsWith(extension)) throw new Error('Web qualification archive format does not match the host.')
  mkdirSync(directory, { recursive: true })
  const seen = new Set(), files = new Set(), expected = expectedFiles === undefined ? undefined : new Set(expectedFiles)
  const accept = (name, type) => {
    if (!safeArchivePath(name) || !['File', 'Directory'].includes(type) || seen.has(name)) {
      throw new Error('Web qualification archive has an unsafe path, duplicate, or link.')
    }
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name
    if (expected && (type === 'Directory' ? ![...expected].some(file => file.startsWith(`${normalized}/`)) : !expected.has(name))) {
      throw new Error('Web qualification archive contains an unexpected entry.')
    }
    seen.add(name)
    if (type === 'File') files.add(name)
  }
  if (platform === 'win32') {
    await extractZip(archive, { dir: resolve(directory), onEntry(entry) {
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      const type = mode === 0o120000 ? 'SymbolicLink' : mode === 0o040000 || entry.fileName.endsWith('/') ? 'Directory'
        : mode === 0 || mode === 0o100000 ? 'File' : 'Special'
      accept(entry.fileName, type)
    } })
  } else {
    extractTar({ file: archive, cwd: directory, sync: true, strict: true, filter(name, entry) {
      accept(name, entry.type)
      return true
    } })
  }
  if (expected && (files.size !== expected.size || [...expected].some(file => !files.has(file)))) {
    throw new Error('Web qualification archive is missing expected files.')
  }
}

/**
 * Build a noninteractive CMD invocation without inserting launcher paths or arguments into shell syntax.
 * @param {string} launcher Absolute CMD launcher.
 * @param {string[]} args Launcher arguments.
 * @param {NodeJS.ProcessEnv} environment Host environment.
 * @returns {object} Command, pre-escaped command line, and child environment.
 */
export function windowsLauncherInvocation(launcher, args, environment) {
  const settings = qualificationPlatform('win32', environment)
  if ([launcher, ...args].some(value => typeof value !== 'string' || /["\r\n\0]/u.test(value))) {
    throw new Error('Windows qualification launcher arguments are unsafe.')
  }
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR
  const env = Object.fromEntries(Object.entries(withMinimalPath(environment, settings.path)).filter(([key]) => {
    const upper = key.toUpperCase()
    return !upper.startsWith('MAPHARNESS_QUALIFY_ARG_') && upper !== 'MAPHARNESS_QUALIFY_LAUNCHER'
  }))
  env.MAPHARNESS_QUALIFY_LAUNCHER = launcher
  const argumentsList = args.map((value, index) => {
    env[`MAPHARNESS_QUALIFY_ARG_${index}`] = value
    return `"%MAPHARNESS_QUALIFY_ARG_${index}%"`
  })
  const commandLine = `/d /v:off /s /c ""%MAPHARNESS_QUALIFY_LAUNCHER%" ${argumentsList.join(' ')} <NUL"`
  return { command: win32.join(root, 'System32', 'cmd.exe'), commandLine, env }
}

/**
 * Start a Windows CMD launcher in its own pseudo-console and require a graceful Ctrl-C exit of its service.
 * Observe the service's exit code independently of CMD/PowerShell. Noninteractive stdin keeps CMD's batch
 * confirmation from blocking; require service exit 130, launcher exit, and observer cleanup on every path.
 * @param {object} pty node-pty implementation.
 * @param {string} launcher Absolute CMD launcher.
 * @param {string[]} args Launcher arguments.
 * @param {NodeJS.ProcessEnv} env Host environment.
 * @param {string} cwd Service working directory.
 * @param {object} options Service identity and process inspection.
 * @param {string} options.executable Absolute path of the packaged service executable.
 * @param {number} [options.timeoutMs] Readiness, service exit, and launcher return timeout.
 * @param {typeof windowsServiceProcesses} [options.processes] Running instances of the service executable.
 * @param {typeof watchWindowsProcessExit} [options.watch] Exit watcher for one process.
 * @param {typeof windowsQualificationProcesses} [options.remaining] Process-residue inspection, defaulting to the host implementation.
 * @returns {object} Readiness promise and bounded stop/abort operations.
 */
export function windowsQualificationSession(pty, launcher, args, env, cwd, options) {
  const { executable, timeoutMs = 120000, processes = windowsServiceProcesses, watch = watchWindowsProcessExit, remaining = windowsQualificationProcesses } = options
  if (typeof executable !== 'string' || !win32.isAbsolute(executable)) {
    throw new Error('Windows qualification requires the absolute service executable.')
  }
  const invocation = windowsLauncherInvocation(launcher, args, env)
  const terminal = pty.spawn(invocation.command, invocation.commandLine, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd, env: invocation.env, useConpty: true,
  })
  let output = '', afterInterrupt, ready = false, released = false, exitEvent, resolveExit, rejectReady, readyTimer
  const exited = new Promise(resolveExitPromise => { resolveExit = resolveExitPromise })
  const result = new Promise((resolveReady, reject) => {
    rejectReady = reject
    readyTimer = setTimeout(() => reject(new Error('Windows Web service readiness timed out.')), timeoutMs)
    terminal.onData(chunk => {
      output = (output + chunk).slice(-1024 * 1024)
      if (afterInterrupt !== undefined) afterInterrupt = (afterInterrupt + chunk).slice(-64 * 1024)
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+)/u)
      if (!match || ready) return
      ready = true
      clearTimeout(readyTimer)
      resolveReady(match[1])
    })
  })
  terminal.onExit(event => {
    exitEvent = event
    clearTimeout(readyTimer)
    if (!ready) rejectReady(new Error(`Windows Web service exited before readiness: ${event.exitCode}`))
    resolveExit(event)
  })
  const releaseTerminal = () => {
    if (!released) { terminal.kill(); released = true }
  }
  return {
    result,
    async stop() {
      if (exitEvent !== undefined) throw new Error('Windows Web service exited before Ctrl-C.')
      const roots = rootProcesses(processes(executable, env))
      if (roots.length !== 1) throw new Error(`Windows qualification expected one running service process, found ${roots.length}.`)
      const watcher = watch(roots[0].pid, executable, env)
      try {
        await bounded(watcher.armed, timeoutMs, () => 'Windows service exit watcher did not start.')
        if (exitEvent !== undefined || watcher.exitCode !== undefined) throw new Error('Windows Web service exited before Ctrl-C.')
        afterInterrupt = ''
        terminal.write('\x03')
        const code = await bounded(watcher.exited, timeoutMs, () => `Windows Web service did not exit after Ctrl-C.${consoleTail(afterInterrupt)}`)
        if (code !== 130) throw new Error(`Windows Web service did not exit cleanly after Ctrl-C: ${code}`)
        await bounded(exited, timeoutMs, () => `Windows Web service launcher did not return after Ctrl-C.${consoleTail(afterInterrupt)}`)
        if (remaining(cwd, env).length !== 0) throw new Error('Windows Web service left processes after Ctrl-C.')
        // node-pty retains its output worker after onExit; release only after both exits and the residue check.
        releaseTerminal()
      } finally {
        await watcher.close()
      }
    },
    async abort() {
      clearTimeout(readyTimer)
      releaseTerminal()
      await bounded(exited, timeoutMs, () => 'Windows Web service did not exit after its pseudo-console closed.')
      if (remaining(cwd, env).length !== 0) throw new Error('Windows Web service cleanup left processes; retain its working directory.')
    },
  }
}

function rootProcesses(rows) {
  const pids = new Set(rows.map(row => row.pid))
  return rows.filter(row => !pids.has(row.parentPid))
}

function bounded(promise, timeoutMs, message) {
  let timer
  const expiry = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message())), timeoutMs) })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

function consoleTail(text = '') {
  const visible = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/token=[^\s"]+/gu, 'token=<redacted>').trim()
  return visible ? ` Console after Ctrl-C: ${JSON.stringify(visible.slice(-500))}` : ''
}

/**
 * Inspect Windows processes referring to an extracted qualification directory.
 * @param {string} root Extracted directory.
 * @param {NodeJS.ProcessEnv} environment Host environment.
 * @param {typeof spawnSync} run Process runner for inspection.
 * @returns {string[]} Remaining process identifiers.
 */
export function windowsQualificationProcesses(root, environment, run = spawnSync) {
  const settings = qualificationPlatform('win32', environment)
  const powershell = windowsPowerShell(environment)
  const script = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:MAPHARNESS_QUALIFY_ROOT, [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($env:MAPHARNESS_QUALIFY_ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { $_.ProcessId }"
  const result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30000, env: { ...withMinimalPath(environment, settings.path), MAPHARNESS_QUALIFY_ROOT: root },
  })
  if (result.error || result.status !== 0) throw new Error('Cannot inspect Windows qualification processes.')
  return result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
}

/**
 * List running Windows processes whose executable is exactly the packaged service.
 * @param {string} executable Absolute service executable path.
 * @param {NodeJS.ProcessEnv} environment Host environment.
 * @param {typeof spawnSync} run Process runner for inspection.
 * @returns {{pid: number, parentPid: number}[]} Matching processes.
 */
export function windowsServiceProcesses(executable, environment, run = spawnSync) {
  const settings = qualificationPlatform('win32', environment)
  const script = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $env:MAPHARNESS_QUALIFY_SERVICE, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"
  const result = run(windowsPowerShell(environment), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30000, env: { ...withMinimalPath(environment, settings.path), MAPHARNESS_QUALIFY_SERVICE: executable },
  })
  if (result.error || result.status !== 0) throw new Error('Cannot inspect Windows service processes.')
  return result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(\d+) (\d+)$/u)
    if (match === null) throw new Error('Windows service process inspection returned an invalid row.')
    const pid = Number(match[1]), parentPid = Number(match[2])
    if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff || !Number.isInteger(parentPid) || parentPid > 0xffffffff) {
      throw new Error('Windows service process inspection returned an invalid identifier.')
    }
    return { pid, parentPid }
  })
}

/**
 * Watch one Windows process from outside its pseudo-console and report its exit code.
 * Failed startup or incomplete observer output rejects both pending results; callers must await close().
 * @param {number} pid Positive Windows process identifier.
 * @param {string} executable Expected absolute service executable path.
 * @param {NodeJS.ProcessEnv} environment Host environment.
 * @param {typeof spawn} start Process starter for the watcher.
 * @returns {{armed: Promise<void>, exited: Promise<number>, readonly exitCode: number | undefined, close: () => Promise<void>}} Owned observer and service exit results.
 */
export function watchWindowsProcessExit(pid, executable, environment, start = spawn) {
  if (typeof executable !== 'string' || !win32.isAbsolute(executable)) throw new Error('Windows exit watcher requires an absolute executable.')
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error('Windows exit watcher requires a process identifier.')
  const settings = qualificationPlatform('win32', environment)
  const script = "$ErrorActionPreference = 'Stop'; $process = Get-Process -Id ([int]$env:MAPHARNESS_QUALIFY_PID); try { $null = $process.Handle; if (-not [string]::Equals($process.MainModule.FileName, $env:MAPHARNESS_QUALIFY_SERVICE, [StringComparison]::OrdinalIgnoreCase)) { throw 'Service process identity changed.' }; if ($process.HasExited) { throw 'Service already exited.' }; 'armed'; $process.WaitForExit(); 'exit=' + $process.ExitCode } finally { $process.Dispose() }"
  const child = start(windowsPowerShell(environment), ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...withMinimalPath(environment, settings.path), MAPHARNESS_QUALIFY_PID: String(pid), MAPHARNESS_QUALIFY_SERVICE: executable }, windowsHide: true,
  })
  return observeWindowsExit(child, pid)
}

function observeWindowsExit(child, pid) {
  let stdout = '', armedSeen = false, code, failure, isClosed = false
  const armed = Promise.withResolvers(), exited = Promise.withResolvers(), closed = Promise.withResolvers()
  // Both outcomes are observed here because callers await readiness before exit; rejections still reach them.
  armed.promise.catch(() => undefined)
  exited.promise.catch(() => undefined)
  const fail = reason => {
    failure ??= new Error(`Windows exit watcher for process ${pid} ${reason}`)
    armed.reject(failure)
    exited.reject(failure)
  }
  child.stdout.setEncoding('utf8')
  child.stderr.resume()
  child.stdout.on('data', chunk => {
    if (failure !== undefined) return
    stdout += chunk
    if (stdout.length > 4096) { fail('returned excessive output.'); return }
    let newline
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline).replace(/\r$/u, '')
      stdout = stdout.slice(newline + 1)
      if (line === 'armed' && !armedSeen && code === undefined) {
        armedSeen = true
        armed.resolve()
      } else if (armedSeen && code === undefined && /^exit=-?\d+$/u.test(line)) {
        code = Number(line.slice(5))
        if (!Number.isSafeInteger(code) || code < -0x80000000 || code > 0xffffffff) fail('returned an invalid exit code.')
      } else fail('returned an invalid process exit report.')
    }
  })
  child.once('error', () => fail('could not start or monitor the process.'))
  child.once('close', (status, signal) => {
    isClosed = true
    if (status !== 0 || signal != null || !armedSeen || code === undefined || stdout !== '') fail('ended without a complete successful exit report.')
    if (failure === undefined) exited.resolve(code)
    closed.resolve()
  })
  return {
    armed: armed.promise, exited: exited.promise,
    get exitCode() { return code },
    async close() {
      if (!isClosed) child.kill()
      await bounded(closed.promise, 30000, () => 'Windows exit watcher did not close.')
    },
  }
}
