/**
 * Cordis plugin (host plane): the deployment's remote MCP connection
 * configuration surface. Two optional blocks declare named connections —
 * `stdio` (cross-process children) and `http` (remote streamable-HTTP
 * endpoints) — and every declaration is validated at load: id shape and
 * global uniqueness, command and argv bounds, env-reference shape, URL
 * shape, bounded deadlines, the total connection count, and every
 * credential reference (`tokenEnv`, `envRefs` values) must resolve to a
 * non-empty environment variable at load. Any violation fails the plugin
 * load loudly; nothing silently degrades. Credential values are resolved
 * once, held in memory for the process lifetime, and never enter config
 * defaults, logs, error text, or summaries. Plugin disposal closes every
 * cached connection quiescently, so no child process or HTTP session
 * outlives the host.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AnyConnectionSpec, HttpConnectionSpec, McpConnectionVerification, StdioConnectionSpec } from './contract.ts'
import {
  httpSpecProblem,
  MAX_CONNECTIONS,
  connectionIdProblem,
  stdioSpecProblem,
} from './contract.ts'
import { openRemoteMcp, verifyRemoteMcp, type McpExchangeOptions, type RemoteMcpConnection, type RemoteMcpCredentials } from './client.ts'
import { McpTransportError } from './errors.ts'
import { MCP_TRANSPORT_SERVICE, type McpConnectionSummary, type McpServiceOptions, type McpTransportService } from './service.ts'

/** One declared connection with its credentials resolved at load. */
export interface ResolvedMcpConnection {
  /** The validated connection spec. */
  readonly spec: AnyConnectionSpec
  /** Credential values resolved from the environment; in memory only. */
  readonly credentials: RemoteMcpCredentials
}

/** Plugin config for the two connection blocks. */
export interface McpTransportPluginConfig {
  /** Declared stdio (cross-process child) connections. */
  stdio?: {
    id: string
    command: string
    args?: string[]
    /** Child-variable-name to environment-variable-name references; values never enter config. */
    envRefs?: Record<string, string>
    cwd?: string
    timeoutMs?: number
  }[]
  /** Declared remote streamable-HTTP connections. */
  http?: {
    id: string
    url: string
    /** Environment-variable name holding a bearer token; values never enter config. */
    tokenEnv?: string
    timeoutMs?: number
  }[]
}

/** Loader config schema; validation failures fail the plugin at load. */
export const Config: z<McpTransportPluginConfig> = z.object({
  stdio: z.array(z.object({
    id: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()),
    envRefs: z.object({}).role('credential-ref'),
    cwd: z.string(),
    timeoutMs: z.number().min(1000).max(60000),
  })),
  http: z.array(z.object({
    id: z.string().required(),
    url: z.string().required(),
    tokenEnv: z.string().role('credential-ref'),
    timeoutMs: z.number().min(1000).max(60000),
  })),
})

/** Resolve one credential reference at load; missing or empty fails loud. */
function resolveCredential(id: string, envName: string, env: NodeJS.ProcessEnv): string {
  const value = env[envName]
  if (value === undefined || value.length === 0) {
    throw new McpTransportError('MCP_TRANSPORT_CREDENTIAL_MISSING', `connection ${id} references ${envName}, which is not set in the environment; set it in the deployment environment (values never enter config)`)
  }
  return value
}

/**
 * Build the resolved-connection registry from config and the environment.
 * Exported for the service tests; the plugin is the only production caller.
 * @param config - validated plugin config.
 * @param env - the environment credentials resolve through.
 * @returns the registry keyed by connection id.
 * @throws when a declaration is invalid, an id collides, the total is over
 * the bound, or a credential reference resolves to nothing.
 */
export function resolveMcpConnections(config: McpTransportPluginConfig, env: NodeJS.ProcessEnv): Map<string, ResolvedMcpConnection> {
  const registry = new Map<string, ResolvedMcpConnection>()
  const declare = (spec: AnyConnectionSpec, credentials: RemoteMcpCredentials): void => {
    const idProblem = connectionIdProblem(spec.id)
    if (idProblem !== undefined) {
      throw new McpTransportError('MCP_TRANSPORT_CONFIG_INVALID', idProblem)
    }
    if (registry.has(spec.id)) {
      throw new McpTransportError('MCP_TRANSPORT_CONFIG_INVALID', `connection id ${spec.id} is declared more than once; ids are global across kinds`)
    }
    if (registry.size >= MAX_CONNECTIONS) {
      throw new McpTransportError('MCP_TRANSPORT_CONFIG_INVALID', `at most ${String(MAX_CONNECTIONS)} connections may be declared`)
    }
    registry.set(spec.id, { spec, credentials })
  }

  for (const declared of config.stdio ?? []) {
    const spec: StdioConnectionSpec = {
      id: declared.id,
      kind: 'stdio',
      command: declared.command,
      ...(declared.args === undefined ? {} : { args: [...declared.args] }),
      ...(declared.envRefs === undefined ? {} : { envRefs: { ...declared.envRefs } }),
      ...(declared.cwd === undefined ? {} : { cwd: declared.cwd }),
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
    }
    const problem = stdioSpecProblem(spec)
    if (problem !== undefined) throw new McpTransportError('MCP_TRANSPORT_CONFIG_INVALID', `stdio connection ${declared.id}: ${problem}`)
    const childEnv: Record<string, string> = {}
    for (const [childName, envName] of Object.entries(spec.envRefs ?? {})) {
      childEnv[childName] = resolveCredential(spec.id, envName, env)
    }
    declare(spec, Object.keys(childEnv).length === 0 ? {} : { env: childEnv })
  }
  for (const declared of config.http ?? []) {
    const spec: HttpConnectionSpec = {
      id: declared.id,
      kind: 'http',
      url: declared.url,
      ...(declared.tokenEnv === undefined ? {} : { tokenEnv: declared.tokenEnv }),
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
    }
    const problem = httpSpecProblem(spec)
    if (problem !== undefined) throw new McpTransportError('MCP_TRANSPORT_CONFIG_INVALID', `http connection ${declared.id}: ${problem}`)
    const token = declared.tokenEnv === undefined ? undefined : resolveCredential(spec.id, declared.tokenEnv, env)
    declare(spec, token === undefined ? {} : { token })
  }
  return registry
}

