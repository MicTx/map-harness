/**
 * The PostGIS connector: a minimal, complete PostgreSQL v3 wire client that
 * proves a declared endpoint connectable — TCP (with SSL negotiation) or TLS,
 * startup, authentication (SCRAM-SHA-256 without channel binding, MD5, or
 * cleartext), one `SELECT version()` exchange, Terminate. It reads metadata
 * only; no result rows beyond the version string, no session pooling, and no
 * query surface — the connection-capability contract, nothing else.
 *
 * ## Wire discipline
 *
 * - Every message is one framed read: `type byte + Int32BE length + payload`
 *   (length includes itself). Frames shorter than 4 or larger than 1 MiB are
 *   protocol violations, never guessed past.
 * - TLS: `disable` never asks; `prefer` asks (SSLRequest) and continues
 *   cleartext when the server answers `N`; `require` refuses cleartext with
 *   `server-refused`. The TLS upgrade verifies the server certificate against
 *   the system trust store with SNI (`servername` = configured host).
 * - SCRAM-SHA-256 follows RFC 5802 + RFC 7677 with the `n,,` gs2 header (no
 *   channel binding); the client verifies the ServerSignature in
 *   AuthenticationSASLFinal — a mismatch is a protocol violation (server
 *   identity not proven), never a silent pass.
 * - Credentials exist only inside the transport bytes; every detail and error
 *   text passes through {@link sanitizeDetail} with the password held against it.
 *
 * ## Outcome mapping
 *
 * SQLSTATE 28P01/28000/28P02 → `auth-rejected`; 3D000 → `not-found`; every
 * other server report → `server-refused` with the code; transport/DNS/TLS
 * failures → `unreachable`; deadline → `timeout`; caller abort → `aborted`;
 * framing or handshake desync → `protocol-violated`.
 *
 * @module @map-harness/spatial-connect/postgres
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { ConnectionVerification, PostgresConnectionSpec, PostgresVerificationFacts } from './contract.ts'
import { DEFAULT_TIMEOUT_MS, bounded, defaultNowMs, sanitizeDetail } from './contract.ts'
import type * as Net from 'node:net'

/** Protocol version 3.0 carried in the StartupMessage (major<<16|minor). */
const PG_PROTOCOL_VERSION = 196608

/** The SSLRequest code (80877103) — a protocol constant, not configuration. */
const PG_SSL_REQUEST_CODE = 80877103

/** Largest framed message accepted; larger server frames are protocol violations. */
const PG_MAX_MESSAGE_BYTES = 1024 * 1024

/** ParameterStatus names a verification report may carry (bounded identity set). */
const REPORTED_PARAMETERS: ReadonlySet<string> = new Set([
  'server_version', 'server_encoding', 'DateStyle', 'TimeZone', 'standard_conforming_strings', 'integer_datetimes',
])

/** At most this many ParameterStatus entries the report carries. */
const MAX_REPORTED_PARAMETERS = 8

/** Upper bound on PBKDF2 iteration counts accepted from a server (DoS bound). */
const MAX_SCRAM_ITERATIONS = 65_536

/**
 * The byte-duplex face the client drives; the real transport wraps
 * `net.Socket` (with a TLS upgrade), the fixture lane scripts it.
 */
export interface PostgresWire {
  /** Queue bytes for the server; never throws after destroy. */
  write(data: Uint8Array): void
  /** Register the chunk listener (at-most-one active). */
  onData(listener: (chunk: Uint8Array) => void): void
  /** Register the fatal-error listener. */
  onError(listener: (error: Error) => void): void
  /** Register the close listener. */
  onClose(listener: (hadError: boolean) => void): void
  /** Tear the transport down unconditionally. */
  destroy(): void
}

/** One established transport: the wire face plus the underlying socket for TLS upgrade. */
export interface PostgresTransport {
  /** The framing wire. */
  readonly wire: PostgresWire
  /** The underlying socket (the TLS upgrade consumes it). */
  readonly socket: Net.Socket
}

