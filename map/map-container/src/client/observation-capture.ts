/**
 * The single capture transaction for visual observation: freeze the view
 * identity (concrete view, generation, camera/gesture epochs, source
 * digest, CSS size, render receipt), claim the pending request from the
 * host, sample `toMap` control points, `takeScreenshot`, composite the
 * committed labels plus the source-attribution footer, and submit the PNG
 * with its capture receipt — rechecking the frozen identity after every
 * await so a replaced view, camera move, source change, resize, gesture, or
 * dispose invalidates the in-flight capture rather than submitting stale
 * pixels. The legacy `captureView()` face shares this transaction core.
 * @module @map-harness/map-container/client/observation-capture
 */
import { expectedObservationSources, type ObservationCamera } from '../observation-protocol.ts'
import type { MapObservationCapture, ObservationDeclineCode } from '../observation.ts'
import type MapView from '@arcgis/core/views/MapView.js'
import type SceneView from '@arcgis/core/views/SceneView.js'
import type { ScreenPoint } from '@arcgis/core/core/types.js'
import { deriveGeoreference, type ControlSample } from './capture-math.ts'
import { LABEL_FONT_FAMILY, LABEL_FONT_PX, LABEL_STROKE_COLOR, LABEL_STROKE_WIDTH_PX } from './labeling.ts'
import { mapCaptureFooterColors } from './map-theme.ts'

/** The minimal 2D view surface the capture reads. */
export interface CaptureView {
  readonly destroyed: boolean
  readonly width: number
  readonly height: number
  readonly padding?: { top: number; right: number; bottom: number; left: number }
  readonly rotation: number | undefined
  readonly scale: number
  readonly zoom: number
  readonly center: { x: number; y: number } | undefined
  readonly extent: { xmin: number; ymin: number; xmax: number; ymax: number } | undefined
  readonly spatialReference: { wkid: number | null | undefined } | undefined
  takeScreenshot(options: { format: 'png'; ignorePadding: true; width: number; height: number }): Promise<{ dataUrl: string; width: number; height: number }>
  toMap(point: { x: number; y: number }): { x: number; y: number } | null
}

/** Adapt an actual ArcGIS view to the capture face using Screenshot.data dimensions. */
export function captureViewOf(view: MapView | SceneView): CaptureView {
  return {
    get destroyed() { return view.destroyed },
    get width() { return view.width },
    get height() { return view.height },
    get padding() { return view.padding },
    get rotation() { return 'rotation' in view ? view.rotation : undefined },
    get scale() { return view.scale },
    get zoom() { return view.zoom },
    get center() {
      const center = view.center
      return center == null ? undefined : { x: center.x, y: center.y }
    },
    get extent() {
      const extent = view.extent
      return extent == null ? undefined : { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax }
    },
    get spatialReference() {
      const spatialReference = view.spatialReference
      return spatialReference == null ? undefined : { wkid: spatialReference.wkid }
    },
    async takeScreenshot(options) {
      const shot = await view.takeScreenshot(options)
      return { dataUrl: shot.dataUrl, width: shot.data.width, height: shot.data.height }
    },
    toMap(point) {
      const world = view.toMap(point as ScreenPoint)
      return world == null ? null : { x: world.x, y: world.y }
    },
  }
}

/** One committed label from the LabelOverlay (CSS position + text + color). */
export interface CommittedLabel {
  readonly key: string
  readonly text: string
  readonly x: number
  readonly y: number
  readonly color: string
}

/** The identity the capture freezes before sampling. */
export interface CaptureIdentity {
  readonly viewId: string
  readonly generation: number
  /** Current projection revision sampled with the render receipt. */
  readonly mapRevision?: number
  readonly cameraEpoch: number
  readonly gestureEpoch: number
  /** Digest of the rendered source set (layers + basemap) at freeze time. */
  readonly sourceDigest: string
  /** Render receipt's rendered revision, or `null` when not yet rendered. */
  readonly renderedRevision: number | null
  /** Whether every required rendered layer (basemap included) is healthy. */
  readonly layersHealthy: boolean
  /** Actual camera/extent/scale/rotation sample; epoch changes also catch move-away-and-back. */
  readonly cameraSignature?: string
  /** Actual CSS viewport size and padding; separate epochs catch resize-away-and-back. */
  readonly layoutSignature?: string
  /** View paint health at freeze time. */
  readonly paintSignature?: string
  /** Number of observed ArcGIS `updating` transitions on this view. */
  readonly renderUpdateEpoch?: number
  /** ArcGIS `updating` state at the identity sample. */
  readonly updating?: boolean
}

