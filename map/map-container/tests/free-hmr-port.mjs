import { createServer } from 'node:http'

/**
 * Reserve one loopback port for a Vite HMR websocket and release it before
 * Vite binds it. Vite 6 serves `/@vite/client` for CSS-module dev transforms
 * even with `hmr: false`, so two middleware servers in one test process must
 * not share the default 24678.
 * @returns the released loopback port.
 */
export async function freeHmrPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  if (address === null || typeof address !== 'object') throw new Error('loopback port allocation failed')
  return address.port
}
