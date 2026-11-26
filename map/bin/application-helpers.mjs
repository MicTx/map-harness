/** Copy the private Map bootstrap dependency closure into a native application stage. */
import { copyFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

/** Bootstrap siblings present in every native Map deployment, independent of checkout imports. */
export const APPLICATION_LAUNCH_HELPERS = Object.freeze([
  'instance-home.mjs',
  'instance-preload.mjs',
  'instance-lock.mjs',
  'install-manifest.mjs',
  'install-layout.mjs',
  'install-transaction.mjs',
  'instance-import.mjs',
  'manage.mjs',
  'windows-transaction.mjs',
  'web-service-qualification-platform.mjs',
  'web-onboarding.mjs',
])

/**
 * Copy each required bootstrap helper as a regular file into an existing stage.
 * Missing or linked inputs fail before sealing; callers own staging cleanup on failure.
 * @param {string} root source checkout containing map/bin
 * @param {string} stage native deployment root
 * @returns {string[]} copied relative helper names
 */
export function stageApplicationHelpers(root, stage) {
  for (const name of APPLICATION_LAUNCH_HELPERS) {
    const source = join(root, 'map/bin', name)
    const info = lstatSync(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Native helper must be a regular file: ${name}`)
    copyFileSync(source, join(stage, name))
  }
  return [...APPLICATION_LAUNCH_HELPERS]
}
