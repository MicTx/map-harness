/**
 * Keyless PostGIS lane: a scripted PostgreSQL v3 server drives the wire
 * client through every authentication family and failure mode — SCRAM-SHA-256
 * (with an independent server-side proof check and ServerSignature
 * verification, both cross-checked inside the fixture), MD5 (expected
 * response computed independently), cleartext, ErrorResponse mapping
 * (28P01/3D000/XX000), TLS negotiation outcomes for disable/prefer/require,
 * the version exchange, framing-violation detection, deadline, and caller
 * abort. No socket, no network: the transport factory is scripted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { verifyPostgres } from '../src/postgres.ts'

const SPEC = { id: 'db-main', host: 'db.example.org', database: 'gis', user: 'gis_ro', passwordEnv: 'PG_PW', ssl: 'disable' }
const PASSWORD = 'trustno1'

/** A scriptable wire: records writes, plays scripted answers, honors destroy. */
class ScriptedWire {
  writes = []
  destroyed = false
  dataListeners = []
  errorListeners = []
  closeListeners = []

  onData(listener) {
    this.dataListeners.push(listener)
  }

  onError(listener) {
    this.errorListeners.push(listener)
  }

  onClose(listener) {
    this.closeListeners.push(listener)
  }

  write(data) {
    this.writes.push(data)
  }

  destroy() {
    this.destroyed = true
    this.closeListeners.forEach(listener => listener(false))
  }

  /** Deliver one server chunk (scripted answer). */
  emit(chunk) {
    this.dataListeners.forEach(listener => listener(chunk))
  }
}

/** Frame one server message: type byte + Int32BE length + payload. */
function frame(type, payload = new Uint8Array(0)) {
  const head = Buffer.alloc(5)
  head.writeUInt8(type.charCodeAt(0), 0)
  head.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([head, payload])
}

/** Build an Authentication message with one Int32BE subcode + trailing bytes. */
function auth(subcode, trailing = new Uint8Array(0)) {
  const code = Buffer.alloc(4)
  code.writeInt32BE(subcode, 0)
  return frame('R', Buffer.concat([code, trailing]))
}

/** ParameterStatus frame. */
function paramStatus(name, value) {
  return frame('S', Buffer.from(`${name}\0${value}\0`, 'utf8'))
}

/** ErrorResponse frame from SQLSTATE fields. */
function errorResponse(code, message) {
  return frame('E', Buffer.from(`SFATAL\0C${code}\0M${message}\0\0`, 'utf8'))
}

/** The post-auth startup tail: parameters + BackendKeyData + ReadyForQuery. */
function readyForQuery(withVersion = true) {
  return [
    ...(withVersion ? [paramStatus('server_version', '16.4 (Debian)'), paramStatus('server_encoding', 'UTF8'), paramStatus('TimeZone', 'UTC')] : []),
    frame('K', (() => { const b = Buffer.alloc(8); b.writeInt32BE(1234, 0); b.writeInt32BE(5678, 4); return b })()),
    frame('Z', Buffer.from('I', 'utf8')),
  ]
}

/** The Query answer for `SELECT version()`. */
function versionAnswer() {
  const versionText = Buffer.from('PostgreSQL 16.4 on x86_64', 'utf8')
  const rowDescription = frame('T', Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(1, 0); return b })(),
    Buffer.from('version\0', 'utf8'),
    (() => { const b = Buffer.alloc(18); b.writeUInt32BE(0, 0); b.writeInt16BE(0, 4); b.writeInt32BE(-1, 6); b.writeInt16BE(0, 10); b.writeUInt32BE(0, 12); b.writeInt16BE(0, 16); return b })(),
  ]))
  const dataRow = frame('D', Buffer.concat([
    (() => { const b = Buffer.alloc(6); b.writeInt16BE(1, 0); b.writeInt32BE(versionText.length, 2); return b })(),
    versionText,
  ]))
  return [rowDescription, dataRow, frame('C', Buffer.from('SELECT 1\0', 'utf8')), frame('Z', Buffer.from('I', 'utf8'))]
}

