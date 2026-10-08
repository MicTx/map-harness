/**
 * Keyless object-store lane: the SigV4 signer checked against the published
 * AWS documentation vector (independent expected signature), then a scripted
 * service answers ListObjectsV2 — the connected pass (bucket echo, KeyCount
 * 0), the service error surface (401/403 auth-rejected with the service
 * error code, 404 NoSuchBucket, the 301/400 region hint), the request
 * contract violations a 200 can still commit (wrong bucket echo, nonzero
 * KeyCount), and the transport failures (deadline, abort, unreachable).
 * Requests are captured so the authorization line, the signing headers, the
 * address shapes (path vs virtual-hosted), and the secret-free detail text
 * are asserted byte-for-byte.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_BODY_SHA256, signSigV4, verifyObjectStore } from '../src/objectstore.ts'

const SPEC = {
  id: 'tiles',
  endpoint: 'https://s3.example.org',
  region: 'eu-west-1',
  bucket: 'tiles',
  accessKeyIdEnv: 'AK',
  secretAccessKeyEnv: 'SK',
  addressing: 'path',
}
const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY' }

/** One captured request with a scripted response. */
function captureFetch(respond) {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return await respond({ url, init, index: requests.length })
  }
  return { fetchImpl, requests }
}

/** A 200 listing body for a bucket. */
function listingBody(bucket, keyCount = 0) {
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix></Prefix><KeyCount>${String(keyCount)}</KeyCount><MaxKeys>0</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`
}

test('the SigV4 signer reproduces the published AWS documentation vector', () => {
  // AWS SigV4 developer guide: GET /test.txt from examplebucket, 20130524T000000Z.
  const signed = signSigV4({
    method: 'GET',
    canonicalUri: '/test.txt',
    canonicalQuery: '',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    signedHeaders: ['host', 'range', 'x-amz-content-sha256', 'x-amz-date'],
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    amzDate: '20130524T000000Z',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  })
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  )
})

test('the empty-body hash is the published sha256 of nothing', () => {
  assert.equal(EMPTY_BODY_SHA256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('a signed listing is a GET with max-keys=0, content hash, and an authorization line', async () => {
  const { fetchImpl, requests } = captureFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => listingBody('tiles'),
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.init.method, 'GET')
  assert.equal(new URL(request.url).pathname, '/tiles/')
  assert.equal(new URL(request.url).search, '?list-type=2&max-keys=0')
  assert.equal(request.init.headers['x-amz-content-sha256'], EMPTY_BODY_SHA256)
  assert.match(request.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
  assert.equal(request.init.headers.authorization.includes(CREDENTIALS.secretAccessKey), false)
  const facts = report.facts
  assert.ok(facts !== undefined && 'bucketName' in facts)
  assert.equal(facts.bucketName, 'tiles')
  assert.equal(facts.keyCount, 0)
  assert.equal(report.connectionId, 'tiles')
  assert.equal(report.kind, 'object-storage')
})

test('virtual-hosted addressing moves the bucket into the host and the canonical URI', async () => {
  const { fetchImpl, requests } = captureFetch(async ({ url }) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => listingBody('tiles'),
  }))
  const report = await verifyObjectStore({ ...SPEC, addressing: 'virtual-hosted' }, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  assert.equal(new URL(requests[0].url).hostname, 'tiles.s3.example.org')
  assert.equal(new URL(requests[0].url).pathname, '/')
  assert.equal(requests[0].init.headers.host, 'tiles.s3.example.org')
})

test('a session token rides the security-token header and the signature scope', async () => {
  const { fetchImpl, requests } = captureFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => listingBody('tiles'),
  }))
  const report = await verifyObjectStore(SPEC, { ...CREDENTIALS, sessionToken: 'SESS_TOKEN_1' }, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  assert.equal(requests[0].init.headers['x-amz-security-token'], 'SESS_TOKEN_1')
  assert.match(requests[0].init.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/)
})

test('a 200 answering for another bucket is a protocol violation', async () => {
  const { fetchImpl } = captureFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => listingBody('other-bucket'),
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
  assert.match(report.detail, /other-bucket/)
})

test('a 200 answering a nonzero KeyCount violates the max-keys=0 request contract', async () => {
  const { fetchImpl } = captureFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => listingBody('tiles', 7),
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
  assert.match(report.detail, /KeyCount/)
})

test('401/403 answers are auth-rejected with the service error code, never the secret', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = captureFetch(async () => ({
      ok: false, status,
      headers: { get: () => null },
      text: async () => `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match.</Message></Error>`,
    }))
    const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
    assert.equal(report.outcome, 'auth-rejected', String(status))
    assert.match(report.detail, /SignatureDoesNotMatch/)
    assert.equal(report.detail.includes(CREDENTIALS.secretAccessKey), false)
  }
})

test('a 404 is not-found for the declared bucket', async () => {
  const { fetchImpl } = captureFetch(async () => ({
    ok: false, status: 404,
    headers: { get: () => null },
    text: async () => `<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message></Error>`,
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'not-found')
  assert.match(report.detail, /tiles/)
})

test('a 301 with the bucket-region hint names the wrong region instead of retrying', async () => {
  const { fetchImpl } = captureFetch(async () => ({
    ok: false, status: 301,
    headers: { get: name => (name === 'x-amz-bucket-region' ? 'eu-central-1' : null) },
    text: async () => '',
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'server-refused')
  assert.match(report.detail, /eu-central-1/)
  assert.match(report.detail, /eu-west-1/)
})

test('other statuses are server refusals without capability', async () => {
  const { fetchImpl } = captureFetch(async () => ({
    ok: false, status: 503,
    headers: { get: () => null },
    text: async () => '<html>slow down</html>',
  }))
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'server-refused')
  assert.match(report.detail, /503/)
})

test('a transport failure is unreachable and stays secret-free', async () => {
  const { fetchImpl } = captureFetch(async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND s3.example.org'), { code: 'ENOTFOUND' })
  })
  const report = await verifyObjectStore(SPEC, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'unreachable')
  assert.match(report.detail, /ENOTFOUND/)
  assert.equal(report.detail.includes(CREDENTIALS.secretAccessKey), false)
})

test('a silent service hits the deadline and reports timeout', async () => {
  // The scripted fetch honors the deadline signal exactly like the real one.
  const { fetchImpl } = captureFetch(({ init }) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  const report = await verifyObjectStore({ ...SPEC, timeoutMs: 1000 }, CREDENTIALS, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'timeout')
})

test('caller abort reports aborted', async () => {
  const controller = new AbortController()
  const { fetchImpl } = captureFetch(({ init }) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  setTimeout(() => controller.abort(), 50)
  const report = await verifyObjectStore({ ...SPEC, timeoutMs: 5000 }, CREDENTIALS, { fetchImpl, signal: controller.signal, now: () => 0 })
  assert.equal(report.outcome, 'aborted')
  assert.match(report.detail, /aborted/)
})
