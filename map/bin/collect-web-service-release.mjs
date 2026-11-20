#!/usr/bin/env node
/** Collect independently qualified Web service archives into one release directory. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductVersion } from './public-release-privacy.mjs'
import { readWebServiceContract } from './web-service-contract.mjs'
import { acceptedWebServiceRelease } from './web-service-release.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sha256 = value => createHash('sha256').update(value).digest('hex')

function filename(template, version, target) {
  if (typeof template !== 'string' || !template.includes('{version}') || !template.includes('{target}')) {
    throw new Error('Web release filename template is invalid.')
  }
  const name = template.replace('{version}', version).replace('{target}', target)
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || basename(name) !== name) throw new Error('Web release filename is invalid.')
  return name
}

function matrixSettings(root) {
  const settings = readWebServiceContract(root).manifest.releaseMatrix
  if (settings?.format !== 'map-harness-web-release-1' || settings.file !== 'web-service-release.json'
    || settings.checksums !== 'SHASUMS256.txt' || settings.targetSource !== 'scripts/primary-runtime/lock.json') {
    throw new Error('Web release matrix settings are invalid.')
  }
  const lock = JSON.parse(readFileSync(join(root, settings.targetSource), 'utf8'))
  if (!lock.targets || typeof lock.targets !== 'object') throw new Error('Web release target inventory is invalid.')
  return { settings, targets: lock.targets }
}

function inspectInput(root, directory, version, settings, targets) {
  const qualificationPath = join(directory, 'web-service-qualification.json')
  if (!existsSync(join(directory, 'web-service-manifest.json')) || !existsSync(qualificationPath)) {
    throw new Error('Script Web service manifest and qualification are both required.')
  }
  const qualification = JSON.parse(readFileSync(qualificationPath, 'utf8'))
  const requested = qualification.targets ?? [qualification.target]
  if (!Array.isArray(requested) || requested.length !== 1 || typeof requested[0] !== 'string'
    || !Object.hasOwn(targets, requested[0])) throw new Error('Web release input must name one known target.')
  const target = requested[0]
  const [os, architecture] = target.split('-')
  const platform = { mac: 'darwin', linux: 'linux', win: 'win32' }[os]
  const abi = targets[target].pythonTarget?.split('-').at(-1)
  if (!platform || !architecture || !abi || qualification.runtime?.platform !== platform
    || qualification.runtime?.arch !== architecture || qualification.runtime?.cwdOutsideCheckout !== true) {
    throw new Error(`Web release qualification runtime does not match ${target}.`)
  }
  const archive = filename(os === 'win' ? settings.archiveNames?.windows : settings.archiveNames?.unix, version, target)
  if (qualification.archive !== archive) throw new Error(`Web release archive name is invalid for ${target}.`)
  const accepted = acceptedWebServiceRelease(root, directory, version)
  if (accepted.manifest.supportedTargets.length !== 1 || accepted.manifest.supportedTargets[0] !== target) {
    throw new Error('Web release input must contain exactly one target.')
  }
  return { target, platform, architecture, abi, accepted }
}

/**
 * Validate and collect individual Web service packages into a destination that must not already exist.
 * @param {object} options Checkout root, input directories, and destination.
 * @returns {{directory: string, manifest: object}} Collected directory and release metadata.
 */
export function collectWebServiceRelease({ root = ROOT, inputs, out }) {
  if (!Array.isArray(inputs) || inputs.length === 0 || typeof out !== 'string' || out.length === 0) {
    throw new Error('Web release collection requires input directories and an output directory.')
  }
  const output = resolve(out)
  if (existsSync(output)) throw new Error('Web release output directory already exists.')
  const version = readProductVersion(root)
  const { settings, targets } = matrixSettings(root)
  const accepted = inputs.map(input => inspectInput(root, resolve(input), version, settings, targets))
    .sort((a, b) => a.target.localeCompare(b.target, 'en'))
  if (new Set(accepted.map(item => item.target)).size !== accepted.length) throw new Error('Web release contains a duplicate target.')
  if (new Set(accepted.map(item => item.accepted.qualification.sourceDigest)).size !== 1) {
    throw new Error('Web release inputs have different source digests.')
  }
  const rows = accepted.map(({ target, platform, architecture, abi, accepted: item }) => ({
    target, platform, architecture, abi,
    archive: filename(target.startsWith('win-') ? settings.archiveNames.windows : settings.archiveNames.unix, version, target),
    archiveSha256: item.archiveSha256,
    manifest: filename(settings.manifestName, version, target), manifestSha256: item.manifestSha256,
    qualification: filename(settings.qualificationName, version, target), qualificationSha256: item.qualificationSha256,
  }))
  const allNames = rows.flatMap(row => [row.archive, row.manifest, row.qualification]).concat(settings.file, settings.checksums)
  if (new Set(allNames).size !== allNames.length) throw new Error('Web release asset names collide.')
  const manifest = {
    format: settings.format, product: 'map-harness', version, sourceDigest: accepted[0].accepted.qualification.sourceDigest,
    targets: rows, unsupportedTargets: Object.keys(targets).filter(target => !rows.some(row => row.target === target)).sort(),
  }
  mkdirSync(dirname(output), { recursive: true })
  const stage = mkdtempSync(join(dirname(output), '.map-web-release-'))
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index], input = accepted[index].accepted
      for (const [source, name, expected] of [[input.archive, row.archive, row.archiveSha256],
        [input.manifestPath, row.manifest, row.manifestSha256], [input.qualificationPath, row.qualification, row.qualificationSha256]]) {
        const destination = join(stage, name)
        copyFileSync(source, destination)
        if (sha256(readFileSync(destination)) !== expected) throw new Error(`Web release input changed while copying: ${name}`)
      }
    }
    writeFileSync(join(stage, settings.file), JSON.stringify(manifest, null, 2) + '\n')
    const files = allNames.filter(name => name !== settings.checksums).sort()
    writeFileSync(join(stage, settings.checksums), files.map(name => `${sha256(readFileSync(join(stage, name)))}  ${name}\n`).join(''))
    renameSync(stage, output)
    return { directory: output, manifest }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), inputs = []
  let out
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input' && argv[index + 1]) inputs.push(argv[++index])
    else if (argv[index] === '--out' && argv[index + 1] && out === undefined) out = argv[++index]
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
  }
  if (!out || inputs.length === 0) throw new Error('Usage: collect-web-service-release --input <dir> [--input <dir>] --out <dir>')
  console.log(JSON.stringify(collectWebServiceRelease({ inputs, out })))
}
