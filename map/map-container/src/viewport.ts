/**
 * Host-half live viewport: the latest settled camera each session's browser
 * reports, kept in memory so the next model request can reason over what the
 * user actually sees. The report is implicit context, not a conversation
 * message: the snapshot that carries it to the model is the logged record.
 * @module @map-harness/map-container/viewport
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'

/** Cordis service name for the live viewport registry. */
export const MAP_VIEWPORT_SERVICE = 'mapViewport'

/** Path of the viewport report route. */
export const MAP_VIEWPORT_ROUTE = '/api/map/viewport'

/** Maximum accepted report body bytes. */
const MAX_VIEWPORT_BODY_BYTES = 2048

/** Maximum sessions the registry remembers; the oldest report is evicted first. */
const MAX_VIEWPORT_SESSIONS = 256

/** One settled camera the user sees. */
export interface MapLiveViewport {
  /** View center `[x, y]` in the display WKID. */
  readonly center: readonly [number, number]
  readonly zoom: number
  /** Visible extent `[minX, minY, maxX, maxY]` in the display WKID. */
  readonly extent: readonly [number, number, number, number]
  readonly wkid: number
  readonly mode: 'map' | 'scene'
  /** ISO time the browser settled the camera. */
  readonly at: string
}

const viewportSchema = z.object({
  center: z.tuple([z.number().finite(), z.number().finite()]),
  zoom: z.number().finite().min(0).max(30),
  extent: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  wkid: z.number().int().positive(),
  mode: z.enum(['map', 'scene']),
  at: z.string().datetime(),
}).strict()

const reportSchema = z.object({
  sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  viewport: viewportSchema,
}).strict()

/** The live viewport registry surface. */
export interface MapViewportService {
  /**
   * Record one session's settled camera, replacing the previous one.
   * @param sessionId - the reporting session.
   * @param viewport - the validated camera.
   */
  report(sessionId: string, viewport: MapLiveViewport): void
  /**
   * Read the latest camera one session reported.
   * @param sessionId - the session.
   * @returns the camera, or `undefined` when the browser has reported none.
   */
  viewportOf(sessionId: string): MapLiveViewport | undefined
}

/**
 * Create the bounded in-memory registry.
 * @returns the registry.
 */
export function createMapViewportService(): MapViewportService {
  const latest = new Map<string, MapLiveViewport>()
  return {
    report(sessionId, viewport) {
      latest.delete(sessionId)
      latest.set(sessionId, viewport)
      if (latest.size > MAX_VIEWPORT_SESSIONS) {
        const oldest = latest.keys().next().value
        if (oldest !== undefined) latest.delete(oldest)
      }
    },
    viewportOf: sessionId => latest.get(sessionId),
  }
}

/**
 * Serve one viewport report.
 * @param request - POST body `{ sessionId, viewport }`.
 * @param service - the registry to record into.
 * @returns `{ ok: true }`, or a 400 refusal for an invalid body.
 */
export async function serveViewportReport(request: Request, service: MapViewportService): Promise<Response> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_VIEWPORT_BODY_BYTES) return Response.json({ ok: false, code: 'oversized' }, { status: 400 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // A body that is not JSON carries no viewport.
    return Response.json({ ok: false, code: 'invalid-viewport' }, { status: 400 })
  }
  const parsed = reportSchema.safeParse(body)
  if (!parsed.success) return Response.json({ ok: false, code: 'invalid-viewport' }, { status: 400 })
  service.report(parsed.data.sessionId, parsed.data.viewport as MapLiveViewport)
  return Response.json({ ok: true })
}

/** The minimal host Connection fetch surface this module registers through. */
interface ConnectionFetchSurface {
  readonly fetch?: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['POST']
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the viewport route when the host Connection is mounted.
 * @param ctx - host root context.
 * @param service - the registry the route records into.
 * @returns the async disposer, or `undefined` when no Connection is mounted.
 */
export function registerViewportRoute(ctx: Context, service: MapViewportService): (() => Promise<void>) | undefined {
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  return connection.fetch.register({
    path: MAP_VIEWPORT_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => serveViewportReport(request, service),
  })
}
