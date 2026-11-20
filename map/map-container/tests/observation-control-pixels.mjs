/**
 * Lead-authored mechanical PNG measurements. Color matching identifies the
 * real SDK marker, not a label drawn by the compositor. The independent
 * geometry checker, not this collector, decides whether residuals pass.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import { OBSERVATION_CONTROL_POINTS } from './observation-control-cases.mjs'

const path = resolve(process.argv[2])
const artifact = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(artifact.schemaVersion, 1)
const cases = []
for (const value of artifact.cases) {
  const png = readFileSync(join(dirname(path), value.png.path))
  assert.equal(createHash('sha256').update(png).digest('hex'), value.png.sha256)
  const { data, info } = await sharp(png).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.channels, 4)
  const markers = OBSERVATION_CONTROL_POINTS.map(({ color }, index) => {
    let count = 0
    let sumX = 0
    let sumY = 0
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * 4
        if (data[offset + 3] >= 250
          && Math.abs(data[offset] - color[0]) <= 8
          && Math.abs(data[offset + 1] - color[1]) <= 8
          && Math.abs(data[offset + 2] - color[2]) <= 8) {
          count += 1
          sumX += x + 0.5
          sumY += y + 0.5
        }
      }
    }
    return { index, color, count, centroid: count === 0 ? null : { x: sumX / count, y: sumY / count } }
  })
  cases.push({ name: value.name, sha256: value.png.sha256, width: info.width, height: info.height, markers })
}
const output = join(dirname(path), 'sdk-marker-pixels.json')
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`)
console.log(output)
