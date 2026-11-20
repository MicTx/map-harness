/**
 * Visual-audit harness: mounts every map UI card against synthetic
 * `MapContainerWire`/record fixtures under the real theme and `map-theme`
 * stylesheets, for Playwright screenshot review. Not a product test entry.
 * The unified map panel renders its resident collapsible sections as
 * data-map-panel-section blocks inside one card. Annotation rows open
 * data-map-annotation-dialog and imagery rows (data-map-imagery-row) open
 * data-map-imagery-dialog; the audit drives both through real clicks.
 */
import '../../../packages/client/ui-theme/src/styles/base.css'
import '../../../packages/client/ui-theme/src/styles/design-platform.css'
import { createRoot } from 'react-dom/client'
import { createElement, useMemo, useState, type ReactNode } from 'react'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { FeatureCard } from '../src/client/FeatureCard.tsx'
import { MapUseStatus } from '../src/client/MapUseStatus.tsx'
import { MapToolCard } from '../src/client/MapToolCard.tsx'
import { MapSessionAction } from '../src/client/MapSessionAction.tsx'
import { MapboxControls } from '../src/client/mapbox-controls.tsx'
import { AIDataLayerPanel, ImageryResourcePanel, UnifiedMapPanel, UserAnnotationPanel, type LayerPanelProps } from '../src/client/LayerPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { installMapTheme } from '../src/client/map-theme.ts'
import type { MapContainerWire } from '../src/client/state.ts'
import type { MapOccurrence } from '../src/client/face.ts'
import type { MapSessionBinding } from '../src/client/default-open.ts'
import { mapInteractionStateSchema } from '../src/interaction-protocol.ts'
import { mapObservationRecordSchema } from '../src/observation-protocol.ts'
import { visualProposalRecordSchema } from '../src/visual-proposal-protocol.ts'
import { visualChangeRecordSchema } from '../src/comparison-protocol.ts'

const translate: TranslateNS<'mapContainer'> = (key, params = {}) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}
const translateEn: TranslateNS<'mapContainer'> = (key, params = {}) => {
  const template = (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const SHA = 'a'.repeat(64)
const attachment = {
  attachmentId: 'att-1', mediaType: 'image/png' as const, bytes: 20480,
  width: 640, height: 480, name: 'obs.png', sha256: SHA,
}
const source = {
  schemaVersion: 1 as const, id: 'esri-world-imagery', title: 'World Imagery', provider: 'esri', role: 'basemap' as const,
  adapter: 'xyz', configDigest: 'a'.repeat(64), nativeWkid: 3857, supportsDynamicExport: false,
  supportedModes: ['map'] as const, minZoom: 0, maxZoom: 23, compatibleBasemapIds: [] as const,
  attribution: 'Esri', release: { version: null, publishedAt: null, acquiredAt: null },
  screenshot: 'unverified', automatedMapUse: 'unverified', availability: { kind: 'configured' as const },
}
const wayback = { ...source, id: 'esri-wayback', title: 'World Imagery Wayback', adapter: 'wmts' as const }
const labels = { ...source, id: 'tianditu-cia-w', title: '天地图注记', role: 'labels' as const, compatibleBasemapIds: ['esri-world-imagery'] as const }

const observation = mapObservationRecordSchema.parse({
  observationId: 'obs-1', callId: 'call-1', requestSeq: 0, mapRevision: 0,
  viewId: 'view-1', generation: 0, cameraEpoch: 0, gestureEpoch: 0,
  attachment, capturedAt: '2026-11-01T08:00:00.000Z',
  imageSize: { width: 640, height: 480 },
  mapContentRect: { x: 0, y: 0, width: 640, height: 480 },
  cssViewSize: { width: 640, height: 480 },
  camera: {
    center: [116.39, 39.9] as [number, number],
    extent: [0, 0, 1, 1] as [number, number, number, number],
    wkid: 4326, scale: 1, zoom: 12, rotation: 0, mode: 'map' as const, padding: [0, 0, 0, 0] as const,
  },
  georeference: { kind: 'none' as const, reason: 'unsupported-projection' as const },
  sources: [{ id: 'esri-world-imagery', kind: 'basemap' as const, version: null, attribution: 'Esri', policy: 'approved' as const }],
  includedOverlays: ['labels' as const, 'attribution' as const],
  limitations: [],
})

const proposal = visualProposalRecordSchema.parse({
  proposalId: `vprop-${'0123456789abcdef01234567'}`, observationId: 'obs-1', observationAttachmentSha256: SHA,
  observationAttachment: attachment, sourceCallId: 'call-1', sourceCallSeq: 0, mapRevision: 0,
  modelProvider: 'deepseek', modelName: 'model-x', purpose: 'sketch' as const,
  category: '新建道路', note: '右下角新增一条车行道', confidence: 'likely' as const,
  pixelGeometry: { type: 'polyline' as const, points: [[0.2, 0.2], [0.8, 0.8]] },
  geometry: { type: 'LineString' as const, coordinates: [[116.3, 39.8], [116.5, 40.0]] },
  status: 'proposed' as const, createdAt: '2026-11-01T08:00:00.000Z', reviewedAt: null, humanEdited: false,
  acceptedFeatureId: null,
})

const change = visualChangeRecordSchema.parse({
  changeId: 'vchange-0123456789abcdef01234567', comparisonId: 'vcompare-0123456789abcdef01234567',
  beforeObservationId: 'obs-0', afterObservationId: 'obs-1',
  beforeAttachmentSha256: SHA, afterAttachmentSha256: SHA, observationAttachment: attachment,
  sourceCallId: 'call-2', sourceCallSeq: 1, mapRevision: 0, modelProvider: 'deepseek', modelName: 'model-x',
  kind: 'appeared' as const, category: '新增建筑', note: '检测到新的建筑轮廓', confidence: 'likely' as const,
  pixelGeometry: { type: 'bbox' as const, corners: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]] },
  geometry: { type: 'Polygon' as const, coordinates: [[[116.3, 39.8], [116.4, 39.8], [116.4, 39.9], [116.3, 39.8]]] },
  status: 'proposed' as const, createdAt: '2026-11-01T08:00:00.000Z', reviewedAt: null, humanEdited: false,
  acceptedFeatureId: null,
})