/** Endpoint identity for one summary (credential names only, never values). */
function summaryEndpoint(spec: AnyConnectionSpec): string {
  if (spec.kind === 'stdio') {
    const stdio = spec as StdioConnectionSpec
    const argCount = stdio.args?.length ?? 0
    const refNames = Object.keys(stdio.envRefs ?? {})
    return `stdio ${stdio.command} (${String(argCount)} args${refNames.length === 0 ? '' : `, envRefs ${refNames.join(',')}`})`
  }
  const http = spec as HttpConnectionSpec
  return `${http.url}${http.tokenEnv === undefined ? '' : ` (tokenEnv ${http.tokenEnv})`}`
}

/** Service options mapped to client exchange options. */
function exchangeOptions(options: McpServiceOptions | undefined): McpExchangeOptions {
  return options === undefined ? {} : { ...options }
}

/** Cached connection bookkeeping the service owns. */
interface ServiceRuntime {
  readonly service: McpTransportService
  /** Close every cached connection quiescently; the plugin dispose path. */
  closeAll(): Promise<void>
}

/**
 * Build the service face over one resolved registry; exported so tests and
 * future hosts construct it without a Cordis context.
 * @param registry - the resolved connections keyed by id.
 * @returns the `mcpTransport` service and its disposal hook.
 */
export function buildMcpTransportService(registry: Map<string, ResolvedMcpConnection>): ServiceRuntime {
  const open = new Map<string, RemoteMcpConnection>()
  const requireConnection = (id: string): ResolvedMcpConnection => {
    const connection = registry.get(id)
    if (connection === undefined) {
      throw new McpTransportError('MCP_TRANSPORT_UNKNOWN_CONNECTION', `no declared connection carries id ${id}; listConnections() names the declared set`)
    }
    return connection
  }
  const service: McpTransportService = {
    specs: [...registry.values()].map(connection => connection.spec),
    listConnections(): readonly McpConnectionSummary[] {
      return [...registry.values()].map(connection => ({
        id: connection.spec.id,
        kind: connection.spec.kind,
        endpoint: summaryEndpoint(connection.spec),
      }))
    },
    async verifyConnection(id: string, options?: McpServiceOptions): Promise<McpConnectionVerification> {
      const connection = requireConnection(id)
      return await verifyRemoteMcp(connection.spec, connection.credentials, exchangeOptions(options))
    },
    async openConnection(id: string, options?: McpServiceOptions): Promise<RemoteMcpConnection> {
      const connection = requireConnection(id)
      const existing = open.get(id)
      if (existing !== undefined) return existing
      const opened = await openRemoteMcp(connection.spec, connection.credentials, exchangeOptions(options))
      const racing = open.get(id)
      if (racing !== undefined) {
        void opened.close()
        return racing
      }
      open.set(id, opened)
      return opened
    },
    async callTool(id: string, name: string, args: Readonly<Record<string, unknown>>, options?: McpServiceOptions): Promise<CallToolResult> {
      const connection = requireConnection(id)
      const cached = open.get(id)
      if (cached !== undefined) return await cached.callTool(name, args, exchangeOptions(options))
      const transient = await openRemoteMcp(connection.spec, connection.credentials, exchangeOptions(options))
      try {
        return await transient.callTool(name, args, exchangeOptions(options))
      } finally {
        await transient.close()
      }
    },
    async closeConnection(id: string): Promise<boolean> {
      const cached = open.get(id)
      if (cached === undefined) return false
      open.delete(id)
      await cached.close()
      return true
    },
  }
  return {
    service,
    async closeAll(): Promise<void> {
      const closing = [...open.values()]
      open.clear()
      await Promise.allSettled(closing.map(connection => connection.close()))
    },
  }
}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/mcp-transport'

/** No host services are required: the plugin owns config validation and its service only. */
export const inject: string[] = []

/**
 * Host plugin body: validate and resolve every declared connection, provide
 * the service for the process lifetime, and close every cached connection
 * on disposal.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: McpTransportPluginConfig): void {
  const registry = resolveMcpConnections(config, process.env)
  const { service, closeAll } = buildMcpTransportService(registry)

  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(MCP_TRANSPORT_SERVICE, service)
    return () => {
      void unprovide()
      void closeAll()
    }
  }, '@map-harness/mcp-transport: service')
}
