/**
 * Resolve the V7 delivery record from either its active or archived location.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const slug = '2026-11-10_add-visual-change'
const active = join(root, '.spec', 'specs', slug)
const archived = join(root, '.spec', 'specs', 'archive', slug)

/** @returns the package directory that currently holds the delivery record. */
export function visualChangePackageRoot() {
  return existsSync(join(active, 'spec.md')) ? active : archived
}

/** @returns the current spec decision source. */
export function visualChangeSpecPath() {
  return join(visualChangePackageRoot(), 'spec.md')
}

/** @param {...string} parts - path below the live evidence directory. */
export function visualChangeEvidencePath(...parts) {
  return join(visualChangePackageRoot(), 'evidence', 'live', ...parts)
}
