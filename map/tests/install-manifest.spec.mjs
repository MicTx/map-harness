/** Installation identity and byte-binding checks use only private synthetic package trees. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  createInstallDescriptor, createInstallManifest, INSTALL_CONTRACT_PATH, INSTALL_MANIFEST_FILE,
  INSTALL_MANIFEST_FORMAT, MapInstallError, readDataCompatibility, readInstallContract, validateInstallManifest,
} from '../bin/install-manifest.mjs'
import { MAP_IDENTITY_REVISION } from '../bin/instance-home.mjs'

const repo = join(import.meta.dirname, '../..')
const targets = ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const version = '1.2.3'
const sourceDigest = 'a'.repeat(64)
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const ownerFiles = [
  ['packages/core/session/src/types.ts', 'SESSION_FORMAT_VERSION', 4],
  ['map/spatial-storage/src/schema.ts', 'SPATIAL_STORE_SCHEMA_VERSION', 6],
  ['map/spatial-accessibility/src/runs.ts', 'ACCESSIBILITY_RUN_SCHEMA_VERSION', 1],
  ['packages/storage/storage-sqlite/src/schema.ts', 'STORAGE_SQLITE_SCHEMA_VERSION', 1],
]
const initialCompatibility = {
  sessionFormat: 4, spatialStore: { min: 6, max: 6 }, accessibilityStore: { min: 1, max: 1 }, storageSqlite: 1, migration: 'none',
}

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-install-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), bytes)
}

function writeOwner(root, index, value, declaration = `export const ${ownerFiles[index][1]}: number = ${value} as const;`) {
  const [path, symbol] = ownerFiles[index]
  const ladder = index === 1 ? `\nexport const STORE_MIGRATION_STEPS: readonly unknown[] = [\n${Array.from({ length: value }, (_, from) => `  { from: ${from}, to: ${from + 1}, name: 'v${from + 1}', up: () => {} },`).join('\n')}\n]\n` : ''
  // A parser must ignore comments and string decoys, and must not execute owners.
  write(root, path, `// export const ${symbol} = 999\nconst decoy = 'export const ${symbol} = 888'\nthrow new Error('owner modules are not executable build inputs')\n${declaration}\n${ladder}`)
}

function buildRoot(t) {
  const root = temp(t)
  mkdirSync(join(root, 'map/release'), { recursive: true })
  copyFileSync(join(repo, INSTALL_CONTRACT_PATH), join(root, INSTALL_CONTRACT_PATH))
  write(root, 'map/release/version.json', json({ version }))
  write(root, 'scripts/primary-runtime/lock.json', json({ targets: Object.fromEntries(targets.map(target => [target, {}])) }))
  for (const [index, [, , value]] of ownerFiles.entries()) writeOwner(root, index, value)
  return root
}

function packageInputs({ supported = ['mac-arm64'], distribution = 'portable', channel = 'stable', data = initialCompatibility } = {}) {
  const records = {}
  const files = [{ path: 'LICENSE', role: 'license', target: null, executable: false, sha256: hash('license') }]
  for (const target of supported) {
    const [os, arch] = target.split('-')
    const executable = `map-harness${os === 'win' ? '.exe' : ''}`
    const record = {
      format: 'map-harness-native-1', version, target, sourceDigest,
      engine: { node: 'v24.21.0', platform: { mac: 'darwin', linux: 'linux', win: 'win32' }[os], arch },
      executable, sha256: hash(`native fixture ${target}`), sourceCoreFiles: 0,
      webService: { format: 1, mode: 'web', profile: 'map-web' },
      install: createInstallDescriptor({ distribution, channel, dataCompatibility: data }),
    }
    records[target] = json(record)
    files.push({ path: `${target}/${executable}`, role: 'service', target, executable: true, sha256: record.sha256 })
    files.push({ path: `${target}/application.json`, role: 'build-record', target, executable: false, sha256: hash(records[target]) })
  }
  const payload = {
    format: 1, product: 'map-harness', version, targets: supported.map(target => ({ target, record: `${target}/application.json` })),
    supportedTargets: [...supported], unsupportedTargets: targets.filter(target => !supported.includes(target)), files,
  }
  return { payload, buildRecordBytes: records, distribution, channel }
}

function candidate(item, target = item.payload.supportedTargets[0]) {
  const data = JSON.parse(item.buildRecordBytes[target]).install.dataCompatibility
  const manifest = {
    format: INSTALL_MANIFEST_FORMAT, product: 'map-harness', distribution: item.distribution, channel: item.channel,
    version: item.payload.version, target, identityRevision: MAP_IDENTITY_REVISION, sourceDigest,
    payload: { manifest: 'web-service-manifest.json', sha256: hash(json(item.payload)) }, dataCompatibility: structuredClone(data),
  }
  const options = {
    expected: { product: manifest.product, distribution: manifest.distribution, channel: manifest.channel,
      target, version: manifest.version, identityRevision: MAP_IDENTITY_REVISION, sourceDigest, payloadSha256: manifest.payload.sha256 },
    payloadManifestBytes: json(item.payload), buildRecordBytes: item.buildRecordBytes, installedManifest: null,
  }
  return { manifest, options }
}

function refreshRecord(item, target, mutate) {
  const value = JSON.parse(item.buildRecordBytes[target])
  mutate(value)
  item.buildRecordBytes[target] = json(value)
  const row = item.payload.files.find(entry => entry.role === 'build-record' && entry.target === target)
  row.sha256 = hash(item.buildRecordBytes[target])
}

function buildOptions(root, item, target = item.payload.supportedTargets[0]) {
  return { root, distribution: item.distribution, channel: item.channel, target, sourceDigest,
    payloadManifestBytes: json(item.payload), buildRecordBytes: item.buildRecordBytes }
}

function fails(code) {
  return error => {
    assert.ok(error instanceof MapInstallError)
    assert.equal(error.code, code)
    assert.equal(typeof error.details, 'object')
    return true
  }
}

function inventory(root) {
  const walk = relative => readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(path) : [[path, hash(readFileSync(join(root, path)))]]
  })
  return walk('').sort(([a], [b]) => a.localeCompare(b))
}

test('the installation build contract names owners, not released versions or fabricated artifacts', () => {
  const contract = readInstallContract(repo)
  assert.equal(contract.product, 'map-harness')
  assert.equal(contract.identityRevision, MAP_IDENTITY_REVISION)
  assert.equal(contract.manifest.file, INSTALL_MANIFEST_FILE)
  assert.equal(contract.manifest.format, INSTALL_MANIFEST_FORMAT)
  assert.equal(contract.versionSource, 'map/release/version.json')
  assert.equal(contract.targetSource, 'scripts/primary-runtime/lock.json')
  assert.equal('version' in contract, false)
  assert.equal('dataCompatibility' in contract, false)
  assert.equal('sourceDigest' in contract, false)
  const lock = JSON.parse(readFileSync(join(repo, contract.targetSource), 'utf8'))
  assert.deepEqual(Object.keys(lock.targets).sort(), targets)
})

test('contract validation ignores object key order but rejects unknown and duplicated sources of truth', t => {
  const root = buildRoot(t)
  const valid = readInstallContract(root)
  write(root, INSTALL_CONTRACT_PATH, json(Object.fromEntries(Object.entries(valid).reverse())))
  assert.deepEqual(readInstallContract(root), valid)
  for (const mutate of [
    value => { value.version = '9.9.9' },
    value => { value.sourceDigest = sourceDigest },
    value => { value.manifest.extra = true },
    value => { value.product = 'dsh' },
    value => { value.identityRevision += 1 },
    value => { value.distributions = ['portable', 'portable'] },
    value => { value.channels = ['stable'] },
    value => { value.versionSource = '../package.json' },
    value => { value.targetSource = 'other.json' },
    value => { value.payloadManifest = '../web-service-manifest.json' },
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    write(root, INSTALL_CONTRACT_PATH, json(invalid))
    assert.throws(() => readInstallContract(root), fails('MAP_INSTALL_SCHEMA'))
  }
})

test('actual compatibility snapshots use owner values and a complete migration ladder', async () => {
  const current = await readDataCompatibility(repo)
  for (const [index, [path, symbol]] of ownerFiles.entries()) {
    const text = readFileSync(join(repo, path), 'utf8')
    const declared = Number(text.match(new RegExp(`^export const ${symbol} = (\\d+)$`, 'mu'))?.[1])
    assert.ok(Number.isSafeInteger(declared), symbol)
    const key = ['sessionFormat', 'spatialStore', 'accessibilityStore', 'storageSqlite'][index]
    assert.deepEqual(current[key], key.endsWith('Store') ? { min: declared, max: declared } : declared)
  }
  assert.equal(current.migration, 'none')
})

test('the native descriptor has an exact field set and retains an independent compatibility snapshot', () => {
  const request = { distribution: 'portable', channel: 'stable', dataCompatibility: structuredClone(initialCompatibility) }
  const descriptor = createInstallDescriptor(request)
  request.dataCompatibility.spatialStore.max = 99
  assert.equal(descriptor.dataCompatibility.spatialStore.max, 6)
  for (const input of [null, undefined, {}, { ...request, dataCompatibility: initialCompatibility, product: 'dsh' },
    { ...request, distribution: 'desktop' }, { ...request, channel: 'nightly' }]) {
    assert.throws(() => createInstallDescriptor(input), fails('MAP_INSTALL_SCHEMA'))
  }
})

test('owner extraction is syntax-aware, does not execute code, and observes every owner change', async t => {
  const root = buildRoot(t)
  assert.deepEqual(await readDataCompatibility(root), initialCompatibility)
  writeOwner(root, 0, 7)
  writeOwner(root, 1, 9)
  writeOwner(root, 2, 2)
  writeOwner(root, 3, 3)
  assert.deepEqual(await readDataCompatibility(root), {
    sessionFormat: 7, spatialStore: { min: 9, max: 9 }, accessibilityStore: { min: 2, max: 2 }, storageSqlite: 3, migration: 'none',
  })
})

test('ambiguous, hidden, computed, missing, and malformed owner declarations stop construction', async t => {
  const root = buildRoot(t)
  for (const [index, [path, symbol, value]] of ownerFiles.entries()) {
    const valid = readFileSync(join(root, path), 'utf8')
    for (const declaration of [
      `export const ${symbol} = '1'`, `export let ${symbol} = 1`, `const ${symbol} = 1`,
      `export const ${symbol} = 1 + 1`, `function nested() { const ${symbol} = 1 }`,
      `export const ${symbol} = -1`, `export const ${symbol} = 0`, `export const ${symbol} = 1.5`,
      `export const ${symbol} = Number.MAX_SAFE_INTEGER + 1`,
      `export const ${symbol} = 1\nexport const ${symbol} = 2`,
      `export const ${symbol} =`,
    ]) {
      writeOwner(root, index, value, declaration)
      await assert.rejects(() => readDataCompatibility(root), fails('MAP_INSTALL_OWNER'))
    }
    write(root, path, valid)
    rmSync(join(root, path))
    await assert.rejects(() => readDataCompatibility(root), fails('MAP_INSTALL_IO'))
    write(root, path, valid)
  }
})

test('spatial metadata rejects broken, duplicated, and spread-overridden migration steps', async t => {
  const root = buildRoot(t)
  const path = ownerFiles[1][0]
  const valid = readFileSync(join(root, path), 'utf8')
  for (const content of [
    valid.replace('from: 0, to: 1', 'from: 2, to: 3'),
    valid.replace('from: 0, to: 1', 'from: 0, to: 2'),
    valid.replace('from: 0, to: 1', 'from: 0, from: 0, to: 1'),
    valid.replace('from: 0, to: 1', "from: 0, to: 1, ...override"),
    valid.replace('from: 0, to: 1', "from: 0, to: 1, ['from']: 4"),
    valid.replace('SPATIAL_STORE_SCHEMA_VERSION: number = 6', 'SPATIAL_STORE_SCHEMA_VERSION: number = 7'),
    valid.replace(/export const STORE_MIGRATION_STEPS[\s\S]*$/u, 'export const STORE_MIGRATION_STEPS = loadSteps()'),
  ]) {
    write(root, path, content)
    await assert.rejects(() => readDataCompatibility(root), fails('MAP_INSTALL_OWNER'))
  }
})

test('creation binds explicit distribution/channel/target and uses the product-version owner', async t => {
  const root = buildRoot(t)
  const before = inventory(root)
  for (const distribution of ['portable', 'managed']) {
    for (const channel of ['stable', 'preview']) {
      for (const target of targets) {
        const item = packageInputs({ supported: [target], distribution, channel })
        const manifest = await createInstallManifest(buildOptions(root, item))
        assert.deepEqual(manifest, candidate(item).manifest)
        assert.equal(validateInstallManifest(manifest, candidate(item).options).status, 'ready')
      }
    }
  }
  assert.deepEqual(inventory(root), before)
})

test('one multi-target portable payload has per-target installation bindings without changing Web format', async t => {
  const root = buildRoot(t)
  const item = packageInputs({ supported: ['mac-arm64', 'linux-x64'] })
  const first = await createInstallManifest(buildOptions(root, item, 'mac-arm64'))
  const second = await createInstallManifest(buildOptions(root, item, 'linux-x64'))
  assert.equal(first.payload.sha256, second.payload.sha256)
  assert.equal(first.target, 'mac-arm64')
  assert.equal(second.target, 'linux-x64')
  assert.equal(item.payload.format, 1)
  assert.deepEqual(item.payload.supportedTargets, ['mac-arm64', 'linux-x64'])
  assert.equal(validateInstallManifest(first, candidate(item, 'mac-arm64').options).status, 'ready')
  assert.equal(validateInstallManifest(second, candidate(item, 'linux-x64').options).status, 'ready')
})

test('construction fails when a native compatibility snapshot is stale even after hashes are recalculated', async t => {
  const root = buildRoot(t)
  for (const [index, [, , number]] of ownerFiles.entries()) {
    const item = packageInputs()
    writeOwner(root, index, number + 1)
    await assert.rejects(() => createInstallManifest(buildOptions(root, item)), fails('MAP_INSTALL_PAYLOAD'))
    writeOwner(root, index, number)
  }
})

test('build version and target owners are required and caller-supplied truth is rejected', async t => {
  const root = buildRoot(t)
  const item = packageInputs()
  const input = buildOptions(root, item)
  for (const extra of [{ version: '9.9.9' }, { dataCompatibility: initialCompatibility }, { identityRevision: 2 }]) {
    await assert.rejects(() => createInstallManifest({ ...input, ...extra }), fails('MAP_INSTALL_INPUT'))
  }
  write(root, 'map/release/version.json', json({ version: '9.9.9' }))
  await assert.rejects(() => createInstallManifest(input), fails('MAP_INSTALL_PAYLOAD'))
  write(root, 'map/release/version.json', json({ version: '01.2.3' }))
  await assert.rejects(() => createInstallManifest(input), fails('MAP_INSTALL_OWNER'))
  write(root, 'map/release/version.json', json({ version }))
  write(root, 'scripts/primary-runtime/lock.json', json({ targets: { 'mac-arm64': {} } }))
  await assert.rejects(() => createInstallManifest(input), fails('MAP_INSTALL_OWNER'))
})

test('installation schema rejects unknown/missing fields and invalid values at every nested level', () => {
  const item = packageInputs()
  const { manifest: valid, options } = candidate(item)
  for (const key of Object.keys(valid)) {
    const value = structuredClone(valid)
    delete value[key]
    assert.throws(() => validateInstallManifest(value, options), fails('MAP_INSTALL_SCHEMA'), key)
  }
  const invalidValues = [
    null, [], 'manifest', { ...valid, extra: true },
    ...[2, 'map-harness-install-manifest-2'].map(format => ({ ...valid, format })),
    { ...valid, product: 'dsh' }, { ...valid, distribution: 'desktop' }, { ...valid, channel: 'nightly' },
    ...[1, '', 'v1.2.3', '01.2.3', '1.2', '1.2.3-01', '1.2.3-a..b', '1.2.3+build', '../1.2.3'].map(value => ({ ...valid, version: value })),
    ...['win-arm64', 'mac-universal', 'mac-arm64/../x', 1].map(target => ({ ...valid, target })),
    ...[0, 2, '1', 1.5, null].map(identityRevision => ({ ...valid, identityRevision })),
    ...['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 1, null].map(sourceDigest => ({ ...valid, sourceDigest })),
  ]
  for (const mutate of [
    value => { value.payload.extra = true }, value => { delete value.payload.sha256 },
    value => { value.payload.manifest = '../web-service-manifest.json' }, value => { value.payload.sha256 = 'A'.repeat(64) },
    value => { value.dataCompatibility.extra = 1 }, value => { delete value.dataCompatibility.migration },
    value => { value.dataCompatibility.sessionFormat = '4' }, value => { value.dataCompatibility.sessionFormat = 0 },
    value => { value.dataCompatibility.storageSqlite = -1 }, value => { value.dataCompatibility.storageSqlite = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.dataCompatibility.migration = 'automatic' }, value => { value.dataCompatibility.spatialStore.min = 5 },
    value => { value.dataCompatibility.spatialStore.max = 5 }, value => { value.dataCompatibility.spatialStore.extra = 1 },
    value => { value.dataCompatibility.accessibilityStore = 1 }, value => { value.dataCompatibility.accessibilityStore.min = 0 },
    value => { value.dataCompatibility.accessibilityStore.max = 2 },
  ]) {
    const value = structuredClone(valid)
    mutate(value)
    invalidValues.push(value)
  }
  for (const invalid of invalidValues) assert.throws(() => validateInstallManifest(invalid, options), fails('MAP_INSTALL_SCHEMA'))
})

test('identity and independently selected release digest are mandatory and never inferred from the candidate', () => {
  const { manifest, options } = candidate(packageInputs())
  for (const key of Object.keys(options.expected)) {
    const expected = { ...options.expected }
    delete expected[key]
    assert.throws(() => validateInstallManifest(manifest, { ...options, expected }), fails('MAP_INSTALL_INPUT'))
  }
  for (const expected of [
    { ...options.expected, extra: true }, { ...options.expected, product: 'dsh' },
    { ...options.expected, target: 'win-arm64' }, { ...options.expected, identityRevision: 2 },
  ]) assert.throws(() => validateInstallManifest(manifest, { ...options, expected }), fails('MAP_INSTALL_INPUT'))
  for (const [key, value] of Object.entries({ distribution: 'managed', channel: 'preview', target: 'linux-x64', version: '1.2.4', sourceDigest: 'b'.repeat(64) })) {
    assert.throws(() => validateInstallManifest(manifest, { ...options, expected: { ...options.expected, [key]: value } }), error => {
      fails('MAP_INSTALL_IDENTITY')(error)
      assert.equal(error.details.field, key)
      return true
    })
  }
  assert.throws(() => validateInstallManifest(manifest, { ...options, expected: { ...options.expected, payloadSha256: 'b'.repeat(64) } }), fails('MAP_INSTALL_DIGEST'))
  const omitted = { ...options }
  delete omitted.installedManifest
  assert.throws(() => validateInstallManifest(manifest, omitted), fails('MAP_INSTALL_INPUT'))
})

test('byte validation rejects manifest and native-record tampering before admission', () => {
  const { manifest, options } = candidate(packageInputs())
  assert.throws(() => validateInstallManifest(manifest, { ...options, payloadManifestBytes: Buffer.concat([options.payloadManifestBytes, Buffer.from(' ')]) }), fails('MAP_INSTALL_DIGEST'))
  assert.throws(() => validateInstallManifest(manifest, { ...options, payloadManifestBytes: JSON.parse(options.payloadManifestBytes) }), fails('MAP_INSTALL_INPUT'))
  assert.throws(() => validateInstallManifest(manifest, { ...options, buildRecordBytes: { 'mac-arm64': Buffer.from('{}') } }), fails('MAP_INSTALL_DIGEST'))
  const malformed = Buffer.from('{"secret":"do-not-echo",')
  assert.throws(() => validateInstallManifest({ ...manifest, payload: { ...manifest.payload, sha256: hash(malformed) } }, {
    ...options, expected: { ...options.expected, payloadSha256: hash(malformed) }, payloadManifestBytes: malformed,
  }), error => {
    fails('MAP_INSTALL_SCHEMA')(error)
    assert.doesNotMatch(error.message, /do-not-echo/u)
    assert.equal(error.cause, undefined)
    return true
  })
})

for (const target of ['mac-arm64', 'linux-x64']) {
  test(`source and native identity conflicts reject for every portable target including ${target}`, () => {
    const mutations = [
      value => { value.product = 'dsh'; value.install.product = 'dsh' },
      value => { value.format = 'map-harness-native-2' }, value => { value.version = '1.2.4' },
      value => { value.target = 'win-x64' }, value => { value.sourceDigest = 'b'.repeat(64) },
      value => { value.sourceCoreFiles = 1 }, value => { value.webService.format = 2 },
      value => { value.webService.mode = 'desktop' }, value => { value.webService.profile = 'web' },
      value => { value.webService.extra = true }, value => { value.install.distribution = 'managed' },
      value => { value.install.channel = 'preview' }, value => { value.install.identityRevision = 2 },
      value => { value.install.dataCompatibility.sessionFormat += 1 }, value => { value.install.extra = true },
      value => { value.engine.platform = 'unknown' }, value => { value.engine.arch = 'arm' },
      value => { value.executable = '../escape' }, value => { value.sha256 = 'b'.repeat(64) },
    ]
    for (const mutate of mutations) {
      const item = packageInputs({ supported: ['mac-arm64', 'linux-x64'] })
      const original = candidate(item)
      refreshRecord(item, target, mutate)
      const rebound = candidate(item)
      const input = { ...original.manifest, payload: rebound.manifest.payload }
      assert.throws(() => validateInstallManifest(input, rebound.options), fails('MAP_INSTALL_PAYLOAD'))
    }
  })
}

test('multi-target payloads require exactly one hashed record for every target, with no hidden unsupported target', () => {
  const mutations = [
    item => { delete item.buildRecordBytes['linux-x64'] },
    item => { item.buildRecordBytes['win-x64'] = Buffer.from('{}') },
    item => { item.payload.supportedTargets.push('mac-arm64') },
    item => { item.payload.unsupportedTargets.push('mac-arm64') },
    item => { item.payload.unsupportedTargets.pop() },
    item => { item.payload.targets.pop() },
    item => { item.payload.targets[1] = item.payload.targets[0] },
    item => { item.payload.targets[1].record = item.payload.targets[0].record },
    item => { item.payload.targets[0].extra = true },
    item => { item.payload.targets[0].record = '../escape.json' },
    item => { item.payload.product = 'dsh' }, item => { item.payload.version = '1.2.4' },
    item => { item.payload.format = 2 }, item => { item.payload.extra = true },
  ]
  for (const mutate of mutations) {
    const item = packageInputs({ supported: ['mac-arm64', 'linux-x64'] })
    const original = candidate(item)
    mutate(item)
    const bytes = json(item.payload)
    assert.throws(() => validateInstallManifest({ ...original.manifest, payload: { ...original.manifest.payload, sha256: hash(bytes) } }, {
      ...original.options, payloadManifestBytes: bytes, expected: { ...original.options.expected, payloadSha256: hash(bytes) }, buildRecordBytes: item.buildRecordBytes,
    }), fails('MAP_INSTALL_PAYLOAD'))
  }
})

test('unsafe paths, file metadata, collisions and unbound services reject even with matching manifest digests', () => {
  const invalidPaths = ['', '/tmp/file', '../escape', 'mac-arm64/../escape', './file', 'mac-arm64//file', 'C:/file', 'mac-arm64\\file', 'file\0name']
  const mutations = [
    ...invalidPaths.map(path => item => { item.payload.files[0].path = path }),
    item => { item.payload.files[0].sha256 = 'A'.repeat(64) },
    item => { item.payload.files[0].extra = true }, item => { item.payload.files[0].executable = 1 },
    item => { item.payload.files[0].target = 'linux-x64' }, item => { item.payload.files[0].role = '' },
    item => { item.payload.files.push({ ...item.payload.files[0] }) },
    item => { item.payload.files.push({ ...item.payload.files[0], path: 'license' }) },
    item => { item.payload.files.push({ ...item.payload.files[0], path: INSTALL_MANIFEST_FILE }) },
    item => { item.payload.files.push({ ...item.payload.files[0], path: 'web-service-manifest.json' }) },
    item => { item.payload.files.push({ ...item.payload.files[0], path: 'other.json', role: 'build-record' }) },
    item => { item.payload.files.push({ ...item.payload.files[0], path: 'other', role: 'service' }) },
  ]
  for (const mutate of mutations) {
    const item = packageInputs()
    mutate(item)
    const { manifest, options } = candidate(item)
    assert.throws(() => validateInstallManifest(manifest, options), fails('MAP_INSTALL_PAYLOAD'))
  }
})

test('Windows path aliases and file-directory collisions reject at manifest admission', () => {
  for (const path of ['LICENSE.', 'dir./file', 'NUL', 'dir/COM1.txt', 'MAP-INSTALL-MANIFEST.JSON', 'mac-arm64/map-install-manifest.json', 'WEB-SERVICE-MANIFEST.JSON']) {
    const item = packageInputs()
    item.payload.files[0].path = path
    const { manifest, options } = candidate(item)
    assert.throws(() => validateInstallManifest(manifest, options), fails('MAP_INSTALL_PAYLOAD'), path)
  }
  const item = packageInputs()
  item.payload.files.push({ ...item.payload.files[0], path: 'license/child' })
  const { manifest, options } = candidate(item)
  assert.throws(() => validateInstallManifest(manifest, options), fails('MAP_INSTALL_PAYLOAD'))
})

test('record role, executable bit, and record hash are all required', () => {
  for (const mutate of [
    row => { row.role = 'readme' }, row => { row.executable = true }, row => { row.sha256 = 'b'.repeat(64) },
  ]) {
    const item = packageInputs()
    mutate(item.payload.files.find(row => row.role === 'build-record'))
    const { manifest, options } = candidate(item)
    assert.throws(() => validateInstallManifest(manifest, options), fails('MAP_INSTALL_DIGEST'))
  }
})

test('same version and byte identities return no-op only when data compatibility also matches', () => {
  const { manifest, options } = candidate(packageInputs())
  const reversed = Object.fromEntries(Object.entries(manifest).reverse())
  reversed.dataCompatibility = Object.fromEntries(Object.entries(manifest.dataCompatibility).reverse())
  const accepted = validateInstallManifest(reversed, { ...options, installedManifest: manifest })
  assert.equal(accepted.status, 'no-op')
  assert.deepEqual(accepted.manifest, manifest)
  accepted.manifest.payload.sha256 = 'c'.repeat(64)
  assert.notEqual(accepted.manifest.payload.sha256, manifest.payload.sha256)
  for (const mutate of [
    value => { value.sourceDigest = 'b'.repeat(64) }, value => { value.payload.sha256 = 'b'.repeat(64) },
    value => { value.dataCompatibility.sessionFormat += 1 },
    value => { value.dataCompatibility.spatialStore = { min: 7, max: 7 } },
    value => { value.dataCompatibility.accessibilityStore = { min: 2, max: 2 } },
    value => { value.dataCompatibility.storageSqlite += 1 },
  ]) {
    const installed = structuredClone(manifest)
    mutate(installed)
    assert.throws(() => validateInstallManifest(manifest, { ...options, installedManifest: installed }), fails('MAP_VERSION_CONFLICT'))
  }
})

test('installed product, channel, distribution, target and revision conflicts precede version replacement', () => {
  const { manifest, options } = candidate(packageInputs())
  for (const [field, value, code] of [
    ['product', 'dsh', 'MAP_INSTALL_SCHEMA'], ['channel', 'preview', 'MAP_INSTALL_IDENTITY'],
    ['distribution', 'managed', 'MAP_INSTALL_IDENTITY'], ['target', 'linux-x64', 'MAP_INSTALL_IDENTITY'],
    ['identityRevision', 2, 'MAP_INSTALL_SCHEMA'],
  ]) {
    assert.throws(() => validateInstallManifest(manifest, { ...options, installedManifest: { ...manifest, version: '1.0.0', [field]: value } }), fails(code))
  }
  assert.equal(validateInstallManifest(manifest, { ...options, installedManifest: { ...manifest, version: '1.0.0' } }).status, 'ready')
})

test('construction and validation stop on combined errors rather than accepting partial identity', async t => {
  const root = buildRoot(t)
  const item = packageInputs({ supported: ['mac-arm64', 'linux-x64'] })
  const { manifest, options } = candidate(item)
  for (const candidate of [
    { ...manifest, product: 'dsh', channel: 'preview', sourceDigest: 'b'.repeat(64) },
    { ...manifest, distribution: 'managed', target: 'linux-x64' },
    { ...manifest, payload: { ...manifest.payload, sha256: 'b'.repeat(64) }, dataCompatibility: { ...manifest.dataCompatibility, sessionFormat: 5 } },
  ]) assert.throws(() => validateInstallManifest(candidate, options), MapInstallError)
  refreshRecord(item, 'linux-x64', record => { record.sourceDigest = 'c'.repeat(64); record.install.channel = 'preview' })
  const before = inventory(root)
  await assert.rejects(() => createInstallManifest(buildOptions(root, item)), fails('MAP_INSTALL_PAYLOAD'))
  assert.deepEqual(inventory(root), before)
})

test('I/O and parse failures retain useful classifications without leaking input contents', t => {
  const root = buildRoot(t)
  write(root, INSTALL_CONTRACT_PATH, '{"private":"SENSITIVE",')
  assert.throws(() => readInstallContract(root), error => {
    fails('MAP_INSTALL_SCHEMA')(error)
    assert.doesNotMatch(error.message, /SENSITIVE/u)
    assert.equal(error.cause, undefined)
    return true
  })
  rmSync(join(root, INSTALL_CONTRACT_PATH))
  assert.throws(() => readInstallContract(root), error => {
    fails('MAP_INSTALL_IO')(error)
    assert.equal(error.details.reason, 'ENOENT')
    assert.equal(error.cause.code, 'ENOENT')
    return true
  })
})
