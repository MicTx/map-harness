/**
 * The layer management panel: every wire layer searchable, grouped, and
 * directly operable. Two operation levels hold throughout — view-local
 * actions (search, folding, locating, the attribute table) take effect
 * immediately and never re-enter the conversation; state-change requests
 * (visibility, opacity, grouping, removal, preset styles, exports) serialize
 * as `[map-panel v1]` texts and queue into the session, with the pending
 * book as the advisory three-state surface. The panel never writes the
 * projection and never pre-stages map state; the wire stays the only
 * authority and the checkbox follows it, not the click.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MAX_ATTRIBUTE_ROWS } from '@map-harness/spatial-viz'
import { SYMBOL_PRESETS } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence } from './face.ts'
import type { PanelSubmit } from './gesture-submit.ts'
import {
  PANEL_TEXT_VERSION,
  emptyPendingBook,
  expirePending,
  hasPendingFor,
  recordRequest,
  serializePanelRequestText,
  syncPendingBook,
  type PanelRequest,
  type PanelRequestMessage,
  type PendingBook,
} from './panel-request.ts'
import {
  PANEL_ATTRIBUTE_PAGE_SIZE,
  PANEL_MAX_ATTRIBUTE_COLUMNS,
  panelAttributesOf,
  panelGroupsOf,
  type PanelBadge,
  type PanelBadgeLabels,
  type PanelLayerFace,
} from './panel-view.ts'

/** How often the panel checks the pending book for TTL expiry (a UI cadence, not a protocol value). */
const PENDING_TTL_POLL_MS = 5_000

/** The four export formats the panel offers, in fixed order. */
const EXPORT_FORMATS = ['geojson', 'csv', 'kml', 'shapefile'] as const

/** Layer opacity slider step; display granularity only. */
const OPACITY_STEP = 0.05

/** The badge vocabulary, in panel-row order. */
const BADGE_KEYS: readonly PanelBadge[] = ['point', 'line', 'polygon', 'heatmap', 'imagery', 'thematic', 'data']

/** The minimal face a batched visibility operation needs. */
interface VisibilityTarget {
  readonly id: string
  readonly visible: boolean
}

/**
 * Render the layer management panel over the map's top-left corner.
 * @param props - the projection wire, the session/occurrence identity, the occurrence getter, the locale seat, and the queue submission seam.
 * @returns the panel region, or its collapsed button.
 */
