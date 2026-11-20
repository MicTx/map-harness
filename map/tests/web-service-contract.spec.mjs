import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'
import { acceptedApplications } from '../bin/application-assets.mjs'
import { assertWebServiceApplications } from '../bin/pack-web-service.mjs'
import { assertWebApplicationMode, readWebServiceContract, webServiceApplicationDescriptor } from '../bin/web-service-contract.mjs'

const repo = join(import.meta.dirname, '../..')

test('the Web service contract owns delivery shape without duplicating truth', () => {
  const contract = readWebServiceContract(repo)
  assert.equal(contract.serviceMode, 'web')
  assert.equal(contract.profile, 'map-web')
  assert.equal(contract.versionSource, 'map/release/version.json')
  assert.equal(contract.launchers.posix, 'start-web.sh')
  assert.equal(contract.launchers.windows, 'start-web.cmd')
  assert.equal('version' in contract, false)
  assert.equal('supportedTargets' in contract, false)
  assert.equal('unsupportedTargets' in contract, false)
  assert.deepEqual(contract.dataHome.environment, ['MAPHARNESS_HOME', 'DSH_HOME'])
})

test('web-only descriptors reject desktop delivery fields', () => {
  const contract = readWebServiceContract(repo)
  const descriptor = assertWebApplicationMode('web', contract)
  assert.deepEqual(webServiceApplicationDescriptor(contract), descriptor)
  assert.deepEqual(Object.keys(descriptor).sort(), ['format', 'mode', 'profile'])
  assert.throws(() => assertWebApplicationMode('desktop', contract), /only web is delivered/u)
})

test('contract parsing rejects duplicated truth and malformed metadata', () => {
  const valid = JSON.parse(readFileSync(join(repo, 'map/release/web-service.json'), 'utf8'))
  const root = mkdtempSync(join(tmpdir(), 'map-web-service-contract-'))
  mkdirSync(join(root, 'map/release'), { recursive: true })
  const write = value => writeFileSync(join(root, 'map/release/web-service.json'), JSON.stringify(value))
  write({ ...valid, version: '0.1.13' })
  assert.throws(() => readWebServiceContract(root), /contract fields are invalid/u)
  write({ ...valid, launchers: { ...valid.launchers, posix: 'start.sh' } })
  assert.throws(() => readWebServiceContract(root), /launcher names are invalid/u)
  write({ ...valid, dataHome: { ...valid.dataHome, environment: ['DSH_HOME'] } })
  assert.throws(() => readWebServiceContract(root), /data-home contract is invalid/u)
})

test('the native builder embeds only the web service mode', () => {
  const source = readFileSync(join(repo, 'map/bin/build-application.mjs'), 'utf8')
  assert.match(source, /assertWebApplicationMode\(mode, readWebServiceContract\(ROOT\)\)/u)
  assert.match(source, /manifest\.webService = webService/u)
  assert.doesNotMatch(source, /desktop\.json|MAP_DESKTOP_BUNDLES|map-desktop/u)
})