/** Read the current identity; the transaction compares after every await. */
export type CaptureIdentityProbe = () => CaptureIdentity

/** Why a capture transaction may refuse (mapped to authored decline codes). */
export type CaptureRefusal = 'no-view' | 'not-ready' | 'stale' | 'capture-failed' | 'no-context'

/** The transaction verdict: the composited product, or a named refusal with optional SDK detail. */
export type CaptureVerdict = CaptureProduct | { readonly refusal: CaptureRefusal; readonly detail?: string }

/** Whether one verdict is a refusal. */
export function isCaptureRefusal(verdict: CaptureVerdict): verdict is { refusal: CaptureRefusal; detail?: string } {
  return 'refusal' in verdict
}

/** The composited output of one successful transaction. */
export interface CaptureProduct {
  readonly pngBase64: string
  readonly imageSize: { width: number; height: number }
  readonly mapContentRect: { x: number; y: number; width: number; height: number }
  readonly cssViewSize: { width: number; height: number }
  readonly camera: ObservationCamera | null
  readonly georeference: ReturnType<typeof deriveGeoreference>
}

/** Attribution footer line height in CSS pixels. */
const FOOTER_LINE_HEIGHT_PX = 16

/** Maximum footer lines appended to one PNG. */
const MAX_ATTRIBUTION_ROWS = 16

/** Maximum attribution input copied into the screenshot. */
const MAX_ATTRIBUTION_CHARS = 512

/** Wrap one bounded attribution using the actual Canvas font metrics. */
function attributionLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] | null {
  if (text.length > MAX_ATTRIBUTION_CHARS || maxWidth <= 0) return null
  const words = text.trim().split(/\s+/u).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    if (line !== '') {
      lines.push(line)
      if (lines.length >= MAX_ATTRIBUTION_ROWS) return null
    }
    line = ''
    for (const character of Array.from(word)) {
      const next = `${line}${character}`
      if (ctx.measureText(character).width > maxWidth) return null
      if (ctx.measureText(next).width <= maxWidth) {
        line = next
      } else {
        lines.push(line)
        if (lines.length >= MAX_ATTRIBUTION_ROWS) return null
        line = character
      }
    }
  }
  if (line !== '') lines.push(line)
  return lines.length > 0 && lines.length <= MAX_ATTRIBUTION_ROWS ? lines : null
}

/**
 * Read one camera snapshot from the live view, or `null` when the SDK cannot
 * report it (allowed only with a `none` georeference naming unreadable-camera).
 */
export function cameraOf(view: CaptureView, mode: 'map' | 'scene'): ObservationCamera | null {
  const center = view.center
  const extent = view.extent
  const wkid = view.spatialReference?.wkid
  const rotation = typeof view.rotation === 'number' && Number.isFinite(view.rotation) ? view.rotation : 0
  const padding = [view.padding?.top ?? 0, view.padding?.right ?? 0, view.padding?.bottom ?? 0, view.padding?.left ?? 0] as const
  if (center === undefined || extent === undefined || wkid === undefined || wkid === null
    || !Number.isInteger(wkid) || wkid <= 0
    || ![center.x, center.y, extent.xmin, extent.ymin, extent.xmax, extent.ymax, view.scale, rotation, ...padding].every(Number.isFinite)) return null
  const zoom = Number.isFinite(view.zoom) && view.zoom >= 0 ? view.zoom : null
  return {
    center: [center.x, center.y],
    extent: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
    wkid,
    scale: view.scale,
    zoom,
    rotation,
    mode,
    padding,
  }
}

/** Sample `toMap` at one CSS point; non-finite or missing points become NaN. */
function sample(view: CaptureView, x: number, y: number): ControlSample {
  const world = view.toMap({ x, y })
  return { css: [x, y], world: world === null ? [Number.NaN, Number.NaN] : [world.x, world.y] }
}

