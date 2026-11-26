/** Native package validation and guided startup for a script Web service. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { prepareMapInstance } from './instance-home.mjs'
import { acquireInstanceLock } from './instance-lock.mjs'
import { applyMapEnvironment, mapEntryEnvironment } from './instance-preload.mjs'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

const SERVICE = '--web-onboarding'
const TARGETS = new Set(['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64'])
const PACKAGE_FIELDS = ['format', 'product', 'version', 'targets', 'supportedTargets', 'unsupportedTargets', 'files']
const FILE_FIELDS = ['executable', 'path', 'role', 'sha256', 'target']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function fail(message) {
  throw new Error(`start-web: ${message}`)
}

function sameFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function safePath(root, path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\')) fail('manifest file path is unsafe.')
  if (path.split('/').some(part => part === '' || part === '.' || part === '..' || /^[A-Za-z]:$/u.test(part))) fail('manifest file path is unsafe.')
  return resolve(root, ...path.split('/'))
}

function hostTarget(platform = process.platform, arch = process.arch) {
  const prefix = platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'win' : undefined
  const target = prefix === undefined || !['arm64', 'x64'].includes(arch) ? undefined : `${prefix}-${arch}`
  if (target === undefined || !TARGETS.has(target)) fail('unsupported operating system or CPU.')
  return target
}

async function regularFile(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`missing package file ${basename(path)}.`)
    return stat
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`missing package file ${basename(path)}.`)
    throw error
  }
}

/** Verify the package before executing the selected native Web service. */
export async function verifyWebPackage(root, platform = process.platform, arch = process.arch) {
  const target = hostTarget(platform, arch)
  let manifest
  try { manifest = JSON.parse(await readFile(resolve(root, 'web-service-manifest.json'), 'utf8')) }
  catch (error) { fail(`invalid web-service manifest: ${error.message}`) }
  if (!sameFields(manifest, PACKAGE_FIELDS) || manifest.format !== 1 || manifest.product !== 'map-harness') fail('web-service manifest identity or fields are invalid.')
  if (!Array.isArray(manifest.targets) || !Array.isArray(manifest.supportedTargets) || !Array.isArray(manifest.unsupportedTargets)
    || manifest.targets.some(row => !TARGETS.has(row?.target))
    || manifest.supportedTargets.some(item => !TARGETS.has(item)) || manifest.unsupportedTargets.some(item => !TARGETS.has(item))) fail('manifest target metadata is invalid.')
  if (!manifest.supportedTargets.includes(target) || manifest.unsupportedTargets.includes(target)) fail(`this package does not support ${target}.`)
  const targets = manifest.targets.filter(row => row.target === target)
  if (targets.length !== 1 || typeof targets[0].record !== 'string') fail('manifest target record is missing or duplicated.')
  const recordPath = safePath(root, targets[0].record)
  let record
  try { record = JSON.parse(await readFile(recordPath, 'utf8')) }
  catch (error) { fail(`invalid native build record: ${error.message}`) }
  if (record.format !== 'map-harness-native-1' || record.version !== manifest.version || record.target !== target
    || record.sourceCoreFiles !== 0 || record.webService?.format !== 1 || record.webService?.mode !== 'web' || record.webService?.profile !== 'map-web'
    || record.engine?.platform !== platform || record.engine?.arch !== arch || typeof record.engine?.node !== 'string') fail('native build record does not match the manifest target.')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('manifest file list is empty.')
  const seen = new Set(), services = [], entries = new Map()
  for (const row of manifest.files) {
    if (!sameFields(row, FILE_FIELDS) || typeof row.role !== 'string' || row.role.length === 0 || typeof row.executable !== 'boolean' || !digest(row.sha256)
      || (row.target !== null && !TARGETS.has(row.target))) fail(`manifest metadata is invalid for ${String(row.path)}.`)
    const path = safePath(root, row.path)
    if (seen.has(row.path)) fail(`duplicate manifest file ${row.path}.`)
    seen.add(row.path)
    entries.set(row.path, row)
    if (row.target !== null && row.target !== target) continue
    const stat = await regularFile(path)
    if (sha(await readFile(path)) !== row.sha256) fail(`verification failed for ${row.path}.`)
    if (platform !== 'win32' && row.executable && (stat.mode & 0o111) === 0) fail(`package file is not executable: ${row.path}.`)
    if (row.role === 'service' && row.target === target) {
      if (record.executable !== basename(row.path) || record.sha256 !== row.sha256 || !row.executable) fail('service file does not match its build record.')
      services.push(row)
    }
    if (row.role === 'build-record' && row.path !== targets[0].record) fail('build-record manifest entry is invalid.')
  }
  if (!entries.has(targets[0].record)) fail('target build record is not listed in the manifest.')
  if (record.resources === null || typeof record.resources !== 'object' || Array.isArray(record.resources)) fail('native build record resources are invalid.')
  for (const [role, resource] of Object.entries(record.resources)) {
    if (resource === null || typeof resource.file !== 'string' || !digest(resource.sha256)) fail(`helper ${role} metadata is invalid.`)
    const helpers = manifest.files.filter(row => row.target === target && row.role === `helper:${role}` && row.path === `${target}/${resource.file}` && row.sha256 === resource.sha256)
    if (helpers.length !== 1) fail(`helper ${role} does not match its build record.`)
  }
  if (services.length !== 1) fail('manifest must carry exactly one executable service for this target.')
  return { manifest, record, target, service: safePath(root, services[0].path) }
}

