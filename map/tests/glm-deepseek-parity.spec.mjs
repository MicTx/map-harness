/**
 * GLM-gateway vs official DeepSeek recorded-corpus parity gate: a read-only
 * structural comparison over the two committed transcript corpora — the
 * upstream DeepSeek recordings under `snapshots/session/` and the GLM gateway
 * recording `snapshots/session/map-analyst-turn` — asserting both sides
 * satisfy the same structural invariants of the harness StreamChunk/Session
 * contract (chunk order, finish vocabulary, tool-call compliance and pairing,
 * disjoint usage accounting, reasoning-block ordering). The measured numbers
 * back the equivalence argument in `map/docs/verification-matrix.md`; this
 * gate re-computes them on every run so a re-recorded corpus cannot silently
 * lose the evidence. Nothing here writes to the corpora.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sessionRoot = join(repoRoot, 'snapshots', 'session')
const GLM_SCENARIO = 'map-analyst-turn'

/** The harness FinishReason kinds the wire finish vocabulary may ever map to. */
const FINISH_VOCABULARY = new Set(['stop', 'tool-calls', 'max-tokens', 'error'])

/** Latest-generation session fixture paths of one scenario directory (one per role). */
function latestSessionFiles(dir) {
  const byRole = new Map()
  for (const entry of readdirSync(dir)) {
    const match = entry.match(/^(session(?:\.\d+)?)(?:\.v(\d+))?\.jsonl$/)
    if (match === null) continue
    const version = match[2] === undefined ? 0 : Number(match[2])
    const current = byRole.get(match[1])
    if (current === undefined || version > current.version) byRole.set(match[1], { file: join(dir, entry), version })
  }
  return [...byRole.values()].map(role => role.file).sort()
}

/** Whether a scenario manifest declares itself a hand-authored fixture. */
function isAuthored(dir) {
  const manifest = join(dir, 'snapshot.yml')
  if (!existsSync(manifest)) return false
  return /^recording:\s*authored\s*$/m.test(readFileSync(manifest, 'utf8'))
}

