/**
 * Bounded WMTS XML parsing and typed element access.
 * External declarations are refused; no document URI is ever fetched.
 * @module @map-harness/map-container/source-xml
 */
import { XMLParser } from 'fast-xml-parser'
import { SourceCatalogError } from './source-error.ts'

/** Parsed XML element awaiting the native metadata field decoder. */
export type SourceXmlElement = Readonly<Record<string, unknown>>

function unavailable(): never {
  throw new SourceCatalogError('SOURCE_UNAVAILABLE')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function enforceValueBudget(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let values = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    values += 1
    if (values > 16_384 || current.depth > 96) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
    if (typeof current.value !== 'object' || current.value === null) continue
    const children = Object.values(current.value)
    if (children.length + pending.length + values > 16_384) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
}

/**
 * Parse bounded UTF8 XML without external declarations or unbounded nesting.
 * @param body - bytes already bounded by the source transport.
 * @returns undecoded elements; external parse errors become safe failures without raw causes.
 */
export function parseSourceXml(body: Uint8Array): SourceXmlElement {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch (error) {
    if (error instanceof TypeError) unavailable()
    throw error
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) unavailable()
  let tags = 0
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    alwaysCreateTextNode: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    maxNestedTags: 32,
    jPath: true,
    isArray: (_name, _path, _leaf, attribute) => !attribute,
    updateTag(name, path) {
      tags += 1
      if (tags > 16_384 || (typeof path === 'string' && path.split('.').length > 32)) {
        throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
      }
      return name
    },
  })
  let value: unknown
  try {
    value = parser.parse(text, true)
  } catch (error) {
    // The external parser may include document contents in its own errors.
    if (error instanceof SourceCatalogError) throw error
    unavailable()
  }
  enforceValueBudget(value)
  if (!isObject(value)) unavailable()
  return value
}

/**
 * Read repeated XML child elements.
 * @param parent - parsed parent.
 * @param name - local element name.
 * @returns children, or an empty array for an absent element; malformed values refuse.
 */
export function xmlElements(parent: SourceXmlElement, name: string): readonly SourceXmlElement[] {
  const value = parent[name]
  if (value === undefined) return []
  if (!Array.isArray(value)) unavailable()
  return value.map((value: unknown) => {
    if (!isObject(value)) unavailable()
    return value
  })
}

/**
 * Read exactly one required XML child.
 * @param parent - parsed parent.
 * @param name - local element name.
 * @returns the only child; missing/duplicate elements refuse.
 */
export function xmlElement(parent: SourceXmlElement, name: string): SourceXmlElement {
  const elements = xmlElements(parent, name)
  if (elements.length !== 1) unavailable()
  return elements[0]!
}

/**
 * Read a bounded text-only XML element.
 * @param element - selected parsed element.
 * @returns decoded text; mixed content and missing/oversized text refuse.
 */
export function xmlText(element: SourceXmlElement): string {
  const value = element['#text']
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024
    || Object.keys(element).some(key => key !== '#text' && !key.startsWith('@_'))) unavailable()
  return value
}

/**
 * Read one required bounded XML attribute.
 * @param element - selected parsed element.
 * @param name - local attribute name.
 * @returns attribute text; missing/oversized values refuse.
 */
export function xmlAttribute(element: SourceXmlElement, name: string): string {
  const value = element[`@_${name}`]
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) unavailable()
  return value
}
