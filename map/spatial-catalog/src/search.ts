/** Bounded, authorization-filtered discovery of registered resource metadata. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { CatalogError } from './errors.ts'
import { parseCatalogRef, resourceIdFromName } from './refs.ts'
import { readVersionRow } from './register.ts'
import type { ResourceVersion } from './types.ts'

/** Catalog-result metadata admits at most sixteen resources per response. */
export const MAX_RESOURCE_SEARCH_RESULTS = 16

const text = z.string().min(1).max(256)
const timestamp = z.string().datetime({ offset: true })
const searchSchema = z.object({
  name: text.optional(),
  query: text.trim().min(1).optional(),
  fields: z.array(text).min(1).max(16).optional(),
  geometry_type: z.enum(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']).optional(),
  crs: text.optional(),
  bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  time: z.object({ from: timestamp.optional(), to: timestamp.optional() }).strict()
    .refine(value => value.from !== undefined || value.to !== undefined, 'time requires from or to')
    .refine(value => value.from === undefined || value.to === undefined || Date.parse(value.from) <= Date.parse(value.to), 'time.from must not follow time.to')
    .optional(),
  include_versions: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAX_RESOURCE_SEARCH_RESULTS).default(8),
  offset: z.number().int().nonnegative().default(0),
}).strict().superRefine((value, ctx) => {
  if (value.bbox === undefined) return
  if (value.crs === undefined) ctx.addIssue({ code: 'custom', message: 'bbox requires an explicit crs', path: ['crs'] })
  if (value.bbox[0] > value.bbox[2] || value.bbox[1] > value.bbox[3]) {
    ctx.addIssue({ code: 'custom', message: 'bbox must be ordered minX,minY,maxX,maxY', path: ['bbox'] })
  }
})

/** Validated metadata filters with explicit pagination defaults. */
export type ResourceSearchSpec = z.infer<typeof searchSchema>

/** One live metadata page; exact refs remain immutable after later searches. */
export interface ResourceSearchResult {
  readonly resources: readonly ResourceVersion[]
  readonly hasMore: boolean
  readonly nextOffset: number | null
}

/**
 * Validate model/file JSON and resolve metadata-query defaults.
 * @param input - a JSON search object; an empty object lists current resources.
 * @returns validated filters; a bbox is interpreted only in its declared CRS.
 * @throws {CatalogError} CATALOG_INVALID_INPUT for invalid or unknown fields.
 */
export function resolveResourceSearch(input: unknown): ResourceSearchSpec {
  const parsed = searchSchema.safeParse(input)
  if (!parsed.success) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `invalid resource search: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return parsed.data
}

/**
 * Read a live page after tenant/domain ACL and recall filtering, before LIMIT.
 * Names match the exact registration identity; query matches field names,
 * geometry types or CRS, not feature values or an external data directory.
 * Newer inaccessible versions never cause an older version to appear as head.
 * @param db - this session's open catalog database.
 * @param search - validated filters from resolveResourceSearch.
 * @param authorization - host-owned authorization domain.
 * @param tenant - host-owned tenant.
 * @returns bounded resource metadata, without reading any geometry bytes.
 */
export function searchResources(
  db: DatabaseSync,
  search: ResourceSearchSpec,
  authorization: string,
  tenant: string,
): ResourceSearchResult {
  const where = [
    "r.state = 'available' AND r.authorization = ?",
    "NOT EXISTS (SELECT 1 FROM governance_recall x WHERE x.tenant = a.tenant AND (x.scope = 'tenant' OR (x.object_kind = 'resource' AND x.ref = a.ref)))",
  ]
  const params: SQLInputValue[] = [tenant, authorization, authorization]
  if (!search.include_versions) where.push('NOT EXISTS (SELECT 1 FROM catalog_resources newer WHERE newer.logical_id = r.logical_id AND newer.version > r.version)')
  if (search.name !== undefined) {
    where.push('r.logical_id = ?')
    params.push(resourceIdFromName(search.name))
  }
  if (search.query !== undefined) {
    where.push("(EXISTS (SELECT 1 FROM json_each(r.schema_fields) f WHERE instr(lower(json_extract(f.value, '$.name')), ?) > 0) OR instr(lower(r.geometry_types), ?) > 0 OR instr(lower(r.native_crs), ?) > 0)")
    const query = search.query.toLowerCase()
    params.push(query, query, query)
  }
  for (const field of search.fields ?? []) {
    where.push("EXISTS (SELECT 1 FROM json_each(r.schema_fields) f WHERE json_extract(f.value, '$.name') = ?)")
    params.push(field)
  }
  if (search.geometry_type !== undefined) {
    where.push('EXISTS (SELECT 1 FROM json_each(r.geometry_types) g WHERE g.value = ?)')
    params.push(search.geometry_type)
  }
  if (search.crs !== undefined) {
    where.push('r.native_crs = ?')
    params.push(search.crs)
  }
  if (search.bbox !== undefined) {
    where.push("r.extent IS NOT NULL AND json_extract(r.extent, '$[0]') <= ? AND json_extract(r.extent, '$[2]') >= ? AND json_extract(r.extent, '$[1]') <= ? AND json_extract(r.extent, '$[3]') >= ?")
    params.push(search.bbox[2], search.bbox[0], search.bbox[3], search.bbox[1])
  }
  if (search.time !== undefined) {
    // A registration timestamp is not a data-validity timestamp. Unknown
    // or unbounded validity cannot prove overlap with the requested window.
    where.push('r.valid_time IS NOT NULL')
    if (search.time.from !== undefined) {
      where.push("julianday(json_extract(r.valid_time, '$.to')) >= julianday(?)")
      params.push(search.time.from)
    }
    if (search.time.to !== undefined) {
      where.push("julianday(json_extract(r.valid_time, '$.from')) <= julianday(?)")
      params.push(search.time.to)
    }
  }
  const rows = db.prepare(
    'SELECT r.logical_id AS id, r.version FROM catalog_resources r '
    + "JOIN governance_acl a ON a.object_kind = 'resource' AND a.ref = r.logical_id || '@v' || r.version "
    + "AND a.tenant = ? AND a.domain = ? AND a.state = 'granted' "
    + `WHERE ${where.join(' AND ')} ORDER BY r.logical_id, r.version DESC LIMIT ? OFFSET ?`,
  ).all(...params, search.limit + 1, search.offset)
  const resources = rows.slice(0, search.limit).map(row => {
    if (typeof row.id !== 'string' || typeof row.version !== 'number') {
      throw new CatalogError('CATALOG_IO', 'invalid resource identity in catalog search')
    }
    const ref = parseCatalogRef(`${row.id}@v${row.version}`)
    if (ref.kind !== 'resource') throw new CatalogError('CATALOG_IO', 'catalog search returned a non-resource identity')
    return readVersionRow(db, ref.text)
  })
  const hasMore = rows.length > search.limit
  return { resources, hasMore, nextOffset: hasMore ? search.offset + resources.length : null }
}
