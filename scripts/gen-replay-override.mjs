#!/usr/bin/env node
/**
 * Regenerate a scenario's `replay.override.json` from its selected session
 * fixture. Scripted entries whose tool-call arguments echo `{{workflow:N}}`
 * tokens cannot execute literally, so the sidecar re-spells them with
 * `{{fromRequest:...}}` bindings that resolve the live-minted id from the
 * run-submit result carrying the same request digest. Digests are
 * request-derived and stable across recordings, so one regeneration per
 * re-record keeps the sidecar in lockstep with the fixture.
 *
 * Usage: node scripts/gen-replay-override.mjs snapshots/session/<scenario>
 * Writes replay.override.json when any entry needs a binding; removes a stale
 * sidecar when none does. Review the diff before committing.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scenarioDir = process.argv[2]
if (scenarioDir === undefined) {
  process.stderr.write('usage: node scripts/gen-replay-override.mjs snapshots/session/<scenario>\n')
  process.exit(2)
}

/** Select the highest session fixture generation, mirroring the harness rule. */
const fixture = readdirSync(scenarioDir)
  .map(name => /^session(?:\.v([1-9]\d*))?\.jsonl$/.exec(name))
  .filter(match => match !== null)
  .sort((left, right) => Number(right[1] ?? 0) - Number(left[1] ?? 0))[0]
if (fixture === undefined) throw new Error(`no session fixture under ${scenarioDir}`)
const fixturePath = join(scenarioDir, fixture[0])

const rows = readFileSync(fixturePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))

/** run_id token ordinal → request digest, from run-bearing tool results. */
const digestByOrdinal = new Map()
for (const row of rows) {
  if (row.type !== 'tool/result') continue
  const text = row.data?.message?.content?.[0]?.text
  if (typeof text !== 'string') continue
  let decoded
  try {
    decoded = JSON.parse(text)
  } catch {
    continue
  }
  const runId = typeof decoded.run_id === 'string' ? decoded.run_id : undefined
  const digest = typeof decoded.request_digest === 'string' ? decoded.request_digest : undefined
  if (runId === undefined || digest === undefined) continue
  const ordinal = /^\{\{workflow:([1-9]\d*)\}\}$/.exec(runId)?.[1]
  if (ordinal !== undefined) digestByOrdinal.set(ordinal, digest)
}

const TOKEN_RE = /\{\{workflow:([1-9]\d*)\}\}/g
const TOKEN_TEST_RE = /\{\{workflow:[1-9]\d*\}\}/
const bindingFor = ordinal => {
  const digest = digestByOrdinal.get(ordinal)
  if (digest === undefined) throw new Error(`workflow:${ordinal} has no request digest to bind; the recording must carry its run-submit result`)
  return `{{fromRequest:"run_id":"(run-[a-f0-9-]+)"[^\\n]*?"request_digest":"${digest}"}}`
}

const assistants = rows.filter(row => row.type === 'assistant/message')
const patches = []
assistants.forEach((row, index) => {
  const message = row.data?.message
  const stream = Array.isArray(row.data?.stream) ? row.data.stream : []
  const calls = Array.isArray(message?.content)
    ? message.content.filter(block => block?.type === 'tool-call' && TOKEN_TEST_RE.test(block.arguments ?? ''))
    : []
  if (calls.length === 0) return
  let usage
  let finishInner
  for (const member of stream) {
    if (member?.type === 'usage') usage = member.usage
    else if (member?.type === 'chunk' && member.chunk?.type === 'usage') usage = member.chunk.usage
    else if (member?.type === 'chunk' && member.chunk?.type === 'finish') finishInner = member.chunk
  }
  const chunks = []
  calls.forEach((call, callIndex) => {
    const boundArguments = call.arguments.replace(TOKEN_RE, (_match, ordinal) => bindingFor(ordinal))
    chunks.push({ type: 'block-start', index: callIndex, blockType: 'tool-call' })
    // The name-bearing empty delta opens one packed run; the payload delta
    // omits name so the accumulator opens a second run, matching the recorded
    // two-row stream shape.
    chunks.push({ type: 'tool-call-delta', index: callIndex, id: call.id, name: call.name, argumentsDelta: '' })
    chunks.push({ type: 'tool-call-delta', index: callIndex, id: call.id, argumentsDelta: boundArguments })
    chunks.push({ type: 'block-end', index: callIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: boundArguments } })
  })
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  if (finishInner !== undefined) {
    const finish = { type: 'finish', reason: finishInner.reason }
    if (finishInner.replayState !== undefined) finish.replayState = finishInner.replayState
    chunks.push(finish)
  }
  patches.push({ at: index, entry: { kind: 'chunks', chunks } })
})

const overridePath = join(scenarioDir, 'replay.override.json')
if (patches.length === 0) {
  try {
    rmSync(overridePath)
    process.stdout.write(`${scenarioDir}: no workflow-echoing entries; removed the stale sidecar\n`)
  } catch {
    process.stdout.write(`${scenarioDir}: no workflow-echoing entries and no sidecar present\n`)
  }
} else {
  writeFileSync(overridePath, `${JSON.stringify({ patches }, null, 2)}\n`)
  process.stdout.write(`${scenarioDir}: wrote ${patches.length} patch(es) over ${fixture[0]} (bindings: ${[...digestByOrdinal.keys()].sort().map(ordinal => `workflow:${ordinal}`).join(', ')})\n`)
}