/** Concatenated client writes so far, for marker assertions. */
function writesText(wire) {
  return Buffer.concat(wire.writes).toString('latin1')
}

// Polls are bounded: an orphaned script must never pin the event loop when a
// client times out mid-exchange.
const POLL_BUDGET = 600

/** Marker wait: react once the client wrote a given ASCII marker. */
async function answerOnce(wire, marker, frames) {
  for (let poll = 0; poll < POLL_BUDGET; poll++) {
    if (writesText(wire).includes(marker)) {
      wire.emit(Buffer.concat(frames))
      return
    }
    if (wire.destroyed) throw new Error(`client destroyed before writing ${marker}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`script budget exhausted waiting for ${marker}`)
}

/** React once the client wrote a byte sequence after a given prefix marker. */
async function answerOnBytes(wire, markerBytes, react) {
  for (let poll = 0; poll < POLL_BUDGET; poll++) {
    const writes = Buffer.concat(wire.writes)
    const index = writes.indexOf(markerBytes)
    if (index >= 0) {
      await react(writes, index)
      return
    }
    if (wire.destroyed) throw new Error(`client destroyed before writing ${markerBytes.toString()}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`script budget exhausted waiting for ${markerBytes.toString()}`)
}

/** Answer after the client's first write: the SSLRequest handshake answer. */
async function answerAfterFirstWrite(wire, frames) {
  for (let poll = 0; poll < POLL_BUDGET; poll++) {
    if (wire.writes.length > 0) {
      wire.emit(Buffer.concat(frames))
      return
    }
    if (wire.destroyed) throw new Error('client destroyed before its first write')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('script budget exhausted waiting for the first write')
}

/** Sleep so the event loop can advance (scripted waits). */
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * Build a scripted transport factory; `script` receives the plain wire,
 * `options.tlsScript` the upgraded one.
 */
function scriptedFactory(script, options = {}) {
  return {
    async connect() {
      if (options.failConnect !== undefined) throw options.failConnect
      const wire = new ScriptedWire()
      void script(wire).catch(error => { process.emitWarning(`scripted server error: ${String(error.message)}`) })
      return { wire, socket: {} }
    },
    async startTls(transport) {
      const wire = new ScriptedWire()
      void options.tlsScript?.(wire).catch(error => { process.emitWarning(`scripted tls server error: ${String(error.message)}`) })
      return { wire, socket: transport.socket }
    },
  }
}

test('SCRAM-SHA-256: the full exchange authenticates and the version is reported', async () => {
  const salt = Buffer.from('0123456789abcdef', 'hex')
  const iterations = 4096
  let sawProof = ''
  let firstBareSeen = ''
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8'))])
    // Client-first arrives inside a 'p' frame; derive the server-first from its nonce.
    // The bare message is captured here, before the client's next write can follow it.
    await answerOnBytes(wire, Buffer.from('n,,n='), async (writes) => {
      firstBareSeen = writes.subarray(writes.indexOf(Buffer.from('n,,', 'utf8')) + 3).toString('utf8').split('\0')[0]
      const nonce = /r=([^,]+)/.exec(firstBareSeen)?.[1] ?? ''
      wire.emit(auth(11, Buffer.from(`r=${nonce}serverside,s=${salt.toString('base64')},i=${iterations}`, 'utf8')))
    })
    // Client-final: verify the proof with an independent SCRAM implementation.
    await answerOnBytes(wire, Buffer.from('c=biws,r='), async (writes) => {
      const all = writes.toString('utf8')
      const clientFinal = all.slice(all.indexOf('c=biws,r=')).split('\0')[0]
      sawProof = /p=([A-Za-z0-9+/=]+)/.exec(clientFinal)?.[1] ?? ''
      const combinedNonce = /r=([^,]+)/.exec(clientFinal)?.[1] ?? ''
      const serverFirst = `r=${combinedNonce},s=${salt.toString('base64')},i=${iterations}`
      const finalBare = clientFinal.slice(0, clientFinal.indexOf(',p='))
      const authMessage = `${firstBareSeen},${serverFirst},${finalBare}`
      const salted = pbkdf2Sync(PASSWORD, salt, iterations, 32, 'sha256')
      const clientKey = createHmac('sha256', salted).update('Client Key').digest()
      const storedKey = createHash('sha256').update(clientKey).digest()
      const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
      const expectedProof = Buffer.alloc(32)
      for (let i = 0; i < 32; i++) expectedProof[i] = clientKey[i] ^ clientSignature[i]
      assert.equal(sawProof, expectedProof.toString('base64'), 'client proof matches the independent SCRAM computation')
      const serverKey = createHmac('sha256', salted).update('Server Key').digest()
      const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest()
      // SASLFinal, then AuthenticationOk and the startup tail, as a real server sends.
      wire.emit(Buffer.concat([auth(12, Buffer.from(`v=${serverSignature.toString('base64')}`, 'utf8')), auth(0), ...readyForQuery()]))
    })
    await answerOnce(wire, 'SELECT version()', versionAnswer())
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'connected')
  assert.equal(report.connectionId, 'db-main')
  assert.equal(report.kind, 'postgis')
  assert.equal(report.latencyMs, 0)
  const facts = report.facts
  assert.ok(facts !== undefined && 'serverVersion' in facts)
  assert.match(facts.serverVersion, /PostgreSQL 16\.4/)
  assert.ok((facts.parameters ?? []).some(parameter => parameter.name === 'server_version'))
  assert.equal(report.detail.includes(PASSWORD), false)
})

test('SCRAM-SHA-256: a wrong ServerSignature is a protocol violation, never a pass', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8'))])
    await answerOnBytes(wire, Buffer.from('n,,n='), async (writes, index) => {
      const nonce = /r=([^,]+)/.exec(writes.subarray(index + 3).toString('utf8'))?.[1] ?? ''
      wire.emit(auth(11, Buffer.from(`r=${nonce}x,s=${Buffer.from('00', 'hex').toString('base64')},i=4096`, 'utf8')))
    })
    await answerOnce(wire, 'c=biws', [auth(12, Buffer.from('v=Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8=', 'utf8'))])
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
  assert.match(report.detail, /ServerSignature/)
})

