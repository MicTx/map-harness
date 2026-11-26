// @vitest-environment jsdom
/** Plugin-manager's remembered registry lives in one application instance. */
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import { PluginManagerController } from '../src/client/manager-store.ts'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

const KEY = 'dsh.plugin-manager.install-registry'

function ctxFor(storage: ReturnType<typeof createBrowserStorage>) {
  return {
    browserStorage: storage,
    get: (name: string) => name === 'browserStorage' ? storage : undefined,
    configForms: { describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }), subscribe: () => () => {} }), get: vi.fn() },
    remote: {
      pluginManager: {
        registries: vi.fn(() => Promise.resolve({ ok: true, value: { registry: null, fallbackRegistries: [], resolved: null } })),
        inspect: vi.fn(() => Promise.resolve({ ok: true, value: { status: 'refused', problem: 'unknown', reason: 'fixture stops before installation' } })),
      },
      pluginInventory: {},
      pluginRegistryProbe: { fastest: vi.fn(() => Promise.resolve({ ok: true, value: null })) },
    },
  } as never
}

function faceOf(controller: PluginManagerController) {
  return controller.inject(
    { getSnapshot: () => ({ items: [], bundles: new Set(), rows: new Set() }), subscribe: () => () => {} },
    { getSnapshot: () => [], subscribe: () => () => {} },
    text => typeof text === 'string' ? text : text.en,
  )
}

it('restores DSH → Map A → Map B → Map A registry choices written by the controller', async () => {
  const scopes = ['', 'map-harness:A', 'map-harness:B'].map(namespace => createBrowserStorage(namespace, window))
  const expected = [
    { kind: 'offered', registry: null },
    { kind: 'custom', url: 'https://npm.corp.example/' },
    { kind: 'offered', registry: 'https://registry.npmmirror.com/' },
  ] as const
  const controllers = scopes.map(storage => new PluginManagerController(ctxFor(storage)))
  try {
    for (const [index, controller] of controllers.entries()) {
      const face = faceOf(controller)
      face.openInstall()
      expect(scopes[index]!.getItem(KEY)).toBeNull()
      face.editInstallSpec('fixture-package')
      face.chooseRegistry(expected[index]!)
      face.runInstall()
      await vi.waitFor(() => { expect(controller.getSnapshot().install.inputError?.reason).toBe('fixture stops before installation') })
    }
    expect(scopes[0]!.getItem(KEY)).toBe(JSON.stringify(expected[0]))
    expect(scopes[1]!.getItem(KEY)).toBe(JSON.stringify(expected[1]))
    expect(scopes[2]!.getItem(KEY)).toBe(JSON.stringify(expected[2]))
    const reopened = new PluginManagerController(ctxFor(scopes[1]!))
    try {
      faceOf(reopened).openInstall()
      expect(reopened.getSnapshot().install.registry).toEqual(expected[1])
    } finally { reopened.dispose() }
  } finally { for (const controller of controllers) controller.dispose() }
})
