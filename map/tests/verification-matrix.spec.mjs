/**
 * Verification-matrix consistency gate: the capability→evidence matrix in
 * `docs/verification-matrix.md` is machine-checked against the tree so the
 * matrix and the suites cannot drift apart. Enforces, per the doc's own
 * 机器门禁 contract: every owner section maps all seven evidence layers
 * (with a reason wherever a layer is `none`), every referenced `map/...`
 * path exists, every suite file under map tests directories is registered,
 * every aggregate label in `map/bin/test.mjs` is listed, and every command
 * in the matrix resolves to a real package/root script or file — planned
 * packages must stay absent until their row becomes real. The parse rules
 * themselves are negative-tested against malformed input.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(mapRoot, '..')
const docPath = join(mapRoot, 'docs', 'verification-matrix.md')
const doc = readFileSync(docPath, 'utf8')

/** The owner rows the matrix must carry (dir token per `###` section, in order). */
const OWNER_DIR_TOKENS = [
  'map-container',
  'map-container',
  'tools',
  'tools',
  'arcgis-mcp',
  'client-ui-brand',
  'profiles',
  'presets',
  'bin',
  'tests',
  'spatial-storage',
  'spatial-catalog',
  'spatial-context',
  'spatial-accessibility',
  'spatial-statistics',
  'spatial-decision',
  'spatial-viz',
  'spatial-collab',
  'spatial-terrain',
  'spatial-realtime',
  'stream-providers',
  'spatial-scale',
  'spatial-perf',
  'spatial-observability',
  'spatial-connect',
  'mcp-transport',
]

/** Packages whose rows are delivery contracts: command documented, package absent. */
const PLANNED_PACKAGES = []

const LAYER_KEYS = ['unit', 'integration', 'Loader', 'snapshot', 'numeric', 'perf', 'ops']

/** Split the doc into `###` sections; each becomes { heading, body }. */
export function parseSections(text) {
  const sections = []
  const lines = text.split('\n')
  let current
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current !== undefined) sections.push(current)
      current = { heading: line.slice(4), body: '' }
    } else if (current !== undefined && line.startsWith('## ')) {
      sections.push(current)
      current = undefined
    } else if (current !== undefined) {
      current.body += `${line}\n`
    }
  }
  if (current !== undefined) sections.push(current)
  return sections
}

/**
 * Validate one owner section: all seven layer bullets present, and every
 * `none` value carries a reason (`none — why`).
 * @returns the parsed layer values keyed by layer name.
 */
export function assertSectionLayers(section) {
  const layers = {}
  for (const key of LAYER_KEYS) {
    const match = section.body.match(new RegExp(`^- ${key}: (.+)$`, 'm'))
    assert.ok(match, `section "${section.heading}" lacks its ${key} layer bullet`)
    const value = match[1].trim()
    if (value === 'none' || value === 'none —') {
      throw new Error(`section "${section.heading}" layer ${key} says none without a reason ("none — <why>")`)
    }
    layers[key] = value
  }
  return layers
}

test('every owner row exists and maps all seven evidence layers', () => {
  const ownerSections = parseSections(doc)
  assert.equal(ownerSections.length, OWNER_DIR_TOKENS.length, 'the matrix carries exactly the agreed owner rows')
  const tokens = ownerSections
    .map(section => section.heading.match(/^`([^`]+)`/)?.[1])
    .map(token => (token ?? '').replace(/\/$/, ''))
  assert.deepEqual(tokens, OWNER_DIR_TOKENS, 'owner rows must cover every domain/engineering package')
  for (const section of ownerSections) assertSectionLayers(section)
})

test('every backticked map/... path in the matrix exists', () => {
  // `map/...` in prose is an ellipsis; planned owner dirs are delivery
  // contracts that must stay absent until their row becomes real.
  const plannedPaths = new Set(PLANNED_PACKAGES.map(pkg => `map/${pkg}`))
  const paths = [...doc.matchAll(/`(map\/[A-Za-z0-9_./-]+)`/g)]
    .map(match => match[1])
    .filter(path => !path.includes('..'))
  assert.ok(paths.length >= 20, `the matrix should reference the tree densely (found ${paths.length})`)
  const missing = [...new Set(paths)]
    .filter(path => !plannedPaths.has(path) && !existsSync(join(repoRoot, path)))
  assert.deepEqual(missing, [], 'every referenced map path must exist')
  for (const planned of plannedPaths) {
    assert.equal(existsSync(join(repoRoot, planned)), false, `planned owner ${planned} appeared — make its matrix row real`)
  }
})

test('every map suite file is registered in the matrix', () => {
  const suites = []
  for (const entry of readdirSync(mapRoot)) {
    const testsDir = join(mapRoot, entry, 'tests')
    if (!statSync(join(mapRoot, entry)).isDirectory() || !existsSync(testsDir)) continue
    for (const file of readdirSync(testsDir)) {
      if (/\.spec\.mjs$|\.e2e\.mjs$/.test(file)) suites.push(`map/${entry}/tests/${file}`)
    }
  }
  const unregistered = suites.filter(suite => !doc.includes(suite))
  assert.deepEqual(unregistered, [], 'every suite must appear in the matrix (fixture inventory has no gaps)')
})

test('every aggregate suite label in the runner is listed in the matrix', () => {
  const runner = readFileSync(join(mapRoot, 'bin', 'test.mjs'), 'utf8')
  const labels = [
    ...[...runner.matchAll(/packageSuite\('([^']+)'/g)].map(match => match[1]),
    ...[...runner.matchAll(/label: '([^']+)'/g)].map(match => match[1]),
  ]
  assert.ok(labels.length >= 9, 'the aggregate should carry every suite lane')
  const unlisted = labels.filter(label => !doc.includes(`\`${label}\``))
  assert.deepEqual(unlisted, [], 'runner labels and the matrix suite registry must match')
})