/** Parse one session log into rows; a torn line fails loud. */
function rowsOf(content) {
  return content.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/** Structural metrics of one session log, per the shared invariants. */
function analyze(rows) {
  const m = {
    sessions: 0,
    assistant: 0,
    withStream: 0,
    orderOk: 0,
    orderBad: 0,
    reasoningMessages: 0,
    bothKinds: 0,
    reasoningFirst: 0,
    toolCallBlocks: 0,
    identityOk: 0,
    argumentsJsonOk: 0,
    calls: 0,
    results: 0,
    paired: 0,
    usageRows: 0,
    usagePositive: 0,
    cacheReadReported: 0,
    reasoningTokensReported: 0,
    totalReported: 0,
    totalConsistent: 0,
    finishKinds: {},
    turnReasons: {},
    orderViolations: [],
    finishVocabularyViolations: [],
  }
  const callIds = new Map()
  const resultIds = new Map()
  const bump = (map, id) => map.set(id, (map.get(id) ?? 0) + 1)
  for (const row of rows) {
    const data = row.data ?? {}
    if (row.type === 'session') m.sessions += 1
    else if (row.type === 'tool/call') { m.calls += 1; bump(callIds, data.callId) }
    else if (row.type === 'tool/result') {
      // v4 upstream logs carry the result call id on the message envelope;
      // older map fixtures keep the nested `tool-result` content block.
      if (typeof data.message?.toolCallId === 'string') {
        m.results += 1
        bump(resultIds, data.message.toolCallId)
      } else {
        for (const block of data.message?.content ?? []) {
          if (block.type === 'tool-result') { m.results += 1; bump(resultIds, block.toolCallId) }
        }
      }
    } else if (row.type === 'turn/end') {
      const kind = data.reason?.kind ?? 'unknown'
      m.turnReasons[kind] = (m.turnReasons[kind] ?? 0) + 1
    } else if (row.type === 'assistant/message') {
      m.assistant += 1
      const content = data.message?.content ?? []
      const reasoning = content.filter(b => b.type === 'reasoning' && b.text)
      const text = content.filter(b => b.type === 'text' && b.text)
      if (reasoning.length > 0) m.reasoningMessages += 1
      if (reasoning.length > 0 && text.length > 0) {
        m.bothKinds += 1
        if (content.indexOf(reasoning[0]) < content.indexOf(text[0])) m.reasoningFirst += 1
      }
      for (const block of content) {
        if (block.type !== 'tool-call') continue
        m.toolCallBlocks += 1
        if (block.id && block.name) m.identityOk += 1
        try {
          if (typeof JSON.parse(block.arguments) === 'object' && JSON.parse(block.arguments) !== null) {
            m.argumentsJsonOk += 1
          }
        } catch { /* counted as invalid below by the totals delta */ }
      }
      const stream = data.stream
      if (stream !== undefined && stream !== null) {
        m.withStream += 1
        const started = new Set()
        let finishIndex
        let usageIndex
        let lastPayloadIndex
        let finishes = 0
        let ok = true
        for (const [index, entry] of stream.entries()) {
          const chunk = entry.chunk
          if (chunk === undefined) { lastPayloadIndex = index; continue }
          if (chunk.type === 'block-start') started.add(chunk.index)
          else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            if (!started.has(chunk.index)) ok = false
            lastPayloadIndex = index
          } else if (chunk.type === 'usage') usageIndex = index
          else if (chunk.type === 'finish') {
            finishes += 1
            if (finishIndex === undefined) finishIndex = index
            const kind = chunk.reason?.kind
            m.finishKinds[kind] = (m.finishKinds[kind] ?? 0) + 1
            if (!FINISH_VOCABULARY.has(kind)) m.finishVocabularyViolations.push(kind)
          }
        }
        if (ok && finishes === 1
          && (usageIndex === undefined || usageIndex < finishIndex)
          && (lastPayloadIndex === undefined || lastPayloadIndex < finishIndex)) m.orderOk += 1
        else m.orderBad += 1
      }
      const usage = data.usage
      if (typeof usage === 'object' && usage !== null) {
        m.usageRows += 1
        if (usage.inputTokens > 0 && usage.outputTokens > 0) m.usagePositive += 1
        if (usage.cacheReadTokens !== undefined) m.cacheReadReported += 1
        if (usage.reasoningTokens !== undefined) m.reasoningTokensReported += 1
        if (usage.totalTokens !== undefined) {
          m.totalReported += 1
          const sum = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          if (usage.totalTokens === sum && usage.totalTokens >= usage.outputTokens) m.totalConsistent += 1
        }
      }
    }
  }
  for (const [id, calls] of callIds) m.paired += Math.min(calls, resultIds.get(id) ?? 0)
  return m
}

/** Aggregate one corpus (a list of session-log contents) into summed metrics. */
function aggregate(logs) {
  const total = analyze([])
  for (const log of logs) {
    const m = analyze(rowsOf(log))
    for (const key of Object.keys(m)) {
      const value = m[key]
      if (typeof value === 'number') total[key] += value
      else if (Array.isArray(value)) total[key] = [...total[key], ...value]
      else if (typeof value === 'object' && value !== null) {
        for (const [k, n] of Object.entries(value)) total[key][k] = (total[key][k] ?? 0) + n
      }
    }
  }
  return total
}

/** Read the two corpora: the GLM recording and every other scenario fixture, split by live/authored. */
function readCorpora() {
  const glmLogs = []
  const upstreamLive = []
  const upstreamAuthored = []
  for (const entry of readdirSync(sessionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionRoot, entry.name)
    if (!existsSync(join(dir, 'snapshot.yml'))) continue
    const logs = latestSessionFiles(dir).map(file => readFileSync(file, 'utf8'))
    if (logs.length === 0) continue
    if (entry.name === GLM_SCENARIO) glmLogs.push(...logs)
    else if (isAuthored(dir)) upstreamAuthored.push(...logs)
    else upstreamLive.push(...logs)
  }
  return { glm: aggregate(glmLogs), upstreamLive: aggregate(upstreamLive), upstreamAuthored: aggregate(upstreamAuthored) }
}