/** Creates and upgrades transports; injectable for the fixture lane. */
export interface PostgresTransportFactory {
  /**
   * Open a TCP connection to `host:port`.
   * @param host - configured server hostname.
   * @param port - configured server port.
   * @param timeoutMs - connect deadline honored by the transport.
   * @param signal - caller cancellation carried into the connect.
   * @returns the established transport.
   */
  connect(host: string, port: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<PostgresTransport>
  /**
   * Upgrade an established transport to TLS with certificate verification.
   * @param transport - the established cleartext transport.
   * @param servername - SNI/verification name (the configured host).
   * @returns the TLS transport.
   */
  startTls(transport: PostgresTransport, servername: string): Promise<PostgresTransport>
}

/** The credentials a verification holds in memory for the exchange only. */
export interface PostgresCredentials {
  /** The role password, resolved from the configured environment variable. */
  readonly password: string
}

/** Extra verification options: deadlines, cancellation, clocks, transports. */
export interface PostgresVerifyOptions {
  /** Caller cancellation, honored at frame boundaries and connect. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline override for the whole exchange. */
  readonly timeoutMs?: number
  /** Monotonic clock for the latency report; defaults to `performance.now`. */
  readonly now?: () => number
  /** Transport factory; defaults to the real TCP/TLS transport. */
  readonly transport?: PostgresTransportFactory
}

/** Map a PostgreSQL SQLSTATE onto the connection outcome vocabulary. */
function outcomeForSqlState(sqlState: string): 'auth-rejected' | 'not-found' | 'server-refused' {
  if (sqlState === '28P01' || sqlState === '28000' || sqlState === '28P02') return 'auth-rejected'
  if (sqlState === '3D000') return 'not-found'
  return 'server-refused'
}

/** md5 password response: `md5` + md5hex(md5hex(password+user) + salt). */
function md5Password(password: string, user: string, salt: Uint8Array): string {
  const inner = createHash('md5').update(`${password}${user}`).digest('hex')
  return `md5${createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex')}`
}

/** Escape one SCRAM attribute value (=2C for comma, =3D for equals). */
function saslEscape(value: string): string {
  return value.replaceAll('=', '=3D').replaceAll(',', '=2C')
}

/** XOR two equal-length byte strings (proof = key XOR signature). */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    out[i] = left ^ right
  }
  return out
}

/** One framed server message. */
interface PgMessage {
  readonly type: number
  readonly payload: Uint8Array
}

/**
 * The framing reader: accumulates transport chunks and yields whole
 * length-prefixed messages (and exact byte strings for the pre-framing SSL
 * negotiation answer); framing violations reject every waiter loudly.
 */
type ReaderWaiter =
  | { kind: 'message'; resolve: (message: PgMessage) => void; reject: (error: Error) => void }
  | { kind: 'bytes'; count: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }

class PgReader {
  private buffer: Uint8Array = new Uint8Array(0)
  private failure: Error | undefined
  private readonly waiters: ReaderWaiter[] = []

  /** Ingest one transport chunk; complete frames resolve the oldest waiter. */
  push(chunk: Uint8Array): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  /** Record the transport's death; pending and future waiters reject. */
  fail(error: Error): void {
    this.failure = this.failure ?? error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /** Wait for the next complete message; framing violations reject. */
  read(): Promise<PgMessage> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'message', resolve, reject })
      this.drain()
    })
  }

  /**
   * Wait for exactly `count` raw bytes — used only for the single-byte SSL
   * negotiation answer, which sits outside the message framing.
   * @param count - the exact byte count to consume.
   */
  readExact(count: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'bytes', count, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      if (this.failure !== undefined) {
        for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure)
        return
      }
      const waiter = this.waiters[0]!
      if (waiter.kind === 'bytes') {
        if (this.buffer.length < waiter.count) return
        const bytes = this.buffer.subarray(0, waiter.count)
        this.buffer = this.buffer.subarray(waiter.count)
        this.waiters.shift()
        waiter.resolve(bytes)
        continue
      }
      if (this.buffer.length < 5) return
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getInt32(1)
      if (length < 4 || length > PG_MAX_MESSAGE_BYTES) {
        // A framing violation is a protocol desync, so it maps to
        // `protocol-violated`, never to a generic transport failure.
        this.fail(new ProtocolDesync(`server frame length ${String(length)} violates the protocol`))
        return
      }
      if (this.buffer.length < 1 + length) return
      const frame = this.buffer.subarray(0, 1 + length)
      this.buffer = this.buffer.subarray(1 + length)
      this.waiters.shift()
      waiter.resolve({ type: frame[0]!, payload: frame.subarray(5) })
    }
  }
}

