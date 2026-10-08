/**
 * Node-half Cordis plugin (host plane): the deployment's connection
 * configuration surface. Three optional blocks declare named connections —
 * `postgis`, `objectStores`, and `cogs` — and every declaration is validated
 * at load: id shape and global uniqueness, endpoint shape, TLS-mode and
 * addressing enums, bounded timeouts, the total connection count, and every
 * credential reference (the `*Env` fields) must resolve to a non-empty
 * environment variable at load. Any violation fails the plugin load loudly;
 * nothing silently degrades to another endpoint. Credential values are
 * resolved once, held in memory for the process lifetime, and never enter
 * config defaults, logs, error text, or summaries.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConnectError } from './errors.ts'
import {
  MAX_CONNECTIONS,
  cogSpecProblem,
  connectionIdProblem,
  objectStoreSpecProblem,
  postgresSpecProblem,
  type CogConnectionSpec,
  type ConnectionKind,
  type ObjectStoreConnectionSpec,
  type PostgresConnectionSpec,
} from './contract.ts'
import { verifyCog, type CogCredentials } from './cog.ts'
import { verifyObjectStore, type ObjectStoreCredentials } from './objectstore.ts'
import { verifyPostgres, type PostgresCredentials } from './postgres.ts'
import { SPATIAL_CONNECT_SERVICE, type ConnectionSummary, type SpatialConnectService } from './service.ts'

/** Ids may not collide across kinds; the plugin owns the global namespace. */
interface ResolvedConnection {
  readonly kind: ConnectionKind
  readonly spec: PostgresConnectionSpec | ObjectStoreConnectionSpec | CogConnectionSpec
  readonly credentials: PostgresCredentials | ObjectStoreCredentials | CogCredentials
}

