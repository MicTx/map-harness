/** Configured Cookie audiences and browser bootstrap through a real Loader and HTTP server. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer, { type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { expect, it, onTestFinished } from 'vitest'
import * as Connection from '../src/index.ts'
import * as AuthenticationToken from '@deepseek-ai/dsh-host-authentication-token'
import { BrowserAuth as AuthenticationTokenBrowserAuth } from '@deepseek-ai/dsh-host-authentication-token/src/browser-auth.ts'
import type { HostConnectionHandle } from '../src/index.ts'
import { RecordCredentials } from './browser-credentials.ts'

function unexpectedCredentialOperation(): never {
  throw new Error('browser authentication fixture only supports owner records')
}

/** Real service identity with in-memory record storage; unrelated operations fail loudly. */
class FixtureCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly records: RecordCredentials) { super(ctx) }
  override resolve = unexpectedCredentialOperation
  override describe = unexpectedCredentialOperation
  override set = unexpectedCredentialOperation
  override unset = unexpectedCredentialOperation
  override describeRecord = unexpectedCredentialOperation
  override listRecords = unexpectedCredentialOperation
  override readRecord(): Promise<CredentialRecord | undefined> { return this.records.readRecord() }
  override deleteRecord(): Promise<void> { return this.records.deleteRecord() }
  override modifyRecord(key: CredentialKey, mutate: Parameters<CredentialProvider['modifyRecord']>[1]): Promise<CredentialRecord | undefined> {
    return this.records.modifyRecord(key, mutate)
  }
}

async function boot(namespace: string, credentials: RecordCredentials) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-storage-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- id: web-server',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: connection',
    "  name: '@deepseek-ai/dsh-client-connection'",
    '  config:',
    `    browserStorageNamespace: ${JSON.stringify(namespace)}`,
    '- id: authentication-token',
    "  name: '@deepseek-ai/dsh-host-authentication-token'",
    '  config:',
    `    cookieNamespace: ${JSON.stringify(namespace)}`,
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // The credential provider is the only nondeterministic persistence dependency.
  await ctx.plugin({ apply: (owner) => { new FixtureCredentials(owner, credentials) } })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-authentication-token', AuthenticationToken],
  ])
  const internal: Pick<Extract<ModuleLoader, { version: 'v2' }>, 'version' | 'import'> = {
    version: 'v2',
    async import(specifier) {
      const plugin = modules.get(specifier)
      if (plugin === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return plugin
    },
  }
  ctx.loader.internal = internal as ModuleLoader
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const inactive = [...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)
  expect(inactive).toEqual([])
  const connection = ctx.get('connection') as HostConnectionHandle
  return { ctx, connection, origin: `http://127.0.0.1:${ctx.webServer.port}` }
}

it('loads namespace config, injects only the public scope, and denies cross-scope replay on real HTTP', async () => {
  const sharedSigningSecret = new RecordCredentials()
  const a = await boot('map-harness:A', sharedSigningSecret)
  const b = await boot('map-harness:B', sharedSigningSecret)
  const rows: IndexInjection[] = []
  a.ctx.emit('webserver/index-inject', rows, a.connection.browserPeer)
  expect(rows.find(row => row.kind === 'global' && row.name === '__DSH_BROWSER_STORAGE_NAMESPACE__'))
    .toEqual({ kind: 'global', name: '__DSH_BROWSER_STORAGE_NAMESPACE__', value: 'map-harness:A' })
  expect(JSON.stringify(rows)).not.toContain('secret')
  // The authority is fixed in this request so the namespace is the only audience difference.
  const authority = 'localhost:3080'
  // rc.3: the token plugin owns issuance; mint through its public constructor with the same secret and namespace.
  const auth = await AuthenticationTokenBrowserAuth.create(a.ctx, a.ctx.credentials, 30, 'map-harness:A')
  const aUrl = new URL(auth.authenticatedUrl(`http://${authority}/connect`))
  const accepted = await fetch(`${a.origin}${aUrl.pathname}${aUrl.search}`, { redirect: 'manual', headers: { host: authority } })
  expect(accepted.status).toBe(302)
  const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!
  await accepted.arrayBuffer()
  const own = await fetch(`${a.origin}/api`, { headers: { host: authority, cookie } })
  expect(own.status).toBe(404)
  await own.arrayBuffer()
  const other = await fetch(`${b.origin}/api`, { headers: { host: authority, cookie } })
  expect(other.status).toBe(401)
  await other.arrayBuffer()
})
