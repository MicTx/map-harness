import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { zipSync } from 'fflate'
import { c as createTarArchive } from 'tar'
import { assertNativeWindows, extractQualificationArchive, qualificationPlatform, watchWindowsProcessExit, windowsLauncherInvocation, windowsQualificationProcesses, windowsQualificationSession, windowsServiceProcesses } from '../bin/web-service-qualification-platform.mjs'
import { qualificationScenarioPaths, smokeWebService, validateWebServiceRuntimeInputs } from '../bin/smoke-web-service.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('runtime inputs bind archive, manifest, build record and host target', t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'mac-arm64'))
  const archive = join(root, 'release.tar.gz')
  writeFileSync(archive, 'archive fixture')
  const record = { version: '0.1.13', target: 'mac-arm64', sourceCoreFiles: 0,
    webService: { mode: 'web', profile: 'map-web' }, sha256: 'a'.repeat(64) }
  const recordPath = 'mac-arm64/record.json'
  writeFileSync(join(root, recordPath), JSON.stringify(record))
  const manifest = { format: 1, product: 'map-harness', version: '0.1.13', supportedTargets: ['mac-arm64'],
    unsupportedTargets: ['win-x64'], targets: [{ target: 'mac-arm64', record: recordPath }],
    files: [{ path: recordPath, sha256: sha(readFileSync(join(root, recordPath))) }, { role: 'service', target: 'mac-arm64', sha256: record.sha256 }] }
  const manifestPath = join(root, 'web-service-manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const result = validateWebServiceRuntimeInputs(archive, manifestPath, 'host', root, { platform: 'darwin', arch: 'arm64' })
  assert.equal(result.target, 'mac-arm64')
  assert.equal(result.buildRecordSha256, sha(readFileSync(join(root, recordPath))))
  assert.equal(result.archiveSha256, sha(readFileSync(archive)))
  assert.throws(() => validateWebServiceRuntimeInputs(archive, manifestPath, 'mac-arm64', root,
    { platform: 'linux', arch: 'x64' }), /host/iu)
  writeFileSync(join(root, recordPath), JSON.stringify({ ...record, sourceCoreFiles: 1 }))
  assert.throws(() => validateWebServiceRuntimeInputs(archive, manifestPath, 'host', root,
    { platform: 'darwin', arch: 'arm64' }), /build record/iu)
})

test('a failed qualification cannot leave a previous success record', async t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-runtime-stale-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const record = join(root, 'web-service-qualification.json')
  writeFileSync(record, 'old success')
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
  await assert.rejects(() => smokeWebService({ archive: join(root, `missing${extension}`), manifest: join(root, 'missing.json'), out: root }))
  assert.equal(existsSync(record), false)
  assert.equal(existsSync(join(root, '.web-service-qualification.lock')), false)
})

test('a concurrent qualification cannot replace another attempt or its evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-runtime-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const record = join(root, 'web-service-qualification.json'), lock = join(root, '.web-service-qualification.lock')
  writeFileSync(record, 'existing evidence')
  writeFileSync(lock, 'active')
  await assert.rejects(() => smokeWebService({ archive: 'missing', manifest: 'missing', out: root }), /already running/iu)
  assert.equal(readFileSync(record, 'utf8'), 'existing evidence')
  assert.equal(readFileSync(lock, 'utf8'), 'active')
})

test('qualification uses only the scenario-owned temporary home and workspace', t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-qualification-'))
  const unrelated = mkdtempSync(join(tmpdir(), 'map-unrelated-home-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(unrelated, { recursive: true, force: true }) })
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'workspace'))
  const scenario = { temp: root, home: join(root, 'home'), workspace: join(root, 'workspace') }
  const paths = qualificationScenarioPaths(scenario)
  assert.equal(paths.temp, dirname(paths.home))
  assert.throws(() => qualificationScenarioPaths({ ...scenario, home: unrelated }), /unsafe/iu)
  assert.throws(() => qualificationScenarioPaths({ ...scenario, workspace: unrelated }), /unsafe/iu)
})

