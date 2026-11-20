/**
 * WMTS KVP metadata admission and credential-free native SDK reconstruction.
 * Generic matrix geometry is preserved, never corrected from a guessed grid.
 * @module @map-harness/map-container/source-wmts
 */
import { XMLBuilder } from 'fast-xml-parser'
import { canonicalSourceWkid as canonicalWkid, type BasemapSource } from '@map-harness/map-layers'
import type { CustomBasemapSourceConfig } from './sources.ts'
import { SourceCatalogError } from './source-error.ts'
import { PUBLIC_WMTS_IDS } from './source-render-protocol.ts'
import { parseSourceXml, xmlAttribute, xmlElement, xmlElements, xmlText, type SourceXmlElement } from './source-xml.ts'

/** The configured private WMTS selection; never sent to SDK clients or models. */
export type WmtsSourceConfig = NonNullable<CustomBasemapSourceConfig['wmts']>

/** Host-only matrix and its neutral SDK identifier, with verified request bounds. */
export interface WmtsMatrix {
  readonly nativeId: string
  readonly publicId: string
  readonly scaleDenominator: number
  readonly viewScale: number
  readonly topLeftCorner: readonly [number, number]
  readonly tileWidth: number
  readonly tileHeight: number
  readonly matrixWidth: number
  readonly matrixHeight: number
  readonly minTileRow: number
  readonly maxTileRow: number
  readonly minTileCol: number
  readonly maxTileCol: number
}

/** Private KVP translation data; publish only the reconstructed SDK document. */
export interface WmtsMetadata {
  readonly nativeWkid: number
  readonly nativeLayer: string
  readonly nativeStyle: string
  readonly nativeFormat: string
  readonly nativeMatrixSet: string
  readonly publicFormat: 'image/png' | 'image/jpeg'
  readonly matrices: readonly WmtsMatrix[]
}

function unavailable(): never {
  throw new SourceCatalogError('SOURCE_UNAVAILABLE')
}

function text(parent: SourceXmlElement, name: string): string {
  return xmlText(xmlElement(parent, name))
}

function numeric(value: string, minimum: number, maximum = Number.MAX_VALUE, integer = false): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) unavailable()
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isSafeInteger(number))) unavailable()
  return number
}

function positiveInteger(parent: SourceXmlElement, name: string, maximum: number): number {
  return numeric(text(parent, name), 1, maximum, true)
}

function crs(value: string): number {
  const match = /^(?:EPSG:|urn:ogc:def:crs:EPSG:[\d.]*:|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)(\d+)$/i.exec(value)
  if (match === null) unavailable()
  return canonicalWkid(numeric(match[1]!, 1, Number.MAX_SAFE_INTEGER, true))
}

function named(elements: readonly SourceXmlElement[], identifier: string): SourceXmlElement {
  const matches = elements.filter(element => text(element, 'Identifier') === identifier)
  if (matches.length !== 1) unavailable()
  return matches[0]!
}

function kvpConstraints(element: SourceXmlElement): boolean {
  return xmlElements(element, 'Constraint').filter(value => xmlAttribute(value, 'name') === 'GetEncoding').every(value => {
    const allowed = xmlElements(xmlElement(value, 'AllowedValues'), 'Value').map(xmlText)
    return allowed.some(value => value.toUpperCase() === 'KVP')
  })
}

function requireKvp(capabilities: SourceXmlElement): void {
  const operations = xmlElement(capabilities, 'OperationsMetadata')
  if (!kvpConstraints(operations)) unavailable()
  for (const name of ['GetCapabilities', 'GetTile']) {
    const matches = xmlElements(operations, 'Operation').filter(value => xmlAttribute(value, 'name') === name)
    if (matches.length !== 1 || !kvpConstraints(matches[0]!)) unavailable()
    const http = xmlElement(xmlElement(matches[0]!, 'DCP'), 'HTTP')
    const gets = xmlElements(http, 'Get')
    for (const get of gets) xmlAttribute(get, 'href')
    if (!gets.some(kvpConstraints)) unavailable()
  }
}

function chosenStyle(layer: SourceXmlElement, requested: string | undefined): string {
  const styles = xmlElements(layer, 'Style')
  if (requested !== undefined) return text(named(styles, requested), 'Identifier')
  const defaults = styles.filter(style => {
    const flag = style['@_isDefault']
    if (flag !== undefined && !['true', 'false', '1', '0'].includes(String(flag))) unavailable()
    return flag === 'true' || flag === '1'
  })
  if (defaults.length === 1) return text(defaults[0]!, 'Identifier')
  if (defaults.length === 0 && styles.length === 1) return text(styles[0]!, 'Identifier')
  unavailable()
}

