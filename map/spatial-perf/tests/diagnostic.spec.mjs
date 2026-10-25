/** Diagnostic CLI and baseline failure-path tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const bin = join(root, 'map/spatial-perf/bin/perf-bench.mjs')

function run(args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
  })
}

test('the diagnostic command writes a v2 report and compares it to a baseline', () => {
  const dir = mkdtempSync(join('/tmp', 'spatial-perf-diagnostic-test-'))
  try {
    const firstPath = join(dir, 'first.json')
    const secondPath = join(dir, 'second.json')
    const first = run(['--json', firstPath])
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /calibration:/)
    assert.match(first.stdout, /locate folds throughput:/)
    assert.match(first.stdout, /advisory throughput/)
    const firstReport = JSON.parse(readFileSync(firstPath, 'utf8'))
    assert.equal(firstReport.methodVersion, 'spatial-perf@2')
    assert.ok(firstReport.calibration)
    assert.ok(firstReport.advisory)

    const second = run(['--json', secondPath, '--baseline', firstPath])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /trend \(baseline → current\)/)
    assert.match(second.stdout, /no regressions/)
    assert.ok(JSON.parse(readFileSync(secondPath, 'utf8')).calibration)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline failures are named and never emit a false trend', () => {
  const dir = mkdtempSync(join('/tmp', 'spatial-perf-baseline-test-'))
  try {
    const missing = run(['--baseline', join(dir, 'missing.json')])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /baseline not found/)
    assert.doesNotMatch(`${missing.stdout}${missing.stderr}`, /no regressions|trend \(/)

    const brokenPath = join(dir, 'broken.json')
    writeFileSync(brokenPath, '{')
    const broken = run(['--baseline', brokenPath])
    assert.notEqual(broken.status, 0)
    assert.match(broken.stderr, /baseline is not valid JSON/)
    assert.doesNotMatch(`${broken.stdout}${broken.stderr}`, /SyntaxError/)

    const invalidPath = join(dir, 'invalid.json')
    writeFileSync(invalidPath, JSON.stringify({ methodVersion: 'spatial-perf@1' }))
    const invalid = run(['--baseline', invalidPath])
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /baseline has invalid report structure/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