test('qualification platform selects native launchers and minimal paths', () => {
  const win = qualificationPlatform('win32', { SystemRoot: 'C:\\Windows' })
  assert.equal(win.extension, '.zip')
  assert.equal(win.launcher, 'start-web.cmd')
  assert.match(win.path, /C:\\Windows\\System32/u)
  assert.match(win.path, /WindowsPowerShell/u)
  assert.equal(win.recordedPath, 'Windows system directories')
  assert.throws(() => qualificationPlatform('win32', {}), /SystemRoot/u)
  assert.deepEqual(qualificationPlatform('darwin', {}), {
    extension: '.tar.gz', launcher: 'start-web.sh', path: '/usr/bin:/bin:/usr/sbin:/sbin', recordedPath: '/usr/bin:/bin:/usr/sbin:/sbin',
  })
})

test('Windows invocation preserves spaced paths without interpolating them into shell code', () => {
  const launcher = 'C:\\Users\\A & B\\start-web.cmd'
  const patch = 'C:\\Users\\A & B\\picker.yml'
  const result = windowsLauncherInvocation(launcher, ['--patch', patch], { SystemRoot: 'C:\\Windows', Path: 'C:\\untrusted', Mapharness_Qualify_Arg_0: 'old' })
  assert.equal(result.env.MAPHARNESS_QUALIFY_LAUNCHER, launcher)
  assert.equal(result.env.MAPHARNESS_QUALIFY_ARG_1, patch)
  assert.equal(result.env.Path, undefined)
  assert.equal(result.env.Mapharness_Qualify_Arg_0, undefined)
  assert.ok(!result.commandLine.includes(launcher))
  assert.ok(!result.commandLine.includes(patch))
  assert.match(result.commandLine, /%MAPHARNESS_QUALIFY_LAUNCHER%/u)
  assert.ok(result.commandLine.replace(/"$/u, '').endsWith('<NUL'))
  assert.throws(() => windowsLauncherInvocation(launcher, ['bad"argument'], { SystemRoot: 'C:\\Windows' }), /unsafe/iu)
})

test('Windows ZIP extraction rejects symbolic links, traversal, and wrong archive formats', async t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-zip-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const good = join(root, 'good.zip'), bad = join(root, 'bad.zip')
  writeFileSync(good, zipSync({ 'release/file.txt': Buffer.from('ok') }))
  writeFileSync(bad, zipSync({ 'release/link': [Buffer.from('../../outside'), { os: 3, attrs: 0o120777 << 16 }] }))
  await extractQualificationArchive(good, join(root, 'good'), 'win32')
  assert.equal(readFileSync(join(root, 'good/release/file.txt'), 'utf8'), 'ok')
  await assert.rejects(() => extractQualificationArchive(bad, join(root, 'bad'), 'win32'), /link/iu)
  const traversal = join(root, 'traversal.zip')
  writeFileSync(traversal, zipSync({ '../outside': Buffer.from('bad') }))
  await assert.rejects(() => extractQualificationArchive(traversal, join(root, 'traversal'), 'win32'))
  assert.equal(existsSync(join(root, 'outside')), false)
  await assert.rejects(() => extractQualificationArchive(good, join(root, 'wrong'), 'darwin'), /format/iu)
})

test('Unix archive extraction rejects links before qualification', { skip: process.platform === 'win32' && 'POSIX symlink fixture' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'map-web-tar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'release'))
  writeFileSync(join(root, 'release/file.txt'), 'ok')
  const archive = join(root, 'good.tar.gz')
  createTarArchive({ file: archive, cwd: root, gzip: true, sync: true }, ['release/file.txt'])
  await extractQualificationArchive(archive, join(root, 'out'), 'darwin')
  assert.equal(readFileSync(join(root, 'out/release/file.txt'), 'utf8'), 'ok')
  symlinkSync('../../outside', join(root, 'release/link'))
  const bad = join(root, 'bad.tar.gz')
  createTarArchive({ file: bad, cwd: root, gzip: true, sync: true }, ['release/link'])
  await assert.rejects(() => extractQualificationArchive(bad, join(root, 'bad'), 'darwin'), /link/iu)
})

test('Windows qualification rejects Wine and a failed host probe', () => {
  const env = { SystemRoot: 'C:\\Windows' }
  assert.doesNotThrow(() => assertNativeWindows(env, (_command, args) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    assert.match(script, /wine_get_version/u)
    assert.match(script, /ErrorActionPreference = 'Stop'/u)
    return { status: 0 }
  }))
  assert.throws(() => assertNativeWindows(env, () => ({ status: 3 })), /Wine/iu)
  assert.throws(() => assertNativeWindows(env, () => ({ status: 2 })), /probe/iu)
})