function chosenFormat(layer: SourceXmlElement, requested: string | undefined): { native: string; public: WmtsMetadata['publicFormat'] } {
  const formats = xmlElements(layer, 'Format').map(xmlText)
  const selected = requested === undefined
    ? ['image/png', 'image/jpeg', 'tiles'].map(format => formats.find(value => value.toLowerCase() === format)).find(value => value !== undefined)
    : formats.find(value => value === requested)
  if (selected === undefined || !['image/png', 'image/jpeg', 'tiles'].includes(selected.toLowerCase())) unavailable()
  return { native: selected, public: selected.toLowerCase() === 'image/jpeg' ? 'image/jpeg' : 'image/png' }
}

function matrices(matrixSet: SourceXmlElement): readonly WmtsMatrix[] {
  const input = xmlElements(matrixSet, 'TileMatrix')
  if (input.length === 0 || input.length > 64) unavailable()
  const ids = new Set<string>()
  const values = input.map((matrix, index): WmtsMatrix => {
    const nativeId = text(matrix, 'Identifier')
    if (ids.has(nativeId)) unavailable()
    ids.add(nativeId)
    const scaleDenominator = numeric(text(matrix, 'ScaleDenominator'), Number.MIN_VALUE)
    const viewScale = scaleDenominator * 0.00028 * 96 / 0.0254
    const corner = text(matrix, 'TopLeftCorner').split(/\s+/)
    if (corner.length !== 2 || !Number.isFinite(viewScale) || viewScale <= 0) unavailable()
    const topLeftCorner: readonly [number, number] = [
      numeric(corner[0]!, -Number.MAX_VALUE), numeric(corner[1]!, -Number.MAX_VALUE),
    ]
    const tileWidth = positiveInteger(matrix, 'TileWidth', 4_096)
    const tileHeight = positiveInteger(matrix, 'TileHeight', 4_096)
    const matrixWidth = positiveInteger(matrix, 'MatrixWidth', 2 ** 32)
    const matrixHeight = positiveInteger(matrix, 'MatrixHeight', 2 ** 32)
    const spanX = scaleDenominator * 0.00028 * tileWidth * matrixWidth
    const spanY = scaleDenominator * 0.00028 * tileHeight * matrixHeight
    if (spanX <= 0 || spanY <= 0 || !Number.isFinite(spanX) || !Number.isFinite(spanY)
      || !Number.isFinite(topLeftCorner[0] + spanX) || !Number.isFinite(topLeftCorner[1] - spanY)) unavailable()
    return {
      nativeId, publicId: String(index), scaleDenominator, viewScale, topLeftCorner,
      tileWidth, tileHeight, matrixWidth, matrixHeight,
      minTileRow: 0, maxTileRow: matrixHeight - 1, minTileCol: 0, maxTileCol: matrixWidth - 1,
    }
  })
  values.sort((left, right) => right.scaleDenominator - left.scaleDenominator)
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.scaleDenominator === values[index]!.scaleDenominator) unavailable()
  }
  return values.map((matrix, index) => ({ ...matrix, publicId: String(index) }))
}

function limitedMatrices(link: SourceXmlElement, input: readonly WmtsMatrix[]): readonly WmtsMatrix[] {
  const containers = xmlElements(link, 'TileMatrixSetLimits')
  if (containers.length === 0) return input
  if (containers.length !== 1) unavailable()
  const limits = xmlElements(containers[0]!, 'TileMatrixLimits')
  if (limits.length === 0 || limits.length > input.length) unavailable()
  const known = new Map(input.map(matrix => [matrix.nativeId, matrix]))
  const limited = new Map<string, WmtsMatrix>()
  for (const limit of limits) {
    const id = text(limit, 'TileMatrix')
    const matrix = known.get(id)
    if (matrix === undefined || limited.has(id)) unavailable()
    const minTileRow = numeric(text(limit, 'MinTileRow'), 0, matrix.matrixHeight - 1, true)
    const maxTileRow = numeric(text(limit, 'MaxTileRow'), minTileRow, matrix.matrixHeight - 1, true)
    const minTileCol = numeric(text(limit, 'MinTileCol'), 0, matrix.matrixWidth - 1, true)
    const maxTileCol = numeric(text(limit, 'MaxTileCol'), minTileCol, matrix.matrixWidth - 1, true)
    limited.set(id, { ...matrix, minTileRow, maxTileRow, minTileCol, maxTileCol })
  }
  return input.filter(matrix => limited.has(matrix.nativeId)).map((matrix, index) => ({ ...limited.get(matrix.nativeId)!, publicId: String(index) }))
}

