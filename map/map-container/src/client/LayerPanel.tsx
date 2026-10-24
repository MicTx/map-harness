/**
 * The layer panel, laid out after the Mapbox layer list: a "Layers" button
 * at the map's top-right opens a floating panel; each layer is one compact
 * row with a drag handle, a type swatch, its name, and a visibility eye;
 * zoom-to and a "more" menu appear on hover or focus. Rows list top-drawn
 * layers first. Visibility, opacity, order, grouping, preset styles, and
 * removal write directly through the user change route and take effect
 * immediately; export still goes through the conversation as a queued
 * `[map-panel v1]` request because it produces a catalog artifact.
 * The panel never pre-stages map state: every control renders the wire.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MAX_ATTRIBUTE_ROWS } from '@map-harness/spatial-viz'
import { SYMBOL_PRESETS } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence } from './face.ts'
import type { PanelSubmit } from './gesture-submit.ts'
import type { PanelChange, PanelChangeSubmit } from './change-submit.ts'
import { PANEL_TEXT_VERSION, serializePanelRequestText, type PanelExportFormat } from './panel-request.ts'
import {
  PANEL_ATTRIBUTE_PAGE_SIZE,
  PANEL_MAX_ATTRIBUTE_COLUMNS,
  panelAttributesOf,
  panelBadgeColorOf,
  panelBulkStateChange,
  panelClearOrder,
  panelFacesOf,
  type PanelLayerFace,
} from './panel-view.ts'

/** The four export formats the panel offers, in fixed order. */
const EXPORT_FORMATS: readonly PanelExportFormat[] = ['geojson', 'csv', 'kml', 'shapefile']

/** Opacity slider step; display granularity only. */
const OPACITY_STEP = 0.05

/** How long one status notice stays visible (a UI cadence, not a protocol value). */
const NOTICE_MS = 4_000

/** Panel props: the wire, identity, occurrence, locale, and both write seams. */
export interface LayerPanelProps {
  readonly wire: MapContainerWire
  readonly sessionId: string
  readonly occurrenceKey: string
  readonly occurrence: () => MapOccurrence | null
  readonly t: TranslateNS<'mapContainer'>
  readonly changeSubmit: PanelChangeSubmit | undefined
  readonly panelSubmit: PanelSubmit | undefined
}

/** One section of rows: a named group or the ungrouped tail. */
interface RowSection {
  readonly name: string | null
  readonly layers: readonly PanelLayerFace[]
}

/** Sections in top-first order; a group sits where its topmost member sits. */
function sectionsOf(faces: readonly PanelLayerFace[], search: string): readonly RowSection[] {
  const tokens = search.trim().toLowerCase().split(/\s+/u).filter(token => token.length > 0)
  const matches = (face: PanelLayerFace): boolean => tokens.length === 0
    || tokens.some(token => face.name.toLowerCase().includes(token) || (face.group ?? '').toLowerCase().includes(token))
  const sections: { name: string | null; layers: PanelLayerFace[] }[] = []
  for (const face of [...faces].reverse()) {
    if (!matches(face)) continue
    const existing = face.group === null ? undefined : sections.find(section => section.name === face.group)
    if (existing !== undefined) existing.layers.push(face)
    else sections.push({ name: face.group, layers: [face] })
  }
  return sections
}

/** The swatch color a row shows: its legend's first color, else a neutral token. */
function swatchOf(face: PanelLayerFace): { readonly kind: 'fill' | 'ramp' | 'none'; readonly colors: readonly string[] } {
  if (face.chip === null) return { kind: 'none', colors: [] }
  if (face.chip.kind === 'class') return { kind: 'ramp', colors: face.chip.colors }
  if (face.chip.kind === 'heatmap') return { kind: 'ramp', colors: face.chip.stops }
  return { kind: 'fill', colors: face.chip.rows.map(row => row.color) }
}

/**
 * Render the layer panel button and, when open, the floating panel.
 * @param props - see {@link LayerPanelProps}.
 * @returns the panel region or its toggle button.
 */
