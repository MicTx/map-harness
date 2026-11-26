/**
 * The resident map panel hosts imagery, layers, and annotations in tabs.
 * Standalone surfaces remain available for focused tests and audit fixtures.
 * Each layer is one compact row with a drag handle, a type swatch, its name,
 * and a visibility eye; zoom-to and a "more" menu appear on hover or focus.
 * Rows list top-drawn layers first. Visibility, opacity, order, grouping,
 * preset styles, and removal write directly through the user change route and
 * take effect immediately; export still goes through the conversation as a
 * queued `[map-panel v1]` request because it produces a catalog artifact. The
 * panel never pre-stages map state: every control renders the wire.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import { MAX_ATTRIBUTE_ROWS } from '@map-harness/spatial-viz/browser'
import { SYMBOL_PRESETS } from '@map-harness/map-layers'
import type { BasemapSource } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence, MapImageUrl } from './face.ts'
import type { PanelSubmit } from './gesture-submit.ts'
import type { PanelChange, PanelChangeSubmit } from './change-submit.ts'
import { PANEL_TEXT_VERSION, serializePanelRequestText, type PanelExportFormat } from './panel-request.ts'
import {
  PANEL_ATTRIBUTE_PAGE_SIZE,
  PANEL_MAX_ATTRIBUTE_COLUMNS,
  panelAttributesOf,
  panelBulkStateChange,
  panelClearOrder,
  panelFacesOf,
  panelRowsOf,
  panelSymbolWithColor,
  panelSymbolColorOf,
  type PanelRowFace,
  panelAnnotationsOf,
  type PanelLayerFace,
  type PanelAnnotationFace,
  type PanelProposalFace,
  type PanelChangeFace,
  type PanelLegendRow,
} from './panel-view.ts'
import type { AnnotationDrawKind } from './annotation-drawing.ts'
import type { AnnotationGeometry } from '../protocol.ts'
import { blendEarlyImagery } from '../imagery-display.ts'
import { VISUAL_CHANGE_LAYER_ID, VISUAL_PROPOSAL_LAYER_ID } from '../comparison-limits.ts'
import type { GeoJsonFeatureCollection } from '../registry.ts'
import { WaybackPanel } from './wayback-panel.tsx'
import { ProposalSource } from './ProposalSource.tsx'
import { ChangeSource } from './ChangeSource.tsx'
import { constrainPanel, resizePanel, type PanelRect, type ResizeDirection } from './panel-geometry.ts'
import { Button, Input, Menu, MenuItemButton, Modal, SegmentedTabs, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { singleSymbolOf } from './layer-colors.ts'

/** The four export formats the panel offers, in fixed order. */
const EXPORT_FORMATS: readonly PanelExportFormat[] = ['geojson', 'csv', 'kml', 'shapefile']

/** The four first-version annotation drawing tools. */
const ANNOTATION_TOOLS: readonly AnnotationDrawKind[] = ['point', 'line', 'polygon', 'rectangle']

/** All four bounded visual-change kinds from the durable record. */
const CHANGE_KINDS: Readonly<Record<string, 'panel.change.kind.appeared' | 'panel.change.kind.disappeared' | 'panel.change.kind.modified' | 'panel.change.kind.uncertain'>> = {
  appeared: 'panel.change.kind.appeared',
  disappeared: 'panel.change.kind.disappeared',
  modified: 'panel.change.kind.modified',
  uncertain: 'panel.change.kind.uncertain',
}

/** Opacity slider step; display granularity only. */
const OPACITY_STEP = 0.05
const PANEL_TABS = ['imagery', 'ai', 'annotation'] as const
const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
type PanelTab = typeof PANEL_TABS[number]


/** Panel props: the wire, identity, occurrence, locale, and both write seams. */
export interface LayerPanelProps {
  readonly surface?: 'all' | 'unified' | 'ai' | 'annotation' | 'imagery'
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly liveViewport?: import('./gesture.ts').GestureCameraSnapshot | null
  readonly wire: MapContainerWire
  readonly sessionId: string
  readonly occurrenceKey: string
  readonly occurrence: () => MapOccurrence | null
  readonly t: TranslateNS<'mapContainer'>
  readonly useResource: UseResource
  readonly changeSubmit: PanelChangeSubmit | undefined
  readonly panelSubmit: PanelSubmit | undefined
  readonly imageUrl: MapImageUrl | undefined
}

function rowName(row: PanelRowFace): string {
  return row.kind === 'layer' ? row.layer.name : row.kind === 'proposal' ? row.proposal.name : row.change.name
}

function rowId(row: PanelRowFace): string {
  return row.kind === 'layer' ? row.layer.id : row.kind === 'proposal' ? row.proposal.id : row.change.id
}


/** Whether a candidate row still needs a user decision. */
function isPendingCandidate(row: PanelRowFace): row is CandidateRowFace {
  if (row.kind === 'layer') return false
  const status = row.kind === 'proposal' ? row.proposal.status : row.change.status
  return status === 'proposed' || status === 'pending'
}

/** Filter every flat row by its own name, never by a removed group label. */
function rowsMatching<Row extends PanelRowFace>(rows: readonly Row[], search: string): readonly Row[] {
  const tokens = search.trim().toLowerCase().split(/\s+/u).filter(token => token.length > 0)
  return rows.filter(row => tokens.length === 0 || tokens.some(token => rowName(row).toLowerCase().includes(token)))
}

function TableHeader({ t }: { readonly t: TranslateNS<'mapContainer'> }): ReactNode {
  return <div role="rowgroup" data-map-panel-visually-hidden=""><div role="row"><span role="columnheader">{t('panel.table.name')}</span><span role="columnheader">{t('panel.table.actions')}</span></div></div>
}

/**
 * Render the resident map panel card: one title bar that collapses the card
 * and starts a pointer drag, and its three tabbed surfaces.
 * @param props - see {@link LayerPanelProps}.
 * @returns the panel card, collapsed to its title bar when closed.
 */