/**
 * Run the compositing stage: draw the SDK screenshot, overlay the committed
 * labels at their CSS positions (same font/stroke source as the DOM overlay),
 * and append the attribution footer. Returns the PNG base64 without header.
 * @returns `null` when no canvas context exists (a hard failure, never a silent uncomposited fallback).
 */
export function compositeCapture(
  shot: { dataUrl: string; width: number; height: number },
  cssViewSize: { width: number; height: number },
  labels: readonly CommittedLabel[],
  attribution: string,
  decodeImage: (dataUrl: string, signal?: AbortSignal) => Promise<{ width: number; height: number; source: CanvasImageSource } | null>,
  signal?: AbortSignal,
): Promise<{ pngBase64: string; imageSize: { width: number; height: number }; mapContentRect: { x: number; y: number; width: number; height: number } } | null> {
  return decodeImage(shot.dataUrl, signal).then(decoded => {
    if (decoded === null) return null
    if (decoded.width !== shot.width || decoded.height !== shot.height) return null
    const document = globalThis.document as { createElement(tag: string): HTMLCanvasElement } | undefined
    if (document === undefined) return null
    const dprScaleX = shot.width / cssViewSize.width
    const dprScaleY = shot.height / cssViewSize.height
    const horizontalPadding = 4 * dprScaleX
    const availableWidth = Math.max(1, shot.width - horizontalPadding * 2)
    const measureCanvas = document.createElement('canvas')
    const measureContext = measureCanvas.getContext('2d')
    if (measureContext === null) return null
    measureContext.font = `${12 * dprScaleY}px ${LABEL_FONT_FAMILY}`
    const lines = attributionLines(measureContext, attribution, availableWidth)
    if (lines === null) return null
    const lineHeight = FOOTER_LINE_HEIGHT_PX * dprScaleY
    const footerPx = Math.max(1, Math.ceil(lines.length * lineHeight + 4 * dprScaleY))
    const canvas = document.createElement('canvas')
    canvas.width = shot.width
    canvas.height = shot.height + footerPx
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    ctx.drawImage(decoded.source, 0, 0, shot.width, shot.height)
    // Committed labels at CSS positions, scaled into output pixels.
    ctx.font = `500 ${LABEL_FONT_PX * dprScaleY}px/1.2 ${LABEL_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = LABEL_STROKE_WIDTH_PX * dprScaleY
    ctx.strokeStyle = LABEL_STROKE_COLOR
    for (const label of labels) {
      const x = label.x * dprScaleX
      const y = label.y * dprScaleY
      ctx.strokeText(label.text, x, y)
      ctx.fillStyle = label.color
      ctx.fillText(label.text, x, y)
    }
    // Attribution footer uses map-theme tokens and wraps at a fixed CSS size.
    const footerStyle = mapCaptureFooterColors()
    ctx.font = `${12 * dprScaleY}px ${LABEL_FONT_FAMILY}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = footerStyle.background
    ctx.fillRect(0, shot.height, shot.width, footerPx)
    ctx.fillStyle = footerStyle.foreground
    lines.forEach((line, index) => {
      ctx.fillText(line, horizontalPadding, shot.height + 2 * dprScaleY + index * lineHeight)
    })
    const mapContentRect = { x: 0, y: 0, width: shot.width, height: shot.height }
    const imageSize = { width: shot.width, height: shot.height + footerPx }
    const dataUrl = canvas.toDataURL('image/png')
    return { pngBase64: dataUrl.split(',')[1] ?? '', imageSize, mapContentRect }
  })
}

/** Load an image element for compositing (browser seam). */
export function loadImageElement(
  dataUrl: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; source: CanvasImageSource } | null> {
  return new Promise(resolve => {
    const image = new globalThis.Image()
    const cleanup = (): void => {
      if (signal !== undefined) signal.removeEventListener('abort', abort)
      image.onload = null
      image.onerror = null
    }
    const abort = (): void => {
      cleanup()
      image.src = ''
      resolve(null)
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
    }
    image.onload = () => { cleanup(); resolve({ width: image.width, height: image.height, source: image }) }
    image.onerror = () => { cleanup(); resolve(null) }
    image.src = dataUrl
  })
}