test('MD5: the client response matches an independent md5 computation', async () => {
  const salt = Buffer.from('abcd', 'latin1')
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(5, salt)])
    for (let poll = 0; poll < POLL_BUDGET; poll++) {
      const text = writesText(wire)
      if (text.includes('md5')) {
        const inner = createHash('md5').update(`${PASSWORD}gis_ro`).digest('hex')
        const expected = `md5${createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex')}`
        assert.ok(text.includes(expected), `client sent ${text.slice(0, 80)}; expected ${expected}`)
        wire.emit(Buffer.concat([auth(0), ...readyForQuery()]))
        break
      }
      if (wire.destroyed) throw new Error('client destroyed before the md5 response')
      await tick()
    }
    await answerOnce(wire, 'SELECT version()', versionAnswer())
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'connected')
})

test('cleartext password authenticates', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(3)])
    await answerOnce(wire, PASSWORD, [auth(0), ...readyForQuery()])
    await answerOnce(wire, 'SELECT version()', versionAnswer())
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'connected')
})

test('ErrorResponse SQLSTATEs map onto the outcome vocabulary', async () => {
  const cases = [
    ['28P01', 'password authentication failed', 'auth-rejected'],
    ['28000', 'no pg_hba.conf entry', 'auth-rejected'],
    ['3D000', 'database "gis" does not exist', 'not-found'],
    ['53300', 'too many connections', 'server-refused'],
  ]
  for (const [code, message, outcome] of cases) {
    const factory = scriptedFactory(async wire => {
      await answerOnce(wire, 'client_encoding', [errorResponse(code, message)])
    })
    const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
    assert.equal(report.outcome, outcome, code)
    assert.match(report.detail, new RegExp(code))
  }
})

