import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UnifiedMapPanel } from '../src/client/LayerPanel.tsx'
import type { LayerPanelProps } from '../src/client/LayerPanel.tsx'
import { en } from '../src/client/locales.ts'
import { MAP_THEME_CSS } from '../src/client/map-theme.ts'
import type { MapContainerWire } from '../src/client/state.ts'
import { WAYBACK_CONFIG_URL, WAYBACK_ENDPOINT } from '../src/wayback-catalog-codec.ts'
import { createWaybackCatalogOwner } from '../src/client/wayback-catalog.ts'

// One official catalog entry; the digest depends on this field order.
const entry = (release: number, date: string, digit: string) => ({
  itemTitle: `World Imagery (Wayback ${date})`, releaseDateLabel: date, itemID: digit.repeat(32),
  itemURL: `${WAYBACK_ENDPOINT}/tile/${release}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${date.slice(0, 4)}_r01/MapServer`,
  metadataLayerItemID: digit === 'a' ? 'b'.repeat(32) : 'c'.repeat(32), layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
})
const catalogBody = JSON.stringify({
  10: entry(10, '2014-02-20', 'a'),
  50: entry(50, '2025-10-29', 'd'),
})

const style = document.createElement('style')
style.textContent = MAP_THEME_CSS
document.head.append(style)

const source = {
  schemaVersion: 1, id: 'esri-world-imagery', title: 'World Imagery', provider: 'esri', role: 'basemap',
  adapter: 'xyz', configDigest: 'a'.repeat(64), nativeWkid: 3857, supportsDynamicExport: false,
  supportedModes: ['map'], minZoom: 0, maxZoom: 23, compatibleBasemapIds: [], attribution: 'Esri',
  release: { version: null, publishedAt: null, acquiredAt: null }, screenshot: 'unverified',
  automatedMapUse: 'unverified', availability: { kind: 'configured' },
}
const wayback = { ...source, id: 'esri-wayback', title: 'World Imagery Wayback', adapter: 'wmts' }
const labels = { ...source, id: 'amap-imagery-labels', title: 'AMap Imagery Labels', role: 'labels', compatibleBasemapIds: ['esri-world-imagery', 'esri-wayback'] }
const admitted = (releaseId: number, title: string, publishedAt: string) => ({
  ...wayback, title, configDigest: `${releaseId}`.repeat(2).padStart(64, '0'),
  release: { version: String(releaseId), publishedAt, acquiredAt: null },
})

const values = new Map<string, string>()
const browserStorage = {
  namespace: 'wayback-fixture', getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) }, keys: () => [...values.keys()], subscribe: () => () => {},
}

const changes: unknown[] = []
const submitted: { revision: number }[] = []
const requests: string[] = []
const admits: { method?: string; credentials?: RequestCredentials; body: unknown }[] = []
const state = { failCatalog: false, failAdmission: false }

// Only the official catalog and the admission route may be requested; everything
// else is recorded so a polled same-origin read fails the assertions.
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (raw === WAYBACK_CONFIG_URL) {
    return state.failCatalog ? new Response('unavailable', { status: 503 }) : new Response(catalogBody, { status: 200 })
  }
  const url = new URL(raw, location.href)
  requests.push(url.pathname + url.search)
  if (url.pathname === '/api/map/wayback/admit') {
    const body = JSON.parse(String(init?.body)) as { sessionId: string; release: { releaseId: number; publishedAt: string } }
    admits.push({ method: init?.method, credentials: init?.credentials, body })
    if (state.failAdmission) return Response.json({ ok: false, code: 'SOURCE_CHANGED' }, { status: 409 })
    return Response.json(admitted(body.release.releaseId, `World Imagery (Wayback ${body.release.publishedAt})`, body.release.publishedAt))
  }
  return Response.json({ ok: false }, { status: 400 })
}
const waybackCatalog = createWaybackCatalogOwner({ storage: browserStorage, ttlMs: 60_000, timeoutMs: 5_000, maxBodyBytes: 1 << 20 })

const translate = (key: keyof typeof en, params: Record<string, string> = {}) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? '')

function Harness() {
  const [panelOpen, setPanelOpen] = useState(false)
  const [wire, setWire] = useState({
    layers: [{
      id: 'user-annotations', name: 'User annotations', role: 'user-annotation', visible: true, opacity: 1,
      sourceCrs: 'EPSG:4326', data: { type: 'FeatureCollection', features: [] },
    }], view: { center: [1, 1], zoom: 12, wkid: 4326 }, mode: 'map',
    basemap: { schemaVersion: 1, basemap: source, labels: null }, aoi: null, revision: 0,
    imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
    operations: [], observationRequest: null,
    undoableAnnotation: null,
  } as MapContainerWire)
  const shared = {
    wire,
    sessionId: 'fixture',
    occurrenceKey: 'view:map',
    occurrence: () => null,
    t: translate,
    useResource: () => ({ status: 'live' as const, value: { sources: [source, wayback, labels], canChange: true } }),
    changeSubmit: async (input: { revision: number; change: { op: string; display?: MapContainerWire['imageryDisplay'] } }) => {
      changes.push(input.change)
      submitted.push({ revision: input.revision })
      const revision = input.revision + 1
      if (input.change.op === 'set-basemap') setWire(previous => ({ ...previous, revision, basemap: (input.change as { selection: MapContainerWire['basemap'] }).selection }))
      if (input.change.op === 'set-imagery-display' && input.change.display !== undefined) setWire(previous => ({ ...previous, revision, imageryDisplay: input.change.display! }))
      if (input.change.op === 'set-wayback-comparison') setWire(previous => ({ ...previous, revision, waybackComparison: (input.change as { pair: MapContainerWire['waybackComparison'] }).pair }))
      return { ok: true as const, revision }
    },
    panelSubmit: undefined,
    waybackCatalog,
    liveViewport: { center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326, zoom: 12, mode: 'map' },
  }
  return <div data-map-container=""><div data-map-overlay-content="">
    <UnifiedMapPanel {...(shared as LayerPanelProps)} open={panelOpen} onOpenChange={setPanelOpen} />
  </div></div>
}

Object.assign(globalThis, {
  waybackFixture: {
    changes,
    requests,
    admits,
    submitted,
    refresh: async () => { await waybackCatalog.refresh() },
    snapshot: () => ({ reason: waybackCatalog.getSnapshot().reason }),
    setAdmissionFailure(value: boolean) { state.failAdmission = value },
    setCatalogFailure(value: boolean) { state.failCatalog = value },
  },
})
createRoot(document.getElementById('root')!).render(<Harness />)