/** Post one terminal observation action without extending its capture deadline. */
async function postTerminalAction(body: unknown, expiresAtMs: number): Promise<Response | undefined> {
  const remaining = expiresAtMs - Date.now()
  if (remaining <= 0) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('observation deadline expired', 'TimeoutError')), remaining)
  try {
    return await fetch('/api/map/observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Whether one thrown value is the shared capture deadline expiring. */
export function isCaptureDeadlineError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && (error as { readonly name?: unknown }).name === 'TimeoutError'
}

/** One owner for an in-flight capture's abort signal and absolute deadline. */
export interface CaptureOperationOptions {
  readonly signal: AbortSignal
  readonly expiresAtMs: number
}

/** Await one async capture stage only while the owning operation remains live. */
async function awaitCaptureStage<T>(
  operation: () => Promise<T>,
  options: CaptureOperationOptions,
): Promise<T> {
  options.signal.throwIfAborted()
  const remaining = options.expiresAtMs - Date.now()
  if (remaining <= 0) throw new DOMException('capture deadline expired', 'TimeoutError')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(options.signal.reason ?? new DOMException('capture aborted', 'AbortError'))
      options.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new DOMException('capture deadline expired', 'TimeoutError')), remaining)
    })
    options.signal.throwIfAborted()
    if (Date.now() >= options.expiresAtMs) throw new DOMException('capture deadline expired', 'TimeoutError')
    const pending = operation()
    return await Promise.race([
      pending,
      aborted,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) options.signal.removeEventListener('abort', abort)
  }
}

/** Wait for one browser paint frame under the same capture signal/deadline. */
export async function waitForCaptureFrame(options: CaptureOperationOptions): Promise<void> {
  let frame: number | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  try {
    await awaitCaptureStage(() => new Promise<void>(resolve => {
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => resolve())
      else fallback = setTimeout(resolve, 16)
    }), options)
  } finally {
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    if (fallback !== undefined) clearTimeout(fallback)
  }
}

/** Compare capture identities while excluding only ArcGIS update state. */
export function sameCaptureIdentityOutsideUpdating(left: CaptureIdentity, right: CaptureIdentity): boolean {
  return left.viewId === right.viewId
    && left.generation === right.generation
    && left.mapRevision === right.mapRevision
    && left.cameraEpoch === right.cameraEpoch
    && left.gestureEpoch === right.gestureEpoch
    && left.sourceDigest === right.sourceDigest
    && left.renderedRevision === right.renderedRevision
    && left.layersHealthy === right.layersHealthy
    && left.cameraSignature === right.cameraSignature
    && left.layoutSignature === right.layoutSignature
    && left.paintSignature === right.paintSignature
}

/** Compare the transient ArcGIS activity omitted from the stable capture identity. */
export function sameCaptureIdentity(left: CaptureIdentity, right: CaptureIdentity): boolean {
  return sameCaptureIdentityOutsideUpdating(left, right)
    && left.renderUpdateEpoch === right.renderUpdateEpoch
    && left.updating === right.updating
}

/** Preserve the legacy capture contract, which compares only sampled update state. */
function sameCaptureIdentityAtSample(left: CaptureIdentity, right: CaptureIdentity): boolean {
  return sameCaptureIdentityOutsideUpdating(left, right)
    && left.updating === right.updating
}

/**
 * Retry a stale screenshot only after an observed ArcGIS update settles and
 * every non-update identity remains unchanged. Both retries and stability
 * frames consume the original observation deadline.
 * @param initial - the identity admitted before the first screenshot.
 * @param probe - reads the latest identity without changing the map.
 * @param requestIsCurrent - checks the exact observation request still owns capture.
 * @param viewIsStable - checks the live SDK view and render receipt are ready.
 * @param capture - captures one view and uses the supplied probe at every stage.
 * @param options - shared capture cancellation and absolute deadline.
 * @returns the capture verdict, or stale when another identity changed.
 */