test('Windows process inspection reports failures instead of treating them as no residue', () => {
  const env = { SystemRoot: 'C:\\Windows' }
  assert.deepEqual(windowsQualificationProcesses('C:\\Temp\\release', env, () => ({ status: 0, stdout: '12\r\n34\r\n' })), ['12', '34'])
  assert.throws(() => windowsQualificationProcesses('C:\\Temp\\release', env, () => ({ status: 1 })), /inspect/iu)
})

const windowsEnv = { SystemRoot: 'C:\\Windows' }
const serviceExecutable = 'C:\\Temp\\release\\dsh.exe'

function deferred() {
  let resolve, reject
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function windowsSessionFixture({ rows = [{ pid: 101, parentPid: 4 }], watch, remaining = () => [], timeoutMs = 200, onWrite, onKill } = {}) {
  let onData, onExit, spawned, killed = false, killCount = 0
  const writes = []
  const terminal = {
    onData(callback) { onData = callback },
    onExit(callback) { onExit = callback },
    write(value) { writes.push(value); onWrite?.(value, { sendData, sendExit }) },
    kill() { killCount += 1; killed = true; onKill ? onKill({ sendData, sendExit }) : sendExit({ exitCode: 1 }) },
  }
  const sendData = value => onData(value)
  const sendExit = event => onExit(event)
  const session = windowsQualificationSession({ spawn(...args) { spawned = args; return terminal } },
    'C:\\Temp\\release\\start-web.cmd', ['--port', '6425'], windowsEnv, 'C:\\Temp\\release', {
      executable: serviceExecutable, timeoutMs, processes: () => rows, remaining, ...(watch === undefined ? {} : { watch }),
    })
  return { session, terminal, writes, sendData, sendExit, get killed() { return killed }, get killCount() { return killCount }, get spawned() { return spawned } }
}

async function markWindowsReady(fixture) {
  fixture.sendData('map-harness web: http://127.0.0.1:6425/?token=fixture\n')
  await fixture.session.result
}

function processWatcherChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.killCalls = 0
  child.kill = () => { child.killCalls += 1; return true }
  return child
}

function closeProcessWatcherChild(child, code, signal = null) {
  child.exitCode = code
  child.signalCode = signal
  child.emit('close', code, signal)
}

test('Windows service process inspection passes the exact executable as data and rejects malformed rows', () => {
  let invocation
  const executable = 'C:\\Temp\\A & B\\dsh.exe'
  assert.deepEqual(windowsServiceProcesses(executable, windowsEnv, (...args) => {
    invocation = args
    return { status: 0, stdout: '41 4\r\n42 41\r\n' }
  }), [{ pid: 41, parentPid: 4 }, { pid: 42, parentPid: 41 }])
  assert.equal(invocation[2].env.MAPHARNESS_QUALIFY_SERVICE, executable)
  assert.ok(!invocation[1].at(-1).includes(executable))
  assert.deepEqual(windowsServiceProcesses(executable, windowsEnv, () => ({ status: 0, stdout: '' })), [])
  assert.deepEqual(windowsServiceProcesses(executable, windowsEnv, () => ({ status: 0, stdout: '1 0\r\n4294967295 4294967295\r\n' })),
    [{ pid: 1, parentPid: 0 }, { pid: 4294967295, parentPid: 4294967295 }])
  for (const stdout of ['0 0\n', '-1 1\n', '4294967296 1\n', '1 4294967296\n']) {
    assert.throws(() => windowsServiceProcesses(executable, windowsEnv, () => ({ status: 0, stdout })), /invalid (?:row|identifier)/iu)
  }
  assert.throws(() => windowsServiceProcesses(executable, windowsEnv, () => ({ status: 0, stdout: '41 nope\n' })), /invalid row/iu)
  assert.throws(() => windowsServiceProcesses(executable, windowsEnv, () => ({ status: 0, stdout: '41 4 extra\n' })), /invalid row/iu)
  assert.throws(() => windowsServiceProcesses(executable, windowsEnv, () => ({ status: 1, stdout: '' })), /Cannot inspect/iu)
})

