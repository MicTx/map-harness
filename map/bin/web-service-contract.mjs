#!/usr/bin/env node
/** Contract for the source-free script-launched Map Harness Web service. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCT_VERSION_PATH } from './public-release-privacy.mjs'

export const WEB_SERVICE_CONTRACT_PATH = 'map/release/web-service.json'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const targetDirectoryPattern = /^(?:mac|win|linux)-(?:x64|arm64)$/u

/**
 * Read the delivery contract without allowing it to duplicate version or target truth.
 * @param {string} root Repository root carrying map/release/web-service.json.
 * @returns {object} Validated contract.
 * @throws If a field is unknown, a launcher is renamed, or version/target truth is copied.
 */
export function readWebServiceContract(root = ROOT) {
  const contract = JSON.parse(readFileSync(join(root, WEB_SERVICE_CONTRACT_PATH), 'utf8'))
  const keys = ['format', 'serviceMode', 'profile', 'versionSource', 'launchers', 'manifest', 'dataHome']
  if (JSON.stringify(Object.keys(contract)) !== JSON.stringify(keys)) throw new Error('Web service contract fields are invalid.')
  if (contract.format !== 1 || contract.serviceMode !== 'web' || contract.profile !== 'map-web') {
    throw new Error('Web service contract must select the map-web service mode.')
  }
  if (contract.versionSource !== PRODUCT_VERSION_PATH) throw new Error('Web service contract must use the product version source.')
  if (contract.launchers?.posix !== 'start-web.sh' || contract.launchers?.windows !== 'start-web.cmd') {
    throw new Error('Web service launcher names are invalid.')
  }
  if (contract.manifest?.file !== 'web-service-manifest.json' || contract.manifest?.format !== 1
    || contract.manifest?.targetDirectoryPattern !== targetDirectoryPattern.source
    || !Array.isArray(contract.manifest?.requiredTopLevelFields) || !Array.isArray(contract.manifest?.requiredFileFields)) {
    throw new Error('Web service manifest contract is invalid.')
  }
  if (JSON.stringify(contract.dataHome?.environment) !== JSON.stringify(['MAPHARNESS_HOME', 'DSH_HOME'])
    || contract.dataHome?.default !== '~/.dsh') {
    throw new Error('Web service data-home contract is invalid.')
  }
  if ('version' in contract || 'supportedTargets' in contract || 'unsupportedTargets' in contract) {
    throw new Error('Web service contract must not duplicate version or target truth.')
  }
  return contract
}

/**
 * Build the positive web-only descriptor embedded in an application record.
 * @param {ReturnType<typeof readWebServiceContract>} contract Valid delivery contract.
 * @returns {{format: number, mode: string, profile: string}} Descriptor without desktop fields.
 */
export function webServiceApplicationDescriptor(contract) {
  return { format: contract.manifest.format, mode: contract.serviceMode, profile: contract.profile }
}

/**
 * Restrict native application construction to the delivered Web service mode.
 * @param {string} mode Explicit build mode.
 * @param {ReturnType<typeof readWebServiceContract>} contract Valid delivery contract.
 * @returns {{format: number, mode: string, profile: string}} Web-only descriptor.
 */
export function assertWebApplicationMode(mode, contract) {
  if (mode !== 'web') throw new Error(`Unsupported native application mode ${mode}; only web is delivered.`)
  return webServiceApplicationDescriptor(contract)
}
