import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const entryPath = join(packageRoot, 'lib/client.js')
const terminalPath = join(packageRoot, 'lib/client.terminal.js')

function sourceMapSources(path: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(`${path}.map`, 'utf8'))
  expect(parsed).toBeTypeOf('object')
  expect(parsed).not.toBeNull()
  const sources = (parsed as { sources?: unknown }).sources
  expect(sources).toBeInstanceOf(Array)
  expect((sources as readonly unknown[]).every(source => typeof source === 'string')).toBe(true)
  return sources as readonly string[]
}

describe('terminal client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('keeps xterm outside the startup bundle', () => {
    expect(existsSync(terminalPath)).toBe(true)
    const entry = readFileSync(entryPath, 'utf8')
    const terminal = readFileSync(terminalPath, 'utf8')
    expect([...entry.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
      .toEqual(['./client.terminal.js'])
    expect(entry).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
    expect([...terminal.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
      .toEqual([])
    const entrySources = sourceMapSources(entryPath)
    const terminalSources = sourceMapSources(terminalPath)
    expect(entrySources.join('\n')).not.toContain('node_modules/@xterm/xterm/')
    expect(entrySources.join('\n')).not.toContain('node_modules/@xterm/addon-fit/')
    expect(terminalSources.join('\n')).toContain('node_modules/@xterm/xterm/')
    expect(terminalSources.join('\n')).toContain('node_modules/@xterm/addon-fit/')
  })
})