/** Select guided startup by default; the explicit bypass preserves CI and qualification. */
export async function runWebOnboarding(argv, root, entry, programRoot) {
  const { service, target } = await verifyWebPackage(root)
  if (argv[0] === '--no-onboarding') {
    return { direct: argv.slice(1) }
  }
  return guidedWebStart(argv, service, target, entry, programRoot)
}

/** Load the product's own environment and writable credential provider. */
async function credentialStore(home, dependencies = {}) {
  const { Context } = dependencies.Context !== undefined ? dependencies : await import('@deepseek-ai/cordis')
  const { LocalCredentialProvider } = dependencies.LocalCredentialProvider !== undefined ? dependencies : await import('@deepseek-ai/dsh-credentials-local')
  const { loadLayeredEnv } = dependencies.loadLayeredEnv !== undefined ? dependencies : await import('@deepseek-ai/dsh-app-boot')
  const { DSH_LAUNCH_ENVIRONMENT_KEY } = dependencies.DSH_LAUNCH_ENVIRONMENT_KEY !== undefined ? dependencies : await import('@deepseek-ai/dsh-launch-environment')
  process.env.DSH_HOME = home
  process.env.MAPHARNESS_HOME = home
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh', home))
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  try { await fiber } catch (error) {
    try { await ctx.fiber.dispose() } catch { /* The original configuration failure is actionable. */ }
    throw error
  } finally { /* The selected home remains fixed for the service child. */ }
  return { ctx, credentials: ctx.credentials, dispose: () => ctx.fiber.dispose() }
}

async function hiddenPrompt(prompt) {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (chunk.toString() === '\u001b[2K\u001b[1G') process.stdout.write('\n')
      callback()
    },
  })
  const reader = createInterface({ input: process.stdin, output, terminal: true })
  try {
    process.stdout.write(prompt)
    return await reader.question('')
  } catch (error) {
    if (error?.code === 'ERR_USE_AFTER_CLOSE') throw new Error('输入已结束，尚未启动服务。')
    throw error
  } finally { reader.close() }
}

async function confirm(question, expected = '') {
  const answer = await hiddenPrompt(question)
  return answer.trim().toLowerCase() === expected
}

