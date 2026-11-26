/**
 * Shared workspace fixture rig for map-tools specs: one real LocalFileSystem
 * context per test, rooted at a tracked mkdtemp workspace that is removed
 * whether the body succeeds or throws. The controlled-filesystem variant
 * serves admission-window fault injection without touching real files.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '../../../packages/fs/fs-local/lib/index.js'

/**
 * Run one body with a prebuilt exec rooted at an existing workspace dir.
 * @param {string} cwd - the workspace root the fs service mounts.
 * @param {(exec: unknown) => Promise<T>} callback - the scoped work.
 * @param {AbortSignal} [signal] - the exec signal.
 * @template T
 */
export async function withExec(cwd, callback, signal = new AbortController().signal) {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd })
  try {
    return await callback({ agent: { ctx, session: { header: { cwd }, id: 's-test' } }, signal })
  } finally {
    await fiber.dispose()
  }
}

/** An exec whose `fs` service is replaced by a caller-controlled double. */
export function controlledFsExec(cwd, filesystem) {
  return {
    agent: {
      ctx: { get: name => name === 'fs' ? filesystem : undefined },
      session: { header: { cwd }, id: 's-controlled' },
    },
    signal: new AbortController().signal,
  }
}

/**
 * Run one body inside a fresh mkdtemp workspace with a mounted filesystem;
 * the workspace and context always tear down.
 * @template T
 * @param {string} label - owner tag for the temp workspace.
 * @param {(rig: { dir: string, exec: unknown, write: (name: string, collection: unknown) => string }) => Promise<T>} body
 * @returns {Promise<T>} the body's resolution.
 */
export async function withWorkspace(label, body) {
  const dir = mkdtempSync(join(tmpdir(), `map-tools-${label}-`))
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  const exec = { agent: { ctx, session: { header: { cwd: dir }, id: 's-rig' } }, signal: new AbortController().signal }
  const write = (name, collection) => {
    writeFileSync(join(dir, name), JSON.stringify(collection))
    return name
  }
  try {
    return await body({ dir, exec, write })
  } finally {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}