test('the release matrix names each target and its evidence without copying version or target truth', () => {
  const contract = readWebServiceContract(repo)
  const matrix = contract.manifest.releaseMatrix
  const lock = JSON.parse(readFileSync(join(repo, matrix.targetSource), 'utf8'))
  const targets = Object.keys(lock.targets).sort()
  assert.deepEqual(targets, ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64'])
  assert.deepEqual(Object.fromEntries(targets.map(target => [target, lock.targets[target].pythonTarget])), {
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'mac-arm64': 'aarch64-apple-darwin',
    'mac-x64': 'x86_64-apple-darwin',
    'win-x64': 'x86_64-pc-windows-msvc',
  })
  assert.equal(matrix.format, 'map-harness-web-release-1')
  assert.equal(matrix.file, 'web-service-release.json')
  assert.equal(matrix.checksums, 'SHASUMS256.txt')
  assert.deepEqual(matrix.requiredTopLevelFields, ['format', 'product', 'version', 'sourceDigest', 'targets', 'unsupportedTargets'])
  assert.deepEqual(matrix.requiredTargetFields, [
    'target', 'platform', 'architecture', 'abi', 'archive', 'archiveSha256', 'manifest', 'manifestSha256',
    'qualification', 'qualificationSha256',
  ])
  assert.equal('version' in matrix, false)
  assert.equal('targets' in matrix, false)
  const name = (pattern, target) => pattern.replace('{version}', 'example').replace('{target}', target)
  const assets = targets.flatMap(target => [
    name(target.startsWith('win-') ? matrix.archiveNames.windows : matrix.archiveNames.unix, target),
    name(matrix.manifestName, target), name(matrix.qualificationName, target),
  ])
  assert.equal(new Set(assets).size, targets.length * 3)
  for (const target of targets) {
    const archive = name(target.startsWith('win-') ? matrix.archiveNames.windows : matrix.archiveNames.unix, target)
    assert.ok(archive.includes(target))
    assert.ok(archive.endsWith(target.startsWith('win-') ? '.zip' : '.tar.gz'))
  }
})

test('application inputs reject duplicate and unknown targets', t => {
  const application = {
    version: '0.1.13', target: 'mac-arm64', sourceDigest: 'a'.repeat(64),
    webService: { format: 1, mode: 'web', profile: 'map-web' },
  }
  assert.throws(() => assertWebServiceApplications([application, application], '0.1.13'), /duplicate target/u)

  const root = mkdtempSync(join(tmpdir(), 'map-web-service-unknown-target-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.dsh-build'))
  mkdirSync(join(root, 'applications'))
  writeFileSync(join(root, '.dsh-build/map-public-release.json'), JSON.stringify({ sources: { sha256: 'a'.repeat(64) } }))
  writeFileSync(join(root, 'applications/map-harness-v0.1.13-mac-arm64.json'), JSON.stringify({
    format: 'map-harness-native-1', version: '0.1.13', target: 'unknown-arm64',
  }))
  assert.throws(() => acceptedApplications(root, join(root, 'applications'), '0.1.13'), /acceptance is missing or stale/u)
})

function workflowStep(job, action) {
  const step = job.steps.find(item => item.uses?.startsWith(`${action}@`))
  assert.ok(step, `${action} step is required`)
  return step
}

function assertWindowsReleaseWorkflow(workflow) {
  const { build, verify } = workflow.jobs
  assert.equal(build['runs-on'], 'windows-2022')
  assert.equal(verify['runs-on'], 'windows-2022')
  assert.equal(verify.needs, 'build')
  assert.equal(workflowStep(verify, 'actions/checkout').with.ref, '${{ needs.build.outputs.source_sha }}')
  assert.equal(workflowStep(verify, 'actions/download-artifact').with.name, 'map-windows-web-unqualified')
  const qualify = verify.steps.find(item => item.name === 'Verify and qualify downloaded package')?.run
  assert.match(qualify, /Get-FileHash/u)
  assert.match(qualify, /smoke-web-service\.mjs/u)
  assert.match(qualify, /collect-web-service-release\.mjs/u)
}

test('Windows release qualification uses the built archive on an independent native runner', () => {
  const workflow = loadYaml(readFileSync(join(repo, '.github/workflows/map-windows-web-release.yml'), 'utf8'))
  assertWindowsReleaseWorkflow(workflow)
  const invalid = structuredClone(workflow)
  workflowStep(invalid.jobs.verify, 'actions/checkout').with.ref = 'main'
  assert.throws(() => assertWindowsReleaseWorkflow(invalid))
})

function assertWindowsDebugWorkflow(workflow) {
  const job = workflow.jobs.diagnose
  assert.equal(workflow.on.workflow_dispatch.inputs.build_run_id.required, true)
  assert.equal(job['runs-on'], 'windows-2022')
  assert.equal(workflowStep(job, 'actions/checkout').with.ref, '${{ github.sha }}')
  const artifact = workflowStep(job, 'actions/download-artifact').with
  assert.equal(artifact['run-id'], '${{ inputs.build_run_id }}')
  assert.equal(artifact.repository, '${{ github.repository }}')
}

test('Windows diagnostics take their artifact from the selected run of the current repository', () => {
  const workflow = loadYaml(readFileSync(join(repo, '.github/workflows/map-windows-debug.yml'), 'utf8'))
  assertWindowsDebugWorkflow(workflow)
  const invalid = structuredClone(workflow)
  workflowStep(invalid.jobs.diagnose, 'actions/download-artifact').with.repository = 'owner/private-repo'
  assert.throws(() => assertWindowsDebugWorkflow(invalid))
})
