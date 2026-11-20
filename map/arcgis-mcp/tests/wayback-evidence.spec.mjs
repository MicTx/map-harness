import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageGridCoverage, isolatedTemp, proxyEvidenceSecrets, redactEvidence, writeEvidence } from './wayback-evidence.mjs'

test('evidence redacts startup credentials in nested diagnostics and text', () => {
  const credential = 'fixture-private-token'
  const value = {
    url: `http://127.0.0.1:1234/?token=${credential}&other=kept`,
    stdout: `ready: http://127.0.0.1:1234/?token=${credential}\n`,
    nested: [{ message: `failed ${credential}`, plain: 'useful context' }],
  }
  const result = redactEvidence(value, [credential])
  assert.equal(JSON.stringify(result).includes(credential), false)
  assert.match(result.url, /other=kept/u)
  assert.equal(result.nested[0].plain, 'useful context')
  assert.equal(value.nested[0].message.includes(credential), true)
})

test('evidence redacts query credentials even when the exact token is unknown', () => {
  const result = redactEvidence({ url: 'http://localhost/?token=opaque&other=kept', error: 'authorization: Bearer opaque' }, [])
  assert.doesNotMatch(JSON.stringify(result), /opaque/u)
  assert.match(result.url, /other=kept/u)
})

test('visual coverage rejects a mostly blank quadrant even if the overall frame is colorful', () => {
  const width = 40; const height = 40
  const full = Buffer.alloc(width * height * 4)
  for (let i = 0; i < full.length; i += 4) { full[i] = 40; full[i + 1] = 80; full[i + 2] = 120; full[i + 3] = 255 }
  const partial = Buffer.from(full)
  for (let y = 0; y < height / 2; y += 1) {
    for (let x = 0; x < width / 2; x += 1) partial.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4)
  }
  assert.equal(imageGridCoverage(full, width, height).every(value => value > 0.8), true)
  assert.equal(imageGridCoverage(partial, width, height)[0], 0)
})

test('proxy without credentials does not redact ordinary evidence', () => {
  const secrets = proxyEvidenceSecrets('http://127.0.0.1:8080')
  const value = redactEvidence({ receipt: { token: 'public-digest' }, provider: 'example' }, secrets)
  assert.equal(value.provider, 'example')
  assert.equal(secrets.length, 1)
})

test('evidence redacts secrets in object keys and username-only proxies', () => {
  const username = 'fixture-username-only'
  const proxyUrl = `http://${username}@proxy.invalid:8080`
  const secrets = proxyEvidenceSecrets(proxyUrl)
  const value = redactEvidence({ [username]: `diagnostic ${username}` }, secrets)
  assert.equal(JSON.stringify(value).includes(username), false)
})

test('invalid proxy values remain available for redaction without parsing failure', () => {
  const invalid = 'not a valid proxy URL'
  assert.deepEqual(proxyEvidenceSecrets(invalid), [invalid])
  assert.equal(redactEvidence(`failed ${invalid}`, proxyEvidenceSecrets(invalid)), 'failed [redacted]')
})

test('temporary evidence roots outside the repository are accepted and inside ones are refused', t => {
  const outside = isolatedTemp(process.cwd(), 'wayback-evidence-outside-')
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.notEqual(outside, process.cwd())
  const captiveRoot = mkdtempSync(join(tmpdir(), 'wayback-evidence-inside-'))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = captiveRoot
  try {
    assert.throws(() => isolatedTemp(captiveRoot, 'wayback-evidence-captive-'), /outside the repository/u)
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    rmSync(captiveRoot, { recursive: true, force: true })
  }
})

test('evidence files redact proxy credentials and quoted secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wayback-evidence-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const secret = 'fixture-proxy-password'
  const proxyUrl = `http://fixture-proxy-user:${secret}@proxy.invalid:8080`
  const secrets = proxyEvidenceSecrets(proxyUrl)
  const auth = Buffer.from(`fixture-proxy-user:${secret}`).toString('base64')
  const message = JSON.stringify({ error: `failed ${proxyUrl}`, detail: secret, auth, payload: { token: 'opaque' } })
  writeEvidence(dir, 'diagnostic.json', message, secrets)
  const saved = readFileSync(join(dir, 'diagnostic.json'), 'utf8')
  const parsed = JSON.parse(saved)
  assert.equal(saved.includes(secret), false)
  assert.equal(saved.includes(auth), false)
  assert.doesNotMatch(saved, /fixture-proxy-user|opaque/u)
  assert.equal(parsed.detail, '[redacted]')
  assert.equal(parsed.payload.token, '[redacted]')
})
