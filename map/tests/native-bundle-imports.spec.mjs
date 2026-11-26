/** Full native packaging keeps value-only credential imports inside the compiled Map bundle. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const repo = join(import.meta.dirname, '../..')

test('map-container bundles the credential value API instead of leaving an ESM require', () => {
  const config = readFileSync(join(repo, 'map/map-container/tsdown.config.ts'), 'utf8')
  assert.match(config, /specifier === '@deepseek-ai\/dsh-credentials'/u,
    'the tsdown alwaysBundle predicate must inline the credential value imports')
  const literal = readFileSync(join(repo, 'map/map-container/package.json'), 'utf8')
  assert.match(JSON.parse(literal).dependencies['@deepseek-ai/dsh-credentials'], /^workspace:/u)
  const built = join(repo, 'map/map-container/lib/index.js')
  assert.equal(existsSync(built), true, 'run the map-container package build before this gate')
  const source = readFileSync(built, 'utf8')
  assert.doesNotMatch(source, /(?:from|require\()\s*["']@deepseek-ai\/dsh-credentials["']/u,
    'a compiled Map loader must not require a late-loading ESM credential package')
  assert.match(source, /function credentialRef|const credentialRef|credentialRef\s*=/u,
    'the value helpers remain available inside the bundle')
})
