import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareMapInstance, resolveMapInstance } from '../bin/instance-home.mjs'
import {
  acquireInstanceLock, inspectInstanceState, INSTANCE_LOCK_DIRECTORY, INSTANCE_LOCK_FILE,
  INSTANCE_RECORD_FILE, probeInstanceLock, readInstanceRecord,
} from '../bin/instance-lock.mjs'
import { trackedTmpDir } from './support/reliability.mjs'

const repo = join(import.meta.dirname, '../..')
const lockModuleUrl = pathToFileURL(join(repo, 'map/bin/instance-lock.mjs')).href
const processBudget = 30000
const posixOnly = process.platform === 'win32' ? 'Requires POSIX signals, permissions, or file symlinks without administrator privileges' : false

function fixture(t) {
  const directory = trackedTmpDir('instance-lock')
  const root = realpathSync(directory.path)
  const cleanups = []
  t.after(async () => {
    const failures = []
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Fixture cleanup did not settle: ${root}`)
    await directory.dispose()
  })
  const user = join(root, 'user')
  mkdirSync(user)
  return { root, user, cleanups }
}

function specFor(item, name = 'data') {
  return prepareMapInstance(resolveMapInstance({
    mode: 'release', env: { MAPHARNESS_HOME: join(item.root, name) }, homedir: item.user, cwd: item.root,
  }))
}

function recordPath(spec) {
  return join(spec.home, INSTANCE_LOCK_DIRECTORY, INSTANCE_RECORD_FILE)
}

function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const path = join(root, entry.name)
    return [entry.name, entry.isDirectory() ? snapshot(path) : entry.isSymbolicLink() ? 'link' : readFileSync(path).toString('hex')]
  })
}

function bounded(promise, label) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), processBudget)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/** Own the child through close, including spawn failure, stderr drain, and failed readiness. */
function start(item, program, { executable = process.execPath } = {}) {
  const child = spawn(executable, ['--input-type=module', '-e', program], {
    cwd: item.root, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries({
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: item.user, USERPROFILE: item.user,
    }).filter(([, value]) => value !== undefined)),
  })
  let stdout = '', stderr = '', error, result
  const messages = []
  const waiters = new Set()
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const diagnostic = label => new Error(`${label}: code=${result?.code} signal=${result?.signal} error=${error?.code}\n${stderr}\n${stdout}`)
  child.on('error', value => {
    error = value
    for (const waiter of waiters) waiter.reject(diagnostic('Child failed before its message'))
    waiters.clear()
  })
  child.on('message', message => {
    const waiter = waiters.values().next().value
    if (waiter === undefined) messages.push(message)
    else { waiters.delete(waiter); waiter.resolve(message) }
  })
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })) })
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      result = { code, signal, error, stdout, stderr }
      for (const waiter of waiters) waiter.reject(diagnostic('Child closed before its message'))
      waiters.clear()
      resolve(result)
    })
  })
  item.cleanups.push(async () => {
    if (result === undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await bounded(closed, 'child close during teardown')
  })
  return {
    child, closed, exited, isClosed: () => result !== undefined,
    async message() {
      if (messages.length > 0) return messages.shift()
      if (result !== undefined || error !== undefined) throw diagnostic('Child ended before its message')
      let waiter
      const pending = new Promise((resolve, reject) => { waiter = { resolve, reject }; waiters.add(waiter) })
      try { return await bounded(pending, 'child readiness or protocol message') } finally { waiters.delete(waiter) }
    },
    async success() {
      const outcome = await bounded(closed, 'child close')
      assert.equal(outcome.error, undefined, diagnostic('Child spawn failed').message)
      assert.equal(outcome.signal, null, diagnostic('Child ended by a signal').message)
      assert.equal(outcome.code, 0, diagnostic('Child failed').message)
      return outcome
    },
  }
}

async function lease(item, spec, metadata) {
  const value = await acquireInstanceLock(spec, metadata)
  item.cleanups.push(value.release)
  return value
}

function holder(item, spec, { simultaneous = false } = {}) {
  return start(item, `
    import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    if (${simultaneous}) {
      process.send('ready');
      await new Promise(resolve => process.once('message', resolve));
    }
    let held;
    try { held = await acquireInstanceLock(${JSON.stringify(spec)}, { version: '1.2.3' }); }
    catch (error) {
      if (error.code !== 'MAP_INSTANCE_BUSY') throw error;
      process.send({ state: 'busy' });
      process.disconnect();
    }
    if (held !== undefined) {
      process.stdin.resume();
      process.stdin.once('end', async () => { await held.release(); process.disconnect(); });
      process.send({ state: 'held', record: held.record });
    }
  `)
}

function rawRecord(spec, extra = {}) {
  return {
    format: 1, productId: spec.productId, instanceId: spec.instanceId, generationId: randomUUID(),
    version: '1.2.3', pid: process.pid, startedAt: '2026-01-02T03:04:05.000Z', state: 'running', ...extra,
  }
}

function putRecord(spec, value) {
  mkdirSync(join(spec.home, INSTANCE_LOCK_DIRECTORY), { recursive: true, mode: 0o700 })
  writeFileSync(recordPath(spec), `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

test('readiness reports spawn and startup failure immediately with the child diagnostic', { timeout: processBudget }, async t => {
  const item = fixture(t)
  const missing = start(item, '', { executable: join(item.root, 'missing-node') })
  await assert.rejects(missing.message(), /ENOENT/u)
  await missing.closed
  const crashed = start(item, 'throw new Error("startup fixture failure")')
  await assert.rejects(crashed.message(), /startup fixture failure/u)
  await crashed.closed
})

test('never-started and existing free locks probe stopped without creating or modifying files', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const before = snapshot(spec.home)
  assert.equal(await probeInstanceLock(spec), 'stopped')
  assert.equal(await inspectInstanceState(spec), 'stopped')
  assert.deepEqual(snapshot(spec.home), before)
  const directory = join(spec.home, INSTANCE_LOCK_DIRECTORY)
  mkdirSync(directory, { mode: 0o700 })
  assert.equal(await probeInstanceLock(spec), 'stopped')
  writeFileSync(join(directory, INSTANCE_LOCK_FILE), 'stable inode bytes', { mode: 0o600 })
  const afterLock = snapshot(spec.home)
  assert.equal(await probeInstanceLock(spec), 'stopped')
  assert.deepEqual(snapshot(spec.home), afterLock)
  assert.equal(existsSync(recordPath(spec)), false)
})

test('invalid diagnostic metadata is rejected before touching the lock namespace', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const before = snapshot(spec.home)
  for (const metadata of [{ version: 'fixture' }, { generationId: 'not-a-uuid' }, { now: 'not-an-iso-date' }, { now: '2026-02-31T00:00:00.000Z' }]) {
    await assert.rejects(acquireInstanceLock(spec, metadata), { code: 'MAP_HOME_INPUT' })
    assert.deepEqual(snapshot(spec.home), before)
  }
})

test('stale running records never mean locked, and damaged markers report unknown without writes', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  putRecord(spec, rawRecord(spec))
  writeFileSync(join(spec.home, INSTANCE_LOCK_DIRECTORY, INSTANCE_LOCK_FILE), '')
  assert.equal(readInstanceRecord(spec).state, 'running')
  const before = snapshot(spec.home)
  assert.equal(await inspectInstanceState(spec), 'stopped')
  assert.deepEqual(snapshot(spec.home), before)
  const marker = join(spec.home, 'map-instance.json')
  for (const bad of ['{broken', JSON.stringify({ ...spec.marker, identityRevision: 99 }), JSON.stringify({ ...spec.marker, createdAt: 'secret' })]) {
    writeFileSync(marker, bad)
    const invalid = snapshot(spec.home)
    assert.equal(await probeInstanceLock(spec), 'unknown')
    await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' })
    assert.deepEqual(snapshot(spec.home), invalid)
  }
  unlinkSync(marker)
  assert.equal(await probeInstanceLock(spec), 'unknown')
})

