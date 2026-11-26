import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UnifiedMapPanel } from '../src/client/LayerPanel.tsx'
import type { LayerPanelProps } from '../src/client/LayerPanel.tsx'
import { en } from '../src/client/locales.ts'
import { MAP_THEME_CSS } from '../src/client/map-theme.ts'
import type { MapContainerWire } from '../src/client/state.ts'

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
const older = {
  releaseId: 10, title: 'World Imagery (Wayback 2014-02-20)', publishedAt: '2014-02-20', acquiredAt: null,
  descriptor: { ...wayback, title: 'World Imagery (Wayback 2014-02-20)', release: { version: '10', publishedAt: '2014-02-20', acquiredAt: null } },
}
const recent = {
  releaseId: 50, title: 'World Imagery (Wayback 2025-10-29)', publishedAt: '2025-10-29', acquiredAt: null,
  descriptor: { ...wayback, title: 'World Imagery (Wayback 2025-10-29)', release: { version: '50', publishedAt: '2025-10-29', acquiredAt: null } },
}
const localEntry = (entry: typeof older, acquiredAt: string | null) => ({
  releaseId: entry.releaseId, title: entry.title, publishedAt: entry.publishedAt, acquiredAt,
  provider: null, resolution: null, accuracy: null, metadataStatus: acquiredAt === null ? 'unknown' : 'known',
})

const originalFetch = globalThis.fetch
let localMode = 'multiple'
let failCatalog = false
const changes: unknown[] = []
const requests: string[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
  if (url.pathname !== '/api/map/wayback') return originalFetch(input, init)
  const operation = url.searchParams.get('operation')
  requests.push(operation ?? '')
  if (operation === 'catalog') {
    if (failCatalog) return Response.json({ ok: false }, { status: 502 })
    return Response.json({ schemaVersion: 1, releases: [recent, older], nextCursor: null })
  }
  if (operation === 'local') {
    const point = { lon: Number(url.searchParams.get('lon')), lat: Number(url.searchParams.get('lat')) }
    return Response.json({ schemaVersion: 1, point, zoom: Number(url.searchParams.get('zoom')), coverage: 'sampled',
      releases: localMode === 'single' ? [localEntry(older, null)] : [localEntry(older, '2010-01-02'), localEntry(recent, '2025-01-02')] })
  }
  if (operation === 'coverage') {
    const center = [Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))]
    const extent = ['minX', 'minY', 'maxX', 'maxY'].map(key => Number(url.searchParams.get(key)))
    const points = [center, [extent[0], extent[1]], [extent[0], extent[3]], [extent[2], extent[1]], [extent[2], extent[3]]]
    return Response.json({ releaseId: Number(url.searchParams.get('releaseId')), zoom: Math.round(Number(url.searchParams.get('zoom'))),
      viewport: { extent, wkid: Number(url.searchParams.get('wkid')) }, coverage: 'partial',
      samples: points.map(([lon, lat], index) => ({ point: { lon, lat }, status: 'known',
        acquiredAt: index === 1 ? '2012-01-01' : '2010-01-02', provider: null, resolution: null, accuracy: null })) })
  }
  return Response.json({ ok: false }, { status: 400 })
}

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
      const revision = input.revision + 1
      if (input.change.op === 'set-basemap') setWire(previous => ({ ...previous, revision, basemap: (input.change as { selection: MapContainerWire['basemap'] }).selection }))
      if (input.change.op === 'set-imagery-display' && input.change.display !== undefined) setWire(previous => ({ ...previous, revision, imageryDisplay: input.change.display! }))
      if (input.change.op === 'set-wayback-comparison') setWire(previous => ({ ...previous, revision, waybackComparison: (input.change as { pair: MapContainerWire['waybackComparison'] }).pair }))
      return { ok: true as const, revision }
    },
    panelSubmit: undefined,
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
    setCatalogFailure(value: boolean) { failCatalog = value },
    setLocalMode(value: string) { localMode = value },
  },
})
createRoot(document.getElementById('root')!).render(<Harness />)