test('Windows qualification uses the root service process, not its helper child', async () => {
  const serviceExit = deferred()
  let observedPid, observedExecutable, observedEnvironment, observedCode
  const fixture = windowsSessionFixture({
    rows: [{ pid: 101, parentPid: 4 }, { pid: 102, parentPid: 101 }, { pid: 103, parentPid: 102 }],
    watch(pid, executable, environment) {
      observedPid = pid
      observedExecutable = executable
      observedEnvironment = environment
      return { armed: Promise.resolve(), exited: serviceExit.promise, close: async () => {}, get exitCode() { return observedCode } }
    },
    onWrite(value, { sendExit }) {
      if (value === '\x03') { observedCode = 130; serviceExit.resolve(130); sendExit({ exitCode: 255 }) }
    },
  })
  await markWindowsReady(fixture)
  await fixture.session.stop()
  assert.equal(observedPid, 101)
  assert.equal(observedExecutable, serviceExecutable)
  assert.equal(observedEnvironment, windowsEnv)
  assert.deepEqual(fixture.writes, ['\x03'])
})

test('Windows qualification rejects zero and ambiguous service roots before Ctrl-C', async t => {
  for (const [name, rows, count] of [
    ['zero roots', [], 0],
    ['ambiguous roots', [{ pid: 101, parentPid: 4 }, { pid: 202, parentPid: 5 }], 2],
  ]) {
    await t.test(name, async () => {
      let watcherCalled = false
      const fixture = windowsSessionFixture({ rows, watch() { watcherCalled = true } })
      await markWindowsReady(fixture)
      await assert.rejects(fixture.session.stop(), new RegExp(`found ${count}`, 'u'))
      assert.equal(watcherCalled, false)
      assert.deepEqual(fixture.writes, [])
    })
  }
})

test('Windows qualification rejects watcher acquisition failure before interrupting service', async () => {
  const fixture = windowsSessionFixture({ watch() { throw new Error('observer unavailable') } })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /observer unavailable/iu)
  assert.deepEqual(fixture.writes, [])
})

