/**
 * Operation-owned, bounded GET transport for compiled source resources.
 * Source service callers own native resource admission and public output.
 * @module @map-harness/map-container/source-network
 */
import { Resolver } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { sourceHostAllowed, sourceResolvedAddressAllowed, sourceResolvedAddressIgnorable } from './source-address.ts'
import { SourceCatalogError, type SourceCatalogFailureCode } from './source-error.ts'
import type { ResolvedOutboundProxy, ResolvedSourceNetworkConfig } from './source-network-config.ts'
import type { ResolvedMapSource } from './sources.ts'

/** Host-only compiled request; never construct this directly from wire fields. */
export interface SourceNetworkRequest {
  readonly source: ResolvedMapSource
  readonly url: URL
  readonly payload: 'json' | 'xml' | 'image'
  /** Host-owned conditional headers, never copied from browser request headers. */
  readonly validators?: SourceNetworkValidators
  /** Omission leaves the operation governed by its deadline and transport owner. */
  readonly signal?: AbortSignal
}

/** Private upstream validators for the exact credential/resource scope. */
export interface SourceNetworkValidators {
  readonly etag: string | null
  readonly lastModified: string | null
}

/** Private cache facts; only a policy-derived subset may reach the browser. */
export interface SourceResponseCacheHeaders {
  readonly etag: string | null
  readonly lastModified: string | null
  readonly cacheControl: string | null
  readonly date: string | null
  readonly age: string | null
  readonly expires: string | null
  readonly vary: string | null
}

/** Host-only response, requiring native decoding/header sanitization before wire output. */
export interface SourceNetworkResponse {
  readonly status: 200 | 304
  readonly body: Buffer
  readonly contentType: string | null
  readonly cache: SourceResponseCacheHeaders
}

/** Operation-local DNS dependency; cancel settles its outstanding requests. */
export interface SourceResolver {
  /**
   * Query the IPv4 family without a second system lookup.
   * @param hostname - configured source hostname.
   * @returns IP strings, or a native DNS failure.
   */
  resolve4(hostname: string): Promise<readonly string[]>
  /**
   * Query the IPv6 family independently of IPv4.
   * @param hostname - configured source hostname.
   * @returns IP strings, or a native DNS failure.
   */
  resolve6(hostname: string): Promise<readonly string[]>
  /** Settle pending DNS requests; implementations must not throw. */
  cancel(): void
}

/** Host composition dependency; omission uses a fresh native Resolver per operation. */
export interface SourceNetworkDependencies {
  readonly createResolver?: (timeoutMs: number) => SourceResolver
}

/** Finite GET operations owned by one source service activation. */
export interface SourceNetwork {
  /**
   * Read a compiled resource without redirects or implicit proxies.
   * @param input - host-resolved source, compiled same-origin URL and payload kind.
   * @returns bounded host-only bytes; safe expected failures reject, never partial success.
   */
  request(input: SourceNetworkRequest): Promise<SourceNetworkResponse>
  /** Cancel all queued/running reads; repeated disposal is inert. */
  dispose(): void
}

interface Operation {
  readonly input: SourceNetworkRequest
  readonly controller: AbortController
  readonly resolve: (response: SourceNetworkResponse) => void
  readonly reject: (error: unknown) => void
  readonly detachCaller: () => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly sockets: Socket[]
  done: boolean
  resolver?: SourceResolver
  request?: ClientRequest
  agent?: HttpAgent
}

interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

const media: Readonly<Record<SourceNetworkRequest['payload'], readonly string[]>> = {
  json: ['application/json', 'text/plain'],
  xml: ['application/xml', 'text/xml'],
  image: ['image/png', 'image/jpeg'],
}
const accept: Readonly<Record<SourceNetworkRequest['payload'], string>> = {
  json: 'application/json',
  xml: 'application/xml,text/xml',
  image: 'image/png,image/jpeg',
}
/** Bound on CONNECT response headers; a larger proxy reply is a safe transport failure. */
const CONNECT_RESPONSE_LIMIT = 16_384
const ownedAgentOptions = { keepAlive: false, proxyEnv: {} }

class TunnelAgent extends HttpsAgent {
  private readonly tunnel: TLSSocket
  constructor(tunnel: TLSSocket) {
    super(ownedAgentOptions)
    this.tunnel = tunnel
  }
  override createConnection(): TLSSocket {
    return this.tunnel
  }
}

