import test from 'node:test'
import assert from 'node:assert/strict'
import { LBS_VENDORS, LbsSectionController } from '../src/client/lbs-section-controller.ts'

/**
 * Script the credentials Remote domain: each describe answer reports which
 * references are configured, and writes record themselves for assertions.
 * @param options - configured refs, unwritable refs, and whether describe fails.
 * @returns the mock ctx, its call logs, and the staged-form model stub.
 */
function bench(options = {}) {
  const configured = new Set(options.configured ?? [])
  const unwritable = new Set(options.unwritable ?? [])
  const describeCalls = []
  const setCalls = []
  const unsetCalls = []
  const ctx = {
    remote: {
      credentials: {
        describe: async (refs) => {
          describeCalls.push([...refs])
          if (options.describeFails === true) return { ok: false, error: { message: 'unavailable' } }
          return {
            ok: true,
            value: Object.fromEntries(refs.map(ref => [ref, {
              configured: configured.has(ref),
              writable: !unwritable.has(ref),
            }])),
          }
        },
        set: async (ref, value) => { setCalls.push([ref, value]); configured.add(ref) },
        unset: async (ref) => { unsetCalls.push(ref); configured.delete(ref) },
      },
    },
  }
  return { ctx, describeCalls, setCalls, unsetCalls, form: makeModel(ctx) }
}

/**
 * Stand in for the shared `SettingsFormModel`: stage per-row drafts, publish
 * a shell, and run each staged secret's write on save.
 * @param ctx - the mock plugin context the writes reach.
 * @returns a model face the controller consumes.
 */
function makeModel(ctx) {
  const staged = new Map()
  const listeners = new Set()
  let saving = false
  let failed = false
  let disposed = false
  const publish = () => { for (const listener of listeners) listener() }
  const model = {
    bind(project) {
      const store = {
        current: project(),
        getSnapshot() { return this.current },
        set(value) { this.current = value },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      }
      listeners.add(() => { store.set(project()) })
      return store
    },
    shell() {
      return {
        available: true, writable: true,
        dirty: [...staged.values()].some(text => text.trim() !== ''),
        invalid: false, saving, failed,
      }
    },
    field(id) { return { text: staged.get(id) ?? '' } },
    actions() {
      return {
        edit: (id, text) => { staged.set(id, text); failed = false; publish() },
        resetField: (id) => { staged.delete(id); publish() },
        save: () => {
          void (async () => {
            const writes = [...staged.entries()].filter(([, text]) => text.trim() !== '')
            if (!writes.length || saving) return
            saving = true
            publish()
            try {
              for (const [id, text] of writes) {
                await ctx.remote.credentials.set(LBS_VENDORS.find(vendor => vendor.id === id).ref, text.trim())
              }
              for (const [id] of writes) staged.delete(id)
            } catch {
              failed = true
            } finally {
              saving = false
              publish()
            }
          })()
        },
        discard: () => { staged.clear(); failed = false; publish() },
      }
    },
    dispose() { disposed = true },
  }
  return { model, isDisposed: () => disposed }
}

/** Build a controller over the bench's ctx and staged-form stub. */
function controllerOf(b) {
  return { controller: new LbsSectionController(b.ctx, b.form.model), disposed: b.form.isDisposed }
}

/** Wait until the form's asynchronous save settles. */
async function settled(face) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!face.hooks.lbs.getSnapshot().shell.saving) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('save did not settle')
}

test('every declared vendor row is a credential reference the consumers resolve', () => {
  assert.deepEqual(LBS_VENDORS.map(vendor => vendor.ref), [
    'TIANDITU_API_KEY', 'TIANDITU_SDK_KEY', 'AMAP_API_KEY', 'BAIDU_API_KEY', 'TENCENT_MAP_KEY', 'MAPBOX_ACCESS_TOKEN',
  ])
})

test('load describes every row in one batch and publishes configured/writable state', async () => {
  const b = bench({ configured: ['TIANDITU_API_KEY'], unwritable: ['AMAP_API_KEY'] })
  const { controller, disposed } = controllerOf(b)
  const face = controller.inject()
  await face.load()
  assert.deepEqual(b.describeCalls, [LBS_VENDORS.map(vendor => vendor.ref)])
  const state = face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.available, true)
  assert.equal(state.shell.writable, true)
  assert.equal(state.shell.dirty, false)
  assert.equal(state.rows.length, LBS_VENDORS.length)
  assert.equal(state.rows[0].configured, true)
  assert.equal(state.rows[1].configured, false)
  assert.equal(state.rows[2].writable, false)
  assert.equal(state.rows.every(row => row.text === '' && row.failed === false), true)
  controller.dispose()
  assert.equal(disposed(), true)
})

