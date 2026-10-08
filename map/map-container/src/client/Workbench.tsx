/**
 * The visualization workbench panel: the legend derived from each styled
 * layer's own StyleSpec, the deterministic time axis (play/pause/step driven
 * entirely by this component's timers — never a model channel), the class
 * histogram whose bars brush the shared selection, the paginated attribute
 * table, and the fixed-revision export.
 *
 * All five surfaces derive from one selection filter (style version + data
 * identity + pinned frame + brush), so the map highlight, the table, the
 * chart, and the export cannot disagree. Copy is locale-owned; the chart and
 * legend carry text ranges beside color, and point classes graduate by size —
 * the non-color encodings.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  MAX_ATTRIBUTE_ROWS,
  attributeRowsOf,
  axisAdvance,
  axisGoto,
  axisPause,
  axisPlay,
  axisStep,
  createTimeAxis,
  currentFrame,
  dataRefOf,
  exportManifestOf,
  filterRevisionOf,
  formatFrameLabel,
  framesOf,
  histogramOf,
  legendOf,
  selectFeatureIds,
  selectionFilterOf,
  TimelineError,
  type StyleSpec,
  type TimeAxisState,
  type WorkbenchFeature,
} from '@map-harness/spatial-viz'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence } from './face.ts'

/** Rows one attribute-table page shows. */
const TABLE_PAGE_SIZE = 8

/** The play-driver tick in ms; a UI cadence, not a protocol value. */
const PLAY_TICK_MS = 1200

/** Format one class bound for labels: six decimals, trailing zeros trimmed. */
function fmt(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return String(rounded)
}

/** One styled layer face for the workbench: the layer plus its derived legend. */
interface StyledLayer {
  readonly id: string
  readonly name: string
  readonly style: StyleSpec
  readonly features: readonly WorkbenchFeature[]
  readonly dataRef: string
}

/** Collect the styled layers in layer order with their derived legends' inputs. */
function styledLayersOf(wire: MapContainerWire): StyledLayer[] {
  const styled: StyledLayer[] = []
  for (const layer of wire.layers) {
    if (layer.style === undefined || layer.visible === false) continue
    const dataRef = dataRefOf(layer)
    if (dataRef === null) continue
    const data = layer.data as { features?: WorkbenchFeature[] } | null
    if (data === null || !Array.isArray(data.features)) continue
    styled.push({
      id: layer.id,
      name: layer.name,
      style: layer.style,
      features: data.features,
      dataRef,
    })
  }
  return styled
}

/**
 * Render the workbench panel under the map.
 * @param props - the projection wire, the occurrence getter, and the locale seat.
 * @returns the workbench region.
 */