const interaction = mapInteractionStateSchema.parse({
  stateVersion: 3, turn: 1, open: true, turnStartSeq: 0, controlEpoch: 0,
  stopped: null, lastResult: null, usedObservationId: null, lastCallSeq: 0,
  startedAt: 0, observedAt: 0, actions: 3, observations: 2, request: null,
})

const geojsonLayer = {
  id: 'points', name: '重点点位', group: '业务', visible: true, opacity: 0.85,
  sourceCrs: 'EPSG:4326', resourceRef: 'res-points-v3',
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'f1', geometry: { type: 'Point', coordinates: [116.39, 39.9] }, properties: { name: '北京站', level: 'S1' } },
    { type: 'Feature', id: 'f2', geometry: { type: 'Point', coordinates: [116.4, 39.91] }, properties: { name: '国贸', level: 'S2' } },
  ] },
}
const polyLayer = {
  id: 'region', name: '研究范围', visible: true, opacity: 0.4,
  sourceCrs: 'EPSG:4326', group: '范围',
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116.2, 39.7], [116.6, 39.7], [116.6, 40.1], [116.2, 40.1], [116.2, 39.7]]] }, properties: {} },
  ] },
}
const heatLayer = {
  id: 'hot', name: '热力分布', visible: true, opacity: 1,
  sourceCrs: 'EPSG:4326',
  symbol: { presentation: 'heatmap', heatmap: { ramp: 'viridis', radiusPx: 20 }, symbolVersion: 'sv1' },
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.39, 39.9] }, properties: { weight: 5 } },
  ] },
}
const annotationLayer = {
  id: 'annotations', name: '用户标记', role: 'user-annotation' as const, visible: true, opacity: 1,
  sourceCrs: 'EPSG:4326',
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'a1', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: '待核查点', description: '现场复核', dshUpdatedAt: '2026-11-01T08:00:00.000Z' } },
    { type: 'Feature', id: 'a2', geometry: { type: 'LineString', coordinates: [[116.3, 39.8], [116.5, 40.0]] }, properties: { name: '巡查路线', dshUpdatedAt: '2026-11-01T08:00:00.000Z' } },
  ] },
}
const proposalLayer = {
  id: 'proposals', name: '模型候选', role: 'visual-proposal' as const, visible: true, opacity: 1,
  sourceCrs: 'EPSG:4326', data: { type: 'FeatureCollection', features: [] },
}
const changeLayer = {
  id: 'changes', name: '视觉变化', role: 'visual-change' as const, visible: true, opacity: 1,
  sourceCrs: 'EPSG:4326', data: { type: 'FeatureCollection', features: [] },
}
const styledLayer = {
  id: 'scored', name: '评分图层', visible: true, opacity: 1, sourceCrs: 'EPSG:4326', resourceRef: 'res-scored-v1',
  style: {
    methodVersion: 'spatial-viz@1', field: 'score', unit: '分', measure: 'total', seriesIdentity: 'observed', encoding: 'fill',
    classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
    palette: ['#f7fbff', '#6baed6', '#08306b'], missingColor: '#bdbdbd', overflowColor: '#616161', missingLabel: 'no data',
    styleVersion: 'style-a',
  },
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 's1', geometry: { type: 'Point', coordinates: [116.39, 39.9] }, properties: { score: 5 } },
    { type: 'Feature', id: 's2', geometry: { type: 'Point', coordinates: [116.4, 39.91] }, properties: { score: 15 } },
    { type: 'Feature', id: 's3', geometry: { type: 'Point', coordinates: [116.41, 39.92] }, properties: { score: 25 } },
  ] },
}

