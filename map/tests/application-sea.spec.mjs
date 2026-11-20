/** Windows snapshot path handling in the sealed pkg SEA prelude. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { driveAgnosticSnapshotPrelude } from '../bin/application-sea.mjs'

const require = createRequire(new URL('../bin/application-sea.mjs', import.meta.url))
const pkgRoot = dirname(require.resolve('@yao-pkg/pkg/package.json'))
const bundle = readFileSync(join(pkgRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')
const sealed = driveAgnosticSnapshotPrelude(bundle)

/** Count non-overlapping occurrences of literal text. */
function occurrences(source, search) {
  return source.split(search).length - 1
}

/** Escape prelude text the way the pkg bundle embeds it inside its single-quoted worker string. */
function embed(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
}

/**
 * Slice the snapshot drive handling out of a prelude copy, without the module export that follows it.
 * The sealed copy opens with the drive binding the pinned copy does not have.
 */
function driveRegion(source) {
  const starts = ['var SNAPSHOT_DRIVE', 'function toPlatformPath(p) {'].map(anchor => source.indexOf(anchor)).filter(index => index !== -1)
  assert.notEqual(starts.length, 0, 'prelude must define toPlatformPath')
  const found = Math.min(...starts)
  const end = source.indexOf('module2.exports = {', found)
  assert.notEqual(end, -1, 'prelude must export after the snapshot helpers')
  return source.slice(source.lastIndexOf('\n', found) + 1, source.lastIndexOf('\n', end))
}

/** Decode the worker bootstrap JavaScript text a prelude embeds as a single-quoted string. */
function workerBootstrap(source) {
  const marker = source.indexOf('var require_worker_bootstrap_string = __commonJS({')
  assert.notEqual(marker, -1, 'pkg prelude must embed a worker bootstrap')
  const line = source.slice(marker).split('\n').find(text => text.trimStart().startsWith('module2.exports = '))
  assert.ok(line !== undefined, 'pkg worker bootstrap must be a single-line string literal')
  const value = runInNewContext(line.trim().slice('module2.exports = '.length).replace(/;$/, ''))
  assert.equal(typeof value, 'string', 'pkg worker bootstrap must evaluate to JavaScript text')
  return value
}

/** Evaluate the sealed snapshot path helpers against one platform and executable drive. */
function snapshotPaths(source, { platform, execPath }) {
  const start = source.indexOf('var SNAPSHOT_DRIVE')
  assert.notEqual(start, -1, 'sealed prelude must derive the snapshot drive')
  const end = source.indexOf('module2.exports = {', start)
  assert.notEqual(end, -1, 'sealed prelude must export after the snapshot helpers')
  const code = `${source.slice(start, end)}\n;({ insideSnapshot: insideSnapshot, toPlatformPath: toPlatformPath })`
  return runInNewContext(code, { process: { platform, execPath } })
}