/** Framed client-message writer with big-endian length prefixes. */
class PgWriter {
  private pending: Uint8Array[] = []
  private wire: PostgresWire

  constructor(wire: PostgresWire) {
    this.wire = wire
  }

  /** Rebind to a new wire face (used once, when the TLS upgrade replaces the stream). */
  bind(wire: PostgresWire): void {
    this.wire = wire
  }

  /** Queue one framed message (type byte + length + payload) and flush. */
  frame(type: number, payload: Uint8Array): void {
    const head = Buffer.alloc(5)
    head.writeUInt8(type, 0)
    head.writeInt32BE(payload.length + 4, 1)
    this.pending.push(head, payload)
    this.flush()
  }

  /** Queue one raw bytestring (SSLRequest and StartupMessage carry no type byte) and flush. */
  raw(bytes: Uint8Array): void {
    this.pending.push(bytes)
    this.flush()
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const joined = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending)
    this.pending = []
    this.wire.write(joined)
  }
}

/** Cursor reader over one message payload: big-endian ints and NUL strings. */
class PayloadReader {
  private offset = 0

  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  /** Read one big-endian Int32 at the cursor and advance. */
  int32(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength).getInt32(this.offset)
    this.offset += 4
    return value
  }

  /** Read one big-endian Int16 at the cursor and advance. */
  int16(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength).getInt16(this.offset)
    this.offset += 2
    return value
  }

  /** Read one NUL-terminated UTF-8 string at the cursor and advance past the NUL. */
  cString(): string {
    let end = this.offset
    while (end < this.bytes.length && this.bytes[end] !== 0) end++
    const text = new TextDecoder().decode(this.bytes.subarray(this.offset, end))
    this.offset = end + 1
    return text
  }

  /** The cursor position (bytes consumed so far). */
  cursor(): number {
    return this.offset
  }

  /** The remaining payload bytes from the cursor. */
  rest(): Uint8Array {
    return this.bytes.subarray(this.offset)
  }
}

/** Fields of one ErrorResponse parsed to a bounded record. */
function parseErrorFields(payload: Uint8Array): { severity?: string; code?: string; message?: string } {
  const fields: { severity?: string; code?: string; message?: string } = {}
  let offset = 0
  while (offset < payload.length) {
    const fieldType = String.fromCharCode(payload[offset]!)
    offset += 1
    if (fieldType === '\0') break
    let end = offset
    while (end < payload.length && payload[end] !== 0) end++
    const value = new TextDecoder().decode(payload.subarray(offset, end))
    offset = end + 1
    if (fieldType === 'S') fields.severity = value
    else if (fieldType === 'C') fields.code = value
    else if (fieldType === 'M') fields.message = value
  }
  return fields
}

/** Named server refusal carrying SQLSTATE fields. */
class ServerRefusal extends Error {
  readonly fields: { severity?: string; code?: string; message?: string }

  constructor(fields: { severity?: string; code?: string; message?: string }) {
    super(fields.message ?? 'server refused')
    this.name = 'ServerRefusal'
    this.fields = fields
  }
}

/** Named protocol desync (framing or handshake order violations). */
class ProtocolDesync extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolDesync'
  }
}