test('an all-unwritable credentials domain marks the form read-only', async () => {
  const b = bench({ unwritable: LBS_VENDORS.map(vendor => vendor.ref) })
  const { controller } = controllerOf(b)
  const face = controller.inject()
  await face.load()
  const state = face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.available, true)
  assert.equal(state.shell.writable, false)
  assert.equal(state.rows.every(row => row.writable === false), true)
  controller.dispose()
})

test('the injected face keeps stable load/actions references across renders', () => {
  const b = bench()
  const { controller } = controllerOf(b)
  const first = controller.inject()
  const second = controller.inject()
  assert.equal(second, first)
  assert.equal(second.load, first.load)
  assert.equal(second.actions, first.actions)
  controller.dispose()
})

test('a failed describe leaves the form unavailable with no configured rows', async () => {
  const b = bench({ describeFails: true })
  const { controller } = controllerOf(b)
  const face = controller.inject()
  await face.load()
  const state = face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.available, false)
  assert.equal(state.rows.every(row => row.configured === false), true)
  controller.dispose()
})

test('a staged key lands through credentials.set on the form save, then refreshes its row', async () => {
  const b = bench()
  const { controller } = controllerOf(b)
  const face = controller.inject()
  face.actions.edit('tianditu', '  secret-from-settings  ')
  assert.equal(face.hooks.lbs.getSnapshot().shell.dirty, true)
  face.actions.save()
  await settled(face)
  assert.deepEqual(b.setCalls, [['TIANDITU_API_KEY', 'secret-from-settings']])
  assert.deepEqual(b.unsetCalls, [])
  const state = face.hooks.lbs.getSnapshot()
  assert.equal(state.rows.find(row => row.spec.id === 'tianditu').text, '')
  assert.equal(state.shell.dirty, false)
  assert.equal(state.shell.failed, false)
  controller.dispose()
})

test('an empty draft never writes and clear goes through credentials.unset', async () => {
  const b = bench({ configured: ['AMAP_API_KEY'] })
  const { controller } = controllerOf(b)
  const face = controller.inject()
  face.actions.edit('amap', '   ')
  face.actions.save()
  await settled(face)
  assert.deepEqual(b.setCalls, [])
  await face.clear('amap')
  assert.deepEqual(b.unsetCalls, ['AMAP_API_KEY'])
  assert.deepEqual(b.describeCalls, [['AMAP_API_KEY']])
  assert.equal(face.hooks.lbs.getSnapshot().rows.find(row => row.spec.id === 'amap').configured, false)
  controller.dispose()
})

test('a refused write keeps the draft and marks the form failed', async () => {
  const b = bench()
  b.ctx.remote.credentials.set = async () => { throw new Error('refused') }
  const { controller } = controllerOf(b)
  const face = controller.inject()
  face.actions.edit('baidu', 'rejected-key')
  face.actions.save()
  await settled(face)
  const state = face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.failed, true)
  assert.equal(state.rows.find(row => row.spec.id === 'baidu').text, 'rejected-key')
  face.actions.edit('baidu', 'retry-key')
  assert.equal(face.hooks.lbs.getSnapshot().shell.failed, false)
  controller.dispose()
})

test('a refused clear marks only its row', async () => {
  const b = bench({ configured: ['MAPBOX_ACCESS_TOKEN'] })
  b.ctx.remote.credentials.unset = async () => { throw new Error('refused') }
  const { controller } = controllerOf(b)
  const face = controller.inject()
  await face.clear('mapbox')
  const rows = face.hooks.lbs.getSnapshot().rows
  assert.equal(rows.find(row => row.spec.id === 'mapbox').failed, true)
  assert.equal(rows.filter(row => row.failed).length, 1)
  controller.dispose()
})

test('refreshCredential ignores references no row declares and updates matching rows', async () => {
  const b = bench()
  const { controller } = controllerOf(b)
  await controller.refreshCredential('UNRELATED_REF')
  assert.deepEqual(b.describeCalls, [])
  await controller.refreshCredential('TENCENT_MAP_KEY')
  assert.deepEqual(b.describeCalls, [['TENCENT_MAP_KEY']])
  assert.equal(controller.inject().hooks.lbs.getSnapshot().rows.find(row => row.spec.ref === 'TENCENT_MAP_KEY').configured, false)
  controller.dispose()
})
