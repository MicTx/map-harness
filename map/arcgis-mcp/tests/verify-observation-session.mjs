/**
 * Lead-owned replay check over the app's actual durable Session, not fabricated
 * tool events. It checks map recovery without touching tiles, models or storage.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSessionLog } from '../../../packages/test-support/llm-replay/lib/index.js'
import { mapContainerProjectionDefinition } from '../../map-container/src/projection.ts'
import { mapProjectionStateSchema } from '../../map-container/src/protocol.ts'
import { mapObservationRecordSchema } from '../../map-container/src/observation-protocol.ts'

const [input, output] = process.argv.slice(2)
assert.ok(input && output, 'Usage: node --experimental-strip-types verify-observation-session.mjs <session.jsonl> <verification.json>')
const raw = readFileSync(resolve(input), 'utf8')
const events = parseSessionLog(raw)
const observations = events.flatMap((event, index) => {
  if (event.type !== 'tool/result' || event.data.meta?.kind !== 'map-observation') return []
  assert.equal(event.data.meta.schemaVersion, 1)
  const record = mapObservationRecordSchema.parse(event.data.meta.record)
  const message = event.data.message
  assert.equal(message.role, 'tool')
  assert.equal(message.toolCallId, record.callId)
  assert.equal(message.source.kind, 'tool')
  assert.equal(message.source.callId, record.callId)
  assert.notEqual(message.isError, true)
  const image = message.content.find(value => value.type === 'image')
  assert.ok(image?.attachment, 'the native tool result retains the saved image')
  for (const key of ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name']) {
    assert.equal(image.attachment[key], record.attachment[key], `saved image ${key} matches its observation`)
  }
  return [{ index, record }]
})
assert.equal(observations.length, 2, 'the durable Session retains both accepted observations')
assert.deepEqual(observations.map(({ record }) => [record.callId, record.mapRevision]), [
  ['obs-base', 0],
  ['obs-labelled', 2],
])
for (const { record } of observations) {
  const paired = events.find(event => event.seq === record.requestSeq)
  assert.equal(paired?.type, 'tool/call')
  assert.equal(paired.data.callId, record.callId)
  assert.equal(paired.data.name, 'map_observe')
  assert.equal(record.attachment.mediaType, 'image/png')
  assert.equal(record.sources[0].id, 'esri-world-imagery')
}

const fold = (source, initial = mapContainerProjectionDefinition.init()) =>
  source.reduce((state, event) => mapContainerProjectionDefinition.apply(state, event), initial)
const full = mapProjectionStateSchema.parse(fold(events))
assert.equal(full.revision, 2)
assert.equal(full.layers.length, 1)
assert.equal(full.observationRequest, null)
assert.deepEqual(full.latestObservation, observations[1].record)

// Include the first accepted evidence and the second still-pending observation.
const cuts = [0, observations[0].index + 1, observations[1].index, events.length]
for (const cut of cuts) {
  const checkpoint = mapProjectionStateSchema.parse(JSON.parse(JSON.stringify(fold(events.slice(0, cut)))))
  const restored = fold(events.slice(cut), checkpoint)
  assert.deepEqual(restored, full, `checkpoint at event index ${cut} matches full replay`)
}

const result = {
  schemaVersion: 1,
  status: 'passed',
  sessionSha256: createHash('sha256').update(raw).digest('hex'),
  verifierSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  checkpointCuts: cuts,
  observations: observations.map(({ record }) => ({
    callId: record.callId,
    mapRevision: record.mapRevision,
    observationId: record.observationId,
    pngSha256: record.attachment.sha256,
  })),
  finalRevision: full.revision,
  finalLayerCount: full.layers.length,
}
writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