/** Named connect timeout for outcome mapping. */
class ConnectTimeoutError extends Error {
  constructor() {
    super('connect timeout')
    this.name = 'ConnectTimeoutError'
  }
}

/** Describe an ErrorResponse for the report detail; bounded and code-first. */
function describeServerError(fields: { severity?: string; code?: string; message?: string }): string {
  const code = fields.code ?? 'unknown'
  return `server refused the exchange (SQLSTATE ${code}: ${bounded(fields.message ?? 'no message')})`
}

/**
 * Verify one PostGIS connection end to end and produce the report.
 * @param spec - the validated connection specification.
 * @param credentials - the resolved password, held in memory for this exchange only.
 * @param options - deadline, cancellation, clock, and transport overrides.
 * @returns the verification report; server-side answers are results, never throws.
 */
export async function verifyPostgres(spec: PostgresConnectionSpec, credentials: PostgresCredentials, options: PostgresVerifyOptions = {}): Promise<ConnectionVerification> {
  const now = options.now ?? defaultNowMs
  const startedAt = now()
  const factory = options.transport ?? createNodeTransport()
  const deadline = AbortSignal.any([AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(options.signal === undefined ? [] : [options.signal])])
  const finish = (outcome: ConnectionVerification['outcome'], detail: string, facts?: PostgresVerificationFacts): ConnectionVerification => ({
    connectionId: spec.id,
    kind: 'postgis',
    outcome,
    detail: sanitizeDetail(detail, [credentials.password]),
    latencyMs: Math.max(0, now() - startedAt),
    ...(facts === undefined ? {} : { facts }),
  })

  let transport: PostgresTransport | undefined
  try {
    transport = await factory.connect(spec.host, spec.port ?? 5432, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline)
    let reader = attachReader(transport.wire)
    const writer = new PgWriter(transport.wire)

    // --- TLS negotiation ---------------------------------------------------
    if (spec.ssl !== 'disable') {
      const request = Buffer.alloc(8)
      request.writeInt32BE(8, 0)
      request.writeInt32BE(PG_SSL_REQUEST_CODE, 4)
      writer.raw(request)
      // The SSL answer is one raw byte (S/N) outside the message framing.
      const answer = await withDeadline(reader.readExact(1), deadline, 'ssl-negotiation')
      if (answer[0] !== 0x53 /* S */ && answer[0] !== 0x4e /* N */) {
        return finish('protocol-violated', `server answered the SSLRequest with byte 0x${(answer[0] ?? 0).toString(16)}, expected S or N`)
      }
      if (answer[0] === 0x53) {
        const tlsTransport = await factory.startTls(transport, spec.host)
        reader = attachReader(tlsTransport.wire)
        writer.bind(tlsTransport.wire)
        transport = tlsTransport
      } else if (spec.ssl === 'require') {
        return finish('server-refused', 'server refused TLS (ssl=require); the connection stays unproven rather than falling back to cleartext')
      }
    }

    // --- Startup ------------------------------------------------------------
    const startupBody = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(PG_PROTOCOL_VERSION, 0); return b })(),
      Buffer.from(`user\0${spec.user}\0database\0${spec.database}\0client_encoding\0UTF8\0\0`, 'utf8'),
    ])
    const startupHead = Buffer.alloc(4)
    startupHead.writeInt32BE(startupBody.length + 4, 0)
    writer.raw(Buffer.concat([startupHead, startupBody]))

    // --- Authentication -------------------------------------------------------
    const parameters: { name: string; value: string }[] = []
    await authenticate(reader, writer, spec, credentials, deadline)

    // --- Post-auth startup messages until ReadyForQuery -----------------------
    for (;;) {
      deadline.throwIfAborted()
      const message = await withDeadline(reader.read(), deadline, 'startup')
      if (message.type === 0x53 /* ParameterStatus */) {
        const payload = new PayloadReader(message.payload)
        const name = payload.cString()
        const value = payload.cString()
        if (REPORTED_PARAMETERS.has(name) && parameters.length < MAX_REPORTED_PARAMETERS && value.length <= 100) {
          parameters.push({ name, value })
        }
      } else if (message.type === 0x5a /* ReadyForQuery */) {
        break
      } else if (message.type === 0x4e /* Notice */ || message.type === 0x4b /* BackendKeyData */ || message.type === 0x76 /* NegotiateProtocolVersion */) {
        continue
      } else if (message.type === 0x45 /* ErrorResponse */) {
        const fields = parseErrorFields(message.payload)
        return finish(outcomeForSqlState(fields.code ?? ''), describeServerError(fields))
      } else {
        return finish('protocol-violated', `unexpected message 0x${message.type.toString(16)} during startup`)
      }
    }

    // --- Version exchange ------------------------------------------------------
    writer.frame(0x51 /* Query */, Buffer.from('SELECT version()\0', 'utf8'))
    let serverVersion: string | undefined
    for (;;) {
      deadline.throwIfAborted()
      const message = await withDeadline(reader.read(), deadline, 'query')
      if (message.type === 0x54 /* RowDescription */ || message.type === 0x43 /* CommandComplete */) {
        continue
      }
      if (message.type === 0x44 /* DataRow */) {
        const payload = new PayloadReader(message.payload)
        const columnCount = payload.int16()
        if (columnCount >= 1 && serverVersion === undefined) {
          const fieldLength = payload.int32()
          if (fieldLength > 0) {
            serverVersion = bounded(new TextDecoder().decode(message.payload.subarray(payload.cursor(), payload.cursor() + fieldLength)))
          }
        }
      } else if (message.type === 0x5a /* ReadyForQuery */) {
        break
      } else if (message.type === 0x45 /* ErrorResponse */) {
        const fields = parseErrorFields(message.payload)
        return finish('server-refused', `the version query was refused (SQLSTATE ${fields.code ?? 'unknown'}: ${bounded(fields.message ?? 'no message')})`)
      } else {
        return finish('protocol-violated', `unexpected message 0x${message.type.toString(16)} during the version query`)
      }
    }

    writer.frame(0x58 /* Terminate */, new Uint8Array(0))
    transport.wire.destroy()
    const versionParameter = parameters.find(parameter => parameter.name === 'server_version')?.value
    return finish('connected', 'authenticated and the version exchange answered', {
      serverVersion: serverVersion ?? bounded(versionParameter ?? 'unknown (server sent no version string)'),
      parameters,
    })
  } catch (error: unknown) {
    return finish(...describeFailure(error, options.signal))
  } finally {
    // Every path — success (already destroyed after Terminate), server answer,
    // or failure — leaves no transport open.
    transport?.wire.destroy()
  }
}

