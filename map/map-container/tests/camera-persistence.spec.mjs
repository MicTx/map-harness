import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelChangeSubmit } from '../src/client/change-submit.ts'

test('a settled camera record posts one set-view user change', async () => {
  const calls = []
  const submit = createPanelChangeSubmit(async (_url, init) => {
    calls.push(JSON.parse(init.body))
    return Response.json({ ok: true, revision: 3 })
  })
  const outcome = await submit({
    sessionId: 's1',
    revision: 2,
    summary: '用户调整了地图视图',
    change: { op: 'set-view', view: { center: [121.47, 31.23], zoom: 12, wkid: 4326, scale: 30_000, rotation: 33 } },
  })
  assert.deepEqual(outcome, { ok: true, revision: 3 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 's1')
  assert.equal(calls[0].record.targetRevision, 2)
  assert.equal(calls[0].record.change.op, 'set-view')
  assert.deepEqual(calls[0].record.change.view.center, [121.47, 31.23])
})

test('a failed settled-camera write reports its refusal without throwing', async () => {
  const submit = createPanelChangeSubmit(async () => Response.json({ ok: false, code: 'stale-revision' }, { status: 409 }))
  const outcome = await submit({
    sessionId: 's1',
    revision: 1,
    summary: '用户调整了地图视图',
    change: { op: 'set-view', view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
  })
  assert.deepEqual(outcome, { ok: false, code: 'stale-revision' })
})