class PlainTunnelAgent extends HttpAgent {
  private readonly tunnel: Socket
  constructor(tunnel: Socket) {
    super(ownedAgentOptions)
    this.tunnel = tunnel
  }
  override createConnection(): Socket {
    return this.tunnel
  }
}

function safeFailure(code: SourceCatalogFailureCode): SourceCatalogError {
  return new SourceCatalogError(code)
}

function dnsCode(reason: unknown): string | null {
  return typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string'
    ? reason.code : null
}

function resolveFamily(resolver: SourceResolver, family: 'resolve4' | 'resolve6', hostname: string): Promise<readonly string[]> {
  try {
    return resolver[family](hostname)
  } catch (error) {
    // Native resolver input failures must follow the same safe DNS failure path.
    return Promise.reject(error)
  }
}

/** Resolver failures that report a failed lookup rather than an untrusted answer. */
const retryableDnsCodes = new Set(['SERVFAIL', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED', 'EBADRESP', 'EAGAIN', 'ENOMEM'])
const DNS_RETRY_LIMIT = 2

/** Resolve both families, retrying transient resolver failures with a fresh resolver. */
async function resolveReplies(
  operation: Operation,
  createResolver: (timeoutMs: number) => SourceResolver,
  timeoutMs: number,
  hostname: string,
): Promise<readonly PromiseSettledResult<readonly string[]>[]> {
  let resolver = createResolver(timeoutMs)
  operation.resolver = resolver
  for (let attempt = 0; ; attempt += 1) {
    const replies = await Promise.allSettled([
      resolveFamily(resolver, 'resolve4', hostname),
      resolveFamily(resolver, 'resolve6', hostname),
    ])
    const retryable = replies.some(reply => reply.status === 'rejected' && retryableDnsCodes.has(dnsCode(reply.reason) ?? ''))
    if (!retryable || attempt >= DNS_RETRY_LIMIT) return replies
    resolver.cancel()
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
    if (operation.controller.signal.aborted) return replies
    resolver = createResolver(timeoutMs)
    operation.resolver = resolver
  }
}

async function resolveAddress(operation: Operation, createResolver: (timeoutMs: number) => SourceResolver, timeoutMs: number): Promise<PinnedAddress> {
  const hostname = operation.input.url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) return { address: hostname, family: literalFamily }
  const replies = await resolveReplies(operation, createResolver, timeoutMs, hostname)
  if (replies.reduce((count, reply) => count + (reply.status === 'fulfilled' ? reply.value.length : 0), 0) > 64) {
    throw safeFailure('SOURCE_LIMIT_EXCEEDED')
  }
  const addresses: PinnedAddress[] = []
  for (const reply of replies) {
    if (reply.status === 'rejected') {
      const code = dnsCode(reply.reason)
      if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw safeFailure('SOURCE_UNAVAILABLE')
      continue
    }
    for (const address of reply.value) {
      if (!sourceResolvedAddressAllowed(address, operation.input.source.allowPrivateNetwork)) {
        // Public DNS answers may carry a Teredo transition address (RFC 4380).
        // It is never dialed and never private, so it does not poison the answer;
        // every other disallowed candidate keeps the fail-closed decision.
        if (sourceResolvedAddressIgnorable(address)) continue
        throw safeFailure('SOURCE_RESOURCE_DENIED')
      }
      const family = isIP(address)
      if (family !== 4 && family !== 6) throw safeFailure('SOURCE_RESOURCE_DENIED')
      addresses.push({ address, family })
    }
  }
  const selected = addresses.find(address => address.family === 4) ?? addresses[0]
  if (selected === undefined) throw safeFailure('SOURCE_UNAVAILABLE')
  return selected
}

/** Retain a socket for operation cleanup and destroy it when the operation aborts. */
function trackSocket(operation: Operation, socket: Socket): void {
  operation.sockets.push(socket)
  const signal = operation.controller.signal
  const onAbort = (): void => { socket.destroy() }
  signal.addEventListener('abort', onAbort, { once: true })
  socket.once('close', () => signal.removeEventListener('abort', onAbort))
  if (signal.aborted) socket.destroy()
}

function dialProxy(proxy: ResolvedOutboundProxy, operation: Operation): Promise<Socket> {
  const host = proxy.url.hostname.replace(/^\[|\]$/g, '')
  const secure = proxy.url.protocol === 'https:'
  const port = Number(proxy.url.port === '' ? (secure ? 443 : 80) : proxy.url.port)
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: isIP(host) === 0 ? host : undefined, ALPNProtocols: ['http/1.1'] })
      : netConnect({ host, port })
    trackSocket(operation, socket)
    const finish = (error?: SourceCatalogError): void => {
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off(secure ? 'secureConnect' : 'connect', onReady)
      if (error === undefined) resolve(socket)
      else {
        socket.destroy()
        reject(error)
      }
    }
    const onError = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onClose = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onReady = (): void => finish()
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.once(secure ? 'secureConnect' : 'connect', onReady)
  })
}