test('Windows qualification does not answer a split CMD prompt and accepts wrapper zero with service 130', async () => {
  const serviceExit = deferred(), closeStarted = deferred(), closeGate = deferred()
  const shutdownOrder = []
  let closed = false, observedCode, launcherExited = false, residueChecks = 0
  const fixture = windowsSessionFixture({
    remaining(root) {
      shutdownOrder.push('residue-check')
      residueChecks += 1
      assert.equal(root, 'C:\\Temp\\release')
      assert.equal(observedCode, 130)
      assert.equal(launcherExited, true)
      assert.equal(fixture.killed, residueChecks > 1)
      return []
    },
    watch() {
      return {
        armed: Promise.resolve(), exited: serviceExit.promise,
        async close() { closeStarted.resolve(); await closeGate.promise; closed = true },
        get exitCode() { return observedCode },
      }
    },
    onWrite(value, { sendData, sendExit }) {
      if (value !== '\x03') return
      shutdownOrder.push('ctrl-c')
      sendData('Terminate batch job (Y')
      sendData('/N)?\r\nTerminate batch job (Y/N)?\r\n')
      observedCode = 130
      serviceExit.resolve(130)
      launcherExited = true
      shutdownOrder.push('launcher-exit')
      sendExit({ exitCode: 0 })
    },
    onKill() { shutdownOrder.push('terminal-release') },
  })
  await markWindowsReady(fixture)
  fixture.sendData('Terminate batch job (Y/N)?\r\n')
  assert.deepEqual(fixture.writes, [])
  const stopping = fixture.session.stop()
  let settled = false
  stopping.then(() => { settled = true }, () => { settled = true })
  await closeStarted.promise
  assert.equal(settled, false)
  assert.deepEqual(fixture.writes, ['\x03'])
  closeGate.resolve()
  await stopping
  assert.equal(closed, true)
  assert.deepEqual(shutdownOrder, ['ctrl-c', 'launcher-exit', 'residue-check', 'terminal-release'])
  assert.equal(fixture.killCount, 1)
  await fixture.session.abort()
  assert.equal(fixture.killCount, 1)
  assert.match(fixture.spawned[0], /cmd\.exe$/iu)
})

test('Windows qualification rejects process residue after a clean service exit', async () => {
  const serviceExit = deferred()
  let observedCode, watcherClosed, inspectedRoot
  const fixture = windowsSessionFixture({
    remaining(root) { inspectedRoot = root; return ['102 helper.exe'] },
    watch() {
      return { armed: Promise.resolve(), exited: serviceExit.promise, async close() { watcherClosed = true }, get exitCode() { return observedCode } }
    },
    onWrite(value, { sendExit }) {
      if (value === '\x03') { observedCode = 130; serviceExit.resolve(130); sendExit({ exitCode: 255 }) }
    },
  })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /left processes/iu)
  assert.equal(inspectedRoot, 'C:\\Temp\\release')
  assert.equal(watcherClosed, true)
  assert.equal(fixture.killed, false)
})

test('Windows qualification rejects a wrong service exit even when CMD exits zero', async () => {
  const serviceExit = deferred(), closeStarted = deferred(), closeGate = deferred()
  let closed = false, observedCode
  const fixture = windowsSessionFixture({
    watch() {
      return { armed: Promise.resolve(), exited: serviceExit.promise, async close() { closeStarted.resolve(); await closeGate.promise; closed = true }, get exitCode() { return observedCode } }
    },
    onWrite(value, { sendExit }) {
      if (value === '\x03') { observedCode = 7; serviceExit.resolve(7); sendExit({ exitCode: 0 }) }
    },
  })
  await markWindowsReady(fixture)
  const stopping = fixture.session.stop()
  let settled = false
  stopping.then(() => { settled = true }, () => { settled = true })
  await closeStarted.promise
  assert.equal(settled, false)
  closeGate.resolve()
  await assert.rejects(stopping, /did not exit cleanly.*7/iu)
  assert.equal(closed, true)
})

test('Windows qualification does not release the terminal when residue inspection fails', async () => {
  const serviceExit = deferred()
  let observedCode, watcherClosed
  const fixture = windowsSessionFixture({
    remaining() { throw new Error('residue inspection unavailable') },
    watch() {
      return { armed: Promise.resolve(), exited: serviceExit.promise, async close() { watcherClosed = true }, get exitCode() { return observedCode } }
    },
    onWrite(value, { sendExit }) {
      if (value === '\x03') { observedCode = 130; serviceExit.resolve(130); sendExit({ exitCode: 255 }) }
    },
  })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /residue inspection unavailable/iu)
  assert.equal(watcherClosed, true)
  assert.equal(fixture.killed, false)
})

test('Windows abort releases a naturally exited terminal at most once', async () => {
  const fixture = windowsSessionFixture()
  await markWindowsReady(fixture)
  fixture.sendExit({ exitCode: 0 })
  await fixture.session.abort()
  await fixture.session.abort()
  assert.equal(fixture.killCount, 1)
})