export function LayerPanel({ wire, sessionId, occurrenceKey, occurrence, t, changeSubmit, panelSubmit }: LayerPanelProps): ReactNode {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [tableFor, setTableFor] = useState<string | null>(null)
  const [attributePage, setAttributePage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)
  const [opacityDraft, setOpacityDraft] = useState<{ readonly layerId: string; readonly value: number } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Each applied change advances the revision; the clear sweep must submit
  // against the newest one, so it reads through a ref rather than the closure.
  const wireRef = useRef(wire)
  wireRef.current = wire
  const revisionNow = (): number => wireRef.current.revision

  const faces = useMemo(() => panelFacesOf(wire), [wire])
  const sections = useMemo(() => sectionsOf(faces, search), [faces, search])
  const groupNames = useMemo(() => [...new Set(faces.map(face => face.group).filter((name): name is string => name !== null))], [faces])
  const nameOf = (id: string): string => faces.find(face => face.id === id)?.name ?? id

  useEffect(() => () => { if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current) }, [])
  const flash = (ok: boolean, text: string): void => {
    setNotice({ ok, text })
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const reasonOf = (code: string): string => code === 'stale-revision'
    ? t('panel.change.stale')
    : code === 'layer-unknown' ? t('panel.change.unknown') : code === 'network' ? t('panel.change.network') : t('panel.change.other')

  /** Write one change directly; the wire reflects it when the host applies it. */
  const write = (change: PanelChange, summary: string): void => {
    if (changeSubmit === undefined || busy) return
    setBusy(true)
    void changeSubmit({ sessionId, revision: wire.revision, summary, change })
      .then(outcome => { if (!outcome.ok) flash(false, t('panel.change.failed', { reason: reasonOf(outcome.code) })) })
      .finally(() => setBusy(false))
  }

  const setVisible = (layers: readonly PanelLayerFace[], visible: boolean): void => {
    const targets = layers.filter(layer => layer.visible !== visible)
    if (targets.length === 0) return
    const names = targets.map(layer => layer.name).join('、')
    write(
      { op: 'set-layer-state', states: targets.map(layer => ({ layerId: layer.id, visible })) },
      t(visible ? 'panel.summary.show' : 'panel.summary.hide', { names }),
    )
  }

  /**
   * Remove every listed layer, one change at a time: the host applies each
   * change before answering, so the next step reads the revision the previous
   * one produced. A refusal stops the sweep and reports how many were removed.
   */
  const clearAll = async (): Promise<void> => {
    if (changeSubmit === undefined) return
    let removed = 0
    const order = panelClearOrder(faces)
    for (const layerId of order) {
      if (busy) break
      const outcome = await changeSubmit({
        sessionId,
        revision: revisionNow(),
        summary: t('panel.summary.remove', { name: nameOf(layerId) }),
        change: { op: 'remove-layer', layerId },
      })
      if (!outcome.ok) {
        flash(false, t('panel.clearAll.partial', { count: String(removed), reason: reasonOf(outcome.code) }))
        return
      }
      removed += 1
    }
    flash(true, t('panel.summary.clearAll', { count: String(removed) }))
  }

  /** Set every listed layer at once, summarised as one bulk action. */
  const setVisibleAll = (visible: boolean): void => {
    const change = panelBulkStateChange(faces, visible)
    if (change === null) return
    write(change, t(visible ? 'panel.summary.showAll' : 'panel.summary.hideAll'))
  }

  /** Move one layer to sit just above (in panel order) another, or by one step. */
  const moveLayer = (layerId: string, beforeId: string | null, step?: -1 | 1): void => {
    const drawOrder = wire.layers.map(layer => layer.id)
    const topFirst = [...drawOrder].reverse()
    const from = topFirst.indexOf(layerId)
    if (from === -1) return
    const next = topFirst.filter(id => id !== layerId)
    let at: number
    if (step !== undefined) at = Math.max(0, Math.min(next.length, from + step))
    else at = beforeId === null ? next.length : next.indexOf(beforeId)
    if (at < 0) return
    next.splice(at, 0, layerId)
    const layerIds = [...next].reverse()
    if (layerIds.every((id, index) => id === drawOrder[index])) return
    write({ op: 'reorder-layers', layerIds }, t('panel.summary.reorder', { names: layerIds.map(nameOf).join(' → ') }))
  }

  const requestExport = (layer: PanelLayerFace, format: PanelExportFormat): void => {
    if (panelSubmit === undefined) return
    const serialized = serializePanelRequestText({
      version: PANEL_TEXT_VERSION,
      sessionId,
      occurrenceKey,
      revision: wire.revision,
      requests: [{ id: `export-${Date.now().toString(36)}`, op: 'export', layer: layer.id, format }],
      at: new Date().toISOString(),
    })
    if (!serialized.ok) {
      flash(false, t('panel.request.refused'))
      return
    }
    flash(true, t('panel.request.exported'))
    void panelSubmit(sessionId, serialized.text, 'queue')
      .then(queued => { if (!queued) flash(false, t('panel.request.failed')) })
      .catch((_submissionError: unknown) => { flash(false, t('panel.request.failed')) })
  }

  /** Download one exact catalog version through the read-only artifact route. */
  const download = (ref: string): void => {
    flash(true, t('panel.download.starting'))
    void fetch(`/api/map/artifact?session=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(ref)}`)
      .then(async response => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { code?: string } | null
          flash(false, t('panel.download.failed', { code: payload?.code ?? String(response.status) }))
          return
        }
        const href = URL.createObjectURL(await response.blob())
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = ref
        anchor.click()
        URL.revokeObjectURL(href)
      })
      .catch((_networkError: unknown) => { flash(false, t('panel.download.failed', { code: 'network' })) })
  }

  const onDrop = (event: DragEvent, beforeId: string | null): void => {
    event.preventDefault()
    const id = dragging
    setDragging(null)
    setDropTarget(null)
    if (id !== null && id !== beforeId) moveLayer(id, beforeId)
  }

  if (!open) {
    return (
      <button type="button" data-map-panel-toggle="" aria-expanded={false} aria-label={t('panel.expand')} onClick={() => setOpen(true)}>
        <LayersIcon />
        <span>{t('panel.toggle')}</span>
        {faces.length > 0 && <span data-map-panel-count="">{faces.length}</span>}
      </button>
    )
  }

  const canWrite = changeSubmit !== undefined && !busy

  return (
    <section data-map-panel="" role="region" aria-label={t('panel.title')} aria-busy={busy}>
      <header data-map-panel-header="">
        <LayersIcon />
        <h2>{t('panel.title')}</h2>
        <span data-map-panel-meta="">{t('panel.layerCount', { count: String(faces.length) })}</span>
        <button type="button" data-map-panel-icon="" aria-label={t('panel.close')} title={t('panel.close')} onClick={() => setOpen(false)}>×</button>
      </header>

      {faces.length > 4 && (
        <input
          type="search"
          data-map-panel-search=""
          aria-label={t('panel.search.label')}
          placeholder={t('panel.search.label')}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      )}

      {faces.length > 0 && (
        <div data-map-panel-bulk="" role="group" aria-label={t('panel.bulk')}>
          <button type="button" disabled={!canWrite} onClick={() => setVisibleAll(true)}>{t('panel.showAll')}</button>
          <button type="button" disabled={!canWrite} onClick={() => setVisibleAll(false)}>{t('panel.hideAll')}</button>
          <button type="button" data-danger="" disabled={!canWrite} onClick={() => setConfirmClear(true)}>{t('panel.clearAll')}</button>
          <span data-map-panel-meta="">{t('panel.layerCount', { count: String(faces.length) })}</span>
        </div>
      )}

      {confirmClear && (
        <div data-map-panel-bulk-confirm="" role="group" aria-label={t('panel.clearAll.confirm', { count: String(faces.length) })}>
          <span>{t('panel.clearAll.confirm', { count: String(faces.length) })}</span>
          <button type="button" data-danger="" disabled={!canWrite} onClick={() => { setConfirmClear(false); void clearAll() }}>{t('panel.clearAll.confirm.button')}</button>
          <button type="button" onClick={() => setConfirmClear(false)}>{t('panel.removeCancel')}</button>
        </div>
      )}

      {notice !== null && <p role="status" data-map-panel-status="" data-ok={notice.ok ? '' : undefined}>{notice.text}</p>}

      {faces.length === 0 && <p data-map-panel-empty="">{t('panel.noLayers')}</p>}
      {faces.length > 0 && sections.length === 0 && <p data-map-panel-empty="">{t('panel.noMatches')}</p>}

      <div data-map-panel-list="" onDragOver={event => { if (dragging !== null) event.preventDefault() }} onDrop={event => onDrop(event, null)}>
        {sections.map(section => {
          const key = section.name ?? ''
          const grouped = section.name !== null
          const sectionOpen = !closedGroups.has(key)
          const allVisible = section.layers.every(layer => layer.visible)
          return (
            <div key={section.name ?? `ungrouped-${section.layers[0]?.id ?? ''}`} data-map-panel-group={grouped ? '' : undefined} aria-label={section.name ?? undefined}>
              {grouped && (
                <div data-map-panel-group-row="">
                  <button
                    type="button"
                    data-map-panel-caret=""
                    aria-expanded={sectionOpen}
                    onClick={() => setClosedGroups(previous => {
                      const next = new Set(previous)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })}
                  >
                    <span aria-hidden="true">{sectionOpen ? '▾' : '▸'}</span>
                    <span data-map-panel-name="">{section.name}</span>
                    <span data-map-panel-meta="">{t('panel.groupCount', { count: String(section.layers.length) })}</span>
                  </button>
                  <EyeButton
                    visible={allVisible}
                    disabled={!canWrite}
                    label={t(allVisible ? 'panel.groupHide' : 'panel.groupShow')}
                    onClick={() => setVisible(section.layers, !allVisible)}
                  />
                </div>
              )}
              {sectionOpen && section.layers.map(layer => (
                <LayerRow
                  key={layer.id}
                  layer={layer}
                  wire={wire}
                  t={t}
                  nested={grouped}
                  canWrite={canWrite}
                  canExport={panelSubmit !== undefined}
                  menuOpen={menuFor === layer.id}
                  onMenu={() => setMenuFor(menuFor === layer.id ? null : layer.id)}
                  tableOpen={tableFor === layer.id}
                  onTable={() => { setTableFor(tableFor === layer.id ? null : layer.id); setAttributePage(0); setMenuFor(null) }}
                  attributePage={attributePage}
                  onAttributePage={setAttributePage}
                  groupNames={groupNames}
                  dragging={dragging === layer.id}
                  dropTarget={dropTarget === layer.id}
                  onDragStart={() => setDragging(layer.id)}
                  onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                  onDragOver={() => { if (dragging !== null && dragging !== layer.id) setDropTarget(layer.id) }}
                  onDrop={event => onDrop(event, layer.id)}
                  onToggle={() => setVisible([layer], !layer.visible)}
                  onZoom={() => occurrence()?.focusLayer(layer.id)}
                  onFeature={featureId => occurrence()?.focusFeature(layer.id, featureId)}
                  onMove={step => { moveLayer(layer.id, null, step); setMenuFor(null) }}
                  opacity={opacityDraft?.layerId === layer.id ? opacityDraft.value : layer.opacity}
                  onOpacityDraft={value => setOpacityDraft({ layerId: layer.id, value })}
                  onOpacityCommit={value => {
                    setOpacityDraft(null)
                    if (Math.abs(value - layer.opacity) < 1e-9) return
                    write(
                      { op: 'set-layer-state', states: [{ layerId: layer.id, opacity: value }] },
                      t('panel.summary.opacity', { name: layer.name, value: String(Math.round(value * 100)) }),
                    )
                  }}
                  onPreset={preset => {
                    setMenuFor(null)
                    write(
                      { op: 'set-symbol-preset', layerId: layer.id, preset: preset.id },
                      t('panel.summary.preset', { name: layer.name, preset: preset.label }),
                    )
                  }}
                  onGroup={group => {
                    setMenuFor(null)
                    write(
                      { op: 'set-layer-state', states: [{ layerId: layer.id, group }] },
                      group === null ? t('panel.summary.ungroup', { name: layer.name }) : t('panel.summary.group', { name: layer.name, group }),
                    )
                  }}
                  onExport={format => { setMenuFor(null); requestExport(layer, format) }}
                  onDownload={ref => { setMenuFor(null); download(ref) }}
                  onRemove={() => {
                    setMenuFor(null)
                    write({ op: 'remove-layer', layerId: layer.id }, t('panel.summary.remove', { name: layer.name }))
                  }}
                />
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** The stacked-squares layers glyph. */
function LayersIcon(): ReactNode {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z" />
      <path d="m1.5 8.5 6.5 3.5 6.5-3.5" />
      <path d="m1.5 11 6.5 3.5 6.5-3.5" opacity="0.5" />
    </svg>
  )
}

/** The visibility eye: open when visible, struck through when hidden. */
function EyeButton({ visible, disabled, label, onClick }: { readonly visible: boolean; readonly disabled: boolean; readonly label: string; readonly onClick: () => void }): ReactNode {
  return (
    <button type="button" data-map-panel-icon="" data-map-panel-eye="" aria-pressed={visible} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
        {!visible && <path d="M2.5 13.5 13.5 2.5" />}
      </svg>
    </button>
  )
}

/** One layer row with its hover actions, menu, and attribute table. */
function LayerRow({ layer, wire, t, nested, canWrite, canExport, menuOpen, onMenu, tableOpen, onTable, attributePage, onAttributePage, groupNames, dragging, dropTarget, onDragStart, onDragEnd, onDragOver, onDrop, onToggle, onZoom, onFeature, onMove, opacity, onOpacityDraft, onOpacityCommit, onPreset, onGroup, onExport, onDownload, onRemove }: {
  readonly layer: PanelLayerFace
  readonly wire: MapContainerWire
  readonly t: TranslateNS<'mapContainer'>
  readonly nested: boolean
  readonly canWrite: boolean
  readonly canExport: boolean
  readonly menuOpen: boolean
  readonly onMenu: () => void
  readonly tableOpen: boolean
  readonly onTable: () => void
  readonly attributePage: number
  readonly onAttributePage: (page: number) => void
  readonly groupNames: readonly string[]
  readonly dragging: boolean
  readonly dropTarget: boolean
  readonly onDragStart: () => void
  readonly onDragEnd: () => void
  readonly onDragOver: () => void
  readonly onDrop: (event: DragEvent) => void
  readonly onToggle: () => void
  readonly onZoom: () => void
  readonly onFeature: (featureId: string) => void
  readonly onMove: (step: -1 | 1) => void
  readonly opacity: number
  readonly onOpacityDraft: (value: number) => void
  readonly onOpacityCommit: (value: number) => void
  readonly onPreset: (preset: { readonly id: string; readonly label: string }) => void
  readonly onGroup: (group: string | null) => void
  readonly onExport: (format: PanelExportFormat) => void
  readonly onDownload: (ref: string) => void
  readonly onRemove: () => void
}): ReactNode {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [groupDraft, setGroupDraft] = useState('')
  useEffect(() => { if (!menuOpen) { setConfirmRemove(false); setGroupDraft('') } }, [menuOpen])
  const swatch = swatchOf(layer)
  const badge = t(`panel.badge.${layer.badge}` as const)
  const badgeColor = panelBadgeColorOf(layer)

  return (
    <div
      data-map-panel-layer=""
      data-hidden={layer.visible ? undefined : ''}
      data-nested={nested ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-drop-target={dropTarget ? '' : undefined}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); onDragOver() }}
      onDrop={event => { event.stopPropagation(); onDrop(event) }}
    >
      <div data-map-panel-row="">
        <span
          data-map-panel-handle=""
          draggable={canWrite}
          role="img"
          aria-label={t('panel.drag', { name: layer.name })}
          title={t('panel.drag', { name: layer.name })}
          onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', layer.id); onDragStart() }}
          onDragEnd={onDragEnd}
        >
          ⋮⋮
        </span>
        <span data-map-panel-swatch="" data-kind={layer.badge} data-badge-color={badgeColor === null ? undefined : ''} title={badge} aria-label={badge} role="img">
          {swatch.kind === 'ramp' && <span data-map-panel-badge="" style={{ background: `linear-gradient(90deg, ${swatch.colors.join(', ')})` }} />}
          {swatch.kind === 'fill' && <span data-map-panel-badge="" style={{ background: swatch.colors[0] }} />}
          {swatch.kind === 'none' && badgeColor !== null && <span data-map-panel-badge="" style={{ background: badgeColor }} />}
        </span>
        <button type="button" data-map-panel-name="" title={layer.name} onClick={onZoom} aria-label={t('panel.locate', { name: layer.name })}>
          {layer.name}
        </button>
        <span data-map-panel-actions="">
          <button type="button" data-map-panel-icon="" aria-label={t('panel.zoomTo')} title={t('panel.zoomTo')} onClick={onZoom}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="M8 1v3M8 12v3M1 8h3M12 8h3" /></svg>
          </button>
          <button type="button" data-map-panel-icon="" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('panel.more', { name: layer.name })} title={t('panel.more', { name: layer.name })} onClick={onMenu}>⋯</button>
        </span>
        <EyeButton visible={layer.visible} disabled={!canWrite} label={t(layer.visible ? 'panel.hide' : 'panel.show', { name: layer.name })} onClick={onToggle} />
      </div>

      {(layer.chip?.kind === 'class' || layer.chip?.kind === 'heatmap' || layer.overridesVersion !== null) && (
        <div data-map-panel-chip="" aria-label={t('panel.legend')}>
          {layer.chip?.kind === 'class' && layer.chip.colors.map((color, at) => <span key={at} role="img" aria-label={t('workbench.legend.class', { n: String(at + 1) })} style={{ background: color }} />)}
          {layer.chip?.kind === 'heatmap' && <span data-map-panel-ramp="" aria-hidden="true">{layer.chip.stops.map((color, at) => <span key={at} style={{ background: color }} />)}</span>}
          {layer.overridesVersion !== null && <small>{t('panel.overridesVersion')}</small>}
        </div>
      )}

      {menuOpen && (
        <div data-map-panel-menu="" role="menu" aria-label={t('panel.more', { name: layer.name })}>
          <label data-map-panel-field="">
            <span>{t('panel.opacity')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={OPACITY_STEP}
              value={opacity}
              disabled={!canWrite}
              aria-label={t('panel.opacityOf', { name: layer.name })}
              onChange={event => onOpacityDraft(Number(event.target.value))}
              onPointerUp={() => onOpacityCommit(opacity)}
              onKeyUp={() => onOpacityCommit(opacity)}
            />
            <output>{Math.round(opacity * 100)}%</output>
          </label>
          {layer.badge !== 'imagery' && (
            <div data-map-panel-field="">
              <span>{t('panel.style')}</span>
              <div data-map-panel-presets="">
                {SYMBOL_PRESETS.map(preset => {
                  const color = preset.symbol.presentation === 'heatmap' ? undefined : (preset.symbol.point?.color ?? preset.symbol.line?.color ?? preset.symbol.fill?.color)
                  return (
                    <button key={preset.id} type="button" role="menuitem" data-map-panel-preset="" disabled={!canWrite} title={preset.label} aria-label={preset.label} onClick={() => onPreset(preset)}>
                      <span style={{ background: color ?? 'transparent' }} />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div data-map-panel-field="">
            <span>{t('panel.group')}</span>
            <div data-map-panel-chips="">
              {groupNames.filter(name => name !== layer.group).map(name => (
                <button key={name} type="button" role="menuitem" disabled={!canWrite} onClick={() => onGroup(name)}>{name}</button>
              ))}
              {layer.group !== null && <button type="button" role="menuitem" disabled={!canWrite} onClick={() => onGroup(null)}>{t('panel.ungroup')}</button>}
              <input
                type="text"
                aria-label={t('panel.groupNewName')}
                placeholder={t('panel.groupNewName.placeholder')}
                value={groupDraft}
                maxLength={64}
                onChange={event => setGroupDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && groupDraft.trim() !== '') onGroup(groupDraft.trim()) }}
              />
            </div>
          </div>
          <div data-map-panel-menu-items="">
            <button type="button" role="menuitem" disabled={!canWrite} onClick={() => onMove(-1)}>{t('panel.moveUp')}</button>
            <button type="button" role="menuitem" disabled={!canWrite} onClick={() => onMove(1)}>{t('panel.moveDown')}</button>
            <button type="button" role="menuitem" aria-expanded={tableOpen} onClick={onTable}>{t('panel.attributes')}</button>
            {layer.ref !== null && <button type="button" role="menuitem" aria-label={t('panel.download', { ref: layer.ref })} onClick={() => onDownload(layer.ref ?? '')}>{t('panel.download.button')}</button>}
          </div>
          {canExport && (
            <div data-map-panel-field="">
              <span>{t('panel.export.button')}</span>
              <div data-map-panel-chips="">
                {EXPORT_FORMATS.map(format => (
                  <button key={format} type="button" role="menuitem" onClick={() => onExport(format)}>{t(`panel.export.format.${format}` as const)}</button>
                ))}
              </div>
            </div>
          )}
          <div data-map-panel-menu-items="">
            {confirmRemove
              ? (
                <>
                  <button type="button" role="menuitem" data-danger="" disabled={!canWrite} aria-label={t('panel.removeConfirm', { name: layer.name })} onClick={onRemove}>{t('panel.removeConfirm.button')}</button>
                  <button type="button" role="menuitem" onClick={() => setConfirmRemove(false)}>{t('panel.removeCancel')}</button>
                </>
              )
              : <button type="button" role="menuitem" data-danger="" disabled={!canWrite} onClick={() => setConfirmRemove(true)}>{t('panel.remove.button')}</button>}
          </div>
        </div>
      )}

      {tableOpen && <AttributeTable layer={layer} wire={wire} t={t} page={attributePage} onPage={onAttributePage} onFeature={onFeature} />}
    </div>
  )
}

/** The paged attribute table of one layer. */
function AttributeTable({ layer, wire, t, page, onPage, onFeature }: {
  readonly layer: PanelLayerFace
  readonly wire: MapContainerWire
  readonly t: TranslateNS<'mapContainer'>
  readonly page: number
  readonly onPage: (page: number) => void
  readonly onFeature: (featureId: string) => void
}): ReactNode {
  const wireLayer = wire.layers.find(item => item.id === layer.id)
  const attributes = useMemo(() => (wireLayer === undefined ? null : panelAttributesOf(wireLayer)), [wireLayer])
  if (attributes === null || attributes.empty) return <p data-map-panel-attributes="">{t('panel.attributeEmpty')}</p>
  const pages = Math.max(Math.ceil(attributes.rows.length / PANEL_ATTRIBUTE_PAGE_SIZE), 1)
  const rows = attributes.rows.slice(page * PANEL_ATTRIBUTE_PAGE_SIZE, (page + 1) * PANEL_ATTRIBUTE_PAGE_SIZE)
  return (
    <div data-map-panel-attributes="">
      <div data-map-panel-table="">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('panel.attributeFeature')}</th>
              {attributes.columns.map(column => <th key={column} scope="col">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} onClick={() => onFeature(row.id)}>
                <td>
                  <button type="button" aria-label={t('panel.attributeLocate', { id: row.id })} onClick={event => { event.stopPropagation(); onFeature(row.id) }}>{row.id}</button>
                </td>
                {row.cells.map((cell, at) => <td key={at}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div data-map-panel-pager="">
        <button type="button" data-map-panel-icon="" aria-label={t('panel.attributePrevPage')} disabled={page === 0} onClick={() => onPage(Math.max(page - 1, 0))}>‹</button>
        <span>{t('panel.attributePage', { page: String(page + 1), pages: String(pages) })}</span>
        <button type="button" data-map-panel-icon="" aria-label={t('panel.attributeNextPage')} disabled={page >= pages - 1} onClick={() => onPage(Math.min(page + 1, pages - 1))}>›</button>
      </div>
      {attributes.columnOverflow > 0 && <p role="note">{t('panel.columnOverflow', { max: String(PANEL_MAX_ATTRIBUTE_COLUMNS), count: String(attributes.columnOverflow) })}</p>}
      {attributes.rowOverflow > 0 && <p role="note">{t('panel.rowOverflow', { max: String(MAX_ATTRIBUTE_ROWS), count: String(attributes.rowOverflow) })}</p>}
    </div>
  )
}