export async function runCaptureWithUpdatingRetry(
  initial: CaptureIdentity,
  probe: CaptureIdentityProbe,
  requestIsCurrent: () => boolean,
  viewIsStable: () => boolean,
  capture: (frozen: CaptureIdentity, readIdentity: CaptureIdentityProbe) => Promise<CaptureVerdict>,
  options: CaptureOperationOptions,
): Promise<CaptureVerdict> {
  let frozen = initial
  let identityChanged = false
  const readIdentity = (): CaptureIdentity => {
    const live = probe()
    if (!sameCaptureIdentityOutsideUpdating(initial, live)) identityChanged = true
    return live
  }
  const assertWithinDeadline = (): void => {
    options.signal.throwIfAborted()
    if (Date.now() >= options.expiresAtMs) throw new DOMException('capture deadline expired', 'TimeoutError')
  }
  while (true) {
    assertWithinDeadline()
    if (!requestIsCurrent()) return { refusal: 'stale' }
    const verdict = await capture(frozen, readIdentity)
    assertWithinDeadline()
    const live = readIdentity()
    if (identityChanged || !requestIsCurrent()) return { refusal: 'stale' }
    if ('refusal' in verdict ? verdict.refusal !== 'stale' : sameCaptureIdentity(frozen, live)) return verdict
    if ((live.renderUpdateEpoch ?? 0) <= (frozen.renderUpdateEpoch ?? 0)) return { refusal: 'stale' }

    let stableFrames = 0
    let liveAfterFrame = live
    while (stableFrames < 2) {
      await waitForCaptureFrame(options)
      const current = readIdentity()
      if (identityChanged || !requestIsCurrent()) return { refusal: 'stale' }
      stableFrames = current.renderUpdateEpoch === liveAfterFrame.renderUpdateEpoch && current.updating === false && viewIsStable()
        ? stableFrames + 1 : 0
      liveAfterFrame = current
    }
    frozen = liveAfterFrame
  }
}

/**
 * Execute one capture transaction.
 * @param view - the frozen concrete view.
 * @param mode - the engine mode.
 * @param probe - re-reads the identity for every post-await comparison.
 * @param frozen - the identity captured before sampling.
 * @param labels - the committed LabelOverlay labels to composite.
 * @param attribution - the source attribution text for the footer.
 * @param decodeImage - image decode seam (browser `Image` in production).
 * @returns the capture product, or a refusal code.
 */
