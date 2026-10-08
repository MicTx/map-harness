/**
 * Shared loopback-fixture harness for the stream-providers test suite:
 * spawn one fixture binary with flags, await its `READY <port>` line, and
 * own its teardown. Fixtures are plain Node processes on 127.0.0.1 with
 * ephemeral ports — no network leaves the host.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** One running loopback fixture. */
export interface LoopbackFixture {
  /** The bound port the fixture reported. */
  readonly port: number
  /** Kill the fixture process and await its exit. */
  stop(): Promise<void>
}

/** Spawn one loopback fixture and resolve once it reports its port. */
export function startFixture(name: 'loopback-sse-server' | 'loopback-completions-server', flags: string[]): Promise<LoopbackFixture> {
  return new Promise((resolveReady, rejectReady) => {
    const entry = resolve(fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url)))
    const child = spawn(process.execPath, [entry, ...flags], { stdio: ['ignore', 'pipe', 'inherit'] })
    let announced = ''
    const onData = (chunk: Buffer): void => {
      announced += chunk.toString('utf8')
      const match = /^READY (\d+)$/m.exec(announced)
      if (match === null) return
      child.stdout.off('data', onData)
      resolveReady({
        port: Number.parseInt(match[1], 10),
        stop: () => new Promise(resolveStop => {
          child.once('exit', () => resolveStop())
          child.kill('SIGKILL')
        }),
      })
    }
    child.stdout.on('data', onData)
    child.once('exit', code => {
      rejectReady(new Error(`fixture ${name} exited before reporting a port (code ${String(code)})`))
    })
  })
}

/** One unbound port to point clients at (the `unreachable` lane needs no listener at all). */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}