export async function prepareCredentials(home, dependencies = {}) {
  const store = await credentialStore(home, dependencies)
  try {
    const ref = 'DEEPSEEK_API_KEY'
    const status = await store.credentials.describe(ref)
    if (status.configured && status.source === 'file') return '已保存的 DeepSeek 密钥'
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
    const label = status.configured ? (status.source === 'process' ? '当前环境变量中的 DeepSeek 密钥' : '现有 .env 中的 DeepSeek 密钥') : undefined
    if (label !== undefined) {
      if (!interactive || await confirm(`[2/4] 检测到${label}。直接保存到本机凭据库？[Y/n] `, 'n')) return label
    }
    if (!interactive) fail('缺少 DEEPSEEK_API_KEY；请先在终端运行本脚本，或设置该环境变量。')
    const secret = await hiddenPrompt('[2/4] 请粘贴 DeepSeek API Key（输入不会显示，只保存在本机）：')
    if (!secret.trim()) fail('未输入 API Key，尚未启动服务。')
    if (!await confirm('[2/4] 确认将密钥保存到本机凭据库？输入 y 确认：', 'y')) fail('已取消保存，尚未启动服务。')
    await store.credentials.set(ref, secret)
    return '本次配置的 DeepSeek 密钥'
  } finally { await store.dispose() }
}

/** Start the ordinary DSH Web profile and wait for its advertised URL. */
export async function superviseWeb(service, argv, options = {}) {
  const child = (options.spawn ?? spawn)(service, ['web', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env })
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  let output = '', url
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Web 服务启动超时。')), options.timeoutMs ?? 120000)
    timer.unref()
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      output = (output + text).slice(-1024 * 1024)
      process.stdout.write(text)
      const match = output.match(/map-harness web: (https?:\/\/[^\s]+)/u)
      if (match === null || url !== undefined) return
      try { url = new URL(match[1]) } catch { return }
      clearTimeout(timer)
      resolveReady(url)
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    exited.then(event => { clearTimeout(timer); reject(new Error(`Web 服务在就绪前退出（${event.code ?? event.signal}）。`)) })
  })
  let stopRequested = false
  const stop = signal => {
    stopRequested = true
    child.kill(signal)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const target = await ready
    child.stdout.resume()
    child.stderr.resume()
    const signal = AbortSignal.timeout(options.httpTimeoutMs ?? 15000)
    let current = target, response, cookie = ''
    for (let hop = 0; hop < 6; hop += 1) {
      response = await fetch(current, { redirect: 'manual', signal, headers: cookie === '' ? {} : { cookie } })
      const rawCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
      const nextCookie = rawCookie?.split(';', 1)[0]
      if (nextCookie !== undefined && nextCookie !== '') cookie = nextCookie
      const location = response.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) break
      current = new URL(location, current)
    }
    const body = await response.text()
    if (response.status !== 200 || !/<html[\s>]/iu.test(body) || !body.includes('</html>')) throw new Error(`Web 页面检查失败（HTTP ${response.status}）。`)
    process.stdout.write(`\n启动完成，请访问：${target.href}\n服务正在前台运行，按 Ctrl-C 停止；数据目录：${process.env.MAPHARNESS_HOME}\n`)
    const event = await exited
    if (!stopRequested && event.code !== 0) throw new Error(`Web 服务异常退出（${event.code ?? event.signal}）。`)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited
    }
  }
}

async function guidedWebStart(argv, service, target, entry, programRoot) {
  entry.spec = prepareMapInstance(entry.spec)
  applyMapEnvironment(mapEntryEnvironment(entry, programRoot))
  const home = entry.spec.home
  process.stdout.write(`Map Harness 启动引导\n[1/4] 环境检查通过：${target}；无需 Node.js 或 Python。\n数据目录：${home}\n`)
  // Credentials initialize while this process briefly owns the writer lock; the service child re-acquires it.
  const lease = await acquireInstanceLock(entry.spec)
  try {
    await prepareCredentials(home)
  } finally {
    await lease.release()
  }
  process.stdout.write('[3/4] 配置已就绪，正在启动本地 Web 服务。\n')
  await superviseWeb(service, argv)
}

/**
 * SEA-only internal launcher; errors never contain credential values.
 * @param {string[]} argv process arguments beginning with the private onboarding marker
 * @param {object} entry admitted instance entry from the application bootstrap
 * @param {string} programRoot validated installation directory
 * @returns {Promise<object|undefined>} direct-boot arguments, or undefined after a guided run
 */
export async function mainWebOnboarding(argv, entry, programRoot) {
  if (argv[0] !== SERVICE) throw new Error('Unknown Web onboarding command.')
  return runWebOnboarding(argv.slice(1), dirname(dirname(process.execPath)), entry, programRoot)
}
