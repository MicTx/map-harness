/** Preparation and installation-contract assertions for the standalone Map launch chain. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createInstallDescriptor, readDataCompatibility, INSTALL_CONTRACT_PATH, INSTALL_MANIFEST_FILE } from '../bin/install-manifest.mjs'
import { readWebServiceContract } from '../bin/web-service-contract.mjs'

const repo = join(import.meta.dirname, '../..')

test('build descriptors freeze the distribution identity and validate compatibility shape', async () => {
  const compatibility = await readDataCompatibility(repo)
  const descriptor = createInstallDescriptor({ distribution: 'portable', channel: 'stable', dataCompatibility: compatibility })
  assert.equal(descriptor.product, 'map-harness')
  assert.equal(descriptor.identityRevision, 1)
  assert.equal(descriptor.distribution, 'portable')
  assert.equal(descriptor.channel, 'stable')
  assert.deepEqual(descriptor.dataCompatibility, compatibility)
  assert.equal(descriptor.dataCompatibility.sessionFormat, 4)
  const changed = createInstallDescriptor({ distribution: 'managed', channel: 'preview', dataCompatibility: compatibility })
  assert.notEqual(changed.distribution, descriptor.distribution)
  assert.notEqual(changed.channel, descriptor.channel)
  assert.throws(() => createInstallDescriptor({ distribution: 'portable', channel: 'stable', dataCompatibility: { sessionFormat: 4 } }), /compatibility|distribution|channel/u)
})

test('the web-service contract resolves one independent data home', () => {
  const contract = readWebServiceContract(repo)
  assert.equal(contract.format, 2)
  assert.deepEqual(contract.dataHome.environment, ['MAPHARNESS_HOME'])
  assert.equal(contract.dataHome.default, '~/.map-harness')
})

test('the native build entry accepts an explicit distribution and channel', () => {
  const source = readFileSync(join(repo, 'map/bin/build-application.mjs'), 'utf8')
  assert.match(source, /createInstallDescriptor\(\{ \.\.\.identity, dataCompatibility: await readDataCompatibility\(ROOT\) \}\)/u)
  assert.match(source, /manifest\.install = install/u)
  assert.match(source, /sha256: hash\(readFileSync\(executable\)\), webService, install,/u)
  assert.match(source, /--distribution/u)
  assert.match(source, /--channel/u)
})

test('the build pipeline delegates helper staging to the native payload owner', () => {
  const application = readFileSync(join(repo, 'map/bin/build-application.mjs'), 'utf8')
  const bootstrap = readFileSync(join(repo, 'map/bin/application-bootstrap.mjs'), 'utf8')
  assert.match(application, /stageApplicationHelpers\(ROOT, stage\)/u)
  assert.match(bootstrap, /resolveMapEntry/u)
  assert.match(bootstrap, /acquireInstanceLock/u)
  assert.equal(bootstrap.includes("join(homedir(), '.dsh')"), false)
})

test('the installation contract is present and consistent with the identity revision', () => {
  const contract = JSON.parse(readFileSync(join(repo, INSTALL_CONTRACT_PATH), 'utf8'))
  assert.equal(contract.format, 'map-harness-install-contract-1')
  assert.equal(contract.manifest.file, INSTALL_MANIFEST_FILE)
  assert.equal(contract.product, 'map-harness')
  assert.deepEqual(contract.distributions, ['portable', 'managed'])
  assert.deepEqual(contract.channels, ['stable', 'preview'])
})

test('an install-identity disagreement in a simulated build is rejected before any payload work', () => {
  assert.throws(() => createInstallDescriptor({ distribution: 'bundle', channel: 'stable', dataCompatibility: { sessionFormat: 4 } }), /distribution/u)
  assert.throws(() => createInstallDescriptor({ distribution: 'portable', channel: 'beta', dataCompatibility: { sessionFormat: 4 } }), /channel/u)
})

test('the map test aggregate covers the standalone instance gates', () => {
  const aggregate = readFileSync(join(repo, 'map/bin/test.mjs'), 'utf8')
  for (const spec of ['instance-home.spec.mjs', 'instance-launch.spec.mjs', 'instance-lock.spec.mjs', 'install-manifest.spec.mjs']) {
    assert.match(aggregate, new RegExp(spec.replaceAll('.', '\\.'), 'u'))
  }
})

test('the root launch scripts select the isolated instance prelude', () => {
  const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts
  assert.match(scripts['start:web'], /--import \.\/map\/bin\/source-preload\.mjs/u)
  assert.match(scripts['dev:web'], /--profile map-web/u)
  const devWeb = readFileSync(join(repo, 'scripts/dev-web.ts'), 'utf8')
  assert.match(devWeb, /options\.preload === undefined \? \[\] : \['--import', options\.preload\]/u)
})
