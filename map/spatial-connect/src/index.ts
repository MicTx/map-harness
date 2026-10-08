/**
 * `@map-harness/spatial-connect` — the external data connection plane at
 * connection capability: the versioned `spatial-connect@1` contract with
 * PostGIS, S3-compatible object-store, and COG connection specifications, a
 * validated deployment Config whose credential fields are environment-variable
 * references (values resolved once at load and held in memory only), and
 * protocol-level connectivity and authentication verification — a PostgreSQL
 * v3 wire handshake (SCRAM-SHA-256/MD5/cleartext with ServerSignature
 * verification), a SigV4-signed zero-key ListObjectsV2, and an HTTP-range
 * TIFF/BigTIFF header validation. Verification reads metadata only; nothing
 * is synchronized or stored. The keyless fixture lanes assert every wire
 * shape; the key-activated lane re-verifies against real endpoints when the
 * documented credential environment is present and self-skips otherwise.
 * The host face mounts through the map-web profile patch.
 *
 * @module @map-harness/spatial-connect
 */
export {
  COG_MAX_DIRECTORY_BYTES,
  COG_MAX_RANGE_REQUESTS,
  CONNECTION_OUTCOMES,
  DEFAULT_TIMEOUT_MS,
  HTTP_ROOT_PATTERN,
  MAX_CONNECTIONS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  POSTGRES_DEFAULT_PORT,
  SPATIAL_CONNECT_VERSION,
  TIFF_MAX_IFD_ENTRIES,
  bounded,
  cogSpecProblem,
  connectionIdProblem,
  hostProblem,
  objectStoreSpecProblem,
  postgresSpecProblem,
  sanitizeDetail,
  timeoutProblem,
  type CogConnectionSpec,
  type CogVerificationFacts,
  type ConnectionFacts,
  type ConnectionKind,
  type ConnectionOutcome,
  type ConnectionVerification,
  type NowMs,
  type ObjectStoreConnectionSpec,
  type ObjectStoreVerificationFacts,
  type PostgresConnectionSpec,
  type PostgresVerificationFacts,
  type S3Addressing,
  type TlsMode,
} from './contract.ts'
export { ConnectError, type ConnectErrorCode } from './errors.ts'
export {
  EMPTY_BODY_SHA256,
  signSigV4,
  verifyObjectStore,
  type ObjectStoreCredentials,
  type ObjectStoreFetch,
  type ObjectStoreVerifyOptions,
  type SigV4Request,
  type SigV4RequestInput,
} from './objectstore.ts'
export {
  verifyCog,
  type CogCredentials,
  type CogFetch,
  type CogVerifyOptions,
} from './cog.ts'
export {
  createNodeTransport,
  verifyPostgres,
  type PostgresCredentials,
  type PostgresTransport,
  type PostgresTransportFactory,
  type PostgresVerifyOptions,
  type PostgresWire,
} from './postgres.ts'
export { SPATIAL_CONNECT_SERVICE, type ConnectionSummary, type SpatialConnectService } from './service.ts'
export {
  Config,
  DEFAULT_COG_TOKEN_ENV,
  DEFAULT_POSTGRES_PASSWORD_ENV,
  DEFAULT_S3_ACCESS_KEY_ID_ENV,
  DEFAULT_S3_SECRET_ACCESS_KEY_ENV,
  apply,
  buildSpatialConnectService,
  inject,
  name,
  resolveConnections,
  type SpatialConnectPluginConfig,
} from './plugin.ts'