export function LayerPanel({ wire, sessionId, occurrenceKey, occurrence, t, panelSubmit }: {
  readonly wire: MapContainerWire
  readonly sessionId: string
  readonly occurrenceKey: string
  readonly occurrence: () => MapOccurrence | null
  readonly t: TranslateNS<'mapContainer'>
  readonly panelSubmit: PanelSubmit | undefined
}): ReactNode {
  // ── view-local state (folding, search, expanded sections) ───────────
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState('')
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set())
  const [detailLayer, setDetailLayer] = useState<string | null>(null)
  const [attributePage, setAttributePage] = useState(0)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [groupEdit, setGroupEdit] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [presetPick, setPresetPick] = useState<string | null>(null)
  const [exportPick, setExportPick] = useState<string | null>(null)
  const [byRef, setByRef] = useState('')
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)
  // Local opacity draft while a slider is being dragged; committed on release.
  const [opacityDraft, setOpacityDraft] = useState<{ readonly layerId: string; readonly value: number } | null>(null)

  const badgeLabels = useMemo<PanelBadgeLabels>(() => {
    const labels: Partial<Record<PanelBadge, string>> = {}
    for (const key of BADGE_KEYS) labels[key] = t(`panel.badge.${key}` as const)
    return labels
  }, [t])
  const groups = useMemo(() => panelGroupsOf(wire, search, badgeLabels), [wire, search, badgeLabels])

  // ── pending book (advisory three-state surface) ─────────────────────
  const [book, setBook] = useState<PendingBook>(emptyPendingBook)
  const bookRef = useRef(book)
  bookRef.current = book
  // Wire changes only sync the book — never a resubmission.
  useEffect(() => {
    setBook(previous => syncPendingBook(previous, wire))
  }, [wire])
  useEffect(() => {
    const timer = setInterval(() => {
      const current = bookRef.current
      if (current.entries.length === 0) return
      const outcome = expirePending(current, Date.now())
      if (outcome.expired.length > 0) {
        setBook(outcome.book)
        setNotice({ ok: false, text: t('panel.pending.unobserved', { count: String(outcome.expired.length) }) })
      }
    }, PENDING_TTL_POLL_MS)
    return () => clearInterval(timer)
  }, [t])

  // ── state-change request submission (the only write path) ───────────
  const requestSeq = useRef(0)
  const nextRequestId = (): string => `pr-${++requestSeq.current}`
  const canSubmit = panelSubmit !== undefined
  const submitRequest = (request: PanelRequest): void => {
    if (panelSubmit === undefined) return
    const message: PanelRequestMessage = {
      version: PANEL_TEXT_VERSION,
      sessionId,
      occurrenceKey,
      revision: wire.revision,
      requests: [request],
      at: new Date().toISOString(),
    }
    const serialized = serializePanelRequestText(message)
    if (!serialized.ok) {
      setNotice({ ok: false, text: t('panel.request.refused') })
      return
    }
    setBook(previous => syncPendingBook(recordRequest(previous, request, Date.now()), wire))
    setNotice({ ok: true, text: t(request.op === 'export' ? 'panel.request.exported' : 'panel.request.queued') })
    void panelSubmit(sessionId, serialized.text, 'queue')
      .then(queued => { if (!queued) setNotice({ ok: false, text: t('panel.request.failed') }) })
      .catch((_submissionError: unknown) => {
        // Advisory input may lose a race with turn completion; map state is unchanged.
        setNotice({ ok: false, text: t('panel.request.failed') })
      })
  }

  /** Send one batched visibility `set-state` for every target whose value would change. */
  const sendVisibility = (targets: readonly VisibilityTarget[], visible: boolean): void => {
    const states = targets.filter(target => target.visible !== visible).map(target => ({ id: target.id, visible }))
    if (states.length === 0) return
    submitRequest({ id: nextRequestId(), op: 'set-state', states })
  }

  const toggleGroup = (name: string | null): void => {
    setClosedGroups(previous => {
      const key = name ?? ''
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // ── artifact download (the only network face: read-only GET) ────────
  const downloadRef = (ref: string): void => {
    const url = `/api/map/artifact?session=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(ref)}`
    setNotice({ ok: true, text: t('panel.download.starting') })
    void fetch(url)
      .then(async response => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { code?: string } | null
          setNotice({ ok: false, text: t('panel.download.failed', { code: payload?.code ?? String(response.status) }) })
          return
        }
        const blob = await response.blob()
        const href = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = ''
        anchor.click()
        URL.revokeObjectURL(href)
      })
      .catch((_networkError: unknown) => {
        setNotice({ ok: false, text: t('panel.download.failed', { code: 'network' }) })
      })
  }

  if (collapsed) {
    return (
      <button
        type="button"
        data-map-panel-collapsed=""
        aria-label={t('panel.expand')}
        onClick={() => setCollapsed(false)}
        style={{ position: 'absolute', left: 8, top: 8, zIndex: 1, padding: '4px 10px' }}
      >
        {t('panel.expand')}
      </button>
    )
  }

  const groupNames = [...new Set(wire.layers.map(layer => layer.group).filter((name): name is string => name !== undefined))]

  return (
    <section
      data-map-panel=""
      role="region"
      aria-label={t('panel.title')}
      style={{ position: 'absolute', left: 8, top: 8, maxWidth: 'calc(100% - 16px)', maxHeight: '60%', overflowY: 'auto', zIndex: 1 }}
    >
      <h2>
        {t('panel.title')}
        <button type="button" aria-label={t('panel.collapse')} onClick={() => setCollapsed(true)}>{t('panel.collapse')}</button>
      </h2>

      <div role="group" aria-label={t('panel.search.label')} style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <input
          type="search"
          aria-label={t('panel.search.label')}
          placeholder={t('panel.search.placeholder')}
          value={search}
          onChange={event => { setSearch(event.target.value); setAttributePage(0) }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="button" aria-label={t('panel.showAll')} disabled={!canSubmit} onClick={() => sendVisibility(wire.layers, true)}>{t('panel.showAll')}</button>
        <button type="button" aria-label={t('panel.hideAll')} disabled={!canSubmit} onClick={() => sendVisibility(wire.layers, false)}>{t('panel.hideAll')}</button>
      </div>

      {!canSubmit && <p role="note" style={{ margin: '0 0 4px' }}>{t('panel.submitUnavailable')}</p>}
      {notice !== null && (
        <p role="status" data-map-panel-status="" style={{ margin: '0 0 4px' }}>{notice.text}</p>
      )}

      {groups.length === 0 && <p style={{ margin: '2px 0' }}>{search.trim() === '' ? t('panel.noLayers') : t('panel.noMatches')}</p>}

      {groups.map(group => {
        const sectionKey = group.name ?? ''
        const sectionOpen = !closedGroups.has(sectionKey)
        const groupVisible = group.layers.every(layer => layer.visible)
        return (
          <section key={group.name ?? 'ungrouped'} data-map-panel-group="" aria-label={group.name ?? t('panel.ungrouped')} style={{ marginBottom: 4 }}>
            <h3>
              <button
                type="button"
                aria-expanded={sectionOpen}
                onClick={() => toggleGroup(group.name)}
              >
                {sectionOpen ? '▾' : '▸'} {group.name ?? t('panel.ungrouped')} ({t('panel.groupCount', { count: String(group.layers.length) })})
              </button>
              {group.name !== null && (
                <button
                  type="button"
                  aria-label={t('panel.groupToggle', { name: group.name })}
                  disabled={!canSubmit}
                  onClick={() => sendVisibility(group.layers, !groupVisible)}
                >
                  {groupVisible ? t('panel.groupHide') : t('panel.groupShow')}
                </button>
              )}
            </h3>
            {sectionOpen && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {group.layers.map(layer => (
                  <li key={layer.id} data-map-panel-layer="" >
                    <LayerRow
                      layer={layer}
                      wire={wire}
                      t={t}
                      canSubmit={canSubmit}
                      pending={hasPendingFor(book, layer.id)}
                      occurrence={occurrence}
                      submitRequest={submitRequest}
                      detailOpen={detailLayer === layer.id}
                      onDetailToggle={() => {
                        setDetailLayer(detailLayer === layer.id ? null : layer.id)
                        setAttributePage(0)
                      }}
                      attributePage={attributePage}
                      onAttributePage={setAttributePage}
                      confirmRemove={confirmRemove === layer.id}
                      onConfirmRemove={() => { setConfirmRemove(confirmRemove === layer.id ? null : layer.id); setGroupEdit(null); setPresetPick(null); setExportPick(null) }}
                      groupEdit={groupEdit === layer.id}
                      groupNames={groupNames}
                      groupDraft={groupDraft}
                      onGroupDraft={setGroupDraft}
                      onGroupEdit={() => { setGroupEdit(groupEdit === layer.id ? null : layer.id); setGroupDraft(''); setConfirmRemove(null); setPresetPick(null); setExportPick(null) }}
                      onGroupAssign={name => {
                        submitRequest({ id: nextRequestId(), op: 'set-state', states: [{ id: layer.id, group: name }] })
                        setGroupEdit(null)
                      }}
                      presetPick={presetPick === layer.id}
                      onPresetPick={() => { setPresetPick(presetPick === layer.id ? null : layer.id); setConfirmRemove(null); setGroupEdit(null); setExportPick(null) }}
                      exportPick={exportPick === layer.id}
                      onExportPick={() => { setExportPick(exportPick === layer.id ? null : layer.id); setConfirmRemove(null); setGroupEdit(null); setPresetPick(null) }}
                      opacityDraft={opacityDraft?.layerId === layer.id ? opacityDraft.value : undefined}
                      onOpacityDraft={value => setOpacityDraft({ layerId: layer.id, value })}
                      onOpacityCommit={value => {
                        setOpacityDraft(null)
                        if (value !== layer.opacity) submitRequest({ id: nextRequestId(), op: 'set-state', states: [{ id: layer.id, opacity: value }] })
                      }}
                      nextRequestId={nextRequestId}
                      downloadRef={downloadRef}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      <div role="group" aria-label={t('panel.downloadByRef')} style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        <input
          type="text"
          aria-label={t('panel.downloadByRef')}
          placeholder={t('panel.downloadByRef.placeholder')}
          value={byRef}
          onChange={event => setByRef(event.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          disabled={byRef.trim() === ''}
          onClick={() => { downloadRef(byRef.trim()); setByRef('') }}
        >
          {t('panel.downloadByRef')}
        </button>
      </div>
    </section>
  )
}

/** One layer row: state controls, legend chip, and the expandable detail faces. */
function LayerRow({ layer, wire, t, canSubmit, pending, occurrence, submitRequest, detailOpen, onDetailToggle, attributePage, onAttributePage, confirmRemove, onConfirmRemove, groupEdit, groupNames, groupDraft, onGroupDraft, onGroupEdit, onGroupAssign, presetPick, onPresetPick, exportPick, onExportPick, opacityDraft, onOpacityDraft, onOpacityCommit, nextRequestId, downloadRef }: {
  readonly layer: PanelLayerFace
  readonly wire: MapContainerWire
  readonly t: TranslateNS<'mapContainer'>
  readonly canSubmit: boolean
  readonly pending: boolean
  readonly occurrence: () => MapOccurrence | null
  readonly submitRequest: (request: PanelRequest) => void
  readonly detailOpen: boolean
  readonly onDetailToggle: () => void
  readonly attributePage: number
  readonly onAttributePage: (page: number) => void
  readonly confirmRemove: boolean
  readonly onConfirmRemove: () => void
  readonly groupEdit: boolean
  readonly groupNames: readonly string[]
  readonly groupDraft: string
  readonly onGroupDraft: (value: string) => void
  readonly onGroupEdit: () => void
  readonly onGroupAssign: (name: string) => void
  readonly presetPick: boolean
  readonly onPresetPick: () => void
  readonly exportPick: boolean
  readonly onExportPick: () => void
  readonly opacityDraft: number | undefined
  readonly onOpacityDraft: (value: number) => void
  readonly onOpacityCommit: (value: number) => void
  readonly nextRequestId: () => string
  readonly downloadRef: (ref: string) => void
}): ReactNode {
  const badgeLabel = t(`panel.badge.${layer.badge}` as const)
  const wireLayer = useMemo(() => wire.layers.find(item => item.id === layer.id), [wire, layer.id])
  const attributes = useMemo(() => (detailOpen && wireLayer !== undefined ? panelAttributesOf(wireLayer) : null), [detailOpen, wireLayer])
  const totalPages = attributes === null ? 0 : Math.max(Math.ceil(attributes.rows.length / PANEL_ATTRIBUTE_PAGE_SIZE), 1)
  const pageRows = attributes === null ? [] : attributes.rows.slice(attributePage * PANEL_ATTRIBUTE_PAGE_SIZE, (attributePage + 1) * PANEL_ATTRIBUTE_PAGE_SIZE)
  const sliderValue = opacityDraft ?? layer.opacity

  return (
    <div data-map-panel-row="">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <input
          type="checkbox"
          aria-label={t('panel.visible', { name: layer.name })}
          checked={layer.visible}
          disabled={!canSubmit}
          onChange={() => submitRequest({ id: nextRequestId(), op: 'set-state', states: [{ id: layer.id, visible: !layer.visible }] })}
        />
        <strong title={layer.id}>{layer.name}</strong>
        <span data-map-panel-badge="" aria-label={t('panel.badgeLabel')} title={badgeLabel}>{badgeLabel}</span>
        {pending && <span role="status" title={t('panel.pending.submitted')}>⏳</span>}
        <button type="button" aria-label={t('panel.locate', { name: layer.name })} onClick={() => occurrence()?.focusLayer(layer.id)}>{t('panel.locate.button')}</button>
        <button type="button" aria-expanded={detailOpen} aria-label={t('panel.attributes')} onClick={onDetailToggle}>{t('panel.attributes')}</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 160px', minWidth: 0 }}>
          {t('panel.opacity')}
          <input
            type="range"
            min={0}
            max={1}
            step={OPACITY_STEP}
            value={sliderValue}
            disabled={!canSubmit}
            aria-label={t('panel.opacityOf', { name: layer.name })}
            onChange={event => onOpacityDraft(Number(event.target.value))}
            onPointerUp={() => onOpacityCommit(sliderValue)}
            onKeyUp={() => onOpacityCommit(sliderValue)}
          />
          {Math.round(sliderValue * 100)}%
        </label>
        <span data-map-panel-meta="">{t('panel.featureCount', { count: String(layer.featureCount) })}</span>
        {layer.ref !== null && (
          <span title={layer.ref} style={{ fontFamily: 'monospace' }}>{t('panel.refBadge')}</span>
        )}
      </div>

      {layer.chip !== null && (
        <div data-map-panel-chip="" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {layer.chip.kind === 'class' && (
            <>
              <span aria-hidden="true" style={{ display: 'inline-flex', border: '1px solid #666', height: 10 }}>
                {layer.chip.colors.map((color, at) => <span key={at} style={{ width: 10, height: 10, background: color }} />)}
              </span>
              <span title={layer.chip.styleVersion}>{t('panel.version', { version: layer.chip.styleVersion })}</span>
            </>
          )}
          {layer.chip.kind === 'symbol' && (
            <>
              {layer.chip.rows.map(row => {
                const geometry = row.geometry === 'point' ? 'point' : row.geometry === 'line' ? 'line' : 'polygon'
                const geometryLabel = t(`panel.badge.${geometry}` as const)
                return (
                  <span
                    key={row.geometry}
                    role="img"
                    aria-label={geometryLabel}
                    title={geometryLabel}
                    style={{ display: 'inline-block', width: 12, height: 12, background: row.color, border: `1px solid ${row.outline ?? '#666'}` }}
                  />
                )
              })}
              <span title={layer.chip.symbolVersion}>{t('panel.version', { version: layer.chip.symbolVersion })}</span>
            </>
          )}
          {layer.chip.kind === 'heatmap' && (
            <>
              <span aria-hidden="true" style={{ display: 'inline-flex', border: '1px solid #666', height: 10 }}>
                {layer.chip.stops.map((color, at) => <span key={at} style={{ width: 8, height: 10, background: color }} />)}
              </span>
              <span title={layer.chip.symbolVersion}>{t('panel.version', { version: layer.chip.symbolVersion })}</span>
            </>
          )}
          {layer.overridesVersion !== null && <span title={layer.overridesVersion}>{t('panel.overridesVersion')}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" aria-label={t('panel.assignGroup', { name: layer.name })} disabled={!canSubmit} onClick={onGroupEdit}>{t('panel.assignGroup.button')}</button>
        {layer.ref !== null && (
          <button type="button" aria-label={t('panel.download', { ref: layer.ref })} onClick={() => downloadRef(layer.ref ?? '')}>{t('panel.download.button')}</button>
        )}
        <button type="button" aria-label={t('panel.preset', { name: layer.name })} disabled={!canSubmit} onClick={onPresetPick}>{t('panel.preset.button')}</button>
        <button type="button" aria-label={t('panel.export', { name: layer.name })} disabled={!canSubmit} onClick={onExportPick}>{t('panel.export.button')}</button>
        {confirmRemove
          ? (
            <span role="group">
              <button type="button" aria-label={t('panel.removeConfirm', { name: layer.name })} onClick={() => { submitRequest({ id: nextRequestId(), op: 'remove', layer: layer.id }); onConfirmRemove() }}>{t('panel.removeConfirm.button')}</button>
              <button type="button" aria-label={t('panel.removeCancel')} onClick={onConfirmRemove}>{t('panel.removeCancel')}</button>
            </span>
          )
          : <button type="button" aria-label={t('panel.remove', { name: layer.name })} disabled={!canSubmit} onClick={onConfirmRemove}>{t('panel.remove.button')}</button>}
      </div>

      {groupEdit && (
        <div role="group" aria-label={t('panel.assignGroup', { name: layer.name })} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '2px 0' }}>
          {groupNames.map(name => (
            <button key={name} type="button" disabled={!canSubmit || name === layer.group} onClick={() => onGroupAssign(name)}>{name}</button>
          ))}
          <input
            type="text"
            aria-label={t('panel.groupNewName')}
            placeholder={t('panel.groupNewName.placeholder')}
            value={groupDraft}
            onChange={event => onGroupDraft(event.target.value)}
            style={{ width: 90 }}
          />
          <button
            type="button"
            disabled={groupDraft.trim().length < 1 || groupDraft.trim().length > 64}
            onClick={() => onGroupAssign(groupDraft.trim())}
          >
            {t('panel.groupApply')}
          </button>
        </div>
      )}

      {presetPick && (
        <div role="group" aria-label={t('panel.preset', { name: layer.name })} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '2px 0' }}>
          {SYMBOL_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              disabled={!canSubmit}
              title={preset.id}
              onClick={() => {
                submitRequest({ id: nextRequestId(), op: 'set-style', layer: layer.id, preset: preset.id })
                onPresetPick()
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {exportPick && (
        <div role="group" aria-label={t('panel.export', { name: layer.name })} style={{ display: 'flex', gap: 4, margin: '2px 0' }}>
          {EXPORT_FORMATS.map(format => (
            <button
              key={format}
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                submitRequest({ id: nextRequestId(), op: 'export', layer: layer.id, format })
                onExportPick()
              }}
            >
              {t(`panel.export.format.${format}` as const)}
            </button>
          ))}
        </div>
      )}

      {detailOpen && (
        <div data-map-panel-attributes="">
          {attributes === null || attributes.empty
            ? <p style={{ margin: '2px 0' }}>{t('panel.attributeEmpty')}</p>
            : (
              <div>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('panel.attributeFeature')}</th>
                      {attributes.columns.map(column => <th key={column} scope="col" style={{ textAlign: 'left' }}>{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(row => (
                      <tr key={row.id}>
                        <td>
                          <button
                            type="button"
                            aria-label={t('panel.attributeLocate', { id: row.id })}
                            onClick={() => occurrence()?.focusFeature(layer.id, row.id)}
                          >
                            {t('panel.attributeLocate.button')}
                          </button>
                          {' '}{row.id}
                        </td>
                        {row.cells.map((cell, at) => <td key={at}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" aria-label={t('panel.attributePrevPage')} disabled={attributePage === 0} onClick={() => onAttributePage(Math.max(attributePage - 1, 0))}>◀</button>
                  <span>{t('panel.attributePage', { page: String(attributePage + 1), pages: String(totalPages) })}</span>
                  <button type="button" aria-label={t('panel.attributeNextPage')} disabled={attributePage >= totalPages - 1} onClick={() => onAttributePage(Math.min(attributePage + 1, totalPages - 1))}>▶</button>
                </div>
                {attributes.columnOverflow > 0 && <p role="note">{t('panel.columnOverflow', { max: String(PANEL_MAX_ATTRIBUTE_COLUMNS), count: String(attributes.columnOverflow) })}</p>}
                {attributes.rowOverflow > 0 && <p role="note">{t('panel.rowOverflow', { max: String(MAX_ATTRIBUTE_ROWS), count: String(attributes.rowOverflow) })}</p>}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