const baseWire = {
  layers: [styledLayer, geojsonLayer, polyLayer, heatLayer, annotationLayer, proposalLayer, changeLayer],
  view: { center: [116.39, 39.9], zoom: 12, wkid: 4326 },
  interaction,
  mode: 'map',
  basemap: { schemaVersion: 1, basemap: source, labels },
  imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  aoi: null, revision: 7, operations: [], observationRequest: null,
  latestObservation: observation,
  observationHistory: [observation],
  visualProposals: [proposal],
  visualChanges: [change],
  undoableAnnotation: null,
} satisfies MapContainerWire

const useResource = (() => ({
  status: 'live',
  value: {
    schemaVersion: 1, catalogVersion: 'cat-1', canChange: true,
    context: { provider: null, at: null, zoom: null },
    sources: [source, wayback, labels], nextCursor: null,
  },
})) as LayerPanelProps['useResource']

const changeSubmit = (async () => ({ ok: true as const, revision: 8 })) as NonNullable<LayerPanelProps['changeSubmit']>
const imageUrl = (async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==') as NonNullable<LayerPanelProps['imageUrl']>

const noopOccurrence = (): MapOccurrence => ({
  sourceFailure: () => null,
  retrySource: () => {},
  getRenderReceipt: () => { throw new Error('unused') },
  getPersistedRenderReceipt: () => null,
  getGestureMetrics: () => { throw new Error('unused') },
  submitGestureObservation: () => 'no-view',
  mount: () => {},
  refresh: () => {},
  focusLayer: () => {},
  focusFeature: () => {},
  setTimeFrame: () => {},
  setHighlight: () => {},
  captureView: () => Promise.reject(new Error('unused')),
  runMapUse: () => Promise.resolve(),
  stopMapUse: () => {},
  startAnnotationDrawing: () => Promise.resolve('no-view'),
  startAnnotationEditing: () => Promise.resolve('no-view'),
  cancelAnnotationDrawing: () => false,
  annotationDrawingState: () => ({ status: 'idle', kind: null, lastError: null }),
  mapControlState: () => null,
  zoomBy: () => 'no-view',
  resetBearing: () => 'no-view',
  dispose: () => {},
})

function panelProps(surface: LayerPanelProps['surface'], t: LayerPanelProps['t'] = translate): LayerPanelProps {
  return {
    surface, wire: baseWire, sessionId: 'fixture', occurrenceKey: 'view:map',
    occurrence: noopOccurrence, t,
    useResource, changeSubmit, panelSubmit: undefined, imageUrl,
    liveViewport: { center: [116.39, 39.9], extent: [0, 0, 1, 1], wkid: 4326, zoom: 12, mode: 'map' },
  }
}

const binding: MapSessionBinding = {
  tabs: { subscribe: () => () => {}, getSnapshot: () => [] },
  owns: () => true,
  ensure: () => {},
  open: () => true,
  dispose: () => {},
}

function Cell({ label, wide, conversation, auditId, children }: {
  readonly label: string
  readonly wide?: boolean
  readonly conversation?: boolean
  readonly auditId?: string
  readonly children: ReactNode
}): ReactNode {
  return <div className={conversation === true ? 'cell conversation-cell' : 'cell'} data-wide={wide === true ? '' : undefined} data-audit-cell={auditId}>
    <div className="cell-label">{label}</div>
    {children}
  </div>
}

function MapSurface({ status, rail, children }: { readonly status?: ReactNode; readonly rail?: boolean; readonly children?: ReactNode }): ReactNode {
  return <div data-map-container="">
    {status}
    <div data-map-rail={rail === true ? 'wide' : undefined} data-map-overlay-content="">{children}</div>
  </div>
}

/** Real-click surface for the vendor control groups; writes land in a DOM readout. */
function MapboxControlsAudit(): ReactNode {
  const [calls, setCalls] = useState<string[]>([])
  const occurrence = useMemo<MapOccurrence>(() => ({
    ...noopOccurrence(),
    mapControlState: () => ({ rotation: 30, scaleLabel: '5 km', zoom: 10 }),
    zoomBy: delta => { setCalls(value => [...value, `zoom:${delta}`]); return 'applied' },
    resetBearing: () => { setCalls(value => [...value, 'bearing']); return 'applied' },
  }), [])
  return <div data-map-container="">
    <span data-mapbox-control-calls="">{calls.join(',')}</span>
    <div data-map-canvas=""><div className="esri-view-attribution">Esri, HERE, Garmin, FAO, NOAA, USGS</div></div>
    <div data-map-overlay-content="">
      <MapboxControls occurrence={() => occurrence} t={translate} />
    </div>
  </div>
}

const START_ARGS = '{"name":"重点点位","layer_id":"points","path":"data/points.geojson"}'
const RESULT_TEXT = '{"layer":{"name":"重点点位","featureCount":2},"bbox":[116.3,39.8,116.5,40.0],"total_layers":3}'

function startedBlock(name: string, argsRaw: string): ToolCallBlock {
  return {
    phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name, argsRaw,
    turn: 1, step: 1, time: 0, subCalls: [],
  }
}

function preparingBlock(name: string): ToolCallBlock {
  return {
    phase: 'preparing', args: new PartialArguments(), callId: 'c1', name,
    turn: 1, step: 1, time: 0, subCalls: [],
  }
}

function resultBlock(name: string, argsRaw: string, over: Partial<ToolResultNode> = {}): ToolCallBlock {
  return {
    kind: 'tool-result', seq: 1, time: 0, callId: 'c1', name, turn: 1, step: 1,
    args: PartialArguments.fromText(argsRaw), call: { name, argsRaw }, callTime: 0,
    content: [], isError: false, subCalls: [], ...over,
  }
}

function ToolCards(): ReactNode {
  const cases: { label: string; tool: string; phase: 'preparing' | 'start' | 'result'; block: ToolCallBlock }[] = [
    { label: 'map_add_layer · running', tool: 'map_add_layer', phase: 'start', block: startedBlock('map_add_layer', START_ARGS) },
    { label: 'map_add_layer · ok', tool: 'map_add_layer', phase: 'result', block: resultBlock('map_add_layer', START_ARGS, { content: [{ type: 'text', text: RESULT_TEXT }] }) },
    { label: 'map_add_layer · error', tool: 'map_add_layer', phase: 'result', block: resultBlock('map_add_layer', START_ARGS, { isError: true, error: { name: 'SpatialError', code: 'SOURCE_POLICY_DENIED', reason: '来源未获许可' }, content: [{ type: 'text', text: 'SOURCE_POLICY_DENIED: 来源未获自动操作许可' }] }) },
    { label: 'map_observe · ok', tool: 'map_observe', phase: 'result', block: resultBlock('map_observe', '{"timeout_ms":5000}', { call: { name: 'map_observe', argsRaw: '{"timeout_ms":5000}' }, content: [{ type: 'text', text: '{"revision":7,"observation_id":"obs-1","image":{"width":640,"height":480},"sources":["esri-world-imagery"],"positioning":"affine-2d"}' }] }) },
    { label: 'map_use · stopped', tool: 'map_use', phase: 'result', block: resultBlock('map_use', '{"action":"pan","dx_px":60,"dy_px":40}', { call: { name: 'map_use', argsRaw: '{"action":"pan","dx_px":60,"dy_px":40}' }, error: { name: 'Interrupted', code: 'interrupted' }, isError: true, content: [] }) },
    { label: 'map_get_state · preparing', tool: 'map_get_state', phase: 'preparing', block: preparingBlock('map_get_state') },
  ]
  return <div className="tool-stack">{cases.map((c, i) => (
    <div key={i} style={{ marginBottom: 8 }}>
      <div className="case-label">{c.label}</div>
      <MapToolCard toolName={c.tool} phase={c.phase} block={c.block} t={translate} inspect={i === 1 ? () => {} : undefined} />
    </div>
  ))}</div>
}

function Audit(): ReactNode {
  return <div className="stage">
    <Cell label="MapToolCard · all states" wide conversation auditId="tools"><ToolCards /></Cell>
    <Cell label="MapboxControls · official control groups" auditId="mapbox-controls"><MapboxControlsAudit /></Cell>
    <Cell label="FeatureCard + collapsed annotation" auditId="feature-card">
      <MapSurface>
        <UserAnnotationPanel {...panelProps('annotation')} />
        <FeatureCard inspection={{ layerId: 'points', layerName: '重点点位', featureId: 'f1', title: '北京站', fields: [{ name: 'name', value: '北京站' }, { name: 'level', value: 'S1' }, { name: 'address', value: '北京市东城区' }], omitted: 2, anchor: { left: 360, top: 120, right: 380, bottom: 150 } }} onClose={() => {}} t={translate} />
      </MapSurface>
    </Cell>
    <Cell label="FeatureCard · empty"><MapSurface><FeatureCard inspection={{ layerId: 'x', layerName: '无属性层', featureId: 'f', title: null, fields: [], omitted: 0, anchor: { left: 260, top: 120, right: 280, bottom: 150 } }} onClose={() => {}} t={translate} /></MapSurface></Cell>
    <Cell label="FeatureCard · floating-DOM collision" auditId="feature-collision">
      <MapSurface status={<MapUseStatus interaction={baseWire.interaction} onStop={() => {}} t={translate} />}>
        <UserAnnotationPanel {...panelProps('annotation')} open />
        <FeatureCard inspection={{ layerId: 'roads', layerName: '道路', featureId: 'r1', title: '东三环', fields: [{ name: 'name', value: '东三环' }, { name: 'level', value: 'S1' }], omitted: 0, anchor: { left: 320, top: 180, right: 340, bottom: 210 } }} onClose={() => {}} t={translate} />
      </MapSurface>
    </Cell>
    <Cell label="MapUseStatus"><MapSurface status={<MapUseStatus interaction={baseWire.interaction} onStop={() => {}} t={translate} />} /></Cell>
    <Cell label="MapUseStatus · stopped"><MapSurface status={<MapUseStatus interaction={{ ...baseWire.interaction, stopped: { reason: 'user-interrupted' } }} onStop={() => {}} t={translate} />} /></Cell>
    <Cell label="MapSessionAction" conversation auditId="session-action"><MapSessionAction sessionId={SessionId('s1')} binding={binding} useSession={selector => selector({ blank: false })} t={translate} /></Cell>
    <Cell label="LayerPanel · resident card (unified sections)" wide auditId="rail"><MapSurface rail><div data-map-resident-mount="">
      <UnifiedMapPanel {...panelProps('unified')} open onOpenChange={() => {}} />
    </div></MapSurface></Cell>
    <Cell label="LayerPanel · resident card (collapsed title bar)" wide auditId="rail-open"><MapSurface rail><div data-map-resident-mount="">
      <UnifiedMapPanel {...panelProps('unified')} open={false} onOpenChange={() => {}} />
    </div></MapSurface></Cell>
    <Cell label="LayerPanel · unified sections" wide auditId="unified"><ResidentAudit /></Cell>
    <Cell label="LayerPanel · AI" wide><MapSurface><AIDataLayerPanel {...panelProps('ai')} open /></MapSurface></Cell>
    <Cell label="LayerPanel · annotation" wide><MapSurface><UserAnnotationPanel {...panelProps('annotation')} open /></MapSurface></Cell>
    <Cell label="LayerPanel · imagery" wide auditId="imagery"><MapSurface><ImageryResourcePanel {...panelProps('imagery')} open /></MapSurface></Cell>
    <Cell label="LayerPanel · compact collapsed bar (en)" auditId="compact-band">
      <MapSurface>
        <UnifiedMapPanel {...panelProps('unified', translateEn)} open={false} onOpenChange={() => {}} />
      </MapSurface>
    </Cell>
    <Cell label="LayerPanel · compact unified card" auditId="compact-open">
      <MapSurface>
        <UnifiedMapPanel {...panelProps('unified', translateEn)} open onOpenChange={() => {}} />
      </MapSurface>
    </Cell>
  </div>
}

/** The stateful desktop resident card: collapse, expand, and drag all toggle real state. */
function ResidentAudit(): ReactNode {
  const [open, setOpen] = useState(true)
  return <MapSurface><UnifiedMapPanel {...panelProps('unified')} open={open} onOpenChange={setOpen} /></MapSurface>
}

function MobileAudit(): ReactNode {
  const [open, setOpen] = useState(false)
  return <MapSurface status={<MapUseStatus interaction={baseWire.interaction} onStop={() => {}} t={translate} />}>
    <div data-map-resident-mount="">
      <UnifiedMapPanel {...panelProps('unified')} open={open} onOpenChange={setOpen} />
    </div>
  </MapSurface>
}

/** Narrow standalone audit for the vendor control groups at 390px touch width. */
function ControlsOnlyStage(): ReactNode {
  return <div className="stage">
    <Cell label="MapboxControls · official control groups" auditId="mapbox-controls"><MapboxControlsAudit /></Cell>
  </div>
}

installMapTheme()
const AUDIT_STYLE = document.createElement('style')
AUDIT_STYLE.textContent = `
  body { margin: 0; padding: 16px; background: var(--dsw-alias-bg-layer-2, #f5f7fa); color: var(--dsw-alias-label-primary, #1f2329); }
  .stage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
  .cell { outline: 1px dashed #9999; padding: 8px; min-width: 0; }
  .cell-label, .case-label { font: 11px/1.4 monospace; color: #888; margin-bottom: 6px; }
  .conversation-cell { background: var(--dsw-alias-bg-layer-1, #fff); }
  /* Each cell is a fixed-height map surface so absolute overlays stay inside it. */
  .cell [data-map-container] { position: relative; height: 320px; overflow: hidden; border: 1px solid #ccc; }
  .cell[data-wide] { grid-column: 1 / -1; }
  .cell[data-wide] [data-map-container] { height: 360px; }
  .cell[data-audit-cell="rail"] [data-map-container] { height: 720px; }
  .cell[data-audit-cell="rail"] [data-map-panel-section] { scroll-margin: 8px; }
  @media (min-width: 421px) { .cell[data-audit-cell="rail"] [data-map-container] { min-width: 421px; } }
  .cell[data-audit-cell="feature-card"] [data-map-container] { height: 380px; }
  .cell[data-audit-cell^="compact-"] [data-map-container] { width: 500px; height: 380px; }
  .tool-stack { padding: 8px; }
  .tool-stack [data-map-tool-card] { margin-bottom: 6px; }
  /* Keep the vendor 2px ring on the control groups inside the audit cell. */
  .cell[data-audit-cell="mapbox-controls"] [data-mapbox-ctrl-group] { box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.1); }
  .cell[data-audit-cell="mapbox-controls"] [data-mapbox-control-calls] { display: block; font: 10px/1.4 monospace; color: #333; padding: 2px 6px; }
  @media (max-width: 720px) { .stage { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 420px) { body { margin: 0; padding: 0; } }
`
document.head.append(AUDIT_STYLE)

const mobile = window.matchMedia('(max-width: 420px)').matches
const controlsOnly = new URLSearchParams(window.location.search).has('mapbox-controls')
const stage = controlsOnly ? ControlsOnlyStage : mobile ? MobileAudit : Audit
createRoot(document.getElementById('root')!).render(createElement(stage))
