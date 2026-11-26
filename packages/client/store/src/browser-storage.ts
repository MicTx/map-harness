/** Instance-local browser persistence; namespaces never alter the browser's Storage object. */
import type { Context } from '@deepseek-ai/cordis'

/** Browser capabilities borrowed by one storage adapter; omitted storage disables persistence. */
export interface BrowserStorageHost {
  readonly localStorage?: Storage
  addEventListener?(type: 'storage', listener: (event: StorageEvent) => void): void
  removeEventListener?(type: 'storage', listener: (event: StorageEvent) => void): void
}

/** Logical-key storage for one application instance. Storage failures propagate to the owning consumer. */
export interface BrowserStorage {
  /** Empty preserves the stock keys; nonempty namespaces neither read nor migrate those keys. */
  readonly namespace: string
  /** @param key - Logical key. @returns Stored text, or null when absent or persistence is unavailable. */
  getItem(key: string): string | null
  /** @param key - Logical key. @param value - Text to persist; absent storage is a no-op. */
  setItem(key: string, value: string): void
  /** @param key - Logical key to remove; absent storage is a no-op. */
  removeItem(key: string): void
  /** @returns Logical keys belonging to this namespace, without reading their values. */
  keys(): readonly string[]
  /**
   * Observe this namespace's external localStorage changes; local writes do not notify.
   * @param listener - Logical key, or null after an origin-wide clear.
   * @returns Idempotent listener removal; the caller owns its lifetime.
   */
  subscribe(listener: (key: string | null) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser persistence adapter supplied by the current Client composition. */
    browserStorage: BrowserStorage
  }
}

/**
 * Resolve an explicit composition adapter, or an independent stock adapter for a standalone tree.
 * @param ctx - Owning Context; configured compositions provide browserStorage before their consumers.
 * @returns The composition's adapter, or an empty-namespace adapter when no provider is composed.
 */
export function resolveBrowserStorage(ctx: Context): BrowserStorage {
  return ctx.get('browserStorage') ?? createBrowserStorage()
}

/**
 * Create an adapter without touching Storage until an operation is requested.
 * @param namespace - Instance namespace; omission or empty text preserves stock keys exactly.
 * @param host - Browser storage and events; omission borrows the current realm's capabilities.
 * @returns An independent adapter whose namespace is fixed for its lifetime.
 */
export function createBrowserStorage(namespace = '', host: BrowserStorageHost = globalThis): BrowserStorage {
  // Length framing prevents overlapping namespaces even when they contain delimiters.
  const prefix = namespace === '' ? '' : `dsh.scope:${namespace.length}:${namespace}:`
  const logicalKey = (key: string): string | undefined => {
    if (namespace === '') return key.startsWith('dsh.scope:') ? undefined : key
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined
  }
  return {
    namespace,
    getItem: key => host.localStorage?.getItem(prefix + key) ?? null,
    setItem: (key, value) => { host.localStorage?.setItem(prefix + key, value) },
    removeItem: (key) => { host.localStorage?.removeItem(prefix + key) },
    keys() {
      const storage = host.localStorage
      if (storage === undefined) return []
      const keys: string[] = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key === null) continue
        const logical = logicalKey(key)
        if (logical !== undefined) keys.push(logical)
      }
      return keys
    },
    subscribe(listener) {
      let active = true
      const changed = (event: StorageEvent): void => {
        if (!active || (event.storageArea !== null && event.storageArea !== host.localStorage)) return
        const key = event.key === null ? null : logicalKey(event.key)
        if (key === undefined) return
        try { listener(key) }
        catch (error) { console.error('[browser-storage] subscriber failed:', error) }
      }
      host.addEventListener?.('storage', changed)
      return () => {
        if (!active) return
        active = false
        host.removeEventListener?.('storage', changed)
      }
    },
  }
}
