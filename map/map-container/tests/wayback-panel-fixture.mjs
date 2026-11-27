/** Shared Wayback catalog and admission fixtures for the browser panel tests. */
import { WAYBACK_CONFIG_URL, WAYBACK_ENDPOINT } from '../src/wayback-catalog-codec.ts'
import { tsImport } from 'tsx/esm/api'

const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
export const { createWaybackCatalogOwner } = await importClient('../src/client/wayback-catalog.ts')
export const { waybackDescriptor } = await importClient('../src/wayback.ts')

const itemId = digit => digit.repeat(32)

/** One official catalog entry, in the field order the digest depends on. */
export const catalogItem = (release, date, digit) => ({
  itemTitle: `World Imagery (Wayback ${date})`,
  releaseDateLabel: date,
  itemID: itemId(digit),
  itemURL: `${WAYBACK_ENDPOINT}/tile/${release}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${date.slice(0, 4)}_r01/MapServer`,
  metadataLayerItemID: itemId(digit === 'a' ? 'b' : 'c'),
  layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
})

/** Official catalog document holding the given `[releaseId, date, digit]` entries. */
export const catalogBody = (...releases) =>
  JSON.stringify(Object.fromEntries(releases.map(([id, date, digit]) => [String(id), catalogItem(id, date, digit)])))

/** Verified release identity as the catalog owner publishes it. */
export const catalogRelease = (releaseId, date, digit = 'a') => ({
  releaseId, itemId: itemId(digit), title: `World Imagery (Wayback ${date})`, publishedAt: date, layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
})

export const OLD_RELEASE = catalogRelease(10, '2014-02-20', 'a')
export const NEW_RELEASE = catalogRelease(50, '2025-10-29', 'd')

/** In-memory BrowserStorage double. */
export function memoryStorage() {
  const map = new Map()
  return {
    namespace: 'test',
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
    keys: () => [...map.keys()],
    subscribe: () => () => {},
  }
}

/**
 * One catalog owner whose official fetch replies come from a queue; same-origin requests are recorded and rejected.
 * @param replies - Queue of `Response`s, functions, or `Error`s for the official catalog URL.
 * @returns The owner and its recorded calls.
 */
export function catalogHarness(...replies) {
  const queue = [...replies]
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) !== WAYBACK_CONFIG_URL) throw new Error('unexpected same-origin request')
    const reply = queue.shift()
    if (reply === undefined) throw new Error('unexpected catalog fetch')
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply(url, init) : reply
  }
  const owner = createWaybackCatalogOwner({ storage: memoryStorage(), fetch, ttlMs: 60_000, timeoutMs: 2_000, maxBodyBytes: 1 << 20 })
  return { owner, calls }
}

/** Official catalog response with HTTP 200. */
export const catalogResponse = body => new Response(body, { status: 200 })

/** The canonical descriptor the admission route returns for one release. */
export const admittedSource = release => waybackDescriptor({ ...release, acquiredAt: null })
