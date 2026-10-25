/** The regular map aggregate runs privacy checks and propagates their failures. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const aggregate = new URL('../bin/test.mjs', import.meta.url).href
const required = ['edition.spec.mjs', 'public-brand-privacy.spec.mjs', 'privacy-aggregate.spec.mjs']

function inspectAggregate(rejectedSuite) {
  const program = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename } from 'node:path';
    childProcess.spawnSync = (command, args) => {
      process.stdout.write('AGGREGATE_COMMAND ' + JSON.stringify(args) + '\\n');
      return { status: args.some(arg => basename(arg) === ${JSON.stringify(rejectedSuite ?? '')}) ? 1 : 0 };
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(aggregate)});
  `
  return spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: resolve(root), encoding: 'utf8',
  })
}

test('the normal aggregate includes each brand privacy suite exactly once', () => {
  const result = inspectAggregate()
  assert.equal(result.status, 0, result.stderr)
  const files = result.stdout.split('\n')
    .filter(line => line.startsWith('AGGREGATE_COMMAND '))
    .flatMap(line => JSON.parse(line.slice('AGGREGATE_COMMAND '.length)))
    .map(file => basename(file))
  for (const name of required) assert.equal(files.filter(file => file === name).length, 1, name)
})

for (const name of required.slice(0, 2)) {
  test(`the aggregate exits unsuccessfully when ${name} fails`, () => {
    const result = inspectAggregate(name)
    assert.equal(result.status, 1, result.stderr)
  })
}
