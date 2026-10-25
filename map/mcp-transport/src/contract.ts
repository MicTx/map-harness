/**
 * The versioned `mcp-transport@1` contract: the two remote MCP connection
 * kinds (a cross-process stdio child and a remote streamable-HTTP endpoint),
 * their validated connection specifications, the closed exchange-outcome
 * vocabulary, and the bounded deadlines every exchange honors. Connection
 * capability means a declared remote MCP endpoint can be reached over a real
 * transport, proven to complete the MCP `initialize` handshake, discovered
 * through `tools/list`, and dispatched through `tools/call` with protocol
 * correctness — cancellation reaches the peer as a protocol
 * `notifications/cancelled`, deadlines bound every exchange, and teardown
 * settles in-flight work before closing the channel. No remote host is
 * deployed by this project: the keyless lanes prove the client face against
 * loopback fixtures (2026-10-07 deployment decision).
 *
 * Protocol constants (deadline bounds, pagination and child-exit budgets,
 * entry caps) are fixed here and never configurable: endpoints, commands,
 * and credential references are the deployment-varying choices and live in
 * the plugin Config; the exchange discipline is the contract.
 *
 * @module @map-harness/mcp-transport/contract
 */

/** Version identity of this contract; bump only on structural changes. */
export const MCP_TRANSPORT_VERSION = 'mcp-transport@1'

/** The remote MCP connection kinds this plane can prove connectable. */
export type McpConnectionKind = 'stdio' | 'http'

/**
 * The closed vocabulary of exchange outcomes. Every value except
 * `connected` names a *failed exchange* surfaced as an {@link McpExchangeError};
 * a server answering a tool call with `isError: true` content is a successful
 * protocol exchange (a result), never one of these outcomes. `connected` is
 * the only outcome that proves the channel usable for the exchange it closes.
 */
export type McpExchangeOutcome =
  | 'connected'
  | 'unreachable'
  | 'auth-rejected'
  | 'handshake-failed'
  | 'protocol-version-unsupported'
  | 'tool-list-refused'
  | 'server-error'
  | 'protocol-violated'
  | 'timeout'
  | 'aborted'
  | 'transport-closed'

/** All outcomes in their canonical order; assertions iterate this list. */
export const MCP_EXCHANGE_OUTCOMES: readonly McpExchangeOutcome[] = [
  'connected', 'unreachable', 'auth-rejected', 'handshake-failed',
  'protocol-version-unsupported', 'tool-list-refused', 'server-error',
  'protocol-violated', 'timeout', 'aborted', 'transport-closed',
]

/** Connection id rule: lowercase letter, then letters/digits/hyphens, ≤64 chars. */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Environment-variable name rule (POSIX portable set). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Absolute path rule: POSIX root or a Windows drive root; never relative. */
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)/

/** Maximum number of declared connections across both kinds (bounded config). */
export const MAX_CONNECTIONS = 16

/** Bounds for every exchange's wall-clock deadline, in milliseconds. */
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 60_000
export const DEFAULT_TIMEOUT_MS = 10_000

/** At most this many fixed argv entries after the command (bounded spawn). */
export const MAX_ARGS = 32

/** At most this many environment references per stdio connection. */
export const MAX_ENV_REFS = 16

/** Maximum length of any single argv entry or the command itself. */
export const MAX_ARG_LENGTH = 512

/** At most this many `tools/list` pages consumed by one discovery (cursor loop bound). */
export const MAX_TOOL_PAGES = 100

/** Grace window for a stdio child to exit after close before SIGKILL, in milliseconds. */
export const CHILD_EXIT_GRACE_MS = 5_000

/** Maximum serialized length of one outcome detail line; longer is truncated. */
export const MAX_DETAIL_LENGTH = 512

/** A named cross-process stdio MCP connection as the deployment declares it. */
export interface StdioConnectionSpec {
  /** Unique connection id across both kinds. */
  readonly id: string
  /** Discriminator for the stdio connection family. */
  readonly kind: 'stdio'
  /** Executable to spawn; passed as argv[0] without any shell interpolation. */
  readonly command: string
  /** Fixed argv tail after the command; never shell-interpolated. */
  readonly args?: readonly string[]
  /**
   * Child environment additions as references: each key names the variable
   * the child sees, each value names the environment variable of this
   * process holding the value at load; values never enter config or logs.
   */
  readonly envRefs?: Readonly<Record<string, string>>
  /** Absolute working directory for the child; omitted inherits the harness cwd. */
  readonly cwd?: string
  /** Wall-clock deadline for any single exchange over this connection. */
  readonly timeoutMs?: number
}

/** A named remote streamable-HTTP MCP connection as the deployment declares it. */
export interface HttpConnectionSpec {
  /** Unique connection id across both kinds. */
  readonly id: string
  /** Discriminator for the streamable-HTTP connection family. */
  readonly kind: 'http'
  /** Endpoint URL: `http(s)`, a host, no userinfo, no fragment. */
  readonly url: string
  /** Environment-variable name holding a bearer token; the value never enters config or logs. */
  readonly tokenEnv?: string
  /** Wall-clock deadline for any single exchange over this connection. */
  readonly timeoutMs?: number
}