test('one root has one kernel writer; busy and probes preserve bytes, and release removes its listener', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const beforeListeners = process.listenerCount('exit')
  const first = await lease(item, spec, { version: '1.2.3' })
  assert.match(first.record.generationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  assert.equal(process.listenerCount('exit'), beforeListeners + 1)
  assert.equal(first.lockPath, join(spec.home, INSTANCE_LOCK_DIRECTORY, INSTANCE_LOCK_FILE))
  if (process.platform !== 'win32') {
    assert.equal(statSync(first.lockPath).mode & 0o777, 0o600)
    assert.equal(statSync(recordPath(spec)).mode & 0o777, 0o600)
    assert.equal(statSync(join(spec.home, INSTANCE_LOCK_DIRECTORY)).mode & 0o777, 0o700)
  }
  const before = snapshot(spec.home)
  await assert.rejects(acquireInstanceLock(spec), error => {
    assert.equal(error.code, 'MAP_INSTANCE_BUSY')
    assert.deepEqual(error.details.record, first.record)
    return true
  })
  for (let index = 0; index < 3; index++) assert.equal(await probeInstanceLock(spec), 'locked')
  assert.equal(await inspectInstanceState(spec), 'locked')
  assert.deepEqual(snapshot(spec.home), before)
  assert.equal(process.listenerCount('exit'), beforeListeners + 1)
  await first.release()
  await first.release()
  assert.equal(process.listenerCount('exit'), beforeListeners)
  assert.equal(readInstanceRecord(spec).state, 'stopped')
  assert.equal(await probeInstanceLock(spec), 'stopped')
  const next = await lease(item, spec)
  assert.notEqual(next.record.generationId, first.record.generationId)
  await first.release()
  assert.deepEqual(readInstanceRecord(spec), next.record)
  await next.release()
  assert.equal(process.listenerCount('exit'), beforeListeners)
})