test('every documented command resolves to a real script or file', () => {
  // Workspace package name → manifest dir, mirroring the topology gate.
  const manifests = new Map()
  for (const entry of readdirSync(mapRoot)) {
    const manifestPath = join(mapRoot, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name === 'string') manifests.set(manifest.name, { dir: entry, scripts: manifest.scripts ?? {} })
  }
  const rootScripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts ?? {}

  // Grammar placeholders in the 机器门禁 section carry `<` and are not commands.
  const commands = [...doc.matchAll(/`([^`\n]+)`/g)]
    .map(match => match[1])
    .filter(token => /^(pnpm|node) /.test(token) && !token.includes('<'))
  assert.ok(commands.length >= 10, `the matrix should pin its commands (found ${commands.length})`)

  const unresolved = []
  for (const command of commands) {
    const filterMatch = command.match(/^pnpm --filter (@[\w-]+\/[\w-]+) run ([\w:-]+)$/)
    if (filterMatch !== null) {
      const [, pkg, script] = filterMatch
      if (PLANNED_PACKAGES.includes(pkg.split('/')[1])) {
        // A planned row is a delivery contract: no package may exist yet.
        assert.equal(manifests.has(pkg), false, `planned package ${pkg} appeared — make its matrix row real`)
        continue
      }
      const manifest = manifests.get(pkg)
      if (manifest === undefined || !(script in manifest.scripts)) unresolved.push(command)
      continue
    }
    const rootMatch = command.match(/^pnpm run ([\w:-]+)$/)
    if (rootMatch !== null) {
      if (!(rootMatch[1] in rootScripts)) unresolved.push(command)
      continue
    }
    const nodeMatch = command.match(/^node (?:--test )?(map\/[^\s]+)/)
    if (nodeMatch !== null) {
      if (!existsSync(join(repoRoot, nodeMatch[1]))) unresolved.push(command)
      continue
    }
    unresolved.push(command)
  }
  assert.deepEqual(unresolved, [], 'every matrix command must resolve against the workspace')
})

test('the gate-ownership section stays present', () => {
  for (const marker of [
    '## 门禁归属、刷新规则与审查流程',
    '## 未实现能力的门禁归属（out-of-scope 表）',
    '## 回放 fixture 清单',
    '## 资源可靠性约定',
    '## 聚合 suite 登记',
    // The keyed snapshot channel flipped from external_blocked to established
    // on 2026-09-26: the recorded scenario and its keyless replay numbers are
    // now load-bearing matrix facts.
    '已建立（2026-09-26）',
    '`snapshots/session/map-analyst-turn`',
  ]) {
    assert.ok(doc.includes(marker), `the matrix must keep its "${marker}" section`)
  }
  assert.equal(doc.includes('external_blocked — 录制需真实'), false,
    'the keyed snapshot row must stay flipped to the established channel')
})

test('the parse rules reject malformed sections (negative self-check)', () => {
  const missingLayer = { heading: '`demo/`', body: '- unit: something\n- integration: something\n' }
  assert.throws(() => assertSectionLayers(missingLayer), /lacks its Loader layer bullet/)
  const bareNone = {
    heading: '`demo/`',
    body: LAYER_KEYS.map(key => `- ${key}: ${key === 'perf' ? 'none' : 'evidence'}`).join('\n'),
  }
  assert.throws(() => assertSectionLayers(bareNone), /none without a reason/)
})
