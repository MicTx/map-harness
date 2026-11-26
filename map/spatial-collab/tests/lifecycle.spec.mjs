/**
 * Writer lease lifecycle: join/duplicate-join, gate admission, disconnect
 * refusing new gates while the identity survives, reconnect, permission
 * revoke, release waiting for real in-flight quiescence, and disposal
 * waiting for every open gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CollabLifecycleError, WriterRegistry } from '../src/lifecycle.ts'

test('join registers a writer; a duplicate join refuses loudly', () => {
  const registry = new WriterRegistry()
  const record = registry.join({ id: 'client-a', label: 'rightbar', canCommit: true })
  assert.equal(record.status, 'active')
  assert.equal(record.canCommit, true)
  assert.throws(() => registry.join({ id: 'client-a' }), error => error.code === 'writer-active')
  assert.throws(() => registry.disconnect('ghost'), error => error.code === 'unknown-writer')
})

test('a gate admits an active permitted writer and counts as in-flight until closed', async () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  const gate = registry.gate('client-a')
  let released = false
  const pending = registry.release('client-a').then(() => { released = true })
  await Promise.resolve()
  assert.equal(released, false, 'release must not settle while a handler holds a gate')
  gate.close()
  gate.close()
  await pending
  assert.equal(released, true)
  assert.throws(() => registry.gate('client-a'), error => error.code === 'writer-released')
})

test('disconnect refuses new gates immediately; reconnect restores them', () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  registry.disconnect('client-a')
  assert.throws(() => registry.gate('client-a'), error => error.code === 'writer-offline')
  assert.equal(registry.writerOf('client-a').status, 'offline', 'the identity survives the transport close')
  registry.reconnect('client-a')
  assert.equal(registry.writerOf('client-a').status, 'active')
  const gate = registry.gate('client-a')
  gate.close()
  assert.throws(() => registry.reconnect('client-a'), error => error.code === 'writer-active')
})

test('permission revoke refuses gates until granted again', () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  registry.setPermission('client-a', false)
  assert.throws(() => registry.gate('client-a'), error => error.code === 'permission-denied')
  assert.equal(registry.writerOf('client-a').canCommit, false)
  registry.setPermission('client-a', true)
  const gate = registry.gate('client-a')
  gate.close()
})

test('release drops the identity and refuses further work for it', async () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  await registry.release('client-a')
  assert.equal(registry.writerOf('client-a'), undefined)
  assert.throws(() => registry.release('client-a'), error => error.code === 'writer-released')
  assert.throws(() => registry.gate('client-a'), error => error.code === 'writer-released')
})

test('quiesce waits for every open gate across writers, including draining releases', async () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  registry.join({ id: 'client-b' })
  const gateA = registry.gate('client-a')
  const gateB = registry.gate('client-b')
  const releaseB = registry.release('client-b')
  let quiet = false
  const quiesce = registry.quiesce().then(() => { quiet = true })
  await Promise.resolve()
  assert.equal(quiet, false)
  gateB.close()
  await Promise.resolve()
  await releaseB
  assert.equal(quiet, false, 'client-a still holds a gate')
  gateA.close()
  await quiesce
  assert.equal(quiet, true)
})

test('dispose refuses new gates and waits for in-flight handlers to finish', async () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  const gate = registry.gate('client-a')
  let done = false
  const disposal = registry.dispose().then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false)
  gate.close()
  await disposal
  assert.equal(done, true)
  assert.throws(() => registry.gate('client-a'), error => error.code === 'service-disposed')
  assert.equal(registry.isDisposed, true)
  assert.throws(() => registry.join({ id: 'client-b' }), error => error.code === 'service-disposed')
})

test('a released writer still quiesces before dispose resolves', async () => {
  const registry = new WriterRegistry()
  registry.join({ id: 'client-a' })
  const gate = registry.gate('client-a')
  const release = registry.release('client-a')
  let done = false
  const disposal = registry.dispose().then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false, 'dispose must wait for the draining released writer')
  gate.close()
  await Promise.all([release, disposal])
  assert.equal(done, true)
})