test('simultaneous first lock contenders have exactly one writer and different roots coexist', { timeout: processBudget }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const contenders = [holder(item, spec, { simultaneous: true }), holder(item, spec, { simultaneous: true })]
  assert.deepEqual(await Promise.all(contenders.map(child => child.message())), ['ready', 'ready'])
  const outcomes = contenders.map(child => child.message())
  for (const child of contenders) child.child.send('go')
  const states = await Promise.all(outcomes)
  assert.deepEqual(states.map(state => state.state).sort(), ['busy', 'held'])
  const winner = contenders[states.findIndex(state => state.state === 'held')]
  const loser = contenders[states.findIndex(state => state.state === 'busy')]
  await loser.success()
  const otherSpec = specFor(item, 'other')
  const other = holder(item, otherSpec)
  assert.equal((await other.message()).state, 'held')
  assert.equal(await probeInstanceLock(spec), 'locked')
  assert.equal(await probeInstanceLock(otherSpec), 'locked')
  winner.child.stdin.end()
  other.child.stdin.end()
  await Promise.all([winner.success(), other.success()])
  assert.equal(await probeInstanceLock(spec), 'stopped')
  assert.equal(await probeInstanceLock(otherSpec), 'stopped')
})

test('SIGKILL releases the kernel lease, not the stale running record', { timeout: processBudget, skip: posixOnly }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const first = holder(item, spec)
  assert.equal((await first.message()).state, 'held')
  first.child.kill('SIGKILL')
  const outcome = await first.closed
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.signal, 'SIGKILL')
  assert.equal(outcome.code, null)
  assert.equal(readInstanceRecord(spec).state, 'running')
  assert.equal(await probeInstanceLock(spec), 'stopped')
  const next = await lease(item, spec)
  await next.release()
})

