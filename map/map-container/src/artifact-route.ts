/**
 * Host-half artifact download: the `GET /api/map/artifact` route that streams
 * one exact catalog version's bytes to the session's browser. The catalog's
 * session view is the authorization domain — `forSession(session)` reads only
 * that session's store, and the read itself re-runs authorization and
 * whole-content digest verification. The route adds only what the browser
 * needs: an exact-ref whitelist, a fixed refusal vocabulary with no storage
 * detail, and an octet-stream response.
 *
 * The route never lists, writes, or resolves loose references: it accepts one
 * `res-…@vN` / `art-…@vN` ref and nothing else.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MAX_ARTIFACT_BYTES, parseCatalogRef } from '@map-harness/spatial-catalog'
import type { SessionSpatialCatalog } from '@map-harness/spatial-catalog'

/** Path of the artifact download route. */
export const MAP_ARTIFACT_ROUTE = '/api/map/artifact'

/** Maximum accepted session id length; the id is opaque, not a ref. */
const MAX_SESSION_ID_CHARS = 128

/** Maximum accepted ref length (the catalog grammar is far shorter). */
const MAX_REF_CHARS = 256

/** The fixed refusal vocabulary: stable codes, never storage detail. */
export type ArtifactRefusalCode = 'unknown-session' | 'unknown-ref' | 'unauthorized' | 'digest-mismatch'

/** The catalog face the route reads through (the process router, structurally narrowed). */
export interface ArtifactCatalog {
  /** Bind one session's own store view. */
  forSession(sessionId: string): Pick<SessionSpatialCatalog, 'readResourceBytes' | 'readArtifactBytes'>
  /** The authorization domain every host-owned read presents. */
  deploymentDomain(): string
}

/** The minimal host Connection fetch surface this module registers through. */
interface ConnectionFetchSurface {
  readonly fetch?: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['GET']
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** One refusal response with its fixed code. */
function refuse(code: ArtifactRefusalCode): Response {
  const status = code === 'unknown-session'
    ? 400
    : code === 'unknown-ref'
      ? 404
      : code === 'unauthorized'
        ? 403
        : 409
  return Response.json({ ok: false, code }, { status })
}

/** Map one thrown catalog failure onto the fixed refusal vocabulary; everything else fails closed. */
function refusalOf(error: unknown): ArtifactRefusalCode {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'GOVERNANCE_DENIED' || code === 'CATALOG_REVOKED') return 'unauthorized'
  if (code === 'CATALOG_DIGEST_MISMATCH') return 'digest-mismatch'
  return 'unknown-ref'
}

/** Whether one session id has the opaque shape the route accepts. */
function admissibleSession(session: string | null): session is string {
  return session !== null && session.length > 0 && session.length <= MAX_SESSION_ID_CHARS && /^[A-Za-z0-9._:-]+$/u.test(session)
}

/** One byte view whose backing buffer is an `ArrayBuffer` (the `Response` body type); copies only a shared-buffer view. */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes)
}

/** One octet-stream response carrying the exact version bytes. */
function bytesResponse(bytes: Uint8Array, ref: string): Response {
  return new Response(bodyOf(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="${ref}"`,
      'cache-control': 'no-store',
    },
  })
}

/**
 * Serve one artifact download request: validate the parameter set, parse the
 * exact ref, read through the session's catalog view, and stream the bytes.
 * @param request - the incoming GET request.
 * @param catalog - the catalog router the read goes through.
 * @returns the download response or one fixed refusal.
 */
export async function serveArtifactRequest(request: Request, catalog: ArtifactCatalog): Promise<Response> {
  const url = new URL(request.url)
  // Parameter whitelist: the request names exactly one session and one ref.
  for (const key of url.searchParams.keys()) {
    if (key !== 'session' && key !== 'ref') return refuse('unknown-ref')
  }
  const session = url.searchParams.get('session')
  if (!admissibleSession(session)) return refuse('unknown-session')
  const ref = url.searchParams.get('ref')
  if (ref === null || ref.length === 0 || ref.length > MAX_REF_CHARS) return refuse('unknown-ref')
  let kind: 'resource' | 'artifact'
  try {
    kind = parseCatalogRef(ref).kind
  } catch {
    // Unparseable or non-exact references (missing `@vN`) never reach the store.
    return refuse('unknown-ref')
  }
  const view = catalog.forSession(session)
  try {
    if (kind === 'resource') {
      const read = await view.readResourceBytes(ref, catalog.deploymentDomain(), MAX_ARTIFACT_BYTES)
      return bytesResponse(read.bytes, ref)
    }
    const read = await view.readArtifactBytes(ref, catalog.deploymentDomain())
    return bytesResponse(read.bytes, ref)
  } catch (error) {
    return refuse(refusalOf(error))
  }
}

/**
 * Register the `/api/map/artifact` download route when the host Connection is
 * present. The route validates the parameter set and ref grammar; the
 * catalog's session view owns authorization and digest verification.
 * @param ctx - host root context.
 * @param catalog - the spatial catalog router the read goes through.
 * @returns the async disposer, or `undefined` when no Connection is mounted.
 */
export function registerArtifactRoute(ctx: Context, catalog: ArtifactCatalog): (() => Promise<void>) | undefined {
  // Optional access: pure-Node hosts mount no Connection, and the plugin must
  // not require one — the absent service reads as `undefined`.
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  return connection.fetch.register({
    path: MAP_ARTIFACT_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => serveArtifactRequest(request, catalog),
  })
}