function readConnectResponse(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = []
    let size = 0
    const finish = (error?: SourceCatalogError): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error === undefined) {
        socket.pause()
        resolve()
      } else {
        socket.destroy()
        reject(error)
      }
    }
    const onError = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onClose = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > CONNECT_RESPONSE_LIMIT) {
        finish(safeFailure('SOURCE_UNAVAILABLE'))
        return
      }
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks, size)
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      if (size > end + 4) {
        finish(safeFailure('SOURCE_UNAVAILABLE'))
        return
      }
      chunks = []
      const statusLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1')
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(statusLine)
      if (match === null) {
        finish(safeFailure('SOURCE_UNAVAILABLE'))
        return
      }
      const status = Number(match[1])
      if (status === 200) finish()
      else if (status === 401 || status === 403 || status === 407) finish(safeFailure('SOURCE_CREDENTIAL_REJECTED'))
      else finish(safeFailure('SOURCE_UNAVAILABLE'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.resume()
  })
}

function upgradeTunnel(operation: Operation, socket: Socket, url: URL): Promise<TLSSocket> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      ALPNProtocols: ['http/1.1'],
      // Verify the origin identity even though the address came from a proxy authority.
      checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
    })
    trackSocket(operation, secure)
    const finish = (error?: SourceCatalogError): void => {
      secure.off('error', onError)
      secure.off('close', onClose)
      secure.off('secureConnect', onReady)
      if (error === undefined) resolve(secure)
      else {
        secure.destroy()
        reject(error)
      }
    }
    const onError = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onClose = (): void => finish(safeFailure('SOURCE_UNAVAILABLE'))
    const onReady = (): void => finish()
    secure.once('error', onError)
    secure.once('close', onClose)
    secure.once('secureConnect', onReady)
  })
}