test('Windows readiness rejects an early launcher exit', async () => {
  const fixture = windowsSessionFixture()
  fixture.sendExit({ exitCode: 17 })
  await assert.rejects(fixture.session.result, /exited before readiness: 17/iu)
})

test('Windows qualification rejects a launcher exit while the watcher is arming', async () => {
  const armed = deferred(), watchStarted = deferred()
  const fixture = windowsSessionFixture({
    watch() {
      watchStarted.resolve()
      return { armed: armed.promise, exited: new Promise(() => {}), close: async () => {}, get exitCode() { return undefined } }
    },
  })
  await markWindowsReady(fixture)
  const stopping = fixture.session.stop()
  await watchStarted.promise
  fixture.sendExit({ exitCode: 130 })
  armed.resolve()
  await assert.rejects(stopping, /before Ctrl-C/iu)
  assert.deepEqual(fixture.writes, [])
})

test('Windows qualification rejects an observed service exit while the watcher arms', async () => {
  const armed = deferred(), watchStarted = deferred()
  let observedCode
  const fixture = windowsSessionFixture({
    watch() {
      watchStarted.resolve()
      return { armed: armed.promise, exited: Promise.resolve(130), close: async () => {}, get exitCode() { return observedCode } }
    },
  })
  await markWindowsReady(fixture)
  const stopping = fixture.session.stop()
  await watchStarted.promise
  observedCode = 130
  armed.resolve()
  await assert.rejects(stopping, /before Ctrl-C/iu)
  assert.deepEqual(fixture.writes, [])
})

test('Windows service timeout closes its watcher and abort waits for launcher exit', async () => {
  let watcherClosed = false
  const fixture = windowsSessionFixture({
    timeoutMs: 40,
    watch() {
      return { armed: Promise.resolve(), exited: new Promise(() => {}), async close() { watcherClosed = true }, get exitCode() { return undefined } }
    },
  })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /did not exit after Ctrl-C/iu)
  assert.equal(watcherClosed, true)
  await fixture.session.abort()
  assert.equal(fixture.killed, true)
})

test('Windows launcher timeout closes its watcher and abort waits for launcher exit', async () => {
  let watcherClosed = false, observedCode
  const fixture = windowsSessionFixture({
    timeoutMs: 40,
    watch() {
      return { armed: Promise.resolve(), exited: Promise.resolve(130), async close() { watcherClosed = true }, get exitCode() { return observedCode } }
    },
    onWrite(value) { if (value === '\x03') { observedCode = 130 } },
  })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /launcher did not return/iu)
  assert.equal(watcherClosed, true)
  await fixture.session.abort()
  assert.equal(fixture.killed, true)
})

test('Windows process exit watcher requires a complete protocol and successful close', async () => {
  const child = processWatcherChild()
  let invocation
  const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, (...args) => { invocation = args; return child })
  assert.equal(invocation[2].env.MAPHARNESS_QUALIFY_PID, '42')
  assert.equal(invocation[2].env.MAPHARNESS_QUALIFY_SERVICE, serviceExecutable)
  const script = invocation[1].at(-1)
  assert.match(script, /MainModule\.FileName/u)
  assert.match(script, /OrdinalIgnoreCase/u)
  assert.ok(script.indexOf('$process.Handle') < script.indexOf('MainModule.FileName'))
  assert.ok(script.indexOf('MainModule.FileName') < script.indexOf("'armed'"))
  assert.ok(!script.includes('42'))
  assert.ok(!script.includes(serviceExecutable))
  assert.ok(!invocation[1].at(-1).includes(serviceExecutable))
  child.stdout.write('arm')
  child.stdout.write('ed\r')
  child.stdout.write('\nexit=13')
  child.stdout.write('0\r\n')
  await watcher.armed
  let resolved = false
  watcher.exited.then(() => { resolved = true }, () => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  closeProcessWatcherChild(child, 0)
  assert.equal(await watcher.exited, 130)
  await watcher.close()
  assert.equal(watcher.exitCode, 130)
})

