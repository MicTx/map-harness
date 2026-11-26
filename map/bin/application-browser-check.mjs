/** Run the native map browser scenario with a deadline and Windows process-tree cleanup. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * Exercise the native application's map UI; refuse skipped tests and terminate the Windows tree on timeout.
 * @param {string} executable - absolute application path to launch from the real browser scenario.
 * @returns {Promise<void>} resolves only after one complete browser scenario passes.
 */
export async function checkApplicationBrowser(executable) {
  const directory = mkdtempSync(join(tmpdir(), 'map-application-browser-')), report = join(directory, 'result.txt')
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-reporter-destination=${report}`,
        '--test-name-pattern=spatial workflow: locate, draw, fit', join(ROOT, 'map/arcgis-mcp/tests/composition.e2e.mjs')],
      { cwd: ROOT, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, MAP_APPLICATION_BIN: executable } })
      let failure
      const timer = setTimeout(() => {
        failure = new Error('Native map browser check timed out.')
        if (process.platform === 'win32') {
          const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 30000 })
          if (stopped.error || stopped.status !== 0) {
            failure = new Error('Native map browser check timed out; Windows process cleanup was not confirmed.')
            child.kill()
          }
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
            if (error.code !== 'ESRCH') failure = error
          }
        }
      }, 300000)
      child.once('error', error => { clearTimeout(timer); rejectRun(error) })
      child.once('exit', (status, signal) => {
        clearTimeout(timer)
        if (failure) rejectRun(failure)
        else if (status !== 0) rejectRun(new Error(`Native map browser check exited with ${status ?? signal}.`))
        else resolveRun()
      })
    })
    const output = readFileSync(report, 'utf8')
    if (!/pass 1\b/u.test(output) || !/skipped 0\b/u.test(output)) throw new Error('Native map browser check did not run exactly one scenario.')
  } catch (error) {
    const output = existsSync(report) ? readFileSync(report, 'utf8').slice(-1024 * 1024) : ''
    throw new Error(`${error.message}\n${output}`, { cause: error })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