async function openProxyTunnel(
  operation: Operation,
  url: URL,
  address: PinnedAddress,
  proxy: ResolvedOutboundProxy,
): Promise<Socket> {
  const socket = await dialProxy(proxy, operation)
  if (operation.done) throw safeFailure('SOURCE_CANCELLED')
  const targetHost = proxy.targetResolution === 'proxy'
    ? url.hostname.replace(/^\[|\]$/g, '')
    : address.address
  const authority = isIP(targetHost) === 6 ? `[${targetHost}]` : targetHost
  const port = Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw safeFailure('SOURCE_CONFIG_INVALID')
  const lines = [`CONNECT ${authority}:${port} HTTP/1.1`, `Host: ${authority}:${port}`, 'Proxy-Connection: close']
  if (proxy.authorization !== null) lines.push(`Proxy-Authorization: ${proxy.authorization}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  await readConnectResponse(socket)
  if (url.protocol !== 'https:') {
    // The CONNECT parser paused the socket; the HTTP client reads it directly.
    socket.resume()
    return socket
  }
  return upgradeTunnel(operation, socket, url)
}

function header(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name]
  return typeof value === 'string' ? value : null
}

function cacheFacts(response: IncomingMessage): SourceNetworkResponse['cache'] {
  const facts = {
    etag: header(response, 'etag'),
    lastModified: header(response, 'last-modified'),
    cacheControl: header(response, 'cache-control'),
    date: header(response, 'date'),
    age: header(response, 'age'),
    expires: header(response, 'expires'),
    vary: header(response, 'vary'),
  }
  if (Object.values(facts).some(value => value !== null && (value.length > 2_048 || /[\r\n]/.test(value)))) {
    return { etag: null, lastModified: null, cacheControl: 'no-store', date: null, age: null, expires: null, vary: null }
  }
  return facts
}

function admittedUrl(input: SourceNetworkRequest): URL {
  const url = new URL(input.url.href)
  const endpoint = new URL(input.source.endpoint.replace(/\{[xyz]\}/g, '1'))
  if (url.origin !== endpoint.origin || url.username !== '' || url.password !== '' || url.hash !== ''
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && input.source.allowHttp))
    || !sourceHostAllowed(url.hostname, input.source.allowPrivateNetwork)) {
    throw safeFailure('SOURCE_RESOURCE_DENIED')
  }
  return url
}

/**
 * Create transport with one queue and no global state or response cache.
 * @param limits - fully validated deployment bounds.
 * @param dependencies - optional host DNS provider; omission uses native DNS.
 * @returns transport whose disposal cancels all retained operations and sockets.
 */
export function createSourceNetwork(
  limits: ResolvedSourceNetworkConfig,
  dependencies: SourceNetworkDependencies = {},
): SourceNetwork {
  const createResolver = dependencies.createResolver
    ?? ((timeoutMs: number) => new Resolver({ timeout: timeoutMs, tries: 1 }))
  const queued: Operation[] = []
  const running = new Set<Operation>()
  let disposed = false

  const finish = (operation: Operation, error: unknown, result?: SourceNetworkResponse): void => {
    if (operation.done) return
    operation.done = true
    clearTimeout(operation.timer)
    operation.detachCaller()
    operation.resolver?.cancel()
    operation.request?.destroy()
    for (const socket of operation.sockets) socket.destroy()
    operation.agent?.destroy()
    const index = queued.indexOf(operation)
    if (index >= 0) queued.splice(index, 1)
    running.delete(operation)
    if (error !== null) operation.reject(error)
    else if (result !== undefined) operation.resolve(result)
    else operation.reject(new Error('source response missing at completion'))
    pump()
  }

  const readResponse = (operation: Operation, response: IncomingMessage): void => {
    response.once('error', () => finish(operation, safeFailure('SOURCE_UNAVAILABLE')))
    if (operation.done) {
      response.destroy()
      return
    }
    const status = response.statusCode
    if (status === 401 || status === 403) return finish(operation, safeFailure('SOURCE_CREDENTIAL_REJECTED'))
    if (status === 304) return finish(operation, null, { status, body: Buffer.alloc(0), contentType: null, cache: cacheFacts(response) })
    if (status !== 200) return finish(operation, safeFailure(status !== undefined && status >= 300 && status < 400 ? 'SOURCE_RESOURCE_DENIED' : 'SOURCE_UNAVAILABLE'))
    const encoding = header(response, 'content-encoding')
    const contentType = header(response, 'content-type')?.split(';')[0]?.trim().toLowerCase() ?? null
    if ((encoding !== null && encoding.toLowerCase().trim() !== 'identity')
      || contentType === null || !media[operation.input.payload].includes(contentType)) {
      return finish(operation, safeFailure('SOURCE_RESOURCE_DENIED'))
    }
    const maximum = operation.input.payload === 'image' ? limits.maxResponseBytes : limits.maxMetadataBytes
    const declared = header(response, 'content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) {
      return finish(operation, safeFailure('SOURCE_LIMIT_EXCEEDED'))
    }
    const chunks: Buffer[] = []
    let bytes = 0
    response.on('data', (chunk: Buffer) => {
      if (operation.done) return
      bytes += chunk.byteLength
      if (bytes > maximum) {
        chunks.length = 0
        finish(operation, safeFailure('SOURCE_LIMIT_EXCEEDED'))
      } else chunks.push(chunk)
    })
    response.once('aborted', () => finish(operation, safeFailure('SOURCE_UNAVAILABLE')))
    response.once('end', () => {
      if (operation.done) return
      if (!response.complete || (declared !== null && Number(declared) !== bytes)) {
        finish(operation, safeFailure('SOURCE_UNAVAILABLE'))
        return
      }
      finish(operation, null, { status: 200, body: Buffer.concat(chunks, bytes), contentType, cache: cacheFacts(response) })
    })
  }

  const perform = async (operation: Operation): Promise<void> => {
    const address = await resolveAddress(operation, createResolver, limits.requestTimeoutMs)
    if (operation.done) return
    const url = new URL(operation.input.url.href)
    const credential = operation.input.source.credential
    const headers: Record<string, string> = { accept: accept[operation.input.payload], 'accept-encoding': 'identity' }
    const validators = operation.input.validators
    if (validators?.etag != null) headers['if-none-match'] = validators.etag
    else if (validators?.lastModified != null) headers['if-modified-since'] = validators.lastModified
    if (credential?.type === 'bearer') headers.authorization = `Bearer ${credential.value}`
    if (credential?.type === 'query') {
      const parameter = credential.parameter
      if (parameter === undefined) throw new Error('resolved query credential has no parameter')
      if ([...url.searchParams.keys()].some(key => key.toLowerCase() === parameter.toLowerCase())) throw safeFailure('SOURCE_CONFIG_INVALID')
      url.searchParams.set(parameter, credential.value)
    }
    // An owned agent never inherits global-agent environment proxy configuration.
    // The only proxy ever used is the explicitly configured outbound proxy.
    const proxy = limits.outboundProxy
    let agent: HttpAgent
    if (proxy === null) {
      agent = url.protocol === 'https:' ? new HttpsAgent(ownedAgentOptions) : new HttpAgent(ownedAgentOptions)
    } else {
      const tunnel = await openProxyTunnel(operation, url, address, proxy)
      if (operation.done) return
      // upgradeTunnel returned a TLSSocket for the https branch that selected TunnelAgent.
      agent = url.protocol === 'https:' ? new TunnelAgent(tunnel as TLSSocket) : new PlainTunnelAgent(tunnel)
    }
    operation.agent = agent
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    try {
      operation.request = proxy === null
        ? request(url, {
          method: 'GET', agent, headers, family: address.family, signal: operation.controller.signal,
          lookup(_hostname, _options, callback) { callback(null, address.address, address.family) },
        }, response => readResponse(operation, response))
        : request(url, {
          method: 'GET', agent, headers, signal: operation.controller.signal,
        }, response => readResponse(operation, response))
    } catch (error) {
      // Node request construction owns header/protocol errors; expose no raw values.
      if (error instanceof TypeError) throw safeFailure('SOURCE_CONFIG_INVALID')
      throw error
    }
    operation.request.once('error', () => finish(operation, safeFailure('SOURCE_UNAVAILABLE')))
    operation.request.end()
  }

  const pump = (): void => {
    while (!disposed && running.size < limits.maxConcurrentRequests) {
      const operation = queued.shift()
      if (operation === undefined) return
      running.add(operation)
      void perform(operation).catch(error => finish(operation, error))
    }
  }

  const request = (input: SourceNetworkRequest): Promise<SourceNetworkResponse> => new Promise((resolve, reject) => {
    if (disposed || input.signal?.aborted) {
      reject(safeFailure('SOURCE_CANCELLED'))
      return
    }
    const url = admittedUrl(input)
    const validators = input.validators === undefined ? undefined : { ...input.validators }
    if (validators !== undefined && Object.values(validators).some(value => value !== null && (value.length > 2_048 || /[\r\n]/.test(value)))) {
      reject(safeFailure('SOURCE_RESOURCE_DENIED'))
      return
    }
    if (running.size >= limits.maxConcurrentRequests && queued.length >= limits.maxQueuedRequests) {
      reject(safeFailure('SOURCE_LIMIT_EXCEEDED'))
      return
    }
    const controller = new AbortController()
    const signal = input.signal
    const abortFromCaller = (): void => controller.abort('caller')
    const operation: Operation = {
      input: { source: input.source, url, payload: input.payload, ...(validators === undefined ? {} : { validators }) },
      controller,
      resolve,
      reject,
      detachCaller: () => signal?.removeEventListener('abort', abortFromCaller),
      timer: setTimeout(() => controller.abort('timeout'), limits.requestTimeoutMs),
      sockets: [],
      done: false,
    }
    controller.signal.addEventListener('abort', () => {
      finish(operation, safeFailure(controller.signal.reason === 'timeout' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELLED'))
    }, { once: true })
    queued.push(operation)
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (signal?.aborted) abortFromCaller()
    else pump()
  })

  return {
    request,
    dispose() {
      if (disposed) return
      disposed = true
      for (const operation of [...queued, ...running]) operation.controller.abort('disposed')
    },
  }
}