/** Attach a fresh framing reader to one wire face. */
function attachReader(wire: PostgresWire): PgReader {
  const reader = new PgReader()
  wire.onError(error => reader.fail(error))
  wire.onClose(() => reader.fail(new Error('server closed the connection')))
  wire.onData(chunk => reader.push(chunk))
  return reader
}

/** Run the authentication sub-protocol; resolves on AuthenticationOk. */
async function authenticate(reader: PgReader, writer: PgWriter, spec: PostgresConnectionSpec, credentials: PostgresCredentials, deadline: AbortSignal): Promise<void> {
  for (;;) {
    deadline.throwIfAborted()
    const message = await withDeadline(reader.read(), deadline, 'authentication')
    if (message.type === 0x45 /* ErrorResponse */) {
      throw new ServerRefusal(parseErrorFields(message.payload))
    }
    if (message.type !== 0x52 /* Authentication */) {
      throw new ProtocolDesync(`unexpected message 0x${message.type.toString(16)} during authentication`)
    }
    const payload = new PayloadReader(message.payload)
    const subcode = payload.int32()
    if (subcode === 0) return
    if (subcode === 3) {
      writer.frame(0x70 /* PasswordMessage */, Buffer.from(`${credentials.password}\0`, 'utf8'))
      continue
    }
    if (subcode === 5) {
      const salt = message.payload.subarray(4, 8)
      if (salt.length !== 4) throw new ProtocolDesync('the MD5 auth request carries no 4-byte salt')
      writer.frame(0x70, Buffer.from(`${md5Password(credentials.password, spec.user, salt)}\0`, 'utf8'))
      continue
    }
    if (subcode === 10) {
      await scramHandshake(reader, writer, spec, credentials, payload, deadline)
      continue
    }
    throw new ServerRefusal({ code: '28000', message: `the server requested unsupported authentication subcode ${String(subcode)}` })
  }
}

