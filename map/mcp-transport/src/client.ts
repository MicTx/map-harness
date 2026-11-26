/**
 * The remote MCP client face: opens one connection over a real transport —
 * a cross-process stdio child (`StdioClientTransport`) or a remote
 * streamable-HTTP endpoint (`StreamableHTTPClientTransport`) — and proves
 * the MCP protocol path end to end: the `initialize` handshake on connect
 * (negotiated protocol version and server identity recorded), paginated
 * `tools/list` discovery, and `tools/call` dispatch. Every exchange carries
 * a wall-clock deadline and honors the caller's `AbortSignal`; aborting
 * reaches the peer as a protocol `notifications/cancelled` before the local
 * promise rejects. Teardown is quiescent: in-flight exchanges settle, the
 * client closes, and a stdio child's exit is confirmed within a bounded
 * grace window with a SIGKILL fallback so no orphan survives disposal.
 *
 * Exchange failures throw {@link McpExchangeError} carrying one closed
 * {@link McpExchangeOutcome}; a tool call answered with `isError: true`
 * content is a successful protocol exchange and resolves normally.
 *
 * @module @map-harness/mcp-transport/client
 */
import { Client, SdkError, SdkHttpError, StreamableHTTPClientTransport, UnsupportedProtocolVersionError, type CallToolResult, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import {
  boundDetail,
  CHILD_EXIT_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  type AnyConnectionSpec,
  type HttpConnectionSpec,
  type McpConnectionVerification,
  type McpExchangeOutcome,
  type RemoteToolDescriptor,
  type StdioConnectionSpec,
  MAX_TOOL_PAGES,
} from './contract.ts'
import { McpTransportError } from './errors.ts'

/** Credentials resolved once at plugin load; values live in memory only. */
export interface RemoteMcpCredentials {
  /** Bearer token for HTTP endpoints; absent means no `Authorization` header. */
  readonly token?: string
  /** Resolved child-environment values keyed by the variable name the child sees. */
  readonly env?: Readonly<Record<string, string>>
}

/** Options every exchange accepts. */
export interface McpExchangeOptions {
  /** Caller cancellation; honored before the deadline when already aborted. */
  readonly signal?: AbortSignal
  /** Per-exchange deadline override; defaults to the spec's `timeoutMs`. */
  readonly timeoutMs?: number
}

/**
 * One exchange failure with its closed outcome. Thrown by every client face
 * below; `detail` is sanitized and bounded, never a credential value.
 */
export class McpExchangeError extends Error {
  /** The exchange outcome naming the failure mode. */
  readonly outcome: Exclude<McpExchangeOutcome, 'connected'>
  constructor(outcome: Exclude<McpExchangeOutcome, 'connected'>, detail: string) {
    super(`mcp exchange ${outcome}: ${boundDetail(detail)}`)
    this.name = 'McpExchangeError'
    this.outcome = outcome
  }
}

/** One open remote MCP connection and its lifecycle facts. */
export interface RemoteMcpConnection {
  /** The spec this connection was opened from. */
  readonly spec: AnyConnectionSpec
  /** Server implementation name from the completed handshake. */
  serverName(): string | undefined
  /** Server implementation version from the completed handshake. */
  serverVersion(): string | undefined
  /** Negotiated MCP protocol version from the completed handshake. */
  protocolVersion(): string | undefined
  /** OS process id of the stdio child, or null for HTTP connections. */
  childPid(): number | null
  /** Discover the tool catalog through paginated `tools/list`; frozen per call. */
  discoverTools(options?: McpExchangeOptions): Promise<readonly RemoteToolDescriptor[]>
  /**
   * Dispatch one `tools/call`; resolves with the raw MCP result (server
   * `isError` content included — that is a result, not an exchange failure).
   * @param name - raw MCP tool name.
   * @param args - tool arguments as the server's schema expects.
   * @param options - deadline and cancellation for this one exchange.
   */
  callTool(name: string, args: Readonly<Record<string, unknown>>, options?: McpExchangeOptions): Promise<CallToolResult>
  /** Quiescent teardown: settle in-flight, close, confirm child exit; idempotent. */
  close(): Promise<void>
}

/** The exchange phase an error occurred in; picks the refusal outcome. */
type ExchangePhase = 'connect' | 'discover' | 'call'

/** What aborted the composed signal of one exchange, when it aborted. */
type AbortSource = 'deadline' | 'caller' | 'lifecycle'

/** Narrow an unknown thrown value to a displayable message without leaking values. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Map a generic protocol refusal to the phase-specific outcome. */
function phaseRefusal(phase: ExchangePhase): Exclude<McpExchangeOutcome, 'connected'> {
  if (phase === 'connect') return 'handshake-failed'
  if (phase === 'discover') return 'tool-list-refused'
  return 'server-error'
}

/** Classify one transport/SDK failure into the closed outcome vocabulary. */
function classify(error: unknown, phase: ExchangePhase): Exclude<McpExchangeOutcome, 'connected'> {
  if (error instanceof UnsupportedProtocolVersionError) {
    return 'protocol-version-unsupported'
  }
  if (SdkHttpError.isInstance(error)) {
    if (error.status === 401 || error.status === 403) return 'auth-rejected'
    return phaseRefusal(phase)
  }
  const text = messageOf(error).toLowerCase()
  if (text.includes('protocol version') && (text.includes('not supported') || text.includes('unsupported'))) {
    return 'protocol-version-unsupported'
  }
  if (SdkError.isInstance(error)) {
    if (error.code === 'INVALID_RESULT') return 'protocol-violated'
    if (error.code === 'CONNECTION_CLOSED') return 'transport-closed'
    if (error.code === 'REQUEST_TIMEOUT') return 'timeout'
    const message = messageOf(error)
    if (message.startsWith('Invalid result for')) return 'protocol-violated'
    if (message.includes('Connection closed')) return 'transport-closed'
    return phaseRefusal(phase)
  }
  if (error instanceof Error) {
    const message = messageOf(error)
    if (message.includes("protocol version is not supported")) return 'protocol-version-unsupported'
    if (/^spawn .+ (ENOENT|EACCES|EPERM)$/.test(message)) return 'unreachable'
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unreachable'
    if (message === 'fetch failed') return 'unreachable'
    return phaseRefusal(phase)
  }
  return phaseRefusal(phase)
}

/** One deadline-bound execution wrapper shared by every exchange. */
interface DeadlineRunner {
  /** Composed signal honoring caller abort, the lifecycle, and the deadline. */
  readonly signal: AbortSignal
  /** Which source aborted the composed signal, when it aborted. */
  abortSource(): AbortSource | undefined
  /** Detach listeners and stop the timer once the exchange settles. */
  settle(): void
}

/** Wrap one exchange in a deadline; the runner must be settled on every path. */
function withDeadline(timeoutMs: number, callerSignal: AbortSignal | undefined, lifecycle: AbortSignal): DeadlineRunner {
  let source: AbortSource | undefined
  const controller = new AbortController()
  const onCallerAbort = (): void => {
    if (source === undefined) source = 'caller'
    controller.abort(callerSignal?.reason)
  }
  const onLifecycleAbort = (): void => {
    if (source === undefined) source = 'lifecycle'
    controller.abort(lifecycle.reason)
  }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  lifecycle.addEventListener('abort', onLifecycleAbort, { once: true })
  if (callerSignal?.aborted === true) onCallerAbort()
  if (lifecycle.aborted === true) onLifecycleAbort()
  const timer = setTimeout(() => {
    if (source === undefined) source = 'deadline'
    controller.abort(new DOMException('mcp transport exchange deadline exceeded', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    abortSource: () => source,
    settle(): void {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      lifecycle.removeEventListener('abort', onLifecycleAbort)
    },
  }
}

/** Resolve one exchange's outcome from its abort source or thrown error. */
function outcomeFor(runner: DeadlineRunner, error: unknown, phase: ExchangePhase): Exclude<McpExchangeOutcome, 'connected'> {
  const source = runner.abortSource()
  if (source === 'deadline') return 'timeout'
  if (source === 'caller') return 'aborted'
  if (source === 'lifecycle') return 'transport-closed'
  return classify(error, phase)
}

/**
 * Cancel-and-classify wrapper for the connect phase; `connect()` accepts no
 * request options, so cancellation closes the transport, which rejects the
 * pending initialize.
 */
interface ConnectDeadline {
  /** Which source cancelled the connect, when it cancelled. */
  source(): AbortSource | undefined
  /** Detach listeners and stop the timer once connect settles. */
  settle(): void
}

/** Wrap the connect exchange in a deadline that cancels through the transport. */
function withConnectDeadline(timeoutMs: number, callerSignal: AbortSignal | undefined, lifecycle: AbortSignal, transport: Transport): ConnectDeadline {
  let cancelled: AbortSource | undefined
  const cancel = (source: AbortSource): void => {
    if (cancelled !== undefined) return
    cancelled = source
    void transport.close().catch(() => { /* cancellation is best-effort; connect still rejects */ })
  }
  const onCallerAbort = (): void => { cancel('caller') }
  const onLifecycleAbort = (): void => { cancel('lifecycle') }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  lifecycle.addEventListener('abort', onLifecycleAbort, { once: true })
  const timer = setTimeout(() => { cancel('deadline') }, timeoutMs)
  return {
    source: () => cancelled,
    settle(): void {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      lifecycle.removeEventListener('abort', onLifecycleAbort)
    },
  }
}

/** Poll a pid until it is gone; SIGKILL after the grace window. */
async function confirmChildExit(pid: number | null): Promise<void> {
  if (pid === null) return
  const deadline = Date.now() + CHILD_EXIT_GRACE_MS
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  const killDeadline = Date.now() + 1_000
  while (Date.now() < killDeadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Build the transport for one spec kind. */
function buildTransport(spec: AnyConnectionSpec, credentials: RemoteMcpCredentials): Transport {
  if (spec.kind === 'stdio') {
    const stdio = spec as StdioConnectionSpec
    const env: Record<string, string> = { ...getDefaultEnvironment(), ...(credentials.env ?? {}) }
    return new StdioClientTransport({
      command: stdio.command,
      args: [...(stdio.args ?? [])],
      env,
      ...(stdio.cwd === undefined ? {} : { cwd: stdio.cwd }),
      stderr: 'pipe',
    })
  }
  const http = spec as HttpConnectionSpec
  const headers: Record<string, string> = {}
  if (credentials.token !== undefined) headers.Authorization = `Bearer ${credentials.token}`
  return new StreamableHTTPClientTransport(new URL(http.url), {
    ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
  })
}

/** Deadline for one exchange from its options and the spec default. */
function deadlineOf(spec: AnyConnectionSpec, options: McpExchangeOptions | undefined): number {
  return options?.timeoutMs ?? spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/**
 * Open one remote MCP connection over a real transport and complete the
 * `initialize` handshake.
 * @param spec - the validated connection spec.
 * @param credentials - values resolved once at plugin load.
 * @param options - deadline and cancellation for the open exchange.
 * @returns the connection handle with handshake facts recorded.
 * @throws McpExchangeError when any transport or protocol step fails.
 */
export function openRemoteMcp(spec: AnyConnectionSpec, credentials: RemoteMcpCredentials, options: McpExchangeOptions = {}): Promise<RemoteMcpConnection> {
  if (options.signal?.aborted === true) {
    return Promise.reject(new McpExchangeError('aborted', 'caller aborted before the exchange started'))
  }
  const lifecycle = new AbortController()
  const transport = buildTransport(spec, credentials)
  const client = new Client({ name: 'map-harness-mcp-transport', version: '0.1.0' })
  let observedChildPid: number | null = null
  const childPid = (): number | null => observedChildPid
  const inFlight = new Set<Promise<unknown>>()
  let disposed = false
  let disposal: Promise<void> | undefined

  const runner = withConnectDeadline(deadlineOf(spec, options), options.signal, lifecycle.signal, transport)
  const openOperation: Promise<void> = client.connect(transport, {
    timeout: deadlineOf(spec, options),
  })
  inFlight.add(openOperation)

  const teardownAfterFailedOpen = (): void => {
    void (async () => {
      try {
        await client.close()
      } catch { /* a failed open leaves nothing requiring a surfaced close error */ }
      await confirmChildExit(childPid())
    })()
  }

  return openOperation.then(
    () => {
      inFlight.delete(openOperation)
      observedChildPid = transport instanceof StdioClientTransport ? transport.pid : null
      runner.settle()

      async function runExchange<T>(phase: ExchangePhase, exchangeOptions: McpExchangeOptions | undefined, exchange: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
        if (disposed) throw new McpExchangeError('transport-closed', 'connection is already closed')
        if (exchangeOptions?.signal?.aborted === true) {
          throw new McpExchangeError('aborted', `caller aborted before the ${phase} exchange started`)
        }
        const timeoutMs = deadlineOf(spec, exchangeOptions)
        const exchangeRunner = withDeadline(timeoutMs, exchangeOptions?.signal, lifecycle.signal)
        const operation = exchange(exchangeRunner.signal, timeoutMs)
        inFlight.add(operation)
        try {
          return await operation
        } catch (error: unknown) {
          if (error instanceof McpTransportError || error instanceof McpExchangeError) throw error
          throw new McpExchangeError(outcomeFor(exchangeRunner, error, phase), messageOf(error))
        } finally {
          exchangeRunner.settle()
          inFlight.delete(operation)
        }
      }

      const connection: RemoteMcpConnection = {
        spec,
        serverName: () => client.getServerVersion()?.name,
        serverVersion: () => client.getServerVersion()?.version,
        protocolVersion: () => client.getNegotiatedProtocolVersion(),
        childPid,
        async discoverTools(discoverOptions?: McpExchangeOptions): Promise<readonly RemoteToolDescriptor[]> {
          const tools: RemoteToolDescriptor[] = []
          let cursor: string | undefined
          for (let page = 0; page < MAX_TOOL_PAGES; page++) {
            const listed = await runExchange('discover', discoverOptions, (signal, timeoutMs) =>
              client.listTools({ ...(cursor === undefined ? {} : { cursor }) }, { signal, timeout: timeoutMs + 1_000 }))
            for (const tool of listed.tools) {
              tools.push(Object.freeze({
                name: tool.name,
                description: tool.description ?? '',
                inputSchema: Object.freeze({ ...tool.inputSchema }) as Record<string, unknown>,
              }))
            }
            if (listed.nextCursor === undefined) return Object.freeze(tools)
            cursor = listed.nextCursor
          }
          throw new McpExchangeError('protocol-violated', `tools/list pagination exceeded ${String(MAX_TOOL_PAGES)} pages without terminating`)
        },
        callTool(name: string, args: Readonly<Record<string, unknown>>, callOptions?: McpExchangeOptions): Promise<CallToolResult> {
          return runExchange('call', callOptions, (signal, timeoutMs) =>
            client.callTool({ name, arguments: { ...args } }, { signal, timeout: timeoutMs + 1_000 }))
        },
        close(): Promise<void> {
          return disposal ??= (async () => {
            disposed = true
            lifecycle.abort(new DOMException('mcp transport connection disposed', 'AbortError'))
            await Promise.allSettled([...inFlight])
            let closeError: unknown
            try {
              await client.close()
            } catch (error: unknown) {
              closeError = error
            }
            await confirmChildExit(childPid())
            if (closeError !== undefined) {
              throw new McpTransportError('MCP_TRANSPORT_STATE', `transport close failed: ${messageOf(closeError)}`)
            }
          })()
        },
      }
      return connection
    },
    (error: unknown) => {
      inFlight.delete(openOperation)
      runner.settle()
      teardownAfterFailedOpen()
      if (error instanceof McpExchangeError || error instanceof McpTransportError) throw error
      const cancelled = runner.source()
      throw new McpExchangeError(
        cancelled === 'deadline' ? 'timeout' : cancelled === 'caller' ? 'aborted' : cancelled === 'lifecycle' ? 'transport-closed' : classify(error, 'connect'),
        messageOf(error),
      )
    },
  )
}

/**
 * Run one bounded verification exchange over a fresh connection: open,
 * handshake, discover, close. Server-side answers are outcomes on the
 * returned report, never throws for them.
 * @param spec - the validated connection spec.
 * @param credentials - values resolved once at plugin load.
 * @param options - deadline and cancellation for the whole verification.
 * @returns the verification report with handshake facts and tool count.
 */
export async function verifyRemoteMcp(spec: AnyConnectionSpec, credentials: RemoteMcpCredentials, options: McpExchangeOptions = {}): Promise<McpConnectionVerification> {
  const startedAt = Date.now()
  let connection: RemoteMcpConnection | undefined
  try {
    connection = await openRemoteMcp(spec, credentials, options)
    const tools = await connection.discoverTools(options)
    const serverName = connection.serverName()
    const serverVersion = connection.serverVersion()
    const protocolVersion = connection.protocolVersion()
    await connection.close()
    return {
      id: spec.id,
      kind: spec.kind,
      outcome: 'connected',
      detail: `handshake completed over ${spec.kind}; ${String(tools.length)} tools discovered`,
      ...(serverName === undefined ? {} : { serverName }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      toolCount: tools.length,
      durationMs: Date.now() - startedAt,
    }
  } catch (error: unknown) {
    const outcome = error instanceof McpExchangeError ? error.outcome : 'transport-closed'
    const detail = error instanceof Error ? error.message : 'exchange failed without a diagnostic'
    try {
      await connection?.close()
    } catch { /* close during a failed verification never masks the outcome */ }
    return {
      id: spec.id,
      kind: spec.kind,
      outcome,
      detail: boundDetail(detail),
      durationMs: Date.now() - startedAt,
    }
  }
}
