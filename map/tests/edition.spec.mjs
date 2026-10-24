/** Community branding and preset display metadata. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
test('the edition line falls back to the community edition', async () => {
  const { editionLine, COMMUNITY_EDITION, BRAND_HEADLINE } = await import('../client-ui-brand/src/client/edition.ts')
  assert.equal(BRAND_HEADLINE, '探索未至之境 x Map Harness')
  assert.equal(editionLine(undefined), COMMUNITY_EDITION)
  assert.equal(editionLine('  '), '社区版')
  assert.equal(editionLine(' 示例单位 '), '示例单位')
})

test('the map-analyst preset publishes a mode name and description in both declarations', () => {
  for (const file of ['map/presets/map-analyst/preset.yml', 'map/profiles/map-web/presets/map-analyst.patch.yml']) {
    const text = readFileSync(join(root, file), 'utf8')
    assert.match(text, /name: 地图分析模式$/m, file)
    assert.match(text, /description: \S.*选址/m, file)
  }
})