test('ssl=require with a server refusing TLS stays unproven instead of degrading', async () => {
  const factory = scriptedFactory(async wire => {
    await answerAfterFirstWrite(wire, [Buffer.from('N', 'latin1')])
  })
  const report = await verifyPostgres({ ...SPEC, ssl: 'require' }, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'server-refused')
  assert.match(report.detail, /refused TLS/)
})

test('ssl=prefer upgrades on S and completes the exchange over the TLS wire', async () => {
  let tlsWire = null
  const factory = scriptedFactory(async plain => {
    await answerAfterFirstWrite(plain, [Buffer.from('S', 'latin1')])
  }, {
    tlsScript: async tls => {
      tlsWire = tls
      await answerOnce(tls, 'client_encoding', [auth(0), ...readyForQuery()])
      await answerOnce(tls, 'SELECT version()', versionAnswer())
      await tick()
    },
  })
  const report = await verifyPostgres({ ...SPEC, ssl: 'prefer' }, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  let tlsSawQuery = false
  for (let poll = 0; poll < POLL_BUDGET; poll++) {
    if (tlsWire !== null && writesText(tlsWire).includes('SELECT version()')) {
      tlsSawQuery = true
      break
    }
    await tick()
  }
  assert.ok(tlsSawQuery, 'the version query ran on the upgraded wire')
})

test('a framing violation is detected, never guessed past', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [Buffer.from([0x52, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00])])
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
  assert.match(report.detail, /frame length/)
})

test('connect failures map to unreachable without leaking the password', async () => {
  const factory = scriptedFactory(async () => {}, { failConnect: Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }) })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'unreachable')
  assert.match(report.detail, /ECONNREFUSED/)
  assert.equal(report.detail.includes(PASSWORD), false)
})

test('a silent server hits the deadline and reports timeout', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [])
  })
  const report = await verifyPostgres({ ...SPEC, timeoutMs: 1000 }, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'timeout')
})

test('caller abort during a silent stretch reports aborted', async () => {
  const controller = new AbortController()
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [])
  })
  setTimeout(() => controller.abort(), 60)
  const report = await verifyPostgres({ ...SPEC, timeoutMs: 5000 }, { password: PASSWORD }, { transport: factory, signal: controller.signal, now: () => 0 })
  assert.equal(report.outcome, 'aborted')
  assert.match(report.detail, /aborted/)
})

test('an ErrorResponse during the version query is a server refusal, not a connected pass', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(0), ...readyForQuery()])
    await answerOnce(wire, 'SELECT version()', [errorResponse('42501', 'permission denied for function version()')])
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'server-refused')
  assert.match(report.detail, /42501/)
})

test('the exchange terminates cleanly: Terminate is written last', async () => {
  let wireSeen = null
  const factory = scriptedFactory(async wire => {
    wireSeen = wire
    await answerOnce(wire, 'client_encoding', [auth(0), ...readyForQuery()])
    await answerOnce(wire, 'SELECT version()', versionAnswer())
    await tick()
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'connected')
  // The Terminate frame is the client's final write; poll so the check does
  // not race the script's own observation.
  let lastByte = 0
  for (let poll = 0; poll < POLL_BUDGET; poll++) {
    const joined = Buffer.concat(wireSeen.writes)
    lastByte = joined.subarray(-5)[0] ?? 0
    if (lastByte === 0x58) break
    await tick()
  }
  assert.equal(lastByte, 0x58, 'the client sent Terminate as its final frame')
})

test('unexpected message order during authentication is a protocol violation', async () => {
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [frame('Z', Buffer.from('I', 'utf8'))])
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
})

test('unsupported authentication families fail loud as auth-rejected', async () => {
  // Subcode 7 is GSSAPI: an authentication family the connector does not implement.
  const factory = scriptedFactory(async wire => {
    await answerOnce(wire, 'client_encoding', [auth(7)])
  })
  const report = await verifyPostgres(SPEC, { password: PASSWORD }, { transport: factory, now: () => 0 })
  assert.equal(report.outcome, 'auth-rejected')
  assert.match(report.detail, /unsupported authentication subcode 7/)
})