test('the service child keeps its lease after the launcher dies and closes before fixture removal', { timeout: processBudget, skip: posixOnly }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const serviceProgram = `
    import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    const held = await acquireInstanceLock(${JSON.stringify(spec)});
    const keepAlive = setInterval(() => {}, 0x7fffffff);
    process.once('SIGTERM', async () => {
      await held.release(); clearInterval(keepAlive);
      process.stdout.write('service-released\\n', () => process.exit(0));
    });
    process.send('held');
  `
  const launcher = start(item, `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(serviceProgram)}], {
      stdio: [0, 1, 2, 'ipc'], env: process.env,
    });
    child.once('spawn', () => process.send({ pid: child.pid }));
    child.once('message', () => process.send('held'));
    child.once('error', error => { throw error });
    child.once('close', (code, signal) => { throw new Error('service exited before launcher: ' + code + '/' + signal) });
  `)
  const { pid } = await launcher.message()
  assert.equal(Number.isInteger(pid), true)
  item.cleanups.push(async () => {
    if (!launcher.isClosed()) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await bounded(launcher.closed, 'orphan service inherited streams to close')
  })
  assert.equal(await launcher.message(), 'held')
  launcher.child.kill('SIGKILL')
  const exited = await bounded(launcher.exited, 'launcher exit')
  assert.equal(exited.signal, 'SIGKILL')
  assert.equal(exited.code, null)
  assert.equal(launcher.isClosed(), false)
  assert.equal(await probeInstanceLock(spec), 'locked')
  await assert.rejects(lease(item, spec), { code: 'MAP_INSTANCE_BUSY' })
  process.kill(pid, 'SIGTERM')
  const outcome = await bounded(launcher.closed, 'service inherited streams to close after termination')
  assert.match(outcome.stdout, /service-released/u)
  assert.equal(readInstanceRecord(spec).state, 'stopped')
  assert.equal(await probeInstanceLock(spec), 'stopped')
})