const corpora = readCorpora()

/** Assert the invariants that hold for real provider output on both sides of the comparison. */
function assertProviderInvariants(label, m) {
  assert.ok(m.assistant > 0, `${label}: corpus carries assistant messages`)
  assert.equal(m.orderBad, 0, `${label}: every embedded stream keeps protocol order`)
  assert.equal(m.orderOk, m.withStream, `${label}: every embedded stream is checked`)
  assert.equal(m.identityOk, m.toolCallBlocks, `${label}: every tool-call block carries non-empty id and name`)
  assert.equal(m.argumentsJsonOk, m.toolCallBlocks, `${label}: every tool-call block carries a JSON-object payload`)
  assert.equal(m.paired, m.calls, `${label}: every tool call has exactly one result`)
  assert.equal(m.results, m.calls, `${label}: no unpaired tool results`)
  assert.deepEqual(m.finishVocabularyViolations, [], `${label}: finish kinds stay in the documented vocabulary`)
  assert.equal(m.usagePositive, m.usageRows, `${label}: usage rows carry positive disjoint input/output counts`)
  assert.equal(m.totalConsistent, m.totalReported, `${label}: reported totals match the disjoint sum`)
  assert.equal(m.reasoningFirst, m.bothKinds, `${label}: reasoning precedes text when a message carries both`)
}

test('the GLM gateway recording satisfies the shared structural contract', () => {
  const glm = corpora.glm
  assertProviderInvariants('glm', glm)
  // The recording must keep carrying tool-chain and thinking evidence.
  assert.ok(glm.toolCallBlocks >= 1, 'glm: recorded tool-call evidence present')
  assert.ok(glm.reasoningMessages >= 1, 'glm: recorded reasoning evidence present')
  assert.ok(glm.cacheReadReported >= 1, 'glm: gateway cache accounting present')
  assert.ok(glm.reasoningTokensReported >= 1, 'glm: gateway reasoning-token accounting present')
})

test('the upstream DeepSeek live recordings satisfy the same structural contract', () => {
  assertProviderInvariants('upstream-live', corpora.upstreamLive)
})

test('authored fixtures keep the structural invariants their negative tests do not target', () => {
  const authored = corpora.upstreamAuthored
  assert.equal(authored.paired, authored.calls, 'authored: call/result pairing holds')
  assert.deepEqual(authored.finishVocabularyViolations, [], 'authored: finish vocabulary holds')
})

test('the measured parity numbers are printed for the equivalence argument', () => {
  const summary = {}
  for (const [label, m] of [['glm', corpora.glm], ['upstream-live', corpora.upstreamLive], ['upstream-authored', corpora.upstreamAuthored]]) {
    summary[label] = {
      assistantMessages: m.assistant,
      embeddedStreams: m.withStream,
      orderOk: m.orderOk,
      toolCallBlocks: m.toolCallBlocks,
      argumentsJsonOk: m.argumentsJsonOk,
      pairedCalls: `${m.paired}/${m.calls}`,
      usageRows: m.usageRows,
      cacheReadReported: m.cacheReadReported,
      reasoningTokensReported: m.reasoningTokensReported,
      totalsConsistent: `${m.totalConsistent}/${m.totalReported}`,
      finishKinds: m.finishKinds,
      turnReasons: m.turnReasons,
      reasoningMessages: m.reasoningMessages,
      reasoningFirst: `${m.reasoningFirst}/${m.bothKinds}`,
    }
  }
  console.log(`glm-deepseek-parity metrics: ${JSON.stringify(summary)}`)
  assert.ok(summary.glm.assistantMessages > 0 && summary['upstream-live'].assistantMessages > 0)
})