/** Endpoint override root validation: an `http(s)` host root without path, query, or userinfo. */
const HTTP_ROOT = z.string().pattern(/^https?:\/\/(?![^/?#]*@)[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$/i)

/** Plugin config for the three connection blocks. */
export interface SpatialConnectPluginConfig {
  /** Declared PostGIS connections. */
  postgis?: {
    id: string
    host: string
    port?: number
    database: string
    user: string
    /** Environment-variable name holding the role password; never a value. */
    passwordEnv?: string
    ssl?: 'disable' | 'prefer' | 'require'
    timeoutMs?: number
  }[]
  /** Declared S3-compatible object-store connections. */
  objectStores?: {
    id: string
    endpoint: string
    region: string
    bucket: string
    /** Environment-variable name holding the access key id. */
    accessKeyIdEnv?: string
    /** Environment-variable name holding the secret access key. */
    secretAccessKeyEnv?: string
    /** Environment-variable name holding a session token. */
    sessionTokenEnv?: string
    addressing?: 'path' | 'virtual-hosted'
    timeoutMs?: number
  }[]
  /** Declared COG connections. */
  cogs?: {
    id: string
    url: string
    /** Environment-variable name holding a bearer token. */
    tokenEnv?: string
    timeoutMs?: number
  }[]
}

/** Default environment variable names per credential role; overridable per connection. */
export const DEFAULT_POSTGRES_PASSWORD_ENV = 'SPATIAL_CONNECT_POSTGRES_PASSWORD'
export const DEFAULT_S3_ACCESS_KEY_ID_ENV = 'SPATIAL_CONNECT_S3_ACCESS_KEY_ID'
export const DEFAULT_S3_SECRET_ACCESS_KEY_ENV = 'SPATIAL_CONNECT_S3_SECRET_ACCESS_KEY'
export const DEFAULT_COG_TOKEN_ENV = 'SPATIAL_CONNECT_COG_TOKEN'

/** Loader config schema; validation failures fail the plugin at load. */
export const Config: z<SpatialConnectPluginConfig> = z.object({
  postgis: z.array(z.object({
    id: z.string().required(),
    host: z.string().required(),
    port: z.number().min(1).max(65535),
    database: z.string().required(),
    user: z.string().required(),
    passwordEnv: z.string().role('credential-ref').default(DEFAULT_POSTGRES_PASSWORD_ENV),
    ssl: z.union(['disable', 'prefer', 'require']).default('prefer'),
    timeoutMs: z.number().min(1000).max(60000),
  })),
  objectStores: z.array(z.object({
    id: z.string().required(),
    endpoint: HTTP_ROOT.required(),
    region: z.string().required(),
    bucket: z.string().required(),
    accessKeyIdEnv: z.string().role('credential-ref').default(DEFAULT_S3_ACCESS_KEY_ID_ENV),
    secretAccessKeyEnv: z.string().role('credential-ref').default(DEFAULT_S3_SECRET_ACCESS_KEY_ENV),
    sessionTokenEnv: z.string().role('credential-ref'),
    addressing: z.union(['path', 'virtual-hosted']).default('path'),
    timeoutMs: z.number().min(1000).max(60000),
  })),
  cogs: z.array(z.object({
    id: z.string().required(),
    url: z.string().pattern(/^https?:\/\//i).required(),
    tokenEnv: z.string().role('credential-ref'),
    timeoutMs: z.number().min(1000).max(60000),
  })),
})

/** Resolve one credential reference at load; missing or empty fails loud. */
function resolveCredential(kind: ConnectionKind, id: string, envName: string, env: NodeJS.ProcessEnv): string {
  const value = env[envName]
  if (value === undefined || value.length === 0) {
    throw new ConnectError('CONNECT_CREDENTIAL_MISSING', `connection ${id} (${kind}) references ${envName}, which is not set in the environment; set it in the deployment environment (values never enter config)`)
  }
  return value
}

/**
 * Build the resolved-connection registry from config and the environment.
 * Exported for the service tests; the plugin is the only production caller.
 * @param config - validated plugin config.
 * @param env - the environment credentials resolve through.
 * @returns the registry keyed by connection id.
 * @throws when a declaration is invalid, an id collides, or a credential reference resolves to nothing.
 */
export function resolveConnections(config: SpatialConnectPluginConfig, env: NodeJS.ProcessEnv): Map<string, ResolvedConnection> {
  const registry = new Map<string, ResolvedConnection>()
  const declare = (kind: ConnectionKind, spec: PostgresConnectionSpec | ObjectStoreConnectionSpec | CogConnectionSpec, credentials: PostgresCredentials | ObjectStoreCredentials | CogCredentials): void => {
    const idProblem = connectionIdProblem(spec.id)
    if (idProblem !== undefined) {
      throw new ConnectError('CONNECT_CONFIG_INVALID', idProblem)
    }
    if (registry.has(spec.id)) {
      throw new ConnectError('CONNECT_CONFIG_INVALID', `connection id ${spec.id} is declared more than once; ids are global across kinds`)
    }
    if (registry.size >= MAX_CONNECTIONS) {
      throw new ConnectError('CONNECT_CONFIG_INVALID', `at most ${String(MAX_CONNECTIONS)} connections may be declared`)
    }
    registry.set(spec.id, { kind, spec, credentials })
  }

  for (const declared of config.postgis ?? []) {
    const spec: PostgresConnectionSpec = {
      id: declared.id,
      host: declared.host,
      ...(declared.port === undefined ? {} : { port: declared.port }),
      database: declared.database,
      user: declared.user,
      passwordEnv: declared.passwordEnv ?? DEFAULT_POSTGRES_PASSWORD_ENV,
      ssl: declared.ssl ?? 'prefer',
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
    }
    const problem = postgresSpecProblem(spec)
    if (problem !== undefined) throw new ConnectError('CONNECT_CONFIG_INVALID', `postgis connection ${declared.id}: ${problem}`)
    declare('postgis', spec, { password: resolveCredential('postgis', spec.id, spec.passwordEnv, env) })
  }
  for (const declared of config.objectStores ?? []) {
    const spec: ObjectStoreConnectionSpec = {
      id: declared.id,
      endpoint: declared.endpoint,
      region: declared.region,
      bucket: declared.bucket,
      accessKeyIdEnv: declared.accessKeyIdEnv ?? DEFAULT_S3_ACCESS_KEY_ID_ENV,
      secretAccessKeyEnv: declared.secretAccessKeyEnv ?? DEFAULT_S3_SECRET_ACCESS_KEY_ENV,
      ...(declared.sessionTokenEnv === undefined ? {} : { sessionTokenEnv: declared.sessionTokenEnv }),
      addressing: declared.addressing ?? 'path',
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
    }
    const problem = objectStoreSpecProblem(spec)
    if (problem !== undefined) throw new ConnectError('CONNECT_CONFIG_INVALID', `object-store connection ${declared.id}: ${problem}`)
    const sessionToken = declared.sessionTokenEnv === undefined ? undefined : resolveCredential('object-storage', spec.id, declared.sessionTokenEnv, env)
    declare('object-storage', spec, {
      accessKeyId: resolveCredential('object-storage', spec.id, spec.accessKeyIdEnv, env),
      secretAccessKey: resolveCredential('object-storage', spec.id, spec.secretAccessKeyEnv, env),
      ...(sessionToken === undefined ? {} : { sessionToken }),
    })
  }
  for (const declared of config.cogs ?? []) {
    const spec: CogConnectionSpec = {
      id: declared.id,
      url: declared.url,
      ...(declared.tokenEnv === undefined ? {} : { tokenEnv: declared.tokenEnv }),
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
    }
    const problem = cogSpecProblem(spec)
    if (problem !== undefined) throw new ConnectError('CONNECT_CONFIG_INVALID', `cog connection ${declared.id}: ${problem}`)
    const token = declared.tokenEnv === undefined ? undefined : resolveCredential('cog', spec.id, declared.tokenEnv, env)
    declare('cog', spec, token === undefined ? {} : { token })
  }
  return registry
}

/** Endpoint identity for one summary (credential names only, never values). */
function summaryEndpoint(kind: ConnectionKind, spec: PostgresConnectionSpec | ObjectStoreConnectionSpec | CogConnectionSpec): string {
  if (kind === 'postgis') {
    const postgis = spec as PostgresConnectionSpec
    return `postgres://${postgis.user}@${postgis.host}:${String(postgis.port ?? 5432)}/${postgis.database} (passwordEnv ${postgis.passwordEnv}, ssl ${postgis.ssl})`
  }
  if (kind === 'object-storage') {
    const store = spec as ObjectStoreConnectionSpec
    return `${store.endpoint}/${store.bucket}/ (region ${store.region}, ${store.addressing}, keys ${store.accessKeyIdEnv}/${store.secretAccessKeyEnv}${store.sessionTokenEnv === undefined ? '' : `/${store.sessionTokenEnv}`})`
  }
  const cog = spec as CogConnectionSpec
  return `${cog.url}${cog.tokenEnv === undefined ? '' : ` (tokenEnv ${cog.tokenEnv})`}`
}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/spatial-connect'

/** No host services are required: the plugin owns config validation and its service only. */
export const inject: string[] = []

/**
 * Build the service face over one resolved registry; exported so tests and
 * future hosts construct it without a Cordis context.
 * @param registry - the resolved connections keyed by id.
 * @returns the `spatialConnect` service.
 */
export function buildSpatialConnectService(registry: Map<string, ResolvedConnection>): SpatialConnectService {
  return {
    specs: [...registry.values()].map(connection => connection.spec),
    listConnections(): readonly ConnectionSummary[] {
      return [...registry.values()].map(connection => ({
        id: connection.spec.id,
        kind: connection.kind,
        endpoint: summaryEndpoint(connection.kind, connection.spec),
      }))
    },
    async verifyConnection(id, options = {}) {
      const connection = registry.get(id)
      if (connection === undefined) {
        throw new ConnectError('CONNECT_UNKNOWN_CONNECTION', `no declared connection carries id ${id}; listConnections() names the declared set`)
      }
      if (options.signal?.aborted === true) {
        throw new ConnectError('CONNECT_ABORTED', `verification of ${id} was aborted before the exchange started`)
      }
      if (connection.kind === 'postgis') {
        return await verifyPostgres(connection.spec as PostgresConnectionSpec, connection.credentials as PostgresCredentials, options)
      }
      if (connection.kind === 'object-storage') {
        return await verifyObjectStore(connection.spec as ObjectStoreConnectionSpec, connection.credentials as ObjectStoreCredentials, options)
      }
      return await verifyCog(connection.spec as CogConnectionSpec, connection.credentials as CogCredentials, options)
    },
  }
}

/**
 * Host plugin body: validate and resolve every declared connection, then
 * provide the service for the process lifetime.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: SpatialConnectPluginConfig): void {
  const registry = resolveConnections(config, process.env)
  const service = buildSpatialConnectService(registry)

  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(SPATIAL_CONNECT_SERVICE, service)
    return () => {
      void unprovide()
    }
  }, '@map-harness/spatial-connect: service')
}