export function Workbench({ wire, occurrence, t }: {
  readonly wire: MapContainerWire
  readonly occurrence: () => MapOccurrence | null
  readonly t: TranslateNS<'mapContainer'>
}): ReactNode {
  const styledLayers = useMemo(() => styledLayersOf(wire), [wire])
  const active = styledLayers[0]
  const binding = active?.style.timeBinding

  // ── time axis ────────────────────────────────────────────────────────
  const [axisError, setAxisError] = useState<string | null>(null)
  const [axis, setAxis] = useState<TimeAxisState | null>(null)
  const axisBindingKey = binding === undefined ? '' : `${binding.timeField}|${binding.timezone}|${binding.granularity}|${binding.window.from}|${binding.window.to}`
  const observedRef = useRef('')
  useEffect(() => {
    if (binding === undefined || active === undefined) {
      observedRef.current = ''
      setAxis(null)
      setAxisError(null)
      return
    }
    // Frames derive from the frozen feature set: recompute only when the
    // binding or the data identity changes, never on unrelated renders.
    const observedKey = `${axisBindingKey}|${active.dataRef}|${active.features.length}`
    if (observedRef.current === observedKey) return
    observedRef.current = observedKey
    try {
      const observed = active.features.map(feature => {
        const raw = feature.properties?.[binding.timeField]
        return typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      })
      setAxis(createTimeAxis(framesOf(binding, observed)))
      setAxisError(null)
    } catch (error) {
      setAxis(null)
      setAxisError(error instanceof TimelineError ? error.code : 'unknown')
    }
  }, [axisBindingKey, active])

  useEffect(() => {
    if (axis === null || !axis.playing) return
    const tick = setInterval(() => setAxis(previous => (previous === null ? previous : axisAdvance(previous))), PLAY_TICK_MS)
    return () => clearInterval(tick)
  }, [axis?.playing])

  const frame = axis === null ? null : currentFrame(axis) ?? null

  // ── brush + shared selection ─────────────────────────────────────────
  const [brush, setBrush] = useState<{ min: number; max: number } | null>(null)
  // Loading a temporal layer shows the full set; the axis pins the map only
  // after the user actually drives it (step/play/slider).
  const [axisTouched, setAxisTouched] = useState(false)
  const frameIndex = axis?.index ?? 0
  const pinnedFrame = axisTouched ? frame : null
  const selection = useMemo(() => {
    if (active === undefined) return { filter: null, ids: [] as string[], revision: null as string | null }
    const filter = selectionFilterOf({
      style: active.style,
      dataRef: active.dataRef,
      frame: pinnedFrame === null ? null : { index: frameIndex, startMs: pinnedFrame.startMs, endMs: pinnedFrame.endMs, occupied: pinnedFrame.occupied },
      brush,
    })
    return { filter, ids: selectFeatureIds(active.features, filter, active.style, binding ?? null), revision: filterRevisionOf(filter) }
  }, [active, pinnedFrame, frameIndex, brush, binding])

  // Push the pinned frame and the shared selection onto the live map.
  const occurrenceRef = useRef(occurrence)
  occurrenceRef.current = occurrence
  const selectionIds = selection.ids
  const selectionKey = selectionIds.join('|')
  const hasConstraint = brush !== null || pinnedFrame !== null
  useEffect(() => {
    // Without a brush or a pinned frame the filter matches everything, which
    // is not a highlight: only constrained selections reach the map.
    occurrenceRef.current()?.setHighlight(active?.id ?? '', hasConstraint ? new Set(selectionIds) : new Set())
  }, [active?.id, selectionKey, hasConstraint])

  useEffect(() => {
    occurrenceRef.current()?.setTimeFrame(pinnedFrame === null ? null : { index: frameIndex, startMs: pinnedFrame.startMs, endMs: pinnedFrame.endMs })
  }, [pinnedFrame?.startMs, pinnedFrame?.endMs, frameIndex])

  // ── attribute table ──────────────────────────────────────────────────
  const [page, setPage] = useState(0)
  const table = useMemo(() => {
    if (active === undefined) return null
    const fields = [active.style.field, ...(active.style.denominatorField === undefined ? [] : [active.style.denominatorField])]
    return attributeRowsOf(active.features, fields)
  }, [active])
  const totalPages = table === null ? 0 : Math.max(Math.ceil(table.rows.length / TABLE_PAGE_SIZE), 1)
  const pageRows = table === null ? [] : table.rows.slice(page * TABLE_PAGE_SIZE, (page + 1) * TABLE_PAGE_SIZE)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const toggleSelected = (id: string): void => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── export ───────────────────────────────────────────────────────────
  const [exportStatus, setExportStatus] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)
  const exportView = (): void => {
    if (active === undefined) {
      setExportStatus({ ok: false, text: t('workbench.export.renderBlocked') })
      return
    }
    if (occurrenceRef.current() === null) {
      setExportStatus({ ok: false, text: t('workbench.export.renderBlocked') })
      return
    }
    const failures = styledLayers
      .filter(layer => layer.features.length === 0)
      .map(layer => ({ kind: 'data' as const, layerId: layer.id, detail: 'the layer carries no features' }))
    const manifest = exportManifestOf({
      mapRevision: wire.revision,
      frame: pinnedFrame === null
        ? null
        : { ...pinnedFrame, index: frameIndex, timezone: binding?.timezone ?? 'UTC', granularity: binding?.granularity ?? 'day' },
      filterRevision: selection.revision,
      layers: styledLayers.map(layer => ({
        layerId: layer.id,
        name: layer.name,
        styleVersion: layer.style.styleVersion,
        dataRef: layer.dataRef.startsWith('display:') ? null : layer.dataRef,
        displayDigest: layer.dataRef.startsWith('display:') ? layer.dataRef.slice('display:'.length) : null,
        featureCount: layer.features.length,
      })),
      failures,
    })
    setExportStatus({
      ok: true,
      text: t('workbench.export.done', { revision: String(manifest.mapRevision), filter: manifest.filterRevision ?? '—' }),
    })
    try {
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `map-export-r${manifest.mapRevision}${manifest.filterRevision === null ? '' : `-${manifest.filterRevision}`}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      // The manifest status stands on its own when the environment refuses
      // programmatic downloads (kiosk profiles, sandboxed iframes).
    }
  }

  if (active === undefined) return null
  const legend = legendOf(active.style)
  const bins = histogramOf(legend, active.style, active.features.map(feature => {
    const raw = feature.properties?.[active.style.field]
    const denominator = active.style.denominatorField === undefined ? undefined : feature.properties?.[active.style.denominatorField]
    if (active.style.denominatorField !== undefined) {
      const numerator = typeof raw === 'number' ? raw : Number.NaN
      const denominatorValue = typeof denominator === 'number' ? denominator : Number.NaN
      return Number.isFinite(denominatorValue) && denominatorValue > 0 ? numerator / denominatorValue : Number.NaN
    }
    return typeof raw === 'number' ? raw : Number.NaN
  }))
  const maxCount = Math.max(...bins.map(bin => bin.count), 1)
  const measureKey = `workbench.legend.measure.${active.style.measure}` as const
  const identityKey = `workbench.legend.identity.${active.style.seriesIdentity}` as const

  return (
    <div
      data-map-workbench=""
      role="region"
      aria-label={t('workbench.status.region')}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '46%', overflowY: 'auto', background: 'rgba(255,255,255,0.94)', borderTop: '1px solid #d0d0d0', padding: '6px 10px', fontSize: 12, zIndex: 1 }}
    >
      <p role="status" aria-live="polite" style={{ margin: '0 0 4px' }}>
        {selection.ids.length > 0
          ? t('workbench.table.selected', { count: String(selection.ids.length) })
          : t('workbench.status.region')}
        {pinnedFrame !== null && binding !== undefined
          ? ` · ${formatFrameLabel(pinnedFrame, binding.timezone, binding.granularity)}${pinnedFrame.occupied ? '' : ` (${t('workbench.timeline.unoccupied')})`}`
          : ''}
      </p>

      <section data-workbench-legend="" aria-label={t('workbench.legend')} style={{ marginBottom: 4 }}>
        <h3 style={{ margin: '2px 0' }}>{t('workbench.legend')} — {active.style.field} ({t(measureKey)}, {active.style.unit}, {t(identityKey)})</h3>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {legend.rows.map((row, at) => {
            const bin = bins[at]
            const label = row.kind === 'class'
              ? (row.toInclusive
                ? t('workbench.legend.rangeTop', { from: fmt(row.from), unit: active.style.unit })
                : t('workbench.legend.range', { from: fmt(row.from), to: fmt(row.to), unit: active.style.unit }))
              : row.kind === 'missing'
                ? t('workbench.legend.missing')
                : row.kind === 'underflow'
                  ? t('workbench.legend.underflow')
                  : t('workbench.legend.overflow')
            return (
              <li key={`${row.kind}-${at}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span
                  role="img"
                  aria-label={label}
                  title={label}
                  style={{
                    display: 'inline-block', width: 14, height: 14,
                    background: row.color,
                    border: '1px solid #666',
                    borderStyle: row.kind === 'missing' ? 'dashed' : 'solid',
                  }}
                />
                <span>
                  {label}
                  {' '}
                  {bin !== undefined ? `(${t('workbench.legend.count', { count: String(bin.count) })})` : ''}
                </span>
              </li>
            )
          })}
        </ul>
        <p style={{ margin: '2px 0 0' }}>
          {active.style.encoding === 'size' ? t('workbench.legend.encodingSize') : t('workbench.legend.encodingFill')}
          {active.style.unifiedDomain === true ? ` · ${t('workbench.legend.unifiedDomain')}` : ''}
        </p>
      </section>

      {binding !== undefined && axis !== null && (
        <section data-workbench-timeline="" aria-label={t('workbench.timeline.title')} style={{ marginBottom: 4 }}>
          <h3 style={{ margin: '2px 0' }}>
            {t('workbench.timeline.title')} — {t('workbench.timeline.frame', { n: String(axis.index + 1), total: String(axis.frames.length) })}
            {frame !== null && !frame.occupied ? ` · ${t('workbench.timeline.unoccupied')}` : ''}
          </h3>
          <div role="group" aria-label={t('workbench.timeline.title')} style={{ display: 'flex', gap: 6 }}>
            <button type="button" aria-label={t('workbench.timeline.prev')} onClick={() => { setAxisTouched(true); setAxis(previous => (previous === null ? previous : axisStep(previous, -1))) }}>◀</button>
            {axis.playing
              ? <button type="button" aria-label={t('workbench.timeline.pause')} onClick={() => { setAxisTouched(true); setAxis(previous => (previous === null ? previous : axisPause(previous))) }}>⏸</button>
              : <button type="button" aria-label={t('workbench.timeline.play')} onClick={() => { setAxisTouched(true); setAxis(previous => (previous === null ? previous : axisPlay(previous))) }}>▶</button>}
            <button type="button" aria-label={t('workbench.timeline.next')} onClick={() => { setAxisTouched(true); setAxis(previous => (previous === null ? previous : axisStep(previous, 1))) }}>▶▶</button>
            <input
              type="range"
              aria-label={t('workbench.timeline.title')}
              min={0}
              max={Math.max(axis.frames.length - 1, 0)}
              value={axis.index}
              onChange={event => { setAxisTouched(true); setAxis(previous => (previous === null ? previous : axisGoto(previous, Number(event.target.value)))) }}
            />
          </div>
        </section>
      )}
      {axisError !== null && (
        <p role="alert" style={{ margin: '2px 0' }}>timeline: {axisError}</p>
      )}

      <section data-workbench-chart="" aria-label={t('workbench.chart.title')} style={{ marginBottom: 4 }}>
        <h3 style={{ margin: '2px 0' }}>{t('workbench.chart.title')}</h3>
        <div role="group" aria-label={t('workbench.chart.title')} style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
          {bins.map((bin, at) => {
            const textLabel = bin.kind === 'class'
              ? t('workbench.chart.bar', { n: String((bin.classIndex ?? 0) + 1), count: String(bin.count), from: fmt(bin.from ?? 0), to: fmt(bin.to ?? 0) })
              : `${bin.kind}: ${bin.count}`
            const brushed = brush !== null && bin.kind === 'class' && brush.min === bin.from
            return (
              <button
                key={`${bin.kind}-${at}`}
                type="button"
                aria-label={textLabel}
                aria-pressed={brushed}
                title={textLabel}
                onClick={() => {
                  if (bin.kind !== 'class') return
                  setBrush(previous => (previous !== null && previous.min === bin.from ? null : { min: bin.from ?? 0, max: bin.to ?? 0 }))
                }}
                style={{
                  width: 34, height: `${Math.max((bin.count / maxCount) * 48, 2)}px`,
                  background: bin.color, border: brushed ? '2px solid #222' : '1px solid #666',
                  padding: 0, cursor: bin.kind === 'class' ? 'pointer' : 'default',
                }}
              >
                <span style={{ fontSize: 9 }}>{bin.count}</span>
              </button>
            )
          })}
        </div>
        {brush !== null && (
          <p style={{ margin: '2px 0 0' }}>
            {t('workbench.chart.brush', { from: fmt(brush.min), to: fmt(brush.max) })}{' '}
            <button type="button" aria-label={t('workbench.chart.clear')} onClick={() => setBrush(null)}>{t('workbench.chart.clear')}</button>
          </p>
        )}
      </section>

      {table !== null && (
        <section data-workbench-table="" aria-label={t('workbench.table.title')} style={{ marginBottom: 4 }}>
          <h3 style={{ margin: '2px 0' }}>
            {t('workbench.table.title')} — {t('workbench.table.page', { page: String(page + 1), pages: String(totalPages) })}
          </h3>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <caption className="visually-hidden" style={{ display: 'none' }}>{t('workbench.table.title')}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left' }}>{t('workbench.table.featureColumn')}</th>
                <th scope="col" style={{ textAlign: 'left' }}>{active.style.field}</th>
                {active.style.denominatorField !== undefined && <th scope="col" style={{ textAlign: 'left' }}>{active.style.denominatorField}</th>}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(row => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      aria-label={t('workbench.table.select', { id: row.id })}
                      aria-pressed={selectedIds.has(row.id)}
                      onClick={() => toggleSelected(row.id)}
                    >
                      {selectedIds.has(row.id) ? '☑' : '☐'} {row.id}
                    </button>
                  </td>
                  <td>{row.values[0] === null ? t('workbench.legend.missing') : String(row.values[0])}</td>
                  {active.style.denominatorField !== undefined && <td>{row.values[1] === null ? '—' : String(row.values[1])}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" aria-label={t('workbench.table.prevPage')} disabled={page === 0} onClick={() => setPage(previous => Math.max(previous - 1, 0))}>◀</button>
            <button type="button" aria-label={t('workbench.table.nextPage')} disabled={page >= totalPages - 1} onClick={() => setPage(previous => Math.min(previous + 1, totalPages - 1))}>▶</button>
          </div>
          {table.truncated > 0 && (
            <p role="note">{t('workbench.table.truncated', { max: String(MAX_ATTRIBUTE_ROWS) })}</p>
          )}
        </section>
      )}

      <section data-workbench-export="" aria-label={t('workbench.export.button')} style={{ marginBottom: 4 }}>
        <button type="button" data-workbench-export-button="" aria-label={t('workbench.export.button')} onClick={exportView}>
          {t('workbench.export.button')}
        </button>
        {exportStatus !== null && (
          <p role="status" data-workbench-export-status="" style={{ margin: '2px 0 0' }}>{exportStatus.text}</p>
        )}
      </section>

      <section data-workbench-history="" aria-label={t('workbench.history.title')} style={{ marginBottom: 2 }}>
        <h3 style={{ margin: '2px 0' }}>
          {t('workbench.history.title')}
          {wire.aoi !== null ? ` · ${t('workbench.aoi.set')}${wire.aoi.name === undefined ? '' : `: ${wire.aoi.name}`}` : ` · ${t('workbench.aoi.none')}`}
        </h3>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {wire.operations.slice(-8).map(op => (
            <li key={op.index} data-workbench-history-entry="">
              {t('workbench.history.entry', {
                revision: String(op.revision),
                summary: op.summary,
                writer: op.writerId ?? t('workbench.history.system'),
              })}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
