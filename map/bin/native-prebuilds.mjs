/** Install pinned native workspace payloads without compiling on the consumer host. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const PREFIX = '@deepseek-ai/node-addon-system'

class NativeSetupError extends Error {
  constructor(code, message, cause) {
    super(message, { cause })
    this.name = 'NativeSetupError'
    this.code = code
  }
}

function metadataError(cause) {
  return new NativeSetupError('INVALID_METADATA', 'Native prebuild metadata does not match the bundled native packages; download a complete runtime archive.', cause)
}

function directory(root, relative, create) {
  let current = root
  for (const part of relative.split('/').filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return undefined
      try { mkdirSync(current) } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError
      }
      info = lstatSync(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new NativeSetupError('UNSAFE_PATH', 'Native package directories must not contain symlinks or non-directory entries; use a clean runtime directory.')
    }
  }
  return current
}

function readMetadata(root, relative) {
  try {
    if (directory(root, dirname(relative).replaceAll('\\', '/'), false) === undefined) throw metadataError()
    const path = join(root, relative)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw metadataError()
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof NativeSetupError) throw error
    throw metadataError(error)
  }
}

/**
 * Resolve the matching workspace package and its locked payloads; Windows uses its existing lock implementation.
 * @param {string} root - target runtime directory.
 * @param {string} platform - Node platform name.
 * @param {string} arch - Node architecture name.
 * @returns {object | undefined} validated installation fields, or undefined for Windows.
 */
export function resolveNativePrebuild(root, platform, arch) {
  if (platform === 'win32') return undefined
  const key = `${platform}-${arch}`
  if (!/^(?:darwin|linux)-(?:arm64|x64)$/u.test(key)) {
    throw new NativeSetupError('UNSUPPORTED_PLATFORM', 'No native prebuild is available for this platform; Linux and macOS require x64 or arm64.')
  }
  const base = realpathSync(root)
  const pins = readMetadata(base, 'map/release/native-prebuilds.json')
  const pin = pins.packages?.[key]
  const relative = `native/system/packages/${key}`
  const local = readMetadata(base, `${relative}/package.json`)
  const entry = readMetadata(base, 'native/system/packages/entry/package.json')
  const declared = readMetadata(base, `${relative}/prebuilds.json`)
  if (pins.formatVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(pins.version ?? '')
    || !pin || pin.name !== `${PREFIX}-${key}` || local.name !== pin.name
    || local.version !== pins.version || entry.version !== pins.version || entry.name !== PREFIX
    || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.integrity ?? '')
    || declared.platform !== key || !Array.isArray(declared.binaries) || !Array.isArray(pin.binaries)
    || pin.binaries.length === 0 || pin.binaries.length !== declared.binaries.length) throw metadataError()
  const seen = new Set()
  for (const binary of pin.binaries) {
    const original = declared.binaries.find(item => item?.path === binary?.path)
    if (!binary || !/^bin\/(?:glibc\/|musl\/)?(?:system\.node|landlock-run)$/u.test(binary.path ?? '')
      || !/^[a-f0-9]{64}$/u.test(binary.sha256 ?? '') || seen.has(binary.path) || !original
      || binary.executable !== (original.tool === 'landlock-run')) throw metadataError()
    seen.add(binary.path)
  }
  return { root: base, key, relative, packageDir: join(base, relative), name: pin.name, version: pins.version, integrity: pin.integrity, binaries: pin.binaries }
}

function binaryPath(spec, binary, create) {
  const parent = directory(spec.root, `${spec.relative}/${dirname(binary.path).replaceAll('\\', '/')}`, create)
  if (parent === undefined) return undefined
  const path = join(parent, basename(binary.path))
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (info !== undefined) {
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new NativeSetupError('UNSAFE_PATH', 'Native payload targets must be regular files; use a clean runtime directory.')
    }
  }
  return path
}