test('Windows process exit watcher bounds close when the observer never exits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = processWatcherChild()
  const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
  const closing = watcher.close()
  t.mock.timers.tick(30000)
  await assert.rejects(closing, /did not close/iu)
  assert.equal(child.killCalls, 1)
})

test('Windows abort rejects residual processes after releasing an exited terminal', async () => {
  let inspected = false, fixture
  fixture = windowsSessionFixture({
    remaining(root, environment) {
      inspected = true
      assert.equal(root, 'C:\\Temp\\release')
      assert.equal(environment, windowsEnv)
      assert.equal(fixture.killed, true)
      return ['102 helper.exe']
    },
  })
  await markWindowsReady(fixture)
  fixture.sendExit({ exitCode: 255 })
  await assert.rejects(fixture.session.abort(), /cleanup left processes/iu)
  assert.equal(inspected, true)
  assert.equal(fixture.killCount, 1)
})

test('Windows qualification rejects a nonzero observer close even when CMD exits zero', async () => {
  const child = processWatcherChild()
  let observer
  const fixture = windowsSessionFixture({
    watch(pid, executable, env) {
      observer = watchWindowsProcessExit(pid, executable, env, () => child)
      child.stdout.write('armed\n')
      return observer
    },
    onWrite(value, { sendExit }) {
      if (value === '\x03') {
        child.stdout.write('exit=130\n')
        closeProcessWatcherChild(child, 1)
        sendExit({ exitCode: 0 })
      }
    },
  })
  await markWindowsReady(fixture)
  await assert.rejects(fixture.session.stop(), /complete successful exit report/iu)
  assert.equal(observer.exitCode, 130)
})

test('Windows process exit watcher rejects invalid pid without spawning an observer', () => {
  let spawned = false
  assert.throws(() => watchWindowsProcessExit(0, serviceExecutable, windowsEnv, () => { spawned = true }), /process identifier/iu)
  assert.throws(() => watchWindowsProcessExit(42, 'relative.exe', windowsEnv, () => { spawned = true }), /absolute executable/iu)
  assert.equal(spawned, false)
})

test('Windows process exit watcher rejects observer startup, partial protocol, and close failures', async t => {
  await t.test('observer spawn error', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    child.emit('error', new Error('spawn denied'))
    closeProcessWatcherChild(child, -2)
    await assert.rejects(watcher.armed, /could not start or monitor/iu)
    await assert.rejects(watcher.exited, /could not start or monitor/iu)
    await watcher.close()
  })
  await t.test('partial exit record at close', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    child.stdout.write('armed\nexit=130')
    closeProcessWatcherChild(child, 0)
    await assert.rejects(watcher.exited, /complete successful exit report/iu)
    await watcher.close()
  })
  await t.test('malformed process exit line', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    child.stdout.write('armed\nnot-an-exit-record\n')
    closeProcessWatcherChild(child, 0)
    await assert.rejects(watcher.exited, /invalid process exit report/iu)
    await watcher.close()
  })
  await t.test('close before armed', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    closeProcessWatcherChild(child, 0)
    await assert.rejects(watcher.armed, /ended|close|protocol/iu)
    await assert.rejects(watcher.exited, /ended|close|protocol/iu)
    await watcher.close()
  })
  await t.test('close after armed but before exit', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    child.stdout.write('armed\n')
    await watcher.armed
    closeProcessWatcherChild(child, 0)
    await assert.rejects(watcher.exited, /ended|close|protocol/iu)
    await watcher.close()
  })
  await t.test('nonzero observer exit after complete output', async () => {
    const child = processWatcherChild()
    const watcher = watchWindowsProcessExit(42, serviceExecutable, windowsEnv, () => child)
    child.stdout.write('armed\nexit=130\n')
    await watcher.armed
    closeProcessWatcherChild(child, 1)
    await assert.rejects(watcher.exited, /close|observer|status|exit/iu)
    await watcher.close()
    assert.equal(watcher.exitCode, 130)
  })
})