/** The SCRAM-SHA-256 exchange (RFC 5802/7677, gs2 header `n,,` — no channel binding). */
async function scramHandshake(reader: PgReader, writer: PgWriter, spec: PostgresConnectionSpec, credentials: PostgresCredentials, payload: PayloadReader, deadline: AbortSignal): Promise<void> {
  const mechanisms = new TextDecoder().decode(payload.rest()).split('\0').filter(name => name.length > 0)
  if (!mechanisms.includes('SCRAM-SHA-256')) {
    throw new ServerRefusal({ code: '28000', message: `server offers only SCRAM mechanisms [${mechanisms.join(', ')}]; supported: SCRAM-SHA-256 without channel binding` })
  }
  const clientNonce = randomBytes(18).toString('base64')
  const clientFirstBare = `n=${saslEscape(spec.user)},r=${clientNonce}`
  const responseBytes = Buffer.from(`n,,${clientFirstBare}`, 'utf8')
  const initial = Buffer.concat([
    Buffer.from('SCRAM-SHA-256\0', 'utf8'),
    (() => { const b = Buffer.alloc(4); b.writeInt32BE(responseBytes.length, 0); return b })(),
    responseBytes,
  ])
  writer.frame(0x70 /* SASLInitialResponse */, initial)

  const continueMessage = await withDeadline(reader.read(), deadline, 'scram-continue')
  if (continueMessage.type === 0x45) throw new ServerRefusal(parseErrorFields(continueMessage.payload))
  if (continueMessage.type !== 0x52) throw new ProtocolDesync(`expected SASLContinue, got 0x${continueMessage.type.toString(16)}`)
  const continuePayload = new PayloadReader(continueMessage.payload)
  if (continuePayload.int32() !== 11) throw new ProtocolDesync('expected AuthenticationSASLContinue (11)')
  const serverFirst = new TextDecoder().decode(continuePayload.rest())
  const serverFirstMatch = /^r=([^,]+),s=([A-Za-z0-9+/=]+),i=(\d+)$/.exec(serverFirst)
  if (serverFirstMatch === null) throw new ProtocolDesync('the server-first-message does not parse as r/s/i')
  const combinedNonce = serverFirstMatch[1]!
  const iterations = Number(serverFirstMatch[3])
  if (!combinedNonce.startsWith(clientNonce)) throw new ProtocolDesync('the server nonce does not extend the client nonce')
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) {
    throw new ProtocolDesync(`the SCRAM iteration count ${serverFirstMatch[3]} is outside 1..${String(MAX_SCRAM_ITERATIONS)}`)
  }
  const salt = Buffer.from(serverFirstMatch[2]!, 'base64')

  const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`
  const saltedPassword = pbkdf2Sync(credentials.password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
  const clientProof = xorBytes(clientKey, clientSignature)
  writer.frame(0x70 /* SASLResponse */, Buffer.from(`${clientFinalWithoutProof},p=${Buffer.from(clientProof).toString('base64')}`, 'utf8'))

  const finalMessage = await withDeadline(reader.read(), deadline, 'scram-final')
  if (finalMessage.type === 0x45) throw new ServerRefusal(parseErrorFields(finalMessage.payload))
  if (finalMessage.type !== 0x52) throw new ProtocolDesync(`expected SASLFinal, got 0x${finalMessage.type.toString(16)}`)
  const finalPayload = new PayloadReader(finalMessage.payload)
  if (finalPayload.int32() !== 12) throw new ProtocolDesync('expected AuthenticationSASLFinal (12)')
  const serverFinal = new TextDecoder().decode(finalPayload.rest())
  const serverSignatureMatch = /^v=([A-Za-z0-9+/=]+)$/.exec(serverFinal)
  if (serverSignatureMatch === null) throw new ProtocolDesync('the server-final-message does not parse as v=')
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  const expectedSignature = createHmac('sha256', serverKey).update(authMessage).digest()
  if (serverSignatureMatch[1] !== expectedSignature.toString('base64')) {
    throw new ProtocolDesync('the ServerSignature does not verify (server identity not proven)')
  }
}

/** Fold one caught failure onto outcome + detail; caller abort outranks the deadline. */
function describeFailure(error: unknown, signal: AbortSignal | undefined): [ConnectionVerification['outcome'], string] {
  if (signal?.aborted === true) return ['aborted', 'verification aborted by the caller']
  if (error instanceof ServerRefusal) {
    const outcome = outcomeForSqlState(error.fields.code ?? '')
    return [outcome, describeServerError(error.fields)]
  }
  if (error instanceof ProtocolDesync) return ['protocol-violated', bounded(error.message)]
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return ['timeout', 'the verification deadline elapsed before the exchange completed']
    if (error.name === 'ConnectTimeoutError') return ['timeout', 'the TCP connect deadline elapsed']
    if (error.name === 'AbortError') return ['timeout', 'the verification deadline elapsed before the exchange completed']
    const unreachable = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|certificate|tls|EPROTO/i
    if (unreachable.test(error.message) || unreachable.test(error.name)) {
      return ['unreachable', `transport failure: ${bounded(error.message)}`]
    }
    return ['unreachable', `transport failure (${error.name}): ${bounded(error.message)}`]
  }
  return ['unreachable', 'unknown transport failure']
}

/** Race one read against the deadline so a silent server cannot wedge the check. */
function withDeadline<T>(pending: Promise<T>, signal: AbortSignal, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error(`${stage} deadline`))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** The real TCP/TLS transport over Node sockets. */
export function createNodeTransport(): PostgresTransportFactory {
  return {
    async connect(host, port, timeoutMs, signal) {
      const { connect } = await import('node:net')
      return await new Promise<PostgresTransport>((resolve, reject) => {
        let settled = false
        const socket = connect({ host, port })
        socket.setTimeout(timeoutMs)
        const fail = (error: Error): void => {
          if (settled) return
          settled = true
          socket.destroy()
          reject(error)
        }
        socket.once('connect', () => {
          if (settled) return
          settled = true
          socket.setTimeout(0)
          resolve({ wire: adaptSocket(socket), socket })
        })
        socket.once('timeout', () => fail(new ConnectTimeoutError()))
        socket.once('error', fail)
        signal?.addEventListener('abort', () => fail(signal.reason instanceof Error ? signal.reason : new Error('connect aborted')), { once: true })
      })
    },
    async startTls(transport, servername) {
      const { connect: tlsConnect } = await import('node:tls')
      const socket = tlsConnect({ socket: transport.socket, servername, rejectUnauthorized: true })
      return await new Promise<PostgresTransport>((resolve, reject) => {
        let settled = false
        socket.once('secureConnect', () => {
          settled = true
          resolve({ wire: adaptSocket(socket), socket })
        })
        socket.once('error', (error: Error) => {
          if (settled) return
          settled = true
          socket.destroy()
          reject(error)
        })
      })
    },
  }
}

/** Adapt a Node socket to the wire face (the client registers listeners after connect). */
function adaptSocket(socket: Net.Socket): PostgresWire {
  return {
    write(data) { socket.write(data) },
    onData(listener) { socket.on('data', (chunk: Buffer) => listener(chunk)) },
    onError(listener) { socket.on('error', listener) },
    onClose(listener) { socket.on('close', listener) },
    destroy() { socket.destroy() },
  }
}