export function LayerPanel({ surface = 'all', open: openProp, onOpenChange, wire, sessionId, occurrenceKey, occurrence, t, useResource, changeSubmit, panelSubmit, imageUrl }: LayerPanelProps): ReactNode {
  const unifiedSurface = surface === 'unified'
  const [activeTab, setActiveTab] = useState<PanelTab>('ai')
  const aiSurface = surface === 'ai' || surface === 'all' || unifiedSurface
  const annotationSurface = surface === 'annotation' || surface === 'all' || unifiedSurface
  const imagerySurface = surface === 'imagery' || surface === 'all' || unifiedSurface
  const showLayerMeta = !unifiedSurface && (surface === 'ai' || surface === 'all')
  const [openState, setOpenState] = useState(true)
  const open = openProp ?? openState
  const setOpen = (next: boolean): void => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  const [search, setSearch] = useState('')
  const [dialogFor, setDialogFor] = useState<string | null>(null)
  const [tableFor, setTableFor] = useState<string | null>(null)
  const [attributePage, setAttributePage] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const acknowledgedRevision = useRef(wire.revision)
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)
  const [opacityDraft, setOpacityDraft] = useState<{ readonly layerId: string; readonly value: number } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [annotationDialogFor, setAnnotationDialogFor] = useState<string | null>(null)
  const [annotationNameDraft, setAnnotationNameDraft] = useState('')
  const [annotationDescriptionDraft, setAnnotationDescriptionDraft] = useState('')
  const [confirmAnnotationDelete, setConfirmAnnotationDelete] = useState(false)
  const [annotationSearch, setAnnotationSearch] = useState('')
  const [drawingStatus, setDrawingStatus] = useState<'idle' | 'drawing' | 'editing' | 'submitting'>('idle')
  const [drawingKind, setDrawingKind] = useState<AnnotationDrawKind | null>(null)
  const [drawingError, setDrawingError] = useState<'geometry-invalid' | 'submit-failed' | null>(null)
  const [imageryDialogFor, setImageryDialogFor] = useState<'labels' | 'recent' | 'early' | null>(null)
  const [annotationMenuOpen, setAnnotationMenuOpen] = useState(false)
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const [panelRect, setPanelRect] = useState<PanelRect | null>(null)
  const panelRectRef = useRef<PanelRect | null>(null)
  const gestureCleanup = useRef<(() => void) | null>(null)
  const [listOverflows, setListOverflows] = useState(false)
  const annotationListRef = useRef<HTMLDivElement | null>(null)
  const [annotationListOverflows, setAnnotationListOverflows] = useState(false)
  // Each applied change advances the revision; the clear sweep must submit
  // against the newest one, so it reads through a ref rather than the closure.
  const wireRef = useRef(wire)
  wireRef.current = wire
  const revisionNow = (): number => Math.max(wireRef.current.revision, acknowledgedRevision.current)

  const faces = useMemo(() => panelFacesOf(wire), [wire])
  const annotations = useMemo(() => panelAnnotationsOf(wire), [wire])
  const annotationLayer = wire.layers.find(layer => layer.role === 'user-annotation')
  const searchedAnnotations = useMemo(() => {
    const tokens = annotationSearch.trim().toLowerCase().split(/\s+/u).filter(token => token.length > 0)
    return annotations.filter(annotation => tokens.length === 0 || tokens.some(token => annotation.name.toLowerCase().includes(token)))
  }, [annotations, annotationSearch])
  const selectedAnnotation = annotations.find(annotation => annotation.id === annotationDialogFor) ?? null
  const sourceResource = useResource(`dsh-resource://map-source/${encodeURIComponent(sessionId)}`)
  const sourcePage = sourceResource.status === 'live' ? sourceResource.value : undefined
  const baseSources = useMemo(() => sourcePage?.sources.filter(source => source.role === 'basemap') ?? [], [sourcePage])
  const labelSources = useMemo(() => sourcePage?.sources.filter(source => source.role === 'labels') ?? [], [sourcePage])
  const currentBaseId = wire.basemap?.basemap.id ?? 'esri-world-imagery'
  const currentLabelId = wire.basemap?.labels?.id ?? (wire.basemap === null ? 'amap-imagery-labels' : null)
  const currentBase = wire.basemap?.basemap ?? baseSources.find(source => source.id === currentBaseId)
  const currentLabel = wire.basemap?.labels ?? labelSources.find(source => source.id === currentLabelId)
  const imageryDisplay = wire.imageryDisplay ?? {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 1,
    earlyVisible: false,
    earlySource: null,
  }
  const compatibleLabels = useMemo(() => {
    if (currentBase === undefined) return []
    return labelSources.filter(source => source.compatibleBasemapIds.includes(currentBase.id))
  }, [currentBase, labelSources])
  const allRows = useMemo(() => panelRowsOf(wire, faces), [wire, faces])
  const pendingRows = useMemo(() => rowsMatching(allRows.filter(isPendingCandidate), search), [allRows, search])
  const rows = useMemo(() => rowsMatching(allRows.filter(row => !isPendingCandidate(row)), search), [allRows, search])
  const dialogRow = allRows.find(row => rowId(row) === dialogFor) ?? null
  const nameOf = (id: string): string => faces.find(face => face.id === id)?.name ?? id
  useEffect(() => {
    const node = unifiedSurface ? null : listRef.current
    if (node === null) return
    const update = (): void => { setListOverflows(node.scrollHeight > node.clientHeight + 1) }
    update()
    node.addEventListener('scroll', update, { passive: true })
    const resize = typeof globalThis.ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(node)
    return () => { resize?.disconnect(); node.removeEventListener('scroll', update) }
  }, [rows.length, pendingRows.length, search, activeTab, open, unifiedSurface])
  useEffect(() => {
    const node = unifiedSurface ? null : annotationListRef.current
    if (node === null) return
    const update = (): void => { setAnnotationListOverflows(node.scrollHeight > node.clientHeight + 1) }
    update()
    node.addEventListener('scroll', update, { passive: true })
    const resize = typeof globalThis.ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(node)
    return () => { resize?.disconnect(); node.removeEventListener('scroll', update) }
  }, [annotations.length, annotationSearch, activeTab, open, unifiedSurface])
  useEffect(() => {
    if (annotationDialogFor !== null && !annotations.some(annotation => annotation.id === annotationDialogFor)) {
      setAnnotationDialogFor(null)
      setConfirmAnnotationDelete(false)
    }
  }, [annotationDialogFor, annotations])
  useEffect(() => {
    if (selectedAnnotation === null) return
    setAnnotationNameDraft(selectedAnnotation.name)
    setAnnotationDescriptionDraft(selectedAnnotation.description ?? '')
  }, [selectedAnnotation?.id, selectedAnnotation?.updatedAt])
  useEffect(() => {
    const live = occurrence()?.annotationDrawingState()
    if (live === undefined) return
    if (live.status !== drawingStatus) setDrawingStatus(live.status)
    if (live.kind !== drawingKind) setDrawingKind(live.kind)
    if (live.lastError !== drawingError) setDrawingError(live.lastError)
  }, [drawingError, drawingKind, drawingStatus, occurrence, wire])
  useEffect(() => {
    if (drawingStatus === 'idle') return
    const timer = setInterval(() => {
      const live = occurrence()?.annotationDrawingState()
      if (live === undefined) return
      if (live.status !== drawingStatus) setDrawingStatus(live.status)
      if (live.kind !== drawingKind) setDrawingKind(live.kind)
      if (live.lastError !== drawingError) setDrawingError(live.lastError)
    }, 100)
    return () => clearInterval(timer)
  }, [drawingError, drawingKind, drawingStatus, occurrence])
  const flash = (ok: boolean, text: string): void => {
    setNotice({ ok, text })
  }

  const reasonOf = (code: string): string => code === 'stale-revision'
    ? t('panel.change.stale')
    : code === 'layer-unknown' ? t('panel.change.unknown') : code === 'network' ? t('panel.change.network') : t('panel.change.other')

  /** Write one change directly; the wire reflects it when the host applies it. */
  const write = (change: PanelChange, summary: string, onApplied?: () => void): void => {
    if (changeSubmit === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    void changeSubmit({ sessionId, revision: revisionNow(), summary, change })
      .then(outcome => {
        if (outcome.ok) {
          acknowledgedRevision.current = outcome.revision
          onApplied?.()
        }
        else flash(false, t('panel.change.failed', { reason: reasonOf(outcome.code) }))
      })
      .catch((_submitError: unknown) => { flash(false, t('panel.change.failed', { reason: reasonOf('network') })) })
      .finally(() => { busyRef.current = false; setBusy(false) })
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

  /** Submit the imagery display state (tab visibility, opacity, historical source). */
  const writeImageryDisplay = (display: import('../protocol.ts').ImageryDisplayState, summary: string): void => {
    write({ op: 'set-imagery-display', display }, summary)
  }

  /** Submit one full public selection; an incompatible existing label is cleared in the same base change. */
  const writeBasemap = (base: BasemapSource, labels: BasemapSource | null): void => {
    if (base.availability.kind !== 'configured' || (labels !== null && labels.availability.kind !== 'configured')) return
    write(
      { op: 'set-basemap', selection: { schemaVersion: 1, basemap: base, labels } },
      labels === null
        ? t('panel.summary.basemap', { base: base.title })
        : t('panel.summary.labels', { labels: labels.title }),
    )
  }

  /**
   * Remove every listed layer, one change at a time: the host applies each
   * change before answering, so the next step reads the revision the previous
   * one produced. A refusal stops the sweep and reports how many were removed.
   */
  const clearAll = async (): Promise<void> => {
    if (changeSubmit === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    let removed = 0
    let revision = revisionNow()
    const order = panelClearOrder(faces)
    try {
      for (const layerId of order) {
        const outcome = await changeSubmit({ sessionId, revision, summary: t('panel.summary.remove', { name: nameOf(layerId) }), change: { op: 'remove-layer', layerId } })
        if (!outcome.ok) {
          flash(false, t('panel.clearAll.partial', { count: String(removed), reason: reasonOf(outcome.code) }))
          return
        }
        revision = outcome.revision
        acknowledgedRevision.current = revision
        removed += 1
      }
      flash(true, t('panel.summary.clearAll', { count: String(removed) }))
    } catch {
      flash(false, t('panel.clearAll.partial', { count: String(removed), reason: reasonOf('network') }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** Set every listed layer at once, summarised as one bulk action. */
  const setVisibleAll = (visible: boolean): void => {
    const change = panelBulkStateChange(faces, visible)
    if (change === null) return
    write(change, t(visible ? 'panel.summary.showAll' : 'panel.summary.hideAll'))
  }

  /** The annotation controls share the direct-write admission gate without pre-staging wire state. */
  const canWriteNow = (): boolean => changeSubmit !== undefined && !busyRef.current

  /** Begin one temporary SDK annotation draft; durable state changes only after validation. */
  const startAnnotation = (kind: AnnotationDrawKind): void => {
    const active = occurrence()
    if (active === null || !canWriteNow()) return
    setConfirmAnnotationDelete(false)
    setDrawingError(null)
    setDrawingStatus('drawing')
    void active.startAnnotationDrawing(kind)
      .then(result => {
        if (result !== 'started') {
          setDrawingStatus('idle')
          flash(false, t(result === 'busy' ? 'panel.annotation.busy' : result === 'scene-mode' ? 'panel.annotation.sceneOnly' : 'panel.annotation.noView'))
        }
      })
      .catch(() => setDrawingStatus('idle'))
  }

  const cancelAnnotationDrawing = (): void => {
    if (occurrence()?.cancelAnnotationDrawing() === true) setDrawingStatus('idle')
  }

  /** Start a geometry edit from the selected annotation's durable GeoJSON. */
  const startAnnotationGeometryEdit = (annotation: PanelAnnotationFace): void => {
    if (occurrence() === null || !canWriteNow()) return
    const feature = (annotationLayer?.data as GeoJsonFeatureCollection | undefined)?.features.find(candidate => candidate.id === annotation.id)
    if (feature === undefined || feature.geometry == null) return
    setDrawingStatus('editing')
    setDrawingError(null)
    void occurrence()?.startAnnotationEditing(annotation.id, feature.geometry as AnnotationGeometry, annotation.updatedAt)
      .then(result => {
        if (result !== 'started') {
          setDrawingStatus('idle')
          flash(false, t(result === 'busy' ? 'panel.annotation.busy' : result === 'scene-mode' ? 'panel.annotation.sceneOnly' : 'panel.annotation.noView'))
        }
      })
      .catch(() => setDrawingStatus('idle'))
  }

  const saveSelectedAnnotation = (): void => {
    if (selectedAnnotation === null || !canWriteNow()) return
    write({
      op: 'annotation-update',
      featureId: selectedAnnotation.id,
      expectedUpdatedAt: selectedAnnotation.updatedAt,
      ...(annotationNameDraft.trim() === selectedAnnotation.name ? {} : { name: annotationNameDraft.trim() }),
      ...(annotationDescriptionDraft === (selectedAnnotation.description ?? '') ? {} : { description: annotationDescriptionDraft }),
    }, t('panel.annotation.summary.update', { id: selectedAnnotation.id }))
  }

  const styleSelectedAnnotation = (presetId: string): void => {
    if (selectedAnnotation === null || !canWriteNow()) return
    const preset = SYMBOL_PRESETS.find(candidate => candidate.id === presetId)
    if (preset === undefined) return
    write({
      op: 'annotation-update',
      featureId: selectedAnnotation.id,
      expectedUpdatedAt: selectedAnnotation.updatedAt,
      symbol: preset.symbol,
    }, t('panel.annotation.summary.update', { id: selectedAnnotation.id }))
  }

  const deleteSelectedAnnotation = (): void => {
    if (selectedAnnotation === null || !canWriteNow()) return
    write({ op: 'annotation-delete', featureIds: [selectedAnnotation.id] },
      t('panel.annotation.summary.delete', { name: selectedAnnotation.name }))
    setConfirmAnnotationDelete(false)
  }

  const undoLatestAnnotation = (): void => {
    if (!canWriteNow()) return
    const target = wire.undoableAnnotation ?? null
    if (target?.operationId === undefined || target.operationId === null) return
    write({ op: 'annotation-undo', operationId: target.operationId },
      t('panel.annotation.summary.undo', { revision: String(target.revision) }))
  }

  const exportAnnotations = (): void => {
    if (panelSubmit === undefined || busyRef.current) return
    const serialized = serializePanelRequestText({
      version: PANEL_TEXT_VERSION,
      sessionId,
      occurrenceKey,
      revision: wire.revision,
      requests: [{ id: `annotation-export-${Date.now().toString(36)}`, op: 'export', layer: 'user-annotations', format: 'geojson' }],
      at: new Date().toISOString(),
    })
    if (!serialized.ok) {
      flash(false, t('panel.request.refused'))
      return
    }
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    void panelSubmit(sessionId, serialized.text, 'queue')
      .then(queued => { if (queued) flash(true, t('panel.request.exported')); else flash(false, t('panel.request.failed')) })
      .catch((_submissionError: unknown) => { flash(false, t('panel.request.failed')) })
      .finally(() => { busyRef.current = false; setBusy(false) })
  }

  /** Move one layer to sit just above (in panel order) another, or by one step. */
  const reviewProposal = (proposal: PanelProposalFace, accept: boolean, name: string, note: string): void => {
    if (proposal.status !== 'pending' && proposal.status !== 'proposed') return
    if (!canWriteNow()) return
    const editedName = name.trim()
    const editedNote = note.trim()
    const change: PanelChange = accept ? {
      op: 'visual-proposal-accept',
      proposalId: proposal.id,
      expectedRevision: wire.revision,
      ...(editedName !== '' && editedName !== proposal.name ? { name: editedName } : {}),
      ...(editedNote !== '' && editedNote !== proposal.note ? { description: editedNote } : {}),
    } : { op: 'visual-proposal-reject', proposalId: proposal.id, expectedRevision: wire.revision }
    write(change, t(accept ? 'panel.proposal.summary.accept' : 'panel.proposal.summary.reject', { name: proposal.name }), () => setDialogFor(null))
  }

  const reviewChange = (change: PanelChangeFace, accept: boolean, name: string, note: string): void => {
    if (change.status !== 'proposed' || !canWriteNow()) return
    const editedName = name.trim()
    const editedNote = note.trim()
    const payload: PanelChange = accept ? {
      op: 'visual-change-accept',
      changeId: change.id,
      expectedRevision: wire.revision,
      ...(editedName !== '' && editedName !== change.name ? { name: editedName } : {}),
      ...(editedNote !== '' && editedNote !== change.note ? { description: editedNote } : {}),
    } : { op: 'visual-change-reject', changeId: change.id, expectedRevision: wire.revision }
    write(payload, t(accept ? 'panel.change.summary.accept' : 'panel.change.summary.reject', { name: change.name }), () => setDialogFor(null))
  }

  const previewCandidate = (row: CandidateRowFace): void => {
    occurrence()?.focusFeature(row.kind === 'proposal' ? VISUAL_PROPOSAL_LAYER_ID : VISUAL_CHANGE_LAYER_ID, row.kind === 'proposal' ? row.proposal.id : row.change.id)
  }

  const acceptCandidate = (row: CandidateRowFace): void => {
    if (row.kind === 'proposal') reviewProposal(row.proposal, true, row.proposal.name, row.proposal.note)
    else reviewChange(row.change, true, row.change.name, row.change.note)
  }

  const rejectCandidate = (row: CandidateRowFace): void => {
    if (row.kind === 'proposal') reviewProposal(row.proposal, false, row.proposal.name, row.proposal.note)
    else reviewChange(row.change, false, row.change.name, row.change.note)
  }

  const moveLayer = (layerId: string, beforeId: string | null, step?: -1 | 1): void => {
    const drawOrder = wire.layers.filter(layer => layer.role !== 'user-annotation' && layer.role !== 'visual-proposal' && layer.role !== 'visual-change').map(layer => layer.id)
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
    if (panelSubmit === undefined || busyRef.current) return
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
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    void panelSubmit(sessionId, serialized.text, 'queue')
      .then(queued => { if (queued) flash(true, t('panel.request.exported')); else flash(false, t('panel.request.failed')) })
      .catch((_submissionError: unknown) => { flash(false, t('panel.request.failed')) })
      .finally(() => { busyRef.current = false; setBusy(false) })
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

  /**
   * The box the card's inline offsets position against: the nearest
   * positioned ancestor inside the map container (the panel lane in
   * production), falling back to the map container itself where that
   * ancestor is unavailable (jsdom, detached trees).
   */
  const dragAnchorOf = (panel: HTMLElement | null): Element | null => {
    if (panel === null) return null
    const container = panel.closest('[data-map-container]')
    const offsetParent = panel.offsetParent
    if (container !== null && offsetParent instanceof Element && container.contains(offsetParent)) return offsetParent
    return container
  }
  const panelBounds = (anchor: Element): { readonly width: number; readonly height: number } => {
    const rect = anchor.getBoundingClientRect()
    return { width: Math.floor(rect.width), height: Math.floor(rect.height) }
  }

  const startPanelGesture = (event: import('react').PointerEvent<HTMLElement>, direction: ResizeDirection | null): void => {
    if (event.button !== 0) return
    if (direction === null && event.target instanceof Element && event.target.closest('button, input, select, a') !== null) return
    const panel = panelRef.current
    const anchor = dragAnchorOf(panel)
    if (panel === null || anchor === null) return
    const view = panel.ownerDocument.defaultView
    if (view === null) return
    const measured = panel.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const origin = constrainPanel({
      x: measured.left - anchorRect.left,
      y: measured.top - anchorRect.top,
      width: panelRect?.width ?? measured.width,
      height: panelRect?.height ?? (open ? measured.height : Math.min(320, anchorRect.height)),
    }, panelBounds(anchor))
    const start = { x: event.clientX, y: event.clientY }
    const pointerId = event.pointerId
    const restore = panelRect
    let moved = false
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      const dx = moveEvent.clientX - start.x
      const dy = moveEvent.clientY - start.y
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      moved = true
      const bounds = panelBounds(anchor)
      const boundedOrigin = constrainPanel(origin, bounds)
      setPanelRect(direction === null
        ? constrainPanel({ ...boundedOrigin, x: boundedOrigin.x + dx, y: boundedOrigin.y + dy }, bounds)
        : resizePanel(boundedOrigin, direction, dx, dy, bounds))
    }
    const cleanup = (): void => {
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerup', onFinish)
      view.removeEventListener('pointercancel', onFinish)
      view.removeEventListener('blur', cleanup)
      gestureCleanup.current = null
    }
    const onFinish = (finishEvent: PointerEvent): void => {
      if (finishEvent.pointerId !== pointerId) return
      if (finishEvent.type === 'pointercancel') setPanelRect(restore)
      cleanup()
    }
    gestureCleanup.current?.()
    gestureCleanup.current = cleanup
    view.addEventListener('pointermove', onMove)
    view.addEventListener('pointerup', onFinish)
    view.addEventListener('pointercancel', onFinish)
    view.addEventListener('blur', cleanup)
  }

  useEffect(() => () => gestureCleanup.current?.(), [])
  useEffect(() => {
    if (!unifiedSurface || !open || panelRectRef.current !== null) return
    const panel = panelRef.current
    const anchor = dragAnchorOf(panel)
    if (panel === null || anchor === null) return
    const bounds = anchor.getBoundingClientRect()
    const rect = panel.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0) return
    const initial = constrainPanel({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height }, panelBounds(anchor))
    panelRectRef.current = initial
    setPanelRect(previous => previous ?? initial)
  }, [open, unifiedSurface])
  useEffect(() => {
    const panel = panelRef.current
    const anchor = dragAnchorOf(panel)
    if (panel === null || anchor === null || typeof globalThis.ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const bounds = anchor.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return
      setPanelRect(previous => {
        if (previous === null) return null
        const next = constrainPanel(previous, panelBounds(anchor))
        return next.x === previous.x && next.y === previous.y && next.width === previous.width && next.height === previous.height ? previous : next
      })
    })
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [open, unifiedSurface])

  const canWrite = changeSubmit !== undefined && !busy
  const sourceCanWrite = canWrite && (sourcePage?.canChange ?? false)
  const undoableAnnotation = wire.undoableAnnotation ?? null
  const panelTitle = surface === 'annotation'
    ? t('panel.annotation.title')
    : surface === 'imagery' ? t('panel.imagery.title')
      : surface === 'unified' ? t('panel.all.title') : t('panel.title')
  const selectedAnnotationDirty = selectedAnnotation !== null
    && (annotationNameDraft.trim() !== selectedAnnotation.name
      || annotationDescriptionDraft !== (selectedAnnotation.description ?? ''))
  const panelId = `${occurrenceKey}:${surface}:panel`
  const panelTitleId = `${panelId}:title`
  const tabLabel = (value: PanelTab): string => value === 'imagery' ? t('panel.tab.imagery') : value === 'ai' ? t('panel.tab.layers') : t('panel.tab.annotation')
  const tabBody = (value: PanelTab, content: ReactNode): ReactNode => {
    return (
      <div data-map-panel-tab-body={value} role="tabpanel" id={`${panelId}:body:${value}`} aria-labelledby={`${panelId}:tab:${value}`} hidden={!open || activeTab !== value} tabIndex={0}>{content}</div>
    )
  }

  const annotationContent = (
        <>
      {annotationSurface && <div data-map-panel-annotations="" role="group" aria-label={t('panel.annotation.title')}>
        <div data-map-panel-annotation-tools="" role="group" aria-label={t('panel.annotation.tools')}>
          {ANNOTATION_TOOLS.map(kind => (
            <Button key={kind} size="sm" variant="outline" disabled={!canWrite || drawingStatus !== 'idle'}
              aria-pressed={drawingStatus === 'drawing' && drawingKind === kind ? true : undefined}
              aria-label={t('panel.annotation.create', { kind: t(`panel.annotation.kind.${kind}` as const) })}
              onClick={() => startAnnotation(kind)}>
              {t(`panel.annotation.kind.${kind}` as const)}
            </Button>
          ))}
          {drawingStatus !== 'idle' && (
            <Button size="sm" onClick={cancelAnnotationDrawing}>{t('panel.annotation.cancel')}</Button>
          )}
          {/* One numeral keeps the drawing tools on a single line at 280px; the
              full sentence stays the accessible name. */}
          <span data-map-panel-bulk-count="" aria-label={t('panel.annotation.count', { count: String(annotations.length) })} title={t('panel.annotation.count', { count: String(annotations.length) })}>{annotations.length}</span>
          <div data-map-panel-annotation-menu="">
            <Menu
              open={annotationMenuOpen}
              onClose={() => setAnnotationMenuOpen(false)}
              align="end"
              portal
              anchor={(
                <Button size="sm" variant="ghost" data-map-panel-icon="" aria-haspopup="menu" aria-expanded={annotationMenuOpen}
                  aria-label={t('panel.annotation.more')} title={t('panel.annotation.more')}
                  onClick={() => setAnnotationMenuOpen(previous => !previous)}>⋯</Button>
              )}
            >
              <MenuItemButton disabled={!canWrite || undoableAnnotation?.operationId == null}
                onSelect={() => { setAnnotationMenuOpen(false); undoLatestAnnotation() }}>
                {t('panel.annotation.undo')}
              </MenuItemButton>
              <MenuItemButton disabled={panelSubmit === undefined || busy || annotations.length === 0}
                onSelect={() => { setAnnotationMenuOpen(false); exportAnnotations() }}>
                {t('panel.annotation.export')}
              </MenuItemButton>
            </Menu>
          </div>
        </div>
        {drawingStatus !== 'idle' && <small role="status">{t(`panel.annotation.status.${drawingStatus}` as const)}</small>}
        {drawingError !== null && <small role="alert">{t(`panel.annotation.error.${drawingError}` as const)}</small>}
        {(annotations.length > 4 || annotationSearch !== '') && (
          <Input
            type="search"
            data-map-panel-search=""
            className="map-panel-search"
            aria-label={t('panel.annotation.search')}
            placeholder={t('panel.annotation.search')}
            value={annotationSearch}
            onInput={event => setAnnotationSearch(event.currentTarget.value)}
          />
        )}
        <div ref={annotationListRef} data-map-panel-list="" data-overflow={!unifiedSurface && annotationListOverflows ? '' : undefined}>
          {annotations.length === 0 && <p data-map-panel-empty="">{t('panel.annotation.empty')}</p>}
          {annotations.length > 0 && searchedAnnotations.length === 0 && <p data-map-panel-empty="">{t('panel.annotation.noMatches')}</p>}
          <div role="table" aria-label={t('panel.tab.annotation')} data-map-panel-table-list="">
            <TableHeader t={t} />
            <div role="rowgroup">
          {searchedAnnotations.map(annotation => (
            <AnnotationRow
              key={annotation.id}
              annotation={annotation}
              t={t}
              onOpen={() => {
                setAnnotationDialogFor(annotation.id)
                setAnnotationNameDraft(annotation.name)
                setAnnotationDescriptionDraft(annotation.description ?? '')
                setConfirmAnnotationDelete(false)
              }}
              onLocate={() => occurrence()?.focusFeature(annotationLayer?.id ?? 'user-annotations', annotation.id)}
            />
          ))}
            </div>
          </div>
        </div>
        {!unifiedSurface && annotationListOverflows && <small data-map-panel-scroll-hint="">{t('panel.scrollHint')}</small>}
        {selectedAnnotation !== null && (
          <AnnotationDialog
            key={selectedAnnotation.id}
            annotation={selectedAnnotation}
            t={t}
            canWrite={canWrite}
            drawingBusy={drawingStatus !== 'idle'}
            name={annotationNameDraft}
            description={annotationDescriptionDraft}
            dirty={selectedAnnotationDirty}
            confirmDelete={confirmAnnotationDelete}
            onName={setAnnotationNameDraft}
            onDescription={setAnnotationDescriptionDraft}
            onConfirmDelete={setConfirmAnnotationDelete}
            onSave={saveSelectedAnnotation}
            onEditGeometry={() => startAnnotationGeometryEdit(selectedAnnotation)}
            onPreset={presetId => styleSelectedAnnotation(presetId)}
            onDelete={deleteSelectedAnnotation}
            onClose={() => { setAnnotationDialogFor(null); setConfirmAnnotationDelete(false) }}
          />
        )}
      </div>}
        </>
  )

  const layersContent = (
    <>
      {aiSurface && (faces.length > 4 || search !== '') && (
        <Input
          type="search"
          data-map-panel-search=""
          className="map-panel-search"
          aria-label={t('panel.search.label')}
          placeholder={t('panel.search.label')}
          value={search}
          onInput={event => setSearch(event.currentTarget.value)}
        />
      )}

      {aiSurface && faces.length > 0 && (
        <div data-map-panel-bulk="" role="group" aria-label={t('panel.bulkScope', { count: String(faces.length) })}>
          <Button variant="outline" size="sm" type="button" disabled={!canWrite} onClick={() => setVisibleAll(true)}>{t('panel.showAll')}</Button>
          <Button variant="outline" size="sm" type="button" disabled={!canWrite} onClick={() => setVisibleAll(false)}>{t('panel.hideAll')}</Button>
          <span data-map-panel-bulk-count="">{t('panel.bulkScope', { count: String(faces.length) })}</span>
          <div data-map-panel-bulk-menu="">
            <Menu
              open={bulkMenuOpen}
              onClose={() => setBulkMenuOpen(false)}
              align="end"
              portal
              anchor={(
                <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="menu" aria-expanded={bulkMenuOpen}
                  aria-label={t('panel.bulkMore')} title={t('panel.bulkMore')}
                  onClick={() => setBulkMenuOpen(previous => !previous)}>⋯</Button>
              )}
            >
              <MenuItemButton danger disabled={!canWrite} onSelect={() => { setBulkMenuOpen(false); setConfirmClear(true) }}>
                {t('panel.clearAll.withCount', { count: String(faces.length) })}
              </MenuItemButton>
            </Menu>
          </div>
        </div>
      )}

      {aiSurface && confirmClear && (
        <div data-map-panel-bulk-confirm="" role="group" aria-label={t('panel.clearAll.confirm', { count: String(faces.length) })}>
          <span>{t('panel.clearAll.confirm', { count: String(faces.length) })}</span>
          <Button variant="outline" size="sm" type="button" data-danger="" disabled={!canWrite} onClick={() => { setConfirmClear(false); void clearAll() }}>{t('panel.clearAll.confirm.button')}</Button>
          <Button variant="outline" size="sm" type="button" onClick={() => setConfirmClear(false)}>{t('panel.removeCancel')}</Button>
        </div>
      )}

      {aiSurface && <div ref={listRef} data-map-panel-list="" data-overflow={!unifiedSurface && listOverflows ? '' : undefined} onDragOver={event => { if (dragging !== null) event.preventDefault() }} onDrop={event => onDrop(event, null)}>
        {aiSurface && pendingRows.length > 0 && (
        <section data-map-panel-pending="" aria-label={t('panel.pending.title', { count: String(pendingRows.length) })}>
          <header data-map-panel-pending-head="">
            <span>{t('panel.pending.title', { count: String(pendingRows.length) })}</span>
            <small>{t('panel.pending.hint')}</small>
          </header>
          <div role="table" aria-label={t('panel.pending.title', { count: String(pendingRows.length) })} data-map-panel-table-list=""><TableHeader t={t} /><div role="rowgroup">
          {pendingRows.map(row => (
            <PendingRow
              key={rowId(row)}
              row={row}
              t={t}
              canWrite={canWrite}
              onPreview={() => previewCandidate(row)}
              onConfirm={() => acceptCandidate(row)}
              onCancel={() => rejectCandidate(row)}
              onOpen={() => setDialogFor(rowId(row))}
            />
          ))}
          </div></div>
        </section>
      )}
        {rows.length === 0 && pendingRows.length === 0 && <p data-map-panel-empty="">{t(allRows.length === 0 ? 'panel.noLayers' : 'panel.noMatches')}</p>}
        <div role="table" aria-label={t('panel.tab.layers')} data-map-panel-table-list=""><TableHeader t={t} /><div role="rowgroup">
        {rows.map(row => {
          if (row.kind !== 'layer') return <CandidateRow key={rowId(row)} row={row} t={t} onOpen={() => setDialogFor(rowId(row))} />
          const layer = row.layer
          return (
                <LayerRow
                  key={layer.id}
                  layer={layer}
                  wire={wire}
                  t={t}
                  canWrite={canWrite}
                  canExport={panelSubmit !== undefined}
                  operationPending={busy}
                  menuOpen={dialogFor === layer.id}
                  onMenu={() => setDialogFor(dialogFor === layer.id ? null : layer.id)}
                  tableOpen={tableFor === layer.id}
                  onTable={() => { setTableFor(tableFor === layer.id ? null : layer.id); setAttributePage(0); setDialogFor(null) }}
                  attributePage={attributePage}
                  onAttributePage={setAttributePage}
                  dragging={dragging === layer.id}
                  dropTarget={dropTarget === layer.id}
                  onDragStart={() => setDragging(layer.id)}
                  onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                  onDragOver={() => { if (dragging !== null && dragging !== layer.id) setDropTarget(layer.id) }}
                  onDrop={event => onDrop(event, layer.id)}
                  onToggle={() => setVisible([layer], !layer.visible)}
                  onZoom={() => occurrence()?.focusLayer(layer.id)}
                  onFeature={featureId => occurrence()?.focusFeature(layer.id, featureId)}
                  onMove={step => moveLayer(layer.id, null, step)}
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
                    write(
                      { op: 'set-symbol-preset', layerId: layer.id, preset: preset.id },
                      t('panel.summary.preset', { name: layer.name, preset: preset.label }),
                    )
                  }}
                  onColor={symbol => {
                    write({ op: 'set-symbol-style', layerId: layer.id, symbol }, t('panel.summary.color', { name: layer.name }))
                  }}
                  onExport={format => requestExport(layer, format)}
                  onDownload={ref => download(ref)}
                  onRemove={() => {
                    write({ op: 'remove-layer', layerId: layer.id }, t('panel.summary.remove', { name: layer.name }), () => setDialogFor(null))
                  }}
                />
          )
        })}
        </div></div>
      </div>}
    </>
  )

  const imageryContent = (
        <>
      {imagerySurface && <div data-map-panel-sources="" role="group" aria-label={t('panel.imagery.title')}>
        {sourceResource.status === 'loading' && <small>{t('panel.source.loading')}</small>}
        {sourceResource.status !== 'live' && sourceResource.status !== 'loading' && <small role="alert">{t('panel.source.error')}</small>}
        <div data-map-panel-list="" role="table" aria-label={t('panel.tab.imagery')} data-map-panel-table-list=""><TableHeader t={t} /><div role="rowgroup">
            <div data-map-imagery-row="" data-imagery-kind="labels" role="row">
              <div data-map-panel-row="" data-mapbox-panel-row="" data-state={imageryDisplay.labelsVisible ? 'visible' : 'hidden'}>
                <span role="cell" data-map-panel-main-cell="">
                <span data-map-panel-handle="" aria-hidden="true" />
                <span data-map-panel-type="" role="img" aria-label={t('panel.badge.imagery')}>{t('panel.badge.imagery')}</span>
                <span data-map-panel-identity="">
                  <span data-map-panel-name-row="">
                    <span data-map-panel-name="" title={t('panel.imagery.tab.labels')}>{t('panel.imagery.tab.labels')}</span>
                    <small data-map-panel-state="" data-state={imageryDisplay.labelsVisible ? 'visible' : 'hidden'}>
                      {t(imageryDisplay.labelsVisible ? 'panel.state.visible' : 'panel.state.hidden')}
                    </small>
                  </span>
                  <span data-map-panel-chip=""><small>{currentLabel?.title ?? t('panel.source.off')}</small></span>
                </span>
                </span>
                <span role="cell" data-map-panel-action-cell="">
                <EyeButton
                  visible={imageryDisplay.labelsVisible}
                  disabled={!sourceCanWrite}
                  label={t(imageryDisplay.labelsVisible ? 'panel.hide' : 'panel.show', { name: t('panel.imagery.tab.labels') })}
                  onClick={() => writeImageryDisplay({ ...imageryDisplay, labelsVisible: !imageryDisplay.labelsVisible }, t('panel.imagery.summary.labels'))}
                />
                <span data-map-panel-actions="">
                  <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-label={t('panel.more', { name: t('panel.imagery.tab.labels') })} title={t('panel.more', { name: t('panel.imagery.tab.labels') })}
                    onClick={() => setImageryDialogFor(previous => previous === 'labels' ? null : 'labels')}>⋯</Button>
                </span>
                </span>
              </div>
            </div>
            <div data-map-imagery-row="" data-imagery-kind="recent" role="row">
              <div data-map-panel-row="" data-mapbox-panel-row="" data-state={imageryDisplay.recentVisible ? 'visible' : 'hidden'}>
                <span role="cell" data-map-panel-main-cell="">
                <span data-map-panel-handle="" aria-hidden="true" />
                <span data-map-panel-type="" role="img" aria-label={t('panel.badge.imagery')}>{t('panel.badge.imagery')}</span>
                <span data-map-panel-identity="">
                  <span data-map-panel-name-row="">
                    <span data-map-panel-name="" title={t('panel.imagery.tab.recent')}>{t('panel.imagery.tab.recent')}</span>
                    <small data-map-panel-state="" data-state={imageryDisplay.recentVisible ? 'visible' : 'hidden'}>
                      {t(imageryDisplay.recentVisible ? 'panel.state.visible' : 'panel.state.hidden')}
                    </small>
                  </span>
                  <span data-map-panel-chip=""><small>{currentBase?.title ?? t('panel.imagery.sourceNone')} · {Math.round(imageryDisplay.recentOpacity * 100)}%</small></span>
                </span>
                </span>
                <span role="cell" data-map-panel-action-cell="">
                <EyeButton
                  visible={imageryDisplay.recentVisible}
                  disabled={!sourceCanWrite}
                  label={t(imageryDisplay.recentVisible ? 'panel.hide' : 'panel.show', { name: t('panel.imagery.tab.recent') })}
                  onClick={() => writeImageryDisplay({ ...imageryDisplay, recentVisible: !imageryDisplay.recentVisible }, t('panel.imagery.summary.recent'))}
                />
                <span data-map-panel-actions="">
                  <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-label={t('panel.more', { name: t('panel.imagery.tab.recent') })} title={t('panel.more', { name: t('panel.imagery.tab.recent') })}
                    onClick={() => setImageryDialogFor(previous => previous === 'recent' ? null : 'recent')}>⋯</Button>
                </span>
                </span>
              </div>
            </div>
            <div data-map-imagery-row="" data-imagery-kind="early" role="row">
              <div data-map-panel-row="" data-mapbox-panel-row="" data-state={imageryDisplay.earlyVisible ? 'visible' : 'hidden'}>
                <span role="cell" data-map-panel-main-cell="">
                <span data-map-panel-handle="" aria-hidden="true" />
                <span data-map-panel-type="" role="img" aria-label={t('panel.badge.imagery')}>{t('panel.badge.imagery')}</span>
                <span data-map-panel-identity="">
                  <span data-map-panel-name-row="">
                    <span data-map-panel-name="" title={t('panel.imagery.tab.early')}>{t('panel.imagery.tab.early')}</span>
                    <small data-map-panel-state="" data-state={imageryDisplay.earlyVisible ? 'visible' : 'hidden'}>
                      {t(imageryDisplay.earlyVisible ? 'panel.state.visible' : 'panel.state.hidden')}
                    </small>
                  </span>
                  <span data-map-panel-chip=""><small>{imageryDisplay.earlySource?.title ?? t('panel.imagery.sourceNone')}</small></span>
                </span>
                </span>
                <span role="cell" data-map-panel-action-cell="">
                <EyeButton
                  visible={imageryDisplay.earlyVisible}
                  disabled={!sourceCanWrite || imageryDisplay.earlySource === null}
                  label={t(imageryDisplay.earlyVisible ? 'panel.hide' : 'panel.show', { name: t('panel.imagery.tab.early') })}
                  onClick={() => writeImageryDisplay(blendEarlyImagery({ ...imageryDisplay, earlyVisible: !imageryDisplay.earlyVisible }), t('panel.imagery.summary.early'))}
                />
                <span data-map-panel-actions="">
                  <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-label={t('panel.more', { name: t('panel.imagery.tab.early') })} title={t('panel.more', { name: t('panel.imagery.tab.early') })}
                    onClick={() => setImageryDialogFor(previous => previous === 'early' ? null : 'early')}>⋯</Button>
                </span>
                </span>
              </div>
            </div>
          </div></div>
      </div>}
      {imageryDialogFor === 'labels' && (
        <ImageryDialog title={t('panel.imagery.tab.labels')} t={t} onClose={() => setImageryDialogFor(null)}>
          <label data-map-panel-field="">
            <span>{t('panel.source.labels')}</span>
            <select
              data-map-panel-source="labels"
              value={currentLabelId ?? ''}
              disabled={!sourceCanWrite || currentBase === undefined || currentBase.availability.kind !== 'configured'}
              onChange={event => {
                if (currentBase === undefined) return
                if (event.currentTarget.value === '') {
                  writeBasemap(currentBase, null)
                  return
                }
                const next = compatibleLabels.find(source => source.id === event.currentTarget.value)
                if (next !== undefined && next.availability.kind === 'configured') writeBasemap(currentBase, next)
              }}
            >
              <option value="">{t('panel.source.off')}</option>
              {currentLabel !== undefined && !compatibleLabels.some(source => source.id === currentLabel.id) && (
                <option value={currentLabel.id}>{currentLabel.title}</option>
              )}
              {compatibleLabels.map(source => (
                <option key={source.id} value={source.id} disabled={source.availability.kind !== 'configured'}>
                  {source.availability.kind === 'configured' ? source.title : `${source.title} · ${t('panel.source.unavailable')}`}
                </option>
              ))}
            </select>
            {currentLabel !== undefined && <small data-map-panel-source-title="">{currentLabel.title}</small>}
          </label>
        </ImageryDialog>
      )}
      {imageryDialogFor === 'recent' && (
        <ImageryDialog title={t('panel.imagery.tab.recent')} t={t} onClose={() => setImageryDialogFor(null)}>
          <label data-map-panel-field="">
            <span>{t('panel.source.base')}</span>
            <select
              data-map-panel-source="base"
              value={currentBaseId}
              disabled={!sourceCanWrite}
              onChange={event => {
                const next = baseSources.find(source => source.id === event.currentTarget.value)
                if (next === undefined || next.availability.kind !== 'configured') return
                const keep = currentLabelId === null
                  ? undefined
                  : compatibleLabels.find(source => source.id === currentLabelId && source.compatibleBasemapIds.includes(next.id))
                writeBasemap(next, keep ?? null)
              }}
            >
              {currentBase !== undefined && !baseSources.some(source => source.id === currentBase.id) && (
                <option value={currentBase.id}>{currentBase.title}</option>
              )}
              {baseSources.filter(source => source.id !== 'esri-wayback').map(source => (
                <option key={source.id} value={source.id} disabled={source.availability.kind !== 'configured'}>
                  {source.availability.kind === 'configured' ? source.title : `${source.title} · ${t('panel.source.unavailable')}`}
                </option>
              ))}
            </select>
            {currentBase !== undefined && <small data-map-panel-source-title="">{currentBase.title}</small>}
          </label>
          <label data-map-panel-field="">
            <span>{t('panel.imagery.opacity')}</span>
            <input
              type="range"
              data-map-imagery-opacity=""
              min="0"
              max="1"
              step="0.05"
              value={imageryDisplay.recentOpacity}
              disabled={!sourceCanWrite || !imageryDisplay.recentVisible}
              onInput={event => writeImageryDisplay({ ...imageryDisplay, recentOpacity: Number(event.currentTarget.value) }, t('panel.imagery.summary.recent'))}
              onChange={event => writeImageryDisplay({ ...imageryDisplay, recentOpacity: Number(event.currentTarget.value) }, t('panel.imagery.summary.recent'))}
            />
            <output>{Math.round(imageryDisplay.recentOpacity * 100)}%</output>
          </label>
        </ImageryDialog>
      )}
      {imageryDialogFor === 'early' && (
        <ImageryDialog title={t('panel.imagery.tab.early')} t={t} onClose={() => setImageryDialogFor(null)}>
          <WaybackPanel
            sessionId={sessionId}
            canWrite={sourceCanWrite}
            current={imageryDisplay.earlySource}
            t={t}
            onSelect={source => writeImageryDisplay(blendEarlyImagery({
              ...imageryDisplay,
              earlySource: source,
              earlyVisible: source === null ? false : true,
            }), t('panel.imagery.summary.early'))}
          />
        </ImageryDialog>
      )}
        </>
  )

  return (
    <section
      ref={panelRef}
      data-map-panel=""
      data-map-panel-surface={surface}
      data-map-panel-collapsed={open ? undefined : ''}
      role="region" aria-labelledby={panelTitleId} aria-busy={busy}
      style={panelRect === null ? undefined : {
        position: 'absolute', left: `${panelRect.x}px`, top: `${panelRect.y}px`,
        right: 'auto', bottom: 'auto', margin: 0, width: `${panelRect.width}px`, height: `${panelRect.height}px`,
        maxWidth: 'none', maxHeight: 'none',
      }}
    >
      <header data-map-panel-header="" onPointerDown={event => startPanelGesture(event, null)}>
        {unifiedSurface ? (
          <>
            <span data-map-panel-grip="" aria-hidden="true">⋮⋮</span>
            <h2 id={panelTitleId} data-map-panel-visually-hidden="">{panelTitle}</h2>
            <div data-map-panel-tabs="">
              <SegmentedTabs size="sm" label={panelTitle} value={activeTab}
                items={[
                  { value: 'imagery', label: <span data-map-panel-tab="imagery">{tabLabel('imagery')}</span>, id: `${panelId}:tab:imagery`, panelId: `${panelId}:body:imagery` },
                  { value: 'ai', label: <span data-map-panel-tab="ai">{tabLabel('ai')}</span>, id: `${panelId}:tab:ai`, panelId: `${panelId}:body:ai` },
                  { value: 'annotation', label: <span data-map-panel-tab="annotation">{tabLabel('annotation')}</span>, id: `${panelId}:tab:annotation`, panelId: `${panelId}:body:annotation` },
                ]}
                onChange={value => { setActiveTab(value); if (!open) setOpen(true) }} />
            </div>
          </>
        ) : <><LayersIcon /><h2 id={panelTitleId}>{panelTitle}</h2></>}
        {showLayerMeta && <span data-map-panel-meta="">{t('panel.layerCount', { count: String(faces.length) })}</span>}
        <Button
          variant="ghost" size="sm" type="button" data-map-panel-icon="" data-map-panel-collapse=""
          aria-expanded={open} aria-label={open ? t('panel.collapse') : t('panel.expand')}
          title={open ? t('panel.collapse') : t('panel.expand')}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </Button>
      </header>

      {unifiedSurface ? (
        <div data-map-panel-body="" hidden={!open}>
          {tabBody('imagery', imageryContent)}
          {tabBody('ai', layersContent)}
          {tabBody('annotation', annotationContent)}
        </div>
      ) : open && (
        <>
          {annotationContent}
          {layersContent}
          {imageryContent}
        </>
      )}

      {!unifiedSurface && open && listOverflows && <small data-map-panel-scroll-hint="">{t('panel.scrollHint')}</small>}

      {unifiedSurface && open && RESIZE_DIRECTIONS.map(direction => (
        <span key={direction} data-map-panel-resize={direction} aria-hidden="true" onPointerDown={event => { event.stopPropagation(); startPanelGesture(event, direction) }} />
      ))}

      {notice !== null && <Toast text={notice.text} {...(notice.ok ? { tone: 'success' as const } : {})} onDone={() => setNotice(null)} />}

      {dialogRow?.kind === 'proposal' && <CandidateDialog key={dialogRow.proposal.id} row={dialogRow} t={t} sessionId={sessionId} imageUrl={imageUrl} canWrite={canWrite} onAccept={(name, note) => reviewProposal(dialogRow.proposal, true, name, note)} onReject={(name, note) => reviewProposal(dialogRow.proposal, false, name, note)} onClose={() => setDialogFor(null)} />}
      {dialogRow?.kind === 'change' && <CandidateDialog key={dialogRow.change.id} row={dialogRow} t={t} sessionId={sessionId} imageUrl={imageUrl} canWrite={canWrite} onAccept={(name, note) => reviewChange(dialogRow.change, true, name, note)} onReject={(name, note) => reviewChange(dialogRow.change, false, name, note)} onClose={() => setDialogFor(null)} />}
    </section>
  )
}

/** User annotation tools and post-draw management as a standalone surface. */
export function UserAnnotationPanel(props: LayerPanelProps): ReactNode {
  return <LayerPanel {...props} surface="annotation" />
}

/** AI-produced data layers as a standalone surface. */
export function AIDataLayerPanel(props: LayerPanelProps): ReactNode {
  return <LayerPanel {...props} surface="ai" />
}

/** Current and historical imagery resources as a standalone surface. */
export function ImageryResourcePanel(props: LayerPanelProps): ReactNode {
  return <LayerPanel {...props} surface="imagery" />
}

/** The single resident map panel card that hosts imagery, layers, and annotations. */
export function UnifiedMapPanel(props: LayerPanelProps): ReactNode {
  return <LayerPanel {...props} surface="unified" />
}

/** One user annotation row in the shared layer-row anatomy: swatch, name, and hover actions. */
function AnnotationRow({ annotation, t, onOpen, onLocate }: {
  readonly annotation: PanelAnnotationFace
  readonly t: TranslateNS<'mapContainer'>
  readonly onOpen: () => void
  readonly onLocate: () => void
}): ReactNode {
  return (
    <div data-map-annotation-row="" role="row">
      <div data-map-panel-row="" data-mapbox-panel-row="">
        <span role="cell" data-map-panel-main-cell="">
        <span data-map-panel-handle="" aria-hidden="true" />
        <span data-map-panel-swatch="" data-kind={annotation.geometryType} role="img" aria-label={t(`panel.annotation.kind.${annotation.geometryType}` as const)}>
          <span data-map-panel-badge="" style={{ background: annotation.color }} />
        </span>
        <Button variant="ghost" size="sm" type="button" data-map-panel-name="" aria-haspopup="dialog" title={annotation.name} onClick={onOpen}><span>{annotation.name}</span></Button>
        <small data-map-panel-meta="">{t(`panel.annotation.kind.${annotation.geometryType}` as const)}</small>
        </span>
        <span role="cell" data-map-panel-action-cell="">
        <span data-map-panel-actions="">
          <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-label={t('panel.annotation.locate', { name: annotation.name })} title={t('panel.annotation.locate', { name: annotation.name })} onClick={onLocate}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="M8 1v3M8 12v3M1 8h3M12 8h3" /></svg>
          </Button>
          <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-label={t('panel.more', { name: annotation.name })} title={t('panel.more', { name: annotation.name })} onClick={onOpen}>⋯</Button>
        </span>
        </span>
      </div>
    </div>
  )
}

/** The operation dialog for one annotation: text fields, style preset, geometry edit, and two-step delete. */
function AnnotationDialog({ annotation, t, canWrite, drawingBusy, name, description, dirty, confirmDelete, onName, onDescription, onConfirmDelete, onSave, onEditGeometry, onPreset, onDelete, onClose }: {
  readonly annotation: PanelAnnotationFace
  readonly t: TranslateNS<'mapContainer'>
  readonly canWrite: boolean
  readonly drawingBusy: boolean
  readonly name: string
  readonly description: string
  readonly dirty: boolean
  readonly confirmDelete: boolean
  readonly onName: (value: string) => void
  readonly onDescription: (value: string) => void
  readonly onConfirmDelete: (value: boolean) => void
  readonly onSave: () => void
  readonly onEditGeometry: () => void
  readonly onPreset: (presetId: string) => void
  readonly onDelete: () => void
  readonly onClose: () => void
}): ReactNode {
  return (
    <Modal open title={annotation.name} closeLabel={t('panel.dialogClose')} onClose={onClose} className="map-layer-dialog" contentClassName="map-layer-dialog-content">
      <div data-map-annotation-dialog="" role="group" aria-label={t('panel.annotation.edit', { name: annotation.name })}>
        <div data-map-layer-dialog-summary="">
          <Tag>{t(`panel.annotation.kind.${annotation.geometryType}` as const)}</Tag>
          {annotation.updatedAt !== '' && <small>{t('panel.annotation.updated', { date: annotation.updatedAt.slice(0, 10) })}</small>}
        </div>
        <label data-map-panel-field="">
          <span>{t('panel.annotation.name')}</span>
          <Input value={name} disabled={!canWrite} onInput={event => onName(event.currentTarget.value)} />
        </label>
        <label data-map-panel-field="">
          <span>{t('panel.annotation.description')}</span>
          <Input value={description} disabled={!canWrite} onInput={event => onDescription(event.currentTarget.value)} />
        </label>
        <label data-map-panel-field="">
          <span>{t('panel.annotation.style')}</span>
          <select
            data-map-annotation-style=""
            aria-label={t('panel.annotation.style.select')}
            value=""
            disabled={!canWrite}
            onChange={event => onPreset(event.currentTarget.value)}
          >
            <option value="">{t('panel.annotation.style.select')}</option>
            {SYMBOL_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <div data-map-panel-menu-items="">
          <Button variant="outline" size="sm" type="button" disabled={!canWrite || drawingBusy} aria-label={t('panel.annotation.editGeometry', { name: annotation.name })} onClick={onEditGeometry}>{t('panel.annotation.editGeometry.button')}</Button>
          {confirmDelete
            ? (
              <>
                <Button variant="outline" size="sm" type="button" data-danger="" disabled={!canWrite} onClick={onDelete}>{t('panel.annotation.deleteConfirm.button')}</Button>
                <Button variant="outline" size="sm" type="button" onClick={() => onConfirmDelete(false)}>{t('panel.removeCancel')}</Button>
              </>
            )
            : <Button variant="outline" size="sm" type="button" data-danger="" disabled={!canWrite} aria-label={t('panel.annotation.delete', { name: annotation.name })} onClick={() => onConfirmDelete(true)}>{t('panel.annotation.delete.button')}</Button>}
        </div>
        <div data-map-panel-actions="">
          <Button variant="primary" disabled={!canWrite || !dirty} onClick={onSave}>{t('panel.annotation.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}

/** One shared source dialog for an imagery row: its selects, slider, or release catalog. */
function ImageryDialog({ title, t, onClose, children }: {
  readonly title: string
  readonly t: TranslateNS<'mapContainer'>
  readonly onClose: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <Modal open title={title} closeLabel={t('panel.dialogClose')} onClose={onClose} className="map-layer-dialog" contentClassName="map-layer-dialog-content">
      <div data-map-imagery-dialog="" role="group" aria-label={title}>{children}</div>
    </Modal>
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
    <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" data-map-panel-eye="" aria-pressed={visible} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
        {!visible && <path d="M2.5 13.5 13.5 2.5" />}
      </svg>
    </Button>
  )
}

/** One layer row with its hover actions, operation dialog trigger, and attribute table. */
function LayerRow({ layer, wire, t, canWrite, canExport, operationPending, menuOpen, onMenu, tableOpen, onTable, attributePage, onAttributePage, dragging, dropTarget, onDragStart, onDragEnd, onDragOver, onDrop, onToggle, onZoom, onFeature, onMove, opacity, onOpacityDraft, onOpacityCommit, onPreset, onColor, onExport, onDownload, onRemove }: {
  readonly layer: PanelLayerFace
  readonly wire: MapContainerWire
  readonly t: TranslateNS<'mapContainer'>
  readonly canWrite: boolean
  readonly canExport: boolean
  readonly operationPending: boolean
  readonly menuOpen: boolean
  readonly onMenu: () => void
  readonly tableOpen: boolean
  readonly onTable: () => void
  readonly attributePage: number
  readonly onAttributePage: (page: number) => void
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
  readonly onColor: (symbol: import('@map-harness/map-layers').SymbolStyle) => void
  readonly onExport: (format: PanelExportFormat) => void
  readonly onDownload: (ref: string) => void
  readonly onRemove: () => void
}): ReactNode {
  return (
    <div
      data-map-panel-layer=""
      role="row"
      data-hidden={layer.visible ? undefined : ''}
      data-dragging={dragging ? '' : undefined}
      data-drop-target={dropTarget ? '' : undefined}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); onDragOver() }}
      onDrop={event => { event.stopPropagation(); onDrop(event) }}
    >
      <div data-map-panel-row="" data-mapbox-panel-row="" data-state={layer.visible ? 'visible' : 'hidden'}>
        <span role="cell" data-map-panel-main-cell="">
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
        <Button variant="ghost" size="sm" type="button" data-map-panel-swatch="" data-kind={layer.badge} data-editable="" title={t('panel.colorOf', { name: layer.name })} aria-label={t('panel.colorOf', { name: layer.name })} onClick={event => { event.currentTarget.focus(); onMenu() }}>
          {layer.chip === null ? <span data-map-panel-type="" role="img" aria-label={t('panel.badge.imagery')}>{t('panel.badge.imagery')}</span>
            : layer.chip.colors.length === 0
              ? <span data-map-panel-type="" role="img" aria-label={t(`panel.badge.${layer.badge}` as const)}>{t(`panel.badge.${layer.badge}` as const)}</span>
              : <span data-map-panel-badge="" aria-hidden="true">{layer.chip.colors.map((color, index) => <span key={index} style={{ background: color }} />)}</span>}
        </Button>
        <span data-map-panel-identity="">
          <span data-map-panel-name-row="">
            <span data-map-panel-name="" title={layer.name}>{layer.name}</span>
            <small data-map-panel-state="" data-state={layer.visible ? 'visible' : 'hidden'}>
              {t(layer.visible ? 'panel.state.visible' : 'panel.state.hidden')}
            </small>
          </span>
          {layer.chip !== null && (layer.style !== undefined || layer.symbol?.presentation === 'heatmap') && (
            <span data-map-panel-chip="" aria-label={t('panel.legend')}>
              {layer.symbol?.presentation === 'heatmap'
                ? <span data-map-panel-ramp="" aria-hidden="true">{layer.chip.colors.map((color, index) => <span key={index} style={{ background: color }} />)}</span>
                : layer.chip.rows.filter(row => row.kind === 'class').map((row, index) => <span key={index} role="img" aria-label={t('workbench.legend.class', { n: String(row.index + 1) })} style={{ background: row.color }} />)}
            </span>
          )}
        </span>
        </span>
        <span role="cell" data-map-panel-action-cell="">
        <EyeButton visible={layer.visible} disabled={!canWrite} label={t(layer.visible ? 'panel.hide' : 'panel.show', { name: layer.name })} onClick={onToggle} />
        <span data-map-panel-actions="">
          <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-label={t('panel.zoomTo')} title={t('panel.zoomTo')} onClick={onZoom}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="M8 1v3M8 12v3M1 8h3M12 8h3" /></svg>
          </Button>
          <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-expanded={menuOpen} aria-label={t('panel.more', { name: layer.name })} title={t('panel.more', { name: layer.name })} onClick={event => { event.currentTarget.focus(); onMenu() }}>⋯</Button>
        </span>
        </span>
      </div>

      {menuOpen && <div role="cell"><LayerDialog layer={layer} t={t} canWrite={canWrite} canExport={canExport} operationPending={operationPending} onClose={onMenu} opacity={opacity} onOpacityDraft={onOpacityDraft} onOpacityCommit={onOpacityCommit} onPreset={onPreset} onColor={onColor} onMove={onMove} onTable={onTable} tableOpen={tableOpen} onExport={onExport} onDownload={onDownload} onRemove={onRemove} /></div>}

      {tableOpen && <div role="cell"><AttributeTable layer={layer} wire={wire} t={t} page={attributePage} onPage={onAttributePage} onFeature={onFeature} /></div>}
    </div>
  )
}

/** The one operation dialog shared by More and the editable swatch. */
function LayerDialog({ layer, t, canWrite, canExport, operationPending, onClose, opacity, onOpacityDraft, onOpacityCommit, onPreset, onColor, onMove, onTable, tableOpen, onExport, onDownload, onRemove }: {
  readonly layer: PanelLayerFace
  readonly t: TranslateNS<'mapContainer'>
  readonly canWrite: boolean
  readonly canExport: boolean
  readonly operationPending: boolean
  readonly onClose: () => void
  readonly opacity: number
  readonly onOpacityDraft: (value: number) => void
  readonly onOpacityCommit: (value: number) => void
  readonly onPreset: (preset: { readonly id: string; readonly label: string }) => void
  readonly onColor: (symbol: import('@map-harness/map-layers').SymbolStyle) => void
  readonly onMove: (step: -1 | 1) => void
  readonly onTable: () => void
  readonly tableOpen: boolean
  readonly onExport: (format: PanelExportFormat) => void
  readonly onDownload: (ref: string) => void
  readonly onRemove: () => void
}): ReactNode {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const resolvedSymbol = singleSymbolOf(layer)
  const editable = layer.style === undefined && resolvedSymbol !== undefined
  const initial = resolvedSymbol === undefined ? '#4264fb' : panelSymbolColorOf(layer, resolvedSymbol) ?? '#4264fb'
  const [draft, setDraft] = useState(initial)
  const [colorError, setColorError] = useState<string | null>(null)
  const applyColor = (): void => {
    const color = draft.trim().toLowerCase()
    if (!/^#[0-9a-f]{6}$/u.test(color)) {
      setColorError(t('panel.color.invalid'))
      return
    }
    setColorError(null)
    const symbol = resolvedSymbol
    if (symbol === undefined) {
      setColorError(t('panel.colorPresetOnly'))
      return
    }
    onColor(panelSymbolWithColor(symbol, color))
  }
  return (
    <Modal open title={layer.name} closeLabel={t('panel.close')} onClose={onClose} className="map-layer-dialog" contentClassName="map-layer-dialog-content">
      <div data-map-panel-menu="" role="group" aria-label={t('panel.more', { name: layer.name })}>
        <div data-map-layer-dialog-summary="">
          <Tag>{t(`panel.badge.${layer.badge}` as const)}</Tag>
          <span>{t('panel.featureCount', { count: String(layer.featureCount) })}</span>
        </div>
        {layer.chip !== null && layer.chip.rows.length > 0 && <LayerLegend rows={layer.chip.rows} t={t} />}
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
                    <Button variant="ghost" size="sm" key={preset.id} type="button" data-map-panel-preset="" disabled={!canWrite} title={preset.label} aria-label={preset.label} onClick={() => onPreset(preset)}>
                      <span style={{ background: color ?? 'transparent' }} />
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
          {editable && (
            <div data-map-panel-field="" data-map-panel-color-field="">
              <span>{t('panel.color')}</span>
              <div data-map-panel-color-row="">
                <input type="color" value={draft} disabled={!canWrite} aria-label={t('panel.colorPicker', { name: layer.name })} onChange={event => { setDraft(event.currentTarget.value); setColorError(null) }} />
                <Input value={draft} maxLength={7} disabled={!canWrite} aria-label={t('panel.colorHex', { name: layer.name })} onInput={event => { setDraft(event.currentTarget.value); setColorError(null) }} />
            <Button size="sm" disabled={!canWrite} onClick={applyColor}>{t('panel.colorApply')}</Button>
              </div>
              {colorError !== null && <small role="alert" data-map-panel-color-error="">{colorError}</small>}
            </div>
          )}
          {!editable && <small data-map-panel-color-disabled="">{t('panel.colorPresetOnly')}</small>}
          <div data-map-panel-menu-items="">
            <Button variant="outline" size="sm" type="button" disabled={!canWrite} onClick={() => onMove(-1)}>{t('panel.moveUp')}</Button>
            <Button variant="outline" size="sm" type="button" disabled={!canWrite} onClick={() => onMove(1)}>{t('panel.moveDown')}</Button>
            <Button variant="outline" size="sm" type="button" aria-expanded={tableOpen} onClick={onTable}>{t('panel.attributes')}</Button>
            {layer.ref !== null && <Button variant="outline" size="sm" type="button" aria-label={t('panel.download', { ref: layer.ref })} onClick={() => onDownload(layer.ref ?? '')}>{t('panel.download.button')}</Button>}
          </div>
          {canExport && (
            <div data-map-panel-field="">
              <span>{t('panel.export.button')}</span>
              <div data-map-panel-chips="">
                {EXPORT_FORMATS.map(format => (
                  <Button variant="outline" size="sm" key={format} type="button" disabled={operationPending} onClick={() => onExport(format)}>{t(`panel.export.format.${format}` as const)}</Button>
                ))}
              </div>
            </div>
          )}
          <div data-map-panel-menu-items="">
            {confirmRemove
              ? (
                <>
                  <Button variant="outline" size="sm" type="button" data-danger="" disabled={!canWrite} aria-label={t('panel.removeConfirm', { name: layer.name })} onClick={onRemove}>{t('panel.removeConfirm.button')}</Button>
                  <Button variant="outline" size="sm" type="button" onClick={() => setConfirmRemove(false)}>{t('panel.removeCancel')}</Button>
                </>
              )
              : <Button variant="outline" size="sm" type="button" data-danger="" disabled={!canWrite} onClick={() => setConfirmRemove(true)}>{t('panel.remove.button')}</Button>}
          </div>
      </div>
    </Modal>
  )
}

function LayerLegend({ rows, t }: { readonly rows: readonly PanelLegendRow[]; readonly t: TranslateNS<'mapContainer'> }): ReactNode {
  const labelOf = (row: PanelLegendRow): string => {
    switch (row.kind) {
      case 'symbol': return t(row.geometry === 'Point' ? 'panel.badge.point' : row.geometry === 'LineString' ? 'panel.badge.line' : 'panel.badge.polygon')
      case 'class': return `${t(row.geometry === 'Point' ? 'panel.badge.point' : row.geometry === 'LineString' ? 'panel.badge.line' : 'panel.badge.polygon')} · ${t('workbench.legend.class', { n: String(row.index + 1) })}: [${row.from}, ${row.to}${row.inclusive ? ']' : ')'}`
      case 'missing': return `${t(row.geometry === 'Point' ? 'panel.badge.point' : row.geometry === 'LineString' ? 'panel.badge.line' : 'panel.badge.polygon')} · ${t('workbench.legend.missing')}`
      case 'underflow': return `${t(row.geometry === 'Point' ? 'panel.badge.point' : row.geometry === 'LineString' ? 'panel.badge.line' : 'panel.badge.polygon')} · ${t('panel.legend.underflow')}`
      case 'overflow': return `${t(row.geometry === 'Point' ? 'panel.badge.point' : row.geometry === 'LineString' ? 'panel.badge.line' : 'panel.badge.polygon')} · ${t('panel.legend.overflow')}`
      case 'feature': return t('panel.legend.feature', { id: row.id })
      case 'heatmap': return t('panel.legend.stop', { n: String(row.index + 1) })
    }
  }
  return <section data-map-panel-legend="" aria-label={t('panel.legend')}>
    <span>{t('panel.legend')}</span>
    <ul>{rows.map((row, index) => <li key={index}><span data-map-panel-legend-color="" style={{ background: row.color }} aria-hidden="true" /><span>{labelOf(row)}: {row.color}</span></li>)}</ul>
  </section>
}

type CandidateRowFace = Extract<PanelRowFace, { readonly kind: 'proposal' | 'change' }>

function candidateStatusLabel(status: string, t: TranslateNS<'mapContainer'>): string {
  return status === 'accepted' ? t('panel.proposal.accepted')
    : status === 'rejected' ? t('panel.proposal.rejected')
      : status === 'agent-applied' ? t('panel.proposal.agentApplied')
        : status === 'agent-dismissed' ? t('panel.proposal.agentDismissed') : t('panel.proposal.pending')
}

/** One unresolved candidate in the explicit pending-review section. */
function PendingRow({ row, t, canWrite, onPreview, onConfirm, onCancel, onOpen }: {
  readonly row: CandidateRowFace
  readonly t: TranslateNS<'mapContainer'>
  readonly canWrite: boolean
  readonly onPreview: () => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onOpen: () => void
}): ReactNode {
  const candidate = row.kind === 'proposal' ? row.proposal : row.change
  return (
    <div role="row" data-map-panel-pending-row="" data-map-panel-proposal={row.kind === 'proposal' ? '' : undefined} data-map-panel-change={row.kind === 'change' ? '' : undefined} data-proposal-id={row.kind === 'proposal' ? candidate.id : undefined} data-change-id={row.kind === 'change' ? candidate.id : undefined} data-status={candidate.status}>
      <div role="cell" data-map-panel-pending-main="">
        <span data-map-panel-pending-swatch={row.kind} aria-hidden="true" />
        <span data-map-panel-pending-name="" title={candidate.name}>{candidate.name}</span>
        <Tag tone="warning">{candidateStatusLabel(candidate.status, t)}</Tag>
      </div>
      <div role="cell" data-map-panel-pending-actions="">
        <Button size="sm" variant="outline" onClick={onPreview}>{t('panel.pending.preview')}</Button>
        <Button size="sm" variant="primary" disabled={!canWrite} onClick={onConfirm}>{t('panel.pending.confirm')}</Button>
        <Button size="sm" variant="ghost" disabled={!canWrite} onClick={onCancel}>{t('panel.pending.cancel')}</Button>
        <Button size="sm" variant="ghost" type="button" data-map-panel-icon="" data-map-panel-proposal-select={row.kind === 'proposal' ? '' : undefined} data-map-panel-change-select={row.kind === 'change' ? '' : undefined} aria-haspopup="dialog" aria-label={t('panel.more', { name: candidate.name })} title={t('panel.more', { name: candidate.name })} onClick={onOpen}>⋯</Button>
      </div>
    </div>
  )
}

/** One candidate row; all review and evidence live in the shared dialog. */
function CandidateRow({ row, t, onOpen }: {
  readonly row: PanelRowFace
  readonly t: TranslateNS<'mapContainer'>
  readonly onOpen: () => void
}): ReactNode {
  if (row.kind === 'layer') return null
  const candidate = row.kind === 'proposal' ? row.proposal : row.change
  return (
    <div role="row" data-map-panel-layer="" data-map-panel-proposal={row.kind === 'proposal' ? '' : undefined} data-map-panel-change={row.kind === 'change' ? '' : undefined} data-proposal-id={row.kind === 'proposal' ? candidate.id : undefined} data-change-id={row.kind === 'change' ? candidate.id : undefined} data-status={candidate.status}>
      <div data-map-panel-row="" data-mapbox-panel-row="">
        <span role="cell" data-map-panel-main-cell="">
        <span data-map-panel-handle="" aria-hidden="true" />
        <span data-map-panel-swatch="" data-kind="data" role="img" aria-label={t('panel.candidate.marker')}><span data-map-panel-badge="" style={{ background: '#86909c' }} /></span>
        <Button variant="ghost" size="sm" type="button" data-map-panel-name="" data-map-panel-proposal-select={row.kind === 'proposal' ? '' : undefined} data-map-panel-change-select={row.kind === 'change' ? '' : undefined} aria-haspopup="dialog" title={candidate.name} onClick={onOpen}><span>{candidate.name}</span></Button>
        <small data-map-panel-meta="">{candidateStatusLabel(candidate.status, t)}</small>
        </span>
        <span role="cell" data-map-panel-action-cell="">
        <span data-map-panel-actions="">
          <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-haspopup="dialog" aria-label={t('panel.more', { name: candidate.name })} title={t('panel.more', { name: candidate.name })} onClick={onOpen}>⋯</Button>
        </span>
        </span>
      </div>
    </div>
  )
}

/** Review and evidence for one candidate, without a group heading. */
function CandidateDialog({ row, t, sessionId, imageUrl, canWrite, onAccept, onReject, onClose }: {
  readonly row: CandidateRowFace
  readonly t: TranslateNS<'mapContainer'>
  readonly sessionId: string
  readonly imageUrl: MapImageUrl | undefined
  readonly canWrite: boolean
  readonly onAccept: (name: string, note: string) => void
  readonly onReject: (name: string, note: string) => void
  readonly onClose: () => void
}): ReactNode {
  const candidate = row.kind === 'proposal' ? row.proposal : row.change
  const [name, setName] = useState(candidate.name)
  const [note, setNote] = useState(candidate.note)
  const pending = candidate.status === 'proposed' || candidate.status === 'pending'
  return (
    <Modal open title={candidate.name} closeLabel={t('panel.dialogClose')} onClose={onClose} className="map-layer-dialog" contentClassName="map-layer-dialog-content">
      <div data-map-candidate-dialog="" data-map-panel-proposal={row.kind === 'proposal' ? '' : undefined} data-map-panel-change={row.kind === 'change' ? '' : undefined} data-status={candidate.status}>
        <div data-map-layer-dialog-summary="">
          {row.kind === 'proposal' ? <Tag tone="info">{t('panel.proposal.targetLabel')}</Tag> : <Tag tone="info">{t(CHANGE_KINDS[row.change.kind] ?? 'panel.change.kind.uncertain')}</Tag>}
          <Tag tone={candidate.status === 'accepted' || candidate.status === 'agent-applied' ? 'success'
            : candidate.status === 'rejected' || candidate.status === 'agent-dismissed' ? 'neutral' : 'warning'}>{candidateStatusLabel(candidate.status, t)}</Tag>
          <small>{candidate.confidence === 'likely' ? t('panel.proposal.likely') : t('panel.proposal.uncertain')}</small>
          {candidate.humanEdited && <Tag tone="warning">{t('panel.proposal.edited')}</Tag>}
        </div>
        <p>{t('panel.proposal.probability')}</p>
        <div data-map-panel-candidate-evidence="">
          {row.kind === 'proposal'
            ? <ProposalSource proposal={row.proposal} sessionId={sessionId} imageUrl={imageUrl} t={t} />
            : <ChangeSource change={row.change} sessionId={sessionId} imageUrl={imageUrl} t={t} />}
        </div>
        {pending && (
          <div data-map-panel-proposal-editor={row.kind === 'proposal' ? '' : undefined} data-map-panel-change-editor={row.kind === 'change' ? '' : undefined}>
            <label><span>{t('panel.proposal.editName')}</span>
              <Input type="text" data-map-panel-proposal-name={row.kind === 'proposal' ? '' : undefined} data-map-panel-change-name={row.kind === 'change' ? '' : undefined} value={name} disabled={!canWrite} onInput={event => setName(event.currentTarget.value)} /></label>
            <label><span>{t('panel.proposal.editNote')}</span>
              <Input type="text" data-map-panel-proposal-note={row.kind === 'proposal' ? '' : undefined} data-map-panel-change-note={row.kind === 'change' ? '' : undefined} value={note} disabled={!canWrite} onInput={event => setNote(event.currentTarget.value)} /></label>
          </div>
        )}
        {pending && (
          <div data-map-panel-actions="">
            <Button disabled={!canWrite} onClick={() => onReject(name, note)}>{t('panel.proposal.reject')}</Button>
            <Button variant="primary" disabled={!canWrite} onClick={() => onAccept(name, note)}>{t('panel.proposal.accept')}</Button>
          </div>
        )}
      </div>
    </Modal>
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
  const currentPage = Math.min(page, pages - 1)
  const rows = attributes.rows.slice(currentPage * PANEL_ATTRIBUTE_PAGE_SIZE, (currentPage + 1) * PANEL_ATTRIBUTE_PAGE_SIZE)
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
                  <Button variant="outline" size="sm" type="button" aria-label={t('panel.attributeLocate', { id: row.id })} onClick={event => { event.stopPropagation(); onFeature(row.id) }}>{row.id}</Button>
                </td>
                {row.cells.map((cell, at) => <td key={at}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div data-map-panel-pager="">
        <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-label={t('panel.attributePrevPage')} disabled={currentPage === 0} onClick={() => onPage(Math.max(currentPage - 1, 0))}>‹</Button>
        <span>{t('panel.attributePage', { page: String(currentPage + 1), pages: String(pages) })}</span>
        <Button variant="ghost" size="sm" type="button" data-map-panel-icon="" aria-label={t('panel.attributeNextPage')} disabled={currentPage >= pages - 1} onClick={() => onPage(Math.min(currentPage + 1, pages - 1))}>›</Button>
      </div>
      {attributes.columnOverflow > 0 && <p role="note">{t('panel.columnOverflow', { max: String(PANEL_MAX_ATTRIBUTE_COLUMNS), count: String(attributes.columnOverflow) })}</p>}
      {attributes.rowOverflow > 0 && <p role="note">{t('panel.rowOverflow', { max: String(MAX_ATTRIBUTE_ROWS), count: String(attributes.rowOverflow) })}</p>}
    </div>
  )
}
