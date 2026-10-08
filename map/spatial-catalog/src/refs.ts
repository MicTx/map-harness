/**
 * Catalog identity vocabulary: branded ids, ref-string grammar, and the
 * digest helpers every catalog record derives from its bytes. Ref strings are
 * the model-visible identity form — `<kind>-<id>@v<version>` — and the only
 * handle a caller needs to read back an exact published version.
 *
 * @module @map-harness/spatial-catalog/refs
 */
import { createHash, randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { CatalogError } from './errors.ts'

/** A logical resource identity: one dataset across its versions. */
export type ResourceId = Branded<'spatial.resource-id'>

/** One published artifact identity. */
export type ArtifactId = Branded<'spatial.artifact-id'>

/** A stable within-version feature identity (`f-<hash16>`). */
export type FeatureRef = Branded<'spatial.feature-ref'>

/** A publish operation identity derived from the owning session call. */
export type OperationRef = Branded<'spatial.operation-ref'>

/** Model-visible ref string for one exact resource version (`res-…@vN`). */
export type ResourceRef = Branded<'spatial.resource-ref'>

/** Model-visible ref string for one exact artifact version (`art-…@vN`). */
export type ArtifactRef = Branded<'spatial.artifact-ref'>

/** Mint a fresh logical resource id for an unnamed register call. */
export function newResourceId(): ResourceId {
  return brandString<ResourceId>(`res-${randomUUID()}`)
}

/** Mint a fresh artifact id for one publish operation. */
export function newArtifactId(): ArtifactId {
  return brandString<ArtifactId>(`art-${randomUUID()}`)
}

/** Derive the logical resource id from an explicit registered name. */
export function resourceIdFromName(name: string): ResourceId {
  return brandString<ResourceId>(`res-${sha256Hex(name).slice(0, 24)}`)
}

/** Derive one publish operation's identity from its owning session call. */
export function operationRefOf(kind: 'register' | 'artifact', sessionId: string, sourceCallSeq: number): OperationRef {
  return brandString<OperationRef>(`op-${sha256Hex(`${kind}:${sessionId}:${sourceCallSeq}`).slice(0, 24)}`)
}

/** sha256 hex of one string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256 hex of one byte range. */
export function sha256BytesHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Format one exact resource-version ref string. */
export function formatResourceRef(resourceId: ResourceId, version: number): ResourceRef {
  return brandString<ResourceRef>(`${resourceId}@v${version}`)
}

/** Format one exact artifact-version ref string. */
export function formatArtifactRef(artifactId: ArtifactId, version: number): ArtifactRef {
  return brandString<ArtifactRef>(`${artifactId}@v${version}`)
}

/** One parsed catalog ref: which object and which exact version. */
export type ParsedCatalogRef =
  | { readonly kind: 'resource'; readonly id: ResourceId; readonly version: number; readonly text: ResourceRef }
  | { readonly kind: 'artifact'; readonly id: ArtifactId; readonly version: number; readonly text: ArtifactRef }

/**
 * Parse one model-visible catalog ref string into its exact identity.
 * @param ref - candidate ref such as `res-abc@v2` or `art-def@v1`.
 * @returns the parsed identity.
 * @throws {CatalogError} `CATALOG_INVALID_INPUT` when the text is not a
 *   well-formed ref; the vocabulary never guesses a head version.
 */
export function parseCatalogRef(ref: string): ParsedCatalogRef {
  const match = /^(res|art)-[A-Za-z0-9-]+@v([1-9][0-9]*)$/.exec(ref)
  if (match === null) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `"${truncate(ref)}" is not a catalog ref of the form res-…@vN or art-…@vN`)
  }
  if (match[1] === 'res') {
    const id = brandString<ResourceId>(ref.slice(0, ref.indexOf('@')))
    return { kind: 'resource', id, version: Number(match[2]), text: brandString<ResourceRef>(ref) }
  }
  const id = brandString<ArtifactId>(ref.slice(0, ref.indexOf('@')))
  return { kind: 'artifact', id, version: Number(match[2]), text: brandString<ArtifactRef>(ref) }
}

/** Bound echoed input inside error diagnostics. */
function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/**
 * The storage row id one exact ref corresponds to: `<id>@vN` → `<id>-vN`.
 * @param ref - a well-formed catalog ref string.
 * @returns the row id stored in `catalog_resources`/`artifacts`.
 */
export function rowIdOfRef(ref: string): string {
  const at = ref.indexOf('@v')
  if (at === -1) throw new CatalogError('CATALOG_INVALID_INPUT', `"${truncate(ref)}" is not a versioned catalog ref`)
  return `${ref.slice(0, at)}-v${ref.slice(at + 2)}`
}