export async function runCaptureTransaction(
  view: CaptureView,
  mode: 'map' | 'scene',
  probe: CaptureIdentityProbe,
  frozen: CaptureIdentity,
  labels: readonly CommittedLabel[],
  attribution: string,
  decodeImage: (dataUrl: string, signal?: AbortSignal) => Promise<{ width: number; height: number; source: CanvasImageSource } | null>,
  options: CaptureOperationOptions,
): Promise<CaptureVerdict> {
  const sameIdentity = (): boolean => {
    return sameCaptureIdentityAtSample(frozen, probe())
  }
  if (options.signal.aborted || Date.now() >= options.expiresAtMs) return { refusal: 'stale' }
  if (!sameIdentity()) return { refusal: 'stale' }
  const cssViewSize = { width: Math.round(view.width), height: Math.round(view.height) }
  if (!(Number.isInteger(cssViewSize.width) && cssViewSize.width > 0
    && Number.isInteger(cssViewSize.height) && cssViewSize.height > 0)) return { refusal: 'no-view' }
  let shot: { dataUrl: string; width: number; height: number }
  try {
    shot = await awaitCaptureStage(
      () => view.takeScreenshot({
        format: 'png',
        ignorePadding: true,
        width: cssViewSize.width,
        height: cssViewSize.height,
      }),
      options,
    )
  } catch (error) {
    // The capture deadline is one shared operation deadline: when a stage
    // observes it as a TimeoutError the face must report capture-timeout, not
    // a generic SDK failure.
    if (isCaptureDeadlineError(error)) throw error
    return { refusal: 'capture-failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (options.signal.aborted || Date.now() >= options.expiresAtMs || !sameIdentity()) return { refusal: 'stale' }
  if (!Number.isInteger(shot.width) || shot.width <= 0 || !Number.isInteger(shot.height) || shot.height <= 0) {
    return { refusal: 'capture-failed', detail: 'the SDK screenshot has invalid image dimensions' }
  }
  // Sample AFTER the screenshot resolves so the frozen camera maps these pixels.
  const camera = cameraOf(view, mode)
  const p0 = sample(view, 0, 0)
  const p1 = sample(view, cssViewSize.width, 0)
  const p2 = sample(view, 0, cssViewSize.height)
  const controls = [
    sample(view, cssViewSize.width, cssViewSize.height),
    sample(view, cssViewSize.width / 2, cssViewSize.height / 2),
    sample(view, cssViewSize.width * 0.25, cssViewSize.height * 0.75),
    sample(view, cssViewSize.width * 0.75, cssViewSize.height * 0.25),
  ]
  const wkid = view.spatialReference?.wkid
  const georeference = camera === null || wkid === undefined || wkid === null
    ? { kind: 'none' as const, reason: 'unreadable-camera' as const }
    : deriveGeoreference(mode, wkid, p0, p1, p2, controls, cssViewSize.width, cssViewSize.height, shot.width, shot.height)
  let product: Awaited<ReturnType<typeof compositeCapture>>
  try {
    product = await awaitCaptureStage(() => compositeCapture(shot, cssViewSize, labels, attribution, decodeImage, options.signal), options)
  } catch (error) {
    // The capture deadline is one shared operation deadline: when a stage
    // observes it as a TimeoutError the face must report capture-timeout, not
    // a generic SDK failure.
    if (isCaptureDeadlineError(error)) throw error
    return { refusal: 'capture-failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (product === null) return { refusal: 'no-context' }
  if (options.signal.aborted || Date.now() >= options.expiresAtMs || !sameIdentity()) return { refusal: 'stale' }
  return {
    pngBase64: product.pngBase64,
    imageSize: product.imageSize,
    mapContentRect: product.mapContentRect,
    cssViewSize,
    camera,
    georeference,
  }
}

/**
 * Post one observation claim to the host route and await the token.
 * @returns the claim token, or `null` when the claim was refused.
 */
export async function claimObservation(
  identity: { sessionId: string; callId: string; requestSeq: number; revision: number; expiresAtMs: number },
  signal: AbortSignal,
): Promise<{ readonly status: 'claimed'; readonly token: string } | { readonly status: 'full' | 'conflict' | 'timeout' | 'cancelled' | 'unavailable' }> {
  try {
    const response = await fetch('/api/map/observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim', ...identity }),
      signal,
    })
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 'unavailable' }
    const result = body as { status?: unknown; token?: unknown }
    if (result.status === 'claimed' && typeof result.token === 'string') return { status: 'claimed', token: result.token }
    if (result.status === 'full' || result.status === 'conflict' || result.status === 'timeout' || result.status === 'cancelled') {
      return { status: result.status }
    }
    return { status: 'unavailable' }
  } catch {
    return signal.aborted ? { status: 'cancelled' } : { status: 'unavailable' }
  }
}

/** Post one token-authenticated decline for a pending request (never a fake capture). */
export async function declineObservation(
  identity: { sessionId: string; callId: string; requestSeq: number },
  token: string,
  code: ObservationDeclineCode,
  signal: AbortSignal,
  expiresAtMs: number,
): Promise<boolean> {
  if (signal.aborted) {
    const response = await postTerminalAction({ kind: 'decline', ...identity, token, code }, expiresAtMs)
    return response?.ok === true
  }
  try {
    const response = await fetch('/api/map/observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decline', ...identity, token, code }),
      signal,
    })
    return response.ok
  } catch { return false }
}

/** Post one capture submission with its token and receipt. */
export async function submitObservation(
  identity: { sessionId: string; callId: string; requestSeq: number; revision: number; token: string },
  capture: MapObservationCapture,
  signal: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code?: string }> {
  try {
    const response = await fetch('/api/map/observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'capture', ...identity, capture }),
      signal,
    })
    if (response.ok) return { ok: true }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false }
    const code = (body as { code?: unknown }).code
    return typeof code === 'string' ? { ok: false, code } : { ok: false }
  } catch { return { ok: false } }
}

/** Cancel a claimed wait with its token; cleanup runs even when the owner signal has aborted. */
export async function cancelObservation(
  identity: { sessionId: string; callId: string; requestSeq: number },
  token: string,
  expiresAtMs: number,
): Promise<boolean> {
  const response = await postTerminalAction({ action: 'cancel', ...identity, token }, expiresAtMs)
  return response?.ok === true
}

/** Compatibility name for the one shared host/client source-descriptor builder. */
export const observationSources = expectedObservationSources