/**
 * Decode the configured WMTS layer/grid without following service-provided URLs.
 * @param source - validated public descriptor.
 * @param config - private layer/style/matrix selection resolved by the host.
 * @param body - transport-bounded UTF8 capabilities.
 * @returns host-only native translation data; unsupported or inconsistent documents reject without raw causes.
 */
export function parseWmtsMetadata(source: BasemapSource, config: WmtsSourceConfig, body: Uint8Array): WmtsMetadata {
  const capabilities = xmlElement(parseSourceXml(body), 'Capabilities')
  if (xmlAttribute(capabilities, 'version') !== '1.0.0') unavailable()
  requireKvp(capabilities)
  const contents = xmlElement(capabilities, 'Contents')
  const layer = named(xmlElements(contents, 'Layer'), config.layer)
  if (xmlElements(layer, 'Dimension').length > 0) unavailable()
  const links = xmlElements(layer, 'TileMatrixSetLink').filter(link => text(link, 'TileMatrixSet') === config.tileMatrixSet)
  if (links.length !== 1) unavailable()
  const matrixSet = named(xmlElements(contents, 'TileMatrixSet'), config.tileMatrixSet)
  const wkid = crs(text(matrixSet, 'SupportedCRS'))
  if (wkid !== canonicalWkid(source.nativeWkid)) unavailable()
  const format = chosenFormat(layer, config.format)
  return {
    nativeWkid: wkid,
    nativeLayer: config.layer,
    nativeStyle: chosenStyle(layer, config.style),
    nativeFormat: format.native,
    nativeMatrixSet: config.tileMatrixSet,
    publicFormat: format.public,
    matrices: limitedMatrices(links[0]!, matrices(matrixSet)),
  }
}

/**
 * Reconstruct native WMTS capabilities with only public identifiers and KVP URLs.
 * @param source - public title/attribution owner.
 * @param metadata - admitted private translation data; native names are not copied.
 * @param resourceHref - host-compiled same-origin controlled resource endpoint.
 * @returns safe native SDK XML; no original endpoint, provider link or identifier survives.
 */
export function createSdkWmtsMetadata(source: BasemapSource, metadata: WmtsMetadata, resourceHref: string): string {
  const ids = PUBLIC_WMTS_IDS
  const get = {
    '@_xlink:href': resourceHref,
    'ows:Constraint': { '@_name': 'GetEncoding', 'ows:AllowedValues': { 'ows:Value': 'KVP' } },
  }
  return new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false }).build({
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    Capabilities: {
      '@_xmlns': 'http://www.opengis.net/wmts/1.0',
      '@_xmlns:ows': 'http://www.opengis.net/ows/1.1',
      '@_xmlns:xlink': 'http://www.w3.org/1999/xlink',
      '@_version': '1.0.0',
      'ows:ServiceIdentification': {
        'ows:Title': source.title,
        'ows:Abstract': source.attribution,
        'ows:ServiceType': 'OGC WMTS',
        'ows:ServiceTypeVersion': '1.0.0',
      },
      'ows:OperationsMetadata': {
        'ows:Operation': ['GetCapabilities', 'GetTile'].map(name => ({
          '@_name': name, 'ows:DCP': { 'ows:HTTP': { 'ows:Get': get } },
        })),
      },
      Contents: {
        Layer: {
          'ows:Title': source.title,
          'ows:Identifier': ids.layer,
          Style: { '@_isDefault': 'true', 'ows:Identifier': ids.style },
          Format: metadata.publicFormat,
          TileMatrixSetLink: {
            TileMatrixSet: ids.matrixSet,
            TileMatrixSetLimits: {
              TileMatrixLimits: metadata.matrices.map(matrix => ({
                TileMatrix: matrix.publicId,
                MinTileRow: matrix.minTileRow, MaxTileRow: matrix.maxTileRow,
                MinTileCol: matrix.minTileCol, MaxTileCol: matrix.maxTileCol,
              })),
            },
          },
        },
        TileMatrixSet: {
          'ows:Identifier': ids.matrixSet,
          'ows:SupportedCRS': `urn:ogc:def:crs:EPSG::${metadata.nativeWkid}`,
          TileMatrix: metadata.matrices.map(matrix => ({
            'ows:Identifier': matrix.publicId,
            ScaleDenominator: matrix.scaleDenominator,
            TopLeftCorner: matrix.topLeftCorner.join(' '),
            TileWidth: matrix.tileWidth, TileHeight: matrix.tileHeight,
            MatrixWidth: matrix.matrixWidth, MatrixHeight: matrix.matrixHeight,
          })),
        },
      },
    },
  })
}
