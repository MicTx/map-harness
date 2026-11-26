import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { admitSourceImage } from '../src/source-image.ts'
import { SourceCatalogError } from '../src/source-error.ts'

const plan = (width, height) => ({
  kind: 'image', width, height, url: new URL('https://private.example.test/native'),
  cacheKey: 'private fixture key',
})
const pixelSource = () => sharp({ create: { width: 8, height: 4, channels: 3, background: '#204060' } })
const unavailable = error => error instanceof SourceCatalogError && error.code === 'SOURCE_UNAVAILABLE'

test('native PNG/JPEG headers retain original bytes and match exact non-square dimensions', async () => {
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg']]) {
    const bytes = await pixelSource()[format]().toBuffer()
    const before = Buffer.from(bytes)
    assert.equal(await admitSourceImage(bytes, mime, plan(8, 4)), mime)
    assert.deepEqual(bytes, before)
    await assert.rejects(admitSourceImage(bytes, mime, plan(4, 8)), unavailable)
    await assert.rejects(admitSourceImage(bytes, mime, plan(8, 5)), unavailable)
    await assert.rejects(admitSourceImage(bytes, mime === 'image/png' ? 'image/jpeg' : 'image/png', plan(8, 4)), unavailable)
  }
})

test('unsupported media, provider error bytes and EXIF rotations never become native image success', async () => {
  await assert.rejects(admitSourceImage(Buffer.from('{"error":"private provider error"}'), 'image/png', plan(8, 4)), unavailable)
  await assert.rejects(admitSourceImage(await pixelSource().webp().toBuffer(), 'image/png', plan(8, 4)), unavailable)
  const rotated = await pixelSource().withMetadata({ orientation: 6 }).jpeg().toBuffer()
  await assert.rejects(admitSourceImage(rotated, 'image/jpeg', plan(8, 4)), unavailable)
  const identity = await pixelSource().withMetadata({ orientation: 1 }).jpeg().toBuffer()
  assert.equal(await admitSourceImage(identity, 'image/jpeg', plan(8, 4)), 'image/jpeg')
})