test('release publishes stopped before descriptor close and never overwrites a successor after close', { timeout: processBudget, skip: posixOnly }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const first = start(item, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { acquireInstanceLock } = await import(${JSON.stringify(lockModuleUrl)});
    const originalOpen = fs.openSync, originalClose = fs.closeSync;
    let lockFd;
    fs.openSync = (...args) => { const fd = originalOpen(...args); if (args[0] === ${JSON.stringify(join(spec.home, INSTANCE_LOCK_DIRECTORY, INSTANCE_LOCK_FILE))}) lockFd = fd; return fd; };
    syncBuiltinESMExports();
    const held = await acquireInstanceLock(${JSON.stringify(spec)});
    fs.closeSync = fd => {
      if (fd === lockFd) {
        const record = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath(spec))}, 'utf8'));
        process.send({ phase: 'before-close', state: record.state });
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        originalClose(fd);
        process.send({ phase: 'after-close' });
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        return;
      }
      return originalClose(fd);
    };
    syncBuiltinESMExports();
    await held.release();
    process.disconnect();
  `)
  assert.deepEqual(await first.message(), { phase: 'before-close', state: 'stopped' })
  assert.equal(await probeInstanceLock(spec), 'locked')
  const afterClose = first.message()
  first.child.stdin.write('x')
  assert.deepEqual(await afterClose, { phase: 'after-close' })
  const successor = await lease(item, spec)
  const successorBytes = readFileSync(recordPath(spec))
  first.child.stdin.write('x')
  await first.success()
  assert.deepEqual(readFileSync(recordPath(spec)), successorBytes)
  assert.equal(await probeInstanceLock(spec), 'locked')
  await successor.release()
})

test('release preserves records with a different instance or generation', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  for (const extra of [{ generationId: randomUUID() }, { instanceId: randomUUID() }]) {
    const held = await lease(item, spec)
    putRecord(spec, { ...held.record, ...extra })
    const other = readFileSync(recordPath(spec))
    await held.release()
    assert.deepEqual(readFileSync(recordPath(spec)), other)
    assert.equal(await probeInstanceLock(spec), 'stopped')
  }
})

test('record parsing bounds bytes and returns only validated non-secret fields, including on busy', async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const held = await lease(item, spec, { version: '1.2.3' })
  putRecord(spec, { ...held.record, token: 'sentinel-credential', home: 'sentinel-credential', origin: 'https://example.invalid/?token=sentinel-credential', nested: { secret: 'sentinel-credential' } })
  assert.deepEqual(readInstanceRecord(spec), held.record)
  await assert.rejects(acquireInstanceLock(spec), error => {
    assert.deepEqual(error.details.record, held.record)
    assert.doesNotMatch(JSON.stringify(error.details), /sentinel-credential/u)
    return error.code === 'MAP_INSTANCE_BUSY'
  })
  const invalid = [null, [], {}, { ...held.record, pid: -1 }, { ...held.record, version: 'secret://token' },
    { ...held.record, generationId: 'secret' }, { ...held.record, startedAt: 'secret' },
    { ...held.record, state: 'ready' }, { ...held.record, state: 'stopped', stoppedAt: 'secret' },
    { ...held.record, instanceId: randomUUID() }, { ...held.record, extra: 'x'.repeat(5000) }]
  for (const value of invalid) { putRecord(spec, value); assert.equal(readInstanceRecord(spec), undefined) }
  writeFileSync(recordPath(spec), '{"secret":"sentinel-credential"')
  assert.equal(readInstanceRecord(spec), undefined)
  await held.release()
})

test('linked directories and junctions are not lock namespaces or diagnostic records', async t => {
  const item = fixture(t)
  for (const kind of ['home', 'directory', 'lock', 'record']) {
    const spec = specFor(item, kind)
    const outside = join(item.root, `outside-${kind}`)
    mkdirSync(outside)
    const directory = join(spec.home, INSTANCE_LOCK_DIRECTORY)
    if (kind !== 'home') mkdirSync(directory)
    const path = kind === 'home' ? spec.home : kind === 'directory' ? directory
      : join(directory, kind === 'lock' ? INSTANCE_LOCK_FILE : INSTANCE_RECORD_FILE)
    if (kind === 'home') renameSync(spec.home, join(item.root, 'preserved-home'))
    if (kind === 'directory') rmSync(directory, { recursive: true })
    symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' })
    assert.equal(await probeInstanceLock(spec), 'unknown')
    assert.equal(readInstanceRecord(spec), undefined)
    assert.deepEqual(readdirSync(outside), [])
    unlinkSync(path)
  }
})

test('file symlinks, hardlinks, and retargeted ancestors leave their targets unchanged', { skip: posixOnly }, async t => {
  const item = fixture(t)
  const target = join(item.root, 'sentinel')
  writeFileSync(target, 'sentinel-credential')
  for (const type of ['symlink', 'hardlink']) {
    for (const name of [INSTANCE_LOCK_FILE, INSTANCE_RECORD_FILE]) {
      const spec = specFor(item, `${type}-${name}`)
      const directory = join(spec.home, INSTANCE_LOCK_DIRECTORY)
      mkdirSync(directory)
      const path = join(directory, name)
      if (type === 'symlink') symlinkSync(target, path)
      else linkSync(target, path)
      await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' })
      assert.equal(await probeInstanceLock(spec), 'unknown')
      assert.equal(readInstanceRecord(spec), undefined)
      assert.equal(readFileSync(target, 'utf8'), 'sentinel-credential')
      unlinkSync(path)
    }
  }
  const parent = join(item.root, 'parent')
  mkdirSync(parent)
  const spec = specFor(item, 'parent/child')
  renameSync(parent, `${parent}-moved`)
  symlinkSync(`${parent}-moved`, parent)
  const before = snapshot(`${parent}-moved`)
  await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' })
  assert.equal(await probeInstanceLock(spec), 'unknown')
  assert.deepEqual(snapshot(`${parent}-moved`), before)
  unlinkSync(parent)
})

test('read-only lock paths are probed without write access and unreadable markers are unknown', { skip: posixOnly || (process.getuid() === 0 ? 'Root bypasses POSIX mode checks' : false) }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const held = await lease(item, spec)
  await held.release()
  const directory = join(spec.home, INSTANCE_LOCK_DIRECTORY)
  const marker = join(spec.home, 'map-instance.json')
  item.cleanups.push(() => { chmodSync(directory, 0o700); chmodSync(held.lockPath, 0o600); chmodSync(marker, 0o600) })
  chmodSync(directory, 0o500)
  chmodSync(held.lockPath, 0o400)
  assert.equal(await probeInstanceLock(spec), 'stopped')
  chmodSync(marker, 0)
  assert.equal(await probeInstanceLock(spec), 'unknown')
  assert.equal(readInstanceRecord(spec), undefined)
})

test('publication and stopped-record failures close descriptors before recovery and dispose listeners', { timeout: processBudget }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const child = start(item, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeFileSync };
    const descriptors = new Set();
    fs.openSync = (...args) => { const fd = original.open(...args); descriptors.add(fd); return fd };
    fs.closeSync = fd => { original.close(fd); descriptors.delete(fd) };
    let failure = 'running';
    fs.writeFileSync = (...args) => {
      if (typeof args[0] === 'number' && String(args[1]).includes('"state": "' + failure + '"')) {
        failure = undefined; throw Object.assign(new Error('diagnostic write fixture'), { code: 'EIO' });
      }
      return original.write(...args);
    };
    syncBuiltinESMExports();
    const { acquireInstanceLock, probeInstanceLock } = await import(${JSON.stringify(lockModuleUrl)});
    const spec = ${JSON.stringify(spec)};
    const listeners = process.listenerCount('exit');
    await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' });
    assert.equal(descriptors.size, 0);
    assert.equal(process.listenerCount('exit'), listeners);
    assert.equal(await probeInstanceLock(spec), 'stopped');
    const held = await acquireInstanceLock(spec);
    failure = 'stopped';
    await assert.rejects(held.release(), error => error.code === 'MAP_INSTANCE_RELEASE_FAILED' && error.details.lockReleased === true);
    assert.equal(descriptors.size, 0);
    assert.equal(process.listenerCount('exit'), listeners);
    fs.writeFileSync = original.write; syncBuiltinESMExports();
    const next = await acquireInstanceLock(spec); await next.release();
    assert.equal(descriptors.size, 0);
    console.log('descriptors-closed');
  `)
  assert.match((await child.success()).stdout, /descriptors-closed/u)
})