for (const [copy, source] of [['main', sealed], ['worker', workerBootstrap(sealed)]]) {
  test(`sealed ${copy} prelude resolves the snapshot root on any Windows drive`, () => {
    const { insideSnapshot, toPlatformPath } = snapshotPaths(source, {
      platform: 'win32', execPath: 'D:\\runner\\map-harness\\map-harness.exe' })

    // The drive GitHub's Windows runner extracts to, which a fixed C: and V: list misses.
    assert.equal(insideSnapshot('D:\\snapshot\\node_modules\\@koromix\\koffi-win32-x64\\win32_x64\\koffi.node'), true)
    assert.equal(insideSnapshot('D:\\snapshot'), true)
    assert.equal(insideSnapshot('D:/snapshot/node_modules/koffi.node'), true)
    for (const drive of ['C', 'V', 'Z']) {
      assert.equal(insideSnapshot(`${drive}:\\snapshot\\addon.node`), true, `${drive}: backslash form`)
      assert.equal(insideSnapshot(`${drive}:/snapshot/addon.node`), true, `${drive}: slash form`)
    }
    assert.equal(insideSnapshot('/snapshot/addon.node'), true)

    assert.equal(toPlatformPath('/snapshot/node_modules/koffi.node'), 'D:\\snapshot\\node_modules\\koffi.node')
    assert.equal(toPlatformPath('/snapshot'), 'D:\\snapshot')
    // A name that merely starts with the prefix is an ordinary path, not the root.
    assert.equal(toPlatformPath('/snapshotx/addon.node'), '\\snapshotx\\addon.node')
    assert.equal(toPlatformPath('/other/path'), '\\other\\path')
  })

  test(`sealed ${copy} prelude rejects paths that only resemble the snapshot root`, () => {
    const { insideSnapshot } = snapshotPaths(source, {
      platform: 'win32', execPath: 'D:\\runner\\map-harness.exe' })

    assert.equal(insideSnapshot('D:\\snapshotx\\addon.node'), false)
    assert.equal(insideSnapshot('D:\\other\\snapshot\\addon.node'), false)
    assert.equal(insideSnapshot('/snapshotx/addon.node'), false)
    assert.equal(insideSnapshot('snapshot/addon.node'), false)
    assert.equal(insideSnapshot(''), false)
    assert.equal(insideSnapshot(undefined), false)
    assert.equal(insideSnapshot(7), false)
  })

  test(`sealed ${copy} prelude keeps the POSIX snapshot prefix on other platforms`, () => {
    const { insideSnapshot, toPlatformPath } = snapshotPaths(source, {
      platform: 'darwin', execPath: '/usr/local/bin/map-harness' })

    assert.equal(insideSnapshot('/snapshot/node_modules/koffi.node'), true)
    assert.equal(insideSnapshot('/snapshot'), true)
    assert.equal(insideSnapshot('/snapshotx/addon.node'), false)
    assert.equal(insideSnapshot('D:\\snapshot\\addon.node'), false)
    assert.equal(toPlatformPath('/snapshot/node_modules/koffi.node'), '/snapshot/node_modules/koffi.node')
    assert.equal(toPlatformPath('/snapshotx/addon.node'), '/snapshotx/addon.node')
  })
}

test('sealing rewrites both prelude copies and nothing else', () => {
  const pinned = driveRegion(bundle)
  const driveAgnostic = driveRegion(sealed)
  assert.equal(occurrences(bundle, pinned), 1, 'pkg bundle must carry one bootstrap drive region')
  assert.equal(occurrences(bundle, embed(pinned)), 1, 'pkg bundle must carry one embedded drive region')
  assert.equal(occurrences(sealed, driveAgnostic), 1, 'sealed bundle must carry one bootstrap drive region')
  assert.equal(occurrences(sealed, embed(driveAgnostic)), 1, 'sealed bundle must carry one embedded drive region')
  assert.equal(occurrences(sealed, 'SNAPSHOT_PREFIXES_WIN'), 0, 'sealed bundle must not pin the snapshot to fixed drives')

  // Derive the inserted text from a marker-wrapped probe, so the comparison does not
  // depend on the replacement reading the transform's own source text.
  const markers = ['\u0001', '\u0002', '\u0003']
  const probed = driveAgnosticSnapshotPrelude(`${markers[0]}${pinned}${markers[1]}${embed(pinned)}${markers[2]}`)
  const [head, tail] = probed.split(markers[1])
  const inserted = { plain: head.slice(markers[0].length), embedded: tail.slice(0, -markers[2].length) }
  assert.equal(occurrences(probed, markers[0]), 1, 'probe markers must survive the seal')

  const strip = (source, plain, embedded) => source.split(plain).join('').split(embedded).join('')
  assert.equal(strip(sealed, inserted.plain, inserted.embedded), strip(bundle, pinned, embed(pinned)),
    'sealing must change nothing outside the snapshot drive regions')
})

test('sealing refuses a prelude without exactly one drive region per copy', () => {
  const pinned = driveRegion(bundle)
  assert.throws(() => driveAgnosticSnapshotPrelude(bundle.split(pinned).join('')),
    /has 0 bootstrap snapshot drive regions; expected exactly one/)
  assert.throws(() => driveAgnosticSnapshotPrelude(`${bundle}${pinned}`),
    /has 2 bootstrap snapshot drive regions; expected exactly one/)
  assert.throws(() => driveAgnosticSnapshotPrelude(sealed),
    /has 0 bootstrap snapshot drive regions; expected exactly one/)
})