/** Any declared connection spec. */
export type AnyConnectionSpec = StdioConnectionSpec | HttpConnectionSpec

/** One remote tool discovered through MCP `tools/list`. */
export interface RemoteToolDescriptor {
  /** Raw MCP tool name. */
  readonly name: string
  /** Server-provided description, empty when absent. */
  readonly description: string
  /** The server's JSON schema for the tool's input object. */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** The report one bounded connection verification produces. */
export interface McpConnectionVerification {
  /** The verified connection id. */
  readonly id: string
  /** The connection family that produced this report. */
  readonly kind: McpConnectionKind
  /** The closed outcome vocabulary value naming the exchange result. */
  readonly outcome: McpExchangeOutcome
  /** Sanitized, bounded diagnostic; never a credential value or host absolute path. */
  readonly detail: string
  /** Server implementation name, present when the handshake completed. */
  readonly serverName?: string
  /** Server implementation version, present when the handshake completed. */
  readonly serverVersion?: string
  /** Negotiated MCP protocol version, present when the handshake completed. */
  readonly protocolVersion?: string
  /** Discovered tool count, present when `tools/list` completed. */
  readonly toolCount?: number
  /** Whole-exchange wall time in milliseconds. */
  readonly durationMs: number
}

/** Validate a connection id against the contract rule. */
export function connectionIdProblem(id: string): string | undefined {
  if (!CONNECTION_ID_PATTERN.test(id)) {
    return `connection id "${redact(id)}" must match ${CONNECTION_ID_PATTERN.source} (lowercase letter first, letters/digits/hyphens, at most 64 chars)`
  }
  return undefined
}

/** Validate a stdio connection spec; returns the first problem or undefined. */
export function stdioSpecProblem(spec: StdioConnectionSpec): string | undefined {
  if (spec.command.length === 0 || spec.command.length > MAX_ARG_LENGTH) {
    return `command must be 1..${String(MAX_ARG_LENGTH)} chars, got ${String(spec.command.length)}`
  }
  if (spec.command.includes('\0') || spec.command.includes('\n')) {
    return 'command must not contain NUL or newline bytes'
  }
  const args = spec.args ?? []
  if (args.length > MAX_ARGS) {
    return `at most ${String(MAX_ARGS)} args allowed, got ${String(args.length)}`
  }
  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH) {
      return `arg longer than ${String(MAX_ARG_LENGTH)} chars is refused`
    }
    if (arg.includes('\0')) {
      return 'arg must not contain NUL bytes'
    }
  }
  const entries = Object.entries(spec.envRefs ?? {})
  if (entries.length > MAX_ENV_REFS) {
    return `at most ${String(MAX_ENV_REFS)} env references allowed, got ${String(entries.length)}`
  }
  for (const [childName, envName] of entries) {
    if (!ENV_NAME_PATTERN.test(childName)) {
      return `env reference key "${redact(childName)}" is not a portable variable name`
    }
    if (!ENV_NAME_PATTERN.test(envName)) {
      return `env reference for "${redact(childName)}" names "${redact(envName)}", which is not a portable variable name`
    }
  }
  if (spec.cwd !== undefined && !ABSOLUTE_PATH_PATTERN.test(spec.cwd)) {
    return 'cwd must be an absolute path'
  }
  return timeoutProblem(spec.timeoutMs)
}

/** Validate a streamable-HTTP connection spec; returns the first problem or undefined. */
export function httpSpecProblem(spec: HttpConnectionSpec): string | undefined {
  let url: URL
  try {
    url = new URL(spec.url)
  } catch {
    return `url "${redact(spec.url)}" does not parse as an absolute URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `url scheme must be http or https, got "${url.protocol}"`
  }
  if (url.username !== '' || url.password !== '') {
    return 'url must not carry userinfo credentials'
  }
  if (url.hash !== '') {
    return 'url must not carry a fragment'
  }
  if (url.host === '') {
    return 'url must name a host'
  }
  if (spec.tokenEnv !== undefined && !ENV_NAME_PATTERN.test(spec.tokenEnv)) {
    return `tokenEnv "${redact(spec.tokenEnv)}" is not a portable variable name`
  }
  return timeoutProblem(spec.timeoutMs)
}

/** Validate the deadline field shared by both families. */
function timeoutProblem(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return `timeoutMs must be an integer between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}`
  }
  return undefined
}

/** Clamp detail text to the contract bound; credential material never reaches this function. */
export function boundDetail(text: string): string {
  if (text.length <= MAX_DETAIL_LENGTH) return text
  return `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…`
}

/** Redact free-text config fragments to a bounded shape before they enter diagnostics. */
function redact(value: string): string {
  const bounded = value.slice(0, 32)
  return bounded.length === value.length ? bounded : `${bounded}…`
}