test('process exit records stopped while disposing its owned lease', { timeout: processBudget }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const child = start(item, `
    import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    await acquireInstanceLock(${JSON.stringify(spec)});
    process.exit(0);
  `)
  await child.success()
  assert.equal(readInstanceRecord(spec).state, 'stopped')
  assert.equal(await probeInstanceLock(spec), 'stopped')
})

test('missing native modules and missing addon payloads fail closed rather than granting test locks', { timeout: processBudget, skip: posixOnly }, async t => {
  const item = fixture(t)
  for (const failure of ['import', 'addon']) {
    const spec = specFor(item, failure)
    const child = start(item, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { registerHooks, syncBuiltinESMExports } from 'node:module';
      const native = '@deepseek-ai/node-addon-system/flock';
      const stub = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify("export async function tryLockExclusive() { throw Object.assign(new Error('native payload absent'), { code: 'ERR_DLOPEN_FAILED' }) }")});
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === native) {
          if (${JSON.stringify(failure)} === 'import') throw Object.assign(new Error('module absent'), { code: 'ERR_MODULE_NOT_FOUND' });
          return { url: stub, shortCircuit: true };
        }
        return next(specifier, context);
      } });
      const originalOpen = fs.openSync, originalClose = fs.closeSync;
      const descriptors = new Set();
      fs.openSync = (...args) => { const fd = originalOpen(...args); descriptors.add(fd); return fd };
      fs.closeSync = fd => { originalClose(fd); descriptors.delete(fd) };
      syncBuiltinESMExports();
      const { acquireInstanceLock, probeInstanceLock } = await import(${JSON.stringify(lockModuleUrl)});
      const spec = ${JSON.stringify(spec)};
      await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' });
      assert.equal(fs.existsSync(${JSON.stringify(recordPath(spec))}), false);
      const lockPath = ${JSON.stringify(join(spec.home, INSTANCE_LOCK_DIRECTORY, INSTANCE_LOCK_FILE))};
      if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '');
      assert.equal(await probeInstanceLock(spec), 'unknown');
      assert.equal(descriptors.size, 0);
      console.log('closed-without-record');
    `)
    assert.match((await child.success()).stdout, /closed-without-record/u)
  }
})

test('Windows FFI contract closes handles on busy, wait errors, write errors, release errors, and probes', { timeout: processBudget }, async t => {
  const item = fixture(t)
  const spec = specFor(item)
  const mock = `
    import assert from 'node:assert/strict';
    export const state = { calls: [], handles: new Map(), counts: new Map(), next: 500, waitError: false, releaseError: false, createError: false, libraries: 0 };
    export default { load(name) {
      assert.equal(name, 'kernel32.dll'); state.libraries++;
      let unloaded = false;
      return {
        unload() { assert.equal(unloaded, false); unloaded = true; state.libraries-- },
        func(convention, name, result, args) {
          assert.equal(convention, '__stdcall');
          if (name === 'CloseHandle') assert.deepEqual([result, args], ['int', ['intptr']]);
          if (name === 'ReleaseSemaphore') assert.deepEqual(args, ['intptr', 'int', 'void*']);
          return (...values) => {
            assert.equal(unloaded, false);
            state.calls.push([name, ...values]);
            if (name === 'CreateSemaphoreW') {
              if (state.createError) return 0;
              const name = values[3]; if (!state.counts.has(name)) state.counts.set(name, 1);
              const handle = state.next++; state.handles.set(handle, name); return handle;
            }
            if (name === 'WaitForSingleObject') {
              assert.equal(values[1], 0); if (state.waitError) return 0xffffffff;
              const name = state.handles.get(values[0]);
              if (state.counts.get(name) === 0) return 0x102;
              state.counts.set(name, 0); return 0;
            }
            if (name === 'ReleaseSemaphore') {
              if (state.releaseError) return 0;
              state.counts.set(state.handles.get(values[0]), 1); return 1;
            }
            if (name === 'CloseHandle') {
              const name = state.handles.get(values[0]); assert.ok(state.handles.delete(values[0]));
              if (![...state.handles.values()].includes(name)) state.counts.delete(name);
              return 1;
            }
            if (name === 'GetLastError') return 5;
            throw new Error('Unexpected API ' + name);
          };
        },
      };
    } };
  `
  const child = start(item, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'koffi') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(mock)}), shortCircuit: true };
      return next(specifier, context);
    } });
    const { state } = await import('koffi');
    const { acquireInstanceLock, probeInstanceLock } = await import(${JSON.stringify(lockModuleUrl)});
    const spec = ${JSON.stringify(spec)};
    for (const field of ['createError', 'waitError']) {
      state[field] = true;
      await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' });
      state[field] = false;
      assert.equal(state.handles.size, 0); assert.equal(state.libraries, 0);
    }
    const owner = await acquireInstanceLock(spec);
    await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_BUSY' });
    assert.equal(await probeInstanceLock(spec), 'locked');
    assert.equal(state.handles.size, 1); assert.equal(state.libraries, 1);
    await owner.release();
    assert.equal(state.handles.size, 0); assert.equal(state.libraries, 0);
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw Object.assign(new Error('write failed'), { code: 'EIO' }) };
    syncBuiltinESMExports();
    await assert.rejects(acquireInstanceLock(spec), { code: 'MAP_INSTANCE_LOCK_FAILED' });
    fs.writeFileSync = originalWrite; syncBuiltinESMExports();
    assert.equal(state.handles.size, 0); assert.equal(state.libraries, 0);
    const failingRelease = await acquireInstanceLock(spec);
    state.releaseError = true;
    await assert.rejects(failingRelease.release(), { code: 'MAP_INSTANCE_RELEASE_FAILED' });
    state.releaseError = false;
    assert.equal(state.handles.size, 0); assert.equal(state.libraries, 0);
    assert.equal(await probeInstanceLock(spec), 'stopped');
    assert.equal(state.handles.size, 0); assert.equal(state.libraries, 0);
    assert.ok(state.calls.some(row => row[0] === 'CloseHandle'));
    console.log('ffi-contract-only');
  `)
  assert.match((await child.success()).stdout, /ffi-contract-only/u)
})