function installed(spec) {
  return spec.binaries.every(binary => {
    const path = binaryPath(spec, binary, false)
    if (path === undefined || !existsSync(path)) return false
    const info = lstatSync(path)
    return info.size <= MAX_ARCHIVE_BYTES && createHash('sha256').update(readFileSync(path)).digest('hex') === binary.sha256
      && (!binary.executable || (info.mode & 0o111) !== 0)
  })
}

/**
 * Validate one pinned npm archive and atomically replace each declared native payload.
 * @param {object} spec - fields returned by resolveNativePrebuild.
 * @param {Buffer} archive - downloaded npm tarball bytes.
 * @returns {void}
 */
export function materializeNativePrebuild(spec, archive) {
  if (archive.length > MAX_ARCHIVE_BYTES || `sha512-${createHash('sha512').update(archive).digest('base64')}` !== spec.integrity) {
    throw new NativeSetupError('INTEGRITY_MISMATCH', 'Native prebuild archive checksum does not match this release; use a trusted registry.')
  }
  const payloads = spec.binaries.map(binary => {
    const result = spawnSync('tar', ['-xzOf', '-', `package/${binary.path}`], { input: archive, maxBuffer: MAX_ARCHIVE_BYTES, timeout: 30_000 })
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)
      || createHash('sha256').update(result.stdout).digest('hex') !== binary.sha256) {
      throw new NativeSetupError('INTEGRITY_MISMATCH', 'Native prebuild binary checksum does not match this release; download the runtime again.')
    }
    return { binary, content: result.stdout }
  })
  for (const { binary, content } of payloads) {
    const target = binaryPath(spec, binary, true)
    const temporary = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: binary.executable ? 0o755 : 0o644 })
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

async function download(spec, registry, environment) {
  const temp = mkdtempSync(join(tmpdir(), 'map-native-download-'))
  try {
    const args = ['pack', `${spec.name}@${spec.version}`, `--registry=${registry}`, '--ignore-scripts', '--json', `--pack-destination=${temp}`, `--cache=${join(temp, 'cache')}`]
    const command = process.platform === 'win32' ? process.execPath : 'npm'
    if (process.platform === 'win32') args.unshift(join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'))
    const result = await execFileAsync(command, args, { cwd: temp, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...environment, npm_config_update_notifier: 'false' } })
    const records = JSON.parse(result.stdout)
    const filename = Array.isArray(records) && records.length === 1 ? records[0]?.filename : undefined
    if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(filename)) throw metadataError()
    const path = join(temp, filename)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_BYTES) throw metadataError()
    return readFileSync(path)
  } catch (error) {
    throw new NativeSetupError('DOWNLOAD_FAILED', 'Could not download the pinned native prebuild; check registry access or retry install with another mirror.', error)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

async function probe(spec) {
  const temp = mkdtempSync(join(tmpdir(), 'map-native-probe-'))
  let fd
  try {
    const { tryLockExclusive } = await import(pathToFileURL(join(spec.root, 'native/system/packages/entry/lib/flock.js')).href)
    fd = openSync(join(temp, 'lock'), 'wx+', 0o600)
    await tryLockExclusive(fd)
  } catch (error) {
    throw new NativeSetupError('BINDING_UNAVAILABLE', 'The installed native Session lock could not load; retry install or download a fresh runtime archive.', error)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * Fetch missing payloads and verify the installed Session lock before setup succeeds.
 * @param {object} spec - fields returned by resolveNativePrebuild.
 * @param {string} registry - npm registry selected by setup.
 * @param {Record<string, string | undefined>} environment - setup's child-process environment.
 * @returns {Promise<void>} resolves after all payloads and the lock probe succeed.
 */
export async function installNativePrebuild(spec, registry, environment) {
  try {
    if (!installed(spec)) materializeNativePrebuild(spec, await download(spec, registry, environment))
    await probe(spec)
  } catch (error) {
    if (error instanceof NativeSetupError) throw error
    throw new NativeSetupError('WRITE_FAILED', 'Could not prepare native payloads; check permissions on the runtime directory and retry install.', error)
  }
}
