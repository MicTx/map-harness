import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifyWebPackage, superviseWeb, prepareCredentials } from '../bin/web-onboarding.mjs'

const require = createRequire(new URL('../tools/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(`${name}/package.json`)).href, { with: { type: 'json' } })

async function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-web-onboarding-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

async function fixture(t, { fakeService = true } = {}) {
  const root = await temp(t)
  const target = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`
  const directory = join(root, target)
  mkdirSync(directory)
  const service = join(directory, 'service')
  if (fakeService) {
    writeFileSync(service, '#!/bin/sh\nprintf \'service\\n\'\nprintf \'%s\\n\' "$@"\n')
    chmodSync(service, 0o755)
  }
  const build = { format: 'map-harness-native-1', version: '0.1.13', target,
    engine: { node: process.version, platform: process.platform, arch: process.arch },
    executable: 'service', sha256: fakeService ? digestFile(service) : '0'.repeat(64), sourceCoreFiles: 0,
    webService: { format: 1, mode: 'web', profile: 'map-web' }, resources: {} }
  const record = join(directory, 'service.json')
  writeFileSync(record, JSON.stringify(build))
  const files = [
    { path: `${target}/service`, role: 'service', target, executable: true, sha256: build.sha256 },
    { path: `${target}/service.json`, role: 'build-record', target, executable: false, sha256: digestFile(record) },
  ]
  writeFileSync(join(root, 'web-service-manifest.json'), JSON.stringify({ format: 1, product: 'map-harness', version: '0.1.13',
    targets: [{ target, record: `${target}/service.json` }], supportedTargets: [target], unsupportedTargets: [], files }))
  return { root, target, service, record }
}

function digestFile(path) {
  return spawnSync(process.execPath, ['--eval', `const {readFileSync}=require('node:fs');const {createHash}=require('node:crypto');console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))`, path], { encoding: 'utf8' }).stdout.trim()
}

async function credentials(root, environment = {}) {
  const { Context } = await import('../../vendor/cordis/lib/index.js')
  const { LocalCredentialProvider } = await import('../../packages/credentials/credentials-local/lib/index.js')
  const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await import('../../packages/util/launch-environment/lib/index.js')
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: root, watch: false })
  await fiber
  return { ctx, fiber }
}

async function credentialDependencies() {
  const { Context } = await import('../../vendor/cordis/lib/index.js')
  const { LocalCredentialProvider } = await import('../../packages/credentials/credentials-local/lib/index.js')
  const { loadLayeredEnv } = await import('../../packages/boot/app-boot/lib/index.js')
  const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import('../../packages/util/launch-environment/lib/index.js')
  return { Context, LocalCredentialProvider, loadLayeredEnv, DSH_LAUNCH_ENVIRONMENT_KEY }
}

test('native validation accepts the real host and rejects traversal and missing targets', async t => {
  const item = await fixture(t)
  const accepted = await verifyWebPackage(item.root)
  assert.equal(accepted.service, item.service)
  const manifest = JSON.parse(readFileSync(join(item.root, 'web-service-manifest.json'), 'utf8'))
  manifest.files[0].path = '../escape'
  writeFileSync(join(item.root, 'web-service-manifest.json'), JSON.stringify(manifest))
  await assert.rejects(() => verifyWebPackage(item.root), /unsafe/u)
  await assert.rejects(() => verifyWebPackage(item.root, 'freebsd', process.arch), /unsupported/u)
})

test('credential store persists without exposing the value and wins over ambient fallback', async t => {
  const home = await temp(t)
  const first = await credentials(home)
  try {
    await first.ctx.credentials.set('DEEPSEEK_API_KEY', 'onboarding-test-secret')
    assert.deepEqual(await first.ctx.credentials.describe('DEEPSEEK_API_KEY'), {
      configured: true, source: 'file', writable: true, masked: '••••••••••••••••••••••',
    })
  } finally { await first.fiber.dispose() }
  const second = await credentials(home, { DEEPSEEK_API_KEY: 'ambient-other-secret' })
  try {
    assert.equal((await second.ctx.credentials.resolve('DEEPSEEK_API_KEY')).value, 'onboarding-test-secret')
  } finally { await second.fiber.dispose() }
  assert.equal((statSync(join(home, '.credentials.yaml')).mode & 0o777), 0o600)
  const diagnostic = JSON.stringify({ file: '.credentials.yaml', mode: '0600' })
  assert.doesNotMatch(diagnostic, /onboarding-test-secret/u)
})

test('noninteractive guidance requires a real stored or inherited credential', async t => {
  const home = await temp(t)
  const previous = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const dependencies = await credentialDependencies()
  try { await assert.rejects(() => prepareCredentials(home, dependencies), /缺少 DEEPSEEK_API_KEY/u) }
  finally { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous }
  assert.equal(existsSync(join(home, '.credentials.yaml')), false)
})

test('a real PTY hides a credential and completes confirmation', { skip: process.platform === 'win32' && 'POSIX PTY' }, async t => {
  const home = await temp(t)
  const script = join(await temp(t), 'prompt.mjs')
  writeFileSync(script, `import {prepareCredentials} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../bin/web-onboarding.mjs')).href)}
import {Context} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../vendor/cordis/lib/index.js')).href)}
import {LocalCredentialProvider} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../packages/credentials/credentials-local/lib/index.js')).href)}
import {loadLayeredEnv} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../packages/boot/app-boot/lib/index.js')).href)}
import {DSH_LAUNCH_ENVIRONMENT_KEY} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../packages/util/launch-environment/lib/index.js')).href)}
await prepareCredentials(process.env.MAPHARNESS_HOME,{Context,LocalCredentialProvider,loadLayeredEnv,DSH_LAUNCH_ENVIRONMENT_KEY})
`)
  const pty = require('node-pty')
  const terminal = pty.spawn(process.execPath, [script], { name: 'xterm', cols: 120, rows: 40, cwd: process.cwd(),
    env: { ...process.env, MAPHARNESS_HOME: home, DEEPSEEK_API_KEY: '', TERM: 'dumb' },
  })
  let stdout = ''
  terminal.onData(chunk => { stdout += chunk })
  const exited = new Promise(resolve => terminal.onExit(resolve))
  setTimeout(() => terminal.write('onboarding-test-secret\r'), 500)
  setTimeout(() => terminal.write('y\r'), 1000)
  const result = await exited
  t.after(() => terminal.kill())
  assert.equal(result.exitCode, 0, stdout)
  assert.doesNotMatch(stdout, /onboarding-test-secret/u)
  assert.match(readFileSync(join(home, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY: onboarding-test-secret/u)
})

async function fakeWeb(t, { body = '<html><body>Map Harness</body></html>', status = 200 } = {}) {
  const server = createServer((request, response) => {
    if (new URL(request.url, 'http://fixture').pathname === '/') { response.writeHead(302, { location: '/app', 'set-cookie': 'map_session=fixture; Path=/; HttpOnly' }); response.end(); return }
    if (!request.headers.cookie?.includes('map_session=fixture')) { response.writeHead(401); response.end('authenticate'); return }
    response.writeHead(status, { 'content-type': 'text/html' }); response.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}

function serviceProcess(url, options = {}) {
  const listeners = new Map()
  const stream = () => ({ handlers: [], on(event, callback) { this.handlers.push(callback) }, resume() {} })
  const child = {
    stdout: stream(), stderr: stream(), exitCode: null, signalCode: null, killed: [],
    once(event, callback) { (listeners.get(event) ?? listeners.set(event, []).get(event)).push(callback) },
    kill(signal) { this.killed.push(signal); this.signalCode = signal; for (const callback of listeners.get('exit') ?? []) callback(null, signal) },
  }
  setImmediate(() => {
    if (options.exitEarly) { child.exitCode = 1; for (const callback of listeners.get('exit') ?? []) callback(1, null); return }
    for (const callback of child.stdout.handlers) callback(`map-harness web: ${url}\n`)
    if (options.stopAfterReady) setTimeout(() => child.kill('SIGTERM'), 30)
  })
  return { child, spawn: () => child }
}

test('a real child remains alive after the HTTP check and exits on SIGTERM', async t => {
  const port = await fakeWeb(t)
  const script = join(await temp(t), 'service.mjs')
  writeFileSync(script, "console.log('map-harness web: http://127.0.0.1:'+process.env.PROBE_PORT+'/?token=fixture-token');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)")
  const childScript = join(await temp(t), 'child.mjs')
  copyFileSync(script, childScript)
  const pending = superviseWeb(process.execPath, [childScript, '--no-open'], {
    env: { ...process.env, PROBE_PORT: String(port) },
    spawn: (file, args, options) => spawn(file, args.filter((_, index) => index !== 0), options),
  })
  const timer = setTimeout(() => process.emit('SIGTERM'), 1500)
  try { await pending } finally { clearTimeout(timer) }
})

test('supervisor rejects non-HTML and early exit instead of claiming success', async t => {
  const port = await fakeWeb(t, { body: 'not-html', status: 503 })
  const bad = serviceProcess(`http://127.0.0.1:${port}/?token=fixture-token`)
  await assert.rejects(() => superviseWeb('/fixture/service', [], { spawn: bad.spawn }), /HTTP 503/u)
  const early = serviceProcess('http://127.0.0.1:1/?token=unused', { exitEarly: true })
  await assert.rejects(() => superviseWeb('/fixture/service', [], { spawn: early.spawn }), /before|就绪前/u)
})
